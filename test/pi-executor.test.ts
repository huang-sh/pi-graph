import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCheckpointStore } from "../src/checkpoint.ts";
import { compileGraph } from "../src/compile.ts";
import { GraphEngine } from "../src/engine.ts";
import { PiNodeExecutor } from "../src/pi-executor.ts";
import { getPath } from "../src/utils.ts";

test("Pi node executor consumes Pi JSON events and writes structured output", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-fake-pi-"));
	try {
		const fakePi = join(directory, "fake-pi.mjs");
		await writeFile(
			fakePi,
			`#!/usr/bin/env node\nlet input = "";\nfor await (const chunk of process.stdin) input += chunk;\nconst message = {\n  role: "assistant",\n  content: [{ type: "text", text: JSON.stringify({ approved: input.includes("ship") }) }],\n  usage: { input: 10, output: 4, cacheRead: 1, cacheWrite: 0, cost: { total: 0.002 } },\n  model: "fake/model",\n  stopReason: "stop"\n};\nprocess.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");\n`,
			{ encoding: "utf8", mode: 0o755 },
		);
		await chmod(fakePi, 0o755);
		const graph = compileGraph({
			schemaVersion: 2,
			name: "fake-pi",
			entry: "review",
			nodes: {
				review: {
					type: "agent",
					prompt: "Review {{input.task}}",
					readOnly: true,
					tools: [],
					output: "review",
					response: { format: "json" },
				},
			},
			limits: {
				maxSteps: 2,
				maxNodeRuns: 2,
				maxConcurrency: 1,
				maxCostUsd: 1,
				maxTokens: 1000,
				timeoutMs: 10000,
				maxStateBytes: 100000,
			},
		});
		const executor = new PiNodeExecutor({ cwd: directory, hasUI: false, piCommand: fakePi });
		const result = await new GraphEngine(graph, executor).run({ input: { task: "ship it" }, checkpoint: false });
		assert.equal(result.status, "completed");
		assert.deepEqual(getPath(result.state, "review"), { approved: true });
		assert.equal(result.usage.inputTokens, 10);
		assert.equal(result.usage.outputTokens, 4);
		assert.equal(result.usage.cacheReadTokens, 1);
		assert.equal(result.usage.costUsd, 0.002);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("shared context appends messages to graph state and injects them into the next node", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-shared-"));
	try {
		const fakePi = join(directory, "fake-pi.mjs");
		await writeFile(
			fakePi,
			`#!/usr/bin/env node\nlet input = "";\nfor await (const chunk of process.stdin) input += chunk;\nconst occurrences = input.split("first-response").length - 1;
const text = input.includes("second instruction") ? (occurrences === 1 ? "saw-first-response-once" : "duplicate-count-" + occurrences) : "first-response";\nconst message = { role: "assistant", content: [{ type: "text", text }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, model: "fake/model", stopReason: "stop" };\nprocess.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");\n`,
			{ encoding: "utf8", mode: 0o755 },
		);
		await chmod(fakePi, 0o755);
		const graph = compileGraph({
			schemaVersion: 2,
			name: "shared-history",
			entry: "first",
			nodes: {
				first: {
					type: "agent",
					prompt: "first instruction",
					readOnly: true,
					tools: [],
					output: "outputs.first",
					context: { mode: "shared", messagesPath: "conversation.messages" },
				},
				second: {
					type: "agent",
					prompt: "second instruction",
					readOnly: true,
					tools: [],
					output: "outputs.second",
					reads: ["outputs.first"],
					context: { mode: "shared", messagesPath: "conversation.messages" },
				},
			},
			edges: [{ from: "first", to: "second" }],
			limits: {
				maxSteps: 3,
				maxNodeRuns: 3,
				maxConcurrency: 1,
				maxCostUsd: 1,
				maxTokens: 1000,
				timeoutMs: 10000,
				maxStateBytes: 100000,
			},
		});
		const executor = new PiNodeExecutor({ cwd: directory, hasUI: false, piCommand: fakePi });
		const result = await new GraphEngine(graph, executor).run({ checkpoint: false });
		assert.equal(result.status, "completed");
		assert.equal(getPath(result.state, "outputs.second"), "saw-first-response-once");
		const messages = getPath(result.state, "conversation.messages") as Array<Record<string, unknown>>;
		assert.deepEqual(
			messages.map((message) => [message.role, message.statePath]),
			[
				["assistant", "outputs.first"],
				["assistant", "outputs.second"],
			],
		);
		assert.ok(messages.every((message) => typeof message.content === "string" && !message.content.includes("first-response")));
		assert.ok(messages.every((message) => typeof message.stateHash === "string" && message.stateHash.length === 64));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("compact shared references do not replay a newer value as historical output", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-shared-reference-integrity-"));
	try {
		const fakePi = join(directory, "fake-pi.mjs");
		const counter = join(directory, "counter");
		await writeFile(
			fakePi,
			`#!/usr/bin/env node\nimport { readFile, writeFile } from "node:fs/promises";\nlet input = ""; for await (const chunk of process.stdin) input += chunk;\nlet count = 0; try { count = Number(await readFile(${JSON.stringify(counter)}, "utf8")); } catch {}\ncount += 1; await writeFile(${JSON.stringify(counter)}, String(count));\nlet text;\nif (count === 1) text = "old-value";\nelse if (count === 2) text = "new-value";\nelse text = JSON.stringify({ oldCount: input.split("old-value").length - 1, newCount: input.split("new-value").length - 1, overwrittenMarker: input.includes("state path was overwritten") });\nconst message = { role: "assistant", content: [{ type: "text", text }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, model: "fake/model", stopReason: "stop" };\nprocess.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");\n`,
			{ encoding: "utf8", mode: 0o755 },
		);
		await chmod(fakePi, 0o755);
		const graph = compileGraph({
			schemaVersion: 2,
			name: "shared-reference-integrity",
			entry: "first",
			nodes: {
				first: {
					type: "agent",
					prompt: "first",
					readOnly: true,
					tools: [],
					output: "shared.latest",
					context: { mode: "shared", messagesPath: "conversation.messages" },
				},
				second: {
					type: "agent",
					prompt: "second",
					readOnly: true,
					tools: [],
					output: "shared.latest",
					context: { mode: "shared", messagesPath: "conversation.messages" },
				},
				observer: {
					type: "agent",
					prompt: "observe",
					readOnly: true,
					tools: [],
					output: "result.observation",
					response: { format: "json" },
					context: { mode: "shared", messagesPath: "conversation.messages", capture: "none" },
				},
			},
			edges: [
				{ from: "first", to: "second" },
				{ from: "second", to: "observer" },
			],
		});
		const result = await new GraphEngine(graph, new PiNodeExecutor({ cwd: directory, hasUI: false, piCommand: fakePi })).run({
			checkpoint: false,
		});
		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(getPath(result.state, "result.observation"), {
			oldCount: 0,
			newCount: 1,
			overwrittenMarker: true,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("shared message retention prunes the durable channel after each commit", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-shared-retention-"));
	try {
		const fakePi = join(directory, "fake-pi.mjs");
		const counter = join(directory, "counter");
		await writeFile(
			fakePi,
			`#!/usr/bin/env node\nimport { readFile, writeFile } from "node:fs/promises";\nfor await (const _chunk of process.stdin) {}\nlet count = 0; try { count = Number(await readFile(${JSON.stringify(counter)}, "utf8")); } catch {}\ncount += 1; await writeFile(${JSON.stringify(counter)}, String(count));\nconst message = { role: "assistant", content: [{ type: "text", text: "turn-" + count }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, model: "fake/model", stopReason: "stop" };\nprocess.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");\n`,
			{ encoding: "utf8", mode: 0o755 },
		);
		await chmod(fakePi, 0o755);
		const graph = compileGraph({
			schemaVersion: 2,
			name: "shared-retention",
			entry: "worker",
			nodes: {
				worker: {
					type: "agent",
					prompt: "continue",
					readOnly: true,
					tools: [],
					response: { storeOutput: false },
					context: {
						mode: "shared",
						messagesPath: "conversation.messages",
						capture: "assistant-only",
						maxStoredMessages: 2,
					},
				},
			},
			edges: [{ from: "worker", to: "worker" }],
			limits: { maxSteps: 4, maxNodeRuns: 8, maxConcurrency: 1, maxCostUsd: 1, maxTokens: 1000, timeoutMs: 10000, maxStateBytes: 100000 },
		});
		const result = await new GraphEngine(graph, new PiNodeExecutor({ cwd: directory, hasUI: false, piCommand: fakePi })).run({
			checkpoint: false,
		});
		assert.equal(result.status, "failed");
		const messages = getPath(result.state, "conversation.messages") as Array<Record<string, unknown>>;
		assert.deepEqual(messages.map((message) => message.content), ["turn-3", "turn-4"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("shared assistant-only capture can be the canonical output without duplicating a node output path", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-shared-canonical-"));
	try {
		const fakePi = join(directory, "fake-pi.mjs");
		await writeFile(
			fakePi,
			`#!/usr/bin/env node\nfor await (const _chunk of process.stdin) {}\nconst message = { role: "assistant", content: [{ type: "text", text: "only-copy" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, model: "fake/model", stopReason: "stop" };\nprocess.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");\n`,
			{ encoding: "utf8", mode: 0o755 },
		);
		await chmod(fakePi, 0o755);
		const graph = compileGraph({
			schemaVersion: 2,
			name: "shared-canonical",
			entry: "debater",
			nodes: {
				debater: {
					type: "agent",
					prompt: "debate",
					readOnly: true,
					tools: [],
					response: { storeOutput: false },
					context: { mode: "shared", messagesPath: "debate.messages", capture: "assistant-only" },
				},
			},
		});
		const result = await new GraphEngine(graph, new PiNodeExecutor({ cwd: directory, hasUI: false, piCommand: fakePi })).run({
			checkpoint: false,
		});
		assert.equal(getPath(result.state, "outputs.debater"), undefined);
		assert.deepEqual(
			(getPath(result.state, "debate.messages") as Array<Record<string, unknown>>).map((message) => message.content),
			["only-copy"],
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("prompt construction omits reads already interpolated by the template", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-prompt-dedupe-"));
	try {
		const fakePi = join(directory, "fake-pi.mjs");
		await writeFile(
			fakePi,
			`#!/usr/bin/env node\nlet input = ""; for await (const chunk of process.stdin) input += chunk;\nconst count = input.split("UNIQUE-EVIDENCE").length - 1;\nconst message = { role: "assistant", content: [{ type: "text", text: String(count) }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, model: "fake/model", stopReason: "stop" };\nprocess.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");\n`,
			{ encoding: "utf8", mode: 0o755 },
		);
		await chmod(fakePi, 0o755);
		const graph = compileGraph({
			schemaVersion: 2,
			name: "prompt-dedupe",
			entry: "worker",
			initialState: { evidence: "UNIQUE-EVIDENCE" },
			nodes: {
				worker: {
					type: "agent",
					prompt: "Evidence={{evidence}}",
					reads: ["evidence"],
					readOnly: true,
					tools: [],
					output: "count",
				},
			},
		});
		const result = await new GraphEngine(graph, new PiNodeExecutor({ cwd: directory, hasUI: false, piCommand: fakePi })).run({
			checkpoint: false,
		});
		assert.equal(getPath(result.state, "count"), "1");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("prompt byte budgets fail before spawning Pi", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-prompt-budget-"));
	try {
		const marker = join(directory, "spawned");
		const fakePi = join(directory, "fake-pi.mjs");
		await writeFile(fakePi, `#!/usr/bin/env node\nimport { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(marker)}, "yes");\n`, {
			encoding: "utf8",
			mode: 0o755,
		});
		await chmod(fakePi, 0o755);
		const graph = compileGraph({
			schemaVersion: 2,
			name: "prompt-budget",
			entry: "worker",
			initialState: { evidence: "x".repeat(2000) },
			nodes: {
				worker: {
					type: "agent",
					prompt: "Review",
					reads: ["evidence"],
					readOnly: true,
					tools: [],
					limits: { maxPromptBytes: 510 },
				},
			},
		});
		assert.deepEqual(graph.definition.nodes.worker.limits, { maxPromptBytes: 510 });
		const result = await new GraphEngine(graph, new PiNodeExecutor({ cwd: directory, hasUI: false, piCommand: fakePi })).run({
			checkpoint: false,
		});
		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /maxPromptBytes/);
		await assert.rejects(readFile(marker, "utf8"), /ENOENT/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("artifact response storage keeps full output out of graph state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-artifact-"));
	try {
		const fakePi = join(directory, "fake-pi.mjs");
		const report = "# Report\\n\\n" + "evidence ".repeat(1000);
		await writeFile(
			fakePi,
			`#!/usr/bin/env node\nfor await (const _chunk of process.stdin) {}\nconst message = { role: "assistant", content: [{ type: "text", text: ${JSON.stringify(report)} }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, model: "fake/model", stopReason: "stop" };\nprocess.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");\n`,
			{ encoding: "utf8", mode: 0o755 },
		);
		await chmod(fakePi, 0o755);
		const graph = compileGraph({
			schemaVersion: 2,
			name: "artifact-output",
			entry: "reporter",
			nodes: {
				reporter: {
					type: "agent",
					prompt: "report",
					readOnly: true,
					tools: [],
					output: "result.report",
					response: { storage: "artifact", mediaType: "text/markdown", previewBytes: 64, maxBytes: 20000 },
				},
			},
			result: { paths: ["result.report"] },
		});
		const artifactsDir = join(directory, "artifacts");
		const result = await new GraphEngine(
			graph,
			new PiNodeExecutor({ cwd: directory, hasUI: false, piCommand: fakePi, artifactsDir }),
		).run({ checkpoint: false });
		const reference = getPath(result.state, "result.report") as Record<string, unknown>;
		assert.equal(reference.kind, "artifact");
		assert.equal(reference.bytes, Buffer.byteLength(report, "utf8"));
		assert.equal(await readFile(String(reference.uri), "utf8"), report);
		assert.ok(Buffer.byteLength(JSON.stringify(result.state), "utf8") < 1000);
		assert.deepEqual(result.result, { result: { report: reference } });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("thread context resumes the same private Pi session after a graph interrupt", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-thread-"));
	try {
		const fakePi = join(directory, "fake-pi.mjs");
		await writeFile(
			fakePi,
			`#!/usr/bin/env node\nimport { readFile, writeFile } from "node:fs/promises";\nlet input = "";\nfor await (const chunk of process.stdin) input += chunk;\nconst args = process.argv.slice(2);\nconst value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };\nconst sessionFile = value("--session");\nif (!sessionFile || args.includes("--no-session") || args.includes("--session-id")) process.exit(7);\nconst counterPath = sessionFile + ".counter";\nlet count = 0;\ntry { count = Number(await readFile(counterPath, "utf8")); } catch {}\ncount += 1;\nawait writeFile(counterPath, String(count));\nconst message = { role: "assistant", content: [{ type: "text", text: "thread-turn-" + count }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, model: "fake/model", stopReason: "stop" };\nprocess.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");\n`,
			{ encoding: "utf8", mode: 0o755 },
		);
		await chmod(fakePi, 0o755);
		const checkpointDir = join(directory, "checkpoints");
		const threadDir = join(directory, "threads");
		const store = new FileCheckpointStore(checkpointDir);
		const graph = compileGraph({
			schemaVersion: 2,
			name: "thread-resume",
			entry: "first",
			nodes: {
				first: {
					type: "agent",
					prompt: "first",
					readOnly: true,
					tools: [],
					output: "outputs.first",
					context: { mode: "thread", threadKey: "coder" },
				},
				approval: { type: "human", kind: "confirm", prompt: "continue?", output: "approved", pause: true },
				second: {
					type: "agent",
					prompt: "second",
					readOnly: true,
					tools: [],
					output: "outputs.second",
					context: { mode: "thread", threadKey: "coder" },
				},
			},
			edges: [
				{ from: "first", to: "approval" },
				{ from: "approval", to: "second" },
			],
			limits: {
				maxSteps: 4,
				maxNodeRuns: 4,
				maxConcurrency: 1,
				maxCostUsd: 1,
				maxTokens: 1000,
				timeoutMs: 30000,
				maxStateBytes: 100000,
			},
		});
		const firstExecutor = new PiNodeExecutor({ cwd: directory, hasUI: false, piCommand: fakePi, threadSessionsDir: threadDir });
		const interrupted = await new GraphEngine(graph, firstExecutor, { checkpointStore: store }).run({ checkpoint: true });
		assert.equal(interrupted.status, "interrupted");
		assert.equal(getPath(interrupted.state, "outputs.first"), "thread-turn-1");

		const secondExecutor = new PiNodeExecutor({ cwd: directory, hasUI: false, piCommand: fakePi, threadSessionsDir: threadDir });
		const resumed = await new GraphEngine(graph, secondExecutor, { checkpointStore: store }).run({
			runId: interrupted.runId,
			resumeValue: true,
			checkpoint: true,
		});
		assert.equal(resumed.status, "completed", resumed.error);
		assert.equal(getPath(resumed.state, "outputs.second"), "thread-turn-2");
		const { snapshot } = await store.load(interrupted.runId);
		assert.equal(snapshot.threads?.coder?.nodes.includes("first"), true);
		assert.equal(snapshot.threads?.coder?.nodes.includes("second"), true);
		assert.match(snapshot.threads?.coder?.sessionId ?? "", /^[0-9a-f-]{36}$/i);
		assert.equal(snapshot.threads?.coder?.invocationCount, 2);
		assert.equal(snapshot.threads?.coder?.lastNodeId, "second");
		const sessionFile = join(threadDir, interrupted.runId, `${snapshot.threads?.coder?.sessionId}.jsonl`);
		const sessionMode = (await stat(sessionFile)).mode & 0o777;
		if (process.platform !== "win32") assert.equal(sessionMode, 0o600);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("thread context refuses to silently reset a missing private session", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-thread-missing-"));
	try {
		const fakePi = join(directory, "fake-pi.mjs");
		await writeFile(
			fakePi,
			`#!/usr/bin/env node\nlet input = "";\nfor await (const chunk of process.stdin) input += chunk;\nconst message = { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, model: "fake/model", stopReason: "stop" };\nprocess.stdout.write(JSON.stringify({ type: "message_end", message }) + "\\n");\n`,
			{ encoding: "utf8", mode: 0o755 },
		);
		await chmod(fakePi, 0o755);
		const checkpointDir = join(directory, "checkpoints");
		const threadDir = join(directory, "threads");
		const store = new FileCheckpointStore(checkpointDir);
		const graph = compileGraph({
			schemaVersion: 2,
			name: "thread-missing",
			entry: "worker",
			nodes: {
				worker: {
					type: "agent",
					prompt: "work",
					readOnly: true,
					tools: [],
					output: "result",
					context: { mode: "thread" },
				},
				approval: { type: "human", kind: "confirm", prompt: "continue?", pause: true },
				second: {
					type: "agent",
					prompt: "continue work",
					readOnly: true,
					tools: [],
					output: "secondResult",
					context: { mode: "thread", threadKey: "worker" },
				},
			},
			edges: [
				{ from: "worker", to: "approval" },
				{ from: "approval", to: "second" },
			],
			limits: {
				maxSteps: 4,
				maxNodeRuns: 4,
				maxConcurrency: 1,
				maxCostUsd: 1,
				maxTokens: 1000,
				timeoutMs: 10000,
				maxStateBytes: 100000,
			},
		});
		const executor = new PiNodeExecutor({ cwd: directory, hasUI: false, piCommand: fakePi, threadSessionsDir: threadDir });
		const interrupted = await new GraphEngine(graph, executor, { checkpointStore: store }).run({ checkpoint: true });
		assert.equal(interrupted.status, "interrupted");
		const { snapshot } = await store.load(interrupted.runId);
		const thread = snapshot.threads?.worker;
		assert.ok(thread);
		await rm(join(threadDir, interrupted.runId, `${thread.sessionId}.jsonl`));

		const failed = await new GraphEngine(graph, executor, { checkpointStore: store }).run({
			runId: interrupted.runId,
			resumeValue: true,
			checkpoint: true,
		});
		assert.equal(failed.status, "failed");
		assert.match(failed.error ?? "", /missing|silently reset/i);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("shared context rejects malformed message state without retrying the agent", async () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "shared-invalid-state",
		entry: "worker",
		initialState: { conversation: { messages: { invalid: true } } },
		nodes: {
			worker: {
				type: "agent",
				prompt: "work",
				readOnly: true,
				tools: [],
				context: { mode: "shared", messagesPath: "conversation.messages" },
				retry: { maxAttempts: 2 },
				idempotent: true,
			},
		},
		limits: {
			maxSteps: 2,
			maxNodeRuns: 3,
			maxConcurrency: 1,
			maxCostUsd: 1,
			maxTokens: 1000,
			timeoutMs: 10000,
			maxStateBytes: 100000,
		},
	});
	const executor = new PiNodeExecutor({ cwd: process.cwd(), hasUI: false, piCommand: "should-not-run" });
	const result = await new GraphEngine(graph, executor).run({ checkpoint: false });
	assert.equal(result.status, "failed");
	assert.match(result.error ?? "", /must be an array/);
	assert.equal(result.nodeRuns, 1);
});
