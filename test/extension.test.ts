import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type AutocompleteItem } from "@earendil-works/pi-tui";
import piGraphExtension from "../src/extension.ts";

interface CapturedTool {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<unknown>;
}

interface CapturedCommand {
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
}

function captureTools(): Map<string, CapturedTool> {
	const tools = new Map<string, CapturedTool>();
	const pi = {
		registerTool(tool: unknown) {
			const captured = tool as CapturedTool;
			tools.set(captured.name, captured);
		},
		registerCommand() {},
		on() {},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	piGraphExtension(pi);
	return tools;
}

function tool(tools: Map<string, CapturedTool>, name: string): CapturedTool {
	const captured = tools.get(name);
	assert.ok(captured, `Expected ${name} to be registered`);
	return captured;
}

test("Pi graph tools throw caught errors so Pi marks tool results as failed", async () => {
	const tools = captureTools();
	const context = {
		cwd: process.cwd(),
		hasUI: false,
		isProjectTrusted: () => true,
		ui: { setStatus() {} },
	};

	await assert.rejects(
		tool(tools, "pi_graph_run").execute("run", { graph: "missing", checkpoint: false }, undefined, undefined, context),
		/pi-graph failed: Unknown graph/,
	);
	await assert.rejects(
		tool(tools, "pi_graph_resume").execute(
			"resume",
			{ runId: "missing", value: "yes", valueJson: "true" },
			undefined,
			undefined,
			context,
		),
		/pi-graph resume failed: Provide only one of value or valueJson/,
	);
	await assert.rejects(
		tool(tools, "pi_graph_inspect").execute("inspect", { runId: "missing" }, undefined, undefined, context),
		/pi-graph inspect failed:/,
	);
});

test("command graph completions use trusted cwd-aware discovery", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-extension-completions-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		const agentDir = join(directory, "agent");
		const project = join(directory, "project");
		const nested = join(project, "packages", "app");
		await mkdir(join(agentDir, "graphs"), { recursive: true });
		await mkdir(join(project, ".pi", "graphs"), { recursive: true });
		await mkdir(nested, { recursive: true });
		await writeCompletionGraph(join(agentDir, "graphs", "user-file.json"), "user-graph");
		await writeCompletionGraph(join(project, ".pi", "graphs", "project-file.json"), "project-graph");
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const captured = captureCommand();
		captured.start({ cwd: nested, isProjectTrusted: () => true });
		const trusted = await captured.command.getArgumentCompletions?.("run ");
		assert.deepEqual(trusted?.map((item) => item.value), ["project-graph", "user-graph"]);

		captured.start({ cwd: nested, isProjectTrusted: () => false });
		const untrusted = await captured.command.getArgumentCompletions?.("run ");
		assert.deepEqual(untrusted?.map((item) => item.value), ["user-graph"]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("run authorization and status text use the compiled graph identity", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-extension-source-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
		const project = join(directory, "project");
		const graphPath = join(project, ".pi", "graphs", "different-file-name.json");
		await mkdir(join(project, ".pi", "graphs"), { recursive: true });
		await writeCompletionGraph(graphPath, "compiled-name");

		const confirmations: Array<{ title: string; message: string }> = [];
		const statuses: Array<string | undefined> = [];
		const context = {
			cwd: project,
			hasUI: true,
			isProjectTrusted: () => true,
			ui: {
				setStatus(_key: string, value: string | undefined) {
					statuses.push(value);
				},
				setWidget() {},
				async confirm(title: string, message: string) {
					confirmations.push({ title, message });
					return true;
				},
			},
		};

		const output = (await tool(captureTools(), "pi_graph_run").execute(
			"run",
			{ graph: "compiled-name", scope: "project", checkpoint: false },
			undefined,
			undefined,
			context,
		)) as { details: { graph: string } };
		assert.equal(output.details.graph, "compiled-name");
		assert.deepEqual(confirmations.map(({ title }) => title), ["Run project-local Pi graph?"]);
		assert.match(confirmations[0].message, /Graph: compiled-name/);
		assert.match(confirmations[0].message, new RegExp(escapeRegExp(graphPath)));
		assert.ok(statuses.some((status) => status === "compiled-name: starting"));
		assert.ok(statuses.some((status) => status?.startsWith("compiled-name: step ")));
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("pi_graph_run throws when the engine returns a cancelled terminal result", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-extension-cancelled-"));
	try {
		const graphDir = join(directory, ".pi", "graphs");
		await mkdir(graphDir, { recursive: true });
		await writeFile(
			join(graphDir, "cancelled.json"),
			JSON.stringify({
				schemaVersion: 2,
				name: "cancelled",
				entry: "marker",
				nodes: { marker: { type: "set", assign: [{ path: "reached", value: true }] } },
				policy: { allowNonInteractive: true },
			}),
			"utf8",
		);
		const tools = captureTools();
		const controller = new AbortController();
		controller.abort();
		const context = {
			cwd: directory,
			hasUI: false,
			isProjectTrusted: () => true,
			ui: { setStatus() {} },
		};

		await assert.rejects(
			tool(tools, "pi_graph_run").execute(
				"run",
				{ graph: "cancelled", scope: "project", checkpoint: false },
				controller.signal,
				undefined,
				context,
			),
			/pi-graph failed: pi-graph run .*status: cancelled/s,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("run and inspect tool details do not duplicate full graph state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-extension-light-details-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
		const graphDir = join(directory, "project", ".pi", "graphs");
		await mkdir(graphDir, { recursive: true });
		const wideKey = "研究".repeat(30);
		await writeFile(
			join(graphDir, "compact-result.json"),
			JSON.stringify({
				schemaVersion: 2,
				name: "compact-result",
				entry: "finish",
				nodes: {
					finish: {
						type: "set",
						assign: [
							{ path: "working.large", value: "x".repeat(20_000) },
							{ path: `working.${wideKey}`, value: "wide" },
							{ path: "result.summary", value: "ok" },
						],
					},
				},
				result: { paths: ["result.summary"], includeState: false },
				policy: { allowNonInteractive: true, confirmProjectGraph: false },
				limits: {
					maxSteps: 2,
					maxNodeRuns: 2,
					maxConcurrency: 1,
					maxCostUsd: 1,
					maxTokens: 1000,
					timeoutMs: 10_000,
					maxStateBytes: 100_000,
				},
			}),
			"utf8",
		);
		const tools = captureTools();
		const context = {
			cwd: join(directory, "project"),
			hasUI: false,
			isProjectTrusted: () => true,
			ui: { setStatus() {} },
		};

		const runOutput = (await tool(tools, "pi_graph_run").execute(
			"run",
			{ graph: "compact-result", scope: "project", checkpoint: true },
			undefined,
			undefined,
			context,
		)) as { content: Array<{ text: string }>; details: { result: Record<string, unknown> } };
		assert.equal("state" in runOutput.details.result, false);
		assert.match(runOutput.content[0].text, /result\.summary|"summary": "ok"/);
		assert.doesNotMatch(runOutput.content[0].text, /x{100}/);
		const runId = String(runOutput.details.result.runId);

		const inspectOutput = (await tool(tools, "pi_graph_inspect").execute(
			"inspect",
			{ runId, view: "summary" },
			undefined,
			undefined,
			context,
		)) as { content: Array<{ text: string }>; details: Record<string, unknown> };
		assert.equal("record" in inspectOutput.details, false);
		assert.equal("snapshot" in inspectOutput.details, false);
		assert.equal("checkpoint" in inspectOutput.details, true);
		assert.match(inspectOutput.content[0].text, /state inventory:/);
		assert.match(inspectOutput.content[0].text, /19\.5KB/);
		assert.doesNotMatch(inspectOutput.content[0].text, /x{100}/);
		const wideInventoryLine = inspectOutput.content[0].text.split("\n").find((line) => line.includes("研究"));
		assert.ok(wideInventoryLine);
		assert.ok(visibleWidth(wideInventoryLine) <= 70);
		assert.match(wideInventoryLine, /…/);

		const pathOutput = (await tool(tools, "pi_graph_inspect").execute(
			"inspect-path",
			{ runId, view: "path", path: "result.summary" },
			undefined,
			undefined,
			context,
		)) as { content: Array<{ text: string }> };
		assert.match(pathOutput.content[0].text, /result\.summary:\n"ok"/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

function captureCommand(): { command: CapturedCommand; start: (ctx: { cwd: string; isProjectTrusted(): boolean }) => void } {
	let command: CapturedCommand | undefined;
	let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
	const pi = {
		registerTool() {},
		registerCommand(_name: string, value: CapturedCommand) {
			command = value;
		},
		on(event: string, handler: (event: unknown, ctx: unknown) => void) {
			if (event === "session_start") sessionStart = handler;
		},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	piGraphExtension(pi);
	assert.ok(command);
	assert.ok(sessionStart);
	return {
		command,
		start(ctx) {
			sessionStart?.({}, ctx);
		},
	};
}

async function writeCompletionGraph(path: string, name: string): Promise<void> {
	await writeFile(
		path,
		JSON.stringify({
			schemaVersion: 2,
			name,
			entry: "done",
			nodes: { done: { type: "set", assign: [{ path: "result.done", value: true }] } },
		}),
		"utf8",
	);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
