# pi-graph `schemaVersion: 2`

本文档描述 `pi-graph` 的 UTF-8 JSON graph definition。版本 2 使用唯一的 prompt、output 与 state byte limits，并只保留具有运行语义的 reviewer purpose。`agent.context` 未声明时默认 `isolated`。

所有 graph 控制对象都使用精确字段集合；未知字段会以 `UNKNOWN_FIELD` 拒绝，避免拼写错误被静默忽略。`initialState`、assignment/condition 的 `value` 等业务 JSON 数据仍允许任意键。

## 顶层字段

```ts
interface GraphDefinition {
  schemaVersion: 2;
  name: string;
  description?: string;
  entry: string | string[];
  initialState?: JsonObject;
  nodes: Record<string, NodeDefinition>;
  edges?: EdgeDefinition[];
  routes?: RouteDefinition[];
  reducers?: Record<string, ReducerName>;
  limits?: GraphLimits;
  statePolicy?: GraphStatePolicy;
  policy?: GraphPolicy;
  result?: GraphResultPolicy;
}
```

### `schemaVersion`

必须为 `2`。其他版本会被拒绝，不执行自动迁移。

### 从 v1 手工迁移

Runtime 不兼容 v1；旧 graph 必须先完成以下一次性编辑：

- 将 `schemaVersion` 改为 `2`；
- 将 node `limits.maxOutputBytes` 移到 `response.maxBytes`；
- 将 graph/node `maxEstimatedInputTokens: N` 改为 `maxPromptBytes`；要保持旧估算阈值可使用 `3N` bytes；
- 将 `statePolicy.maxHotStateBytes` 移到顶层 `limits.maxStateBytes`；
- 删除非 `reviewer` 的 `purpose`，并且只在 agent node 上保留 reviewer；
- 不恢复旧 checkpoint，使用迁移后的 graph 启动新 run。

迁移完成后运行 `npm run validate:examples` 或 `/pi-graph validate <graph>`；compiler 不代填、归一或保留旧字段。

### `name`

图的发现名。`scope: "both"` 时项目图覆盖同名用户图。

### `entry`

首个节点，或第一 superstep 中并行运行的节点数组。`"__end__"` 表示空运行。

### `initialState`

初始 shared state。调用输入深合并到 `state.input`：

```json
{
  "initialState": {
    "quality": { "minimumScore": 0.8 },
    "input": { "language": "zh-CN" }
  }
}
```

调用输入：

```json
{ "task": "Write a brief", "language": "en-US" }
```

得到：

```json
{
  "quality": { "minimumScore": 0.8 },
  "input": { "task": "Write a brief", "language": "en-US" }
}
```

## 节点公共字段

```ts
interface BaseNodeDefinition {
  type: "agent" | "set" | "human";
  description?: string;
  reads?: string[];
  output?: string;
  retry?: RetryPolicy;
  onError?: NodeErrorPolicy;
  limits?: NodeLimits;
  idempotent?: boolean;
}
```

### State path

路径使用点号：

```text
research.repository
review.approved
input.task
```

空段以及 `__proto__`、`prototype`、`constructor` 被拒绝。数组索引不作为特殊语法处理。

### `reads`

声明节点依赖的 state paths。对 agent 节点，这些值会附加到 prompt 的 `Selected shared state` JSON 中；模板引用仍独立工作。相同精确路径同时出现在模板和 `reads` 时，编译器给出 `DUPLICATE_STATE_INJECTION`，runtime 省略重复的 `reads` payload。父子路径重叠不会被自动删除，因为这可能丢失 sibling 字段；编译器给出 `OVERLAPPING_STATE_INJECTION`，图作者应显式选择一种投影。

### `output`

`agent` 和 `human` 节点的写入路径，缺省为 `outputs.<nodeId>`。`set` 使用 assignment 自己的路径。

## Agent node

