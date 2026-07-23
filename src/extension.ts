import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	formatSize as formatBytes,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text, truncateToWidth, visibleWidth, type AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { FileCheckpointStore, type CheckpointRecord } from "./checkpoint.ts";
import { graphUsesMutatingTools } from "./compile.ts";
import { discoverGraphs, findGraph } from "./discovery.ts";
import { GraphEngine } from "./engine.ts";
import { PiNodeExecutor } from "./pi-executor.ts";
import {
	RuntimeGraphMonitor,
	renderRuntimeGraph,
	type RuntimeGraphView,
} from "./runtime-visualization.ts";
import type {
	Condition,
	CheckpointSnapshot,
	GraphDefinition,
	GraphRunEvent,
	GraphRunResult,
	GraphScope,
	GraphSource,
	JsonObject,
	JsonValue,
} from "./types.ts";
import {
	deepMergeObjects,
	errorMessage,
	getPath,
	isJsonObject,
	parseJsonObject,
	parseJsonOrText,
	parseJsonValue,
	stateSizeBytes,
} from "./utils.ts";

// StringEnum (not Type.Union/Type.Literal) so the scope parameter serializes as a
// JSON Schema `enum`, which is required for Google API compatibility.
const GraphScopeSchema = StringEnum(["user", "project", "both"] as const);
const InspectViewSchema = StringEnum(["summary", "inventory", "path", "full"] as const);
const RUNTIME_WIDGET_KEY = "pi-graph-runtime";

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
	view: Type.Optional(InspectViewSchema),
	path: Type.Optional(Type.String({ description: "State path when view=path" })),
	maxBytes: Type.Optional(Type.Integer({ minimum: 256, maximum: 200000, description: "Maximum UTF-8 bytes rendered" })),
});

interface GraphToolDetails {
	graph?: string;
	source?: string;
	event?: GraphRunEvent;
	/** Live, bounded runtime projection used by the TUI and streaming tool card. */
	runtime?: RuntimeGraphView;
	/** Lightweight view only; full graph state remains in the graph checkpoint. */
	result?: GraphRunView;
	/** Lightweight checkpoint metadata only; inspect content carries the requested projection. */
	checkpoint?: CheckpointView;
	runs?: Awaited<ReturnType<FileCheckpointStore["list"]>>;
}

type GraphRunView = Omit<GraphRunResult, "state"> & { stateInventory: string };

