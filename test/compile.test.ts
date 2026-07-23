import assert from "node:assert/strict";
import test from "node:test";
import { GraphValidationError, compileGraph } from "../src/compile.ts";
import type { GraphDefinition } from "../src/types.ts";

test("compiler flags a reviewer that is not read-only", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "review",
		entry: "reviewer",
		nodes: {
			reviewer: { type: "agent", purpose: "reviewer", prompt: "review" },
		},
		limits: { maxSteps: 2, maxNodeRuns: 2, maxConcurrency: 1, maxCostUsd: 1, maxTokens: 1000, timeoutMs: 1000, maxStateBytes: 1000 },
	});
	assert.ok(graph.diagnostics.some((item) => item.code === "REVIEWER_NOT_READ_ONLY"));
});

test("compiler rejects schemaVersion 1 even when called directly", () => {
	const definition = {
		schemaVersion: Number("1"),
		name: "old-schema",
		entry: "worker",
		nodes: { worker: { type: "agent", prompt: "work", readOnly: true } },
	};
	assert.throws(
		() => compileGraph(definition as unknown as GraphDefinition),
		(error: unknown) => error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "SCHEMA_VERSION"),
	);
});

test("compiler rejects removed v1 fields and purpose outside agent nodes", () => {
	const base = {
		schemaVersion: 2,
		name: "v2-removed-fields",
		entry: "worker",
		nodes: { worker: { type: "agent", prompt: "work", readOnly: true } },
	};
	const cases = [
		{
			path: "limits.maxEstimatedInputTokens",
			definition: { ...base, limits: { maxEstimatedInputTokens: 100 } },
		},
		{
			path: "nodes.worker.limits.maxOutputBytes",
			definition: {
				...base,
				nodes: { worker: { ...base.nodes.worker, limits: { maxOutputBytes: 1024 } } },
			},
		},
		{
			path: "nodes.worker.limits.maxEstimatedInputTokens",
			definition: {
				...base,
				nodes: { worker: { ...base.nodes.worker, limits: { maxEstimatedInputTokens: 100 } } },
			},
		},
		{
			path: "statePolicy.maxHotStateBytes",
			definition: { ...base, statePolicy: { maxHotStateBytes: 1024 } },
		},
		{
			path: "nodes.worker.purpose",
			definition: {
				...base,
				nodes: { worker: { type: "set", purpose: "reviewer", assign: [{ path: "done", value: true }] } },
			},
		},
	] as const;

	for (const { definition, path } of cases) {
		assert.throws(
			() => compileGraph(definition as unknown as GraphDefinition),
			(error: unknown) =>
				error instanceof GraphValidationError &&
				error.diagnostics.some((item) => item.code === "UNKNOWN_FIELD" && item.path === path),
			path,
		);
	}
});

test("compiler rejects unsupported agent purpose values", () => {
	const definition = {
		schemaVersion: 2,
		name: "unsupported-purpose",
		entry: "worker",
		nodes: { worker: { type: "agent", purpose: "worker", prompt: "work", readOnly: true } },
	};
	assert.throws(
		() => compileGraph(definition as unknown as GraphDefinition),
		(error: unknown) =>
			error instanceof GraphValidationError &&
			error.diagnostics.some((item) => item.code === "GRAPH_STRUCTURE" && item.path === "nodes.worker.purpose"),
	);
});

test("compiler rejects unknown destinations", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "bad-edge",
				entry: "a",
				nodes: { a: { type: "set", assign: [{ path: "x", value: 1 }] } },
				edges: [{ from: "a", to: "missing" }],
			}),
		(error: unknown) => error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "UNKNOWN_TARGET"),
	);
});

test("compiler rejects unknown graph control fields with their exact paths", () => {
	const cases = [
		{
			path: "descripton",
			graph: {
				schemaVersion: 2,
				name: "unknown-top-level",
				descripton: "typo",
				entry: "a",
				nodes: { a: { type: "set", assign: [{ path: "x", value: 1 }] } },
			},
		},
		{
			path: "nodes.a.limtis",
			graph: {
				schemaVersion: 2,
				name: "unknown-node-field",
				entry: "a",
				nodes: { a: { type: "set", assign: [{ path: "x", value: 1 }], limtis: { timeoutMs: 1 } } },
			},
		},
		{
			path: "nodes.a.assign.0.paht",
			graph: {
				schemaVersion: 2,
				name: "unknown-assignment-field",
				entry: "a",
				nodes: { a: { type: "set", assign: [{ path: "x", value: 1, paht: "y" }] } },
			},
		},
		{
			path: "limits.maxStepz",
			graph: {
				schemaVersion: 2,
				name: "unknown-limit-field",
				entry: "a",
				nodes: { a: { type: "set", assign: [{ path: "x", value: 1 }] } },
				limits: { maxSteps: 2, maxStepz: 3 },
			},
		},
	] as const;

	for (const { graph, path } of cases) {
		assert.throws(
			() => compileGraph(graph),
			(error: unknown) =>
				error instanceof GraphValidationError &&
				error.diagnostics.some((item) => item.code === "UNKNOWN_FIELD" && item.path === path),
			path,
		);
	}
});

