import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
	CheckpointConflictError,
	CheckpointLeaseError,
	CheckpointValidationError,
	FileCheckpointStore,
	parseCheckpointRecord,
	parseCheckpointSnapshot,
} from "../src/checkpoint.ts";
import type { CheckpointSnapshot } from "../src/types.ts";
import { emptyUsage } from "../src/utils.ts";

test("creating a leased run durably publishes revision one before the first commit", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-checkpoint-create-"));
	try {
		const snapshot = validSnapshot("created-run");
		const store = new FileCheckpointStore(directory);
		const run = await store.open({ mode: "create", snapshot });
		try {
			assert.equal(run.revision, 1);
			const loaded = await new FileCheckpointStore(directory).load("created-run");
			assert.equal(loaded.revision, 1);
			assert.deepEqual(loaded.snapshot, snapshot);
		} finally {
			await run.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("deleting a missing run cannot purge a concurrent unpublished create", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-checkpoint-create-delete-race-"));
	let releasePublish: (() => void) | undefined;
	let creating: Promise<Awaited<ReturnType<FileCheckpointStore["open"]>>> | undefined;
	let created: Awaited<ReturnType<FileCheckpointStore["open"]>> | undefined;
	try {
		const createStore = new FileCheckpointStore(directory);
		type InternalStore = { publish(entry: unknown, durable: boolean): Promise<boolean> };
		const internal = createStore as unknown as InternalStore;
		const originalPublish = internal.publish.bind(createStore);
		let markPublishReady: (() => void) | undefined;
		const publishReady = new Promise<void>((resolve) => {
			markPublishReady = resolve;
		});
		const publishGate = new Promise<void>((resolve) => {
			releasePublish = resolve;
		});
		let intercepted = false;
		internal.publish = async (entry: unknown, durable: boolean) => {
			if (!intercepted) {
				intercepted = true;
				markPublishReady?.();
				await publishGate;
			}
			return await originalPublish(entry, durable);
		};

		creating = createStore.open({ mode: "create", snapshot: validSnapshot("create-delete-race-run") });
		await publishReady;
		await new FileCheckpointStore(directory).delete("create-delete-race-run");
		releasePublish?.();
		releasePublish = undefined;
		created = await creating;

		const loaded = await createStore.load("create-delete-race-run");
		assert.equal(loaded.revision, 1);
		assert.deepEqual(loaded.snapshot, created.snapshot);
	} finally {
		releasePublish?.();
		await creating?.catch(() => undefined);
		await created?.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("an active run lease excludes a second store and revisions advance by CAS", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-checkpoint-lease-"));
	try {
		const firstStore = new FileCheckpointStore(directory);
		const secondStore = new FileCheckpointStore(directory);
		const first = await firstStore.open({ mode: "create", snapshot: validSnapshot("leased-run") });
		try {
			assert.equal(first.revision, 1);
			assert.equal((await secondStore.load("leased-run")).revision, 1);
			await assert.rejects(
				secondStore.open({ mode: "resume", runId: "leased-run" }),
				(error: unknown) => error instanceof CheckpointLeaseError && error.code === "RUN_LEASE_HELD",
			);
			await first.commit(first.snapshot);
			assert.equal(first.revision, 2);
			await first.commit({ ...first.snapshot, updatedAt: now() });
			assert.equal(first.revision, 3);
		} finally {
			await first.close();
		}

		const resumed = await secondStore.open({ mode: "resume", runId: "leased-run" });
		assert.equal(resumed.revision, 3);
		await resumed.close();
		const journalFiles = (await readdir(join(directory, ".journal", "leased-run"))).filter((name) => /^\d{16}\.json$/.test(name));
		const latestSequence = Math.max(...journalFiles.map((name) => Number(name.slice(0, 16))));
		assert.equal(journalFiles.length, latestSequence, "CAS sequence claims must remain append-only and non-reusable");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("failed resume validation releases the lease immediately", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-checkpoint-open-cleanup-"));
	try {
		const store = new FileCheckpointStore(directory, { leaseDurationMs: 5_000 });
		const run = await store.open({ mode: "create", snapshot: validSnapshot("corrupt-open-run") });
		await run.close();
		await rm(join(directory, ".journal", "corrupt-open-run", "blobs"), { recursive: true, force: true });

		for (let attempt = 0; attempt < 2; attempt++) {
			await assert.rejects(
				new FileCheckpointStore(directory, { leaseDurationMs: 5_000 }).open({ mode: "resume", runId: "corrupt-open-run" }),
				(error: unknown) => error instanceof CheckpointValidationError && /referenced blob.*missing/.test(error.message),
			);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("resume revalidates its lease after loading the checkpoint blob", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-checkpoint-open-stabilize-"));
	let releaseRead: (() => void) | undefined;
	let opening: Promise<Awaited<ReturnType<FileCheckpointStore["open"]>>> | undefined;
	let replacement: Awaited<ReturnType<FileCheckpointStore["open"]>> | undefined;
	try {
		const seedStore = new FileCheckpointStore(directory, { leaseDurationMs: 1_000 });
		const seed = await seedStore.open({ mode: "create", snapshot: validSnapshot("stabilize-run") });
		await seed.close();

		const staleStore = new FileCheckpointStore(directory, { leaseDurationMs: 1_000 });
		type InternalStore = { readPointedRecord(runId: string, pointer: unknown): Promise<unknown> };
		const internal = staleStore as unknown as InternalStore;
		const originalRead = internal.readPointedRecord.bind(staleStore);
		let markRead: (() => void) | undefined;
		const readStarted = new Promise<void>((resolve) => {
			markRead = resolve;
		});
		const readGate = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		internal.readPointedRecord = async (runId: string, pointer: unknown) => {
			const record = await originalRead(runId, pointer);
			markRead?.();
			await readGate;
			return record;
		};

		opening = staleStore.open({ mode: "resume", runId: "stabilize-run" });
		await readStarted;
		await delay(1_300);
		const replacementStore = new FileCheckpointStore(directory, { leaseDurationMs: 1_000 });
		replacement = await replacementStore.open({ mode: "resume", runId: "stabilize-run" });
		releaseRead?.();
		releaseRead = undefined;

		await assert.rejects(
			opening,
			(error: unknown) => error instanceof CheckpointLeaseError && error.code === "RUN_LEASE_LOST",
		);
		await assert.rejects(
			new FileCheckpointStore(directory, { leaseDurationMs: 1_000 }).open({ mode: "resume", runId: "stabilize-run" }),
			(error: unknown) => error instanceof CheckpointLeaseError && error.code === "RUN_LEASE_HELD",
		);
	} finally {
		releaseRead?.();
		await opening?.catch(() => undefined);
		await replacement?.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("checkpoint commits preserve immutable identity and monotonic progress", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-checkpoint-progress-"));
	try {
		const store = new FileCheckpointStore(directory);
		const run = await store.open({ mode: "create", snapshot: validSnapshot("progress-run") });
		try {
			await assert.rejects(
				run.commit({ ...run.snapshot, graphHash: "b".repeat(64), updatedAt: now() }),
				(error: unknown) => error instanceof CheckpointValidationError && error.path === "$snapshot.graphHash",
			);
			await run.commit({ ...run.snapshot, step: 1, nodeRuns: 1, updatedAt: now() });
			assert.equal(run.revision, 2);
			await assert.rejects(
				run.commit({ ...run.snapshot, step: 0, updatedAt: now() }),
				(error: unknown) => error instanceof CheckpointValidationError && error.path === "$snapshot.step",
			);
			assert.equal((await store.load("progress-run")).revision, 2);
		} finally {
			await run.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("delete rejects an active lease and leaves an authoritative tombstone", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-checkpoint-delete-"));
	try {
		const store = new FileCheckpointStore(directory);
		const run = await store.open({ mode: "create", snapshot: validSnapshot("deleted-run") });
		const mirror = await readFile(join(directory, "deleted-run.json"), "utf8");
		await assert.rejects(
			store.delete("deleted-run"),
			(error: unknown) => error instanceof CheckpointLeaseError && error.code === "RUN_LEASE_HELD",
		);
		await run.close();
		await store.delete("deleted-run");
		await assert.rejects(store.load("deleted-run"), /checkpoint does not exist/);

		// A stale human-readable mirror cannot resurrect a journal-tombstoned run.
		await writeFile(join(directory, "deleted-run.json"), mirror, "utf8");
		await assert.rejects(store.load("deleted-run"), /checkpoint does not exist/);
		await assert.rejects(
			store.open({ mode: "create", snapshot: validSnapshot("deleted-run") }),
			(error: unknown) => error instanceof CheckpointConflictError && error.actualRevision === 1,
		);
		await store.delete("deleted-run");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a delayed delete cannot reuse an old CAS slot and purge a replacement commit", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-checkpoint-delete-race-"));
	let releaseDelete: (() => void) | undefined;
	let winner: Awaited<ReturnType<FileCheckpointStore["open"]>> | undefined;
	let delayedDelete: Promise<void> | undefined;
	try {
		const seedStore = new FileCheckpointStore(directory);
		const seed = await seedStore.open({ mode: "create", snapshot: validSnapshot("delete-race-run") });
		await seed.close();

		const deletingStore = new FileCheckpointStore(directory);
		type InternalStore = { ensureJournal(runId: string): Promise<unknown> };
		const internal = deletingStore as unknown as InternalStore;
		const originalEnsureJournal = internal.ensureJournal.bind(deletingStore);
		let markDeleteRead: (() => void) | undefined;
		const deleteRead = new Promise<void>((resolve) => {
			markDeleteRead = resolve;
		});
		const deleteGate = new Promise<void>((resolve) => {
			releaseDelete = resolve;
		});
		let intercepted = false;
		internal.ensureJournal = async (runId: string) => {
			const current = await originalEnsureJournal(runId);
			if (!intercepted) {
				intercepted = true;
				markDeleteRead?.();
				await deleteGate;
			}
			return current;
		};

		delayedDelete = deletingStore.delete("delete-race-run");
		await deleteRead;
		const winnerStore = new FileCheckpointStore(directory);
		winner = await winnerStore.open({ mode: "resume", runId: "delete-race-run" });
		await winner.commit({ ...winner.snapshot, state: { winner: true }, updatedAt: now() });
		releaseDelete?.();
		releaseDelete = undefined;

		await assert.rejects(
			delayedDelete,
			(error: unknown) => error instanceof CheckpointLeaseError && error.code === "RUN_LEASE_HELD",
		);
		const loaded = await winnerStore.load("delete-race-run");
		assert.equal(loaded.revision, 2);
		assert.deepEqual(loaded.snapshot.state, { winner: true });
	} finally {
		releaseDelete?.();
		await delayedDelete?.catch(() => undefined);
		await winner?.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("concurrent commits use revision CAS so exactly one stale writer loses", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-checkpoint-cas-"));
	try {
		const store = new FileCheckpointStore(directory);
		const run = await store.open({ mode: "create", snapshot: validSnapshot("cas-run") });
		try {
			assert.equal(run.revision, 1);
			const left = { ...run.snapshot, state: { winner: "left" }, updatedAt: now() };
			const right = { ...run.snapshot, state: { winner: "right" }, updatedAt: now() };
			const results = await Promise.allSettled([run.commit(left), run.commit(right)]);
			assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
			const rejected = results.find((result) => result.status === "rejected");
			assert.ok(rejected?.status === "rejected");
			assert.ok(rejected.reason instanceof CheckpointConflictError);
			assert.equal(rejected.reason.expectedRevision, 1);
			assert.equal(rejected.reason.actualRevision, 2);

			const loaded = await store.load("cas-run");
			assert.equal(loaded.revision, 2);
			assert.ok(loaded.snapshot.state.winner === "left" || loaded.snapshot.state.winner === "right");
		} finally {
			await run.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("an expired owner cannot commit or release a replacement owner's lease", { skip: process.platform === "win32" }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-checkpoint-takeover-"));
	let child: ReturnType<typeof spawn> | undefined;
	try {
		const seedStore = new FileCheckpointStore(directory, { leaseDurationMs: 2_000 });
		const seed = await seedStore.open({ mode: "create", snapshot: validSnapshot("takeover-run") });
		await seed.close();

		const checkpointModule = pathToFileURL(join(process.cwd(), "src", "checkpoint.ts")).href;
		const script = `
import { FileCheckpointStore } from ${JSON.stringify(checkpointModule)};
const store = new FileCheckpointStore(process.argv[1], { leaseDurationMs: 2000 });
const run = await store.open({ mode: "resume", runId: "takeover-run" });
process.on("SIGCONT", async () => {
  try {
    await run.commit({ ...run.snapshot, state: { owner: "stale" }, updatedAt: new Date().toISOString() });
    process.stdout.write("STALE:COMMITTED\\n");
  } catch (error) {
    process.stdout.write("STALE:" + (error && typeof error === "object" && "code" in error ? error.code : "UNKNOWN") + "\\n");
  } finally {
    await run.close();
    process.stdout.write("CLOSED\\n");
    process.exit(0);
  }
});
process.stdout.write("LEASED\\n");
setInterval(() => undefined, 1000);
`;
		child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script, directory], {
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "inherit"],
		});
		const capture = captureOutput(child);
		await waitForOutput(capture, "LEASED");
		child.kill("SIGSTOP");
		await delay(2_500);

		const replacementStore = new FileCheckpointStore(directory, { leaseDurationMs: 2_000 });
		const replacement = await replacementStore.open({ mode: "resume", runId: "takeover-run" });
		try {
			child.kill("SIGCONT");
			await waitForOutput(capture, "STALE:RUN_LEASE_LOST");
			await waitForOutput(capture, "CLOSED");
			await assert.rejects(
				new FileCheckpointStore(directory, { leaseDurationMs: 2_000 }).open({ mode: "resume", runId: "takeover-run" }),
				(error: unknown) => error instanceof CheckpointLeaseError && error.code === "RUN_LEASE_HELD",
			);
			await replacement.commit({ ...replacement.snapshot, state: { owner: "replacement" }, updatedAt: now() });
			assert.equal(replacement.revision, 2);
			assert.deepEqual((await replacementStore.load("takeover-run")).snapshot.state, { owner: "replacement" });
		} finally {
			await replacement.close();
		}
		await waitForExit(child);
		child = undefined;
	} finally {
		if (child && child.exitCode === null && child.signalCode === null) {
			child.kill("SIGCONT");
			child.kill("SIGKILL");
		}
		if (child) await waitForExit(child);
		await rm(directory, { recursive: true, force: true });
	}
});

test("lease heartbeat keeps a long-running owner exclusive", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-checkpoint-heartbeat-"));
	try {
		const firstStore = new FileCheckpointStore(directory, { leaseDurationMs: 3_000 });
		const secondStore = new FileCheckpointStore(directory, { leaseDurationMs: 3_000 });
		const first = await firstStore.open({ mode: "create", snapshot: validSnapshot("heartbeat-run") });
		try {
			await waitForJournalEntries(directory, "heartbeat-run", 3);
			await assert.rejects(
				secondStore.open({ mode: "resume", runId: "heartbeat-run" }),
				(error: unknown) => error instanceof CheckpointLeaseError && error.code === "RUN_LEASE_HELD",
			);
		} finally {
			await first.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a crashed owner can be replaced only after its lease expires", { skip: process.platform === "win32" }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-checkpoint-crash-"));
	let child: ReturnType<typeof spawn> | undefined;
	try {
		const store = new FileCheckpointStore(directory, { leaseDurationMs: 500 });
		const created = await store.open({ mode: "create", snapshot: validSnapshot("crash-run") });
		await created.close();

		const checkpointModule = pathToFileURL(join(process.cwd(), "src", "checkpoint.ts")).href;
		const script = `
import { FileCheckpointStore } from ${JSON.stringify(checkpointModule)};
const store = new FileCheckpointStore(process.argv[1], { leaseDurationMs: 500 });
await store.open({ mode: "resume", runId: "crash-run" });
process.stdout.write("LEASED\\n");
setInterval(() => undefined, 1000);
`;
		child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script, directory], {
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "inherit"],
		});
		assert.ok(child.stdout);
		let output = "";
		while (!output.includes("LEASED")) {
			const [chunk] = (await once(child.stdout, "data")) as [Buffer];
			output += chunk.toString();
		}

		await assert.rejects(
			store.open({ mode: "resume", runId: "crash-run" }),
			(error: unknown) => error instanceof CheckpointLeaseError && error.code === "RUN_LEASE_HELD",
		);
		child.kill("SIGKILL");
		await waitForExit(child);
		child = undefined;
		await new Promise((resolve) => setTimeout(resolve, 700));

		const replacement = await store.open({ mode: "resume", runId: "crash-run" });
		assert.equal(replacement.revision, 1);
		await replacement.close();
	} finally {
		if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		if (child) await waitForExit(child);
		await rm(directory, { recursive: true, force: true });
	}
});

test("multiple processes race through one lease/CAS winner", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-checkpoint-process-cas-"));
	const children: Array<ReturnType<typeof spawn>> = [];
	try {
		const store = new FileCheckpointStore(directory, { leaseDurationMs: 2_000 });
		const seed = await store.open({ mode: "create", snapshot: validSnapshot("process-cas-run") });
		await seed.close();

		const checkpointModule = pathToFileURL(join(process.cwd(), "src", "checkpoint.ts")).href;
		const barrierPath = join(directory, "start.barrier");
		const releasePath = join(directory, "release-winner.barrier");
		const script = `
import { access } from "node:fs/promises";
import { FileCheckpointStore } from ${JSON.stringify(checkpointModule)};
const directory = process.argv[1];
const contender = process.argv[2];
const barrier = process.argv[3];
const release = process.argv[4];
process.stdout.write("READY:" + contender + "\\n");
while (true) {
  try { await access(barrier); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
}
const store = new FileCheckpointStore(directory, { leaseDurationMs: 2000 });
try {
  const run = await store.open({ mode: "resume", runId: "process-cas-run" });
  await run.commit({ ...run.snapshot, state: { contender }, updatedAt: new Date().toISOString() });
  process.stdout.write("WIN:" + contender + "\\n");
  while (true) {
    try { await access(release); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  await run.close();
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : "UNKNOWN";
  process.stdout.write("LOSE:" + contender + ":" + code + "\\n");
}
`;
		const captures: Array<() => string> = [];
		for (let index = 0; index < 4; index++) {
			const child = spawn(
				process.execPath,
				["--experimental-strip-types", "--input-type=module", "--eval", script, directory, String(index), barrierPath, releasePath],
				{ cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] },
			);
			children.push(child);
			captures.push(captureOutput(child));
		}
		await Promise.all(captures.map((capture, index) => waitForOutput(capture, `READY:${index}`)));
		await writeFile(barrierPath, "go\n", "utf8");
		await Promise.all(captures.map((capture) => waitForMatch(capture, /^(?:WIN|LOSE):/m)));

		const output = captures.map((capture) => capture()).join("");
		const winners = [...output.matchAll(/^WIN:(\d+)$/gm)].map((match) => match[1]);
		const losers = [...output.matchAll(/^LOSE:(\d+):RUN_LEASE_HELD$/gm)].map((match) => match[1]);
		assert.equal(winners.length, 1, output);
		assert.equal(losers.length, 3, output);
		await writeFile(releasePath, "go\n", "utf8");
		await Promise.all(children.map(waitForExit));
		const loaded = await store.load("process-cas-run");
		assert.equal(loaded.revision, 2);
		assert.deepEqual(loaded.snapshot.state, { contender: winners[0] });
	} finally {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		await Promise.all(children.map(waitForExit));
		await rm(directory, { recursive: true, force: true });
	}
});

test("checkpoint records require a versioned envelope and explicit threads", () => {
	const snapshot = validSnapshot("versioned-schema");
	assert.throws(
		() => parseCheckpointRecord(snapshot, "versioned-schema"),
		(error: unknown) => error instanceof CheckpointValidationError && error.path === "$checkpoint.format",
	);
	assert.throws(
		() => parseCheckpointSnapshot({ ...snapshot, version: 1 }),
		(error: unknown) => error instanceof CheckpointValidationError && error.path === "$snapshot.version",
	);
	assert.throws(
		() => parseCheckpointRecord({ format: "pi-graph-checkpoint", formatVersion: 2, revision: 0, snapshot }),
		(error: unknown) => error instanceof CheckpointValidationError && error.path === "$checkpoint.revision",
	);

	const missingThreads = { ...snapshot } as Record<string, unknown>;
	delete missingThreads.threads;

	assert.throws(
		() => parseCheckpointSnapshot(missingThreads),
		(error: unknown) => error instanceof CheckpointValidationError && error.path === "$snapshot.threads",
	);
	assert.throws(
		() => parseCheckpointRecord({ format: "pi-graph-checkpoint", formatVersion: 2, revision: 1, snapshot: missingThreads }),
		(error: unknown) => error instanceof CheckpointValidationError && error.path === "$snapshot.threads",
	);
});

test("checkpoint schema rejects inherited objects and non-JSON object instances", () => {
	const inherited = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, validSnapshot("prototype-run"));
	assert.throws(
		() => parseCheckpointSnapshot(inherited),
		(error: unknown) => error instanceof CheckpointValidationError && error.path === "$snapshot",
	);
	assert.throws(
		() => parseCheckpointSnapshot({ ...validSnapshot("date-run"), state: { observedAt: new Date() } }),
		(error: unknown) => error instanceof CheckpointValidationError && error.path === "$snapshot.state.observedAt",
	);

	const symbolState = { visible: true } as Record<PropertyKey, unknown>;
	symbolState[Symbol("hidden")] = true;
	assert.throws(
		() => parseCheckpointSnapshot({ ...validSnapshot("symbol-run"), state: symbolState }),
		(error: unknown) => error instanceof CheckpointValidationError && error.path === "$snapshot.state",
	);
});

test("lease durations shorter than the heartbeat safety floor are rejected", () => {
	assert.throws(() => new FileCheckpointStore("unused", { leaseDurationMs: 99 }), /at least 100/);
});

test("checkpoint schema rejects corrupt roots and nested control state", () => {
	const cases: Array<{ name: string; mutate(value: CheckpointSnapshot): unknown; path: RegExp }> = [
		{
			name: "unknown root field",
			mutate: (value) => ({ ...value, surprise: true }),
			path: /\$snapshot\.surprise/,
		},
		{
			name: "negative usage",
			mutate: (value) => ({ ...value, usage: { ...value.usage, costUsd: -1 } }),
			path: /\$snapshot\.usage\.costUsd/,
		},
		{
			name: "unsafe thread session path",
			mutate: (value) => ({
				...value,
				threads: {
					coder: {
						key: "coder",
						sessionId: "../escape",
						createdAt: now(),
						updatedAt: now(),
						nodes: ["worker"],
						invocationCount: 0,
					},
				},
			}),
			path: /sessionId/,
		},
		{
			name: "in-flight partition gap",
			mutate: (value) => ({
				...value,
				step: 1,
				pending: [],
				inFlight: { step: 1, scheduled: ["worker"], unresolved: [], completed: {} },
			}),
			path: /neither unresolved nor completed/,
		},
		{
			name: "unsafe persisted state write path",
			mutate: (value) => {
				const timestamp = now();
				return {
					...value,
					step: 1,
					pending: [],
					inFlight: {
						step: 1,
						scheduled: ["worker"],
						unresolved: [],
						completed: {
							worker: {
								kind: "success",
								writes: [{ path: "__proto__.polluted", value: true, nodeId: "worker" }],
								usage: emptyUsage(),
								attempts: 1,
								startedAt: timestamp,
								endedAt: timestamp,
							},
						},
					},
				};
			},
			path: /\$snapshot\.inFlight\.completed\.worker\.writes\[0\]\.path/,
		},
		{
			name: "completed run with pending work",
			mutate: (value) => {
				const timestamp = now();
				return { ...value, status: "completed", updatedAt: timestamp, endedAt: timestamp, pending: ["worker"] };
			},
			path: /\$snapshot\.pending/,
		},
		{
			name: "non-finite state number",
			mutate: (value) => ({ ...value, state: { invalid: Number.NaN } }),
			path: /\$snapshot\.state\.invalid/,
		},
		{
			name: "fractional active time",
			mutate: (value) => ({ ...value, activeTimeMs: 0.5 }),
			path: /\$snapshot\.activeTimeMs/,
		},
		{
			name: "whitespace-only map key",
			mutate: (value) => ({ ...value, completionCounts: { "   ": 0 } }),
			path: /\$snapshot\.completionCounts.*keys must be non-empty/,
		},
		{
			name: "history at step zero",
			mutate: (value) => {
				const timestamp = now();
				return {
					...value,
					nodeRuns: 1,
					history: [{
						step: 0,
						nodeId: "worker",
						status: "completed",
						attempts: 1,
						startedAt: timestamp,
						endedAt: timestamp,
						usage: emptyUsage(),
					}],
				};
			},
			path: /\$snapshot\.history\[0\]\.step/,
		},
		{
			name: "failed history without an error",
			mutate: (value) => {
				const timestamp = now();
				return {
					...value,
					step: 1,
					nodeRuns: 1,
					history: [{
						step: 1,
						nodeId: "worker",
						status: "failed",
						attempts: 1,
						startedAt: timestamp,
						endedAt: timestamp,
						usage: emptyUsage(),
					}],
				};
			},
			path: /\$snapshot\.history\[0\]\.error/,
		},
		{
			name: "completed history retaining an error",
			mutate: (value) => {
				const timestamp = now();
				return {
					...value,
					step: 1,
					nodeRuns: 1,
					history: [{
						step: 1,
						nodeId: "worker",
						status: "completed",
						attempts: 1,
						startedAt: timestamp,
						endedAt: timestamp,
						usage: emptyUsage(),
						error: "stale error",
					}],
				};
			},
			path: /\$snapshot\.history\[0\]\.error.*absent/,
		},
		{
			name: "history attempts exceeding node runs",
			mutate: (value) => {
				const timestamp = now();
				return {
					...value,
					step: 1,
					nodeRuns: 1,
					history: [{
						step: 1,
						nodeId: "worker",
						status: "completed",
						attempts: 2,
						startedAt: timestamp,
						endedAt: timestamp,
						usage: emptyUsage(),
					}],
				};
			},
			path: /\$snapshot\.history.*must not exceed nodeRuns/,
		},
		{
			name: "JSON array with an extra property",
			mutate: (value) => {
				const items = Object.assign(["valid"], { extra: true });
				return { ...value, state: { items } };
			},
			path: /\$snapshot\.state\.items\.extra.*not a JSON array index/,
		},
		{
			name: "control array with an extra property",
			mutate: (value) => ({ ...value, pending: Object.assign(["worker"], { extra: true }) }),
			path: /\$snapshot\.pending\.extra.*not a JSON array index/,
		},
		{
			name: "running checkpoint with interrupt",
			mutate: (value) => ({
				...value,
				step: 1,
				pending: [],
				inFlight: { step: 1, scheduled: ["worker"], unresolved: ["worker"], completed: {} },
				interrupt: { nodeId: "worker", kind: "confirm", prompt: "Continue?", createdAt: now() },
			}),
			path: /\$snapshot\.interrupt.*absent for a running run/,
		},
		{
			name: "interrupted checkpoint pointing at a resolved node",
			mutate: (value) => ({
				...value,
				status: "interrupted",
				step: 1,
				pending: [],
				inFlight: { step: 1, scheduled: ["worker"], unresolved: ["worker"], completed: {} },
				interrupt: { nodeId: "human", kind: "confirm", prompt: "Continue?", createdAt: now() },
			}),
			path: /must identify an unresolved in-flight node/,
		},
		{
			name: "select interrupt without options",
			mutate: (value) => ({
				...value,
				status: "interrupted",
				step: 1,
				pending: [],
				inFlight: { step: 1, scheduled: ["worker"], unresolved: ["worker"], completed: {} },
				interrupt: { nodeId: "worker", kind: "select", prompt: "Choose", createdAt: now() },
			}),
			path: /\$snapshot\.interrupt\.options.*required/,
		},
		{
			name: "failed checkpoint retaining an interrupt",
			mutate: (value) => {
				const timestamp = now();
				return {
					...value,
					status: "failed",
					updatedAt: timestamp,
					endedAt: timestamp,
					error: "failed",
					interrupt: { nodeId: "worker", kind: "confirm", prompt: "Continue?", createdAt: timestamp },
				};
			},
			path: /\$snapshot\.interrupt.*absent for a failed run/,
		},
	];

	for (const item of cases) {
		assert.throws(
			() => parseCheckpointSnapshot(item.mutate(validSnapshot(`schema-${item.name.replaceAll(" ", "-")}`))),
			(error: unknown) => error instanceof CheckpointValidationError && item.path.test(error.message),
			item.name,
		);
	}
});

function captureOutput(child: ReturnType<typeof spawn>): () => string {
	assert.ok(child.stdout);
	let output = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		output += chunk;
	});
	return () => output;
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => {
		const onExit = () => resolve();
		child.once("exit", onExit);
		if (child.exitCode !== null || child.signalCode !== null) {
			child.off("exit", onExit);
			resolve();
		}
	});
}

async function waitForOutput(capture: () => string, expected: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!capture().includes(expected)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${JSON.stringify(expected)}; output: ${capture()}`);
		await delay(10);
	}
}

async function waitForMatch(capture: () => string, expected: RegExp, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!expected.test(capture())) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected}; output: ${capture()}`);
		await delay(10);
	}
}

async function waitForJournalEntries(directory: string, runId: string, minimum: number, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const entries = await readdir(join(directory, ".journal", runId));
		if (entries.filter((name) => /^\d{16}\.json$/.test(name)).length >= minimum) return;
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${minimum} journal entries for ${runId}`);
		await delay(10);
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validSnapshot(runId: string): CheckpointSnapshot {
	const timestamp = now();
	return {
		version: 2,
		runId,
		graphName: "test-graph",
		graphHash: "a".repeat(64),
		status: "running",
		createdAt: timestamp,
		updatedAt: timestamp,
		startedAt: timestamp,
		activeTimeMs: 0,
		step: 0,
		nodeRuns: 0,
		state: {},
		pending: ["worker"],
		completionCounts: {},
		barrierConsumed: {},
		usage: emptyUsage(),
		history: [],
		threads: {},
	};
}

function now(): string {
	return new Date().toISOString();
}
