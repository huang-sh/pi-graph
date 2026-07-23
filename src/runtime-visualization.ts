import type {
	CheckpointSnapshot,
	GraphDefinition,
	GraphRunEvent,
	GraphStatus,
	NodeRunHistory,
	UsageLedger,
} from "./types.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { emptyUsage, usageTokens } from "./utils.ts";

export type RuntimeNodeStatus =
	| "waiting"
	| "queued"
	| "running"
	| "retrying"
	| "completed"
	| "failed"
	| "interrupted"
	| "cancelled";

export interface RuntimeGraphLink {
	target: string;
	kind: "edge" | "route" | "error";
}

export interface RuntimeNodeView {
	id: string;
	type: "agent" | "set" | "human";
	status: RuntimeNodeStatus;
	step?: number;
	attempt?: number;
	runs: number;
	elapsedMs?: number;
	updatedAtMs: number;
	message?: string;
	processed: boolean;
	links: RuntimeGraphLink[];
}

export interface RuntimeGraphView {
	graphName: string;
	runId?: string;
	status: GraphStatus;
	step: number;
	nodeRuns: number;
	elapsedMs: number;
	usage: UsageLedger;
	message?: string;
	nodes: RuntimeNodeView[];
}

interface MutableRuntimeNode {
	id: string;
	type: RuntimeNodeView["type"];
	status: RuntimeNodeStatus;
	step?: number;
	attempt?: number;
	runs: number;
	startedAtMs?: number;
	endedAtMs?: number;
	updatedAtMs: number;
	message?: string;
	processed: boolean;
	links: RuntimeGraphLink[];
}

interface RuntimeGraphMonitorOptions {
	checkpoint?: CheckpointSnapshot;
	now?: () => number;
}

interface RenderRuntimeGraphOptions {
	maxLines?: number;
	maxLineLength?: number;
}

const ACTIVE_NODE_STATUSES = new Set<RuntimeNodeStatus>(["running", "retrying"]);
const TERMINAL_NODE_STATUSES = new Set<RuntimeNodeStatus>(["completed", "failed", "interrupted", "cancelled"]);
const DEFAULT_MAX_LINES = 10;
const DEFAULT_MAX_LINE_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 160;

export class RuntimeGraphMonitor {
	private readonly definition: GraphDefinition;
	private readonly now: () => number;
	private readonly nodes = new Map<string, MutableRuntimeNode>();
	private readonly invocationStartedAtMs: number;
	private baseElapsedMs = 0;
	private endedAtMs: number | undefined;
	private runId: string | undefined;
	private status: GraphStatus = "running";
	private step = 0;
	private nodeRuns = 0;
	private usage: UsageLedger = emptyUsage();
	private message: string | undefined;

	constructor(definition: GraphDefinition, options: RuntimeGraphMonitorOptions = {}) {
		this.definition = definition;
		this.now = options.now ?? Date.now;
		this.invocationStartedAtMs = this.now();
		const links = collectLinks(definition);
		for (const [id, node] of Object.entries(definition.nodes)) {
			this.nodes.set(id, {
				id,
				type: node.type,
				status: "waiting",
				runs: 0,
				updatedAtMs: this.invocationStartedAtMs,
				processed: false,
				links: links.get(id) ?? [],
			});
		}
		if (options.checkpoint) this.hydrate(options.checkpoint);
	}

