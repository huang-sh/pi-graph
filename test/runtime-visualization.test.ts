import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { compileGraph } from "../src/compile.ts";
import { GraphEngine } from "../src/engine.ts";
import { RuntimeGraphMonitor, renderRuntimeGraph } from "../src/runtime-visualization.ts";
import type {
	AgentNodeDefinition,
	GraphDefinition,
	GraphRunEvent,
	NodeDefinition,
	NodeExecutionContext,
	NodeExecutionResult,
	NodeExecutionSuccess,
	NodeExecutor,
} from "../src/types.ts";
import { emptyUsage } from "../src/utils.ts";

const graphDefinition: GraphDefinition = {
	schemaVersion: 2,
	name: "live-board",
	entry: "plan",
	nodes: {
		plan: agentNode(),
		research: agentNode(),
		implement: agentNode(),
		review: agentNode(),
	},
	edges: [
		{ from: "plan", to: ["research", "implement"] },
		{ from: ["research", "implement"], to: "review" },
	],
	routes: [{ from: "review", cases: [], default: "plan" }],
};

test("runtime monitor renders the active graph location, retries, topology, and bounded output", () => {
	let now = 1_000;
	const monitor = new RuntimeGraphMonitor(graphDefinition, { now: () => now });
	monitor.apply(event("graph_start", { runId: "12345678-abcd", status: "running", step: 0 }));
	monitor.apply(event("step_start", { step: 1, scheduled: ["plan"] }));
	monitor.apply(event("node_start", { step: 1, nodeId: "plan", attempt: 1 }));
	now += 2_500;

	let lines = renderRuntimeGraph(monitor.view());
	assert.ok(lines.length <= 10);
	assert.match(lines[0], /live-board · RUNNING · step 1 · 12345678/);
	assert.ok(lines.some((line) => /● plan · running · attempt 1 · 2s/.test(line)));
	assert.ok(lines.some((line) => line.includes("→ research, implement")));

	monitor.apply(event("node_settled", { step: 1, nodeId: "plan", attempt: 1, status: "completed" }));
	monitor.apply(event("node_end", { step: 1, nodeId: "plan", status: "completed" }));
	monitor.apply(event("step_start", { step: 2, scheduled: ["research", "implement"] }));
	monitor.apply(event("node_start", { step: 2, nodeId: "research", attempt: 1 }));
	monitor.apply(event("node_retry", { step: 2, nodeId: "research", attempt: 2, message: "temporary timeout" }));
	monitor.apply(event("node_start", { step: 2, nodeId: "implement", attempt: 1 }));

	lines = renderRuntimeGraph(monitor.view());
	assert.ok(lines.length <= 10);
	assert.ok(
		lines.some((line) => line.includes("↻ research · retrying · attempt 2") && line.includes("temporary timeout")),
	);
	assert.ok(lines.some((line) => /● implement · running · attempt 1/.test(line)));
	assert.match(lines[1], /active 2 · done 1\/4 · runs 3/);
});

test("runtime graph truncation respects terminal width for wide characters", () => {
	const definition: GraphDefinition = {
		...graphDefinition,
		name: "研究".repeat(30),
	};
	const monitor = new RuntimeGraphMonitor(definition);
	monitor.apply(event("graph_start", { status: "running" }));
	const lines = renderRuntimeGraph(monitor.view(), { maxLineLength: 40 });

	assert.ok(lines.every((line) => visibleWidth(line) <= 40));
	assert.ok(lines[0].includes("…"));
});

