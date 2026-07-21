import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { FileCheckpointStore } from "./checkpoint.ts";
import { compileGraph, graphUsesMutatingTools } from "./compile.ts";
import { discoverGraphs, findGraph } from "./discovery.ts";
import { GraphEngine } from "./engine.ts";
import { PiNodeExecutor } from "./pi-executor.ts";
import type {
	CheckpointSnapshot,
	GraphRunEvent,
	GraphRunResult,
	GraphScope,
	GraphSource,
	JsonObject,
	JsonValue,
} from "./types.ts";
import { deepMergeObjects, errorMessage, parseJsonObject, parseJsonOrText, parseJsonValue } from "./utils.ts";

// StringEnum (not Type.Union/Type.Literal) so the scope parameter serializes as a
// JSON Schema `enum`, which is required for Google API compatibility.
const GraphScopeSchema = StringEnum(["user", "project", "both"] as const);

const RunGraphParameters = Type.Object({
	graph: Type.String({ description: "Installed graph name" }),
	task: Type.Optional(Type.String({ description: "Task text, exposed as state.input.task" })),
	inputJson: Type.Optional(Type.String({ description: "Additional JSON object merged into state.input" })),
	scope: Type.Optional(GraphScopeSchema),
	checkpoint: Type.Optional(Type.Boolean({ description: "Persist checkpoints for resume; default true" })),
});

const ResumeGraphParameters = Type.Object({
	runId: Type.String({ description: "Run id returned by pi_graph_run" }),
	value: Type.Optional(Type.String({ description: "Plain-text human response" })),
	valueJson: Type.Optional(Type.String({ description: "JSON human response, such as true or an object" })),
	forceGraphVersion: Type.Optional(
		Type.Boolean({ description: "Resume after graph definition changed. Review idempotency and state compatibility first." }),
	),
	scope: Type.Optional(GraphScopeSchema),
});

