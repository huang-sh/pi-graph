# Changelog

## 0.0.1 — 2026-07-21

- Reversioned the package to `0.0.1` as the active baseline.

## 0.2.0 — 2026-07-21

- Added explicit agent context modes: `isolated`, `thread`, and `shared`.
- Preserved `isolated` as the default for backward-compatible `schemaVersion: 1` graphs.
- Added durable private Pi sessions keyed by `threadKey`, including checkpoint metadata, cwd compatibility checks, concurrent-use rejection, private permissions, and missing-session fail-closed behavior.
- Added explicit role-tagged shared-message channels in graph state, bounded transcript projection, atomic message commits, and implicit `concat` reducers.
- Added reviewer-context diagnostics and warnings for retrying persistent thread nodes.
- Updated coding, research, and shared-handoff examples to demonstrate deliberate memory boundaries.
- Expanded type, compile, subprocess, restart/resume, missing-session, and reducer regression coverage.

## 0.1.0 — 2026-07-21

- Initial Pi package and extension.
- Explicit JSON state graph with static and conditional edges.
- Bulk-synchronous fan-out/fan-in execution.
- Atomic state reducers and parallel-write conflict detection.
- Isolated Pi subprocess nodes with per-node model, thinking, tools, cwd, and resources.
- Node retry policies, idempotency diagnostics, and failure isolation.
- Durable checkpoints, inspection, resume, and human interrupts.
- Graph and node cost, token, turn, step, concurrency, timeout, output, and state-size limits.
- Project trust and mutating-tool confirmation gates.
