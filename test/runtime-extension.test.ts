import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Text } from "@earendil-works/pi-tui";
import piGraphExtension from "../src/extension.ts";

interface ToolPartial {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

interface CapturedTool {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: ToolPartial) => void) | undefined,
		ctx: unknown,
	) => Promise<unknown>;
	renderResult: (result: ToolPartial, options: { expanded: boolean }, theme: Theme) => Text;
}

test("run tool publishes and clears a live graph widget and renders non-empty partials", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-graph-runtime-widget-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = join(directory, "agent");
		const project = join(directory, "project");
		const graphDir = join(project, ".pi", "graphs");
		await mkdir(graphDir, { recursive: true });
		await writeFile(
			join(graphDir, "visible-run.json"),
			JSON.stringify({
				schemaVersion: 2,
				name: "visible-run",
				entry: "marker",
				nodes: { marker: { type: "set", assign: [{ path: "result.done", value: true }] } },
				policy: { confirmProjectGraph: false },
			}),
			"utf8",
		);

		const tools = captureTools();
		const runTool = tools.get("pi_graph_run");
		assert.ok(runTool);
		const widgets: Array<{ key: string; content: string[] | undefined }> = [];
		const partials: ToolPartial[] = [];
		const context = {
			cwd: project,
			hasUI: true,
			isProjectTrusted: () => true,
			ui: {
				setStatus() {},
				setWidget(key: string, content: string[] | undefined) {
					widgets.push({ key, content });
				},
				confirm: async () => true,
			},
		};

		await runTool.execute(
			"run",
			{ graph: "visible-run", scope: "project", checkpoint: false },
			undefined,
			(partial) => partials.push(partial),
			context,
		);

		assert.ok(widgets.some((widget) => widget.key === "pi-graph-runtime" && widget.content?.some((line) => line.includes("● marker"))));
		assert.deepEqual(widgets.at(-1), { key: "pi-graph-runtime", content: undefined });
		const activePartial = partials.find((partial) => partial.content[0]?.text.includes("● marker"));
		assert.ok(activePartial);
		assert.ok(activePartial.details.runtime);
		const rendered = runTool.renderResult(activePartial, { expanded: false }, identityTheme()).render(120).join("\n");
		assert.match(rendered, /visible-run · RUNNING/);
		assert.match(rendered, /● marker · running/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(directory, { recursive: true, force: true });
	}
});

function captureTools(): Map<string, CapturedTool> {
	const tools = new Map<string, CapturedTool>();
	const pi = {
		registerTool(value: unknown) {
			const captured = value as CapturedTool;
			tools.set(captured.name, captured);
		},
		registerCommand() {},
		on() {},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	piGraphExtension(pi);
	return tools;
}

function identityTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
}
