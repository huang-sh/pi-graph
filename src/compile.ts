import type {
	AgentNodeDefinition,
	CompiledEdge,
	CompiledGraph,
	Condition,
	Diagnostic,
	EdgeDefinition,
	GraphDefinition,
	HumanNodeDefinition,
	JsonObject,
	NodeDefinition,
	ReducerName,
	RouteDefinition,
	SetNodeDefinition,
} from "./types.ts";
import { posix as pathPosix } from "node:path";
import { END } from "./types.ts";
import {
	asStringArray,
	assertNonNegativeNumber,
	assertPositiveInteger,
	hashJson,
	isJsonObject,
	normalizePath,
	toJsonValue,
	uniqueStrings,
} from "./utils.ts";

const KNOWN_REDUCERS = new Set(["replace", "append", "concat", "merge", "sum", "min", "max"]);
const KNOWN_OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "exists", "includes", "matches", "truthy"]);
const KNOWN_NODE_TYPES = new Set(["agent", "set", "human"]);
const KNOWN_PURPOSES = new Set(["worker", "reviewer", "router", "deterministic"]);
const KNOWN_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const KNOWN_ERROR_STRATEGIES = new Set(["fail", "continue", "route"]);
const KNOWN_HUMAN_KINDS = new Set(["confirm", "input", "select"]);
const KNOWN_RESPONSE_FORMATS = new Set(["text", "json"]);
const KNOWN_CONTEXT_MODES = new Set(["isolated", "thread", "shared"]);
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

export class GraphValidationError extends Error {
	readonly diagnostics: Diagnostic[];

	constructor(diagnostics: Diagnostic[]) {
		super(diagnostics.filter((item) => item.level === "error").map((item) => item.message).join("; "));
		this.name = "GraphValidationError";
		this.diagnostics = diagnostics;
	}
}

export function parseGraphDefinition(raw: unknown, source = "graph"): GraphDefinition {
	const normalized = toJsonValue(raw, source);
	if (!isJsonObject(normalized)) throw new Error(`${source} must be a JSON object`);
	const diagnostics: Diagnostic[] = [];

	if (normalized.schemaVersion !== 1) pushError(diagnostics, "SCHEMA_VERSION", "schemaVersion must be 1", "schemaVersion");
	if (typeof normalized.name !== "string" || !normalized.name.trim()) {
		pushError(diagnostics, "GRAPH_NAME", "name must be a non-empty string", "name");
	}
	validateOptionalString(normalized, "description", diagnostics, "description");
	validateStringOrStringArray(normalized.entry, diagnostics, "entry");
	if (!isJsonObject(normalized.nodes)) pushError(diagnostics, "NODES", "nodes must be an object", "nodes");

	if (isJsonObject(normalized.nodes)) {
		for (const [nodeId, rawNode] of Object.entries(normalized.nodes)) validateRawNode(nodeId, rawNode, diagnostics);
	}
	if (normalized.edges !== undefined) validateRawEdges(normalized.edges, diagnostics);
	if (normalized.routes !== undefined) validateRawRoutes(normalized.routes, diagnostics);
	if (normalized.reducers !== undefined) validateRawReducers(normalized.reducers, diagnostics);
	if (normalized.initialState !== undefined && !isJsonObject(normalized.initialState)) {
		pushError(diagnostics, "INITIAL_STATE", "initialState must be an object", "initialState");
	}
	if (normalized.limits !== undefined) validateRawLimits(normalized.limits, diagnostics, "limits", true);
	if (normalized.policy !== undefined) validateRawPolicy(normalized.policy, diagnostics, "policy");

	if (diagnostics.some((item) => item.level === "error")) throw new GraphValidationError(diagnostics);
	return normalized as unknown as GraphDefinition;
}

export function compileGraph(definition: GraphDefinition): CompiledGraph {
	const diagnostics = validateGraph(definition);
	if (diagnostics.some((item) => item.level === "error")) throw new GraphValidationError(diagnostics);
	const staticEdges: CompiledEdge[] = (definition.edges ?? []).map((edge, index) => ({
		id: `edge:${index}`,
		from: uniqueStrings(asStringArray(edge.from)),
		to: uniqueStrings(asStringArray(edge.to)),
		barrier: uniqueStrings(asStringArray(edge.from)).length > 1,
	}));
	const routesByNode = new Map<string, RouteDefinition>();
	for (const route of definition.routes ?? []) routesByNode.set(route.from, route);
	return {
		definition,
		hash: hashJson(toJsonValue(definition)),
		diagnostics,
		staticEdges,
		routesByNode,
		reducers: resolveEffectiveReducers(definition),
	};
}

export function parseAndCompileGraph(raw: unknown, source = "graph"): CompiledGraph {
	return compileGraph(parseGraphDefinition(raw, source));
}

