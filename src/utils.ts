import { createHash } from "node:crypto";
import type { JsonObject, JsonValue, ReducerName, StateWrite, UsageLedger } from "./types.ts";

const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export function emptyUsage(): UsageLedger {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		turns: 0,
		costUsd: 0,
	};
}

export function addUsage(target: UsageLedger, delta: Partial<UsageLedger>): void {
	target.inputTokens += finiteNumber(delta.inputTokens);
	target.outputTokens += finiteNumber(delta.outputTokens);
	target.cacheReadTokens += finiteNumber(delta.cacheReadTokens);
	target.cacheWriteTokens += finiteNumber(delta.cacheWriteTokens);
	target.turns += finiteNumber(delta.turns);
	target.costUsd += finiteNumber(delta.costUsd);
}

export function usageTokens(usage: UsageLedger): number {
	return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

function finiteNumber(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toJsonValue(value: unknown, path = "$", seen = new Set<object>()): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${path} must contain finite numbers`);
		return value;
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) throw new Error(`${path} contains a circular reference`);
		seen.add(value);
		const result = value.map((item, index) => toJsonValue(item, `${path}[${index}]`, seen));
		seen.delete(value);
		return result;
	}
	if (typeof value === "object" && value !== null) {
		if (seen.has(value)) throw new Error(`${path} contains a circular reference`);
		seen.add(value);
		const result: JsonObject = {};
		for (const [key, item] of Object.entries(value)) {
			if (FORBIDDEN_PATH_SEGMENTS.has(key)) throw new Error(`${path}.${key} is not allowed`);
			if (item === undefined) continue;
			result[key] = toJsonValue(item, `${path}.${key}`, seen);
		}
		seen.delete(value);
		return result;
	}
	throw new Error(`${path} contains unsupported value type ${typeof value}`);
}

export function deepCloneJson<T extends JsonValue>(value: T): T {
	return structuredClone(value);
}

export function stableStringify(value: JsonValue): string {
	return JSON.stringify(sortJson(value));
}

function sortJson(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(sortJson);
	if (!isJsonObject(value)) return value;
	const sorted: JsonObject = {};
	for (const key of Object.keys(value).sort()) sorted[key] = sortJson(value[key]);
	return sorted;
}

export function hashJson(value: JsonValue): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function parseJsonObject(text: string, label: string): JsonObject {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`);
	}
	const normalized = toJsonValue(parsed, label);
	if (!isJsonObject(normalized)) throw new Error(`${label} must be a JSON object`);
	return normalized;
}

