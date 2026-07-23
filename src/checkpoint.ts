import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
	AgentThreadState,
	CheckpointSnapshot,
	CheckpointSummary,
	GraphInterrupt,
	InFlightStep,
	JsonValue,
	NodeExecutionSuccess,
	NodeRunHistory,
	NodeUsage,
	StateWrite,
	UsageLedger,
} from "./types.ts";
import { errorMessage, normalizePath } from "./utils.ts";

const CHECKPOINT_FORMAT = "pi-graph-checkpoint";
const CHECKPOINT_FORMAT_VERSION = 2;
const BLOB_FORMAT = "pi-graph-checkpoint-blob";
const BLOB_FORMAT_VERSION = 1;
const JOURNAL_FORMAT = "pi-graph-checkpoint-journal";
const JOURNAL_FORMAT_VERSION = 1;
const LEASE_FORMAT = "pi-graph-run-lease";
const LEASE_FORMAT_VERSION = 1;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const MIN_LEASE_DURATION_MS = 100;
const JOURNAL_DIRECTORY = ".journal";
const SEQUENCE_WIDTH = 16;
const CURRENT_HOST = hostname();

export interface CheckpointRecord {
	format: typeof CHECKPOINT_FORMAT;
	formatVersion: typeof CHECKPOINT_FORMAT_VERSION;
	revision: number;
	snapshot: CheckpointSnapshot;
}

export type OpenCheckpointRequest =
	| { mode: "create"; snapshot: CheckpointSnapshot }
	| { mode: "resume"; runId: string };

/**
 * Exclusive durable-run handle. The adapter owns lease renewal and CAS;
 * callers only commit snapshots through this interface.
 */
export interface CheckpointRun {
	readonly runId: string;
	readonly revision: number;
	readonly snapshot: CheckpointSnapshot;
	/** Aborts when the adapter can no longer prove lease ownership. */
	readonly signal: AbortSignal;
	commit(snapshot: CheckpointSnapshot): Promise<void>;
	close(): Promise<void>;
}

export interface CheckpointStore {
	open(request: OpenCheckpointRequest): Promise<CheckpointRun>;
	load(runId: string): Promise<CheckpointRecord>;
	list(limit?: number): Promise<CheckpointSummary[]>;
	delete(runId: string): Promise<void>;
}

export interface FileCheckpointStoreOptions {
	/** Lease TTL. The adapter renews at roughly one third of this interval. */
	leaseDurationMs?: number;
}

export type CheckpointLeaseErrorCode =
	| "RUN_LEASE_HELD"
	| "RUN_LEASE_EXPIRED"
	| "RUN_LEASE_LOST";

export class CheckpointLeaseError extends Error {
	readonly code: CheckpointLeaseErrorCode;

	constructor(code: CheckpointLeaseErrorCode, message: string) {
		super(message);
		this.name = "CheckpointLeaseError";
		this.code = code;
	}
}

export class CheckpointConflictError extends Error {
	readonly expectedRevision: number;
	readonly actualRevision: number;

	constructor(runId: string, expectedRevision: number, actualRevision: number) {
		super(`Checkpoint ${runId} revision conflict: expected ${expectedRevision}, found ${actualRevision}`);
		this.name = "CheckpointConflictError";
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
	}
}

export class CheckpointValidationError extends Error {
	readonly path: string;

	constructor(path: string, message: string) {
		super(`Invalid checkpoint at ${path}: ${message}`);
		this.name = "CheckpointValidationError";
		this.path = path;
	}
}

export class CheckpointDurabilityError extends Error {
	readonly runId: string;
	readonly sequence: number;

	constructor(runId: string, sequence: number, cause: unknown) {
		super(`Checkpoint transition ${runId}#${sequence} was published but could not be durably synced`, { cause });
		this.name = "CheckpointDurabilityError";
		this.runId = runId;
		this.sequence = sequence;
	}
}

interface RunLeaseRecord {
	format: typeof LEASE_FORMAT;
	formatVersion: typeof LEASE_FORMAT_VERSION;
	runId: string;
	ownerId: string;
	host: string;
	pid: number;
	acquiredAt: string;
	expiresAt: string;
}

interface CheckpointPointer {
	revision: number;
	blob: string;
}

interface CheckpointBlob {
	format: typeof BLOB_FORMAT;
	formatVersion: typeof BLOB_FORMAT_VERSION;
	revision: number;
	snapshot: CheckpointSnapshot;
}

interface JournalEntry {
	format: typeof JOURNAL_FORMAT;
	formatVersion: typeof JOURNAL_FORMAT_VERSION;
	sequence: number;
	runId: string;
	createdAt: string;
	deleted: boolean;
	lease: RunLeaseRecord | null;
	checkpoint: CheckpointPointer;
}

export class FileCheckpointStore implements CheckpointStore {
	readonly rootDir: string;
	readonly leaseDurationMs: number;
	private readonly directoryInitializations = new Map<string, Promise<void>>();

	constructor(rootDir: string, options: FileCheckpointStoreOptions = {}) {
		this.rootDir = rootDir;
		this.leaseDurationMs = positiveInteger(options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS, "leaseDurationMs");
		if (this.leaseDurationMs < MIN_LEASE_DURATION_MS) {
			throw new Error(`leaseDurationMs must be at least ${MIN_LEASE_DURATION_MS}`);
		}
	}

	async open(request: OpenCheckpointRequest): Promise<CheckpointRun> {
		const runId = request.mode === "create" ? request.snapshot.runId : request.runId;
		validateRunId(runId);
		const ownerId = randomUUID();

		if (request.mode === "create") {
			const snapshot = parseCheckpointSnapshot(request.snapshot, runId);
			const existing = await this.ensureJournal(runId);
			if (existing) throw new CheckpointConflictError(runId, 0, existing.checkpoint.revision);

			const record = checkpointRecord(1, snapshot);
			const blob = await this.writeBlob(record);
			const lease = createLease(runId, ownerId, this.leaseDurationMs);
			const entry = journalEntry(1, runId, false, lease, { revision: record.revision, blob });
			let published = false;
			try {
				published = await this.publish(entry, true);
				if (!published) {
					const winner = await this.readLatestEntry(runId);
					throw new CheckpointConflictError(runId, 0, winner?.checkpoint.revision ?? 0);
				}
			} catch (error) {
				if (error instanceof CheckpointDurabilityError) published = true;
				if (published) await this.releaseBestEffort(lease);
				throw error;
			} finally {
				if (!published) await rm(this.blobPath(runId, blob), { force: true });
			}
			let stabilizedLease: RunLeaseRecord;
			try {
				stabilizedLease = await this.stabilizeAcquiredLease(lease);
			} catch (error) {
				await this.releaseBestEffort(lease);
				throw error;
			}
			const run = new FileCheckpointRun(this, stabilizedLease, record);
			await this.writeMirrorBestEffort(record);
			return run;
		}

		while (true) {
			const current = await this.ensureJournal(runId);
			if (!current || current.deleted) throw missingCheckpoint(runId);
			if (current.lease && !leaseExpired(current.lease)) {
				throw new CheckpointLeaseError(
					"RUN_LEASE_HELD",
					`Run ${runId} is already owned by ${current.lease.ownerId} until ${current.lease.expiresAt}`,
				);
			}
			const lease = createLease(runId, ownerId, this.leaseDurationMs);
			const next = journalEntry(current.sequence + 1, runId, false, lease, current.checkpoint);
			let acquired = false;
			try {
				acquired = await this.publish(next, false);
			} catch (error) {
				if (error instanceof CheckpointDurabilityError) await this.releaseBestEffort(lease);
				throw error;
			}
			if (!acquired) continue;
			try {
				const record = await this.readPointedRecord(runId, current.checkpoint);
				const stabilizedLease = await this.stabilizeAcquiredLease(lease);
				return new FileCheckpointRun(this, stabilizedLease, record);
			} catch (error) {
				await this.releaseBestEffort(lease);
				throw error;
			}
		}
	}