export function validateGraph(definition: GraphDefinition): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const nodeIds = Object.keys(definition.nodes);
	const nodeSet = new Set(nodeIds);

	if (definition.schemaVersion !== 1) pushError(diagnostics, "SCHEMA_VERSION", "schemaVersion must be 1", "schemaVersion");
	if (!definition.name.trim()) pushError(diagnostics, "GRAPH_NAME", "name must be non-empty", "name");
	if (nodeIds.length === 0) pushError(diagnostics, "EMPTY_GRAPH", "Graph must define at least one node", "nodes");
	if (nodeIds.length === 1) {
		pushWarning(
			diagnostics,
			"SINGLE_NODE_GRAPH",
			"This graph has one node. Prefer a single agent loop unless persistence or human interruption is the actual requirement.",
			"nodes",
		);
	}

	for (const entry of asStringArray(definition.entry)) validateTarget(entry, nodeSet, diagnostics, "entry");
	for (const [nodeId, node] of Object.entries(definition.nodes)) validateNode(nodeId, node, diagnostics, nodeSet);

	const routeSources = new Set<string>();
	for (const [index, edge] of (definition.edges ?? []).entries()) validateEdge(edge, index, nodeSet, diagnostics);
	for (const [index, route] of (definition.routes ?? []).entries()) {
		if (routeSources.has(route.from)) {
			pushError(diagnostics, "DUPLICATE_ROUTE", `Node ${route.from} has more than one conditional route`, `routes.${index}.from`);
		}
		routeSources.add(route.from);
		validateRoute(route, index, nodeSet, diagnostics);
	}

	for (const [path, reducer] of Object.entries(definition.reducers ?? {})) {
		try {
			normalizePath(path);
		} catch (error) {
			pushError(diagnostics, "REDUCER_PATH", String(error), `reducers.${path}`);
		}
		if (!KNOWN_REDUCERS.has(reducer)) {
			pushError(diagnostics, "REDUCER", `Unknown reducer ${JSON.stringify(reducer)} at ${path}`, `reducers.${path}`);
		}
	}

	validateLimits(definition, diagnostics);
	validateGraphPolicy(definition, diagnostics);
	validateReachability(definition, diagnostics);
	validateAgentContexts(definition, diagnostics);
	validateThreadContextCompatibility(definition, diagnostics);
	validateParallelWrites(definition, diagnostics);
	validateParallelThreadContexts(definition, diagnostics);
	return diagnostics;
}

function validateRawNode(nodeId: string, rawNode: unknown, diagnostics: Diagnostic[]): void {
	const path = `nodes.${nodeId}`;
	if (!nodeId.trim() || nodeId === END) pushError(diagnostics, "NODE_ID", `${JSON.stringify(nodeId)} is not a valid node id`, path);
	if (!isJsonObject(rawNode)) {
		pushError(diagnostics, "NODE", "Node definition must be an object", path);
		return;
	}
	if (typeof rawNode.type !== "string" || !KNOWN_NODE_TYPES.has(rawNode.type)) {
		pushError(diagnostics, "NODE_TYPE", "Node type must be agent, set, or human", `${path}.type`);
		return;
	}

	validateOptionalString(rawNode, "description", diagnostics, `${path}.description`);
	validateOptionalString(rawNode, "output", diagnostics, `${path}.output`);
	if (typeof rawNode.output === "string") validateStatePath(rawNode.output, diagnostics, `${path}.output`);
	if (rawNode.purpose !== undefined && (typeof rawNode.purpose !== "string" || !KNOWN_PURPOSES.has(rawNode.purpose))) {
		pushError(diagnostics, "NODE_PURPOSE", "purpose must be worker, reviewer, router, or deterministic", `${path}.purpose`);
	}
	if (rawNode.reads !== undefined) {
		if (!isStringArray(rawNode.reads)) pushError(diagnostics, "NODE_READS", "reads must be an array of strings", `${path}.reads`);
		else rawNode.reads.forEach((readPath, index) => validateStatePath(readPath, diagnostics, `${path}.reads.${index}`));
	}
	validateOptionalBoolean(rawNode, "idempotent", diagnostics, `${path}.idempotent`);
	if (rawNode.retry !== undefined) validateRawRetry(rawNode.retry, diagnostics, `${path}.retry`);
	if (rawNode.onError !== undefined) validateRawErrorPolicy(rawNode.onError, diagnostics, `${path}.onError`);
	if (rawNode.limits !== undefined) validateRawLimits(rawNode.limits, diagnostics, `${path}.limits`, false);

	if (rawNode.type === "agent") {
		if (typeof rawNode.prompt !== "string" || !rawNode.prompt.trim()) {
			pushError(diagnostics, "AGENT_PROMPT", "Agent node requires a non-empty prompt", `${path}.prompt`);
		}
		for (const field of ["systemPrompt", "model", "cwd"] as const) validateOptionalString(rawNode, field, diagnostics, `${path}.${field}`);
		if (rawNode.thinking !== undefined && (typeof rawNode.thinking !== "string" || !KNOWN_THINKING_LEVELS.has(rawNode.thinking))) {
			pushError(diagnostics, "THINKING_LEVEL", "Invalid thinking level", `${path}.thinking`);
		}
		if (rawNode.tools !== undefined && !isStringArray(rawNode.tools)) {
			pushError(diagnostics, "AGENT_TOOLS", "Agent tools must be an array of strings", `${path}.tools`);
		}
		for (const field of ["readOnly", "loadExtensions", "loadSkills", "loadPromptTemplates", "includeContextFiles"] as const) {
			validateOptionalBoolean(rawNode, field, diagnostics, `${path}.${field}`);
		}
		if (rawNode.response !== undefined) validateRawResponse(rawNode.response, diagnostics, `${path}.response`);
		if (rawNode.context !== undefined) validateRawAgentContext(rawNode.context, diagnostics, `${path}.context`);
	}
	if (rawNode.type === "set") {
		if (!Array.isArray(rawNode.assign)) pushError(diagnostics, "SET_ASSIGN", "Set node requires an assign array", `${path}.assign`);
		else {
			for (const [index, assignment] of rawNode.assign.entries()) {
				const assignmentPath = `${path}.assign.${index}`;
				if (!isJsonObject(assignment) || typeof assignment.path !== "string") {
					pushError(diagnostics, "SET_ASSIGNMENT", "Assignment requires a string path", assignmentPath);
					continue;
				}
				validateStatePath(assignment.path, diagnostics, `${assignmentPath}.path`);
				const sourceCount = Number(assignment.value !== undefined) + Number(assignment.template !== undefined) + Number(assignment.from !== undefined);
				if (sourceCount !== 1) {
					pushError(diagnostics, "SET_ASSIGNMENT_SOURCE", "Assignment must define exactly one of value, template, or from", assignmentPath);
				}
				if (assignment.template !== undefined && typeof assignment.template !== "string") {
					pushError(diagnostics, "SET_TEMPLATE", "template must be a string", `${assignmentPath}.template`);
				}
				if (assignment.from !== undefined) {
					if (typeof assignment.from !== "string") pushError(diagnostics, "SET_FROM", "from must be a string", `${assignmentPath}.from`);
					else validateStatePath(assignment.from, diagnostics, `${assignmentPath}.from`);
				}
			}
		}
	}
	if (rawNode.type === "human") {
		if (typeof rawNode.prompt !== "string" || !rawNode.prompt.trim()) {
			pushError(diagnostics, "HUMAN_PROMPT", "Human node requires a non-empty prompt", `${path}.prompt`);
		}
		if (rawNode.kind !== undefined && (typeof rawNode.kind !== "string" || !KNOWN_HUMAN_KINDS.has(rawNode.kind))) {
			pushError(diagnostics, "HUMAN_KIND", "kind must be confirm, input, or select", `${path}.kind`);
		}
		if (rawNode.options !== undefined && !isStringArray(rawNode.options)) {
			pushError(diagnostics, "HUMAN_OPTIONS", "Human options must be an array of strings", `${path}.options`);
		}
		validateOptionalBoolean(rawNode, "pause", diagnostics, `${path}.pause`);
	}
}

