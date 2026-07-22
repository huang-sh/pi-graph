---
name: pi-graph
description: Build, run, and iterate on Pi agent graphs (pi-graph) — explicit-state multi-agent workflows with isolated/thread/shared context modes, conditional routing, fan-out/barrier, durable checkpoints, and human approval gates. Use when the user wants to design a multi-agent workflow, set up a pi-graph, orchestrate specialized agents (researcher/writer/reviewer loops, parallel fan-out, idea tournaments, human-in-the-loop approval), author a graph JSON, or validate/run/resume/visualize a graph. Reach for this only when the task genuinely needs specialization, parallelism, independent review, or persistent role memory — otherwise prefer a single agent loop.
---

# Pi Graph

`pi-graph` orchestrates multi-agent workflows as **explicit state graphs**: nodes, edges, conditional routes, reducers, supersteps, durable checkpoints, and interrupts. It is a Pi extension modeled on LangGraph's low-level orchestration.

**Loop first.** A graph is overhead. Use one only when the task genuinely needs it (see below). For ordinary work, stay in a normal Pi agent loop — a single-node graph even emits a compile warning.

## Decide: graph or loop?

Reach for a graph only if **at least one** is true:

- **Distinct specialties** — two or more roles that should not share one context (e.g. a researcher vs. a skeptical reviewer).
- **Parallelism** — fan-out (run N branches at once) or barrier fan-in (wait for N sources).
- **Independent reviewer with teeth** — a node that can reject work and route it back for revision.
- **Persistent role memory** across iterations (`thread`), or an **auditable shared transcript** (`shared`).
- **Different models / tools / budgets per step.**
- **Human-in-the-loop** approval, choice, or input gates.
- **Failure isolation** between steps (retry, continue, or route on error without losing graph state).

If none apply, do not build a graph.

## Install & discover

```bash
pi install ./pi-graph          # or load in dev: pi -e ./extensions/pi-graph.ts
```

Graphs are discovered from:

- User: `~/.pi/agent/graphs/*.json`
- Project (trusted projects only): `<project>/.pi/graphs/*.json`

Project graphs override same-named user graphs. **Tools and commands accept only discovered graph names — never raw file paths.**

## The three context modes (most important decision)

Every `agent` node declares a `context.mode`. Pick deliberately by role semantics.

| Mode | When to use | Memory |
|---|---|---|
| `isolated` | Default. Independent judgment, parallel branches, one-shot experts, **reviewers**. | None private — passes via graph state / files only. |
| `thread` | Same role revisits across loops (implement → fix → implement). | Reuses one private Pi session per `threadKey`. |
| `shared` | Several nodes share an auditable conversation (ReAct-style handoff). | Role-tagged messages appended to graph state. |

How to choose:

```
Role needs working memory preserved across loops   → thread
Several nodes must share an auditable conversation → shared
Node must judge independently or run in parallel   → isolated
Plain deterministic transform (no model)           → set
Needs human approval / choice / input              → human
```

Hard rules (the compiler warns/violates on these):

- A `purpose: "reviewer"` node should be `isolated` **and** `readOnly`.
- Nodes sharing a `threadKey` must share the same `cwd` and never run concurrently in one superstep.
- `thread` retry re-appends to the same session → set `maxAttempts: 1` on thread nodes; let the graph loop do revisions.
- A lost `thread` session fails recovery closed — the runner never silently resets role memory.

## Authoring workflow

1. **Name** the graph and pick the `entry` node(s) (array = parallel start).
2. **List roles.** For each `agent` node decide: context mode, `output` path, `readOnly`, model/tools/budget.
3. **Draw control flow.** Static `edges` for always-next; `routes` for conditional branching. Mark fan-out (`to: [...]`) and barrier fan-in (`from: [...]`).
4. **Reducers.** Any state path written by parallel nodes needs a reducer or the run fails. The `shared` `messagesPath` gets `concat` automatically.
5. **Bounds.** Set graph-level `limits` (steps, node runs, concurrency, tokens, cost, timeout, state size) and `policy`.
6. **Validate → run → iterate.** Don't skip validate.

### Minimal skeleton (adapt this)

```json
{
  "schemaVersion": 1,
  "name": "research-review",
  "entry": "researcher",
  "nodes": {
    "researcher": {
      "type": "agent",
      "prompt": "Research {{input.task}}",
      "readOnly": true,
      "context": { "mode": "isolated" },
      "output": "notes"
    },
    "writer": {
      "type": "agent",
      "prompt": "Write from {{notes}}. Prior review: {{review}}",
      "readOnly": true,
      "context": { "mode": "thread", "threadKey": "writer" },
      "output": "draft"
    },
    "reviewer": {
      "type": "agent",
      "purpose": "reviewer",
      "prompt": "Review {{draft}} and return {\"approved\": boolean, \"issues\": string[]}",
      "readOnly": true,
      "context": { "mode": "isolated" },
      "output": "review",
      "response": { "format": "json" }
    }
  },
  "edges": [
    { "from": "researcher", "to": "writer" },
    { "from": "writer", "to": "reviewer" }
  ],
  "routes": [
    {
      "from": "reviewer",
      "cases": [
        { "when": { "path": "review.approved", "op": "eq", "value": true }, "to": "__end__" }
      ],
      "default": "writer"
    }
  ],
  "limits": { "maxSteps": 8, "maxNodeRuns": 12, "maxConcurrency": 2, "maxCostUsd": 3 }
}
```