	async load(runId: string): Promise<CheckpointRecord> {
		validateRunId(runId);
		const current = await this.ensureJournal(runId);
		if (!current || current.deleted) throw missingCheckpoint(runId);
		return await this.readPointedRecord(runId, current.checkpoint);
	}

	async list(limit = 50): Promise<CheckpointSummary[]> {
		await this.ensureRoot();
		const runIds = new Set<string>();
		for (const entry of await readdir(this.journalRoot(), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			try {
				validateRunId(entry.name);
				runIds.add(entry.name);
			} catch {
				// Ignore internal directories that are not valid run IDs.
			}
		}

		const snapshots: CheckpointSummary[] = [];
		for (const runId of runIds) {
			try {
				const record = await this.load(runId);
				const snapshot = record.snapshot;
				snapshots.push({
					runId: snapshot.runId,
					revision: record.revision,
					graphName: snapshot.graphName,
					status: snapshot.status,
					updatedAt: snapshot.updatedAt,
					step: snapshot.step,
					nodeRuns: snapshot.nodeRuns,
					costUsd: snapshot.usage.costUsd,
				});
			} catch {
				// Listing is best-effort: skip malformed, deleted, or concurrently changing runs.
			}
		}
		return snapshots
			.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.runId.localeCompare(right.runId))
			.slice(0, Math.max(0, limit))
	}

	async delete(runId: string): Promise<void> {
		validateRunId(runId);
		while (true) {
			const current = await this.ensureJournal(runId);
			// No journal means there is no linearized run to delete. A concurrent
			// create may already have written its private blob but not yet published
			// sequence 1, so orphan cleanup cannot safely happen on this path.
			if (!current) return;
			if (current.deleted) {
				await this.syncJournalEntry(current);
				await this.purgeDeletedPayload(runId);
				return;
			}
			if (current.lease && !leaseExpired(current.lease)) {
				throw new CheckpointLeaseError("RUN_LEASE_HELD", `Cannot delete run ${runId} while it is leased`);
			}
			const tombstone = journalEntry(current.sequence + 1, runId, true, null, current.checkpoint);
			if (!(await this.publish(tombstone, true))) continue;
			await this.purgeDeletedPayload(runId);
			return;
		}
	}

	async commit(lease: RunLeaseRecord, expectedRevision: number, snapshot: CheckpointSnapshot): Promise<CheckpointRecord> {
		const normalized = parseCheckpointSnapshot(snapshot, lease.runId);
		const record = checkpointRecord(expectedRevision + 1, normalized);
		const blob = await this.writeBlob(record);
		let published = false;
		try {
			while (true) {
				const current = await this.requireCurrentEntry(lease.runId);
				this.assertLeaseOwned(current, lease);
				if (current.checkpoint.revision !== expectedRevision) {
					throw new CheckpointConflictError(lease.runId, expectedRevision, current.checkpoint.revision);
				}
				const previous = await this.readPointedRecord(lease.runId, current.checkpoint);
				assertCheckpointProgress(previous.snapshot, normalized);
				const renewed = renewLease(current.lease!, this.leaseDurationMs);
				const next = journalEntry(current.sequence + 1, lease.runId, false, renewed, {
					revision: record.revision,
					blob,
				});
				if (!(await this.publish(next, true))) continue;
				published = true;
				if (leaseExpired(renewed)) await this.stabilizeAcquiredLease(renewed);
				await this.writeMirrorBestEffort(record);
				return record;
			}
		} catch (error) {
			if (error instanceof CheckpointDurabilityError) published = true;
			throw error;
		} finally {
			if (!published) await rm(this.blobPath(lease.runId, blob), { force: true });
		}
	}

	async renew(lease: RunLeaseRecord): Promise<RunLeaseRecord> {
		const current = await this.requireCurrentEntry(lease.runId);
		this.assertLeaseOwned(current, lease);
		return await this.stabilizeAcquiredLease(lease);
	}

	async release(lease: RunLeaseRecord): Promise<void> {
		while (true) {
			const current = await this.readLatestEntry(lease.runId);
			if (!current || current.deleted || current.lease === null) return;
			if (current.lease.ownerId !== lease.ownerId) {
				throw new CheckpointLeaseError("RUN_LEASE_LOST", `Run ${lease.runId} is owned by another executor`);
			}
			const next = journalEntry(current.sequence + 1, lease.runId, false, null, current.checkpoint);
			if (await this.publish(next, false)) return;
		}
	}

	private assertLeaseOwned(current: JournalEntry, lease: RunLeaseRecord): void {
		if (current.deleted || !current.lease || current.lease.ownerId !== lease.ownerId) {
			throw new CheckpointLeaseError("RUN_LEASE_LOST", `Lease ownership for run ${lease.runId} was lost`);
		}
		if (leaseExpired(current.lease)) {
			throw new CheckpointLeaseError("RUN_LEASE_EXPIRED", `Lease for run ${lease.runId} expired at ${current.lease.expiresAt}`);
		}
	}

	private async stabilizeAcquiredLease(lease: RunLeaseRecord): Promise<RunLeaseRecord> {
		while (true) {
			const current = await this.requireCurrentEntry(lease.runId);
			if (!current.lease || current.lease.ownerId !== lease.ownerId) {
				throw new CheckpointLeaseError("RUN_LEASE_LOST", `Lease ownership for run ${lease.runId} was lost during acquisition`);
			}
			const renewed = renewLease(current.lease, this.leaseDurationMs);
			const next = journalEntry(current.sequence + 1, lease.runId, false, renewed, current.checkpoint);
			if ((await this.publish(next, false)) && !leaseExpired(renewed)) return renewed;
		}
	}