function validateRawRetry(value: unknown, diagnostics: Diagnostic[], path: string): void {
	if (!isJsonObject(value)) {
		pushError(diagnostics, "RETRY", "retry must be an object", path);
		return;
	}
	validateRawNumber(value.maxAttempts, diagnostics, `${path}.maxAttempts`, { integer: true, positive: true });
	validateRawNumber(value.backoffMs, diagnostics, `${path}.backoffMs`, { nonNegative: true });
	validateRawNumber(value.backoffMultiplier, diagnostics, `${path}.backoffMultiplier`, { minimum: 1 });
}

function validateRawErrorPolicy(value: unknown, diagnostics: Diagnostic[], path: string): void {
	if (!isJsonObject(value)) {
		pushError(diagnostics, "ERROR_POLICY", "onError must be an object", path);
		return;
	}
	if (value.strategy !== undefined && (typeof value.strategy !== "string" || !KNOWN_ERROR_STRATEGIES.has(value.strategy))) {
		pushError(diagnostics, "ERROR_STRATEGY", "strategy must be fail, continue, or route", `${path}.strategy`);
	}
	if (value.to !== undefined) validateStringOrStringArray(value.to, diagnostics, `${path}.to`);
	validateOptionalString(value, "output", diagnostics, `${path}.output`);
	if (typeof value.output === "string") validateStatePath(value.output, diagnostics, `${path}.output`);
}

function validateRawResponse(value: unknown, diagnostics: Diagnostic[], path: string): void {
	if (!isJsonObject(value)) {
		pushError(diagnostics, "RESPONSE", "response must be an object", path);
		return;
	}
	if (value.format !== undefined && (typeof value.format !== "string" || !KNOWN_RESPONSE_FORMATS.has(value.format))) {
		pushError(diagnostics, "RESPONSE_FORMAT", "format must be text or json", `${path}.format`);
	}
	validateRawNumber(value.maxBytes, diagnostics, `${path}.maxBytes`, { integer: true, positive: true });
}

function validateRawAgentContext(value: unknown, diagnostics: Diagnostic[], path: string): void {
	if (!isJsonObject(value)) {
		pushError(diagnostics, "AGENT_CONTEXT", "context must be an object", path);
		return;
	}
	if (value.mode !== undefined && (typeof value.mode !== "string" || !KNOWN_CONTEXT_MODES.has(value.mode))) {
		pushError(diagnostics, "AGENT_CONTEXT_MODE", "context.mode must be isolated, thread, or shared", `${path}.mode`);
	}
	validateOptionalString(value, "threadKey", diagnostics, `${path}.threadKey`);
	validateOptionalString(value, "messagesPath", diagnostics, `${path}.messagesPath`);
	if (typeof value.messagesPath === "string") validateStatePath(value.messagesPath, diagnostics, `${path}.messagesPath`);
	validateRawNumber(value.maxMessages, diagnostics, `${path}.maxMessages`, { integer: true, positive: true });
	validateRawNumber(value.maxPromptBytes, diagnostics, `${path}.maxPromptBytes`, { integer: true, positive: true });
}

function validateRawLimits(value: unknown, diagnostics: Diagnostic[], path: string, graph: boolean): void {
	if (!isJsonObject(value)) {
		pushError(diagnostics, "LIMITS", "limits must be an object", path);
		return;
	}
	const integerFields = graph
		? ["maxSteps", "maxNodeRuns", "maxConcurrency", "maxTokens", "timeoutMs", "maxStateBytes"]
		: ["timeoutMs", "maxTurns", "maxTokens", "maxOutputBytes"];
	for (const field of integerFields) validateRawNumber(value[field], diagnostics, `${path}.${field}`, { integer: true, positive: true });
	validateRawNumber(value.maxCostUsd, diagnostics, `${path}.maxCostUsd`, { nonNegative: true });
}

function validateRawPolicy(value: unknown, diagnostics: Diagnostic[], path: string): void {
	if (!isJsonObject(value)) {
		pushError(diagnostics, "POLICY", "policy must be an object", path);
		return;
	}
	for (const field of ["allowNonInteractive", "allowNonInteractiveMutations", "confirmProjectGraph", "confirmMutatingNodes"] as const) {
		validateOptionalBoolean(value, field, diagnostics, `${path}.${field}`);
	}
}

interface RawNumberOptions {
	integer?: boolean;
	positive?: boolean;
	nonNegative?: boolean;
	minimum?: number;
}