	apply(event: GraphRunEvent): void {
		const changedAtMs = this.now();
		this.runId = event.runId || this.runId;
		if (event.step !== undefined) this.step = event.step;
		if (event.usage) this.usage = copyUsage(event.usage);

		switch (event.type) {
			case "graph_start":
				this.status = "running";
				this.endedAtMs = undefined;
				break;
			case "step_start":
				for (const nodeId of event.scheduled ?? []) this.updateNode(nodeId, "queued", event, changedAtMs);
				break;
			case "node_start": {
				const node = this.updateNode(event.nodeId, "running", event, changedAtMs);
				if (node) {
					this.nodeRuns += 1;
					if ((event.attempt ?? 1) === 1) node.runs += 1;
					node.startedAtMs = changedAtMs;
					node.endedAtMs = undefined;
					node.message = undefined;
					node.processed = false;
				}
				break;
			}
			case "node_retry":
				this.updateNode(event.nodeId, "retrying", event, changedAtMs);
				break;
			case "node_settled": {
				const status = nodeStatusFromEvent(event.status);
				const node = status ? this.updateNode(event.nodeId, status, event, changedAtMs) : undefined;
				if (node) node.endedAtMs = changedAtMs;
				break;
			}
			case "node_end": {
				const status = nodeStatusFromEvent(event.status);
				const node = status ? this.updateNode(event.nodeId, status, event, changedAtMs) : undefined;
				if (node) {
					node.endedAtMs ??= changedAtMs;
					node.processed = true;
				}
				break;
			}
			case "interrupt": {
				const node = this.updateNode(event.nodeId, "interrupted", event, changedAtMs);
				if (node) node.endedAtMs ??= changedAtMs;
				this.status = "interrupted";
				break;
			}
			case "graph_end":
				this.status = graphStatusFromEvent(event.status) ?? this.status;
				this.message = truncateMessage(event.message);
				this.endedAtMs = changedAtMs;
				this.finishActiveNodes(changedAtMs);
				break;
			case "checkpoint":
			case "step_end":
				break;
		}
	}

	view(): RuntimeGraphView {
		const now = this.now();
		const invocationEnd = this.endedAtMs ?? now;
		return {
			graphName: this.definition.name,
			runId: this.runId,
			status: this.status,
			step: this.step,
			nodeRuns: this.nodeRuns,
			elapsedMs: this.baseElapsedMs + Math.max(0, invocationEnd - this.invocationStartedAtMs),
			usage: copyUsage(this.usage),
			message: this.message,
			nodes: [...this.nodes.values()].map((node) => ({
				id: node.id,
				type: node.type,
				status: node.status,
				step: node.step,
				attempt: node.attempt,
				runs: node.runs,
				elapsedMs:
					node.startedAtMs === undefined
						? undefined
						: Math.max(0, (node.endedAtMs ?? now) - node.startedAtMs),
				updatedAtMs: node.updatedAtMs,
				message: node.message,
				processed: node.processed,
				links: node.links.map((link) => ({ ...link })),
			})),
		};
	}

	private hydrate(checkpoint: CheckpointSnapshot): void {
		this.runId = checkpoint.runId;
		this.status = checkpoint.status;
		this.step = checkpoint.step;
		this.nodeRuns = checkpoint.nodeRuns;
		this.usage = copyUsage(checkpoint.usage);
		this.baseElapsedMs = checkpoint.activeTimeMs;
		for (const history of checkpoint.history) this.hydrateHistory(history);
		if (checkpoint.inFlight) {
			for (const nodeId of Object.keys(checkpoint.inFlight.completed)) {
				const node = this.nodes.get(nodeId);
				if (node?.status === "waiting") node.status = "completed";
			}
			for (const nodeId of checkpoint.inFlight.unresolved) {
				const node = this.nodes.get(nodeId);
				if (node) {
					node.status = "queued";
					node.step = checkpoint.inFlight.step;
				}
			}
		} else {
			for (const nodeId of checkpoint.pending) {
				const node = this.nodes.get(nodeId);
				if (node) node.status = "queued";
			}
		}
		if (checkpoint.interrupt) {
			const node = this.nodes.get(checkpoint.interrupt.nodeId);
			if (node) {
				node.status = "interrupted";
				node.message = truncateMessage(checkpoint.interrupt.prompt);
			}
		}
	}

	private hydrateHistory(history: NodeRunHistory): void {
		const node = this.nodes.get(history.nodeId);
		if (!node) return;
		node.status = history.status;
		node.step = history.step;
		node.attempt = history.attempts;
		node.runs += 1;
		node.startedAtMs = parseTimestamp(history.startedAt);
		node.endedAtMs = parseTimestamp(history.endedAt);
		node.updatedAtMs = node.endedAtMs ?? this.invocationStartedAtMs;
		node.message = truncateMessage(history.error);
		node.processed = true;
	}