	private async releaseBestEffort(lease: RunLeaseRecord): Promise<void> {
		try {
			await this.release(lease);
		} catch {
			// Lease expiry remains the fallback when cleanup after a failed open cannot publish.
		}
	}

	private async requireCurrentEntry(runId: string): Promise<JournalEntry> {
		const current = await this.readLatestEntry(runId);
		if (!current || current.deleted) throw new CheckpointLeaseError("RUN_LEASE_LOST", `Run ${runId} no longer exists`);
		return current;
	}

	private async ensureRoot(): Promise<void> {
		await this.ensureDirectory(this.rootDir);
		await this.ensureDirectory(this.journalRoot());
	}

	private async ensureRunDirectories(runId: string): Promise<void> {
		await this.ensureRoot();
		await this.ensureDirectory(this.runDirectory(runId));
		await this.ensureDirectory(this.blobsDirectory(runId));
	}

	private async ensureDirectory(path: string): Promise<void> {
		let work = this.directoryInitializations.get(path);
		if (!work) {
			work = ensureDirectoryDurable(path, 0o700);
			this.directoryInitializations.set(path, work);
		}
		try {
			await work;
		} catch (error) {
			this.directoryInitializations.delete(path);
			throw error;
		}
	}

	private async ensureJournal(runId: string): Promise<JournalEntry | undefined> {
		await this.ensureRoot();
		return await this.readLatestEntry(runId);
	}

	private async purgeDeletedPayload(runId: string): Promise<void> {
		await Promise.all([
			rm(this.mirrorPath(runId), { force: true }),
			rm(this.blobsDirectory(runId), { recursive: true, force: true }),
		]);
	}

	private async readLatestEntry(runId: string): Promise<JournalEntry | undefined> {
		while (true) {
			let entries;
			try {
				entries = await readdir(this.runDirectory(runId), { withFileTypes: true });
			} catch (error) {
				if (errorCode(error) === "ENOENT") return undefined;
				throw error;
			}
			const names = entries
				.filter((entry) => entry.isFile() && /^\d{16}\.json$/.test(entry.name))
				.map((entry) => entry.name)
				.sort()
				.reverse();
			if (names.length === 0) return undefined;
			const name = names[0];
			const sequence = Number(name.slice(0, SEQUENCE_WIDTH));
			let parsed: unknown;
			try {
				parsed = JSON.parse(await readFile(join(this.runDirectory(runId), name), "utf8"));
			} catch (error) {
				if (errorCode(error) === "ENOENT") continue;
				throw new CheckpointValidationError("$journal", `invalid JSON: ${errorMessage(error)}`);
			}
			return parseJournalEntry(parsed, runId, sequence);
		}
	}

	private async readPointedRecord(runId: string, pointer: CheckpointPointer): Promise<CheckpointRecord> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(this.blobPath(runId, pointer.blob), "utf8"));
		} catch (error) {
			if (errorCode(error) === "ENOENT") {
				throw new CheckpointValidationError("$journal.checkpoint.blob", `referenced blob ${JSON.stringify(pointer.blob)} is missing`);
			}
			throw new CheckpointValidationError("$blob", `invalid JSON: ${errorMessage(error)}`);
		}
		return parseCheckpointBlob(parsed, runId, pointer.revision);
	}

	private async writeBlob(record: CheckpointRecord): Promise<string> {
		await this.ensureRunDirectories(record.snapshot.runId);
		const blob = `r${sequenceName(record.revision)}.${randomUUID()}.json`;
		const value: CheckpointBlob = {
			format: BLOB_FORMAT,
			formatVersion: BLOB_FORMAT_VERSION,
			revision: record.revision,
			snapshot: record.snapshot,
		};
		await writeJsonDurable(this.blobPath(record.snapshot.runId, blob), value, 0o600, true);
		await syncDirectory(this.blobsDirectory(record.snapshot.runId));
		return blob;
	}

	private async publish(entry: JournalEntry, durable: boolean): Promise<boolean> {
		await this.ensureRunDirectories(entry.runId);
		const directory = this.runDirectory(entry.runId);
		const temporary = join(directory, `.publish.${process.pid}.${randomUUID()}.tmp`);
		const destination = join(directory, `${sequenceName(entry.sequence)}.json`);
		// Sync the inode before publishing its hard link. Even a lease-only entry
		// may become directory-durable as a side effect of a later fsync; its data
		// must never be left torn while it is the highest visible sequence.
		try {
			await writeJsonDurable(temporary, entry, 0o600, true);
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => undefined);
			throw error;
		}
		let published = false;
		try {
			try {
				await link(temporary, destination);
				published = true;
			} catch (error) {
				if (errorCode(error) !== "EEXIST") throw error;
			}
		} finally {
			try {
				await rm(temporary, { force: true });
			} catch (error) {
				if (!published) throw error;
			}
		}
		if (published && durable) {
			try {
				await syncFile(destination);
				await syncDirectory(directory);
			} catch (error) {
				throw new CheckpointDurabilityError(entry.runId, entry.sequence, error);
			}
		}
		return published;
	}

	private async syncJournalEntry(entry: JournalEntry): Promise<void> {
		const path = join(this.runDirectory(entry.runId), `${sequenceName(entry.sequence)}.json`);
		try {
			await syncFile(path);
			await syncDirectory(this.runDirectory(entry.runId));
		} catch (error) {
			throw new CheckpointDurabilityError(entry.runId, entry.sequence, error);
		}
	}

	private async writeMirrorBestEffort(record: CheckpointRecord): Promise<void> {
		try {
			await this.ensureRoot();
			await writeJsonAtomic(this.mirrorPath(record.snapshot.runId), record, 0o600);
		} catch {
			// The immutable journal is authoritative. A failed human-readable mirror
			// must not turn an already committed CAS operation into an apparent failure.
		}
	}

	private journalRoot(): string {
		return join(this.rootDir, JOURNAL_DIRECTORY);
	}

	private runDirectory(runId: string): string {
		return join(this.journalRoot(), runId);
	}

	private blobsDirectory(runId: string): string {
		return join(this.runDirectory(runId), "blobs");
	}

	private blobPath(runId: string, blob: string): string {
		return join(this.blobsDirectory(runId), blob);
	}

	private mirrorPath(runId: string): string {
		return join(this.rootDir, `${runId}.json`);
	}
}

class FileCheckpointRun implements CheckpointRun {
	private readonly store: FileCheckpointStore;
	private lease: RunLeaseRecord;
	private record: CheckpointRecord;
	private readonly abortController = new AbortController();
	private readonly heartbeat: NodeJS.Timeout;
	private heartbeatWork: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(store: FileCheckpointStore, lease: RunLeaseRecord, record: CheckpointRecord) {
		this.store = store;
		this.lease = lease;
		this.record = record;
		const intervalMs = Math.max(10, Math.floor(store.leaseDurationMs / 3));
		this.heartbeat = setInterval(() => {
			this.heartbeatWork = this.heartbeatWork.then(async () => {
				if (this.closed || this.signal.aborted) return;
				try {
					this.lease = await this.store.renew(this.lease);
				} catch (error) {
					this.abortController.abort(error);
				}
			});
		}, intervalMs);
		this.heartbeat.unref?.();
	}