function validateRawNumber(value: JsonObject[string] | undefined, diagnostics: Diagnostic[], path: string, options: RawNumberOptions): void {
	if (value === undefined) return;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		pushError(diagnostics, "NUMBER", "Expected a finite number", path);
		return;
	}
	if (options.integer && !Number.isInteger(value)) pushError(diagnostics, "INTEGER", "Expected an integer", path);
	if (options.positive && value <= 0) pushError(diagnostics, "POSITIVE", "Expected a positive number", path);
	if (options.nonNegative && value < 0) pushError(diagnostics, "NON_NEGATIVE", "Expected a non-negative number", path);
	if (options.minimum !== undefined && value < options.minimum) pushError(diagnostics, "MINIMUM", `Expected a value >= ${options.minimum}`, path);
}

function validateOptionalString(record: JsonObject, field: string, diagnostics: Diagnostic[], path: string): void {
	if (record[field] !== undefined && typeof record[field] !== "string") pushError(diagnostics, "STRING", "Expected a string", path);
}

function validateOptionalBoolean(record: JsonObject, field: string, diagnostics: Diagnostic[], path: string): void {
	if (record[field] !== undefined && typeof record[field] !== "boolean") pushError(diagnostics, "BOOLEAN", "Expected a boolean", path);
}

function validateRawEdges(rawEdges: unknown, diagnostics: Diagnostic[]): void {
	if (!Array.isArray(rawEdges)) {
		pushError(diagnostics, "EDGES", "edges must be an array", "edges");
		return;
	}
	for (const [index, edge] of rawEdges.entries()) {
		if (!isJsonObject(edge)) {
			pushError(diagnostics, "EDGE", "Edge must be an object", `edges.${index}`);
			continue;
		}
		validateStringOrStringArray(edge.from, diagnostics, `edges.${index}.from`);
		validateStringOrStringArray(edge.to, diagnostics, `edges.${index}.to`);
	}
}

function validateRawRoutes(rawRoutes: unknown, diagnostics: Diagnostic[]): void {
	if (!Array.isArray(rawRoutes)) {
		pushError(diagnostics, "ROUTES", "routes must be an array", "routes");
		return;
	}
	for (const [index, route] of rawRoutes.entries()) {
		if (!isJsonObject(route)) {
			pushError(diagnostics, "ROUTE", "Route must be an object", `routes.${index}`);
			continue;
		}
		if (typeof route.from !== "string") pushError(diagnostics, "ROUTE_FROM", "Route from must be a string", `routes.${index}.from`);
		if (!Array.isArray(route.cases)) pushError(diagnostics, "ROUTE_CASES", "Route cases must be an array", `routes.${index}.cases`);
		else {
			for (const [caseIndex, item] of route.cases.entries()) {
				if (!isJsonObject(item)) {
					pushError(diagnostics, "ROUTE_CASE", "Route case must be an object", `routes.${index}.cases.${caseIndex}`);
					continue;
				}
				if (!isJsonObject(item.when)) {
					pushError(diagnostics, "CONDITION", "Route condition must be an object", `routes.${index}.cases.${caseIndex}.when`);
				}
				validateStringOrStringArray(item.to, diagnostics, `routes.${index}.cases.${caseIndex}.to`);
			}
		}
		if (route.default !== undefined) validateStringOrStringArray(route.default, diagnostics, `routes.${index}.default`);
	}
}

function validateRawReducers(rawReducers: unknown, diagnostics: Diagnostic[]): void {
	if (!isJsonObject(rawReducers)) {
		pushError(diagnostics, "REDUCERS", "reducers must be an object", "reducers");
		return;
	}
	for (const [path, reducer] of Object.entries(rawReducers)) {
		if (typeof reducer !== "string" || !KNOWN_REDUCERS.has(reducer)) {
			pushError(diagnostics, "REDUCER", `Unknown reducer ${JSON.stringify(reducer)} at ${path}`, `reducers.${path}`);
		}
	}
}

function validateNode(nodeId: string, node: NodeDefinition, diagnostics: Diagnostic[], nodeSet: Set<string>): void {
	const path = `nodes.${nodeId}`;
	if (!nodeId.trim() || nodeId === END) pushError(diagnostics, "NODE_ID", `${JSON.stringify(nodeId)} is not a valid node id`, path);
	if (node.output !== undefined) validateStatePath(node.output, diagnostics, `${path}.output`);
	for (const [index, readPath] of (node.reads ?? []).entries()) validateStatePath(readPath, diagnostics, `${path}.reads.${index}`);
	validateRetry(node, diagnostics, path);
	validateNodeLimits(node, diagnostics, path);
	validateErrorPolicy(node, diagnostics, path, nodeSet);

	if (node.type === "agent") validateAgentNode(nodeId, node, diagnostics, path);
	else if (node.type === "set") validateSetNode(node, diagnostics, path);
	else validateHumanNode(node, diagnostics, path);
}

function validateAgentNode(nodeId: string, node: AgentNodeDefinition, diagnostics: Diagnostic[], path: string): void {
	if (!node.prompt.trim()) pushError(diagnostics, "AGENT_PROMPT", `Agent node ${nodeId} requires a prompt`, `${path}.prompt`);
	if (node.purpose === "reviewer" && node.readOnly !== true) {
		pushWarning(
			diagnostics,
			"REVIEWER_NOT_READ_ONLY",
			`Reviewer node ${nodeId} should set readOnly: true so verification cannot mutate the work it reviews.`,
			path,
		);
	}
	if (node.purpose === "reviewer" && (node.context?.mode ?? "isolated") !== "isolated") {
		pushWarning(
			diagnostics,
			"REVIEWER_CONTEXT_NOT_ISOLATED",
			`Reviewer node ${nodeId} uses ${node.context?.mode} context. Use isolated context when the reviewer must remain independent from upstream agent history.`,
			`${path}.context.mode`,
		);
	}
	if (node.readOnly === true && node.tools?.some((tool) => !READ_ONLY_TOOLS.has(tool))) {
		pushError(
			diagnostics,
			"READ_ONLY_TOOLS",
			`Node ${nodeId} is read-only but requests a mutating or unknown tool. Allowed tools: ${[...READ_ONLY_TOOLS].join(", ")}.`,
			`${path}.tools`,
		);
	}
	if (node.thinking !== undefined && !KNOWN_THINKING_LEVELS.has(node.thinking)) {
		pushError(diagnostics, "THINKING_LEVEL", `Unknown thinking level ${node.thinking}`, `${path}.thinking`);
	}
	if (node.response?.format !== undefined && node.response.format !== "text" && node.response.format !== "json") {
		pushError(diagnostics, "RESPONSE_FORMAT", "Agent response format must be text or json", `${path}.response.format`);
	}
	assertDiagnostic(() => assertPositiveInteger(node.response?.maxBytes, `${path}.response.maxBytes`), diagnostics, "RESPONSE_LIMIT", path);
	validateAgentContextPolicy(nodeId, node, diagnostics, path);
}

