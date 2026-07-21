import type { Condition, JsonObject, JsonValue, LeafCondition } from "./types.ts";
import { getPath, isJsonObject, stableStringify } from "./utils.ts";

export function evaluateCondition(condition: Condition, state: JsonObject): boolean {
	if ("all" in condition) return condition.all.every((item) => evaluateCondition(item, state));
	if ("any" in condition) return condition.any.some((item) => evaluateCondition(item, state));
	if ("not" in condition) return !evaluateCondition(condition.not, state);
	return evaluateLeaf(condition, state);
}

function evaluateLeaf(condition: LeafCondition, state: JsonObject): boolean {
	const actual = getPath(state, condition.path);
	switch (condition.op) {
		case "exists":
			return actual !== undefined;
		case "truthy":
			return Boolean(actual);
		case "eq":
			return jsonEquals(actual, condition.value);
		case "ne":
			return !jsonEquals(actual, condition.value);
		case "gt":
			return compare(actual, condition.value, (left, right) => left > right);
		case "gte":
			return compare(actual, condition.value, (left, right) => left >= right);
		case "lt":
			return compare(actual, condition.value, (left, right) => left < right);
		case "lte":
			return compare(actual, condition.value, (left, right) => left <= right);
		case "includes":
			return includes(actual, condition.value);
		case "matches":
			return matches(actual, condition.value);
	}
}

function jsonEquals(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return left === right;
	return stableStringify(left) === stableStringify(right);
}

function compare(
	left: JsonValue | undefined,
	right: JsonValue | undefined,
	predicate: (left: number | string, right: number | string) => boolean,
): boolean {
	if (typeof left === "number" && typeof right === "number") return predicate(left, right);
	if (typeof left === "string" && typeof right === "string") return predicate(left, right);
	return false;
}

function includes(container: JsonValue | undefined, needle: JsonValue | undefined): boolean {
	if (typeof container === "string" && typeof needle === "string") return container.includes(needle);
	if (Array.isArray(container) && needle !== undefined) return container.some((item) => jsonEquals(item, needle));
	if (isJsonObject(container) && typeof needle === "string") return needle in container;
	return false;
}

function matches(actual: JsonValue | undefined, pattern: JsonValue | undefined): boolean {
	if (typeof actual !== "string" || typeof pattern !== "string") return false;
	try {
		return new RegExp(pattern).test(actual);
	} catch {
		return false;
	}
}