**Full schema:** `../../docs/SCHEMA.md`. **Worked examples** (copy and adapt): `../../examples/` — `research-review` (parallel research + thread writer + isolated reviewer), `coding-review` (thread coder + reviewer + human approval), `shared-handoff` (shared channel), `idea-tournament` (3-way fan-out + barrier judge), `science-research` (planner → parallel branches → evidence review → integrate → report).

## Edges, routes, reducers

```jsonc
// plain
{ "from": "a", "to": "b" }
// fan-out
{ "from": "a", "to": ["b", "c"] }
// barrier fan-in (join waits for all sources)
{ "from": ["b", "c"], "to": "join" }
// conditional route
{
  "from": "reviewer",
  "cases": [
    { "when": { "path": "review.approved", "op": "eq", "value": true }, "to": "__end__" }
  ],
  "default": "writer"
}
```

Condition DSL (no `eval`): `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `exists`, `truthy`, `includes`, `matches`, combinators `all` / `any` / `not`.

Reducers for write conflicts: `replace`, `append`, `concat`, `merge`, `sum`, `min`, `max`. Two parallel nodes writing the same path without a reducer → run fails. A parent and child path written in the same superstep is also rejected.

## Limits & policy

`limits` (graph or per-node): `maxSteps`, `maxNodeRuns`, `maxConcurrency`, `maxTokens`, `maxCostUsd`, `timeoutMs`, `maxTurns`, `maxStateBytes`, `maxOutputBytes`.

`policy`:

- Non-interactive runs require `allowNonInteractive: true`.
- Non-interactive **mutations** additionally require `allowNonInteractiveMutations: true`.
- Graphs using `bash`/`edit`/`write` or unknown tools require confirmation by default.

## Validate, run, resume

```text
/pi-graph list
/pi-graph validate research-review        # always validate first
/pi-graph run research-review <task text or JSON object>
/pi-graph resume <runId> <value or JSON>  # after a human interrupt
/pi-graph inspect [runId]                 # checkpoint / recent runs
```

Or via tools (the model calls these; the three tools are disabled inside child Pi to prevent hidden recursion):

- `pi_graph_run` — `{ graph, task, checkpoint }`; input lands at `state.input`.
- `pi_graph_resume` — `{ runId, value | valueJson }` to satisfy a human node.
- `pi_graph_inspect` — checkpoint, thread metadata, or recent runs.

Checkpoints live at `~/.pi/agent/pi-graph/runs/<runId>.json`. Recovery re-runs only unresolved nodes. Resuming after the graph **definition** changed is refused by default; set `forceGraphVersion: true` only after checking state compatibility and side-effect idempotency.

## Human nodes

```json
{ "type": "human", "prompt": "Approve this plan: {{draft}}", "response": { "format": "boolean" } }
```

A human node pauses the run and returns an `interrupt` + `runId`. Resume with the user's answer. Use for approvals, choices, or requesting missing input.

## Failures & retries

```json
"onError": { "strategy": "fail" }                         // default: stop, keep checkpoint
"onError": { "strategy": "continue", "output": "errors.x" }
"onError": { "strategy": "route", "to": "fallback", "output": "errors.x" }
"retry": { "maxAttempts": 3, "backoffMs": 500, "backoffMultiplier": 2 },
"idempotent": true
```

`idempotent: true` is a **design declaration** — it does not make external side effects idempotent. State is committed only after a node succeeds, so failed/interrupted nodes never write half-finished output.

## Visualize

```text
/pi-graph visualize research-review
```

Renders the graph as a Mermaid `flowchart LR` in the TUI. Shapes: `agent` → stadium `([id])`, `set` → `[[id]]`, `human` → hexagon `{id}`, `__end__` → circle `((end))`. Solid arrows = edges; dashed labeled arrows = conditional routes (`else` = default branch). Entry nodes get a green border. Use this to sanity-check topology before running.

## Inspect & debug

- `/pi-graph inspect <runId>` — full checkpoint JSON (state, routing, `inFlight`, usage).
- Stuck after a definition edit? You hit the graph-hash guard — review state compatibility, then `forceGraphVersion`.
- `thread` run won't resume? The private session file may be missing — recovery fails closed by design.
- Cost/token overshoot near limits is expected; limits rely on provider usage events and a single in-flight response can slightly exceed before termination.

## Boundaries to respect

- `shared` is an explicit transcript projection into a fresh subprocess — not a hidden shared session, and not provider-native message-array injection.
- `thread` continuity is real, but the graph checkpoint and the Pi JSONL session are **two** persistence objects; back up / migrate both.
- Checkpoints are **at-least-once**; external side effects are not guaranteed exactly-once.
- `readOnly` is a tool allowlist, **not** an OS sandbox. For high-risk execution use a container.
- Graph format is `schemaVersion: 1`.
