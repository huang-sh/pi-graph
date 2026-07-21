import assert from "node:assert/strict";
import test from "node:test";
import { GraphValidationError, compileGraph, parseGraphDefinition } from "../src/compile.ts";

test("compiler flags a reviewer that is not read-only", () => {
	const graph = compileGraph({
		schemaVersion: 1,
		name: "review",
		entry: "reviewer",
		nodes: {
			reviewer: { type: "agent", purpose: "reviewer", prompt: "review" },
		},
		limits: { maxSteps: 2, maxNodeRuns: 2, maxConcurrency: 1, maxCostUsd: 1, maxTokens: 1000, timeoutMs: 1000, maxStateBytes: 1000 },
	});
	assert.ok(graph.diagnostics.some((item) => item.code === "REVIEWER_NOT_READ_ONLY"));
});

test("compiler rejects unknown destinations", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 1,
				name: "bad-edge",
				entry: "a",
				nodes: { a: { type: "set", assign: [{ path: "x", value: 1 }] } },
				edges: [{ from: "a", to: "missing" }],
			}),
		(error: unknown) => error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "UNKNOWN_TARGET"),
	);
});

test("parser rejects prototype-pollution state paths", () => {
	assert.throws(
		() =>
			parseGraphDefinition({
				schemaVersion: 1,
				name: "unsafe",
				entry: "a",
				nodes: { a: { type: "set", assign: [{ path: "__proto__.polluted", value: true }] } },
			}),
		/allowed|not allowed/,
	);
});

test("shared context installs an implicit concat reducer", () => {
	const graph = compileGraph({
		schemaVersion: 1,
		name: "shared-context",
		entry: "writer",
		nodes: {
			writer: {
				type: "agent",
				prompt: "write",
				readOnly: true,
				context: { mode: "shared", messagesPath: "conversation.messages" },
			},
		},
		limits: { maxSteps: 2, maxNodeRuns: 2, maxConcurrency: 1, maxCostUsd: 1, maxTokens: 1000, timeoutMs: 1000, maxStateBytes: 10000 },
	});
	assert.equal(graph.reducers["conversation.messages"], "concat");
});

test("shared context rejects an incompatible explicit reducer", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 1,
				name: "bad-shared-reducer",
				entry: "writer",
				nodes: {
					writer: {
						type: "agent",
						prompt: "write",
						readOnly: true,
						context: { mode: "shared", messagesPath: "messages" },
					},
				},
				reducers: { messages: "replace" },
			}),
		(error: unknown) => error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "SHARED_MESSAGES_REDUCER"),
	);
});

test("compiler rejects parallel nodes sharing one persistent thread", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 1,
				name: "parallel-thread",
				entry: ["a", "b"],
				nodes: {
					a: { type: "agent", prompt: "a", readOnly: true, context: { mode: "thread", threadKey: "coder" } },
					b: { type: "agent", prompt: "b", readOnly: true, context: { mode: "thread", threadKey: "coder" } },
				},
			}),
		(error: unknown) => error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "PARALLEL_THREAD_CONTEXT"),
	);
});

test("compiler warns when a persistent thread node retries", () => {
	const graph = compileGraph({
		schemaVersion: 1,
		name: "thread-retry",
		entry: "coder",
		nodes: {
			coder: {
				type: "agent",
				prompt: "code",
				readOnly: true,
				context: { mode: "thread" },
				retry: { maxAttempts: 2 },
				idempotent: true,
			},
		},
	});
	assert.ok(graph.diagnostics.some((item) => item.code === "THREAD_RETRY_APPENDS_HISTORY"));
});

test("compiler warns when an independent reviewer shares agent history", () => {
	const graph = compileGraph({
		schemaVersion: 1,
		name: "reviewer-history",
		entry: "reviewer",
		nodes: {
			reviewer: {
				type: "agent",
				purpose: "reviewer",
				prompt: "review",
				readOnly: true,
				context: { mode: "shared" },
			},
		},
		limits: { maxSteps: 2, maxNodeRuns: 2, maxConcurrency: 1, maxCostUsd: 1, maxTokens: 1000, timeoutMs: 1000, maxStateBytes: 10000 },
	});
	assert.ok(graph.diagnostics.some((item) => item.code === "REVIEWER_CONTEXT_NOT_ISOLATED"));
});

test("compiler rejects nodes that bind one thread to different working directories", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 1,
				name: "thread-cwd",
				entry: "a",
				nodes: {
					a: { type: "agent", prompt: "a", readOnly: true, cwd: "packages/a", context: { mode: "thread", threadKey: "coder" } },
					b: { type: "agent", prompt: "b", readOnly: true, cwd: "packages/b", context: { mode: "thread", threadKey: "coder" } },
				},
				edges: [{ from: "a", to: "b" }],
			}),
		(error: unknown) => error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "THREAD_CWD_MISMATCH"),
	);
});