```ts
interface AgentNodeDefinition {
  type: "agent";
  purpose?: "reviewer";
  prompt: string;
  systemPrompt?: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  tools?: string[];
  readOnly?: boolean;
  cwd?: string;
  loadExtensions?: boolean;
  loadSkills?: boolean;
  loadPromptTemplates?: boolean;
  includeContextFiles?: boolean;
  context?: AgentContextPolicy;
  response?: {
    format?: "text" | "json";
    maxBytes?: number;
    storeOutput?: boolean;       // default true
    storage?: "state" | "artifact"; // default state
    mediaType?: string;
    previewBytes?: number;
  };
}
```

`purpose` 只存在于 agent node，且只接受 `"reviewer"`：它加入独立审阅提示，并触发 reviewer 安全诊断。其他职责直接通过节点的 prompt、tools、context 与 graph topology 表达。

### Prompt template

`{{ dotted.path }}` 从当前 superstep 的 state snapshot 读取：

```json
{
  "prompt": "Task: {{input.task}}\nDraft: {{draft}}\nReview: {{review}}"
}
```

object/array 格式化为 JSON；不存在路径渲染为空字符串。

## Agent context

```ts
interface AgentContextPolicy {
  mode?: "isolated" | "thread" | "shared"; // default isolated
  threadKey?: string;                        // thread only
  messagesPath?: string;                     // shared only, default messages
  maxMessages?: number;                      // prompt projection, default 32
  maxPromptBytes?: number;                   // transcript projection, default 65536
  maxMessageBytes?: number;                  // per captured message, default 8192
  maxStoredMessages?: number;                // durable retention bound
  capture?: "none" | "compact" | "assistant-only" | "full"; // default compact
}
```

### `isolated`

```json
{
  "context": { "mode": "isolated" }
}
```

每次 node run 使用：

```text
pi --mode json -p --no-session --no-approve ...
```

没有私有跨节点消息历史。数据通过 graph state、文件系统或 Pi context files 传递。

### `thread`

```json
{
  "context": {
    "mode": "thread",
    "threadKey": "coder"
  }
}
```

相同 `threadKey` 复用一个持久 Pi session。未指定时 key 默认为 node id。

规则：

- `threadKey` 非空，最长 128 字符，不允许控制字符和原型污染保留名。
- 同一 key 的节点必须具有相同规范化 `cwd`。
- 同一 key 不能在一个 superstep 内并发执行；编译器检查显式 fan-out，运行时再次检查实际 scheduled set。
- graph checkpoint 保存 key 到稳定 session ID 的映射。
- 私有 session 文件丢失时 fail closed，不会自动用空 session 替代已使用记忆。
- `retry.maxAttempts > 1` 会产生 `THREAD_RETRY_APPENDS_HISTORY` warning，因为重试复用同一 Pi session。

### `shared`

```json
{
  "context": {
    "mode": "shared",
    "messagesPath": "conversation.messages",
    "maxMessages": 32,
    "maxPromptBytes": 65536
  }
}
```

`messagesPath` 必须是合法 state path，且不能与该节点 `output` 路径形成父子重叠。该 path 自动获得 `concat` reducer；显式配置非 `concat` reducer 会报错。

成功 node run 可追加如下 message：

```ts
interface GraphMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  nodeId: string;
  createdAt: string;
  name: string | null;
  statePath: string | null;
}
```

Capture modes：

- `compact`（默认）：保存小型 assistant 引用；正文由 `statePath` 指向节点 output，避免 state 内精确副本。若当前节点已通过 template/`reads` 投影该路径，runtime 不再展开引用。
- `assistant-only`：只保存最终 assistant 文本。配合 `response.storeOutput: false` 可让 shared channel 成为唯一副本。
- `none`：不写消息，也不安装隐式 reducer。
- `full`：保存展开后的 user instruction、assistant/tool 过程消息；会产生 `SHARED_FULL_CAPTURE` warning。

