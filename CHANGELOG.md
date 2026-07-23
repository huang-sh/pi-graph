# Changelog

## 0.0.3 — 2026-07-23

- Consolidated graph topology analysis so target validation, reachability, cycle detection, and fan-out checks share one representation; `onError.to` is now accepted only with `strategy: "route"`.
- Replaced hand-written raw graph parsing with an exact TypeBox structure schema. Unknown control fields now fail closed while `initialState` and user data values remain open JSON.
- **Breaking:** moved graph definitions to `schemaVersion: 2`. Version 1 is rejected; duplicate output/prompt/state limit fields and non-reviewer `purpose` values were removed. See `docs/SCHEMA.md` for the one-time manual migration.
- **Breaking:** checkpoint snapshots now require `version: 2` inside the existing `formatVersion: 2` envelope. Flat and v1 snapshots are rejected, and only the journal is read as authoritative recovery state.
- Reused Pi terminal width/size helpers, Node's abortable promise timer and `rm(..., { force: true })`; centralized tool policy constants and removed undocumented wrappers.
- Made the discovery result carry one required compiled graph instead of duplicating its definition, identity, hash and diagnostics.
- Replaced the runtime barrel's accidental exports with an explicit compile/engine/checkpoint/executor interface.
- Reduced the npm publish whitelist to runtime, examples, documentation, and skills; development tests, scripts, agent notes, and TypeScript configuration are no longer packed.
- Added a bounded live runtime board for graph runs and resumes, showing the current superstep, queued/running/retrying/completed nodes, topology, elapsed time, usage, and cost in both the Pi TUI widget and streaming tool result. The event stream additively exposes structured `step_start.scheduled` nodes and immediate, observational `node_settled` events without changing ordered `node_end`/checkpoint semantics.
- Hardened the shipped reviewer workflows: malformed structured reviews now retry and preserve best-effort output, while `research-review` can repair missing repository evidence and exits through an explicit approved or bounded best-effort result before hard graph limits.

- Added round-scoped state lifecycle primitives: the `collect` reducer, explicit `overwrite` and `unset` writes, hot-state limits, and per-path state budgets.
- Added prompt hygiene: compiler diagnostics for template/`reads` overlap, runtime projection deduplication, compact shared state-reference suppression, and byte/token preflight limits before Pi is spawned.
- Changed shared capture to a bounded policy model (`none`, `compact`, `assistant-only`, `full`) and added `maxStoredMessages` durable retention with post-commit pruning.
- Added runtime-managed artifact output so full reports and transcripts stay out of checkpoint state; state keeps content-addressed metadata and a bounded preview.
- Added result projection and summary-first/path-oriented inspection; Pi tools no longer return the complete graph state or checkpoint by default.
- Reworked both science-research examples around `working`/`memory`/`result`, current-round branch collection, explicit round cleanup, compact debate state, prompt budgets, and artifact-backed final reports.
- Added compiler diagnostics for cyclic accumulating reducers, duplicate shared/output copies, orphaned artifact references, and duplicate/overlapping prompt projections.
- Added regression tests for cross-round collection, overwrite/unset cleanup, duplicate prompt suppression, shared retention, prompt preflight rejection, artifact persistence, state budgets, and projected results.
- Added exclusive run leases with heartbeat renewal over an immutable per-run operation journal; unexpired leases reject a second executor, expired/crashed owners can be replaced, and stale checkpoint commits are fenced by CAS. External node effects still require idempotency or downstream fencing after TTL-based takeover.
- Added atomic hard-link CAS with non-reusable append-only sequence claims, revisioned immutable checkpoint blobs, durable inode/directory synchronization, and a `formatVersion: 2` checkpoint envelope; new runs are durable at revision 1 and legacy flat `version: 1` checkpoints migrate from revision 0.
- Added strict checkpoint validation for all control fields, nested execution results, usage, history, thread UUIDs, interrupts, finite counters, status invariants, and immutable/monotonic properties across revisions.
- Changed Pi graph tools to throw failures through Pi's real tool-error channel instead of returning an ineffective `isError` field.
- Added concurrency, stale-revision, lease-takeover, crash-recovery, create/delete race, schema-corruption, extension-error, cancellation, and real offline Pi CLI contract tests.

## 0.0.2 — 2026-07-22

- Added `/pi-graph visualize <graph>`: render any discovered graph as a Mermaid flowchart in the Pi TUI (node shapes, static edges, conditional routes, and entry-node highlighting).
- Added the `pi-graph` skill (`skills/pi-graph/SKILL.md`): a workflow-oriented guide for deciding when to use a graph and for authoring, validating, running, resuming, and visualizing one; registered via `pi.skills`.
- Added the `science-research` example graph: a multi-stage research loop (planner → parallel branches → evidence review → integration → report).
- Added the `science-research-auto` example graph: a fully-autonomous variant of `science-research` that replaces the human scope gate with an isolated agent reviewer (`scope_review`) so the whole graph runs headless with no human in the loop; all other mechanics (parallel fan-out + barrier, shared adversarial debate, thread integrator, refinement loop) are preserved.
- Added an English README (`README.en.md`) with a language switcher linking both READMEs.
- Rendered all example graphs as embedded SVGs in the README (`docs/images/`) via `npm run render:graphs`; `@mermaid-js/mermaid-cli` is a devDependency only.
- Added GitHub `repository`, `bugs`, and `homepage` metadata to `package.json`.

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
