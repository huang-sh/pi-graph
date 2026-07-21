# pi-graph

**English** | [中文](README.md)

`pi-graph` is a state-graph extension for the [Pi agent harness](https://github.com/earendil-works/pi). It borrows the low-level orchestration ideas of [LangGraph](https://github.com/langchain-ai/langgraph) and organizes Pi agent workflows with explicit state, nodes, edges, reducers, supersteps, checkpoints and interrupts.

Current version: **0.0.1**.

`pi-graph` no longer forces every agent node into a one-shot isolated context. Each agent node can choose among three context semantics based on its role:

| Mode | Cross-node memory | Persistence location | Typical use |
|---|---|---|---|
| `isolated` | Passed only via graph state / files | No private Pi session | Independent reviewers, parallel research, one-shot experts |
| `thread` | Same `threadKey` reuses a private Pi session | Pi JSONL session + checkpoint thread metadata | implement–review–fix loops, long-running researchers |
| `shared` | Role-tagged messages written into graph state | graph checkpoint | ReAct-style continuous dialogue, explicit auditable handoffs |

Legacy graphs that do not declare `context` still run as `isolated`, preserving `schemaVersion: 1` backward compatibility.

The design follows the core constraints of the [Graph Engineering Guide (2026)](https://www.aibuilderclub.com/blog/graph-engineering-guide-2026): try a single agent loop first; reach for a graph only when the task genuinely needs specialization, parallel fan-out/fan-in, different models or tools, independent reviewers, auditable routing, persistent role memory, or failure isolation.

## Features

- Explicit JSON shared state, nodes, static edges and conditional edges
- LangGraph/Pregel-style bulk-synchronous superstep
- Parallel fan-out, multi-source barrier fan-in, conditional branches and cyclic back-edges
- `agent`, `set`, `human` node types
- `isolated`, `thread`, `shared` agent context modes
- Per-node model, thinking, tools, cwd, resource inheritance and budget
- Atomic state commit; parallel write conflicts must declare a reducer
- Shared message channel automatically uses the `concat` reducer
- Durable identity, recovery and concurrency protection for thread sessions
- Node retry, idempotency diagnostics, failure isolation and error routing
- Durable checkpoint, failure recovery, human interrupt/resume
- Hard graph/node-level limits on steps, node-runs, concurrency, tokens, cost, timeout, output and state size
- Project-graph trust gate, mutating-tool confirmation, non-interactive execution policy
- Graph visualization: `/pi-graph visualize` renders any discovered graph as a Mermaid flowchart
- Pi tools: `pi_graph_run`, `pi_graph_resume`, `pi_graph_inspect`
- Pi command: `/pi-graph`

## Installation

Install from a local directory:

```bash
pi install ./pi-graph
```

Load directly during development:

```bash
pi --no-extensions -e ./pi-graph/extensions/pi-graph.ts
```

The Pi package manifest is declared in `package.json` under `pi.extensions`. The runtime depends only on the Pi-provided `@earendil-works/pi-coding-agent` and `typebox` peer packages.

## Quick start

Install the example graphs:

```bash
mkdir -p ~/.pi/agent/graphs
cp ./pi-graph/examples/research-review.json ~/.pi/agent/graphs/
cp ./pi-graph/examples/shared-handoff.json ~/.pi/agent/graphs/
```

After starting Pi:

```text
/pi-graph list
/pi-graph validate research-review
/pi-graph run research-review Design a safe cache invalidation strategy for this repository
```

A human node pauses and returns a `runId`:

```text
/pi-graph resume <runId> true
```

The model can call it too:

```json
{
  "graph": "research-review",
  "task": "Design a safe cache invalidation strategy for this repository",
  "checkpoint": true
}
```

## Agent context model

### `isolated`: independent context

```json
{
  "type": "agent",
  "purpose": "reviewer",
  "prompt": "Review {{draft}}",
  "readOnly": true,
  "context": { "mode": "isolated" },
  "output": "review"
}
```

Each invocation spawns a fresh sessionless Pi subprocess:

```text
pi --mode json -p --no-session ...
```

The node does not inherit other nodes' Pi message history. Cross-node information must flow through:

1. graph state, e.g. `draft`, `review.requiredChanges`
2. real artifacts in the shared working directory, e.g. code and test output
3. Pi context files, e.g. a stable `AGENTS.md`

Suited to independent reviewers, parallel research branches, one-shot experts, and nodes that need a strong failure boundary.

### `thread`: private persistent Pi session

```json
{
  "type": "agent",
  "prompt": "Implement {{input.task}}. Prior review: {{review}}",
  "context": {
    "mode": "thread",
    "threadKey": "coder"
  },
  "output": "implementation"
}
```

Nodes sharing a `threadKey` sequentially reuse the same Pi session:

```text
planner(threadKey=coder)
  → implementer(threadKey=coder)
  → isolated reviewer
  → implementer(threadKey=coder)
```

On the second entry to `implementer`, Pi sees the existing messages and tool working memory of the `coder` private session; the current graph state remains the authoritative input, and the node prompt should keep explicitly referencing the plan, review outcome and control state.

Thread metadata is stored in the graph checkpoint; the private Pi session lives by default at:

```text
~/.pi/agent/pi-graph/threads/<runId>/<sessionId>.jsonl
```

Constraints:

- When `threadKey` is omitted, it defaults to the node id.
- The same `threadKey` cannot run concurrently within one superstep.
- Nodes sharing a `threadKey` must use the same `cwd`.
- If the private session file is lost, recovery fails; the runner never silently resets role memory.
- A thread retry re-appends the prompt to the same session, so the compiler emits a `THREAD_RETRY_APPENDS_HISTORY` warning. Production graphs should usually set `maxAttempts` to `1` on thread nodes and let the graph loop handle revision iterations.

### `shared`: explicit shared message channel

```json
{
  "type": "agent",
  "prompt": "Continue the analysis for {{input.task}}",
  "context": {
    "mode": "shared",
    "messagesPath": "conversation.messages",
    "maxMessages": 32,
    "maxPromptBytes": 65536
  },
  "output": "analysis"
}
```

A successful node appends the current user instruction, assistant messages and tool results to the specified state path:

```json
{
  "role": "assistant",
  "content": "...",
  "nodeId": "analyst",
  "name": null,
  "createdAt": "2026-07-21T12:00:00.000Z"
}
```

`messagesPath` automatically gets the `concat` reducer, so parallel shared nodes can deterministically append their messages to the same channel. Configuring a different reducer explicitly is rejected.

The current implementation injects the most recent role-tagged messages as an **explicit transcript projection** into a fresh Pi subprocess, rather than letting multiple nodes share one hidden Pi session. This makes messages ordinary graph state: inspectable, trimmable, checkpointable and mergeable by a reducer. By default at most the latest 32 messages and 64 KiB of UTF-8 text are injected; tighten this via `maxMessages` and `maxPromptBytes`.

Only shared messages from successful nodes are committed atomically with the step. Failed or interrupted nodes never write half-finished messages into graph state.

### How to choose

```text
A role needs working memory preserved across loops      → thread
Multiple nodes need to share an auditable conversation  → shared
A node must judge independently or run in parallel      → isolated
A plain deterministic transform                         → set
Needs approval, a choice, or supplementary input        → human
```

Recommended combinations:

```text
planner/thread ─→ implementer/thread ─→ reviewer/isolated
                         ↑                    │
                         └──── required changes ────┘
```

or:

```text
analyst/shared → writer/shared → reviewer/isolated
```

## Graph discovery directories

User graphs:

```text
~/.pi/agent/graphs/*.json
```

Project graphs:

```text
<project>/.pi/graphs/*.json
```

With `scope: "both"`, project graphs override same-named user graphs by `name`. Project graphs are discovered only after Pi has trusted the project; interactive mode additionally shows a graph-level confirmation by default. Tools accept only discovered graph names, never arbitrary file paths.

## Minimal graph

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
        {
          "when": { "path": "review.approved", "op": "eq", "value": true },
          "to": "__end__"
        }
      ],
      "default": "writer"
    }
  ],
  "limits": {
    "maxSteps": 8,
    "maxNodeRuns": 12,
    "maxConcurrency": 2,
    "maxCostUsd": 3,
    "maxTokens": 300000,
    "timeoutMs": 1200000,
    "maxStateBytes": 1048576
  }
}
```

For the full schema see [`docs/SCHEMA.md`](docs/SCHEMA.md).

## Graph visualization

`/pi-graph visualize <graph>` renders any discovered graph as a Mermaid `flowchart LR` and displays it directly in the Pi TUI. The structure comes straight from the graph definition; it renders even when compile errors exist, which helps debug control-flow issues.

```text
/pi-graph visualize research-review
```

The output contains a summary header (node / edge / route counts, or the number of compile errors) and a Mermaid code block. The diagrams below are pre-rendered to SVG from the same rendering logic (`generateMermaid`) via `npm run render:graphs` and committed to the repo, so they are visible on GitHub, npm, and any viewer that does not render Mermaid.

### Node shapes

| Type | Shape | Mermaid syntax |
|---|---|---|
| `agent` | stadium (rounded rectangle) | `id([id])` |
| `set` | subroutine (double-bordered rectangle) | `id[[id]]` |
| `human` | hexagon | `id{id}` |
| `__end__` | circle | `__end__((end))` |

Entry nodes (real node ids listed in `entry`) are marked with a green bold border: `classDef entry stroke:#2a2,stroke-width:3px;`.

