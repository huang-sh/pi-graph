/**
 * End-to-end live driver for examples/science-research.json.
 *
 * Unlike test/science-research.test.ts (which uses a deterministic in-process
 * executor with no model calls), this script wires up the REAL PiNodeExecutor
 * that spawns actual `pi` agent subprocesses. It drives the full non-linear
 * control flow — human scope gate (auto-approved), parallel fan-out + barrier,
 * the conditional debate detour, the refinement loop, and the final report —
 * and prints every graph event plus the projected result and artifact report.
 *
 * Run:  npx tsx scripts/run-science-research.ts
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FileCheckpointStore } from "../src/checkpoint.ts";
import { compileGraph } from "../src/compile.ts";
import { GraphEngine } from "../src/engine.ts";
import { PiNodeExecutor } from "../src/pi-executor.ts";
import type {
	CompiledGraph,
	GraphDefinition,
	GraphRunEvent,
	GraphRunResult,
	JsonObject,
	UsageLedger,
} from "../src/types.ts";
import { getPath, isJsonObject, usageTokens } from "../src/utils.ts";

const here = import.meta.dirname;
const examplePath = join(here, "..", "examples", "science-research.json");
const definition = JSON.parse(readFileSync(examplePath, "utf8")) as GraphDefinition;

// Configurable research question — override with the first CLI arg.
const researchQuestion = process.argv[2] ?? "Is intermittent fasting more effective than continuous caloric restriction for long-term weight-loss maintenance in adults with obesity?";

function fmtUsage(usage: UsageLedger | undefined): string {
	if (!usage) return "";
	const tokens = usageTokens(usage);
	const cost = usage.costUsd ? ` $${usage.costUsd.toFixed(4)}` : "";
	return `${tokens} tok${cost}`;
}

function logEvent(event: GraphRunEvent): void {
	const step = event.step !== undefined ? ` s${event.step}` : "";
	const node = event.nodeId ? ` [${event.nodeId}]` : "";
	const attempt = event.attempt !== undefined ? ` #${event.attempt}` : "";
	const status = event.status ? ` ${event.status}` : "";
	const usage = fmtUsage(event.usage);
	const message = event.message ? ` — ${event.message}` : "";
	const ts = new Date(event.timestamp).toISOString().slice(11, 19);
	console.log(`${ts}${step}${event.type}${node}${attempt}${status}${usage ? ` (${usage})` : ""}${message}`);
}

async function driveRun(
	graph: CompiledGraph,
	executor: PiNodeExecutor,
	store: FileCheckpointStore,
	input: JsonObject,
): Promise<GraphRunResult> {
	const engine = new GraphEngine(graph, executor, { checkpointStore: store });

	console.log("\n=== RUN 1: planner -> scope_gate (expects interrupt) ===");
	const first = await engine.run({ input, checkpoint: true, onEvent: logEvent });
	console.log(`\nstatus=${first.status} step=${first.step} nodeRuns=${first.nodeRuns} usage=${fmtUsage(first.usage)}`);

	if (first.status !== "interrupted" || first.interrupt?.nodeId !== "scope_gate") {
		console.error("Expected scope_gate interrupt, got:", first.interrupt);
		return first;
	}

	console.log("\n=== RESUME: approve scope_gate -> full graph to completion ===");
	const completed = await engine.run({ runId: first.runId, resumeValue: "approve", checkpoint: true, onEvent: logEvent });
	console.log(`\nstatus=${completed.status} step=${completed.step} nodeRuns=${completed.nodeRuns} usage=${fmtUsage(completed.usage)}`);
	return completed;
}

async function main(): Promise<void> {
	console.log(`Graph: ${definition.name}`);
	console.log(`Research question: ${researchQuestion}`);

	const workDir = await mkdtemp(join(tmpdir(), "pi-graph-live-"));
	const threadSessionsDir = resolve(join(workDir, "thread-sessions"));
	const store = new FileCheckpointStore(join(workDir, "checkpoints"));

	const graph = compileGraph(definition);
	const executor = new PiNodeExecutor({
		cwd: process.cwd(),
		hasUI: false,
		threadSessionsDir,
		artifactsDir: resolve(join(workDir, "artifacts")),
	});

	const start = Date.now();
	try {
		const result = await driveRun(graph, executor, store, { task: researchQuestion });
		const elapsed = ((Date.now() - start) / 1000).toFixed(1);

		console.log(`\n=== FINAL (elapsed ${elapsed}s) ===`);
		console.log(`status: ${result.status}`);
		if (result.error) console.log(`error: ${result.error}`);
		console.log(`usage: ${fmtUsage(result.usage)}`);
		console.log(`state bytes: ${result.stateBytes}`);
		if (result.result) {
			console.log("\n--- projected result ---");
			console.log(JSON.stringify(result.result, null, 2));
		}
		const report = getPath(result.state, "result.report_artifact");
		if (isJsonObject(report) && typeof report.uri === "string") {
			console.log("\n--- report artifact ---");
			console.log(await readFile(report.uri, "utf8"));
		}
		console.log(`\nCheckpoints: ${workDir}`);
	} finally {
		// Keep the working dir for inspection; comment out to clean up.
		// await rm(workDir, { recursive: true, force: true });
		console.log(`\n(artifacts retained at ${workDir})`);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