function validateAgentContextPolicy(
	nodeId: string,
	node: AgentNodeDefinition,
	diagnostics: Diagnostic[],
	path: string,
): void {
	const context = node.context;
	const mode = context?.mode ?? "isolated";
	if (!KNOWN_CONTEXT_MODES.has(mode)) {
		pushError(diagnostics, "AGENT_CONTEXT_MODE", `Unknown agent context mode ${mode}`, `${path}.context.mode`);
		return;
	}
	if (context?.threadKey !== undefined) {
		if (mode !== "thread") {
			pushError(diagnostics, "THREAD_KEY_MODE", "context.threadKey is only valid for thread mode", `${path}.context.threadKey`);
		}
		validateThreadKey(context.threadKey, diagnostics, `${path}.context.threadKey`);
	}
	if (mode === "thread") {
		validateThreadKey(context?.threadKey ?? nodeId, diagnostics, `${path}.context.threadKey`);
		if ((node.retry?.maxAttempts ?? 1) > 1) {
			pushWarning(
				diagnostics,
				"THREAD_RETRY_APPENDS_HISTORY",
				`Thread node ${nodeId} retries in the same Pi session; a failed attempt can leave duplicate prompts or partial history.`,
				path,
			);
		}
	}
	if (mode !== "shared") {
		for (const field of ["messagesPath", "maxMessages", "maxPromptBytes"] as const) {
			if (context?.[field] !== undefined) {
				pushError(diagnostics, "SHARED_CONTEXT_FIELD", `context.${field} is only valid for shared mode`, `${path}.context.${field}`);
			}
		}
	}
	if (mode === "shared") {
		const messagesPath = context?.messagesPath ?? "messages";
		validateStatePath(messagesPath, diagnostics, `${path}.context.messagesPath`);
		assertDiagnostic(() => assertPositiveInteger(context?.maxMessages, `${path}.context.maxMessages`), diagnostics, "AGENT_CONTEXT_LIMIT", path);
		assertDiagnostic(
			() => assertPositiveInteger(context?.maxPromptBytes, `${path}.context.maxPromptBytes`),
			diagnostics,
			"AGENT_CONTEXT_LIMIT",
			path,
		);
		const outputPath = node.output ?? `outputs.${nodeId}`;
		if (pathsOverlapForValidation(messagesPath, outputPath)) {
			pushError(
				diagnostics,
				"SHARED_OUTPUT_OVERLAP",
				`Shared messages path ${messagesPath} overlaps node output path ${outputPath}.`,
				path,
			);
		}
	}
}

function validateThreadKey(key: string, diagnostics: Diagnostic[], path: string): void {
	if (!key.trim()) {
		pushError(diagnostics, "THREAD_KEY", "threadKey must be non-empty", path);
		return;
	}
	if (key.length > 128 || /[\u0000-\u001f\u007f]/.test(key)) {
		pushError(diagnostics, "THREAD_KEY", "threadKey must be at most 128 characters and contain no control characters", path);
	}
	if (["__proto__", "prototype", "constructor"].includes(key)) {
		pushError(diagnostics, "THREAD_KEY", `${JSON.stringify(key)} is not an allowed threadKey`, path);
	}
}

function validateSetNode(node: SetNodeDefinition, diagnostics: Diagnostic[], path: string): void {
	if (!Array.isArray(node.assign) || node.assign.length === 0) {
		pushError(diagnostics, "SET_ASSIGN", "Set node requires at least one assignment", `${path}.assign`);
		return;
	}
	for (const [index, assignment] of node.assign.entries()) {
		validateStatePath(assignment.path, diagnostics, `${path}.assign.${index}.path`);
		const sourceCount = Number(assignment.value !== undefined) + Number(assignment.template !== undefined) + Number(assignment.from !== undefined);
		if (sourceCount !== 1) {
			pushError(
				diagnostics,
				"SET_ASSIGNMENT_SOURCE",
				"Assignment must define exactly one of value, template, or from",
				`${path}.assign.${index}`,
			);
		}
		if (assignment.from !== undefined) validateStatePath(assignment.from, diagnostics, `${path}.assign.${index}.from`);
	}
}

function validateHumanNode(node: HumanNodeDefinition, diagnostics: Diagnostic[], path: string): void {
	if (!node.prompt.trim()) pushError(diagnostics, "HUMAN_PROMPT", "Human node requires a prompt", `${path}.prompt`);
	const kind = node.kind ?? "input";
	if (!KNOWN_HUMAN_KINDS.has(kind)) pushError(diagnostics, "HUMAN_KIND", `Unknown human input kind ${kind}`, `${path}.kind`);
	if (kind === "select" && (!node.options || node.options.length === 0)) {
		pushError(diagnostics, "HUMAN_OPTIONS", "Select human node requires options", `${path}.options`);
	}
}