### Edges and routing

- Static edge: solid arrow `a --> b`. When `from`/`to` is an array, it expands into all combinations, so fan-out and barrier fan-in appear as multiple parallel arrows.
- Conditional route: dashed arrow with a condition label `a -. "label" .-> b`; an unmatched `default` branch is labeled `else`.
- Condition labels are produced by the condition DSL: `all`/`any`/`not` render as `∧`/`∨`/`¬`, comparison operators map to `==`, `!=`, `>`, `≥`, `<`, `≤`, etc.; any `"` in a label is replaced with `'` to keep the Mermaid syntax valid.

### Example: parallel research + thread writer + independent reviewer

`/pi-graph visualize research-review` renders as:

![research-review graph](docs/images/research-review.svg)

The two entry nodes (parallel isolated research) barrier-join at the writer; the reviewer's conditional route goes to `__end__` when the bar is met, otherwise returns to the writer with an `else` label to form a revision loop.

### Example: parallel fan-out + barrier tournament

`/pi-graph visualize idea-tournament` shows how three parallel ideator branches converge on the barrier node `judge` through a single edge:

![idea-tournament graph](docs/images/idea-tournament.svg)

### Other example diagrams

`coding-review` (thread coder + independent reviewer + human approval, two layers of conditional loops):

![coding-review graph](docs/images/coding-review.svg)