	get runId(): string {
		return this.lease.runId;
	}

	get revision(): number {
		return this.record.revision;
	}

	get snapshot(): CheckpointSnapshot {
		return this.record.snapshot;
	}

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	async commit(snapshot: CheckpointSnapshot): Promise<void> {
		if (this.closed) throw new CheckpointLeaseError("RUN_LEASE_LOST", `Checkpoint run ${this.runId} is closed`);
		if (this.signal.aborted) throw this.signal.reason ?? new CheckpointLeaseError("RUN_LEASE_LOST", `Lease for ${this.runId} was lost`);
		this.record = await this.store.commit(this.lease, this.record.revision, snapshot);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.heartbeat);
		await this.heartbeatWork.catch(() => undefined);
		try {
			await this.store.release(this.lease);
		} catch (error) {
			if (!(error instanceof CheckpointLeaseError) || error.code !== "RUN_LEASE_LOST") throw error;
		}
	}
}

export function parseCheckpointRecord(value: unknown, expectedRunId?: string): CheckpointRecord {
	const record = objectValue(value, "$checkpoint");
	if (record.format !== CHECKPOINT_FORMAT) {
		invalid("$checkpoint.format", `must be ${JSON.stringify(CHECKPOINT_FORMAT)}`);
	}
	assertExactKeys(record, ["format", "formatVersion", "revision", "snapshot"], ["format", "formatVersion", "revision", "snapshot"], "$checkpoint");
	if (record.formatVersion !== CHECKPOINT_FORMAT_VERSION) {
		invalid("$checkpoint.formatVersion", `must be ${CHECKPOINT_FORMAT_VERSION}`);
	}
	const revision = positiveInteger(record.revision, "$checkpoint.revision");
	return checkpointRecord(revision, parseCheckpointSnapshot(record.snapshot, expectedRunId));
}

export function parseCheckpointSnapshot(value: unknown, expectedRunId?: string): CheckpointSnapshot {
	const record = objectValue(value, "$snapshot");
	const allowed = [
		"version", "runId", "graphName", "graphHash", "graphSource", "status", "createdAt", "updatedAt", "startedAt",
		"endedAt", "activeTimeMs", "step", "nodeRuns", "state", "pending", "completionCounts", "barrierConsumed",
		"usage", "history", "threads", "inFlight", "interrupt", "error",
	];
	const required = [
		"version", "runId", "graphName", "graphHash", "status", "createdAt", "updatedAt", "startedAt", "activeTimeMs",
		"step", "nodeRuns", "state", "pending", "completionCounts", "barrierConsumed", "usage", "history", "threads",
	];
	assertExactKeys(record, allowed, required, "$snapshot");
	if (record.version !== 2) invalid("$snapshot.version", "must be 2");
	const runId = nonEmptyString(record.runId, "$snapshot.runId");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) invalid("$snapshot.runId", "contains invalid characters");
	if (expectedRunId !== undefined && runId !== expectedRunId) {
		invalid("$snapshot.runId", `must match ${JSON.stringify(expectedRunId)}`);
	}
	nonEmptyString(record.graphName, "$snapshot.graphName");
	if (typeof record.graphHash !== "string" || !/^[a-f0-9]{64}$/.test(record.graphHash)) {
		invalid("$snapshot.graphHash", "must be a SHA-256 hex digest");
	}
	optionalNonEmptyString(record.graphSource, "$snapshot.graphSource");
	const statuses = new Set(["running", "interrupted", "completed", "failed", "cancelled"]);
	if (typeof record.status !== "string" || !statuses.has(record.status)) invalid("$snapshot.status", "has an unknown status");
	const createdAt = isoTimestamp(record.createdAt, "$snapshot.createdAt");
	const updatedAt = isoTimestamp(record.updatedAt, "$snapshot.updatedAt");
	const startedAt = isoTimestamp(record.startedAt, "$snapshot.startedAt");
	const endedAt = record.endedAt === undefined ? undefined : isoTimestamp(record.endedAt, "$snapshot.endedAt");
	if (Date.parse(startedAt) < Date.parse(createdAt)) invalid("$snapshot.startedAt", "must not be earlier than createdAt");
	if (Date.parse(updatedAt) < Date.parse(createdAt)) invalid("$snapshot.updatedAt", "must not be earlier than createdAt");
	if (Date.parse(updatedAt) < Date.parse(startedAt)) invalid("$snapshot.updatedAt", "must not be earlier than startedAt");
	if (endedAt !== undefined && Date.parse(endedAt) < Date.parse(startedAt)) {
		invalid("$snapshot.endedAt", "must not be earlier than startedAt");
	}
	if (endedAt !== undefined && Date.parse(updatedAt) < Date.parse(endedAt)) {
		invalid("$snapshot.updatedAt", "must not be earlier than endedAt");
	}
	nonNegativeInteger(record.activeTimeMs, "$snapshot.activeTimeMs");
	const step = nonNegativeInteger(record.step, "$snapshot.step");
	const nodeRuns = nonNegativeInteger(record.nodeRuns, "$snapshot.nodeRuns");
	assertJsonObject(record.state, "$snapshot.state");
	const pending = nodeIdArray(record.pending, "$snapshot.pending", true);
	validateCountRecord(record.completionCounts, "$snapshot.completionCounts");
	validateNestedCountRecord(record.barrierConsumed, "$snapshot.barrierConsumed");
	validateUsage(record.usage, "$snapshot.usage", false);
	validateHistory(record.history, "$snapshot.history", step, nodeRuns);
	const threads = record.threads === undefined ? {} : validateThreads(record.threads, "$snapshot.threads");
	if (record.inFlight !== undefined) validateInFlight(record.inFlight, "$snapshot.inFlight", step);
	if (record.interrupt !== undefined) validateInterrupt(record.interrupt, "$snapshot.interrupt");
	if (record.error !== undefined && typeof record.error !== "string") invalid("$snapshot.error", "must be a string");
	if (record.inFlight !== undefined && pending.length > 0) invalid("$snapshot.pending", "must be empty while a step is in flight");

	if (record.status === "completed") {
		if (record.endedAt === undefined) invalid("$snapshot.endedAt", "is required for a completed run");
		if (pending.length > 0) invalid("$snapshot.pending", "must be empty for a completed run");
		if (record.inFlight !== undefined) invalid("$snapshot.inFlight", "must be absent for a completed run");
		if (record.interrupt !== undefined) invalid("$snapshot.interrupt", "must be absent for a completed run");
		if (record.error !== undefined) invalid("$snapshot.error", "must be absent for a completed run");
	}
	if (record.status === "interrupted") {
		if (record.interrupt === undefined) invalid("$snapshot.interrupt", "is required for an interrupted run");
		if (record.inFlight === undefined) invalid("$snapshot.inFlight", "is required for an interrupted run");
		if (record.endedAt !== undefined) invalid("$snapshot.endedAt", "must be absent for an interrupted run");
		if (record.error !== undefined) invalid("$snapshot.error", "must be absent for an interrupted run");
		const interrupt = record.interrupt as unknown as GraphInterrupt;
		const inFlight = record.inFlight as unknown as InFlightStep;
		if (!inFlight.unresolved.includes(interrupt.nodeId)) {
			invalid("$snapshot.interrupt.nodeId", "must identify an unresolved in-flight node");
		}
	}
	if ((record.status === "failed" || record.status === "cancelled") && record.endedAt === undefined) {
		invalid("$snapshot.endedAt", `is required for a ${record.status} run`);
	}
	if ((record.status === "failed" || record.status === "cancelled") && record.error === undefined) {
		invalid("$snapshot.error", `is required for a ${record.status} run`);
	}
	if (record.status === "failed" || record.status === "cancelled") nonEmptyString(record.error, "$snapshot.error");
	if ((record.status === "failed" || record.status === "cancelled") && record.interrupt !== undefined) {
		invalid("$snapshot.interrupt", `must be absent for a ${record.status} run`);
	}
	if (record.status === "running") {
		if (record.endedAt !== undefined) invalid("$snapshot.endedAt", "must be absent for a running run");
		if (record.interrupt !== undefined) invalid("$snapshot.interrupt", "must be absent for a running run");
		if (record.error !== undefined) invalid("$snapshot.error", "must be absent for a running run");
	}

	return canonicalJsonClone({ ...record, threads }) as CheckpointSnapshot;
}