function validateRetry(node: NodeDefinition, diagnostics: Diagnostic[], path: string): void {
	const retry = node.retry;
	if (!retry) return;
	assertDiagnostic(() => assertPositiveInteger(retry.maxAttempts, `${path}.retry.maxAttempts`), diagnostics, "RETRY", path);
	assertDiagnostic(() => assertNonNegativeNumber(retry.backoffMs, `${path}.retry.backoffMs`), diagnostics, "RETRY", path);
	assertDiagnostic(() => assertNonNegativeNumber(retry.backoffMultiplier, `${path}.retry.backoffMultiplier`), diagnostics, "RETRY", path);
	if (retry.backoffMultiplier !== undefined && retry.backoffMultiplier < 1) {
		pushError(diagnostics, "RETRY", `${path}.retry.backoffMultiplier must be at least 1`, `${path}.retry.backoffMultiplier`);
	}
	if ((retry.maxAttempts ?? 1) > 1 && node.idempotent !== true) {
		pushWarning(
			diagnostics,
			"RETRY_REQUIRES_IDEMPOTENCY",
			`${path} retries but does not declare idempotent: true. A crash or resume can re-run side effects.`,
			path,
		);
	}
}

function validateNodeLimits(node: NodeDefinition, diagnostics: Diagnostic[], path: string): void {
	const limits = node.limits;
	if (!limits) return;
	assertDiagnostic(() => assertPositiveInteger(limits.timeoutMs, `${path}.limits.timeoutMs`), diagnostics, "NODE_LIMIT", path);
	assertDiagnostic(() => assertPositiveInteger(limits.maxTurns, `${path}.limits.maxTurns`), diagnostics, "NODE_LIMIT", path);
	assertDiagnostic(() => assertPositiveInteger(limits.maxTokens, `${path}.limits.maxTokens`), diagnostics, "NODE_LIMIT", path);
	assertDiagnostic(() => assertNonNegativeNumber(limits.maxCostUsd, `${path}.limits.maxCostUsd`), diagnostics, "NODE_LIMIT", path);
	assertDiagnostic(() => assertPositiveInteger(limits.maxOutputBytes, `${path}.limits.maxOutputBytes`), diagnostics, "NODE_LIMIT", path);
}

function validateErrorPolicy(node: NodeDefinition, diagnostics: Diagnostic[], path: string, nodeSet: Set<string>): void {
	const policy = node.onError;
	if (!policy) return;
	const strategy = policy.strategy ?? "fail";
	if (!KNOWN_ERROR_STRATEGIES.has(strategy)) pushError(diagnostics, "ERROR_STRATEGY", `Unknown onError strategy ${strategy}`, `${path}.onError.strategy`);
	if (strategy === "route" && policy.to === undefined) {
		pushError(diagnostics, "ERROR_ROUTE", "onError route strategy requires to", `${path}.onError.to`);
	}
	for (const target of policy.to === undefined ? [] : asStringArray(policy.to)) {
		validateTarget(target, nodeSet, diagnostics, `${path}.onError.to`);
	}
	if (policy.output !== undefined) validateStatePath(policy.output, diagnostics, `${path}.onError.output`);
}

function validateEdge(edge: EdgeDefinition, index: number, nodeSet: Set<string>, diagnostics: Diagnostic[]): void {
	const from = uniqueStrings(asStringArray(edge.from));
	const to = uniqueStrings(asStringArray(edge.to));
	if (from.length === 0) pushError(diagnostics, "EDGE_FROM", "Edge must have a source", `edges.${index}.from`);
	if (to.length === 0) pushError(diagnostics, "EDGE_TO", "Edge must have a destination", `edges.${index}.to`);
	for (const source of from) {
		if (!nodeSet.has(source)) pushError(diagnostics, "EDGE_SOURCE", `Unknown edge source ${source}`, `edges.${index}.from`);
	}
	for (const target of to) validateTarget(target, nodeSet, diagnostics, `edges.${index}.to`);
}

function validateRoute(route: RouteDefinition, index: number, nodeSet: Set<string>, diagnostics: Diagnostic[]): void {
	if (!nodeSet.has(route.from)) pushError(diagnostics, "ROUTE_SOURCE", `Unknown route source ${route.from}`, `routes.${index}.from`);
	if (!Array.isArray(route.cases) || route.cases.length === 0) {
		pushError(diagnostics, "ROUTE_CASES", "Route must define at least one case", `routes.${index}.cases`);
	}
	for (const [caseIndex, item] of route.cases.entries()) {
		validateCondition(item.when, diagnostics, `routes.${index}.cases.${caseIndex}.when`);
		for (const target of asStringArray(item.to)) validateTarget(target, nodeSet, diagnostics, `routes.${index}.cases.${caseIndex}.to`);
	}
	for (const target of route.default === undefined ? [] : asStringArray(route.default)) {
		validateTarget(target, nodeSet, diagnostics, `routes.${index}.default`);
	}
}

function validateCondition(condition: Condition, diagnostics: Diagnostic[], path: string): void {
	if ("all" in condition) {
		if (!Array.isArray(condition.all) || condition.all.length === 0) pushError(diagnostics, "CONDITION_ALL", "all must be non-empty", path);
		else condition.all.forEach((item, index) => validateCondition(item, diagnostics, `${path}.all.${index}`));
		return;
	}
	if ("any" in condition) {
		if (!Array.isArray(condition.any) || condition.any.length === 0) pushError(diagnostics, "CONDITION_ANY", "any must be non-empty", path);
		else condition.any.forEach((item, index) => validateCondition(item, diagnostics, `${path}.any.${index}`));
		return;
	}
	if ("not" in condition) {
		validateCondition(condition.not, diagnostics, `${path}.not`);
		return;
	}
	validateStatePath(condition.path, diagnostics, `${path}.path`);
	if (!KNOWN_OPERATORS.has(condition.op)) pushError(diagnostics, "CONDITION_OPERATOR", `Unknown operator ${condition.op}`, `${path}.op`);
	if (!["exists", "truthy"].includes(condition.op) && condition.value === undefined) {
		pushError(diagnostics, "CONDITION_VALUE", `Operator ${condition.op} requires value`, `${path}.value`);
	}
}