test("compiler keeps graph data objects open", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "open-data",
		entry: "a",
		initialState: { arbitrary: { nested: true, fields: [1, 2, 3] } },
		nodes: {
			a: {
				type: "set",
				assign: [{ path: "payload", value: { arbitrary: { nested: true }, limtis: { anything: "data" } } }],
			},
		},
	});

	assert.deepEqual(graph.definition.initialState, { arbitrary: { nested: true, fields: [1, 2, 3] } });
});

test("compiler rejects onError.to for non-route strategies", () => {
	for (const strategy of ["fail", "continue"] as const) {
		assert.throws(
			() =>
				compileGraph({
					schemaVersion: 2,
					name: `invalid-${strategy}-target`,
					entry: "a",
					nodes: {
						a: { type: "set", assign: [{ path: "x", value: 1 }], onError: { strategy, to: "b" } },
						b: { type: "set", assign: [{ path: "y", value: 1 }] },
					},
				}),
			(error: unknown) => error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "ERROR_ROUTE"),
		);
	}
});

test("compiler validates error-route targets", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "bad-error-route",
				entry: "a",
				nodes: {
					a: { type: "set", assign: [{ path: "x", value: 1 }], onError: { strategy: "route", to: "missing" } },
				},
			}),
		(error: unknown) => error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "UNKNOWN_TARGET"),
	);
});

test("error-route targets drive reachability, cycle, and fan-out analysis", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "error-route-topology",
		entry: "source",
		nodes: {
			source: {
				type: "set",
				assign: [{ path: "started", value: true }],
				onError: { strategy: "route", to: ["left", "right"] },
			},
			left: {
				type: "set",
				assign: [
					{ path: "history", value: "left" },
					{ path: "shared", value: "left" },
				],
			},
			right: { type: "set", assign: [{ path: "shared", value: "right" }] },
		},
		edges: [{ from: "left", to: "source" }],
		reducers: { history: "append" },
	});

	assert.ok(!graph.diagnostics.some((item) => item.code === "UNREACHABLE_NODE"));
	assert.ok(graph.diagnostics.some((item) => item.code === "ACCUMULATING_REDUCER_IN_CYCLE"));
	assert.ok(graph.diagnostics.some((item) => item.code === "POSSIBLE_PARALLEL_STATE_CONFLICT"));
});

test("compiler rejects prototype-pollution state paths", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "unsafe",
				entry: "a",
				nodes: { a: { type: "set", assign: [{ path: "__proto__.polluted", value: true }] } },
			}),
		/allowed|not allowed/,
	);
});

test("compiler rejects node ids that collide with object prototype keys", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "unsafe-node-id",
				entry: "constructor",
				nodes: { constructor: { type: "set" as const, assign: [{ path: "safe", value: true }] } },
			}),
		/graph\.nodes\.constructor is not allowed/,
	);
});

test("shared context installs an implicit concat reducer", () => {
	const graph = compileGraph({
		schemaVersion: 2,
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

test("compiler accepts collect reducers for current-superstep fan-in", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "collect",
		entry: ["a", "b"],
		nodes: {
			a: { type: "set", assign: [{ path: "results", value: "a" }] },
			b: { type: "set", assign: [{ path: "results", value: "b" }] },
		},
		reducers: { results: "collect" },
	});
	assert.equal(graph.reducers.results, "collect");
});

test("compiler warns when prompt templates and reads inject the same state", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "duplicate-input",
		entry: "worker",
		nodes: {
			worker: {
				type: "agent",
				prompt: "Review {{evidence}}",
				reads: ["evidence"],
				readOnly: true,
			},
		},
	});
	assert.ok(graph.diagnostics.some((item) => item.code === "DUPLICATE_STATE_INJECTION"));
});

