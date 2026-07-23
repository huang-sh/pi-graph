import { Type, type TProperties, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { Diagnostic, JsonObject } from "./types.ts";
import { normalizePath } from "./utils.ts";

function exactObject<const Properties extends TProperties>(properties: Properties) {
	return Type.Object(properties, { additionalProperties: false });
}

const NonEmptyStringSchema = Type.Refine(
	Type.String(),
	(value) => value.trim().length > 0,
	() => "must be a non-empty string",
);
const StringOrStringArraySchema = Type.Union([NonEmptyStringSchema, Type.Array(NonEmptyStringSchema, { minItems: 1 })]);

const StatePathSchema = Type.Refine(
	NonEmptyStringSchema,
	(value) => isStatePath(value),
	(value) => `STATE_PATH: ${statePathError(value)}`,
);
const NodeIdSchema = Type.Refine(
	NonEmptyStringSchema,
	(value) => value !== "__end__" && !["__proto__", "prototype", "constructor"].includes(value),
	(value) => `NODE_ID: ${JSON.stringify(value)} is not a valid node id`,
);

const PositiveIntegerSchema = Type.Integer({ minimum: 1 });
const NonNegativeNumberSchema = Type.Number({ minimum: 0 });

const ReducerSchema = Type.Enum(["replace", "append", "collect", "concat", "merge", "sum", "min", "max"] as const);
const PurposeSchema = Type.Literal("reviewer");
const ThinkingSchema = Type.Enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
const ErrorStrategySchema = Type.Enum(["fail", "continue", "route"] as const);
const HumanKindSchema = Type.Enum(["confirm", "input", "select"] as const);
const ResponseFormatSchema = Type.Enum(["text", "json"] as const);
const ContextModeSchema = Type.Enum(["isolated", "thread", "shared"] as const);
const CaptureModeSchema = Type.Enum(["none", "assistant-only", "compact", "full"] as const);
const OutputStorageSchema = Type.Enum(["state", "artifact"] as const);
const WriteModeSchema = Type.Enum(["reduce", "overwrite", "unset"] as const);
const ConditionOperatorSchema = Type.Enum(["eq", "ne", "gt", "gte", "lt", "lte", "exists", "includes", "matches", "truthy"] as const);

const RetrySchema = exactObject({
	maxAttempts: Type.Optional(PositiveIntegerSchema),
	backoffMs: Type.Optional(NonNegativeNumberSchema),
	backoffMultiplier: Type.Optional(Type.Number({ minimum: 1 })),
});

const ErrorPolicySchema = Type.Refine(
	exactObject({
		strategy: Type.Optional(ErrorStrategySchema),
		to: Type.Optional(StringOrStringArraySchema),
		output: Type.Optional(StatePathSchema),
	}),
	(policy) => (policy.strategy === "route" ? policy.to !== undefined : policy.to === undefined),
	(policy) =>
		policy.strategy === "route"
			? "ERROR_ROUTE: onError route strategy requires to"
			: "ERROR_ROUTE: onError.to is only valid with strategy route",
);

const ResponseSchema = exactObject({
	format: Type.Optional(ResponseFormatSchema),
	maxBytes: Type.Optional(PositiveIntegerSchema),
	storeOutput: Type.Optional(Type.Boolean()),
	storage: Type.Optional(OutputStorageSchema),
	mediaType: Type.Optional(Type.String()),
	previewBytes: Type.Optional(PositiveIntegerSchema),
});

const ContextSchema = exactObject({
	mode: Type.Optional(ContextModeSchema),
	threadKey: Type.Optional(Type.String()),
	messagesPath: Type.Optional(StatePathSchema),
	maxMessages: Type.Optional(PositiveIntegerSchema),
	maxPromptBytes: Type.Optional(PositiveIntegerSchema),
	maxMessageBytes: Type.Optional(PositiveIntegerSchema),
	maxStoredMessages: Type.Optional(PositiveIntegerSchema),
	capture: Type.Optional(CaptureModeSchema),
});

const NodeLimitsSchema = exactObject({
	timeoutMs: Type.Optional(PositiveIntegerSchema),
	maxTurns: Type.Optional(PositiveIntegerSchema),
	maxTokens: Type.Optional(PositiveIntegerSchema),
	maxCostUsd: Type.Optional(NonNegativeNumberSchema),
	maxPromptBytes: Type.Optional(PositiveIntegerSchema),
});

const BaseNodeProperties = {
	description: Type.Optional(Type.String()),
	reads: Type.Optional(Type.Array(StatePathSchema)),
	output: Type.Optional(StatePathSchema),
	retry: Type.Optional(RetrySchema),
	onError: Type.Optional(ErrorPolicySchema),
	limits: Type.Optional(NodeLimitsSchema),
	idempotent: Type.Optional(Type.Boolean()),
};

const AssignmentSchema = Type.Refine(
	exactObject({
		path: StatePathSchema,
		value: Type.Optional(Type.Unknown()),
		template: Type.Optional(Type.String()),
		from: Type.Optional(StatePathSchema),
		mode: Type.Optional(WriteModeSchema),
	}),
	(assignment) => {
		const sourceCount =
			Number(assignment.value !== undefined) + Number(assignment.template !== undefined) + Number(assignment.from !== undefined);
		return assignment.mode === "unset" ? sourceCount === 0 : sourceCount === 1;
	},
	(assignment) =>
		assignment.mode === "unset"
			? "SET_ASSIGNMENT_SOURCE: Unset assignment must not define value, template, or from"
			: "SET_ASSIGNMENT_SOURCE: Assignment must define exactly one of value, template, or from",
);

const AgentNodeSchema = exactObject({
	...BaseNodeProperties,
	type: Type.Literal("agent"),
	purpose: Type.Optional(PurposeSchema),
	prompt: NonEmptyStringSchema,
	systemPrompt: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(ThinkingSchema),
	tools: Type.Optional(Type.Array(Type.String())),
	readOnly: Type.Optional(Type.Boolean()),
	cwd: Type.Optional(Type.String()),
	loadExtensions: Type.Optional(Type.Boolean()),
	loadSkills: Type.Optional(Type.Boolean()),
	loadPromptTemplates: Type.Optional(Type.Boolean()),
	includeContextFiles: Type.Optional(Type.Boolean()),
	context: Type.Optional(ContextSchema),
	response: Type.Optional(ResponseSchema),
});

const SetNodeSchema = exactObject({
	...BaseNodeProperties,
	type: Type.Literal("set"),
	assign: Type.Array(AssignmentSchema, { minItems: 1 }),
});

const HumanNodeSchema = exactObject({
	...BaseNodeProperties,
	type: Type.Literal("human"),
	kind: Type.Optional(HumanKindSchema),
	prompt: NonEmptyStringSchema,
	options: Type.Optional(Type.Array(Type.String())),
	pause: Type.Optional(Type.Boolean()),
});

const UnknownNodeSchema = exactObject({
	...BaseNodeProperties,
	type: Type.Enum(["agent", "set", "human"] as const),
	prompt: Type.Optional(Type.String()),
	systemPrompt: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(ThinkingSchema),
	tools: Type.Optional(Type.Array(Type.String())),
	readOnly: Type.Optional(Type.Boolean()),
	cwd: Type.Optional(Type.String()),
	loadExtensions: Type.Optional(Type.Boolean()),
	loadSkills: Type.Optional(Type.Boolean()),
	loadPromptTemplates: Type.Optional(Type.Boolean()),
	includeContextFiles: Type.Optional(Type.Boolean()),
	context: Type.Optional(ContextSchema),
	response: Type.Optional(ResponseSchema),
	assign: Type.Optional(Type.Array(AssignmentSchema)),
	kind: Type.Optional(HumanKindSchema),
	options: Type.Optional(Type.Array(Type.String())),
	pause: Type.Optional(Type.Boolean()),
});

const ConditionSchema = Type.Cyclic(
	{
		Condition: Type.Refine(
			exactObject({
				all: Type.Optional(Type.Array(Type.Ref("Condition"), { minItems: 1 })),
				any: Type.Optional(Type.Array(Type.Ref("Condition"), { minItems: 1 })),
				not: Type.Optional(Type.Ref("Condition")),
				path: Type.Optional(StatePathSchema),
				op: Type.Optional(ConditionOperatorSchema),
				value: Type.Optional(Type.Unknown()),
			}),
			(condition) => {
				const compoundCount = Number(condition.all !== undefined) + Number(condition.any !== undefined) + Number(condition.not !== undefined);
				if (compoundCount > 0) {
					return compoundCount === 1 && condition.path === undefined && condition.op === undefined && condition.value === undefined;
				}
				return condition.path !== undefined && condition.op !== undefined;
			},
			() => "CONDITION: Condition must define exactly one of all, any, not, or path/op",
		),
	},
	"Condition",
);

const EdgeSchema = exactObject({
	from: StringOrStringArraySchema,
	to: StringOrStringArraySchema,
});

const RouteCaseSchema = exactObject({
	when: ConditionSchema,
	to: StringOrStringArraySchema,
});

const RouteSchema = exactObject({
	from: NonEmptyStringSchema,
	cases: Type.Array(RouteCaseSchema, { minItems: 1 }),
	default: Type.Optional(StringOrStringArraySchema),
});

const GraphLimitsSchema = exactObject({
	maxSteps: Type.Optional(PositiveIntegerSchema),
	maxNodeRuns: Type.Optional(PositiveIntegerSchema),
	maxConcurrency: Type.Optional(PositiveIntegerSchema),
	maxCostUsd: Type.Optional(NonNegativeNumberSchema),
	maxTokens: Type.Optional(PositiveIntegerSchema),
	timeoutMs: Type.Optional(PositiveIntegerSchema),
	maxStateBytes: Type.Optional(PositiveIntegerSchema),
	maxPromptBytes: Type.Optional(PositiveIntegerSchema),
});

const StatePathPolicySchema = exactObject({ maxBytes: Type.Optional(PositiveIntegerSchema) });
const StatePolicySchema = exactObject({
	paths: Type.Optional(
		Type.Record(Type.String(), StatePathPolicySchema, {
			additionalProperties: false,
			propertyNames: StatePathSchema,
		}),
	),
});

const GraphPolicySchema = exactObject({
	allowNonInteractive: Type.Optional(Type.Boolean()),
	allowNonInteractiveMutations: Type.Optional(Type.Boolean()),
	confirmProjectGraph: Type.Optional(Type.Boolean()),
	confirmMutatingNodes: Type.Optional(Type.Boolean()),
});

const ResultPolicySchema = exactObject({
	paths: Type.Optional(Type.Array(StatePathSchema)),
	includeState: Type.Optional(Type.Boolean()),
	maxBytes: Type.Optional(PositiveIntegerSchema),
});

const GraphStructureSchema = exactObject({
	schemaVersion: Type.Literal(2),
	name: NonEmptyStringSchema,
	description: Type.Optional(Type.String()),
	entry: StringOrStringArraySchema,
	initialState: Type.Optional(Type.Object({}, { additionalProperties: true })),
	nodes: Type.Record(Type.String(), Type.Unknown(), {
		additionalProperties: false,
		propertyNames: NodeIdSchema,
	}),
	edges: Type.Optional(Type.Array(EdgeSchema)),
	routes: Type.Optional(Type.Array(RouteSchema)),
	reducers: Type.Optional(
		Type.Record(Type.String(), ReducerSchema, {
			additionalProperties: false,
			propertyNames: StatePathSchema,
		}),
	),
	limits: Type.Optional(GraphLimitsSchema),
	statePolicy: Type.Optional(StatePolicySchema),
	policy: Type.Optional(GraphPolicySchema),
	result: Type.Optional(ResultPolicySchema),
});

export function validateGraphStructure(value: JsonObject): Diagnostic[] {
	const diagnostics = schemaDiagnostics(GraphStructureSchema, value);
	if (isRecord(value.nodes)) {
		for (const [nodeId, node] of Object.entries(value.nodes)) {
			diagnostics.push(...schemaDiagnostics(schemaForNode(node), node, `nodes.${nodeId}`));
		}
	}
	return uniqueDiagnostics(diagnostics);
}

function schemaForNode(value: unknown): TSchema {
	if (!isRecord(value)) return UnknownNodeSchema;
	if (value.type === "agent") return AgentNodeSchema;
	if (value.type === "set") return SetNodeSchema;
	if (value.type === "human") return HumanNodeSchema;
	return UnknownNodeSchema;
}

function schemaDiagnostics(schema: TSchema, value: unknown, prefix = ""): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const error of Value.Errors(schema, value)) {
		const basePath = joinDiagnosticPath(prefix, pointerPath(error.instancePath));
		if (error.keyword === "additionalProperties") {
			for (const field of error.params.additionalProperties) {
				const path = joinDiagnosticPath(basePath, field);
				diagnostics.push({ level: "error", code: "UNKNOWN_FIELD", message: `Unknown field ${path}`, path });
			}
			continue;
		}
		if (error.keyword === "required") {
			for (const field of error.params.requiredProperties) {
				const path = joinDiagnosticPath(basePath, field);
				diagnostics.push({ level: "error", code: structureCode(path), message: `Missing required field ${path}`, path });
			}
			continue;
		}
		const refinement = /^([A-Z][A-Z0-9_]+):\s*(.*)$/.exec(error.message);
		diagnostics.push({
			level: "error",
			code: refinement?.[1] ?? structureCode(basePath),
			message: refinement?.[2] ?? error.message,
			path: basePath || undefined,
		});
	}
	return diagnostics;
}

function structureCode(path: string): string {
	if (path === "schemaVersion") return "SCHEMA_VERSION";
	if (path === "name") return "GRAPH_NAME";
	if (path.startsWith("nodes.") && path.endsWith(".type")) return "NODE_TYPE";
	return "GRAPH_STRUCTURE";
}

function pointerPath(pointer: string): string {
	return pointer.split("/").slice(1).join(".");
}

function joinDiagnosticPath(...parts: Array<string | number>): string {
	return parts.filter((part) => String(part).length > 0).join(".");
}

function uniqueDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
	const seen = new Set<string>();
	return diagnostics.filter((diagnostic) => {
		const key = `${diagnostic.code}\u0000${diagnostic.path ?? ""}\u0000${diagnostic.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function isStatePath(value: string): boolean {
	try {
		normalizePath(value);
		return true;
	} catch {
		return false;
	}
}

function statePathError(value: string): string {
	try {
		normalizePath(value);
		return "Invalid state path";
	} catch (error) {
		return String(error);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
