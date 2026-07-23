# pi-graph

**English** | [中文](README.md)

Durable, auditable state-graph orchestration for the [Pi agent harness](https://github.com/earendil-works/pi).

`pi-graph` organizes complex agent workflows with explicit state, nodes, edges, and reducers. It is designed for tasks that need parallel research, specialized roles, independent review, human approval, or failure recovery. Its execution model draws from [LangGraph](https://github.com/langchain-ai/langgraph) and Pregel, while every agent node still runs through Pi.

Current version: **0.0.3** · Graph schema: **`schemaVersion: 2`**

> Prefer a single Pi agent loop for simple work. A graph becomes worthwhile when the workflow genuinely needs parallel fan-out/fan-in, different models or tools, an independent reviewer, persistent role memory, a human gate, or failure isolation.

## What it solves

A conventional agent loop works well when one context can carry the task from start to finish. More involved workflows often need to:

- run several research nodes in parallel and join only after all of them finish;
- preserve an implementer's working memory while keeping the reviewer independent;
- record handoffs in explicit state instead of relying on hidden chat history;
- continue from a checkpoint after human approval, process exit, or node failure;
- enforce hard limits on steps, concurrency, tokens, cost, time, and state size.

`pi-graph` puts that control flow and state behavior in a JSON graph definition that can be validated, inspected, visualized, and resumed.

## Core capabilities

- Three node types: `agent`, `set`, and `human`;
- static edges, conditional routes, loops, parallel fan-out, and barrier fan-in;
- three agent context modes: `isolated`, `thread`, and `shared`;
- per-node model, thinking, tools, cwd, budget, and resource inheritance;
- deterministic parallel state merging through reducers, including current-superstep-only `collect`;
- `overwrite` / `unset` writes, bounded shared-message retention, and per-path state budgets;
- preflight byte limits over the graph-constructed prompt and duplicate state-injection suppression;
- runtime-managed artifacts, result projection, and path-oriented inspection so large bodies do not return to the parent agent;
- atomic state commits, node retries, error continuation, and fallback routes;
- durable checkpoints, process-restart recovery, and human interrupt/resume;
- graph- and node-level limits for steps, node runs, concurrency, tokens, cost, timeout, output, and state size;
- project trust gates, confirmation for mutating tools, and non-interactive execution policies;
- a live runtime node board plus pre-run Mermaid graph visualization;
- Pi tools: `pi_graph_run`, `pi_graph_resume`, and `pi_graph_inspect`;
- Pi command: `/pi-graph`.

## Quick start

### 1. Install

Requires Node.js `>= 22.19.0` and an installed copy of Pi.

From the repository root:

```bash
pi install .
```

For extension development, load it directly:

```bash
pi --no-extensions -e ./extensions/pi-graph.ts
```

At runtime, the package adds no dependencies beyond Pi-provided peer packages and Node.js built-ins.

### 2. Install an example graph

User graphs are discovered from `~/.pi/agent/graphs/*.json` by default:

```bash
mkdir -p ~/.pi/agent/graphs
cp examples/research-review.json ~/.pi/agent/graphs/
```

### 3. Validate and run

Start Pi, then run:

```text
/pi-graph list
/pi-graph validate research-review
/pi-graph visualize research-review
/pi-graph run research-review Design a safe cache invalidation strategy for this repository
```

If the graph pauses at a `human` node, the command returns a `runId`:

```text
/pi-graph resume <runId> true
```

The model can also call `pi_graph_run` directly:

```json
{
  "graph": "research-review",
  "task": "Design a safe cache invalidation strategy for this repository",
  "checkpoint": true
}
```

## How it works

At the start of a run, input is written to `state.input`. Within each superstep, every node reads the same immutable state snapshot. Successful writes are committed together at the end of the step, and only then does the runner schedule the next set of nodes.

```text
input
  │
  ▼
entry nodes ── fan-out ──► parallel nodes
                                │
                                ▼ barrier
                           join / reviewer
                                │
                         route / loop / end
```

This bulk-synchronous model provides two important guarantees:

1. A node never sees another node's partial result from the same superstep.
2. Parallel nodes writing to the same path must declare a reducer, or the run fails.

### Node types

| Type | Purpose | Calls an agent? |
|---|---|---|
| `agent` | Nondeterministic work such as research, implementation, or review | Yes |
| `set` | Deterministic state writes or transformations | No |
| `human` | Request approval, a choice, or additional input | No; pauses until resume |

### Three context modes

Each `agent` node should choose context semantics based on its responsibility:

| Mode | Memory model | Best suited for |
|---|---|---|
| `isolated` | Starts a fresh Pi subprocess every time; information flows only through state, files, and context files | Independent reviewers, parallel research, one-shot experts |
| `thread` | Reuses a private Pi JSONL session for the same `threadKey` | Implement–review–fix loops, persistent researchers |
| `shared` | Writes role-tagged messages into graph state and projects them into later prompts | Auditable handoffs, ReAct-style collaboration |

Nodes without an explicit `context` run as `isolated`.

#### `isolated`: independent judgment

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

The node does not inherit Pi message history from any other node. Cross-node information must live in graph state, real artifacts in the shared working directory, or stable Pi context files.

#### `thread`: private persistent session

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

Nodes with the same `threadKey` sequentially reuse one Pi session. This lets a role retain working memory across a loop:

```text
planner(threadKey=coder)
  → implementer(threadKey=coder)
  → reviewer(isolated)
  → implementer(threadKey=coder)
```

Thread metadata is stored in the graph checkpoint. By default, the private session lives at:

```text
~/.pi/agent/pi-graph/threads/<runId>/<sessionId>.jsonl
```

The same `threadKey` cannot run concurrently within one superstep or span different `cwd` values. If a previously used session file is missing, recovery fails instead of silently starting a new role memory.

A thread retry appends another prompt to the same session. Production graphs should generally set `maxAttempts` to `1` for thread nodes and use an explicit graph loop for revisions.

#### `shared`: auditable message channel

```json
{
  "type": "agent",
  "prompt": "Continue the analysis for {{input.task}}",
  "context": {
    "mode": "shared",
    "messagesPath": "conversation.messages",
    "capture": "compact",
    "maxMessages": 32,
    "maxPromptBytes": 65536,
    "maxStoredMessages": 32
  },
  "output": "analysis"
}
```

`shared` does not make multiple nodes share a hidden Pi session. Instead, it keeps role-tagged messages as ordinary graph state and projects them into the prompt of a fresh process. Partial messages from failed or interrupted nodes are never committed.

The default is `capture: "compact"`: the channel stores one small assistant reference message while the node output path remains the canonical value. When the next node already projects that state path through its template or `reads`, runtime does not expand the reference again. Other modes are `none`, `assistant-only` (useful with `storeOutput: false`), and explicit `full` transcript capture.

`maxMessages` bounds one prompt projection. `maxStoredMessages` is the durable retention bound: after every commit the engine removes the oldest messages beyond that limit.

A compact decision guide:

```text
One role needs private working memory across loops  → thread
Several nodes need an auditable conversation        → shared
A node needs independent judgment or parallel isolation → isolated
A plain deterministic state transformation          → set
The workflow needs approval or human input          → human
```

## State and token hygiene

Treat graph state as a bounded hot working set, not as a document store:

```text
working  round-scoped temporary data, explicitly unset before refinement
memory   compact cross-round summaries
result   final summaries and artifact references
```

Use `collect` for parallel results that must replace the previous round, `set.assign[].mode: "unset"` for obsolete state, `response.storage: "artifact"` for full reports/transcripts, graph/node prompt preflight limits, `limits.maxStateBytes` for total state, `statePolicy.paths` for exact path budgets, and top-level `result.paths` to keep the full internal state out of the parent Pi context.

```json
{
  "reducers": { "working.branch_results": "collect" },
  "limits": { "maxStateBytes": 131072 },
  "statePolicy": {
    "paths": { "working.reviewed_evidence": { "maxBytes": 8192 } }
  },
  "result": {
    "paths": ["result.executive_summary", "result.report_artifact"],
    "includeState": false,
    "maxBytes": 8192
  }
}
```

Prompt preflight covers the parts constructed by `pi-graph`: the node instruction, shared transcript, `reads`, response contract, and node system prompt. It does not include Pi's base system prompt, tool schemas, automatically loaded context/skills/extensions, provider framing, or prior private history in a thread session. Continue to use conservative limits, actual usage accounting, and context compaction for those inputs.

## Minimal graph definition

In this graph, a researcher produces source material, a writer retains revision context, and an independent reviewer decides whether the run should end:

```json
{
  "schemaVersion": 2,
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
      "response": { "format": "json" },
      "retry": { "maxAttempts": 3, "backoffMs": 500 },
      "idempotent": true
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

See the [graph schema](docs/SCHEMA.md) for every available field.

## State, reducers, and control flow

Nodes read state through `{{path.to.value}}` templates and optional `reads`. They write through `output`, `set.assign`, or a shared message channel.

Parallel writes to the same path require a reducer on that path:

- `replace`
- `append`: accumulate history across supersteps
- `collect`: collect only the current superstep and replace the previous round
- `concat`
- `merge`
- `sum`
- `min`
- `max`

A parent path and one of its child paths cannot both be written in the same superstep. `set.assign[].mode` defaults to `reduce`; `overwrite` bypasses the reducer and `unset` removes the path. The compiler emits `ACCUMULATING_REDUCER_IN_CYCLE` when a cyclic node keeps writing an `append`/`concat` channel; bounded shared channels with `maxStoredMessages` are exempt.

Common control-flow patterns:

```json
{
  "edges": [
    { "from": "plan", "to": ["research_a", "research_b"] },
    { "from": ["research_a", "research_b"], "to": "join" }
  ],
  "routes": [
    {
      "from": "reviewer",
      "cases": [
        { "when": { "path": "review.approved", "op": "eq", "value": true }, "to": "__end__" }
      ],
      "default": "writer"
    }
  ]
}
```

The condition DSL never uses `eval`. It supports `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `exists`, `truthy`, `includes`, and `matches`, plus the combinators `all`, `any`, and `not`.

## Graph discovery and commands

Graphs are discovered from two locations:

| Scope | Path |
|---|---|
| User graphs | `~/.pi/agent/graphs/*.json` |
| Project graphs | `<project>/.pi/graphs/*.json` |

When scope is `both`, a project graph overrides a same-named user graph. Project graphs are discovered only after Pi trusts the current project. Tools accept discovered graph names only, never arbitrary file paths.

Available commands:

```text
/pi-graph list
/pi-graph validate [graph]
/pi-graph run <graph> [task or JSON object]
/pi-graph resume <runId> [value or JSON]
/pi-graph inspect [runId] [--full|--inventory|state.path]
/pi-graph visualize <graph>
```

Corresponding model tools:

| Tool | Purpose |
|---|---|
| `pi_graph_run` | Run a discovered graph by name; input is written to `state.input` |
| `pi_graph_resume` | Resume by `runId`, optionally submitting human input |
| `pi_graph_inspect` | Inspect a compact checkpoint summary, inventory, selected state path, or explicitly requested full record |

### Inspection is summary-first

`/pi-graph inspect <runId>` returns status, usage, pending/in-flight work, total state bytes, and the largest state paths. Use `--inventory`, a dotted state path, or explicit `--full` for deeper inspection. Only `--full` renders the complete checkpoint, still under a byte cap.

## Visualization and examples

Runs started through `/pi-graph run`, `/pi-graph resume`, `pi_graph_run`, or `pi_graph_resume` automatically show a live board below the editor, bounded to ten lines. It reports the current superstep, active/completed counts, queued/running/retrying/failed nodes, outgoing edges or routes, elapsed time, tokens, and cost, and is cleared on every exit path. Tool-driven runs stream the same snapshot into the in-progress tool result instead of rendering a blank card.

`/pi-graph visualize <graph>` generates a Mermaid `flowchart LR` from a discovered graph that passes compilation. Use it to inspect entry points, parallel branches, barriers, and conditional loops before a run.

### Parallel research, persistent writer, independent reviewer

The [research-review example](examples/research-review.json) combines parallel isolated research, a barrier join, a thread writer, an isolated reviewer, targeted evidence repair, and a bounded best-effort exit:

![research-review graph](docs/images/research-review.svg)

### Implementation, review, and human approval

The [coding-review example](examples/coding-review.json) combines a thread coder, an independent reviewer, human approval, and conditional revision loops:

![coding-review graph](docs/images/coding-review.svg)

### Full example list

| Example | Demonstrates |
|---|---|
| [research-review](examples/research-review.json) | Parallel research, barrier join, evidence repair, thread writer, independent reviewer, bounded fallback |
| [coding-review](examples/coding-review.json) | Persistent coder, independent review, human approval, revision loops |
| [shared-handoff](examples/shared-handoff.json) | Shared message channel, independent reviewer |
| [idea-tournament](examples/idea-tournament.json) | Three-way fan-out, `append` reducer, barrier judge |
| [science-research](examples/science-research.json) | Human scope gate, current-round `collect`, bounded shared debate, explicit cleanup, artifact report |
| [science-research-auto](examples/science-research-auto.json) | Fully autonomous variant with the same bounded-state and artifact semantics |

After editing `examples/*.json`, regenerate the committed SVG files with:

```bash
npm run render:graphs
```

## Checkpoints, recovery, and error handling

Checkpoints are written by default to:

```text
~/.pi/agent/pi-graph/runs/<runId>.json
```

That file is a human-readable mirror of the latest checkpoint for inspection and backup. The authoritative lease, revision, and CAS state lives under `.journal/<runId>/` in the same directory. The journal appends immutable operation records and checkpoint blobs, using an atomic hard link to claim the one valid next sequence number. Sequence claims are never deleted or reused, preventing ABA when a paused process resumes.

Every durable run acquires an exclusive lease before execution and renews it in the background. While that lease is unexpired, a second executor for the same `runId` receives `RUN_LEASE_HELD` and cannot enter node execution; after a process crash or long stall, takeover is allowed only after the old lease expires. Every save uses the current revision as a CAS condition, so a stale revision or lost lease cannot overwrite the winner. A new run is already durable at revision 1 before `open(create)` returns; it does not depend on the engine's first later save.

Checkpoints use a `formatVersion: 2` envelope containing a monotonically increasing `revision` and the `snapshot`. Load, create, and every commit run the complete schema validator over usage, history, threads, in-flight results, interrupts, UUID session IDs, plain JSON containers, finite non-negative counters, and status invariants. Across revisions it also prevents graph identity, timestamps, steps, node runs, usage, counts, history, or thread progress from moving backwards or being rewritten. Other checkpoint formats are rejected.

The runner writes checkpoints atomically before a superstep starts, records successful results after the parallel batch returns, writes again after step commit, and persists interrupt, failure, and completion states. Nodes already present in `inFlight.completed` are not rerun. If the process exits before the whole parallel batch returns, a sibling that completed only in process is still unresolved and will run again during recovery.

Each checkpoint stores a graph hash. Recovery is rejected by default after the graph definition changes. Use `forceGraphVersion` only after manually verifying state compatibility and side-effect idempotency.

By default, a node failure stops the graph and preserves the checkpoint:

```json
{ "onError": { "strategy": "fail" } }
```

A graph can instead record the error and continue, or route to a fallback:

```json
{
  "onError": {
    "strategy": "route",
    "to": "fallback",
    "output": "errors.research"
  }
}
```

`to` is valid only with `strategy: "route"`; `fail` and `continue` retain their fixed routing semantics.

Retry example:

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

`response.format: "json"` appends a strict output instruction and parses the final text, but it is not a provider-level schema guarantee. Invalid JSON is a retryable node failure; missing fields or wrong JSON types must still be handled by graph routes and fallbacks.

`onError` handles node failures only. An `approved: false` review is a successful node result, and `maxSteps` is a graph-level hard limit, so neither triggers the reviewer's `onError`. A loop that needs graceful degradation should count rounds in state and route to a best-effort or human node before reaching the hard limit; keep `maxSteps` as the final guardrail.

`idempotent: true` is a design declaration; it does not make external side effects idempotent automatically. Checkpoints provide at-least-once recovery semantics, not exactly-once external side effects.

When exposed as Pi tools, `failed`, `cancelled`, and execution exceptions are thrown into Pi's real tool-error channel. An `interrupted` run remains a normal resumable result.

## Security boundaries

- Project graphs are discovered only in trusted projects, and interactive runs show a graph-level confirmation by default.
- Graphs using `bash`, `edit`, `write`, or unknown extension tools require additional confirmation by default.
- Non-interactive runs must set `policy.allowNonInteractive: true`.
- Non-interactive mutations must also set `policy.allowNonInteractiveMutations: true`.
- State paths, node IDs, and thread/control-map keys reject `__proto__`, `prototype`, and `constructor`.
- Child Pi processes disable all three pi-graph tools to prevent hidden recursive graph calls.
- `readOnly` restricts the tool allowlist; it is not an operating-system sandbox.

Run high-risk workflows inside a container or OS sandbox. Do not treat graph-level `readOnly` as system-level permission isolation.

## Known limitations

- `shared` is an explicit transcript projection, not provider-native message-array injection.
- With `thread`, the graph checkpoint and Pi JSONL session are separate persistent objects; back them up, migrate them, and clean them up together.
- A thread node can crash after its session history is appended but before the checkpoint is updated, so recovery may repeat the current prompt.
- The file checkpoint adapter's journal/hard-link lease/CAS protocol targets a same-host local filesystem with atomic hard-link support; it is not a cross-host distributed coordination protocol.
- Full power-loss durability also requires directory `fsync`; platforms without it provide only best-effort metadata durability. Append-only lease entries and old snapshot blobs grow with long-running runs. Deleting a run removes blobs but retains anti-resurrection sequence claims and a tombstone, so continue to monitor inode use and rotate or archive a checkpoint root only after ruling out stale processes and future reuse of its `runId` values.
- Lease/CAS fences checkpoint commits, not external effects a node has already issued. If an old process is paused beyond its TTL, it can briefly overlap a replacement after resuming and before its next heartbeat or commit detects lease loss; mutations still need idempotency keys or downstream fencing tokens.
- Token and cost limits depend on provider usage events; one in-flight response may slightly exceed a limit before termination.
- Barriers pair each source by completion count, and the same target is executed only once within a superstep.
- The graph format is `schemaVersion: 2`; other schema versions are rejected.

## Development

```bash
npm run check
npm test
npm run validate:examples
```

The `prepublishOnly` hook runs all three checks before publication.

## Further reading

- [Schema reference](docs/SCHEMA.md) (Chinese): complete graph format, node fields, and context configuration;
- [Architecture](docs/ARCHITECTURE.md) (Chinese): supersteps, four memory planes, checkpoints, and failure semantics;
- [Changelog](CHANGELOG.md): release history.

## License

[MIT](LICENSE)