新节点只解析最近 `maxMessages` 条，并从尾部按 `maxPromptBytes` 限制 transcript。`maxStoredMessages` 与此不同：它在每次 superstep commit 后裁掉 durable channel 中最旧消息；多个节点对同一 channel 设置不同值时采用较小值。旧引用路径已被 cleanup 删除时，transcript 显示 unavailable marker，而不会让无关旧消息阻塞恢复。

Shared messages 和普通 output 属于同一 node result，只有成功并完成 superstep commit 时才写入 state。

### 字段互斥

- `threadKey` 只适用于 `thread`。
- `messagesPath`、`maxMessages`、`maxPromptBytes`、`maxMessageBytes`、`maxStoredMessages`、`capture` 只适用于 `shared`。
- reviewer 使用非 `isolated` context 会产生独立性 warning。

## Process 与资源继承

所有 agent node 都使用 Pi JSON mode 和 print mode。默认添加：

```text
--no-approve --no-extensions --no-skills --no-prompt-templates
```

- `isolated` / `shared` 额外使用 `--no-session`。
- `thread` 使用 graph-owned explicit Pi session file。
- 设置对应 `load*` 字段为 `true` 才继承资源。
- `includeContextFiles: false` 添加 `--no-context-files`。

### Tools

`readOnly: true` 时允许：

```text
read, grep, find, ls
```

未指定 `tools` 时 read-only 节点默认获得四个只读工具。非 read-only 节点默认获得：

```text
read, bash, edit, write
```

`tools: []` 传递 `--no-tools`。加载 extensions 时仍通过 `--exclude-tools` 禁用三个 pi-graph tools，避免递归。

### Response 与 artifact storage

```json
{
  "output": "result.report",
  "response": {
    "format": "text",
    "maxBytes": 65536,
    "storage": "artifact",
    "mediaType": "text/markdown",
    "previewBytes": 2048
  }
}
```

`format: "json"` 时最终 assistant text 必须是单个合法 JSON value。这个字段会向模型追加输出契约并在返回后解析文本，但不是 provider 级 schema 强制；语法错误是可重试 node failure，合法 JSON 的字段与类型不做额外校验。需要固定 shape 时，图仍应通过 reviewer/router/fallback 验证结构。`storeOutput: false` 不写 `output` 路径；常用于 `assistant-only` shared channel。`storage: "artifact"` 将完整输出写到 runtime-managed artifact 目录，state 只保存：

```json
{
  "kind": "artifact",
  "uri": "...",
  "mediaType": "text/markdown",
  "bytes": 18342,
  "sha256": "...",
  "preview": "..."
}
```

Artifact 文件使用 content hash 命名和私有权限；它适合完整 report、branch analysis 和 transcript。Artifact reference 必须写入 state，因此 `storage: "artifact"` 与 `storeOutput: false` 组合会报 `ARTIFACT_REFERENCE_NOT_STORED`。

## Set node

```ts
interface SetNodeDefinition {
  type: "set";
  assign: Array<{
    path: string;
    value?: JsonValue;
    template?: string;
    from?: string;
    mode?: "reduce" | "overwrite" | "unset";
  }>;
}
```

默认 `mode: "reduce"`，每个 assignment 必须且只能指定一个 source。`overwrite` 绕过该 path 的 reducer；`unset` 不允许 source，并真正删除路径：

```json
{ "path": "status", "value": "ready" }
```

```json
{ "path": "summary", "template": "Task {{input.task}} is {{status}}" }
```

```json
{ "path": "archive.finalDraft", "from": "draft" }
```

```json
{ "path": "working.branch_results", "value": [], "mode": "overwrite" }
```

```json
{ "path": "working", "mode": "unset" }
```

## Human node

```ts
interface HumanNodeDefinition {
  type: "human";
  kind?: "confirm" | "input" | "select";
  prompt: string;
  options?: string[];
  pause?: boolean;
}
```

- `confirm` 输出 boolean
- `input` 输出提交的 JSON value 或文本
- `select` 输出 options 中一个 string
- `pause: true` 总是 interrupt 并要求显式 resume