function assertCheckpointProgress(previous: CheckpointSnapshot, next: CheckpointSnapshot): void {
	for (const key of ["version", "runId", "graphName", "graphHash", "graphSource", "createdAt", "startedAt"] as const) {
		if (!Object.is(previous[key], next[key])) invalid(`$snapshot.${key}`, "must remain unchanged across revisions");
	}
	if (previous.status === "completed") invalid("$snapshot.status", "a completed checkpoint cannot advance to another revision");
	assertMonotonicNumber(previous.activeTimeMs, next.activeTimeMs, "$snapshot.activeTimeMs");
	assertMonotonicNumber(previous.step, next.step, "$snapshot.step");
	assertMonotonicNumber(previous.nodeRuns, next.nodeRuns, "$snapshot.nodeRuns");
	if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) {
		invalid("$snapshot.updatedAt", "must not move backwards across revisions");
	}

	for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "turns", "costUsd"] as const) {
		assertMonotonicNumber(previous.usage[key], next.usage[key], `$snapshot.usage.${key}`);
	}
	if (next.history.length < previous.history.length) invalid("$snapshot.history", "must not discard prior entries");
	for (let index = 0; index < previous.history.length; index++) {
		if (!isDeepStrictEqual(previous.history[index], next.history[index])) {
			invalid(`$snapshot.history[${index}]`, "must remain unchanged across revisions");
		}
	}
	assertCountProgress(previous.completionCounts, next.completionCounts, "$snapshot.completionCounts");
	for (const [barrierId, counts] of Object.entries(previous.barrierConsumed)) {
		const nextCounts = next.barrierConsumed[barrierId];
		if (!nextCounts) invalid(`$snapshot.barrierConsumed.${barrierId}`, "must not be removed across revisions");
		assertCountProgress(counts, nextCounts, `$snapshot.barrierConsumed.${barrierId}`);
	}
	for (const [threadKey, thread] of Object.entries(previous.threads)) {
		const nextThread = next.threads[threadKey];
		if (!nextThread) invalid(`$snapshot.threads.${threadKey}`, "must not be removed across revisions");
		for (const key of ["key", "sessionId", "createdAt"] as const) {
			if (thread[key] !== nextThread[key]) invalid(`$snapshot.threads.${threadKey}.${key}`, "must remain unchanged across revisions");
		}
		assertMonotonicNumber(
			thread.invocationCount,
			nextThread.invocationCount,
			`$snapshot.threads.${threadKey}.invocationCount`,
		);
		if (Date.parse(nextThread.updatedAt) < Date.parse(thread.updatedAt)) {
			invalid(`$snapshot.threads.${threadKey}.updatedAt`, "must not move backwards across revisions");
		}
		for (const nodeId of thread.nodes) {
			if (!nextThread.nodes.includes(nodeId)) invalid(`$snapshot.threads.${threadKey}.nodes`, "must retain prior node ids");
		}
	}
}

function assertCountProgress(previous: Record<string, number>, next: Record<string, number>, path: string): void {
	for (const [key, value] of Object.entries(previous)) {
		if (!Object.hasOwn(next, key)) invalid(`${path}.${key}`, "must not be removed across revisions");
		assertMonotonicNumber(value, next[key], `${path}.${key}`);
	}
}

function assertMonotonicNumber(previous: number, next: number, path: string): void {
	if (next < previous) invalid(path, `must not decrease across revisions (was ${previous}, received ${next})`);
}

function checkpointRecord(revision: number, snapshot: CheckpointSnapshot): CheckpointRecord {
	return { format: CHECKPOINT_FORMAT, formatVersion: CHECKPOINT_FORMAT_VERSION, revision, snapshot };
}

function journalEntry(
	sequence: number,
	runId: string,
	deleted: boolean,
	lease: RunLeaseRecord | null,
	checkpoint: CheckpointPointer,
): JournalEntry {
	return {
		format: JOURNAL_FORMAT,
		formatVersion: JOURNAL_FORMAT_VERSION,
		sequence,
		runId,
		createdAt: new Date().toISOString(),
		deleted,
		lease,
		checkpoint,
	};
}

