# pi-graph

**中文** | [English](README.en.md)

为 [Pi agent harness](https://github.com/earendil-works/pi) 提供可恢复、可审计的状态图编排。

`pi-graph` 用显式的 state、nodes、edges 和 reducers 组织复杂 Agent 工作流，适合需要并行研究、专业分工、独立审查、人工审批或失败恢复的任务。它借鉴了 [LangGraph](https://github.com/langchain-ai/langgraph) 和 Pregel 的执行模型，但所有节点仍由 Pi 运行。

当前版本：**0.0.3** · 图格式：**`schemaVersion: 2`**

> 简单任务优先使用一个 Pi agent loop。只有当流程确实需要并行 fan-out/fan-in、不同模型或工具、独立 reviewer、持久角色记忆、人工门控或故障隔离时，图编排才值得引入。

## 它解决什么问题

普通的 Agent loop 擅长在一个上下文里持续工作，但复杂任务往往还需要：

- 让多个研究节点并行执行，并在全部完成后汇总；
- 让实现者保留自己的工作记忆，同时让 reviewer 保持独立；
- 把节点间交接写入显式状态，而不是依赖隐藏的聊天历史；
- 在人工审批、进程退出或节点失败后，从 checkpoint 继续；
- 为步骤数、并发、token、成本、超时和状态大小设置硬上限。

`pi-graph` 将这些控制流和状态语义写进 JSON 图定义，使工作流可以验证、检查、可视化和恢复。

## 核心能力

- `agent`、`set`、`human` 三类节点；
- 静态边、条件路由、循环、并行 fan-out 和 barrier fan-in；
- `isolated`、`thread`、`shared` 三种 Agent 上下文模式；
- 每节点独立配置 model、thinking、tools、cwd、预算和资源继承；
- 基于 reducer 的确定性并行状态合并，包括只收集当前 superstep 的 `collect`；
- `overwrite` / `unset` 状态写入、shared 消息保留上限和按路径 state budget；
- Graph 构造部分的 prompt 调用前 byte 预算与重复 state 注入去重；
- runtime-managed artifacts、结果投影和按路径 inspect，避免把全文塞回主 Agent；
- 原子 state commit、节点重试、错误继续和 fallback 路由；
- durable checkpoint、进程重启恢复和人工 interrupt/resume；
- graph/node 级 step、node-run、并发、token、cost、timeout、output 和 state-size 限制；
- 项目图 trust gate、写工具确认和非交互执行策略；
- 运行时节点看板，以及运行前 Mermaid 图可视化；
- Pi tools：`pi_graph_run`、`pi_graph_resume`、`pi_graph_inspect`；
- Pi command：`/pi-graph`。

## 快速开始

### 1. 安装

要求 Node.js `>= 22.19.0`，并已安装 Pi。

在本仓库根目录安装：

```bash
pi install .
```

开发时也可以直接加载扩展：

```bash
pi --no-extensions -e ./extensions/pi-graph.ts
```

运行时除 Pi 提供的 peer packages 和 Node.js 内置模块外，不引入额外依赖。

### 2. 安装示例图

用户图默认从 `~/.pi/agent/graphs/*.json` 发现：

```bash
mkdir -p ~/.pi/agent/graphs
cp examples/research-review.json ~/.pi/agent/graphs/
```

### 3. 验证并运行

启动 Pi 后执行：

```text
/pi-graph list
/pi-graph validate research-review
/pi-graph visualize research-review
/pi-graph run research-review 为这个仓库设计一个安全的缓存失效方案
```

如果图在 `human` 节点暂停，命令会返回 `runId`：

```text
/pi-graph resume <runId> true
```

也可以让模型调用 `pi_graph_run`：

```json
{
  "graph": "research-review",
  "task": "为这个仓库设计一个安全的缓存失效方案",
  "checkpoint": true
}
```

## 工作方式

图运行时，初始输入写入 `state.input`。每个 superstep 中的节点读取同一份不可变状态快照；所有成功写入在 step 结束时一次性提交，然后再计算下一批节点。

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

这种 bulk-synchronous 语义带来两个重要保证：

1. 节点不会看到同一 superstep 中其他节点的半完成结果；
2. 并行节点写入同一路径时，必须显式声明 reducer，否则运行失败。

### 节点类型

| 类型 | 用途 | 是否调用 Agent |
|---|---|---|
| `agent` | 研究、实现、审查等非确定性任务 | 是 |
| `set` | 确定性地写入或转换 state | 否 |
| `human` | 请求批准、选择或补充输入 | 否，暂停并等待 resume |

### 三种上下文模式

每个 `agent` 节点都应根据职责选择上下文语义：

| 模式 | 记忆方式 | 适合场景 |
|---|---|---|
| `isolated` | 每次启动全新 Pi 子进程；只通过 state、文件和 context files 传递信息 | 独立 reviewer、并行研究、一次性专家 |
| `thread` | 相同 `threadKey` 复用私有 Pi JSONL session | 实现—审查—修复循环、持续研究员 |
| `shared` | role-tagged messages 显式写入 graph state，并投影到后续 prompt | 可审计 handoff、ReAct 风格连续协作 |

未声明 `context` 的节点按 `isolated` 运行。

#### `isolated`：独立判断

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

节点不会继承其他节点的 Pi 消息历史。跨节点信息必须放在 graph state、共享工作目录中的真实产物，或稳定的 Pi context files 中。

#### `thread`：私有持久会话

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

具有相同 `threadKey` 的节点会顺序复用同一个 Pi session，适合让同一职责在循环中保持工作记忆：

```text
planner(threadKey=coder)
  → implementer(threadKey=coder)
  → reviewer(isolated)
  → implementer(threadKey=coder)
```

Thread metadata 保存在 graph checkpoint，私有 session 默认位于：

```text
~/.pi/agent/pi-graph/threads/<runId>/<sessionId>.jsonl
```

同一 `threadKey` 不能在一个 superstep 内并发运行，也不能跨不同 `cwd`。如果已经使用的 session 文件丢失，恢复会直接失败，不会静默创建一段新的角色记忆。

Thread retry 会继续向同一 session 追加 prompt。生产图通常应将 thread 节点的 `maxAttempts` 设为 `1`，并用显式 graph loop 处理修订。

#### `shared`：可审计消息通道

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

`shared` 并不是让多个节点共用隐藏的 Pi session。它把 role-tagged messages 作为普通 graph state 投影到新进程的 prompt，因此消息可以被检查、裁剪、合并和 checkpoint。失败或中断节点的半完成消息不会提交。

默认 `capture: "compact"`：只保存一条很小的 assistant 引用消息，正文仍以节点 `output` 路径为唯一事实来源；运行时在后续 prompt 已显式读取同一路径时不会再次展开该引用。可选模式还有：

- `none`：不写 shared message；
- `assistant-only`：只把最终 assistant 文本写入 channel，适合 `storeOutput: false` 的单一副本；
- `full`：保存完整展开后的 user prompt 和过程消息，仅在确实需要完整 transcript 时使用。

`maxMessages` 只控制一次 prompt 投影；`maxStoredMessages` 则在每次 state commit 后删除最旧消息，给 durable channel 设置真正的保留上限。

选择规则可以简化为：

```text
同一职责需要跨循环保持私有工作记忆  → thread
多个节点需要共享可审计对话历史      → shared
节点需要独立判断或并行隔离          → isolated
普通确定性状态转换                  → set
需要人工批准或输入                  → human
```

## State 与 token 卫生

Graph state 应是有限的热工作集，而不是全文仓库。推荐分为：

```text
working  当前轮临时状态，refinement 前显式 unset
memory   跨轮保留的紧凑摘要
result   最终摘要和 artifact 引用
```

关键机制：

- 并行分支跨轮不累积：使用 `collect`，它只收集当前 superstep 的 writes；
- 清理过期路径：`set.assign[].mode` 使用 `overwrite` 或 `unset`；
- 避免 prompt 重复：同一路径不要同时出现在 `{{template}}` 和 `reads`；编译器会给出 `DUPLICATE_STATE_INJECTION`，运行时也会去重；
- 大型 report/transcript：使用 `response.storage: "artifact"`，state 只保存 URI、hash、bytes 和 preview；
- 调用前阻断过大的 Graph prompt 投影：设置 graph/node `maxPromptBytes`；
- 控制 state：完整大小使用 `limits.maxStateBytes`，精确路径使用 `statePolicy.paths`；
- 控制返回内容：使用顶层 `result.paths`，默认不会把完整 state 返回给主 Pi。

示例：

```json
{
  "reducers": {
    "working.branch_results": "collect"
  },
  "limits": {
    "maxStateBytes": 131072
  },
  "statePolicy": {
    "paths": {
      "working.reviewed_evidence": { "maxBytes": 8192 }
    }
  },
  "result": {
    "paths": ["result.executive_summary", "result.report_artifact"],
    "includeState": false,
    "maxBytes": 8192
  }
}
```

Prompt preflight 覆盖 `pi-graph` 自己构造的 node instruction、shared transcript、`reads`、response contract 和 node system prompt。它不包含 Pi 自身的基础 system prompt、工具 schema、自动加载的 context/skill/extension、provider 包装开销，或 thread session 已有私有历史；这些仍应通过实际 usage、上下文压缩和保守预算管理。

## 最小图定义

下面的图由 researcher 产出资料，writer 保留自己的修订上下文，reviewer 独立判断是否结束：

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

完整字段见 [Graph Schema](docs/SCHEMA.md)。

## State、reducers 与控制流

节点通过 `{{path.to.value}}` 模板和可选的 `reads` 读取 state，通过 `output`、`set.assign` 或 shared message channel 写入 state。

并行写入同一路径时，需要为该路径配置 reducer：

- `replace`
- `append`：跨 superstep 累积历史
- `collect`：只收集当前 superstep，替换旧轮次
- `concat`
- `merge`
- `sum`
- `min`
- `max`

父路径和子路径不能在同一 superstep 中同时写入。`set.assign[].mode` 默认为 `reduce`；`overwrite` 绕过 reducer，`unset` 真正删除路径。编译器会对循环中由节点持续写入的 `append`/`concat` channel 给出 `ACCUMULATING_REDUCER_IN_CYCLE` 警告；有界 shared channel（配置 `maxStoredMessages`）除外。

常见控制流写法：

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

条件 DSL 不使用 `eval`。它支持 `eq`、`ne`、`gt`、`gte`、`lt`、`lte`、`exists`、`truthy`、`includes`、`matches`，以及组合条件 `all`、`any`、`not`。

## 图发现与命令

图从两个位置发现：

| Scope | 路径 |
|---|---|
| 用户图 | `~/.pi/agent/graphs/*.json` |
| 项目图 | `<project>/.pi/graphs/*.json` |

当 scope 为 `both` 时，项目图按 `name` 覆盖同名用户图。项目图只有在 Pi 信任当前项目后才会被发现；工具只接受已发现的图名，不接受任意文件路径。

可用命令：

```text
/pi-graph list
/pi-graph validate [graph]
/pi-graph run <graph> [task or JSON object]
/pi-graph resume <runId> [value or JSON]
/pi-graph inspect [runId] [--full|--inventory|state.path]
/pi-graph visualize <graph>
```

对应的模型工具：

| Tool | 作用 |
|---|---|
| `pi_graph_run` | 按图名执行，输入写入 `state.input` |
| `pi_graph_resume` | 按 `runId` 恢复，并可提交人工输入 |
| `pi_graph_inspect` | 默认查看 checkpoint 摘要/最大 state paths；也可按 path、inventory 或显式 full 查看 |

### Inspect 不再倾倒完整 checkpoint

默认：

```text
/pi-graph inspect <runId>
```

返回 status、usage、pending/in-flight、state 总字节数和最大的 state paths。定向查看：

```text
/pi-graph inspect <runId> --inventory
/pi-graph inspect <runId> working.reviewed_evidence
/pi-graph inspect <runId> --full
```

只有 `--full` 会输出完整 checkpoint，并仍受输出 byte 上限约束。

## 可视化与示例

图通过 `/pi-graph run`、`/pi-graph resume`、`pi_graph_run` 或 `pi_graph_resume` 执行时，编辑器下方会自动出现一个最多 10 行的实时看板。它显示当前 superstep、活动/完成节点数、节点的 queued/running/retrying/failed 状态、后续边或路由、耗时、token 和成本；运行结束或异常退出时自动清理。模型调用工具时，同一份快照也会进入增量 tool result，不再显示空白的运行中卡片。

`/pi-graph visualize <graph>` 会从已发现且通过编译的图定义生成 Mermaid `flowchart LR`，便于在运行前检查入口、并行分支、barrier 和条件回环。

### 并行研究、持久 writer 与独立 reviewer

[研究—审查示例](examples/research-review.json)包含并行 isolated research、barrier 汇合、thread writer、独立 reviewer、缺失证据回补和有界 best-effort 退出：

![research-review graph](docs/images/research-review.svg)

### 实现、审查与人工批准

[代码审查示例](examples/coding-review.json)包含 thread coder、独立 reviewer、human approval 和条件回环：

![coding-review graph](docs/images/coding-review.svg)

### 完整示例列表

| 示例 | 展示能力 |
|---|---|
| [research-review](examples/research-review.json) | 并行研究、barrier、证据回补、thread writer、独立 reviewer、有界降级 |
| [coding-review](examples/coding-review.json) | 持久 coder、独立审查、人工批准、修订循环 |
| [shared-handoff](examples/shared-handoff.json) | shared message channel、独立 reviewer |
| [idea-tournament](examples/idea-tournament.json) | 三路 fan-out、`append` reducer、barrier judge |
| [science-research](examples/science-research.json) | 人工 scope 门控、当前轮 `collect`、有界 shared 辩论、显式 cleanup、artifact 报告 |
| [science-research-auto](examples/science-research-auto.json) | 面向 headless/CI 的全自动版本，保留同样的有界 state 与 artifact 语义 |

编辑 `examples/*.json` 后可重新生成仓库中的 SVG：

```bash
npm run render:graphs
```

## Checkpoint、恢复与错误处理

Checkpoint 默认写入：

```text
~/.pi/agent/pi-graph/runs/<runId>.json
```

这个文件是便于检查和备份的最新 checkpoint 镜像；lease、revision 和 CAS 的权威状态位于同目录下的 `.journal/<runId>/`。Journal 只追加不可变操作记录和 checkpoint blob，并通过原子 hard-link 争抢唯一的下一序号；序号 claim 不删除、不复用，从协议上避免暂停进程恢复后的 ABA。

每个持久化 run 在执行前都会取得独占 lease，并在运行期间自动续租。Lease 尚未过期时，同一 `runId` 的第二个执行者会收到 `RUN_LEASE_HELD`，不会进入节点执行；进程崩溃或长时间停顿后，新的执行者只能在旧 lease 过期后接管。每次保存都使用当前 revision 做 CAS，revision 不匹配或 lease 丢失时拒绝覆盖。新 run 在 `open(create)` 返回前已经持久化为 revision 1，不依赖后续第一次 engine save。

Checkpoint 采用 `formatVersion: 2` envelope，包含单调递增的 `revision` 和 `snapshot`。加载、创建和每次 commit 都执行完整 schema 校验，包括 usage、history、threads、in-flight results、interrupt、UUID session ID、plain JSON 容器、有限非负计数和状态不变量；跨 revision 还会保护 graph identity、时间、step、node run、usage、count、history 与 thread progress 不回退或改写。其他 checkpoint 格式会被拒绝。

运行器会在 superstep 开始前、并行 batch 返回后记录其中的成功结果、step commit 后，以及 interrupt、failure 和 end 时原子写入 checkpoint。已经写入 `inFlight.completed` 的节点不会在恢复时重跑；如果进程在整个并行 batch 返回前退出，即使某个 sibling 已在进程内完成，它仍属于 unresolved，恢复时会重新执行。

Checkpoint 保存 graph hash。图定义改变后默认拒绝恢复；只有在人工确认 state 兼容性和 side-effect 幂等性后，才应使用 `forceGraphVersion`。

节点默认在失败时停止图并保留 checkpoint：

```json
{ "onError": { "strategy": "fail" } }
```

也可以记录错误后继续，或转向 fallback：

```json
{
  "onError": {
    "strategy": "route",
    "to": "fallback",
    "output": "errors.research"
  }
}
```

`to` 仅允许与 `strategy: "route"` 一起使用；`fail` 和 `continue` 会继续采用各自固定语义。

重试示例：

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

`response.format: "json"` 会追加严格输出提示并解析最终文本，但不是 provider 级 schema 保证；语法错误会成为可重试的 node failure，字段缺失或类型错误仍需由图的 route/fallback 设计处理。

`onError` 只处理 node failure。`approved: false` 是一次成功的 reviewer 结果，`maxSteps` 也是 graph-level 硬限制，两者都不会触发 reviewer 的 `onError`。需要优雅降级的循环应在 state 中显式累计轮数，并在撞上硬限制前路由到 best-effort 或人工节点；`maxSteps` 只作为最后一道 guardrail。

`idempotent: true` 是设计声明，不会自动让外部副作用变得幂等。Checkpoint 提供 at-least-once 恢复语义，不保证外部副作用 exactly-once。

作为 Pi tools 调用时，`failed`、`cancelled` 和执行异常都会通过 throw 进入 Pi 的真实 tool-error 通道；`interrupted` 仍是可恢复的正常结果。

## 安全边界

- 项目图只在 trusted project 中发现，交互运行默认还会显示图级确认；
- 使用 `bash`、`edit`、`write` 或未知 extension tools 的图默认需要额外确认；
- 非交互运行必须设置 `policy.allowNonInteractive: true`；
- 非交互写操作还必须设置 `policy.allowNonInteractiveMutations: true`；
- 状态路径、node ID 和 thread/control map key 拒绝 `__proto__`、`prototype` 和 `constructor`；
- 子 Pi 进程会禁用三个 pi-graph tools，避免隐藏的递归图调用；
- `readOnly` 只限制工具 allowlist，不是操作系统 sandbox。

高风险工作流应在容器或 OS sandbox 中运行。不要把图级 `readOnly` 当成系统权限隔离。

## 已知边界

- `shared` 是显式 transcript projection，不是 provider-native message-array 注入；
- `thread` 的 graph checkpoint 与 Pi JSONL session 是两个持久化对象，备份、迁移和清理时应一起处理；
- Thread 节点可能在 session 已追加历史、checkpoint 尚未更新时崩溃，恢复后当前 prompt 可能重复；
- File checkpoint adapter 的 journal/hard-link lease/CAS 面向同一主机且支持原子 hard-link 的本地文件系统，不是跨主机分布式协调协议；
- 完整断电耐久性还要求文件系统支持目录 `fsync`；不支持的平台只能提供 best-effort metadata durability。Append-only lease entry 和旧 snapshot blob 会随长运行 run 增长；删除 run 会清除 blob，但会保留防复活所需的 sequence claim/tombstone，因此仍需监控 inode，并只在确认无 stale 进程且不再复用相关 `runId` 时轮换或归档 checkpoint root；
- Lease/CAS 能 fence checkpoint commit，不能 fence 节点已经发出的外部副作用；暂停超过 TTL 的旧进程恢复后，可能在下一次 heartbeat/commit 发现失租前与新 owner 短暂重叠，因此 mutation 仍需幂等键或下游 fencing token；
- token/cost 限制依赖 provider usage event，正在完成的单次响应可能在终止前轻微越界；
- barrier 按各 source 的 completion count 配对，同一 superstep 的相同目标只执行一次；
- 当前图格式为 `schemaVersion: 2`；其他 schema version 会被拒绝。

## 开发

```bash
npm run check
npm test
npm run validate:examples
```

发布前会通过 `prepublishOnly` 运行以上三项检查。

## 延伸阅读

- [Schema reference](docs/SCHEMA.md)：完整图格式、节点字段和 context 配置；
- [Architecture](docs/ARCHITECTURE.md)：superstep、三层记忆、checkpoint 和故障语义；
- [Changelog](CHANGELOG.md)：版本变更记录。

## License

[MIT](LICENSE)