非交互模式或 UI 取消输入时，节点保存 interrupt checkpoint。

## Edges

```ts
interface EdgeDefinition {
  from: string | string[];
  to: string | string[];
}
```

Sequential：

```json
{ "from": "research", "to": "write" }
```

Fan-out：

```json
{ "from": "research", "to": ["security", "performance", "ux"] }
```

Fan-in barrier：

```json
{ "from": ["security", "performance", "ux"], "to": "synthesize" }
```

每个 source 的 completion count 都超过该 barrier 已消费 count 时触发一次。

## Conditional routes

```ts
interface RouteDefinition {
  from: string;
  cases: Array<{ when: Condition; to: string | string[] }>;
  default?: string | string[];
}
```

按顺序选择第一个匹配 case。没有匹配且无 default 时不产生 destination。普通 edge 与 route 可共存。

Leaf condition：

```json
{
  "path": "review.score",
  "op": "gte",
  "value": 0.8
}
```

Operators：

- `eq`, `ne`
- `gt`, `gte`, `lt`, `lte`
- `exists`, `truthy`
- `includes`, `matches`

Boolean composition：

```json
{
  "all": [
    { "path": "review.approved", "op": "eq", "value": true },
    { "not": { "path": "risk.blocked", "op": "truthy" } }
  ]
}
```

## Reducers

```json
{
  "reducers": {
    "research.notes": "append",
    "metrics.tokens": "sum",
    "facts": "merge"
  }
}
```

Reducer 只按完整路径匹配。

- `replace`：后一个写按 deterministic scheduled order 覆盖
- `append`：每个 write 作为一个 item 追加，并跨 superstep 保留旧值
- `collect`：只收集当前 superstep 的 writes 成数组，替换该 path 的旧轮次；用于并行 fan-in + refinement loop
- `concat`：incoming array 展开拼接并保留旧值
- `merge`：递归 deep-merge objects
- `sum`, `min`, `max`：只接受 number

Capture 非 `none` 的 shared message path 是隐式 `concat` channel，也会出现在 compiled graph 的 effective reducers 中。若 cyclic node 持续写入 `append` 或 `concat` path，编译器给出 `ACCUMULATING_REDUCER_IN_CYCLE`；使用 `collect`、每轮 `overwrite`/`unset`，或为 shared channel 设置 `maxStoredMessages`。该诊断用于防止 refinement loop 无界增长，不改变 reducer 的运行时语义。

## Retry

```ts
interface RetryPolicy {
  maxAttempts?: number;       // default 1
  backoffMs?: number;         // default 0
  backoffMultiplier?: number; // default 2, minimum 1
}
```

Retry 计入 `maxNodeRuns`，所有 attempt usage 均计入预算。Side-effect node 必须真正实现幂等。Thread retry 还会改变私有 session history。

## Error policy

```ts
interface NodeErrorPolicy {
  strategy?: "fail" | "continue" | "route";
  to?: string | string[];
  output?: string;
}
```

结构化错误：

```json
{
  "message": "...",
  "code": "AGENT_FAILED",
  "retryable": true,
  "attempts": 2
}
```

默认写入 `errors.<nodeId>`。

- `continue`：继续正常 routing
- `route`：用 `to` 替代正常 routing
- `fail`：停止图并保留 unresolved checkpoint

`to` 只对 `strategy: "route"` 有意义，并且此时必填；`fail` 或 `continue` 携带 `to` 会在编译期报错，避免可达性分析与运行时行为分裂。

`onError` 只处理某次 node execution 最终返回的 failure。业务拒绝（例如合法 JSON 中的 `approved: false`）属于 success；`maxSteps`、graph timeout 等 graph-level limit 也不进入 node `onError`。

## Limits

```ts
interface GraphLimits {
  maxSteps?: number;
  maxNodeRuns?: number;
  maxConcurrency?: number;
  maxCostUsd?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxStateBytes?: number;
  maxPromptBytes?: number;
}
```

缺省硬限制：