	private updateNode(
		nodeId: string | undefined,
		status: RuntimeNodeStatus,
		event: GraphRunEvent,
		changedAtMs: number,
	): MutableRuntimeNode | undefined {
		if (!nodeId) return undefined;
		const node = this.nodes.get(nodeId);
		if (!node) return undefined;
		node.status = status;
		node.step = event.step ?? node.step;
		node.attempt = event.attempt ?? node.attempt;
		node.updatedAtMs = changedAtMs;
		if (event.message !== undefined) node.message = truncateMessage(event.message);
		return node;
	}

	private finishActiveNodes(changedAtMs: number): void {
		for (const node of this.nodes.values()) {
			if (node.status !== "queued" && !ACTIVE_NODE_STATUSES.has(node.status)) continue;
			node.status =
				node.status === "queued" || this.status === "cancelled"
					? "cancelled"
					: this.status === "interrupted"
						? "interrupted"
						: "failed";
			node.endedAtMs ??= changedAtMs;
			node.updatedAtMs = changedAtMs;
		}
	}
}

export function renderRuntimeGraph(view: RuntimeGraphView, options: RenderRuntimeGraphOptions = {}): string[] {
	const maxLines = Math.max(4, options.maxLines ?? DEFAULT_MAX_LINES);
	const maxLineLength = Math.max(40, options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH);
	const runId = view.runId ? ` · ${view.runId.slice(0, 8)}` : "";
	const lines = [
		truncateToWidth(
			`pi-graph · ${view.graphName} · ${view.status.toUpperCase()} · step ${view.step}${runId} · ${formatDuration(view.elapsedMs)}`,
			maxLineLength,
			"…",
		),
	];
	const active = view.nodes.filter((node) => ACTIVE_NODE_STATUSES.has(node.status)).length;
	const done = view.nodes.filter((node) => TERMINAL_NODE_STATUSES.has(node.status)).length;
	lines.push(
		truncateToWidth(
			`active ${active} · done ${done}/${view.nodes.length} · runs ${view.nodeRuns} · ${formatTokens(usageTokens(view.usage))} tok · $${view.usage.costUsd.toFixed(4)}`,
			maxLineLength,
			"…",
		),
	);

	const nodeLineCapacity = maxLines - 2;
	const needsOmission = view.nodes.length > nodeLineCapacity;
	const visibleCapacity = needsOmission ? Math.max(1, nodeLineCapacity - 1) : nodeLineCapacity;
	const visible = selectVisibleNodes(view.nodes, visibleCapacity);
	for (const node of visible) lines.push(truncateToWidth(formatNodeLine(node), maxLineLength, "…"));
	if (needsOmission) lines.push(`  … ${view.nodes.length - visible.length} more node(s)`);
	return lines.slice(0, maxLines);
}

function collectLinks(definition: GraphDefinition): Map<string, RuntimeGraphLink[]> {
	const result = new Map<string, RuntimeGraphLink[]>();
	for (const nodeId of Object.keys(definition.nodes)) result.set(nodeId, []);
	const add = (source: string, target: string, kind: RuntimeGraphLink["kind"]) => {
		const links = result.get(source);
		if (!links || links.some((link) => link.target === target && link.kind === kind)) return;
		links.push({ target, kind });
	};
	for (const edge of definition.edges ?? []) {
		const sources = Array.isArray(edge.from) ? edge.from : [edge.from];
		const targets = Array.isArray(edge.to) ? edge.to : [edge.to];
		for (const source of sources) for (const target of targets) add(source, displayTarget(target), "edge");
	}
	for (const route of definition.routes ?? []) {
		for (const routeCase of route.cases) {
			const targets = Array.isArray(routeCase.to) ? routeCase.to : [routeCase.to];
			for (const target of targets) add(route.from, displayTarget(target), "route");
		}
		if (route.default !== undefined) {
			const targets = Array.isArray(route.default) ? route.default : [route.default];
			for (const target of targets) add(route.from, displayTarget(target), "route");
		}
	}
	for (const [nodeId, node] of Object.entries(definition.nodes)) {
		if (node.onError?.strategy !== "route" || node.onError.to === undefined) continue;
		const targets = Array.isArray(node.onError.to) ? node.onError.to : [node.onError.to];
		for (const target of targets) add(nodeId, displayTarget(target), "error");
	}
	return result;
}

