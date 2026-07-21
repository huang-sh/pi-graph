export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
	[key: string]: JsonValue;
}

export type GraphScope = "user" | "project" | "both";
export type GraphStatus = "running" | "interrupted" | "completed" | "failed" | "cancelled";
export type NodePurpose = "worker" | "reviewer" | "router" | "deterministic";
export type ReducerName = "replace" | "append" | "concat" | "merge" | "sum" | "min" | "max";
export type OnErrorStrategy = "fail" | "continue" | "route";
export type HumanInputKind = "confirm" | "input" | "select";
export type AgentResponseFormat = "text" | "json";
export type AgentContextMode = "isolated" | "thread" | "shared";
export type GraphMessageRole = "user" | "assistant" | "tool";
export type ConditionOperator =
	| "eq"
	| "ne"
	| "gt"
	| "gte"
	| "lt"
	| "lte"
	| "exists"
	| "includes"
	| "matches"
	| "truthy";

export interface UsageLedger {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	turns: number;
	costUsd: number;
}

export interface GraphLimits {
	maxSteps?: number;
	maxNodeRuns?: number;
	maxConcurrency?: number;
	maxCostUsd?: number;
	maxTokens?: number;
	timeoutMs?: number;
	maxStateBytes?: number;
}

export interface NodeLimits {
	timeoutMs?: number;
	maxTurns?: number;
	maxTokens?: number;
	maxCostUsd?: number;
	maxOutputBytes?: number;
}

export interface RetryPolicy {
	maxAttempts?: number;
	backoffMs?: number;
	backoffMultiplier?: number;
}

export interface NodeErrorPolicy {
	strategy?: OnErrorStrategy;
	to?: string | string[];
	output?: string;
}

export interface AgentResponsePolicy {
	format?: AgentResponseFormat;
	maxBytes?: number;
}

export interface AgentContextPolicy {
	/** Default: isolated. */
	mode?: AgentContextMode;
	/** Private Pi session identity for thread mode. Defaults to the node id. */
	threadKey?: string;
	/** Shared message channel in graph state. Defaults to messages. */
	messagesPath?: string;
	/** Maximum recent shared messages injected into one node prompt. */
	maxMessages?: number;
	/** Maximum UTF-8 bytes of shared transcript injected into one node prompt. */
	maxPromptBytes?: number;
}

export interface GraphMessage extends JsonObject {
	role: GraphMessageRole;
	content: string;
	nodeId: string;
	createdAt: string;
	name: string | null;
}

export interface BaseNodeDefinition {
	type: "agent" | "set" | "human";
	description?: string;
	purpose?: NodePurpose;
	reads?: string[];
	output?: string;
	retry?: RetryPolicy;
	onError?: NodeErrorPolicy;
	limits?: NodeLimits;
	idempotent?: boolean;
}

export interface AgentNodeDefinition extends BaseNodeDefinition {
	type: "agent";
	prompt: string;
	systemPrompt?: string;
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	tools?: string[];
	readOnly?: boolean;
	cwd?: string;
	loadExtensions?: boolean;
	loadSkills?: boolean;
	loadPromptTemplates?: boolean;
	includeContextFiles?: boolean;
	context?: AgentContextPolicy;
	response?: AgentResponsePolicy;
}

export interface StateAssignment {
	path: string;
	value?: JsonValue;
	template?: string;
	from?: string;
}

export interface SetNodeDefinition extends BaseNodeDefinition {
	type: "set";
	assign: StateAssignment[];
}

export interface HumanNodeDefinition extends BaseNodeDefinition {
	type: "human";
	kind?: HumanInputKind;
	prompt: string;
	options?: string[];
	pause?: boolean;
}

export type NodeDefinition = AgentNodeDefinition | SetNodeDefinition | HumanNodeDefinition;

export interface EdgeDefinition {
	from: string | string[];
	to: string | string[];
}

export interface LeafCondition {
	path: string;
	op: ConditionOperator;
	value?: JsonValue;
}

export interface AllCondition {
	all: Condition[];
}

export interface AnyCondition {
	any: Condition[];
}

export interface NotCondition {
	not: Condition;
}

export type Condition = LeafCondition | AllCondition | AnyCondition | NotCondition;

export interface RouteCase {
	when: Condition;
	to: string | string[];
}

export interface RouteDefinition {
	from: string;
	cases: RouteCase[];
	default?: string | string[];
}

export interface GraphPolicy {
	allowNonInteractive?: boolean;
	allowNonInteractiveMutations?: boolean;
	confirmProjectGraph?: boolean;
	confirmMutatingNodes?: boolean;
}

export interface GraphDefinition {
	schemaVersion: 1;
	name: string;
	description?: string;
	entry: string | string[];
	initialState?: JsonObject;
	nodes: Record<string, NodeDefinition>;
	edges?: EdgeDefinition[];
	routes?: RouteDefinition[];
	reducers?: Record<string, ReducerName>;
	limits?: GraphLimits;
	policy?: GraphPolicy;
}

export interface Diagnostic {
	level: "error" | "warning";
	code: string;
	message: string;
	path?: string;
}

export interface CompiledEdge {
	id: string;
	from: string[];
	to: string[];
	barrier: boolean;
}