test("engine exposes structured scheduling and actual node settlement before bulk reconciliation", async () => {
	const definition: GraphDefinition = {
		schemaVersion: 2,
		name: "live-events",
		entry: ["first", "comma,node"],
		nodes: { first: agentNode(), "comma,node": agentNode() },
		limits: {
			maxSteps: 2,
			maxNodeRuns: 4,
			maxConcurrency: 1,
			maxCostUsd: 1,
			maxTokens: 1000,
			timeoutMs: 10_000,
			maxStateBytes: 100_000,
		},
	};
	let releaseSecond: (() => void) | undefined;
	let markSecondStarted: (() => void) | undefined;
	const secondStarted = new Promise<void>((resolve) => {
		markSecondStarted = resolve;
	});
	const secondGate = new Promise<void>((resolve) => {
		releaseSecond = resolve;
	});
	const events: GraphRunEvent[] = [];
	const executor: NodeExecutor = {
		async execute(_node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult> {
			if (context.nodeId === "comma,node") {
				markSecondStarted?.();
				await secondGate;
			}
			return success(context);
		},
	};

	const run = new GraphEngine(compileGraph(definition), executor).run({
		checkpoint: false,
		onEvent: (runtimeEvent) => {
			events.push(runtimeEvent);
		},
	});
	await secondStarted;

	const stepStart = events.find((runtimeEvent) => runtimeEvent.type === "step_start");
	assert.deepEqual(stepStart?.scheduled, ["first", "comma,node"]);
	assert.ok(events.some((runtimeEvent) => runtimeEvent.type === "node_settled" && runtimeEvent.nodeId === "first"));
	assert.ok(events.some((runtimeEvent) => runtimeEvent.type === "node_start" && runtimeEvent.nodeId === "comma,node"));
	assert.equal(events.some((runtimeEvent) => runtimeEvent.type === "node_end"), false);

	releaseSecond?.();
	await run;
	assert.deepEqual(
		events.filter((runtimeEvent) => runtimeEvent.type === "node_settled").map((runtimeEvent) => runtimeEvent.nodeId),
		["first", "comma,node"],
	);
	assert.deepEqual(
		events.filter((runtimeEvent) => runtimeEvent.type === "node_end").map((runtimeEvent) => runtimeEvent.nodeId),
		["first", "comma,node"],
	);
});

test("cancellation waits for active workers and never emits events after graph_end", async () => {
	const definition: GraphDefinition = {
		schemaVersion: 2,
		name: "cancel-events",
		entry: ["retrying", "slow"],
		nodes: {
			retrying: { ...agentNode(), retry: { maxAttempts: 2, backoffMs: 60_000 } },
			slow: agentNode(),
		},
		limits: {
			maxSteps: 2,
			maxNodeRuns: 4,
			maxConcurrency: 2,
			maxCostUsd: 1,
			maxTokens: 1000,
			timeoutMs: 10_000,
			maxStateBytes: 100_000,
		},
	};
	let releaseSlow: (() => void) | undefined;
	let markSlowStarted: (() => void) | undefined;
	let markRetry: (() => void) | undefined;
	const slowStarted = new Promise<void>((resolve) => {
		markSlowStarted = resolve;
	});
	const retrySeen = new Promise<void>((resolve) => {
		markRetry = resolve;
	});
	const slowGate = new Promise<void>((resolve) => {
		releaseSlow = resolve;
	});
	const events: GraphRunEvent[] = [];
	const executor: NodeExecutor = {
		async execute(_node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult> {
			if (context.nodeId === "retrying") return retryableFailure();
			markSlowStarted?.();
			await slowGate;
			return success(context);
		},
	};
	const controller = new AbortController();
	const run = new GraphEngine(compileGraph(definition), executor).run({
		checkpoint: false,
		signal: controller.signal,
		onEvent: (runtimeEvent) => {
			events.push(runtimeEvent);
			if (runtimeEvent.type === "node_retry") markRetry?.();
		},
	});
	await Promise.all([slowStarted, retrySeen]);
	controller.abort();
	let runCompleted = false;
	void run.then(() => {
		runCompleted = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(runCompleted, false);

	releaseSlow?.();
	const result = await run;
	assert.equal(result.status, "cancelled");
	const graphEndIndex = events.findLastIndex((runtimeEvent) => runtimeEvent.type === "graph_end");
	assert.ok(graphEndIndex >= 0);
	assert.ok(
		events.every((runtimeEvent, index) => runtimeEvent.type !== "node_settled" || index < graphEndIndex),
	);
	const eventCount = events.length;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(events.length, eventCount);
});

test("graph failure marks never-started queued nodes as cancelled, not failed", () => {
	const monitor = new RuntimeGraphMonitor(graphDefinition);
	monitor.apply(event("graph_start", { status: "running" }));
	monitor.apply(event("step_start", { step: 1, scheduled: ["plan"] }));
	monitor.apply(event("graph_end", { step: 1, status: "failed", message: "scheduler failed" }));
	assert.equal(monitor.view().nodes.find((node) => node.id === "plan")?.status, "cancelled");
});

function agentNode(): AgentNodeDefinition {
	return { type: "agent", prompt: "test", readOnly: true };
}

function event(type: GraphRunEvent["type"], overrides: Partial<GraphRunEvent> = {}): GraphRunEvent {
	return {
		type,
		runId: "12345678-abcd",
		timestamp: new Date().toISOString(),
		...overrides,
	};
}

function success(context: NodeExecutionContext): NodeExecutionSuccess {
	return {
		kind: "success",
		writes: [],
		usage: emptyUsage(),
		attempts: 1,
		startedAt: new Date().toISOString(),
		endedAt: new Date().toISOString(),
		output: context.nodeId,
	};
}

function retryableFailure(): NodeExecutionResult {
	return {
		kind: "failure",
		error: "temporary failure",
		code: "TEMPORARY",
		retryable: true,
		usage: emptyUsage(),
		attempts: 1,
		startedAt: new Date().toISOString(),
		endedAt: new Date().toISOString(),
	};
}
