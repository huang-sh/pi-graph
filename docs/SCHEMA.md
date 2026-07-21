# pi-graph `schemaVersion: 1`

本文档描述 `pi-graph` 的 UTF-8 JSON graph definition。0.2.0 在不改变 schema version 的前提下增加 `agent.context`；未声明该字段时默认 `isolated`，旧图保持兼容。

## 顶层字段

```ts
interface GraphDefinition {
  schemaVersion: 1;
  name: string;
  description?: string;
  entry: string | string[];
  initialState?: JsonObject;
  nodes: Record<string, NodeDefinition>;
  edges?: EdgeDefinition[];
  routes?: RouteDefinition[];
  reducers?: Record<string, ReducerName>;
  limits?: GraphLimits;
  policy?: GraphPolicy;
}
```

### `schemaVersion`

必须为 `1`。

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
  purpose?: "worker" | "reviewer" | "router" | "deterministic";
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

声明节点依赖的 state paths。对 agent 节点，这些值会附加到 prompt 的 `Selected shared state` JSON 中；模板引用仍独立工作。

### `output`

`agent` 和 `human` 节点的写入路径，缺省为 `outputs.<nodeId>`。`set` 使用 assignment 自己的路径。

## Agent node

```ts
interface AgentNodeDefinition {
  type: "agent";
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
  };
}
```

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
  maxMessages?: number;                      // shared only, default 32
  maxPromptBytes?: number;                   // shared only, default 65536
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

成功 node run 追加的 message shape：

```ts
interface GraphMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  nodeId: string;
  createdAt: string;
  name: string | null;
}
```

新节点从 state snapshot 读取最近 `maxMessages` 条，并从尾部按 `maxPromptBytes` 限制生成 role-tagged transcript。它仍运行在新的 `--no-session` Pi 子进程中。

Shared messages 和普通 output 属于同一 node result，只有成功并完成 superstep commit 时才写入 state。

### 字段互斥

- `threadKey` 只适用于 `thread`。
- `messagesPath`、`maxMessages`、`maxPromptBytes` 只适用于 `shared`。
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

### JSON response

```json
{
  "response": {
    "format": "json",
    "maxBytes": 32768
  }
}
```

最终 assistant text 必须是单个合法 JSON value。允许一个完整 `json` Markdown fence，但推荐纯 JSON。

## Set node

```ts
interface SetNodeDefinition {
  type: "set";
  assign: Array<{
    path: string;
    value?: JsonValue;
    template?: string;
    from?: string;
  }>;
}
```

每个 assignment 必须且只能指定一个 source：

```json
{ "path": "status", "value": "ready" }
```

```json
{ "path": "summary", "template": "Task {{input.task}} is {{status}}" }
```

```json
{ "path": "archive.finalDraft", "from": "draft" }
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
- `append`：每个 write 作为一个 item 追加
- `concat`：incoming array 展开拼接
- `merge`：递归 deep-merge objects
- `sum`, `min`, `max`：只接受 number

Shared message path 是隐式 `concat` channel，也会出现在 compiled graph 的 effective reducers 中。

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
  "maxStateBytes": 2097152
}
```

Node limits：

```ts
interface NodeLimits {
  timeoutMs?: number;
  maxTurns?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxOutputBytes?: number;
}
```

Graph 与 node limits 同时生效。

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