function parseJournalEntry(value: unknown, expectedRunId: string, expectedSequence: number): JournalEntry {
	const record = objectValue(value, "$journal");
	assertExactKeys(
		record,
		["format", "formatVersion", "sequence", "runId", "createdAt", "deleted", "lease", "checkpoint"],
		["format", "formatVersion", "sequence", "runId", "createdAt", "deleted", "lease", "checkpoint"],
		"$journal",
	);
	if (record.format !== JOURNAL_FORMAT || record.formatVersion !== JOURNAL_FORMAT_VERSION) {
		invalid("$journal", "has an unsupported format");
	}
	const sequence = positiveInteger(record.sequence, "$journal.sequence");
	if (sequence !== expectedSequence) invalid("$journal.sequence", `must match journal filename sequence ${expectedSequence}`);
	if (record.runId !== expectedRunId) invalid("$journal.runId", `must match ${JSON.stringify(expectedRunId)}`);
	isoTimestamp(record.createdAt, "$journal.createdAt");
	if (typeof record.deleted !== "boolean") invalid("$journal.deleted", "must be a boolean");
	const lease = record.lease === null ? null : parseLeaseRecord(record.lease, expectedRunId, "$journal.lease");
	if (record.deleted && lease !== null) invalid("$journal.lease", "must be null for a deleted run");
	const pointer = objectValue(record.checkpoint, "$journal.checkpoint");
	assertExactKeys(pointer, ["revision", "blob"], ["revision", "blob"], "$journal.checkpoint");
	const revision = positiveInteger(pointer.revision, "$journal.checkpoint.revision");
	const blob = nonEmptyString(pointer.blob, "$journal.checkpoint.blob");
	if (!/^r\d{16}\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(blob)) {
		invalid("$journal.checkpoint.blob", "has an invalid blob filename");
	}
	if (!blob.startsWith(`r${sequenceName(revision)}.`)) {
		invalid("$journal.checkpoint.blob", `must encode checkpoint revision ${revision}`);
	}
	return canonicalJsonClone({ ...record, lease, checkpoint: { revision, blob } }) as JournalEntry;
}

function parseCheckpointBlob(value: unknown, expectedRunId: string, expectedRevision: number): CheckpointRecord {
	const record = objectValue(value, "$blob");
	assertExactKeys(record, ["format", "formatVersion", "revision", "snapshot"], ["format", "formatVersion", "revision", "snapshot"], "$blob");
	if (record.format !== BLOB_FORMAT || record.formatVersion !== BLOB_FORMAT_VERSION) invalid("$blob", "has an unsupported format");
	const revision = positiveInteger(record.revision, "$blob.revision");
	if (revision !== expectedRevision) invalid("$blob.revision", `must match journal revision ${expectedRevision}`);
	return checkpointRecord(revision, parseCheckpointSnapshot(record.snapshot, expectedRunId));
}

function createLease(runId: string, ownerId: string, durationMs: number): RunLeaseRecord {
	const now = Date.now();
	return {
		format: LEASE_FORMAT,
		formatVersion: LEASE_FORMAT_VERSION,
		runId,
		ownerId,
		host: CURRENT_HOST,
		pid: process.pid,
		acquiredAt: new Date(now).toISOString(),
		expiresAt: new Date(now + durationMs).toISOString(),
	};
}

function renewLease(lease: RunLeaseRecord, durationMs: number): RunLeaseRecord {
	const expiresAt = Math.max(Date.now() + durationMs, Date.parse(lease.expiresAt), Date.parse(lease.acquiredAt) + 1);
	return { ...lease, expiresAt: new Date(expiresAt).toISOString() };
}

function parseLeaseRecord(value: unknown, expectedRunId: string, path = "$lease"): RunLeaseRecord {
	const record = objectValue(value, path);
	assertExactKeys(
		record,
		["format", "formatVersion", "runId", "ownerId", "host", "pid", "acquiredAt", "expiresAt"],
		["format", "formatVersion", "runId", "ownerId", "host", "pid", "acquiredAt", "expiresAt"],
		path,
	);
	if (record.format !== LEASE_FORMAT || record.formatVersion !== LEASE_FORMAT_VERSION) invalid(path, "has an unsupported format");
	if (record.runId !== expectedRunId) invalid(`${path}.runId`, `must match ${JSON.stringify(expectedRunId)}`);
	nonEmptyString(record.ownerId, `${path}.ownerId`);
	nonEmptyString(record.host, `${path}.host`);
	positiveInteger(record.pid, `${path}.pid`);
	const acquiredAt = isoTimestamp(record.acquiredAt, `${path}.acquiredAt`);
	const expiresAt = isoTimestamp(record.expiresAt, `${path}.expiresAt`);
	if (Date.parse(expiresAt) <= Date.parse(acquiredAt)) invalid(`${path}.expiresAt`, "must be later than acquiredAt");
	return canonicalJsonClone(record) as unknown as RunLeaseRecord;
}

function leaseExpired(lease: RunLeaseRecord): boolean {
	return Date.parse(lease.expiresAt) <= Date.now();
}

async function ensureDirectoryDurable(path: string, mode: number): Promise<void> {
	try {
		await mkdir(path, { mode });
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			const parent = dirname(path);
			if (parent === path) throw error;
			await ensureDirectoryDurable(parent, mode);
			try {
				await mkdir(path, { mode });
			} catch (retryError) {
				if (errorCode(retryError) !== "EEXIST") throw retryError;
			}
		} else if (errorCode(error) !== "EEXIST") {
			throw error;
		}
	}
	await syncDirectory(dirname(path));
}

async function writeJsonAtomic(path: string, value: unknown, mode: number): Promise<void> {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeJsonDurable(temporary, value, mode, true);
		await rename(temporary, path);
		await syncDirectory(dirname(path));
	} finally {
		await rm(temporary, { force: true });
	}
}