```json
{
  "maxSteps": 32,
  "maxNodeRuns": 128,
  "maxConcurrency": 4,
  "maxCostUsd": 10,
  "maxTokens": 1000000,
  "timeoutMs": 1800000,
  "maxStateBytes": 2097152,
  "maxPromptBytes": 262144
}
```

Node limits：

```ts
interface NodeLimits {
  timeoutMs?: number;
  maxTurns?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxPromptBytes?: number;
}
```

Graph 与 node limits 同时生效，采用更小的 `maxPromptBytes`。Preflight byte 计算包含 `pi-graph` 构造的 node instruction、shared transcript、`reads` JSON、response contract 和 node system prompt，并在启动 Pi 进程前检查。它不包含 Pi 自身的基础 system prompt、工具 schema、自动加载的 context/skill/extension、provider 包装开销，或 thread session 的既有私有历史；实际 usage 仍进入运行预算。Agent 输出大小只由 `response.maxBytes` 限制。

所有 limit 都是硬 guardrail，不会调度一个额外 fallback step。需要 best-effort 或人工升级的循环必须在 state 中显式记录轮数，并在达到 `maxSteps` 前完成 fallback 路由；预算时要为 counter/router 和 terminal node 保留 superstep。

## State size policy

```ts
interface GraphStatePolicy {
  paths?: Record<string, { maxBytes?: number }>;
}
```

每个 superstep commit 后检查完整 state 和精确 path 大小。Path policy 只支持精确 dotted path，不是 glob。完整 state 统一使用 `limits.maxStateBytes`。

```json
{
  "limits": {
    "maxStateBytes": 131072
  },
  "statePolicy": {
    "paths": {
      "working.reviewed_evidence": { "maxBytes": 8192 },
      "working.debate.messages": { "maxBytes": 16384 }
    }
  }
}
```

## Result projection

```ts
interface GraphResultPolicy {
  paths?: string[];
  includeState?: boolean; // default false
  maxBytes?: number;      // default 16384
}
```

GraphRunResult 内部仍携带 durable state，但 Pi tool/TUI 默认只渲染 `result.paths`。未声明 paths 时依次尝试 `result`、`report` 或单一 `outputs`。只有显式 `includeState: true` 才把完整 state 返回给主 Pi。

```json
{
  "result": {
    "paths": ["result.executive_summary", "result.report_artifact"],
    "includeState": false,
    "maxBytes": 8192
  }
}
```

## 关键编译诊断

与 state/token 卫生直接相关的诊断：

- `DUPLICATE_STATE_INJECTION`：相同路径同时出现在模板和 `reads`；runtime 会去掉精确重复。
- `OVERLAPPING_STATE_INJECTION`：模板和 `reads` 使用父子重叠路径；必须由图作者选择。
- `SHARED_MESSAGES_DUPLICATE_READ` / `SHARED_MESSAGES_DUPLICATE_TEMPLATE`：shared channel 已自动注入，禁止再次读取或插值。
- `SHARED_OUTPUT_DUPLICATED`：assistant-only/full capture 与普通 output 同时保存同一最终正文。
- `SHARED_FULL_CAPTURE`：完整展开 prompt 和 process transcript 将进入 state。
- `ARTIFACT_REFERENCE_NOT_STORED`：Artifact 已创建但 reference 被配置为不写 state。
- `ACCUMULATING_REDUCER_IN_CYCLE`：循环中的 `append`/`concat` path 可能跨轮无界增长。

Warnings 不会自动改变 Graph；`run` 仍会先编译，errors 会阻止任何 node 启动。

## Policy

```ts
interface GraphPolicy {
  allowNonInteractive?: boolean;
  allowNonInteractiveMutations?: boolean;
  confirmProjectGraph?: boolean;
  confirmMutatingNodes?: boolean;
}
```

默认：

- `allowNonInteractive: false`
- `allowNonInteractiveMutations: false`
- `confirmProjectGraph: true`
- `confirmMutatingNodes: true`
