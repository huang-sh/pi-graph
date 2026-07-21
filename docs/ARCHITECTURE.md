# pi-graph architecture

## 目标

`pi-graph` 是 Pi extension，不是 LangGraph API 克隆。它把以下低层语义映射到 Pi agent runtime：

- shared state
- nodes and edges
- three explicit agent context modes
- bulk-synchronous parallelism
- reducers and conditional routing
- durable checkpoint
- human interrupt
- failure isolation
- bounded execution

Graph runtime 负责控制流、state ownership、恢复和治理；Pi 负责每个智能节点中的模型推理、tool loop、provider 和项目上下文。

## 为什么支持三种上下文

单一上下文策略无法同时满足连续性、独立性和可审计性：

- 所有节点共享完整历史会污染 reviewer，并让并行和恢复变得含糊。
- 所有节点完全隔离会让实现—审查—修复循环丢失有价值的工作记忆。
- 只使用持久 session 会把关键业务状态藏进不可组合的消息历史。

因此上下文由图作者显式选择：

```text
isolated = private memory per invocation
thread   = private durable memory per role
shared   = explicit durable messages in graph state
```

Graph state 在所有模式中都是控制流和跨角色契约的权威来源。

## 运行层次

```text
Pi session
  └─ pi-graph extension tool/command
       └─ GraphEngine
            ├─ shared JSON state
            ├─ scheduler / routes / barriers
            ├─ effective reducers
            ├─ checkpoint store
            └─ PiNodeExecutor
                 ├─ isolated Pi subprocess
                 ├─ persistent-thread Pi subprocess
                 ├─ shared-transcript Pi subprocess
                 └─ deterministic / human nodes
```

GraphEngine 不直接调用 provider SDK。Agent node 委托给 Pi CLI，复用 Pi 的 provider、模型、tool harness、context files、session format 和 NDJSON usage protocol。

## 三个记忆平面

### 1. Graph state

```text
state.input
plan
implementation
review
conversation.messages
```

它是 JSON serializable、checkpointed、受 reducer 和 state-size limit 约束的显式记忆。条件 route 只读取 graph state。

### 2. Thread private session

```text
threadKey → stable sessionId → Pi JSONL
```

它保存某个持续角色的 Pi user/assistant/tool history，不直接参与 reducer，也不自动暴露给其他角色。

### 3. Workspace / context files

代码、数据、报告、`AGENTS.md` 等由工作目录和 Pi resource loader 提供。它们是外部真实世界状态，不由 graph checkpoint 回滚。

## Context execution

### Isolated

```text
state snapshot
  → render prompt
  → pi --no-session
  → output/state writes
```

每次调用是新 Pi session。适合并行 worker 和 independent reviewer。

### Thread

```text
checkpoint.threads[threadKey].sessionId
  + current state-derived prompt
  → pi --session <stable-file>
  → Pi appends private history
  → output/state writes
```

默认文件：

```text
~/.pi/agent/pi-graph/threads/<runId>/<sessionId>.jsonl
```

目录为 `0700`，文件为 `0600`（非 Windows）。首次运行由 Pi 在受控空显式 session file 上初始化合法 header；后续 invocation 打开同一路径。

GraphEngine 在调度 thread node 前建立 durable thread metadata，并在运行时拒绝同一 key 并发。共享 key 的节点必须使用相同 cwd，因为一个 Pi session header 只有一个工作目录语义。

Thread session 和 graph checkpoint 不构成跨文件事务。若 Pi 已追加 session、进程却在 graph checkpoint 前崩溃，恢复可能重复当前 prompt；这是 at-least-once 语义。

### Shared

```text
state[messagesPath] snapshot
  → select recent messages
  → role-tagged transcript projection
  → pi --no-session
  → collect user/assistant/tool messages
  → one state write to messagesPath
```

Shared mode 不复用 Pi session。它把成功 node 的可公开对话记录变成普通 graph messages：

```json
{
  "role": "assistant",
  "content": "...",
  "nodeId": "writer",
  "name": null,
  "createdAt": "..."
}
```

`messagesPath` 使用隐式 `concat` reducer。并行节点都读取同一个 transcript snapshot，分别生成 message arrays，commit 时按 scheduled order 合并。

`maxMessages` 和 `maxPromptBytes` 只限制每次 prompt projection，不删除 checkpoint 中已有 messages。长期图需要通过显式 set/compaction node 管理 channel 大小，或依赖 graph `maxStateBytes` 停止。

## Superstep 模型

每个 step：

1. 从 `pending` 得到唯一 scheduled nodes。
2. 为 scheduled thread nodes建立/恢复 thread metadata。
3. 保存 `inFlight` checkpoint。
4. 所有节点读取同一个 state snapshot。
5. 在 `maxConcurrency` 内并发运行 unresolved nodes。
6. 每个成功结果立即保存到 `inFlight.completed`，但不修改 shared state。
7. 所有节点解决后按 scheduled order 聚合 writes。
8. 应用 effective reducers 并原子提交新 state。
9. 增加 completion counts。
10. 计算 routes/static edges/barriers，写入下一 step 的 `pending`。

这种 bulk-synchronous 模型避免较快并行节点提前改变 sibling 正在读取的 state。

## State commit

节点返回：

```ts
interface StateWrite {
  path: string;
  value: JsonValue;
  nodeId: string;
}
```

同一路径：

- 单 writer：隐式 replace
- 多 writer、无 reducer：fail
- 多 writer、有 reducer：按 scheduled order deterministic reduce
- shared messages path：隐式 concat

