import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverGraphs } from "../src/discovery.ts";

test("discovery retains compiled graphs and applies cwd, trust, and scope", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-discovery-"));
	try {
		const agentDir = join(directory, "agent");
		const project = join(directory, "project");
		const nested = join(project, "packages", "app");
		await mkdir(join(agentDir, "graphs"), { recursive: true });
		await mkdir(join(project, ".pi", "graphs"), { recursive: true });
		await mkdir(nested, { recursive: true });
		await writeGraph(join(agentDir, "graphs", "user.json"), "user-graph");
		await writeGraph(join(agentDir, "graphs", "shared.json"), "shared-graph", "user copy");
		await writeGraph(join(project, ".pi", "graphs", "project.json"), "project-graph");
		await writeGraph(join(project, ".pi", "graphs", "shared.json"), "shared-graph", "project copy");

		const trusted = discoverGraphs({
			cwd: nested,
			agentDir,
			configDirName: ".pi",
			scope: "both",
			projectTrusted: true,
		});
		assert.deepEqual(trusted.graphs.map((graph) => graph.compiled.definition.name), ["project-graph", "shared-graph", "user-graph"]);
		for (const graph of trusted.graphs) {
			assert.deepEqual(Object.keys(graph).sort(), ["compiled", "filePath", "scope"]);
			assert.equal(typeof graph.compiled.hash, "string");
			assert.ok(Array.isArray(graph.compiled.diagnostics));
		}
		const shared = trusted.graphs.find((graph) => graph.compiled.definition.name === "shared-graph");
		assert.equal(shared?.scope, "project");
		assert.equal(shared?.compiled.definition.description, "project copy");

		const untrusted = discoverGraphs({
			cwd: nested,
			agentDir,
			configDirName: ".pi",
			scope: "both",
			projectTrusted: false,
		});
		assert.deepEqual(untrusted.graphs.map((graph) => graph.compiled.definition.name), ["shared-graph", "user-graph"]);
		assert.ok(untrusted.diagnostics.some((diagnostic) => diagnostic.code === "PROJECT_GRAPH_UNTRUSTED"));

		const projectOnly = discoverGraphs({
			cwd: nested,
			agentDir,
			configDirName: ".pi",
			scope: "project",
			projectTrusted: true,
		});
		assert.deepEqual(projectOnly.graphs.map((graph) => graph.compiled.definition.name), ["project-graph", "shared-graph"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

async function writeGraph(path: string, name: string, description?: string): Promise<void> {
	await writeFile(
		path,
		JSON.stringify({
			schemaVersion: 2,
			name,
			description,
			entry: "done",
			nodes: { done: { type: "set", assign: [{ path: "result.done", value: true }] } },
		}),
		"utf8",
	);
}
