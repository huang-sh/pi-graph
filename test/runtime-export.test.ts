import assert from "node:assert/strict";
import test from "node:test";
import * as runtime from "../src/index.ts";

test("runtime exposes only the supported value surface", () => {
	assert.deepEqual(
		Object.keys(runtime).sort(),
		[
			"CheckpointConflictError",
			"CheckpointDurabilityError",
			"CheckpointLeaseError",
			"CheckpointValidationError",
			"END",
			"FileCheckpointStore",
			"GraphEngine",
			"GraphValidationError",
			"PiNodeExecutor",
			"compileGraph",
		].sort(),
	);
});