async function writeJsonDurable(path: string, value: unknown, mode: number, exclusive: boolean, sync = true): Promise<void> {
	const handle = await open(path, exclusive ? "wx" : "w", mode);
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		if (sync) await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncFile(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectory(path: string): Promise<void> {
	let handle;
	try {
		handle = await open(path, "r");
		await handle.sync();
	} catch (error) {
		const unsupportedOnWindows = process.platform === "win32"
			&& ["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(errorCode(error));
		if (!unsupportedOnWindows) throw error;
	} finally {
		await handle?.close();
	}
}

function sequenceName(sequence: number): string {
	if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= 10 ** SEQUENCE_WIDTH) {
		throw new Error(`Checkpoint journal sequence is out of range: ${sequence}`);
	}
	return String(sequence).padStart(SEQUENCE_WIDTH, "0");
}

function missingCheckpoint(runId: string): Error {
	return new Error(`Unable to load pi-graph run ${runId}: checkpoint does not exist`);
}

function canonicalJsonClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function validateRunId(runId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error(`Invalid run id ${JSON.stringify(runId)}`);
}

function validateHistory(value: unknown, path: string, snapshotStep: number, nodeRuns: number): asserts value is NodeRunHistory[] {
	const items = arrayValue(value, path);
	let totalAttempts = 0;
	for (let index = 0; index < items.length; index++) {
		const item = objectValue(items[index], `${path}[${index}]`);
		assertExactKeys(item, ["step", "nodeId", "status", "attempts", "startedAt", "endedAt", "usage", "error"], ["step", "nodeId", "status", "attempts", "startedAt", "endedAt", "usage"], `${path}[${index}]`);
		const historyStep = positiveInteger(item.step, `${path}[${index}].step`);
		if (historyStep > snapshotStep) invalid(`${path}[${index}].step`, `must not exceed snapshot step ${snapshotStep}`);
		validateNodeId(item.nodeId, `${path}[${index}].nodeId`);
		if (item.status !== "completed" && item.status !== "failed" && item.status !== "interrupted") invalid(`${path}[${index}].status`, "has an unknown status");
		const attempts = positiveInteger(item.attempts, `${path}[${index}].attempts`);
		if (attempts > nodeRuns - totalAttempts) invalid(path, `total attempts must not exceed nodeRuns (${nodeRuns})`);
		totalAttempts += attempts;
		const startedAt = isoTimestamp(item.startedAt, `${path}[${index}].startedAt`);
		const endedAt = isoTimestamp(item.endedAt, `${path}[${index}].endedAt`);
		if (Date.parse(endedAt) < Date.parse(startedAt)) invalid(`${path}[${index}].endedAt`, "must not be earlier than startedAt");
		validateUsage(item.usage, `${path}[${index}].usage`, true);
		if (item.status === "failed") nonEmptyString(item.error, `${path}[${index}].error`);
		else if (item.error !== undefined) invalid(`${path}[${index}].error`, `must be absent for ${item.status} history`);
	}
}

function validateInFlight(value: unknown, path: string, snapshotStep: number): asserts value is InFlightStep {
	const item = objectValue(value, path);
	assertExactKeys(item, ["step", "scheduled", "unresolved", "completed"], ["step", "scheduled", "unresolved", "completed"], path);
	const step = positiveInteger(item.step, `${path}.step`);
	if (step !== snapshotStep) invalid(`${path}.step`, `must equal snapshot step ${snapshotStep}`);
	const scheduled = nodeIdArray(item.scheduled, `${path}.scheduled`, true);
	if (scheduled.length === 0) invalid(`${path}.scheduled`, "must not be empty");
	const unresolved = nodeIdArray(item.unresolved, `${path}.unresolved`, true);
	const scheduledSet = new Set(scheduled);
	for (const nodeId of unresolved) if (!scheduledSet.has(nodeId)) invalid(`${path}.unresolved`, `${JSON.stringify(nodeId)} is not scheduled`);
	const completed = objectValue(item.completed, `${path}.completed`);
	for (const [nodeId, result] of Object.entries(completed)) {
		validateMapKey(nodeId, `${path}.completed`);
		if (!scheduledSet.has(nodeId)) invalid(`${path}.completed.${nodeId}`, "node is not scheduled");
		if (unresolved.includes(nodeId)) invalid(`${path}.completed.${nodeId}`, "node cannot also be unresolved");
		validateSuccess(result, `${path}.completed.${nodeId}`, nodeId);
	}
	for (const nodeId of scheduled) {
		if (!unresolved.includes(nodeId) && !Object.hasOwn(completed, nodeId)) {
			invalid(path, `scheduled node ${JSON.stringify(nodeId)} is neither unresolved nor completed`);
		}
	}
}

function validateSuccess(value: unknown, path: string, nodeId: string): asserts value is NodeExecutionSuccess {
	const item = objectValue(value, path);
	assertExactKeys(item, ["kind", "writes", "output", "usage", "next", "attempts", "startedAt", "endedAt"], ["kind", "writes", "usage", "attempts", "startedAt", "endedAt"], path);
	if (item.kind !== "success") invalid(`${path}.kind`, "must be success");
	validateWrites(item.writes, `${path}.writes`, nodeId);
	if (item.output !== undefined) assertJsonValue(item.output, `${path}.output`);
	validateUsage(item.usage, `${path}.usage`, true);
	if (item.next !== undefined) nodeIdArray(item.next, `${path}.next`, false);
	positiveInteger(item.attempts, `${path}.attempts`);
	const startedAt = isoTimestamp(item.startedAt, `${path}.startedAt`);
	const endedAt = isoTimestamp(item.endedAt, `${path}.endedAt`);
	if (Date.parse(endedAt) < Date.parse(startedAt)) invalid(`${path}.endedAt`, "must not be earlier than startedAt");
}

function validateWrites(value: unknown, path: string, expectedNodeId: string): asserts value is StateWrite[] {
	const items = arrayValue(value, path);
	for (let index = 0; index < items.length; index++) {
		const item = objectValue(items[index], `${path}[${index}]`);
		assertExactKeys(item, ["path", "value", "nodeId", "mode"], ["path", "nodeId"], `${path}[${index}]`);
		const writePath = nonEmptyString(item.path, `${path}[${index}].path`);
		try {
			normalizePath(writePath);
		} catch (error) {
			invalid(`${path}[${index}].path`, errorMessage(error));
		}
		const mode = item.mode ?? "reduce";
		if (mode !== "reduce" && mode !== "overwrite" && mode !== "unset") {
			invalid(`${path}[${index}].mode`, "must be reduce, overwrite, or unset");
		}
		if (mode === "unset") {
			if (item.value !== undefined) invalid(`${path}[${index}].value`, "must be absent for unset writes");
		} else {
			if (item.value === undefined) invalid(`${path}[${index}].value`, `is required for ${mode} writes`);
			assertJsonValue(item.value, `${path}[${index}].value`);
		}
		if (item.nodeId !== expectedNodeId) invalid(`${path}[${index}].nodeId`, `must equal ${JSON.stringify(expectedNodeId)}`);
	}
}

function validateThreads(value: unknown, path: string): Record<string, AgentThreadState> {
	const record = objectValue(value, path);
	for (const [key, raw] of Object.entries(record)) {
		validateMapKey(key, path);
		const itemPath = `${path}.${key}`;
		const item = objectValue(raw, itemPath);
		assertExactKeys(item, ["key", "sessionId", "createdAt", "updatedAt", "nodes", "invocationCount", "lastNodeId"], ["key", "sessionId", "createdAt", "updatedAt", "nodes", "invocationCount"], itemPath);
		if (item.key !== key) invalid(`${itemPath}.key`, `must equal ${JSON.stringify(key)}`);
		const sessionId = nonEmptyString(item.sessionId, `${itemPath}.sessionId`);
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
			invalid(`${itemPath}.sessionId`, "must be a UUID");
		}
		const createdAt = isoTimestamp(item.createdAt, `${itemPath}.createdAt`);
		const updatedAt = isoTimestamp(item.updatedAt, `${itemPath}.updatedAt`);
		if (Date.parse(updatedAt) < Date.parse(createdAt)) invalid(`${itemPath}.updatedAt`, "must not be earlier than createdAt");
		const nodes = nodeIdArray(item.nodes, `${itemPath}.nodes`, true);
		if (nodes.length === 0) invalid(`${itemPath}.nodes`, "must not be empty");
		nonNegativeInteger(item.invocationCount, `${itemPath}.invocationCount`);
		if (item.lastNodeId !== undefined) {
			const lastNodeId = nonEmptyString(item.lastNodeId, `${itemPath}.lastNodeId`);
			if (!nodes.includes(lastNodeId)) invalid(`${itemPath}.lastNodeId`, "must be present in nodes");
		}
	}
	return record as unknown as Record<string, AgentThreadState>;
}

function validateInterrupt(value: unknown, path: string): asserts value is GraphInterrupt {
	const item = objectValue(value, path);
	assertExactKeys(item, ["nodeId", "kind", "prompt", "options", "createdAt"], ["nodeId", "kind", "prompt", "createdAt"], path);
	validateNodeId(item.nodeId, `${path}.nodeId`);
	if (item.kind !== "confirm" && item.kind !== "input" && item.kind !== "select") invalid(`${path}.kind`, "has an unknown kind");
	if (typeof item.prompt !== "string") invalid(`${path}.prompt`, "must be a string");
	if (item.kind === "select") {
		if (item.options === undefined) invalid(`${path}.options`, "is required for a select interrupt");
		if (stringArray(item.options, `${path}.options`, false).length === 0) invalid(`${path}.options`, "must not be empty for a select interrupt");
	} else if (item.options !== undefined) {
		stringArray(item.options, `${path}.options`, false);
	}
	isoTimestamp(item.createdAt, `${path}.createdAt`);
}

function validateUsage(value: unknown, path: string, allowModel: boolean): asserts value is UsageLedger | NodeUsage {
	const item = objectValue(value, path);
	const keys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "turns", "costUsd"];
	assertExactKeys(item, allowModel ? [...keys, "model"] : keys, keys, path);
	for (const key of keys.slice(0, 5)) nonNegativeInteger(item[key], `${path}.${key}`);
	nonNegativeFinite(item.costUsd, `${path}.costUsd`);
	if (item.model !== undefined) nonEmptyString(item.model, `${path}.model`);
}