interface CheckpointView {
	runId: string;
	graphName: string;
	status: CheckpointSnapshot["status"];
	revision: number;
	step: number;
	nodeRuns: number;
	stateBytes: number;
	costUsd: number;
	pending: string[];
	inFlight: string[];
	threadCount: number;
	interruptNodeId?: string;
	error?: string;
	stateInventory: string;
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
	const activeRuntimeDisposers = new Set<() => void>();
	let completionContext: Pick<ExtensionContext, "cwd" | "isProjectTrusted"> | undefined;

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
				completionContext = ctx;
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
					activeRuntimeDisposers,
				);
				pi.appendEntry("pi-graph-run", runSummary(result, params.graph));
				throwForTerminalGraphFailure(result, "pi-graph failed");
				return {
					content: [{ type: "text", text: formatRunResult(result) }],
					details: { graph: params.graph, result: toGraphRunView(result) } satisfies GraphToolDetails,
				};
			} catch (error) {
				throw toolExecutionError("pi-graph failed", error);
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
				completionContext = ctx;
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
					activeRuntimeDisposers,
				);
				const resumedSnapshot = (await checkpointStore.load(result.runId)).snapshot;
				pi.appendEntry("pi-graph-run", runSummary(result, resumedSnapshot.graphName));
				throwForTerminalGraphFailure(result, "pi-graph resume failed");
				return {
					content: [{ type: "text", text: formatRunResult(result) }],
					details: { result: toGraphRunView(result) } satisfies GraphToolDetails,
				};
			} catch (error) {
				throw toolExecutionError("pi-graph resume failed", error);
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
					const record = await checkpointStore.load(params.runId);
					return {
						content: [
							{
								type: "text",
								text: formatCheckpointRecord(record, params.view ?? (params.path ? "path" : "summary"), params.path, params.maxBytes),
							},
						],
						details: { checkpoint: toCheckpointView(record) } satisfies GraphToolDetails,
					};
				}
				const runs = await checkpointStore.list(params.limit ?? 20);
				return {
					content: [{ type: "text", text: formatRunList(runs) }],
					details: { runs } satisfies GraphToolDetails,
				};
			} catch (error) {
				throw toolExecutionError("pi-graph inspect failed", error);
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
		getArgumentCompletions: (argumentPrefix) =>
			resolvePiGraphCompletions(
				argumentPrefix,
				completionContext ?? { cwd: process.cwd(), isProjectTrusted: () => false },
				getAgentDir(),
				checkpointStore,
			),
		handler: async (args, ctx) => {
			try {
				completionContext = ctx;
				await handleCommand(
					args,
					ctx,
					pi,
					checkpointStore,
					confirmedProjectGraphs,
					confirmedMutatingGraphs,
					activeRuntimeDisposers,
				);
			} catch (error) {
				ctx.ui.notify(`pi-graph: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		completionContext = ctx;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		for (const dispose of [...activeRuntimeDisposers]) dispose();
		ctx.ui.setStatus("pi-graph", undefined);
		ctx.ui.setWidget(RUNTIME_WIDGET_KEY, undefined);
	});
}

function throwForTerminalGraphFailure(result: GraphRunResult, prefix: string): void {
	if (result.status === "failed" || result.status === "cancelled") {
		throw new Error(`${prefix}: ${formatRunResult(result)}`);
	}
}

function toolExecutionError(prefix: string, error: unknown): Error {
	const message = errorMessage(error);
	if (message.startsWith(`${prefix}:`)) return error instanceof Error ? error : new Error(message);
	return new Error(`${prefix}: ${message}`, { cause: error });
}

async function runGraph(
	request: RunRequest,
	checkpointStore: FileCheckpointStore,
	confirmedProjectGraphs: Set<string>,
	confirmedMutatingGraphs: Set<string>,
	activeRuntimeDisposers: Set<() => void>,
): Promise<GraphRunResult> {
	const graph = resolveGraph(request.ctx, request.graphName, request.scope);
	await authorizeGraph(request.ctx, graph, request.checkpoint, confirmedProjectGraphs, confirmedMutatingGraphs);
	const { compiled } = graph;
	const graphName = compiled.definition.name;
	const executor = new PiNodeExecutor({
		cwd: request.ctx.cwd,
		hasUI: request.ctx.hasUI,
		ui: request.ctx.ui,
		threadSessionsDir: join(getAgentDir(), "pi-graph", "threads"),
		artifactsDir: join(getAgentDir(), "pi-graph", "artifacts"),
	});
	const engine = new GraphEngine(compiled, executor, { checkpointStore, graphSource: graph.filePath });
	const progress = createRuntimeProgress(request.ctx, graph, request.onUpdate, activeRuntimeDisposers);
	try {
		request.ctx.ui.setStatus("pi-graph", `${graphName}: starting`);
		const result = await engine.run({
			input: request.input,
			checkpoint: request.checkpoint,
			signal: request.signal,
			onEvent: progress.onEvent,
		});
		return result;
	} finally {
		progress.clear();
		request.ctx.ui.setStatus("pi-graph", undefined);
	}
}

async function resumeGraph(
	request: ResumeRequest,
	checkpointStore: FileCheckpointStore,
	confirmedProjectGraphs: Set<string>,
	confirmedMutatingGraphs: Set<string>,
	activeRuntimeDisposers: Set<() => void>,
): Promise<GraphRunResult> {
	const snapshot = (await checkpointStore.load(request.runId)).snapshot;
	const graph = resolveGraph(request.ctx, snapshot.graphName, request.scope);
	await authorizeGraph(request.ctx, graph, true, confirmedProjectGraphs, confirmedMutatingGraphs);
	const { compiled } = graph;
	const graphName = compiled.definition.name;
	const executor = new PiNodeExecutor({
		cwd: request.ctx.cwd,
		hasUI: request.ctx.hasUI,
		ui: request.ctx.ui,
		threadSessionsDir: join(getAgentDir(), "pi-graph", "threads"),
		artifactsDir: join(getAgentDir(), "pi-graph", "artifacts"),
	});
	const engine = new GraphEngine(compiled, executor, { checkpointStore, graphSource: graph.filePath });
	const progress = createRuntimeProgress(request.ctx, graph, request.onUpdate, activeRuntimeDisposers, snapshot);
	try {
		request.ctx.ui.setStatus("pi-graph", `${graphName}: resuming`);
		const result = await engine.run({
			runId: request.runId,
			resumeValue: request.resumeValue,
			forceGraphVersion: request.forceGraphVersion,
			checkpoint: true,
			signal: request.signal,
			onEvent: progress.onEvent,
		});
		return result;
	} finally {
		progress.clear();
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
	const { definition, hash } = graph.compiled;
	const graphName = definition.name;
	const policy = definition.policy ?? {};
	const mutating = graphUsesMutatingTools(definition);
	const confirmationKey = `${graph.filePath}:${hash}`;
	if (!ctx.hasUI) {
		if (policy.allowNonInteractive !== true) {
			throw new Error(`Graph ${graphName} does not allow non-interactive execution`);
		}
		if (mutating && policy.allowNonInteractiveMutations !== true) {
			throw new Error(`Graph ${graphName} uses mutating tools and does not allow non-interactive mutations`);
		}
	}
	if (graph.scope === "project") {
		if (!ctx.isProjectTrusted()) throw new Error(`Project graph ${graphName} requires a trusted project`);
		if (ctx.hasUI && policy.confirmProjectGraph !== false && !confirmedProjectGraphs.has(confirmationKey)) {
			const approved = await ctx.ui.confirm(
				"Run project-local Pi graph?",
				`Graph: ${graphName}\nSource: ${graph.filePath}\n\nProject graphs are repository-controlled orchestration code. Continue only for a trusted repository.`,
			);
			if (!approved) throw new Error("Project graph was not approved");
			confirmedProjectGraphs.add(confirmationKey);
		}
	}
	if (mutating && ctx.hasUI && policy.confirmMutatingNodes !== false && !confirmedMutatingGraphs.has(confirmationKey)) {
		const approved = await ctx.ui.confirm(
			"Allow mutating graph nodes?",
			`Graph ${graphName} can run bash, edit, write, or extension tools in Pi agent nodes. Review ${graph.filePath} before continuing.`,
		);
		if (!approved) throw new Error("Mutating graph execution was not approved");
		confirmedMutatingGraphs.add(confirmationKey);
	}
	const hasHumanNode = Object.values(definition.nodes).some((node) => node.type === "human");
	if (hasHumanNode && !checkpoint) {
		throw new Error(`Graph ${graphName} contains a human node and requires checkpoint: true for durable resume`);
	}
}

function createRuntimeProgress(
	ctx: ExtensionContext,
	graph: GraphSource,
	onUpdate: RunRequest["onUpdate"],
	activeRuntimeDisposers: Set<() => void>,
	checkpoint?: CheckpointSnapshot,
): { onEvent: (event: GraphRunEvent) => void; clear: () => void } {
	const graphName = graph.compiled.definition.name;
	const monitor = new RuntimeGraphMonitor(graph.compiled.definition, { checkpoint });
	let cleared = false;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	const showWidget = () => {
		if (!cleared && ctx.hasUI) {
			ctx.ui.setWidget(RUNTIME_WIDGET_KEY, renderRuntimeGraph(monitor.view()), { placement: "belowEditor" });
		}
	};
	const clear = () => {
		if (cleared) return;
		cleared = true;
		if (refreshTimer) clearInterval(refreshTimer);
		if (ctx.hasUI) ctx.ui.setWidget(RUNTIME_WIDGET_KEY, undefined);
		activeRuntimeDisposers.delete(clear);
	};
	activeRuntimeDisposers.add(clear);
	try {
		showWidget();
		refreshTimer = ctx.hasUI ? setInterval(showWidget, 1_000) : undefined;
		refreshTimer?.unref();
	} catch (error) {
		clear();
		throw error;
	}
	return {
		onEvent: (event) => {
			if (cleared) return;
			monitor.apply(event);
			const runtime = monitor.view();
			const lines = renderRuntimeGraph(runtime);
			if (ctx.hasUI) ctx.ui.setWidget(RUNTIME_WIDGET_KEY, lines, { placement: "belowEditor" });
			const status = event.nodeId
				? `${graphName}: step ${event.step ?? "?"} · ${event.nodeId} · ${event.type.replaceAll("_", " ")}`
				: `${graphName}: ${event.type.replaceAll("_", " ")}`;
			ctx.ui.setStatus("pi-graph", status);
			onUpdate?.({
				content: [{ type: "text", text: lines.join("\n") }],
				details: { graph: graphName, source: graph.filePath, event, runtime },
			});
		},
		clear,
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
	activeRuntimeDisposers: Set<() => void>,
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
						.map((graph) => {
							const definition = graph.compiled.definition;
							return `${definition.name} [${graph.scope}] · ${Object.keys(definition.nodes).length} nodes · ${definition.description ?? ""}`;
						})
						.join("\n")
				: "No graphs found.";
			ctx.ui.notify(text, "info");
			return;
		}
		const selected = rest ? discovery.graphs.filter((graph) => graph.compiled.definition.name === rest) : discovery.graphs;
		if (rest && selected.length === 0) throw new Error(`Unknown graph ${rest}`);
		const lines = selected.flatMap((graph) => {
			const { definition, diagnostics } = graph.compiled;
			return [
				`${definition.name}: ${diagnostics.some((item) => item.level === "error") ? "invalid" : "valid"}`,
				...diagnostics.map((item) => `  ${item.level.toUpperCase()} ${item.code}: ${item.message}`),
			];
		});
		for (const diagnostic of discovery.diagnostics) lines.push(`${diagnostic.level.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`);
		ctx.ui.notify(lines.join("\n") || "All discovered graphs are valid.", "info");
		return;
	}

	if (action === "visualize") {
		if (!rest) throw new Error("Usage: /pi-graph visualize <graph>");
		const discovery = discoverGraphs({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			configDirName: CONFIG_DIR_NAME,
			scope: "both",
			projectTrusted: ctx.isProjectTrusted(),
		});
		const graph = findGraph(discovery, rest);
		const { compiled } = graph;
		const mermaid = generateMermaid(compiled.definition);
		const errorCount = compiled.diagnostics.filter((item) => item.level === "error").length;
		const header = errorCount > 0
			? `${compiled.definition.name} — ⚠ ${errorCount} compile error(s); rendering structure anyway`
			: `${compiled.definition.name} — ${Object.keys(compiled.definition.nodes).length} nodes · ${compiled.definition.edges?.length ?? 0} edges · ${compiled.definition.routes?.length ?? 0} routes`;
		ctx.ui.notify(`${header}\n\n\`\`\`mermaid\n${mermaid}\n\`\`\``, "info");
		return;
	}

	if (action === "inspect") {
		if (rest) {
			const [runId, viewArg] = splitFirst(rest);
			const record = await checkpointStore.load(runId);
			const view = viewArg === "--full" ? "full" : viewArg === "--inventory" ? "inventory" : viewArg ? "path" : "summary";
			const path = view === "path" ? viewArg : undefined;
			ctx.ui.notify(formatCheckpointRecord(record, view, path, 12_000), "info");
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
			activeRuntimeDisposers,
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
			activeRuntimeDisposers,
		);
		const resumedSnapshot = (await checkpointStore.load(result.runId)).snapshot;
		pi.appendEntry("pi-graph-run", runSummary(result, resumedSnapshot.graphName));
		ctx.ui.notify(formatRunResult(result), result.status === "completed" ? "info" : result.status === "interrupted" ? "warning" : "error");
		return;
	}

	throw new Error("Usage: /pi-graph [list|validate [graph]|run <graph> [input]|resume <runId> [value]|inspect [runId]|visualize <graph>]");
}

function splitFirst(text: string): [string, string] {
	const trimmed = text.trim();
	const index = trimmed.search(/\s/);
	if (index === -1) return [trimmed, ""];
	return [trimmed.slice(0, index), trimmed.slice(index).trim()];
}

const PI_GRAPH_ACTIONS = ["list", "validate", "run", "resume", "inspect", "visualize"] as const;
const PI_GRAPH_ACTION_DESCRIPTIONS: Record<string, string> = {
	list: "List discovered graphs",
	validate: "Validate a graph (or all)",
	run: "Run a graph with a task",
	resume: "Resume an interrupted run",
	inspect: "Inspect a run checkpoint or list recent runs",
	visualize: "Render a graph as a Mermaid diagram",
};

function completeActions(prefix: string): AutocompleteItem[] {
	const lower = prefix.toLowerCase();
	return PI_GRAPH_ACTIONS.filter((action) => action.startsWith(lower)).map((action) => ({
		value: action,
		label: action,
		description: PI_GRAPH_ACTION_DESCRIPTIONS[action],
	}));
}

function completeGraphNames(
	context: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
	agentDir: string,
	prefix: string,
): AutocompleteItem[] {
	const discovery = discoverGraphs({
		cwd: context.cwd,
		agentDir,
		configDirName: CONFIG_DIR_NAME,
		scope: "both",
		projectTrusted: context.isProjectTrusted(),
	});
	return discovery.graphs
		.filter((graph) => graph.compiled.definition.name.startsWith(prefix))
		.map((graph) => ({
			value: graph.compiled.definition.name,
			label: graph.compiled.definition.name,
			description: `${Object.keys(graph.compiled.definition.nodes).length} nodes · ${graph.scope}`,
		}));
}

async function resolvePiGraphCompletions(
	argumentPrefix: string,
	context: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
	agentDir: string,
	store: FileCheckpointStore,
): Promise<AutocompleteItem[] | null> {
	const trimmed = argumentPrefix.trimStart();
	const spaceIndex = trimmed.search(/\s/);
	if (spaceIndex === -1) {
		const items = completeActions(trimmed);
		return items.length > 0 ? items : null;
	}
	const action = trimmed.slice(0, spaceIndex);
	const rest = trimmed.slice(spaceIndex + 1).trimStart();
	if (action === "run" || action === "validate" || action === "visualize") {
		const items = completeGraphNames(context, agentDir, rest);
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
	const runtime = details?.runtime;
	if (runtime) {
		const text = renderRuntimeGraph(runtime)
			.map((line, index) => {
				if (index === 0) return theme.fg("accent", theme.bold(line));
				if (line.includes("✗")) return theme.fg("error", line);
				if (line.includes("↻") || line.includes("!")) return theme.fg("warning", line);
				if (line.includes("●")) return theme.fg("accent", line);
				if (line.includes("✓")) return theme.fg("success", line);
				return theme.fg("dim", line);
			})
			.join("\n");
		return new Text(text, 0, 0);
	}
	const result = details?.result;
	if (result) {
		const tone = result.status === "completed" ? "success" : result.status === "interrupted" ? "warning" : "error";
		let text =
			theme.fg(tone, result.status) +
			theme.fg(
				"muted",
				` · ${result.step} steps · ${result.nodeRuns} node runs · $${result.usage.costUsd.toFixed(4)} · ${formatBytes(result.stateBytes)} state`,
			);
		if (result.error) text += `\n${theme.fg("error", result.error)}`;
		if (expanded && result.result) {
			text += `\n${theme.fg("dim", truncateUtf8Text(JSON.stringify(result.result, null, 2), Math.min(result.resultMaxBytes, 4000)))}`;
		} else if (expanded) {
			text += `\n${theme.fg("dim", result.stateInventory)}`;
		}
		return new Text(text, 0, 0);
	}
	const checkpoint = details?.checkpoint;
	if (checkpoint) {
		const tone = checkpoint.status === "completed" ? "success" : checkpoint.status === "interrupted" ? "warning" : "error";
		let text =
			theme.fg("accent", checkpoint.graphName) +
			" " +
			theme.fg(tone, checkpoint.status) +
			theme.fg(
				"muted",
				` · step ${checkpoint.step} · ${checkpoint.nodeRuns} runs · rev ${checkpoint.revision} · ${formatBytes(checkpoint.stateBytes)} state`,
			);
		if (expanded) text += `\n${theme.fg("dim", checkpoint.stateInventory)}`;
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
	if (details?.event) return new Text(theme.fg("muted", formatEvent(details.event)), 0, 0);
	return new Text("", 0, 0);
}

const MERMAID_OP: Record<string, string> = {
	eq: "==",
	ne: "!=",
	gt: ">",
	gte: "≥",
	lt: "<",
	lte: "≤",
	exists: "exists",
	truthy: "truthy",
	includes: "includes",
	matches: "matches",
};

function conditionLabel(cond: Condition): string {
	if ("all" in cond) return cond.all.map(conditionLabel).join(" ∧ ");
	if ("any" in cond) return cond.any.map(conditionLabel).join(" ∨ ");
	if ("not" in cond) return "¬" + conditionLabel(cond.not);
	const op = MERMAID_OP[cond.op] ?? cond.op;
	const valuePart = cond.value === undefined ? "" : ` ${JSON.stringify(cond.value)}`;
	return `${cond.path} ${op}${valuePart}`;
}

export function generateMermaid(def: GraphDefinition): string {
	const lines: string[] = ["flowchart LR"];
	const referenced = new Set<string>();
	const edgeLines: string[] = [];
	for (const edge of def.edges ?? []) {
		const froms = Array.isArray(edge.from) ? edge.from : [edge.from];
		const tos = Array.isArray(edge.to) ? edge.to : [edge.to];
		for (const from of froms) {
			for (const to of tos) {
				edgeLines.push(`  ${from} --> ${to}`);
				referenced.add(from);
				referenced.add(to);
			}
		}
	}
	for (const route of def.routes ?? []) {
		for (const routeCase of route.cases) {
			const label = conditionLabel(routeCase.when).replace(/"/g, "'");
			const tos = Array.isArray(routeCase.to) ? routeCase.to : [routeCase.to];
			for (const to of tos) {
				edgeLines.push(`  ${route.from} -. "${label}" .-> ${to}`);
				referenced.add(route.from);
				referenced.add(to);
			}
		}
		if (route.default !== undefined) {
			const tos = Array.isArray(route.default) ? route.default : [route.default];
			for (const to of tos) {
				edgeLines.push(`  ${route.from} -. "else" .-> ${to}`);
				referenced.add(route.from);
				referenced.add(to);
			}
		}
	}
	for (const [id, node] of Object.entries(def.nodes)) {
		const decl = node.type === "human" ? `${id}{${id}}` : node.type === "set" ? `${id}[[${id}]]` : `${id}([${id}])`;
		lines.push(`  ${decl}`);
	}
	if (referenced.has("__end__")) lines.push("  __end__((end))");
	lines.push(...edgeLines);
	const entry = Array.isArray(def.entry) ? def.entry : def.entry ? [def.entry] : [];
	const entryIds = entry.filter((id) => def.nodes[id]);
	if (entryIds.length > 0) {
		lines.push("  classDef entry stroke:#2a2,stroke-width:3px;");
		lines.push(`  class ${entryIds.join(",")} entry;`);
	}
	return lines.join("\n");
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
		`state: ${formatBytes(result.stateBytes)}`,
	].join("\n");
	if (result.status === "interrupted" && result.interrupt) {
		return `${header}\n\nInterrupted at ${result.interrupt.nodeId}: ${result.interrupt.prompt}\nResume with pi_graph_resume and runId ${result.runId}.`;
	}
	if (result.error) return `${header}\n\nerror: ${result.error}`;
	const sections = [header];
	if (result.result) sections.push(`result:\n${truncateUtf8Text(JSON.stringify(result.result, null, 2), result.resultMaxBytes)}`);
	else sections.push(`state inventory:\n${formatStateInventory(result.state, 12)}`);
	if (result.includeState) {
		sections.push(`state:\n${truncateUtf8Text(JSON.stringify(result.state, null, 2), result.resultMaxBytes)}`);
	}
	return sections.join("\n\n");
}

function toGraphRunView(result: GraphRunResult): GraphRunView {
	return {
		runId: result.runId,
		status: result.status,
		result: result.result,
		stateBytes: result.stateBytes,
		includeState: result.includeState,
		resultMaxBytes: result.resultMaxBytes,
		usage: result.usage,
		step: result.step,
		nodeRuns: result.nodeRuns,
		interrupt: result.interrupt,
		error: result.error,
		stateInventory: formatStateInventory(result.state, 12),
	};
}

function toCheckpointView(record: CheckpointRecord): CheckpointView {
	const snapshot = record.snapshot;
	return {
		runId: snapshot.runId,
		graphName: snapshot.graphName,
		status: snapshot.status,
		revision: record.revision,
		step: snapshot.step,
		nodeRuns: snapshot.nodeRuns,
		stateBytes: stateSizeBytes(snapshot.state),
		costUsd: snapshot.usage.costUsd,
		pending: [...snapshot.pending],
		inFlight: [...(snapshot.inFlight?.unresolved ?? [])],
		threadCount: Object.keys(snapshot.threads).length,
		interruptNodeId: snapshot.interrupt?.nodeId,
		error: snapshot.error,
		stateInventory: formatStateInventory(snapshot.state, 12),
	};
}

type InspectView = "summary" | "inventory" | "path" | "full";

function formatCheckpointRecord(
	record: CheckpointRecord,
	view: InspectView,
	path: string | undefined,
	maxBytes = 80_000,
): string {
	if (view === "full") return truncateUtf8Text(JSON.stringify(record, null, 2), maxBytes);
	if (view === "path") {
		if (!path) throw new Error("inspect view=path requires path");
		const value = getPath(record.snapshot.state, path);
		if (value === undefined) throw new Error(`State path ${path} does not exist in run ${record.snapshot.runId}`);
		return truncateUtf8Text(`${path}:\n${JSON.stringify(value, null, 2)}`, maxBytes);
	}
	const snapshot = record.snapshot;
	const header = [
		`run: ${snapshot.runId}`,
		`graph: ${snapshot.graphName}`,
		`status: ${snapshot.status}`,
		`revision: ${record.revision}`,
		`step: ${snapshot.step}`,
		`node runs: ${snapshot.nodeRuns}`,
		`state bytes: ${formatBytes(stateSizeBytes(snapshot.state))}`,
		`cost: $${snapshot.usage.costUsd.toFixed(4)}`,
		`pending: ${snapshot.pending.join(", ") || "none"}`,
	];
	if (snapshot.inFlight) header.push(`in flight: ${snapshot.inFlight.unresolved.join(", ") || "none"}`);
	if (snapshot.interrupt) header.push(`interrupt: ${snapshot.interrupt.nodeId} (${snapshot.interrupt.kind})`);
	if (snapshot.error) header.push(`error: ${snapshot.error}`);
	const inventory = formatStateInventory(snapshot.state, view === "inventory" ? 100 : 16);
	return truncateUtf8Text(`${header.join("\n")}\n\nstate inventory:\n${inventory}`, maxBytes);
}

interface StateInventoryEntry {
	path: string;
	type: string;
	bytes: number;
}

function formatStateInventory(state: JsonObject, limit: number): string {
	const entries = collectStateInventory(state)
		.sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path))
		.slice(0, limit);
	if (entries.length === 0) return "(empty)";
	const pathWidth = Math.min(52, Math.max(4, ...entries.map((entry) => visibleWidth(entry.path))));
	return entries
		.map((entry) => {
			const path = truncateToWidth(entry.path, pathWidth, "…");
			const padding = " ".repeat(Math.max(0, pathWidth - visibleWidth(path)));
			return `${path}${padding}  ${entry.type.padEnd(7)}  ${formatBytes(entry.bytes)}`;
		})
		.join("\n");
}

function collectStateInventory(state: JsonObject): StateInventoryEntry[] {
	const entries: StateInventoryEntry[] = [];
	const visit = (value: JsonValue, path: string, depth: number) => {
		if (path) entries.push({ path, type: jsonType(value), bytes: Buffer.byteLength(JSON.stringify(value), "utf8") });
		if (depth >= 3) return;
		if (Array.isArray(value)) {
			for (let index = 0; index < Math.min(value.length, 20); index++) visit(value[index], `${path}[${index}]`, depth + 1);
			return;
		}
		if (isJsonObject(value)) {
			for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key, depth + 1);
		}
	};
	visit(state, "", 0);
	return entries;
}

function jsonType(value: JsonValue): string {
	if (Array.isArray(value)) return "array";
	if (isJsonObject(value)) return "object";
	if (value === null) return "null";
	return typeof value;
}

function truncateUtf8Text(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const marker = "\n… content omitted";
	const available = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
	let end = Math.min(text.length, available);
	let prefix = text.slice(0, end);
	while (Buffer.byteLength(prefix, "utf8") > available && end > 0) {
		end -= 1;
		prefix = text.slice(0, end);
	}
	return `${prefix}${marker}`;
}

function formatRunList(runs: Awaited<ReturnType<FileCheckpointStore["list"]>>): string {
	if (runs.length === 0) return "No pi-graph checkpoints found.";
	return runs
		.map(
			(run) =>
				`${run.runId} · ${run.graphName} · ${run.status} · rev ${run.revision} · step ${run.step} · ${run.nodeRuns} node runs · $${run.costUsd.toFixed(4)} · ${run.updatedAt}`,
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
