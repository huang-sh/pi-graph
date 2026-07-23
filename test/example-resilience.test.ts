import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileGraph } from "../src/compile.ts";
import { GraphEngine } from "../src/engine.ts";
import { PiNodeExecutor } from "../src/pi-executor.ts";
import type {
	GraphDefinition,
	JsonValue,
	NodeDefinition,
	NodeExecutionContext,
	NodeExecutionFailure,
	NodeExecutionResult,
	NodeExecutor,
	StateWrite,
} from "../src/types.ts";
import { emptyUsage, getPath } from "../src/utils.ts";

const here = import.meta.dirname;

function loadExample(name: string): GraphDefinition {
	return JSON.parse(readFileSync(join(here, "..", "examples", `${name}.json`), "utf8")) as GraphDefinition;
}

function nowIso(): string {
	return new Date().toISOString();
}

function success(writes: StateWrite[], output: JsonValue): NodeExecutionResult {
	return { kind: "success", writes, output, usage: emptyUsage(), attempts: 1, startedAt: nowIso(), endedAt: nowIso() };
}

function output(context: NodeExecutionContext, path: string, value: JsonValue): NodeExecutionResult {
	return success([{ path, value, nodeId: context.nodeId }], value);
}

function malformedJsonFailure(): NodeExecutionFailure {
	return {
		kind: "failure",
		error: "Agent response is not valid JSON: Unexpected token '所'",
		code: "AGENT_EXECUTION_ERROR",
		retryable: true,
		usage: emptyUsage(),
		attempts: 1,
		startedAt: nowIso(),
		endedAt: nowIso(),
	};
}

class SharedHandoffExecutor implements NodeExecutor {
	reviewerRuns = 0;
	private readonly alwaysMalformed: boolean;

	constructor(alwaysMalformed = false) {
		this.alwaysMalformed = alwaysMalformed;
	}

	execute(_node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult> {
		switch (context.nodeId) {
			case "analyst":
				return Promise.resolve(output(context, "analysis", "grounded analysis"));
			case "writer":
				return Promise.resolve(output(context, "answer", "a complete answer"));
			case "reviewer":
				this.reviewerRuns += 1;
				if (this.alwaysMalformed || this.reviewerRuns === 1) return Promise.resolve(malformedJsonFailure());
				return Promise.resolve(output(context, "review", { approved: true, issues: [] }));
			default:
				throw new Error(`Unexpected shared-handoff node ${context.nodeId}`);
		}
	}
}

class ResearchReviewExecutor implements NodeExecutor {
	readonly calls: string[] = [];
	repositoryRuns = 0;
	reviewerRuns = 0;
	private readonly neverApprove: boolean;

	constructor(neverApprove = false) {
		this.neverApprove = neverApprove;
	}

