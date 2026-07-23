import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCheckpointStore } from "../src/checkpoint.ts";
import { compileGraph } from "../src/compile.ts";
import { GraphEngine } from "../src/engine.ts";
import type {
	GraphDefinition,
	JsonObject,
	JsonValue,
	NodeDefinition,
	NodeExecutionContext,
	NodeExecutionResult,
	NodeExecutor,
	StateWrite,
} from "../src/types.ts";
import { emptyUsage, getPath } from "../src/utils.ts";

// Loads the REAL shipped example and drives it through the actual engine +
// compiler with a deterministic executor (no model calls). This is the test
// that actually exercises science-research.json's non-linear control flow:
// human gate interrupt/resume, fan-out + barrier, the conflict-triggered
// debate detour, the integrator's nested conditional route, the refinement
// loop through deterministic cleanup, per-superstep collect reducers, and
// compact cross-round memory.
const here = import.meta.dirname;
const definition = JSON.parse(readFileSync(join(here, "..", "examples", "science-research.json"), "utf8")) as GraphDefinition;

function nowIso(): string {
	return new Date().toISOString();
}

/** Deterministic executor that scripts a specific path through the graph. */
class ScenarioExecutor implements NodeExecutor {
	readonly calls: string[] = [];
	round = 0;

	execute(node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult> {
		this.calls.push(context.nodeId);
		return Promise.resolve(this.handle(node, context));
	}

	private ok(writes: StateWrite[], output: JsonValue): NodeExecutionResult {
		return { kind: "success", writes, output, usage: emptyUsage(), attempts: 1, startedAt: nowIso(), endedAt: nowIso() };
	}

	private handle(node: NodeDefinition, context: NodeExecutionContext): NodeExecutionResult {
		const id = context.nodeId;

		// Deterministic set-node handling, including overwrite/unset lifecycle writes.
		if (node.type === "set") {
			const writes: StateWrite[] = [];
			for (const assign of node.assign) {
				const mode = assign.mode ?? "reduce";
				if (mode === "unset") {
					writes.push({ path: assign.path, nodeId: id, mode });
					continue;
				}
				const value = assign.from !== undefined ? getPath(context.state, assign.from) ?? null : assign.value ?? null;
				writes.push({ path: assign.path, value, nodeId: id, mode });
			}
			return this.ok(writes, null);
		}

		switch (id) {
			case "scope_gate": {
				// Human select node: interrupt for input, then accept the resumed value.
				if (context.resumeValue !== undefined) {
					return this.ok([{ path: "control.scope_decision", value: context.resumeValue, nodeId: id }], context.resumeValue);
				}
				return {
					kind: "interrupt",
					interrupt: { nodeId: id, kind: "select", prompt: "Approve the plan?", options: ["approve", "refine"], createdAt: nowIso() },
					usage: emptyUsage(),
					attempts: 1,
					startedAt: nowIso(),
					endedAt: nowIso(),
				};
			}
			case "planner": {
				this.round += 1;
				return this.ok([{ path: "working.plan", value: { round: this.round }, nodeId: id }], { round: this.round });
			}
			case "branch_a":
			case "branch_b":
			case "branch_c":
				return this.ok([{ path: "working.branch_results", value: { angle: id, round: this.round }, nodeId: id }], { angle: id });
			case "evidence_critic": {
				// Round 1: a critical conflict between branches triggers the debate detour.
				const hasCriticalConflicts = this.round === 1;
				return this.ok(
					[{ path: "working.reviewed_evidence", value: { has_critical_conflicts: hasCriticalConflicts }, nodeId: id }],
					{ has_critical_conflicts: hasCriticalConflicts },
				);
			}
			case "devil_advocate":
				return this.ok(
					[
						{
							path: "working.debate.messages",
							value: [{ role: "assistant", content: "skeptic", nodeId: id, createdAt: nowIso(), name: null }],
							nodeId: id,
						},
					],
					{ position: "skeptic" },
				);
			case "defender":
				return this.ok(
					[
						{
							path: "working.debate.messages",
							value: [{ role: "assistant", content: "defender", nodeId: id, createdAt: nowIso(), name: null }],
							nodeId: id,
						},
					],
					{ position: "defender" },
				);
			case "arbiter":
				return this.ok(
					[{ path: "working.debate.verdict", value: { resolved: false, fatal_conflict: false }, nodeId: id }],
					{ resolved: false },
				);
			case "integrator": {
				// Round 1: insufficient -> refine via bump_round -> planner. Round 2: sufficient -> report.
				const sufficient = this.round >= 2;
				const integration = { sufficient, fatal_conflict: false, round: this.round };
				return this.ok([{ path: "working.integration", value: integration, nodeId: id }], integration);
			}
			case "reporter":
				return this.ok(
					[
						{
							path: "result.report_artifact",
							value: { kind: "artifact", uri: "/tmp/report.md", mediaType: "text/markdown", bytes: 10, sha256: "abc", preview: "report" },
							nodeId: id,
						},
					],
					{ done: true },
				);
			default:
				return this.ok([], null);
		}
	}
}

function count(calls: readonly string[], nodeId: string): number {
	return calls.filter((item) => item === nodeId).length;
}

test("science-research: full non-linear control flow (gate, debate detour, refine loop)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-science-"));
	const store = new FileCheckpointStore(directory);
	try {
		const graph = compileGraph(definition);
		const executor = new ScenarioExecutor();
		const engine = new GraphEngine(graph, executor, { checkpointStore: store });

		// First run reaches the human scope gate and interrupts.
		const interrupted = await engine.run({ input: { task: "Is X better than Y?" }, checkpoint: true });
		assert.equal(interrupted.status, "interrupted");
		assert.equal(interrupted.interrupt?.nodeId, "scope_gate");
		assert.equal(interrupted.interrupt?.kind, "select");

		// Resume with "approve" -> drives the rest of the graph to completion.
		const completed = await engine.run({ runId: interrupted.runId, resumeValue: "approve", checkpoint: true });
		assert.equal(completed.status, "completed");

		// --- Human gate: approved, and NOT re-entered on the refinement round ---
		assert.equal(getPath(completed.state, "control.scope_decision"), "approve");
		assert.equal(count(executor.calls, "scope_gate"), 2, "scope_gate runs once (interrupt) + once (resume), never on the refine round");

		// --- Refinement loop: planner/evidence_critic/integrator each ran twice ---
		assert.equal(count(executor.calls, "planner"), 2);
		assert.equal(count(executor.calls, "evidence_critic"), 2);
		assert.equal(count(executor.calls, "integrator"), 2);

		// collect is scoped to one superstep: old round branch results are replaced.
		const branchResults = getPath(completed.state, "working.branch_results");
		assert.ok(Array.isArray(branchResults), "working.branch_results is a current-round collection");
		assert.equal(branchResults.length, 3);
		assert.ok(branchResults.every((item) => getPath(item as JsonObject, "round") === 2), "only round-2 branch cards remain");

		// The conflict-triggered debate ran in round 1, then bump_round removed all
		// round-scoped working data before round 2.
		assert.equal(count(executor.calls, "devil_advocate"), 1);
		assert.equal(count(executor.calls, "defender"), 1);
		assert.equal(count(executor.calls, "arbiter"), 1);
		const idxAdvocate = executor.calls.indexOf("devil_advocate");
		const idxDefender = executor.calls.indexOf("defender");
		const idxArbiter = executor.calls.indexOf("arbiter");
		assert.ok(idxAdvocate < idxDefender && idxDefender < idxArbiter, "debate chain order: advocate -> defender -> arbiter");
		assert.equal(getPath(completed.state, "working.debate"), undefined, "stale round-1 debate was cleaned");

		// The cleanup node keeps only the latest compact cross-round memory.
		assert.equal(getPath(completed.state, "memory.round_summaries"), undefined);
		assert.equal(getPath(completed.state, "memory.last_integration.round"), 1);

		const firstIntegrator = executor.calls.indexOf("integrator");
		const bumpRound = executor.calls.indexOf("bump_round");
		const secondPlanner = executor.calls.indexOf("planner", firstIntegrator);
		assert.ok(firstIntegrator < bumpRound && bumpRound < secondPlanner, "insufficient integrator -> cleanup/archive -> planner");

		assert.equal(getPath(completed.state, "working.integration.sufficient"), true);
		assert.equal(getPath(completed.state, "working.integration.round"), 2);
		assert.equal(getPath(completed.state, "result.report_artifact.kind"), "artifact");
		assert.equal(count(executor.calls, "reporter"), 1);
		assert.equal(completed.includeState, false);
		assert.equal(getPath(completed.result ?? {}, "result.report_artifact.kind"), "artifact");

	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