`shared-handoff` (explicit shared message channel + isolated reviewer revision loop):

![shared-handoff graph](docs/images/shared-handoff.svg)

`science-research` (planner fans out three parallel branches → barrier evidence review → integration → report):

![science-research graph](docs/images/science-research.svg)

### Regenerating

After editing `examples/*.json`, re-run the script to refresh every SVG (it calls the same `generateMermaid` as `/pi-graph visualize`, so output stays consistent with the TUI):

```bash
npm run render:graphs
```

`docs/images/*.svg` are committed to the repo, so readers see the diagrams without running anything; `@mermaid-js/mermaid-cli` is a devDependency only and never enters the runtime.

## State and reducers

Runtime state is a JSON object. Initial input lives at `state.input`; the graph's `initialState` is deep-merged with the invocation input. Nodes read state via templates `{{path.to.value}}` and optional `reads`, and write via `output`, the shared message channel, or `set.assign`.

All nodes within a superstep read the same immutable snapshot. When nodes finish, their write-sets are committed at once. If two parallel nodes write the same path without a reducer, the run fails; a parent path and a child path written in the same superstep are also rejected.

Supported:

- `replace`
- `append`
- `concat`
- `merge`
- `sum`
- `min`
- `max`

## Edges, parallelism and loops

Plain edge:

```json
{ "from": "a", "to": "b" }
```

fan-out:

```json
{ "from": "a", "to": ["b", "c"] }
```

barrier fan-in:

```json
{ "from": ["b", "c"], "to": "join" }
```

conditional route:

```json
{
  "from": "reviewer",
  "cases": [
    { "when": { "path": "review.approved", "op": "eq", "value": true }, "to": "__end__" }
  ],
  "default": "writer"
}
```

The condition DSL never uses `eval`. It supports `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `exists`, `truthy`, `includes`, `matches`, plus `all`, `any`, `not`.

## Durable execution

Graph checkpoints are written by default to:

```text
~/.pi/agent/pi-graph/runs/<runId>.json
```

Atomic writes happen before each superstep starts, after each successful node, after step commit, and on interrupt/failure/end. Successful nodes in a parallel step are kept in `inFlight.completed`; recovery re-executes only unresolved nodes.

Checkpoints store a graph hash. Recovery is refused by default after the definition changes; `forceGraphVersion` should be used only after you have manually verified state compatibility and side-effect idempotency.

Thread mode adds a second persistence layer:

```text
graph checkpoint
  ├─ state / routing / usage / inFlight
  └─ threadKey → stable Pi sessionId

Pi session JSONL
  └─ that role's private message/tool history