const InspectGraphParameters = Type.Object({
	runId: Type.Optional(Type.String({ description: "Run id. Omit to list recent runs." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum recent runs to list" })),
});

interface GraphToolDetails {
	graph?: string;
	source?: string;
	event?: GraphRunEvent;
	result?: GraphRunResult;
	snapshot?: CheckpointSnapshot;
	runs?: Awaited<ReturnType<FileCheckpointStore["list"]>>;
}

interface RunRequest {
	graphName: string;
	input: JsonObject;
	scope: GraphScope;
	checkpoint: boolean;
	ctx: ExtensionContext;
	signal?: AbortSignal;
	onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: GraphToolDetails }) => void;
}

interface ResumeRequest {
	runId: string;
	resumeValue?: JsonValue;
	forceGraphVersion: boolean;
	scope: GraphScope;
	ctx: ExtensionContext;
	signal?: AbortSignal;
	onUpdate?: (partial: { content: Array<{ type: "text"; text: string }>; details: GraphToolDetails }) => void;
}

export default function piGraphExtension(pi: ExtensionAPI): void {
	const checkpointStore = new FileCheckpointStore(join(getAgentDir(), "pi-graph", "runs"));
	const confirmedProjectGraphs = new Set<string>();
	const confirmedMutatingGraphs = new Set<string>();

	pi.registerTool({
		name: "pi_graph_run",
		label: "Pi Graph Run",
		description:
			"Run a named, bounded Pi agent graph with isolated, persistent-thread, or shared-message context; explicit state; routing; fan-out/fan-in; checkpoints; and human interrupts.",
		promptSnippet: "Run a preconfigured bounded multi-node Pi agent graph",
		promptGuidelines: [
			"Use pi_graph_run only when the work genuinely needs specialized handoffs, parallel fan-out/fan-in, distinct tools/models, failure isolation, or an independent reviewer.",
			"Prefer the normal Pi agent loop for a single well-scoped task; do not create graph complexity merely to sequence trivial steps.",
		],
		parameters: RunGraphParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			try {
				const input = buildInput(params.task, params.inputJson);
				const result = await runGraph(
					{
						graphName: params.graph,
						input,
						scope: params.scope ?? "both",
						checkpoint: params.checkpoint ?? true,
						ctx,
						signal,
						onUpdate,
					},
					checkpointStore,
					confirmedProjectGraphs,
					confirmedMutatingGraphs,
				);
				pi.appendEntry("pi-graph-run", runSummary(result, params.graph));
				return {
					content: [{ type: "text", text: formatRunResult(result) }],
					details: { graph: params.graph, result } satisfies GraphToolDetails,
					isError: result.status === "failed" || result.status === "cancelled",
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `pi-graph failed: ${errorMessage(error)}` }],
					details: { graph: params.graph } satisfies GraphToolDetails,
					isError: true,
				};
			}
		},
		renderCall(args, theme) {
			return renderGraphCall("pi_graph_run", args.graph ?? "", theme);
		},
		renderResult(result, { expanded }, theme) {
			return renderGraphResult(result.details as GraphToolDetails | undefined, expanded, theme);
		},
	});

	pi.registerTool({
		name: "pi_graph_resume",
		label: "Pi Graph Resume",
		description: "Resume a durable pi-graph run after interruption, failure, cancellation, or process restart.",
		promptSnippet: "Resume a checkpointed Pi graph run",
		promptGuidelines: [
			"Use pi_graph_resume with the exact runId returned by pi_graph_run.",
			"Supply valueJson for booleans or structured approval data; use value for plain text.",
		],
		parameters: ResumeGraphParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			try {
				if (params.value !== undefined && params.valueJson !== undefined) {
					throw new Error("Provide only one of value or valueJson");
				}
				const resumeValue =
					params.valueJson !== undefined
						? parseJsonValue(params.valueJson, "valueJson")
						: params.value !== undefined
							? params.value
							: undefined;
				const result = await resumeGraph(
					{
						runId: params.runId,
						resumeValue,
						forceGraphVersion: params.forceGraphVersion ?? false,
						scope: params.scope ?? "both",
						ctx,
						signal,
						onUpdate,
					},
					checkpointStore,
					confirmedProjectGraphs,
					confirmedMutatingGraphs,
				);
				const resumedSnapshot = await checkpointStore.load(result.runId);
				pi.appendEntry("pi-graph-run", runSummary(result, resumedSnapshot.graphName));
				return {
					content: [{ type: "text", text: formatRunResult(result) }],
					details: { result } satisfies GraphToolDetails,
					isError: result.status === "failed" || result.status === "cancelled",
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `pi-graph resume failed: ${errorMessage(error)}` }],
					details: {} satisfies GraphToolDetails,
					isError: true,
				};
			}
		},
		renderCall(args, theme) {
			return renderGraphCall("pi_graph_resume", args.runId ?? "", theme);
		},
		renderResult(result, { expanded }, theme) {
			return renderGraphResult(result.details as GraphToolDetails | undefined, expanded, theme);
		},
	});

	pi.registerTool<typeof InspectGraphParameters, GraphToolDetails>({
		name: "pi_graph_inspect",
		label: "Pi Graph Inspect",
		description: "Inspect a durable pi-graph checkpoint or list recent runs without executing nodes.",
		promptSnippet: "Inspect Pi graph runs and checkpoints",
		parameters: InspectGraphParameters,
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			try {
				if (params.runId) {
					const snapshot = await checkpointStore.load(params.runId);
					return {
						content: [{ type: "text", text: truncateText(JSON.stringify(snapshot, null, 2), 80_000) }],
						details: { snapshot } satisfies GraphToolDetails,
					};
				}
				const runs = await checkpointStore.list(params.limit ?? 20);
				return {
					content: [{ type: "text", text: formatRunList(runs) }],
					details: { runs } satisfies GraphToolDetails,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `pi-graph inspect failed: ${errorMessage(error)}` }],
					details: {} satisfies GraphToolDetails,
					isError: true,
				};
			}
		},
		renderCall(args, theme) {
			return renderGraphCall("pi_graph_inspect", args.runId ?? "(recent)", theme);
		},
		renderResult(result, { expanded }, theme) {
			return renderGraphResult(result.details as GraphToolDetails | undefined, expanded, theme);
		},
	});

	pi.registerCommand("pi-graph", {
		description: "List, validate, run, resume, or inspect Pi agent graphs",
		getArgumentCompletions: (argumentPrefix) => resolvePiGraphCompletions(argumentPrefix, getAgentDir(), checkpointStore),
		handler: async (args, ctx) => {
			try {
				await handleCommand(
					args,
					ctx,
					pi,
					checkpointStore,
					confirmedProjectGraphs,
					confirmedMutatingGraphs,
				);
			} catch (error) {
				ctx.ui.notify(`pi-graph: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus("pi-graph", undefined);
	});
}

async function runGraph(
	request: RunRequest,
	checkpointStore: FileCheckpointStore,
	confirmedProjectGraphs: Set<string>,
	confirmedMutatingGraphs: Set<string>,
): Promise<GraphRunResult> {
	const graph = resolveGraph(request.ctx, request.graphName, request.scope);
	await authorizeGraph(request.ctx, graph, request.checkpoint, confirmedProjectGraphs, confirmedMutatingGraphs);
	const compiled = compileGraph(graph.definition);
	const executor = new PiNodeExecutor({
		cwd: request.ctx.cwd,
		hasUI: request.ctx.hasUI,
		ui: request.ctx.ui,
		threadSessionsDir: join(getAgentDir(), "pi-graph", "threads"),
	});
	const engine = new GraphEngine(compiled, executor, { checkpointStore, graphSource: graph.filePath });
	request.ctx.ui.setStatus("pi-graph", `${graph.name}: starting`);
	try {
		const result = await engine.run({
			input: request.input,
			checkpoint: request.checkpoint,
			signal: request.signal,
			onEvent: buildEventHandler(request.ctx, graph, request.onUpdate),
		});
		return result;
	} finally {
		request.ctx.ui.setStatus("pi-graph", undefined);
	}
}

async function resumeGraph(
	request: ResumeRequest,
	checkpointStore: FileCheckpointStore,
	confirmedProjectGraphs: Set<string>,
	confirmedMutatingGraphs: Set<string>,
): Promise<GraphRunResult> {
	const snapshot = await checkpointStore.load(request.runId);
	const graph = resolveGraph(request.ctx, snapshot.graphName, request.scope);
	await authorizeGraph(request.ctx, graph, true, confirmedProjectGraphs, confirmedMutatingGraphs);
	const compiled = compileGraph(graph.definition);
	const executor = new PiNodeExecutor({
		cwd: request.ctx.cwd,
		hasUI: request.ctx.hasUI,
		ui: request.ctx.ui,
		threadSessionsDir: join(getAgentDir(), "pi-graph", "threads"),
	});
	const engine = new GraphEngine(compiled, executor, { checkpointStore, graphSource: graph.filePath });
	request.ctx.ui.setStatus("pi-graph", `${graph.name}: resuming`);
	try {
		const result = await engine.run({
			runId: request.runId,
			resumeValue: request.resumeValue,
			forceGraphVersion: request.forceGraphVersion,
			checkpoint: true,
			signal: request.signal,
			onEvent: buildEventHandler(request.ctx, graph, request.onUpdate),
		});
		return result;
	} finally {
		request.ctx.ui.setStatus("pi-graph", undefined);
	}
}

function resolveGraph(ctx: ExtensionContext, name: string, scope: GraphScope): GraphSource {
	const discovery = discoverGraphs({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		configDirName: CONFIG_DIR_NAME,
		scope,
		projectTrusted: ctx.isProjectTrusted(),
	});
	return findGraph(discovery, name);
}

async function authorizeGraph(
	ctx: ExtensionContext,
	graph: GraphSource,
	checkpoint: boolean,
	confirmedProjectGraphs: Set<string>,
	confirmedMutatingGraphs: Set<string>,
): Promise<void> {
	const policy = graph.definition.policy ?? {};
	const mutating = graphUsesMutatingTools(graph.definition);
	const confirmationKey = `${graph.filePath}:${graph.hash}`;
	if (!ctx.hasUI) {
		if (policy.allowNonInteractive !== true) {
			throw new Error(`Graph ${graph.name} does not allow non-interactive execution`);
		}
		if (mutating && policy.allowNonInteractiveMutations !== true) {
			throw new Error(`Graph ${graph.name} uses mutating tools and does not allow non-interactive mutations`);
		}
	}
	if (graph.scope === "project") {
		if (!ctx.isProjectTrusted()) throw new Error(`Project graph ${graph.name} requires a trusted project`);
		if (ctx.hasUI && policy.confirmProjectGraph !== false && !confirmedProjectGraphs.has(confirmationKey)) {
			const approved = await ctx.ui.confirm(
				"Run project-local Pi graph?",
				`Graph: ${graph.name}\nSource: ${graph.filePath}\n\nProject graphs are repository-controlled orchestration code. Continue only for a trusted repository.`,
			);
			if (!approved) throw new Error("Project graph was not approved");
			confirmedProjectGraphs.add(confirmationKey);
		}
	}
	if (mutating && ctx.hasUI && policy.confirmMutatingNodes !== false && !confirmedMutatingGraphs.has(confirmationKey)) {
		const approved = await ctx.ui.confirm(
			"Allow mutating graph nodes?",
			`Graph ${graph.name} can run bash, edit, write, or extension tools in Pi agent nodes. Review ${graph.filePath} before continuing.`,
		);
		if (!approved) throw new Error("Mutating graph execution was not approved");
		confirmedMutatingGraphs.add(confirmationKey);
	}
	const hasHumanNode = Object.values(graph.definition.nodes).some((node) => node.type === "human");
	if (hasHumanNode && !checkpoint) {
		throw new Error(`Graph ${graph.name} contains a human node and requires checkpoint: true for durable resume`);
	}
}

function buildEventHandler(
	ctx: ExtensionContext,
	graph: GraphSource,
	onUpdate: RunRequest["onUpdate"],
): (event: GraphRunEvent) => void {
	return (event) => {
		const status = event.nodeId
			? `${graph.name}: step ${event.step ?? "?"} · ${event.nodeId} · ${event.type.replaceAll("_", " ")}`
			: `${graph.name}: ${event.type.replaceAll("_", " ")}`;
		ctx.ui.setStatus("pi-graph", status);
		onUpdate?.({
			content: [{ type: "text", text: formatEvent(event) }],
			details: { graph: graph.name, source: graph.filePath, event },
		});
	};
}

function buildInput(task: string | undefined, inputJson: string | undefined): JsonObject {
	let input: JsonObject = {};
	if (inputJson !== undefined) input = parseJsonObject(inputJson, "inputJson");
	if (task !== undefined) input = deepMergeObjects(input, { task });
	return input;
}

async function handleCommand(
	args: string,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	checkpointStore: FileCheckpointStore,
	confirmedProjectGraphs: Set<string>,
	confirmedMutatingGraphs: Set<string>,
): Promise<void> {
	const trimmed = args.trim();
	const firstSpace = trimmed.search(/\s/);
	const action = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)) || "list";
	const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace).trim();

	if (action === "list" || action === "validate") {
		const discovery = discoverGraphs({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			configDirName: CONFIG_DIR_NAME,
			scope: "both",
			projectTrusted: ctx.isProjectTrusted(),
		});
		if (action === "list") {
			const text = discovery.graphs.length
				? discovery.graphs
						.map((graph) => `${graph.name} [${graph.scope}] · ${Object.keys(graph.definition.nodes).length} nodes · ${graph.description ?? ""}`)
						.join("\n")
				: "No graphs found.";
			ctx.ui.notify(text, "info");
			return;
		}
		const selected = rest ? discovery.graphs.filter((graph) => graph.name === rest) : discovery.graphs;
		if (rest && selected.length === 0) throw new Error(`Unknown graph ${rest}`);
		const lines = selected.flatMap((graph) => [
			`${graph.name}: ${graph.diagnostics.some((item) => item.level === "error") ? "invalid" : "valid"}`,
			...graph.diagnostics.map((item) => `  ${item.level.toUpperCase()} ${item.code}: ${item.message}`),
		]);
		for (const diagnostic of discovery.diagnostics) lines.push(`${diagnostic.level.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`);
		ctx.ui.notify(lines.join("\n") || "All discovered graphs are valid.", "info");
		return;
	}

	if (action === "inspect") {
		if (rest) {
			const snapshot = await checkpointStore.load(rest);
			ctx.ui.notify(truncateText(JSON.stringify(snapshot, null, 2), 12_000), "info");
		} else {
			ctx.ui.notify(formatRunList(await checkpointStore.list(20)), "info");
		}
		return;
	}

	if (action === "run") {
		const [graphName, payload] = splitFirst(rest);
		if (!graphName) throw new Error("Usage: /pi-graph run <graph> [task or JSON object]");
		const input = payload.trim().startsWith("{") ? parseJsonObject(payload, "command input") : payload ? { task: payload } : {};
		const result = await runGraph(
			{ graphName, input, scope: "both", checkpoint: true, ctx },
			checkpointStore,
			confirmedProjectGraphs,
			confirmedMutatingGraphs,
		);
		pi.appendEntry("pi-graph-run", runSummary(result, graphName));
		ctx.ui.notify(formatRunResult(result), result.status === "completed" ? "info" : result.status === "interrupted" ? "warning" : "error");
		return;
	}

	if (action === "resume") {
		const [runId, payload] = splitFirst(rest);
		if (!runId) throw new Error("Usage: /pi-graph resume <runId> [value or JSON]");
		const result = await resumeGraph(
			{
				runId,
				resumeValue: payload ? parseJsonOrText(payload) : undefined,
				forceGraphVersion: false,
				scope: "both",
				ctx,
			},
			checkpointStore,
			confirmedProjectGraphs,
			confirmedMutatingGraphs,
		);
		const resumedSnapshot = await checkpointStore.load(result.runId);
		pi.appendEntry("pi-graph-run", runSummary(result, resumedSnapshot.graphName));
		ctx.ui.notify(formatRunResult(result), result.status === "completed" ? "info" : result.status === "interrupted" ? "warning" : "error");
		return;
	}

	throw new Error("Usage: /pi-graph [list|validate [graph]|run <graph> [input]|resume <runId> [value]|inspect [runId]]");
}

function splitFirst(text: string): [string, string] {
	const trimmed = text.trim();
	const index = trimmed.search(/\s/);
	if (index === -1) return [trimmed, ""];
	return [trimmed.slice(0, index), trimmed.slice(index).trim()];
}

const PI_GRAPH_ACTIONS = ["list", "validate", "run", "resume", "inspect"] as const;
const PI_GRAPH_ACTION_DESCRIPTIONS: Record<string, string> = {
	list: "List discovered graphs",
	validate: "Validate a graph (or all)",
	run: "Run a graph with a task",
	resume: "Resume an interrupted run",
	inspect: "Inspect a run checkpoint or list recent runs",
};

function completeActions(prefix: string): AutocompleteItem[] {
	const lower = prefix.toLowerCase();
	return PI_GRAPH_ACTIONS.filter((action) => action.startsWith(lower)).map((action) => ({
		value: action,
		label: action,
		description: PI_GRAPH_ACTION_DESCRIPTIONS[action],
	}));
}

function completeUserGraphNames(agentDir: string, prefix: string): AutocompleteItem[] {
	const dir = join(agentDir, "graphs");
	if (!existsSync(dir)) return [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const items: AutocompleteItem[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".json")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = join(dir, entry.name);
		let name = entry.name.slice(0, -".json".length);
		let description = "graph";
		try {
			const def = JSON.parse(readFileSync(filePath, "utf8")) as { name?: unknown; nodes?: Record<string, unknown> };
			if (typeof def.name === "string") name = def.name;
			if (def.nodes && typeof def.nodes === "object") description = `${Object.keys(def.nodes).length} nodes`;
		} catch {
			// fall back to filename stem
		}
		if (!name.startsWith(prefix)) continue;
		items.push({ value: name, label: name, description });
	}
	return items.sort((left, right) => left.label.localeCompare(right.label));
}

async function resolvePiGraphCompletions(
	argumentPrefix: string,
	agentDir: string,
	store: FileCheckpointStore,
): Promise<AutocompleteItem[] | null> {
	const trimmed = argumentPrefix.trim();
	const spaceIndex = trimmed.search(/\s/);
	if (spaceIndex === -1) {
		const items = completeActions(trimmed);
		return items.length > 0 ? items : null;
	}
	const action = trimmed.slice(0, spaceIndex);
	const rest = trimmed.slice(spaceIndex + 1).trimStart();
	if (action === "run" || action === "validate") {
		const items = completeUserGraphNames(agentDir, rest);
		return items.length > 0 ? items : null;
	}
	if (action === "resume" || action === "inspect") {
		const runs = await store.list(20);
		const items = runs
			.filter((run) => run.runId.startsWith(rest))
			.map((run) => ({ value: run.runId, label: run.runId.slice(0, 8), description: `${run.graphName} · ${run.status}` }));
		return items.length > 0 ? items : null;
	}
	return null;
}

function renderGraphCall(toolName: string, keyArg: string, theme: Theme): Text {
	return new Text(theme.fg("toolTitle", theme.bold(`${toolName} `)) + theme.fg("muted", keyArg), 0, 0);
}

function renderGraphResult(details: GraphToolDetails | undefined, expanded: boolean, theme: Theme): Text {
	const result = details?.result;
	if (result) {
		const tone = result.status === "completed" ? "success" : result.status === "interrupted" ? "warning" : "error";
		let text =
			theme.fg(tone, result.status) +
			theme.fg("muted", ` · ${result.step} steps · ${result.nodeRuns} node runs · $${result.usage.costUsd.toFixed(4)}`);
		if (result.error) text += `\n${theme.fg("error", result.error)}`;
		if (expanded && result.state) text += `\n${theme.fg("dim", truncateText(JSON.stringify(result.state, null, 2), 4000))}`;
		return new Text(text, 0, 0);
	}
	const snapshot = details?.snapshot;
	if (snapshot) {
		const tone = snapshot.status === "completed" ? "success" : snapshot.status === "interrupted" ? "warning" : "error";
		let text =
			theme.fg("accent", snapshot.graphName) +
			" " +
			theme.fg(tone, snapshot.status) +
			theme.fg("muted", ` · step ${snapshot.step} · ${snapshot.nodeRuns} runs`);
		if (expanded && snapshot.state) text += `\n${theme.fg("dim", truncateText(JSON.stringify(snapshot.state, null, 2), 4000))}`;
		return new Text(text, 0, 0);
	}
	const runs = details?.runs;
	if (runs && runs.length > 0) {
		let text = theme.fg("muted", `${runs.length} run(s)`);
		const display = expanded ? runs : runs.slice(0, 5);
		for (const run of display) {
			text += `\n${theme.fg("accent", run.runId.slice(0, 8))} ${theme.fg("dim", `${run.graphName} · ${run.status} · step ${run.step}`)}`;
		}
		if (!expanded && runs.length > 5) text += `\n${theme.fg("dim", `… ${runs.length - 5} more`)}`;
		return new Text(text, 0, 0);
	}
	return new Text("", 0, 0);
}

function formatEvent(event: GraphRunEvent): string {
	const parts = [`[${event.runId}]`, event.type.replaceAll("_", " ")];
	if (event.step !== undefined) parts.push(`step ${event.step}`);
	if (event.nodeId) parts.push(event.nodeId);
	if (event.attempt !== undefined) parts.push(`attempt ${event.attempt}`);
	if (event.message) parts.push(event.message);
	return parts.join(" · ");
}

function formatRunResult(result: GraphRunResult): string {
	const header = [
		`pi-graph run ${result.runId}`,
		`status: ${result.status}`,
		`steps: ${result.step}`,
		`node runs: ${result.nodeRuns}`,
		`cost: $${result.usage.costUsd.toFixed(4)}`,
	].join("\n");
	if (result.status === "interrupted" && result.interrupt) {
		return `${header}\n\nInterrupted at ${result.interrupt.nodeId}: ${result.interrupt.prompt}\nResume with pi_graph_resume and runId ${result.runId}.`;
	}
	if (result.error) return `${header}\n\nerror: ${result.error}`;
	return `${header}\n\nstate:\n${truncateText(JSON.stringify(result.state, null, 2), 80_000)}`;
}

function formatRunList(runs: Awaited<ReturnType<FileCheckpointStore["list"]>>): string {
	if (runs.length === 0) return "No pi-graph checkpoints found.";
	return runs
		.map(
			(run) =>
				`${run.runId} · ${run.graphName} · ${run.status} · step ${run.step} · ${run.nodeRuns} node runs · $${run.costUsd.toFixed(4)} · ${run.updatedAt}`,
		)
		.join("\n");
}

function runSummary(result: GraphRunResult, graph: string): JsonObject {
	return {
		graph,
		runId: result.runId,
		status: result.status,
		step: result.step,
		nodeRuns: result.nodeRuns,
		costUsd: result.usage.costUsd,
		error: result.error ?? null,
	};
}

function truncateText(text: string, maxCharacters: number): string {
	return text.length <= maxCharacters ? text : `${text.slice(0, maxCharacters)}\n… ${text.length - maxCharacters} characters omitted`;
}