function validateLimits(definition: GraphDefinition, diagnostics: Diagnostic[]): void {
	const limits = definition.limits;
	if (!limits) {
		pushWarning(
			diagnostics,
			"DEFAULT_LIMITS",
			"No limits configured. pi-graph will apply conservative hard defaults; set explicit limits for production graphs.",
			"limits",
		);
		return;
	}
	assertDiagnostic(() => assertPositiveInteger(limits.maxSteps, "limits.maxSteps"), diagnostics, "GRAPH_LIMIT", "limits.maxSteps");
	assertDiagnostic(() => assertPositiveInteger(limits.maxNodeRuns, "limits.maxNodeRuns"), diagnostics, "GRAPH_LIMIT", "limits.maxNodeRuns");
	assertDiagnostic(() => assertPositiveInteger(limits.maxConcurrency, "limits.maxConcurrency"), diagnostics, "GRAPH_LIMIT", "limits.maxConcurrency");
	assertDiagnostic(() => assertNonNegativeNumber(limits.maxCostUsd, "limits.maxCostUsd"), diagnostics, "GRAPH_LIMIT", "limits.maxCostUsd");
	assertDiagnostic(() => assertPositiveInteger(limits.maxTokens, "limits.maxTokens"), diagnostics, "GRAPH_LIMIT", "limits.maxTokens");
	assertDiagnostic(() => assertPositiveInteger(limits.timeoutMs, "limits.timeoutMs"), diagnostics, "GRAPH_LIMIT", "limits.timeoutMs");
	assertDiagnostic(() => assertPositiveInteger(limits.maxStateBytes, "limits.maxStateBytes"), diagnostics, "GRAPH_LIMIT", "limits.maxStateBytes");
}

function validateGraphPolicy(definition: GraphDefinition, diagnostics: Diagnostic[]): void {
	const policy = definition.policy;
	if (!policy) return;
	for (const [field, value] of Object.entries(policy)) {
		if (typeof value !== "boolean") pushError(diagnostics, "POLICY", `policy.${field} must be boolean`, `policy.${field}`);
	}
}

function validateReachability(definition: GraphDefinition, diagnostics: Diagnostic[]): void {
	const adjacency = new Map<string, Set<string>>();
	for (const nodeId of Object.keys(definition.nodes)) adjacency.set(nodeId, new Set());
	for (const edge of definition.edges ?? []) {
		for (const source of asStringArray(edge.from)) {
			const destinations = adjacency.get(source);
			if (!destinations) continue;
			for (const target of asStringArray(edge.to)) if (target !== END) destinations.add(target);
		}
	}
	for (const route of definition.routes ?? []) {
		const destinations = adjacency.get(route.from);
		if (!destinations) continue;
		for (const routeCase of route.cases) for (const target of asStringArray(routeCase.to)) if (target !== END) destinations.add(target);
		for (const target of route.default === undefined ? [] : asStringArray(route.default)) if (target !== END) destinations.add(target);
	}
	for (const [nodeId, node] of Object.entries(definition.nodes)) {
		if (node.onError?.to !== undefined) {
			for (const target of asStringArray(node.onError.to)) if (target !== END) adjacency.get(nodeId)?.add(target);
		}
	}
	const reached = new Set<string>();
	const queue = asStringArray(definition.entry).filter((item) => item !== END);
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || reached.has(current)) continue;
		reached.add(current);
		for (const next of adjacency.get(current) ?? []) if (!reached.has(next)) queue.push(next);
	}
	for (const nodeId of Object.keys(definition.nodes)) {
		if (!reached.has(nodeId)) pushWarning(diagnostics, "UNREACHABLE_NODE", `Node ${nodeId} is unreachable from entry`, `nodes.${nodeId}`);
	}
}

function validateAgentContexts(definition: GraphDefinition, diagnostics: Diagnostic[]): void {
	for (const [nodeId, node] of Object.entries(definition.nodes)) {
		if (node.type !== "agent" || (node.context?.mode ?? "isolated") !== "shared") continue;
		const messagesPath = node.context?.messagesPath ?? "messages";
		const reducer = definition.reducers?.[messagesPath];
		if (reducer !== undefined && reducer !== "concat") {
			pushError(
				diagnostics,
				"SHARED_MESSAGES_REDUCER",
				`Shared message channel ${messagesPath} requires the concat reducer, not ${reducer}.`,
				`reducers.${messagesPath}`,
			);
		}
	}
}

function validateThreadContextCompatibility(definition: GraphDefinition, diagnostics: Diagnostic[]): void {
	const threads = new Map<string, { cwd: string; nodes: string[] }>();
	for (const [nodeId, node] of Object.entries(definition.nodes)) {
		if (node.type !== "agent" || (node.context?.mode ?? "isolated") !== "thread") continue;
		const key = node.context?.threadKey ?? nodeId;
		const cwd = normalizeThreadCwd(node.cwd);
		const existing = threads.get(key);
		if (!existing) {
			threads.set(key, { cwd, nodes: [nodeId] });
			continue;
		}
		existing.nodes.push(nodeId);
		if (existing.cwd !== cwd) {
			pushError(
				diagnostics,
				"THREAD_CWD_MISMATCH",
				`Thread context ${JSON.stringify(key)} is shared by nodes with different cwd values (${existing.cwd} and ${cwd}). A Pi session has one durable working directory.`,
				`nodes.${nodeId}.cwd`,
			);
		}
	}
}

function normalizeThreadCwd(cwd: string | undefined): string {
	return pathPosix.normalize((cwd?.trim() || ".").replaceAll("\\", "/"));
}

function resolveEffectiveReducers(definition: GraphDefinition): Record<string, ReducerName> {
	const reducers = { ...(definition.reducers ?? {}) };
	for (const node of Object.values(definition.nodes)) {
		if (node.type !== "agent" || (node.context?.mode ?? "isolated") !== "shared") continue;
		const messagesPath = node.context?.messagesPath ?? "messages";
		reducers[messagesPath] ??= "concat";
	}
	return reducers;
}