export function parseJsonValue(text: string, label: string): JsonValue {
	try {
		return toJsonValue(JSON.parse(text), label);
	} catch (error) {
		throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`);
	}
}

export function parseJsonOrText(text: string): JsonValue {
	const trimmed = text.trim();
	if (!trimmed) return "";
	try {
		return toJsonValue(JSON.parse(trimmed));
	} catch {
		return text;
	}
}

export function parseModelJson(text: string): JsonValue {
	const trimmed = text.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
	const candidate = fenced?.[1] ?? trimmed;
	try {
		return toJsonValue(JSON.parse(candidate), "model response");
	} catch (error) {
		throw new Error(`Agent response is not valid JSON: ${errorMessage(error)}`);
	}
}

export function normalizePath(path: string): string[] {
	const trimmed = path.trim();
	if (!trimmed) throw new Error("State path cannot be empty");
	const segments = trimmed.split(".").map((segment) => segment.trim());
	for (const segment of segments) {
		if (!segment) throw new Error(`State path ${JSON.stringify(path)} contains an empty segment`);
		if (FORBIDDEN_PATH_SEGMENTS.has(segment)) throw new Error(`State path segment ${JSON.stringify(segment)} is not allowed`);
	}
	return segments;
}

export function getPath(root: JsonObject, path: string): JsonValue | undefined {
	const segments = normalizePath(path);
	let current: JsonValue = root;
	for (const segment of segments) {
		if (!isJsonObject(current) || !(segment in current)) return undefined;
		current = current[segment];
	}
	return current;
}

export function hasPath(root: JsonObject, path: string): boolean {
	return getPath(root, path) !== undefined;
}

export function setPath(root: JsonObject, path: string, value: JsonValue): void {
	const segments = normalizePath(path);
	let current = root;
	for (let index = 0; index < segments.length - 1; index++) {
		const segment = segments[index];
		const existing = current[segment];
		if (existing === undefined) {
			const next: JsonObject = {};
			current[segment] = next;
			current = next;
			continue;
		}
		if (!isJsonObject(existing)) {
			throw new Error(`Cannot write ${path}: ${segments.slice(0, index + 1).join(".")} is not an object`);
		}
		current = existing;
	}
	current[segments[segments.length - 1]] = deepCloneJson(value);
}

export function deepMergeObjects(base: JsonObject, overlay: JsonObject): JsonObject {
	const result = deepCloneJson(base);
	for (const [key, value] of Object.entries(overlay)) {
		const existing = result[key];
		if (isJsonObject(existing) && isJsonObject(value)) result[key] = deepMergeObjects(existing, value);
		else result[key] = deepCloneJson(value);
	}
	return result;
}

export function renderTemplate(template: string, state: JsonObject): string {
	return template.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, rawPath: string) => {
		const value = getPath(state, rawPath);
		if (value === undefined || value === null) return value === null ? "null" : "";
		return typeof value === "string" ? value : JSON.stringify(value, null, 2);
	});
}

export function applyStateWrites(
	state: JsonObject,
	writes: StateWrite[],
	reducers: Record<string, ReducerName> = {},
): JsonObject {
	const grouped = new Map<string, StateWrite[]>();
	for (const write of writes) {
		normalizePath(write.path);
		const list = grouped.get(write.path) ?? [];
		list.push(write);
		grouped.set(write.path, list);
	}

	assertNoOverlappingWritePaths([...grouped.keys()]);
	const next = deepCloneJson(state);
	for (const [path, pathWrites] of grouped) {
		const reducer = reducers[path];
		if (pathWrites.length > 1 && reducer === undefined) {
			const nodes = pathWrites.map((write) => write.nodeId).join(", ");
			throw new Error(`Parallel state conflict at ${path}; writers: ${nodes}. Configure a reducer for this path.`);
		}
		let value = getPath(next, path);
		for (const write of pathWrites) value = reduceValue(value, write.value, reducer ?? "replace", path);
		if (value === undefined) throw new Error(`Reducer for ${path} returned undefined`);
		setPath(next, path, value);
	}
	return next;
}

function assertNoOverlappingWritePaths(paths: string[]): void {
	const entries = paths.map((path) => ({ path, segments: normalizePath(path) }));
	for (let leftIndex = 0; leftIndex < entries.length; leftIndex++) {
		for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex++) {
			const left = entries[leftIndex];
			const right = entries[rightIndex];
			const shorter = left.segments.length <= right.segments.length ? left : right;
			const longer = shorter === left ? right : left;
			if (shorter.segments.every((segment, index) => longer.segments[index] === segment)) {
				throw new Error(`Overlapping state writes at ${left.path} and ${right.path} are not allowed in one superstep.`);
			}
		}
	}
}

function reduceValue(previous: JsonValue | undefined, incoming: JsonValue, reducer: ReducerName, path: string): JsonValue {
	switch (reducer) {
		case "replace":
			return deepCloneJson(incoming);
		case "append": {
			const list = previous === undefined ? [] : Array.isArray(previous) ? deepCloneJson(previous) : [deepCloneJson(previous)];
			list.push(deepCloneJson(incoming));
			return list;
		}
		case "concat": {
			const left = previous === undefined ? [] : Array.isArray(previous) ? previous : [previous];
			const right = Array.isArray(incoming) ? incoming : [incoming];
			return [...deepCloneJson(left), ...deepCloneJson(right)];
		}
		case "merge": {
			if (previous !== undefined && !isJsonObject(previous)) throw new Error(`Reducer merge requires object state at ${path}`);
			if (!isJsonObject(incoming)) throw new Error(`Reducer merge requires object writes at ${path}`);
			return deepMergeObjects(previous ?? {}, incoming);
		}
		case "sum":
			return (previous === undefined ? 0 : numberValue(previous, path)) + numberValue(incoming, path);
		case "min":
			return previous === undefined ? numberValue(incoming, path) : Math.min(numberValue(previous, path), numberValue(incoming, path));
		case "max":
			return previous === undefined ? numberValue(incoming, path) : Math.max(numberValue(previous, path), numberValue(incoming, path));
	}
}

function numberValue(value: JsonValue | undefined, path: string): number {
	if (typeof value !== "number") throw new Error(`Reducer at ${path} requires numeric values`);
	return value;
}

export function stateSizeBytes(state: JsonObject): number {
	return Buffer.byteLength(JSON.stringify(state), "utf8");
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}

export function asStringArray(value: string | string[]): string[] {
	return Array.isArray(value) ? value : [value];
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		const abort = () => {
			clearTimeout(timer);
			reject(new Error("Operation aborted"));
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

export function assertPositiveInteger(value: number | undefined, label: string): void {
	if (value === undefined) return;
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

export function assertNonNegativeNumber(value: number | undefined, label: string): void {
	if (value === undefined) return;
	if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`);
}
