import assert from "node:assert/strict";
import test from "node:test";
import { applyStateWrites, extractTemplatePaths, parseModelJson, renderTemplate } from "../src/utils.ts";

test("template rendering reads explicit dotted state paths", () => {
	assert.equal(renderTemplate("Task={{input.task}} count={{stats.count}}", { input: { task: "ship" }, stats: { count: 2 } }), "Task=ship count=2");
});

test("model JSON parser accepts a single fenced JSON value", () => {
	assert.deepEqual(parseModelJson("```json\n{\"approved\":true}\n```"), { approved: true });
});

test("merge reducer combines parallel object writes deterministically", () => {
	const state = applyStateWrites(
		{},
		[
			{ path: "facts", value: { a: 1 }, nodeId: "a" },
			{ path: "facts", value: { b: 2 }, nodeId: "b" },
		],
		{ facts: "merge" },
	);
	assert.deepEqual(state, { facts: { a: 1, b: 2 } });
});

test("collect reducer replaces the previous round with the current superstep batch", () => {
	const state = applyStateWrites(
		{ branch_results: ["old-a", "old-b"] },
		[
			{ path: "branch_results", value: "new-a", nodeId: "a" },
			{ path: "branch_results", value: "new-b", nodeId: "b" },
		],
		{ branch_results: "collect" },
	);
	assert.deepEqual(state, { branch_results: ["new-a", "new-b"] });
});

test("overwrite and unset write modes bypass reducers and clean stale state", () => {
	const overwritten = applyStateWrites(
		{ history: ["old"] },
		[{ path: "history", value: [], nodeId: "reset", mode: "overwrite" }],
		{ history: "append" },
	);
	assert.deepEqual(overwritten, { history: [] });
	const cleaned = applyStateWrites(overwritten, [{ path: "history", nodeId: "reset", mode: "unset" }], { history: "append" });
	assert.deepEqual(cleaned, {});
});

test("template path extraction deduplicates explicit state references", () => {
	assert.deepEqual(extractTemplatePaths("{{input.task}} {{ evidence.summary }} {{input.task}}"), ["input.task", "evidence.summary"]);
});


test("sum reducer starts from zero when the path is absent", () => {
	const state = applyStateWrites(
		{},
		[
			{ path: "metrics.total", value: 2, nodeId: "a" },
			{ path: "metrics.total", value: 3, nodeId: "b" },
		],
		{ "metrics.total": "sum" },
	);
	assert.deepEqual(state, { metrics: { total: 5 } });
});

test("parent and child writes in one superstep are rejected", () => {
	assert.throws(
		() =>
			applyStateWrites({}, [
				{ path: "result", value: { ok: true }, nodeId: "a" },
				{ path: "result.score", value: 1, nodeId: "b" },
			]),
		/Overlapping state writes/,
	);
});