export interface CompiledGraph {
	definition: GraphDefinition;
	hash: string;
	diagnostics: Diagnostic[];
	staticEdges: CompiledEdge[];
	routesByNode: Map<string, RouteDefinition>;
	/** Explicit reducers plus implicit concat reducers for shared message channels. */
	reducers: Record<string, ReducerName>;
}

export interface StateWrite {
	path: string;
	value: JsonValue;
	nodeId: string;
}

export interface NodeUsage extends UsageLedger {
	model?: string;
}

export interface GraphInterrupt {
	nodeId: string;
	kind: HumanInputKind;
	prompt: string;
	options?: string[];
	createdAt: string;
}

export interface NodeExecutionSuccess {
	kind: "success";
	writes: StateWrite[];
	output?: JsonValue;
	usage: NodeUsage;
	next?: string[];
	attempts: number;
	startedAt: string;
	endedAt: string;
}

export interface NodeExecutionInterrupt {
	kind: "interrupt";
	interrupt: GraphInterrupt;
	usage: NodeUsage;
	attempts: number;
	startedAt: string;
	endedAt: string;
}

export interface NodeExecutionFailure {
	kind: "failure";
	error: string;
	code?: string;
	retryable: boolean;
	usage: NodeUsage;
	attempts: number;
	startedAt: string;
	endedAt: string;
}

export type NodeExecutionResult = NodeExecutionSuccess | NodeExecutionInterrupt | NodeExecutionFailure;

export interface NodeRunHistory {
	step: number;
	nodeId: string;
	status: "completed" | "failed" | "interrupted";
	attempts: number;
	startedAt: string;
	endedAt: string;
	usage: NodeUsage;
	error?: string;
}

export interface InFlightStep {
	step: number;
	scheduled: string[];
	unresolved: string[];
	completed: Record<string, NodeExecutionSuccess>;
}

export interface AgentThreadState {
	key: string;
	sessionId: string;
	createdAt: string;
	updatedAt: string;
	nodes: string[];
	/** Number of Pi subprocess invocations recorded for this thread. */
	invocationCount: number;
	/** Most recent graph node that used the private session. */
	lastNodeId?: string;
}

export interface CheckpointSnapshot {
	version: 1;
	runId: string;
	graphName: string;
	graphHash: string;
	graphSource?: string;
	status: GraphStatus;
	createdAt: string;
	updatedAt: string;
	startedAt: string;
	endedAt?: string;
	activeTimeMs: number;
	step: number;
	nodeRuns: number;
	state: JsonObject;
	pending: string[];
	completionCounts: Record<string, number>;
	barrierConsumed: Record<string, Record<string, number>>;
	usage: UsageLedger;
	history: NodeRunHistory[];
	/** Durable metadata for private Pi sessions used by thread context nodes. */
	threads?: Record<string, AgentThreadState>;
	inFlight?: InFlightStep;
	interrupt?: GraphInterrupt;
	error?: string;
}

export interface CheckpointSummary {
	runId: string;
	graphName: string;
	status: GraphStatus;
	updatedAt: string;
	step: number;
	nodeRuns: number;
	costUsd: number;
}

export interface GraphRunEvent {
	type:
		| "graph_start"
		| "step_start"
		| "node_start"
		| "node_retry"
		| "node_end"
		| "checkpoint"
		| "interrupt"
		| "step_end"
		| "graph_end";
	runId: string;
	timestamp: string;
	step?: number;
	nodeId?: string;
	attempt?: number;
	status?: GraphStatus | "completed" | "failed" | "interrupted";
	message?: string;
	usage?: UsageLedger;
}

export interface GraphRunOptions {
	input?: JsonObject;
	runId?: string;
	resumeValue?: JsonValue;
	forceGraphVersion?: boolean;
	checkpoint?: boolean;
	signal?: AbortSignal;
	onEvent?: (event: GraphRunEvent) => void | Promise<void>;
}

export interface GraphRunResult {
	runId: string;
	status: GraphStatus;
	state: JsonObject;
	usage: UsageLedger;
	step: number;
	nodeRuns: number;
	interrupt?: GraphInterrupt;
	error?: string;
}

export interface ExecutionBudget {
	usage: UsageLedger;
	report(delta: Partial<UsageLedger>): void;
	assertWithinLimits(nodeId: string, nodeUsage: UsageLedger, nodeLimits?: NodeLimits): void;
}

export interface NodeExecutionContext {
	runId: string;
	step: number;
	nodeId: string;
	state: JsonObject;
	graph: CompiledGraph;
	thread?: AgentThreadState;
	resumeValue?: JsonValue;
	signal?: AbortSignal;
	budget: ExecutionBudget;
	onEvent?: (event: GraphRunEvent) => void | Promise<void>;
}

export interface NodeExecutor {
	execute(node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult>;
}

export interface GraphSource {
	name: string;
	description?: string;
	filePath: string;
	scope: "user" | "project";
	definition: GraphDefinition;
	hash: string;
	diagnostics: Diagnostic[];
}

export interface GraphDiscoveryResult {
	graphs: GraphSource[];
	projectGraphsDir: string | null;
	diagnostics: Diagnostic[];
}

export const END = "__end__";
