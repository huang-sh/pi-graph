export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
	[key: string]: JsonValue;
}

export type GraphScope = "user" | "project" | "both";
export type GraphStatus = "running" | "interrupted" | "completed" | "failed" | "cancelled";
export type ReducerName = "replace" | "append" | "collect" | "concat" | "merge" | "sum" | "min" | "max";
export type StateWriteMode = "reduce" | "overwrite" | "unset";
export type OnErrorStrategy = "fail" | "continue" | "route";
export type HumanInputKind = "confirm" | "input" | "select";
export type AgentResponseFormat = "text" | "json";
export type AgentContextMode = "isolated" | "thread" | "shared";
export type SharedCaptureMode = "none" | "compact" | "assistant-only" | "full";
export type AgentOutputStorage = "state" | "artifact";
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
	/** Maximum UTF-8 bytes sent to any single agent, including its node system prompt. */
	maxPromptBytes?: number;
}

export interface NodeLimits {
	timeoutMs?: number;
	maxTurns?: number;
	maxTokens?: number;
	maxCostUsd?: number;
	/** Hard preflight limit over the complete rendered prompt plus node system prompt. */
	maxPromptBytes?: number;
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
	/** Write the final output to the node output path. Defaults to true. */
	storeOutput?: boolean;
	/** Keep output inline in graph state or persist it as a runtime-managed artifact reference. */
	storage?: AgentOutputStorage;
	/** Artifact media type. Defaults from response format. */
	mediaType?: string;
	/** UTF-8 preview bytes retained in an artifact reference. Default: 2048. */
	previewBytes?: number;
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
	/** Maximum UTF-8 bytes retained for one captured message. Default: 8192. */
	maxMessageBytes?: number;
	/** Optional durable retention bound for the shared state channel. Oldest messages are pruned after commit. */
	maxStoredMessages?: number;
	/** Messages committed after a successful shared invocation. Default: compact. */
	capture?: SharedCaptureMode;
}

export interface GraphMessage extends JsonObject {
	role: GraphMessageRole;
	content: string;
	nodeId: string;
	createdAt: string;
	name: string | null;
	/** Canonical state output path when compact capture stores a reference. */
	statePath: string | null;
	/** Content hash captured with statePath so overwritten paths cannot masquerade as historical output. */
	stateHash: string | null;
}

export interface BaseNodeDefinition {
	type: "agent" | "set" | "human";
	description?: string;
	reads?: string[];
	output?: string;
	retry?: RetryPolicy;
	onError?: NodeErrorPolicy;
	limits?: NodeLimits;
	idempotent?: boolean;
}

export interface AgentNodeDefinition extends BaseNodeDefinition {
	type: "agent";
	purpose?: "reviewer";
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
	/** reduce uses the path reducer, overwrite bypasses it, unset removes the path. */
	mode?: StateWriteMode;
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

export interface StatePathPolicy {
	maxBytes?: number;
}

export interface GraphStatePolicy {
	/** Exact state-path budgets checked after every superstep commit. */
	paths?: Record<string, StatePathPolicy>;
}

export interface GraphPolicy {
	allowNonInteractive?: boolean;
	allowNonInteractiveMutations?: boolean;
	confirmProjectGraph?: boolean;
	confirmMutatingNodes?: boolean;
}

export interface GraphResultPolicy {
	/** State paths projected into the user-facing graph result. */
	paths?: string[];
	/** Explicitly include the complete state in the user-facing result. Default false. */
	includeState?: boolean;
	/** Maximum UTF-8 bytes rendered for the projected result/full state. */
	maxBytes?: number;
}

export interface GraphDefinition {
	schemaVersion: 2;
	name: string;
	description?: string;
	entry: string | string[];
	initialState?: JsonObject;
	nodes: Record<string, NodeDefinition>;
	edges?: EdgeDefinition[];
	routes?: RouteDefinition[];
	reducers?: Record<string, ReducerName>;
	limits?: GraphLimits;
	statePolicy?: GraphStatePolicy;
	policy?: GraphPolicy;
	result?: GraphResultPolicy;
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
	value?: JsonValue;
	nodeId: string;
	mode?: StateWriteMode;
}

export interface ArtifactReference extends JsonObject {
	kind: "artifact";
	uri: string;
	mediaType: string;
	bytes: number;
	sha256: string;
	preview: string;
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
	version: 2;
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
	threads: Record<string, AgentThreadState>;
	inFlight?: InFlightStep;
	interrupt?: GraphInterrupt;
	error?: string;
}

export interface CheckpointSummary {
	runId: string;
	revision: number;
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
		| "node_settled"
		| "node_end"
		| "checkpoint"
		| "interrupt"
		| "step_end"
		| "graph_end";
	runId: string;
	timestamp: string;
	step?: number;
	/** Exact nodes selected for a step. Present on step_start events. */
	scheduled?: string[];
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
	/** Durable internal state. Tool/UI formatting must not expose it by default. */
	state: JsonObject;
	/** Configured user-facing result projection. */
	result?: JsonObject;
	stateBytes: number;
	includeState: boolean;
	resultMaxBytes: number;
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
	filePath: string;
	scope: "user" | "project";
	compiled: CompiledGraph;
}

export interface GraphDiscoveryResult {
	graphs: GraphSource[];
	projectGraphsDir: string | null;
	diagnostics: Diagnostic[];
}

export const END = "__end__";