function validateCountRecord(value: unknown, path: string): void {
	const record = objectValue(value, path);
	for (const [key, count] of Object.entries(record)) {
		validateMapKey(key, path);
		nonNegativeInteger(count, `${path}.${key}`);
	}
}

function validateNestedCountRecord(value: unknown, path: string): void {
	const record = objectValue(value, path);
	for (const [key, counts] of Object.entries(record)) {
		validateMapKey(key, path);
		validateCountRecord(counts, `${path}.${key}`);
	}
}

function validateMapKey(key: string, path: string): void {
	if (!key.trim()) invalid(path, "keys must be non-empty");
	if (["__proto__", "prototype", "constructor"].includes(key)) invalid(`${path}.${key}`, "uses a forbidden object key");
}

function assertJsonObject(value: unknown, path: string): void {
	if (!isObject(value)) invalid(path, "must be a JSON object");
	assertJsonValue(value, path);
}

function assertJsonValue(value: unknown, path: string, ancestors = new Set<object>()): asserts value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) invalid(path, "numbers must be finite");
		return;
	}
	if (typeof value !== "object") invalid(path, "must contain only JSON values");
	if (ancestors.has(value)) invalid(path, "must not contain cycles");
	ancestors.add(value);
	if (Array.isArray(value)) {
		const items = arrayValue(value, path);
		for (let index = 0; index < items.length; index++) {
			assertJsonValue(items[index], `${path}[${index}]`, ancestors);
		}
	} else {
		if (!isObject(value)) invalid(path, "must contain only plain JSON objects and arrays");
		assertJsonOwnProperties(value, path, false);
		for (const [key, item] of Object.entries(value)) {
			if (key === "__proto__" || key === "prototype" || key === "constructor") invalid(`${path}.${key}`, "uses a forbidden object key");
			assertJsonValue(item, `${path}.${key}`, ancestors);
		}
	}
	ancestors.delete(value);
}

function stringArray(value: unknown, path: string, unique: boolean): string[] {
	const items = arrayValue(value, path);
	const result = items.map((item, index) => nonEmptyString(item, `${path}[${index}]`));
	if (unique && new Set(result).size !== result.length) invalid(path, "must not contain duplicates");
	return result;
}

function nodeIdArray(value: unknown, path: string, unique: boolean): string[] {
	const result = stringArray(value, path, unique);
	for (let index = 0; index < result.length; index++) validateNodeId(result[index], `${path}[${index}]`);
	return result;
}

function validateNodeId(value: unknown, path: string): string {
	const nodeId = nonEmptyString(value, path);
	if (["__proto__", "prototype", "constructor"].includes(nodeId)) invalid(path, "uses a forbidden object key as a node id");
	return nodeId;
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
	if (!isObject(value)) invalid(path, "must be an object");
	assertJsonOwnProperties(value, path, false);
	return value;
}

function arrayValue(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) invalid(path, "must be an array");
	if (Object.getPrototypeOf(value) !== Array.prototype) invalid(path, "must be a plain array");
	assertJsonOwnProperties(value, path, true);
	for (let index = 0; index < value.length; index++) {
		if (!Object.hasOwn(value, index)) invalid(`${path}[${index}]`, "array entries must not be sparse");
	}
	return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(record: Record<string, unknown>, allowed: string[], required: string[], path: string): void {
	assertJsonOwnProperties(record, path, false);
	const allowedSet = new Set(allowed);
	for (const key of Object.getOwnPropertyNames(record)) if (!allowedSet.has(key)) invalid(`${path}.${key}`, "is not a recognized field");
	for (const key of required) if (!Object.hasOwn(record, key)) invalid(`${path}.${key}`, "is required");
}

function assertJsonOwnProperties(value: object, path: string, array: boolean): void {
	if (Object.getOwnPropertySymbols(value).length > 0) invalid(path, "must not contain symbol keys");
	for (const key of Object.getOwnPropertyNames(value)) {
		if (array && key === "length") continue;
		if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= (value as unknown[]).length)) {
			invalid(`${path}.${key}`, "is not a JSON array index");
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) {
			invalid(`${path}.${key}`, "must be an enumerable data property");
		}
	}
}

function nonEmptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) invalid(path, "must be a non-empty string");
	return value;
}

function optionalNonEmptyString(value: unknown, path: string): void {
	if (value !== undefined) nonEmptyString(value, path);
}

function isoTimestamp(value: unknown, path: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid(path, "must be an ISO timestamp");
	if (new Date(value).toISOString() !== value) invalid(path, "must be a canonical ISO timestamp");
	return value;
}

function nonNegativeFinite(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(path, "must be a finite non-negative number");
	return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(path, "must be a non-negative safe integer");
	return value;
}

function positiveInteger(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) invalid(path, "must be a positive safe integer");
	return value;
}

function invalid(path: string, message: string): never {
	throw new CheckpointValidationError(path, message);
}

function errorCode(error: unknown): string {
	return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}