function validateParallelThreadContexts(definition: GraphDefinition, diagnostics: Diagnostic[]): void {
	for (const group of collectFanOutGroups(definition)) {
		const byKey = new Map<string, string[]>();
		for (const nodeId of group) {
			const node = definition.nodes[nodeId];
			if (!node || node.type !== "agent" || (node.context?.mode ?? "isolated") !== "thread") continue;
			const key = node.context?.threadKey ?? nodeId;
			const nodes = byKey.get(key) ?? [];
			nodes.push(nodeId);
			byKey.set(key, nodes);
		}
		for (const [key, nodes] of byKey) {
			if (nodes.length > 1) {
				pushError(
					diagnostics,
					"PARALLEL_THREAD_CONTEXT",
					`Parallel nodes ${nodes.join(", ")} share threadKey ${JSON.stringify(key)}. A persistent Pi session cannot be used concurrently.`,
					"nodes",
				);
			}
		}
	}
}

function collectFanOutGroups(definition: GraphDefinition): string[][] {
	const groups: string[][] = [];
	const entry = asStringArray(definition.entry).filter((item) => item !== END);
	if (entry.length > 1) groups.push(entry);
	for (const edge of definition.edges ?? []) {
		const targets = asStringArray(edge.to).filter((item) => item !== END);
		if (targets.length > 1) groups.push(targets);
	}
	for (const route of definition.routes ?? []) {
		for (const routeCase of route.cases) {
			const targets = asStringArray(routeCase.to).filter((item) => item !== END);
			if (targets.length > 1) groups.push(targets);
		}
	}
	return groups;
}

function validateParallelWrites(definition: GraphDefinition, diagnostics: Diagnostic[]): void {
	const reducers = resolveEffectiveReducers(definition);
	for (const group of collectFanOutGroups(definition)) {
		const paths = new Map<string, string[]>();
		for (const nodeId of group) {
			const node = definition.nodes[nodeId];
			if (!node) continue;
			for (const path of directWritePaths(nodeId, node)) {
				const writers = paths.get(path) ?? [];
				writers.push(nodeId);
				paths.set(path, writers);
			}
		}
		for (const [path, writers] of paths) {
			if (writers.length > 1 && reducers[path] === undefined) {
				pushWarning(
					diagnostics,
					"POSSIBLE_PARALLEL_STATE_CONFLICT",
					`Parallel nodes ${writers.join(", ")} may write ${path}. Add a reducer or use distinct output paths.`,
					`reducers.${path}`,
				);
			}
		}
	}
}

function directWritePaths(nodeId: string, node: NodeDefinition): string[] {
	if (node.type === "set") return node.assign.map((assignment) => assignment.path);
	const paths = [node.output ?? `outputs.${nodeId}`];
	if (node.type === "agent" && (node.context?.mode ?? "isolated") === "shared") {
		paths.push(node.context?.messagesPath ?? "messages");
	}
	return paths;
}

function pathsOverlapForValidation(leftPath: string, rightPath: string): boolean {
	try {
		return pathsOverlap(leftPath, rightPath);
	} catch {
		// The dedicated path validator already reports malformed paths.
		return false;
	}
}

function pathsOverlap(leftPath: string, rightPath: string): boolean {
	const left = normalizePath(leftPath);
	const right = normalizePath(rightPath);
	const shorter = left.length <= right.length ? left : right;
	const longer = shorter === left ? right : left;
	return shorter.every((segment, index) => longer[index] === segment);
}

function validateTarget(target: string, nodeSet: Set<string>, diagnostics: Diagnostic[], path: string): void {
	if (target !== END && !nodeSet.has(target)) pushError(diagnostics, "UNKNOWN_TARGET", `Unknown target ${target}`, path);
}

function validateStatePath(path: string, diagnostics: Diagnostic[], diagnosticPath: string): void {
	try {
		normalizePath(path);
	} catch (error) {
		pushError(diagnostics, "STATE_PATH", String(error), diagnosticPath);
	}
}

function validateStringOrStringArray(value: unknown, diagnostics: Diagnostic[], path: string): void {
	if (typeof value === "string" && value.trim()) return;
	if (isStringArray(value) && value.length > 0 && value.every((item) => item.trim())) return;
	pushError(diagnostics, "STRING_OR_ARRAY", "Expected a non-empty string or non-empty string array", path);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function assertDiagnostic(action: () => void, diagnostics: Diagnostic[], code: string, path: string): void {
	try {
		action();
	} catch (error) {
		pushError(diagnostics, code, String(error), path);
	}
}

function pushError(diagnostics: Diagnostic[], code: string, message: string, path?: string): void {
	diagnostics.push({ level: "error", code, message, path });
}

function pushWarning(diagnostics: Diagnostic[], code: string, message: string, path?: string): void {
	diagnostics.push({ level: "warning", code, message, path });
}

export function graphUsesMutatingTools(definition: GraphDefinition): boolean {
	for (const node of Object.values(definition.nodes)) {
		if (node.type !== "agent") continue;
		if (node.loadExtensions === true) return true;
		if (node.readOnly === true) continue;
		const tools = node.tools ?? ["read", "bash", "edit", "write"];
		if (tools.some((tool) => !READ_ONLY_TOOLS.has(tool))) return true;
	}
	return false;
}

export function graphSummary(definition: GraphDefinition): JsonObject {
	const nodeTypes: JsonObject = {};
	for (const [nodeId, node] of Object.entries(definition.nodes)) nodeTypes[nodeId] = node.type;
	return {
		name: definition.name,
		description: definition.description ?? "",
		nodes: nodeTypes,
		entry: toJsonValue(definition.entry),
		edges: definition.edges?.length ?? 0,
		routes: definition.routes?.length ?? 0,
	};
}