test("compiler warns but does not claim to deduplicate parent-child input overlaps", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "overlapping-input",
		entry: "worker",
		nodes: {
			worker: {
				type: "agent",
				prompt: "Review {{evidence.summary}}",
				reads: ["evidence"],
				readOnly: true,
			},
		},
	});
	assert.ok(graph.diagnostics.some((item) => item.code === "OVERLAPPING_STATE_INJECTION"));
});

test("compiler rejects reading a shared message path twice", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "duplicate-shared",
				entry: "worker",
				nodes: {
					worker: {
						type: "agent",
						prompt: "Continue",
						reads: ["conversation.messages"],
						readOnly: true,
						context: { mode: "shared", messagesPath: "conversation.messages" },
					},
				},
			}),
		(error: unknown) =>
			error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "SHARED_MESSAGES_DUPLICATE_READ"),
	);
});

test("compiler rejects interpolating a shared message path twice", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "duplicate-shared-template",
				entry: "worker",
				nodes: {
					worker: {
						type: "agent",
						prompt: "Continue from {{conversation.messages}}",
						readOnly: true,
						context: { mode: "shared", messagesPath: "conversation.messages" },
					},
				},
			}),
		(error: unknown) =>
			error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "SHARED_MESSAGES_DUPLICATE_TEMPLATE"),
	);
});

test("compiler warns when artifact output is copied inline into shared state", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "artifact-inline-shared",
		entry: "writer",
		nodes: {
			writer: {
				type: "agent",
				prompt: "write",
				readOnly: true,
				response: { storage: "artifact" },
				context: { mode: "shared", capture: "assistant-only" },
			},
		},
	});
	assert.ok(graph.diagnostics.some((item) => item.code === "ARTIFACT_SHARED_INLINE_CAPTURE"));
});

test("compiler accepts explicit unset assignments and result projection", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "cleanup",
		entry: "cleanup",
		nodes: {
			cleanup: { type: "set", assign: [{ path: "working", mode: "unset" }] },
		},
		result: { paths: ["result.summary"], includeState: false, maxBytes: 4096 },
	});
	assert.equal(graph.definition.nodes.cleanup.type, "set");
});

test("shared context rejects an incompatible explicit reducer", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
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
				schemaVersion: 2,
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
		schemaVersion: 2,
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
		schemaVersion: 2,
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
				schemaVersion: 2,
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

test("compiler rejects artifact storage when its reference is not retained", () => {
	assert.throws(
		() =>
			compileGraph({
				schemaVersion: 2,
				name: "orphan-artifact",
				entry: "writer",
				nodes: {
					writer: {
						type: "agent",
						prompt: "write",
						readOnly: true,
						response: { storage: "artifact", storeOutput: false },
					},
				},
			}),
		(error: unknown) =>
			error instanceof GraphValidationError && error.diagnostics.some((item) => item.code === "ARTIFACT_REFERENCE_NOT_STORED"),
	);
});

test("compiler warns when shared inline capture duplicates the node output", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "duplicated-shared-output",
		entry: "writer",
		nodes: {
			writer: {
				type: "agent",
				prompt: "write",
				readOnly: true,
				output: "draft",
				context: { mode: "shared", capture: "assistant-only" },
			},
		},
	});
	assert.ok(graph.diagnostics.some((item) => item.code === "SHARED_OUTPUT_DUPLICATED"));
});

test("compiler warns when an accumulating reducer is written inside a cycle", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "cyclic-append",
		entry: "worker",
		nodes: {
			worker: { type: "set", assign: [{ path: "history", value: "round" }] },
			review: { type: "set", assign: [{ path: "approved", value: false }] },
		},
		edges: [
			{ from: "worker", to: "review" },
			{ from: "review", to: "worker" },
		],
		reducers: { history: "append" },
	});
	assert.ok(graph.diagnostics.some((item) => item.code === "ACCUMULATING_REDUCER_IN_CYCLE"));
});

test("bounded shared channels do not warn about cyclic accumulation", () => {
	const graph = compileGraph({
		schemaVersion: 2,
		name: "bounded-shared-cycle",
		entry: "writer",
		nodes: {
			writer: {
				type: "agent",
				prompt: "write",
				readOnly: true,
				context: { mode: "shared", maxStoredMessages: 4 },
			},
		},
		edges: [{ from: "writer", to: "writer" }],
	});
	assert.ok(!graph.diagnostics.some((item) => item.code === "ACCUMULATING_REDUCER_IN_CYCLE"));
});