父子路径并行写入也会失败。State commit 前后保持 JSON serializable，并进行 deep clone。

## Routing 与 barrier

Route 在整个 step writes 提交后求值，因此 reviewer route 可以读取刚提交的 review state。第一个 case 命中；default 可选。

`onError.route` 是 node-result override：失败节点走专用 destination，不再执行正常 route/edge。

Multi-source edge 使用 completion count barrier：当每个 source count 都大于该 barrier 已消费 count 时触发一次。这支持循环中的重复 fan-in。

## Checkpoint

Checkpoint 使用临时文件 + atomic rename，并设置目录 `0700`、文件 `0600`。

```ts
interface CheckpointSnapshot {
  runId: string;
  graphName: string;
  graphHash: string;
  status: "running" | "interrupted" | "completed" | "failed" | "cancelled";
  state: JsonObject;
  pending: string[];
  completionCounts: Record<string, number>;
  barrierConsumed: Record<string, Record<string, number>>;
  usage: UsageLedger;
  history: NodeRunHistory[];
  threads?: Record<string, AgentThreadState>;
  inFlight?: {
    step: number;
    scheduled: string[];
    unresolved: string[];
    completed: Record<string, NodeExecutionSuccess>;
  };
  interrupt?: GraphInterrupt;
}
```

Thread metadata：

```ts
interface AgentThreadState {
  key: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  nodes: string[];
  invocationCount: number;
  lastNodeId?: string;
}
```

### Crash recovery

并行 step 运行 A、B、C：

- A 成功并 checkpoint
- B 成功并 checkpoint
- C 运行时退出

恢复后只执行 C；随后 A/B/C writes 一起 commit。

Shared messages 属于 pending writes，所以 A/B 的 messages 已保存在 `inFlight.completed` 但尚未进入 state。Thread private session 由 Pi 直接追加，可能领先于 graph checkpoint。

### Graph hash

Hash 是 definition 的 stable sorted JSON SHA-256。恢复时 hash 不同会拒绝。强制恢复不会迁移 state 或 thread history。

## Human interrupt

Human node 无值时保存：

```json
{
  "nodeId": "approval",
  "kind": "confirm",
  "prompt": "Approve?",
  "createdAt": "..."
}
```

Status 变为 `interrupted`，in-flight 保持。Resume value 只注入当前 interrupt node。

## Pi subprocess protocol

Executor 读取 Pi `--mode json` NDJSON events：

- `message_end`
- assistant text
- `tool_result_end`
- usage input/output/cacheRead/cacheWrite
- `usage.cost.total`
- model、stopReason、errorMessage

每条 assistant usage 立即上报共享 budget。达到上限后发送 SIGTERM，5 秒后仍存活则 SIGKILL。

System prompt 写入 `0600` 临时文件，通过 `--append-system-prompt` 传入，执行后删除。

## Budget

Graph budget 是并发共享 ledger。每个 attempt 还有 scoped node budget。Executor 流式 `report()`；engine 用最终 result usage reconciliation 补齐差额。

所有 retries 计费和计 token。Human/set usage 为零。Graph timeout 记录 active execution time，不计算人工暂停时间。

## Failure model

### Retryable failure

按 node retry policy 重试，每个 attempt 计入 `maxNodeRuns`。

- isolated/shared retry：新 Pi process；未成功的 graph writes 不提交。
- thread retry：同一 Pi session；先前 attempt 可能已经留下 messages，因此编译器 warning。

### Fatal node failure

成功 sibling results 留在 `inFlight.completed`；失败 node 留在 `unresolved`。Resume 只重跑失败 node。

### Isolated error policy

`onError.continue` 或 `route` 把结构化错误转为成功 graph result，使 step 可 commit。History 仍记录 failed。

### State conflict / graph limit

Status 变为 failed，in-flight 保留。调整 definition 后 graph hash 会变化，force resume 必须经过人工审阅。

### Missing thread session

若 checkpoint 显示 thread 已被调用，但其 JSONL 不存在，executor 返回 `THREAD_SESSION_MISSING`，拒绝静默丢失 private memory。

### Abort

AbortSignal 导致 status `cancelled`，未完成 in-flight 保留。

## Security boundaries

1. Discovery 只读取固定 user/project graph directories。
2. Project graph discovery 依赖 Pi trust。
3. 项目和 mutating graph 有独立 confirmation cache。
4. 非交互执行由 graph policy 显式授权。
5. Child Pi 默认最小资源继承。
6. Graph tools 在 child Pi 中禁用，避免递归。
7. Read-only reviewer 使用固定 built-in allowlist。
8. State path、thread key、run id、JSON 类型和输出大小均验证。
9. Thread directories 和 files 使用私有权限，并拒绝 symlink/非普通文件。

`readOnly` 不等于 sandbox。Child Pi 与父进程仍共享 OS user 权限。高风险执行应增加容器、namespace、seccomp、只读挂载或专用工作区。

## 扩展点

核心 runtime 通过 `NodeExecutor` 解耦：

```ts
interface NodeExecutor {
  execute(node: NodeDefinition, context: NodeExecutionContext): Promise<NodeExecutionResult>;
}
```

后续可增加：

- provider-native message-array executor
- SDK-native persistent AgentSession executor
- containerized / remote worker executor
- database checkpoint and thread-session store
- state channel schemas and message compaction nodes
- OpenTelemetry event sink
- graph migrations and subgraph nodes

扩展必须保持控制流、state ownership、memory mode、failure semantics 和 budget 显式。
