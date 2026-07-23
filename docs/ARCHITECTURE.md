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

## 四个记忆平面

### 1. Graph state（hot working set）

```text
state.input
working.*
memory.*
result.*
conversation.messages
```

它是 JSON serializable、checkpointed、受 reducer、state policy 和 state-size limit 约束的显式记忆。条件 route 只读取 graph state。Graph state 不是全文仓库：`working` 应按轮次清理，`memory` 只保留压缩摘要，`result` 保存小型输出和 artifact 引用。

### 2. Thread private session

```text
threadKey → stable sessionId → Pi JSONL
```

它保存某个持续角色的 Pi user/assistant/tool history，不直接参与 reducer，也不自动暴露给其他角色。

### 3. Workspace / context files

代码、数据、报告、`AGENTS.md` 等由工作目录和 Pi resource loader 提供。它们是外部真实世界状态，不由 graph checkpoint 回滚。

### 4. Runtime artifacts

Agent output 可声明 `response.storage: "artifact"`。PiNodeExecutor 将完整正文写入私有、content-addressed 文件，Graph state 仅保存 URI、media type、bytes、SHA-256 和有限 preview。完整 report、branch analysis 和 debate transcript 应进入该冷存储，而不是热 state。

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
  → select only recent maxMessages
  → resolve compact state references unless already projected
  → byte-bounded role-tagged transcript
  → pi --no-session
  → capture according to policy
  → commit + optional maxStoredMessages pruning