function selectVisibleNodes(nodes: RuntimeNodeView[], limit: number): RuntimeNodeView[] {
	if (nodes.length <= limit) return nodes;
	const selected: RuntimeNodeView[] = [];
	const add = (candidates: RuntimeNodeView[]) => {
		for (const node of candidates) {
			if (selected.length >= limit) return;
			if (!selected.includes(node)) selected.push(node);
		}
	};
	add(nodes.filter((node) => ACTIVE_NODE_STATUSES.has(node.status) || node.status === "failed" || node.status === "interrupted"));
	add(nodes.filter((node) => node.status === "queued"));
	add(
		nodes
			.filter((node) => node.status === "completed" || node.status === "cancelled")
			.toSorted((left, right) => right.updatedAtMs - left.updatedAtMs),
	);
	add(nodes.filter((node) => node.status === "waiting"));
	return selected;
}

function formatNodeLine(node: RuntimeNodeView): string {
	const glyph = nodeGlyph(node.status);
	const details: string[] = [node.status];
	if (node.attempt !== undefined && (ACTIVE_NODE_STATUSES.has(node.status) || node.status === "failed")) {
		details.push(`attempt ${node.attempt}`);
	}
	if (node.elapsedMs !== undefined && (ACTIVE_NODE_STATUSES.has(node.status) || node.status === "failed")) {
		details.push(formatDuration(node.elapsedMs));
	}
	if (node.runs > 1) details.push(`run ${node.runs}`);
	if (node.message && (node.status === "retrying" || node.status === "failed" || node.status === "interrupted")) {
		details.push(node.message);
	}
	const links = formatLinks(node.links);
	return `  ${glyph} ${node.id} · ${details.join(" · ")}${links ? ` ${links}` : ""}`;
}

function formatLinks(links: RuntimeGraphLink[]): string {
	const parts: string[] = [];
	for (const [kind, marker] of [
		["edge", "→"],
		["route", "⇢"],
		["error", "!→"],
	] as const) {
		const targets = links.filter((link) => link.kind === kind).map((link) => link.target);
		if (targets.length > 0) parts.push(`${marker} ${targets.join(", ")}`);
	}
	return parts.join(" · ");
}

function nodeGlyph(status: RuntimeNodeStatus): string {
	if (status === "queued") return "◌";
	if (status === "running") return "●";
	if (status === "retrying") return "↻";
	if (status === "completed") return "✓";
	if (status === "failed") return "✗";
	if (status === "interrupted") return "!";
	if (status === "cancelled") return "×";
	return "○";
}

function nodeStatusFromEvent(status: GraphRunEvent["status"]): RuntimeNodeStatus | undefined {
	if (status === "completed" || status === "failed" || status === "interrupted") return status;
	if (status === "cancelled") return "cancelled";
	return undefined;
}

function graphStatusFromEvent(status: GraphRunEvent["status"]): GraphStatus | undefined {
	if (status === "running" || status === "completed" || status === "failed" || status === "interrupted" || status === "cancelled") {
		return status;
	}
	return undefined;
}

function copyUsage(usage: UsageLedger): UsageLedger {
	return { ...usage };
}

function parseTimestamp(value: string): number | undefined {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function truncateMessage(message: string | undefined): string | undefined {
	if (!message) return undefined;
	const normalized = message.replaceAll(/\s+/g, " ").trim();
	return normalized.length <= MAX_MESSAGE_LENGTH ? normalized : `${normalized.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m${remainingSeconds.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function displayTarget(target: string): string {
	return target === "__end__" ? "end" : target;
}