	execute(_node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult> {
		this.calls.push(context.nodeId);
		switch (context.nodeId) {
			case "repo_research": {
				this.repositoryRuns += 1;
				const evidence = this.neverApprove ? "src/checkpoint.ts:123 validates recovery state" : "I will inspect the repository next.";
				return Promise.resolve(output(context, "research.repository", evidence));
			}
			case "repo_repair":
				this.repositoryRuns += 1;
				return Promise.resolve(output(context, "research.repository", "src/checkpoint.ts:123 validates recovery state"));
			case "requirements_research":
				return Promise.resolve(output(context, "research.requirements", "Analyze crash recovery with exact source evidence."));
			case "writer": {
				const evidence = String(getPath(context.state, "research.repository") ?? "");
				const draft = evidence.includes("src/checkpoint.ts:123") ? "Grounded analysis citing src/checkpoint.ts:123" : "Process-only plan";
				return Promise.resolve(output(context, "draft", draft));
			}
			case "reviewer": {
				this.reviewerRuns += 1;
				const grounded = String(getPath(context.state, "draft") ?? "").includes("src/checkpoint.ts:123");
				const approved = grounded && !this.neverApprove;
				return Promise.resolve(
					output(context, "review", {
						approved,
						score: approved ? 0.95 : grounded ? 0.7 : 0.1,
						needsRepositoryResearch: !grounded,
						issues: approved ? [] : [grounded ? "One non-blocking issue remains" : "Repository evidence is missing"],
						requiredChanges: approved ? [] : [grounded ? "Clarify the risk" : "Read src/checkpoint.ts"],
					}),
				);
			}
			case "record_review": {
				return Promise.resolve(output(context, "control.reviewRounds", 1));
			}
			case "finalize":
				return Promise.resolve(
					success(
						[
							{ path: "result.status", value: "approved", nodeId: context.nodeId },
							{ path: "result.proposal", value: getPath(context.state, "draft") ?? null, nodeId: context.nodeId },
							{ path: "result.review", value: getPath(context.state, "review") ?? null, nodeId: context.nodeId },
						],
						"approved",
					),
				);
			case "best_effort":
				return Promise.resolve(
					success(
						[
							{ path: "result.status", value: "best-effort", nodeId: context.nodeId },
							{ path: "result.proposal", value: getPath(context.state, "draft") ?? null, nodeId: context.nodeId },
							{ path: "result.review", value: getPath(context.state, "review") ?? null, nodeId: context.nodeId },
						],
						"best-effort",
					),
				);
			default:
				throw new Error(`Unexpected research-review node ${context.nodeId}`);
		}
	}
}

test("shared-handoff retries a reviewer that returns malformed JSON", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-shared-review-retry-"));
	try {
		const fakePi = join(directory, "fake-pi.mjs");
		const counter = join(directory, "counter");
		await writeFile(
			fakePi,
			`#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { writeSync } from "node:fs";
for await (const _chunk of process.stdin) {}
let count = 0;
try { count = Number(await readFile(${JSON.stringify(counter)}, "utf8")); } catch {}
count += 1;
await writeFile(${JSON.stringify(counter)}, String(count));
const text = count === 1 ? "grounded analysis" : count === 2 ? "a complete answer" : count === 3 ? "所有主张均已根据实际源码核验。" : '{"approved":true,"issues":[]}';
const message = { role: "assistant", content: [{ type: "text", text }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, model: "fake/model", stopReason: "stop" };
writeSync(1, JSON.stringify({ type: "message_end", message }) + "\\n");
`,
			{ encoding: "utf8", mode: 0o755 },
		);
		await chmod(fakePi, 0o755);
		const result = await new GraphEngine(
			compileGraph(loadExample("shared-handoff")),
			new PiNodeExecutor({ cwd: directory, hasUI: false, piCommand: fakePi }),
		).run({ input: { task: "Explain pi-graph" }, checkpoint: false });
		assert.equal(result.status, "completed", result.error);
		assert.equal(readFileSync(counter, "utf8"), "4");
		assert.equal(getPath(result.state, "review.approved"), true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("shared-handoff preserves the answer when reviewer JSON retries are exhausted", async () => {
	const executor = new SharedHandoffExecutor(true);
	const result = await new GraphEngine(compileGraph(loadExample("shared-handoff")), executor).run({
		input: { task: "Explain pi-graph" },
		checkpoint: false,
	});
	assert.equal(result.status, "completed", result.error);
	assert.equal(executor.reviewerRuns, 3);
	assert.equal(getPath(result.state, "answer"), "a complete answer");
	assert.match(String(getPath(result.state, "errors.reviewer.message")), /not valid JSON/);
});

test("research-review can re-run repository research after a reviewer detects missing evidence", async () => {
	const executor = new ResearchReviewExecutor();
	const result = await new GraphEngine(compileGraph(loadExample("research-review")), executor).run({
		input: { task: "Analyze src/checkpoint.ts crash recovery" },
		checkpoint: false,
	});
	assert.equal(result.status, "completed", result.error);
	assert.equal(executor.repositoryRuns, 2);
	assert.equal(executor.reviewerRuns, 2);
	assert.equal(getPath(result.state, "result.status"), "approved");
	assert.match(String(getPath(result.state, "result.proposal")), /src\/checkpoint\.ts:123/);
});

test("research-review returns an explicit best-effort result instead of exhausting maxSteps", async () => {
	const executor = new ResearchReviewExecutor(true);
	const result = await new GraphEngine(compileGraph(loadExample("research-review")), executor).run({
		input: { task: "Analyze src/checkpoint.ts crash recovery" },
		checkpoint: false,
	});
	assert.equal(result.status, "completed", result.error);
	assert.equal(executor.reviewerRuns, 3);
	assert.equal(getPath(result.state, "result.status"), "best-effort");
	assert.match(String(getPath(result.state, "result.proposal")), /src\/checkpoint\.ts:123/);
});
