import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CheckpointSnapshot, CheckpointSummary } from "./types.ts";
import { errorMessage } from "./utils.ts";

export interface CheckpointStore {
	save(snapshot: CheckpointSnapshot): Promise<void>;
	load(runId: string): Promise<CheckpointSnapshot>;
	list(limit?: number): Promise<CheckpointSummary[]>;
	delete(runId: string): Promise<void>;
}

export class FileCheckpointStore implements CheckpointStore {
	readonly rootDir: string;
	private readonly queues = new Map<string, Promise<void>>();

	constructor(rootDir: string) {
		this.rootDir = rootDir;
	}

	async save(snapshot: CheckpointSnapshot): Promise<void> {
		validateRunId(snapshot.runId);
		const previous = this.queues.get(snapshot.runId) ?? Promise.resolve();
		const next = previous
			.catch(() => undefined)
			.then(async () => {
				await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
				const path = this.pathFor(snapshot.runId);
				const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
				const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
				await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
				await rename(temporary, path);
			});
		this.queues.set(snapshot.runId, next);
		try {
			await next;
		} finally {
			if (this.queues.get(snapshot.runId) === next) this.queues.delete(snapshot.runId);
		}
	}

	async load(runId: string): Promise<CheckpointSnapshot> {
		validateRunId(runId);
		let text: string;
		try {
			text = await readFile(this.pathFor(runId), "utf8");
		} catch (error) {
			throw new Error(`Unable to load pi-graph run ${runId}: ${errorMessage(error)}`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new Error(`Checkpoint ${runId} is invalid JSON: ${errorMessage(error)}`);
		}
		if (!isCheckpointSnapshot(parsed)) throw new Error(`Checkpoint ${runId} has an unsupported format`);
		return parsed;
	}

	async list(limit = 50): Promise<CheckpointSummary[]> {
		await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
		const entries = await readdir(this.rootDir, { withFileTypes: true });
		const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
		const snapshots: Array<{ summary: CheckpointSummary; modifiedAt: number }> = [];
		for (const entry of files) {
			try {
				const runId = basename(entry.name, ".json");
				validateRunId(runId);
				const [snapshot, metadata] = await Promise.all([this.load(runId), stat(join(this.rootDir, entry.name))]);
				snapshots.push({
					summary: {
						runId: snapshot.runId,
						graphName: snapshot.graphName,
						status: snapshot.status,
						updatedAt: snapshot.updatedAt,
						step: snapshot.step,
						nodeRuns: snapshot.nodeRuns,
						costUsd: snapshot.usage.costUsd,
					},
					modifiedAt: metadata.mtimeMs,
				});
			} catch {
				// Ignore malformed or concurrently replaced files in the listing path.
			}
		}
		return snapshots
			.sort((left, right) => right.modifiedAt - left.modifiedAt)
			.slice(0, Math.max(0, limit))
			.map((item) => item.summary);
	}

	async delete(runId: string): Promise<void> {
		validateRunId(runId);
		try {
			await unlink(this.pathFor(runId));
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
			if (code !== "ENOENT") throw error;
		}
	}

	private pathFor(runId: string): string {
		return join(this.rootDir, `${runId}.json`);
	}
}

function validateRunId(runId: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error(`Invalid run id ${JSON.stringify(runId)}`);
}

function isCheckpointSnapshot(value: unknown): value is CheckpointSnapshot {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.version === 1 &&
		typeof record.runId === "string" &&
		typeof record.graphName === "string" &&
		typeof record.graphHash === "string" &&
		typeof record.status === "string" &&
		typeof record.state === "object" &&
		record.state !== null &&
		!Array.isArray(record.state)
	);
}