```

## Graph-engineering constraints

1. **Loop first**: a single-node graph produces a warning; simple tasks should use a plain Pi loop.
2. **Real specialties**: nodes should represent genuine responsibility boundaries, not inlinable steps disguised as roles.
3. **Explicit edges/state**: control flow, input dependencies, output paths and reducers are all reviewable.
4. **Choose memory deliberately**: `isolated`, `thread`, `shared` must be chosen by role semantics.
5. **Reviewer with teeth**: `purpose: "reviewer"` without `readOnly` warns; a non-isolated reviewer also warns.
6. **Failure isolation**: graph state is not committed before a node succeeds; retry, continue and error routing are supported.
7. **Hard bounds**: steps, node runs, concurrency, tokens, cost, timeout, output and state all have hard limits.
8. **No hidden recursive graphing**: the three pi-graph tools are disabled inside child Pi.

## Failures and retries

By default a failure stops the graph and keeps the in-flight checkpoint:

```json
"onError": { "strategy": "fail" }
```

Record the error and continue:

```json
{
  "onError": {
    "strategy": "continue",
    "output": "errors.research"
  }
}
```

Divert to a fallback:

```json
{
  "onError": {
    "strategy": "route",
    "to": "fallback",
    "output": "errors.research"
  }
}
```

Retries for ordinary isolated/shared nodes:

```json
{
  "retry": {
    "maxAttempts": 3,
    "backoffMs": 500,
    "backoffMultiplier": 2
  },
  "idempotent": true
}
```

`idempotent: true` is a design declaration; it does not automatically make external side effects idempotent. A thread-mode retry also reuses a private session that may already have changed, so be extra careful.

## Security model

- Project graphs are discovered only in trusted projects.
- Project graphs require interactive confirmation by default.
- Graphs containing `bash/edit/write` or unknown extension tools require extra confirmation by default.
- Non-interactive runs must set `policy.allowNonInteractive: true`.
- Non-interactive mutations must additionally set `policy.allowNonInteractiveMutations: true`.
- Thread session directories use restricted permissions; a lost session that has been used is never silently rebuilt.
- State paths reject `__proto__`, `prototype` and `constructor`.
- `readOnly` is a tool allowlist, not an OS sandbox.

## Pi tools and commands

Tools:

- `pi_graph_run`: run by graph name; input goes to `state.input`
- `pi_graph_resume`: resume by `runId`; can submit human input
- `pi_graph_inspect`: inspect a checkpoint, thread metadata, or recent runs

Command:

```text
/pi-graph list
/pi-graph validate [graph]
/pi-graph run <graph> [task or JSON object]
/pi-graph resume <runId> [value or JSON]
/pi-graph inspect [runId]
/pi-graph visualize <graph>
```

## Development and validation

```bash
npm run check
npm test
npm run validate:examples
```

Test coverage:

- All three context modes and default backward compatibility
- Shared message append, injection into the next node, and implicit reducer
- Thread session resumption across graph interrupt / process restart
- Fail-closed behavior when a thread session is lost
- Reviewer isolation, thread cwd and concurrency diagnostics
- Conditional loops, fan-out/fan-in barrier
- Parallel state conflicts and reducers
- Retry, failure isolation, human interrupt/resume
- Checkpoint persistence and the Pi NDJSON event protocol
- Strict TypeBox / Pi ExtensionAPI type checking

## Important boundaries

- `shared` is an explicit prompt projection of a role-tagged transcript; it is not a provider-native message-array injection, nor is it multiple nodes sharing one Pi session.
- `thread` provides real Pi session continuity, but the graph checkpoint and the Pi JSONL are two separate persistence objects; backup, migration and cleanup must handle both.
- Checkpoints provide at-least-once recovery semantics and do not guarantee exactly-once external side effects.
- A thread node may crash after the Pi session has appended history but before the graph checkpoint is updated; recovery may repeat the current prompt.
- Cost/token limits rely on provider usage events; a single in-flight response may slightly overshoot before termination.
- `readOnly` does not restrict OS permissions; high-risk execution should use a container or OS sandbox.
- Barriers pair on each source's completion count; the same target within a superstep is deduplicated and executed once.
- The graph format is still `schemaVersion: 1`.

## Examples and documentation

- [`docs/SCHEMA.md`](docs/SCHEMA.md): full graph format and context schema
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): superstep, three-layer memory, checkpoint and failure semantics
- [`examples/research-review.json`](examples/research-review.json): parallel isolated research + thread writer + isolated reviewer
- [`examples/coding-review.json`](examples/coding-review.json): shared coder thread + independent reviewer + human approval
- [`examples/shared-handoff.json`](examples/shared-handoff.json): explicit shared message channel + isolated reviewer
- [`examples/idea-tournament.json`](examples/idea-tournament.json): parallel fan-out (3 ideators) + `append` reducer aggregation + barrier judge tournament
- [`examples/science-research.json`](examples/science-research.json): multi-stage research loop (planner → parallel branches → evidence review → integration → report); one pass = one research iteration, mapping to the Science Agent GENERATE/TEST/REVIEW/INTEGRATE/REPORT design