```

Shared mode 不复用 Pi session。默认 `capture: compact` 不保存展开后的完整 user prompt；它保存一条小型 assistant message，并用 `statePath` 引用 node output 作为 canonical content。若当前 node 已经通过 template 或 `reads` 投影该路径，runtime 不再次展开引用。

`assistant-only` 保存最终 assistant 文本，通常与 `storeOutput: false` 配合；`none` 不写 channel；`full` 才保存完整 user/tool/assistant transcript，并产生 warning。

`messagesPath` 使用隐式 `concat` reducer。并行节点都读取同一个 transcript snapshot，commit 时按 scheduled order 合并。`maxMessages` / `maxPromptBytes` 限制一次模型输入；`maxStoredMessages` 在 commit 后真正裁剪 durable state。旧 compact reference 已被 state cleanup 删除时仅显示 unavailable marker，不阻塞后续运行。

## Prompt projection 与 preflight

Graph state 不会整体自动发送给模型。PiNodeExecutor 只组合：node template、shared transcript、`reads` projection、response contract 和 node system prompt。Compiler 对 template 与 `reads` 的重叠给出诊断；runtime 对精确重复路径以及 compact shared state reference 再次去重。

`pi-graph` 构造的 prompt 部分在 spawn 前计算 UTF-8 bytes，并与 node/graph `maxPromptBytes` 的较小值比较。超限时返回 `PROMPT_BUDGET_EXCEEDED`，不会发起该次模型调用。该 preflight 不包含 Pi 基础 system prompt、工具 schema、自动加载的 context/skill/extension、provider framing，或 thread session 已有私有历史；这些由实际 usage、Pi context management 和更保守的运行预算兜底。Runtime 只维护这一套 prompt byte 判断。

## Superstep 模型

每个 step：

1. 从 `pending` 得到唯一 scheduled nodes。
2. 为 scheduled thread nodes建立/恢复 thread metadata。
3. 保存 `inFlight` checkpoint。
4. 所有节点读取同一个 state snapshot。
5. 在 `maxConcurrency` 内并发运行 unresolved nodes。
6. 每个节点真实结束时立即发出只用于观测的 `node_settled`；它不代表 state 已提交。
7. 并行 batch 返回后，按 scheduled order 发出 `node_end`，并将成功结果逐个保存到 `inFlight.completed`，但不修改 shared state。
8. 所有节点解决后按 scheduled order 聚合 writes。
9. 应用 effective reducers 并原子提交新 state。
10. 增加 completion counts。
11. 计算 routes/static edges/barriers，写入下一 step 的 `pending`。

这种 bulk-synchronous 模型避免较快并行节点提前改变 sibling 正在读取的 state。

## 运行时可观测性

Extension 为每次 run/resume 建立一个仅含控制面信息的 `RuntimeGraphMonitor`。它从 graph definition 提取静态边、条件路由和错误 fallback，从 `step_start.scheduled`、node start/retry/settled/end、interrupt 与 graph end events 归约出当前节点状态。Resume 时先用 checkpoint history、pending 和 `inFlight` hydrate，再继续消费新事件。

同一份有界快照同时驱动编辑器下方的 TUI widget 和 streaming tool result。默认最多 10 行，并优先保留活动、重试、失败和排队节点，避免大型图撑满终端。Widget 是临时 UI，所有退出路径都会清理；checkpoint 和 `node_end` 仍是 durable/control-flow 事实，`node_settled` 只解决并发 batch 中“较快节点已经结束，但尚未进入 ordered reconciliation”的显示延迟。

## State commit 与生命周期

节点返回：

```ts
interface StateWrite {
  path: string;
  value?: JsonValue;
  nodeId: string;
  mode?: "reduce" | "overwrite" | "unset";
}
```

- `reduce`：使用 channel reducer；单 writer 无 reducer时等价 replace。
- `overwrite`：绕过 reducer，适合在新轮次建立干净 working set。
- `unset`：真正删除旧路径，不留下 `null` 占位。
- `append`：跨 superstep 累积历史。
- `collect`：只收集当前 superstep 的并行 writes，替换上一轮 batch。
- shared messages：隐式 concat，随后按 `maxStoredMessages` 裁剪。

Compiler 对 cyclic node 写入 `append`/`concat` channel 发出 `ACCUMULATING_REDUCER_IN_CYCLE`，除非它是配置了 `maxStoredMessages` 的有界 shared channel。父子路径并行写入、同一路径中的显式 overwrite/unset 与其他 writes 混用都会失败。Commit 后立即执行 shared retention、hot-state/per-path budget，再计算 route。

## User-facing result 与 inspect

`GraphRunResult.state` 仍是内部 durable state，但 extension 默认只渲染顶层 `result.paths` 投影；`includeState` 默认为 false。这样 100KB 内部 state 不会在 tool result 中再次进入主 Pi context。

Inspect 默认输出 checkpoint summary、pending/in-flight、usage、state 总大小和最大 paths；inventory/path/full 是显式视图。只有 full 会序列化完整 checkpoint，且仍有 byte cap。

## Routing 与 barrier

Route 在整个 step writes 提交后求值，因此 reviewer route 可以读取刚提交的 review state。第一个 case 命中；default 可选。

`onError.route` 是 node-result override：失败节点走专用 destination，不再执行正常 route/edge。

合法的业务拒绝仍是成功 node result；`maxSteps` 等 graph-level hard limit 也不会进入 node `onError`。需要降级输出的循环在 graph state 中显式计数，并在硬限制前路由到 terminal fallback，不能依赖撞限后再执行节点。

Multi-source edge 使用 completion count barrier：当每个 source count 都大于该 barrier 已消费 count 时触发一次。这支持循环中的重复 fan-in。

## Checkpoint

File checkpoint adapter 不使用需要回收的锁文件。每个 run 在 `.journal/<runId>/` 下维护 append-only 的不可变操作序列；lease acquire/renew、CAS commit、release 和 delete 都尝试用 atomic hard-link 发布唯一的下一序号文件。多个进程从同一序号出发时只有一个 link 能成功，其余进程重新读取 winner 后重试或返回 lease/revision 冲突，因此 stale owner 无法删除或覆盖新 owner 的协调状态。

Checkpoint snapshot 先写入并 `fsync` 为唯一命名的 immutable blob，journal entry 的 inode 也在 hard-link 发布前完成 `fsync`。需要对调用者确认成功的 durable 状态转换还会同步最终 journal 文件及其目录；首次创建目录时也会同步父目录。这样，即使一次非 durable lease 目录更新被稍后的目录同步一并刷盘，它也不会成为内容撕裂的最高序号。只有 journal 是 lease、revision 和 checkpoint pointer 的权威来源；根目录 `<runId>.json` 是供人工检查与备份的 best-effort 最新镜像，镜像失败不会反转已经成功的 CAS。耐久同步失败会作为 checkpoint control error 返回，不能被误报成一次成功 commit。

Journal sequence claim 永不删除或复用。保留 append-only CAS namespace 可以避免暂停进程在恢复后复用旧序号产生 ABA；代价是长运行 run 的 lease entry 与旧 checkpoint blob 会持续增长。删除 run 会清除 blob，但为了防止复活仍保留 sequence claim 和最小 tombstone，因此部署方仍需监控 inode，并在确认不存在 stale 进程且不再复用这些 `runId` 时按运维策略轮换或归档整个 checkpoint root。目录使用 `0700`，文件使用 `0600`。完整耐久语义要求同一主机、支持原子 hard-link 和目录 `fsync` 的本地文件系统，不是跨主机分布式协调协议；不支持目录同步的平台只能提供 best-effort metadata durability。

删除 run 时先发布不可变 tombstone，再移除 snapshot blobs 和根目录镜像；最小 tombstone 会保留，以阻止 stale owner 或残留旧镜像复活已经删除的 `runId`。

磁盘格式是带 revision 的 envelope：

```ts
interface CheckpointRecord {
  format: "pi-graph-checkpoint";
  formatVersion: 2;
  revision: number;
  snapshot: CheckpointSnapshot;
}
```

新 run 在 `open({ mode: "create" })` 返回前已持久化为 revision 1。Checkpoint 只接受 `formatVersion: 2` envelope；其他磁盘格式直接拒绝，不执行隐式迁移。

`CheckpointStore.open()` 在加载 resume state 或运行新节点前取得 run lease。`CheckpointRun` 在内部 heartbeat；lease 不确定或丢失时 abort 自己的 signal。`commit()` 同时验证 owner、expiry 和 expected revision，成功后 revision 精确加一。CAS/lease/schema 错误不会被 engine 转写成一个新的 failed checkpoint。

```ts
interface CheckpointRun {
  readonly runId: string;
  readonly revision: number;
  readonly snapshot: CheckpointSnapshot;
  readonly signal: AbortSignal;
  commit(snapshot: CheckpointSnapshot): Promise<void>;
  close(): Promise<void>;
}
```

加载、创建和每次 commit 共用同一个 strict validator。除开放的 JSON state/value 外，所有 control objects 都拒绝未知字段；validator 覆盖 usage、history、threads、in-flight success results、writes、interrupt、UUID session IDs、有限非负整数、规范时间戳、plain JSON object 以及 status-specific invariants。Snapshot 必须显式包含 `threads`。`running` 不得携带 interrupt/error/end，`interrupted` 必须指向 unresolved in-flight node，terminal 状态必须满足各自的 end/error 约束。

```ts
interface CheckpointSnapshot {
  version: 2;
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
  threads: Record<string, AgentThreadState>;
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

并行 step 运行 A、B、C。整个 batch 返回后：

- A 成功并 checkpoint
- B 成功并 checkpoint
- C 返回失败并保留在 unresolved

恢复后只执行 C；随后 A/B/C writes 一起 commit。

如果进程在整个 batch 返回前退出，A/B 即使已在进程内完成也还没有进入 `inFlight.completed`，恢复时仍会重跑。未过期 lease 会阻止第二个执行者进入同一 run；但旧进程暂停超过 TTL 后，新 owner 可以接管，旧进程恢复时仍可能在下一次 heartbeat 或 commit 发现失租前短暂继续执行。Lease/CAS 只 fence checkpoint 协调状态，不能把外部副作用变成 exactly-once；node 仍应幂等，或使用下游 idempotency key/fencing token。

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
