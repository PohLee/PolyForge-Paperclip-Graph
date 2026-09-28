# PolyForge Migration — Sources, Compatibility and Architecture Decisions

版本：1.0 · 观察日期：2026-09-25

本文区分：**讨论中确定的意图**、**本次读取到的代码/文档事实**、**拟议设计**、**必须实施验证的事项**。已存在某个 endpoint/类型，不代表已在目标部署中可用，也不代表没有实验性开关。

## 1. 输入资料与完整性

### 1.1 原讨论

来源：[了解 PaperClip 插件与治理](chatgpt-conversation://6ab66129-cd90-83ec-8e6e-496a341d4cac)。本次用会话读取接口获取了五轮讨论：

1. External Adapter vs Plugin、Governance、API 变动与 anti-corruption layer。
2. Issue/Case/Decision/Approval、Project 与 workspace isolation。
3. Feature migration matrix 与 Phase 0–6。
4. Graph Editor、不可变版本、子图/EntryPoint、Coordinator vs Executor、many-to-many capability mapping、Graph Tools。
5. 用户要求导出 requirement spec + technical implementation plan。

第三轮 assistant 长回复被读取服务标记为 20,000 字符上限截断，末尾位于 UI 迁移段；其他相关轮次及主要矩阵/阶段均已读到。本文件组以这些内容及用户本轮明确范围为依据；不声称逐字还原不可获取的尾部。原截图未使用为证据。

会话中前期“Decision 可以当 Approval”的说法，在后续讨论已收窄：它可以承载工程或业务上的审批判断，**不能替代特权授权**。本规格采用收窄后的解释。

### 1.2 本地 PolyForge 参考

以下文件位于任务 workspace 的 `implementation/`，仅作为现有设计/实现参考，未修改：

- `ENGINEERING_CONTRACTS.md`：GraphStore 权威、AgentDefinition/Operation/Policy/TransitionContract、精确 target 审批、证据与 evaluator、UNKNOWN reconciliation、atomic publication、learning promotion。
- `graph_README.md`：runtime-neutral execution specs、Hermes Kanban port、parent/child graph、join、workspace/capability rails、工程预算和 RuleSet family pins。
- `root_README.md`：现有项目概念与使用上下文。
- `engineering_runtime.py`：读取到现有 RuntimeAdapter execute/reconcile、ExecutionState、checkpoint、attempt、adapter binding 与 durable transition journal 的实现入口。

`sources/` 本次没有可读同步文件；保持只读。存在的 `reviewfix/` 和其他工作文件不被当成已经合并到生产的证据。本次没有运行 PolyForge 或 Paperclip 集成测试。

### 1.3 读取优先级

用户已确认方向 → 明确的工程不变量 → 实际固定版本的代码与集成测试 → 当前实现指南 → 目标 SPEC → 历史讨论的示例。

本次能访问的是移动中的官方 `master` 页面，未获得一个经过测试的 host release/commit pin。下面链接用于可追溯核查，**不是 lockfile**。本任务未核实历史回复提到的 release commit 数量，因此不把那些数字放入实施决策。

## 2. Paperclip 官方来源登记

| ID | 官方来源 | 本次可支持的有限结论 |
|---|---|---|
| S01 | [Repository README](https://github.com/paperclipai/paperclip) | 产品拥有 task、runtime、workspace、governance、budget、audit 和 plugin 等平台能力；不能据此证明每项 API 在任意版本中可用 |
| S02 | [Plugin Authoring Guide](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_AUTHORING_GUIDE.md) | 当前实现仍称 alpha；workers/UI 可信；同源 UI 非 capability sandbox；有 namespace DB 与 plugin routes；`ctx.assets` 不支持 |
| S03 | [Plugin SDK types](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/types.ts) | 存在 issues、approvals、authorization、tools 等 client；execution workspace metadata 为只读；未看到 first-class cases/decisions/pipelines client |
| S04 | [Plugin SDK README](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/README.md) | React data/action/stream hooks、UI slots、testing harness；真实 deployment 与 distributed installation 仍需验证 |
| S05 | [Plugin architecture SPEC](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_SPEC.md) | 目标架构、manifest、候选事件/slots；含未来设计，不能独立证明 runtime 实现或安全保证 |
| S06 | [Adapters overview](https://github.com/paperclipai/paperclip/blob/master/docs/adapters/overview.md) | Paperclip heartbeat 调 adapter；Hermes local/gateway 已列出；外部 adapter 属 runtime invocation 层 |
| S07 | [Case routes](https://github.com/paperclipai/paperclip/blob/master/server/src/routes/cases.ts) | 新 Cases 检查 `experimental.enableCases`；部分路径与 Pipeline Cases 共存，不能混同两个对象域 |
| S08 | [Decision routes](https://github.com/paperclipai/paperclip/blob/master/server/src/routes/decisions.ts) | 决策相关 schema、authenticated agent context 与 board checks；完整操作合同仍须按选定版本验证 |
| S09 | [Pipelines tutorial](https://github.com/paperclipai/paperclip/blob/master/docs/pipelines-tutorial.md) | 已有 stage/case/review/blocker/rollup 的示例；generic workflow 不等于工程图合同 |
| S10 | [Sidebar implementation](https://github.com/paperclipai/paperclip/blob/master/ui/src/components/Sidebar.tsx) | Pipelines、Cases、Decisions 和 isolated-workspace 导航与实验开关有关；UI 开关不自动等同后端所有 API 的成熟度 |
| S11 | [MCP Access Governance](https://github.com/paperclipai/paperclip/blob/master/doc/MCP-ACCESS-GOVERNANCE.md) | Gateway 内调用有 policy/approval/audit；不能阻止任意外部 process 直接访问上游 |
| S12 | [Shared constants](https://github.com/paperclipai/paperclip/blob/master/packages/shared/src/constants.ts) | 当前 Issue/Interaction/Approval 等枚举；示例应依固定版本 schema 编译，不能长期硬编码 master |
| S13 | [Interaction service](https://github.com/paperclipai/paperclip/blob/master/server/src/services/issue-thread-interactions.ts) | resolver policy、结构化响应、tool-action 相关分支与服务端治理逻辑存在；bridge 仍须验证精确对象/动作 |
| S14 | [KanbanBoard implementation](https://github.com/paperclipai/paperclip/blob/master/ui/src/components/KanbanBoard.tsx) | 原生 Issue 看板实现可复用；不能替代 PF Graph definition/runtime visualization |

本次有些猜测的旧文档路径无法打开；它们没有作为支持功能存在的来源使用。生产文档应在 Phase 0 将以上移动链接补充为选定 SHA 的 permalink，并保存测试报告。

## 3. 从讨论到实施规格的关键校正

| 原讨论中的快捷表述 | 本规格采用的精确定义 | 依据/影响 |
|---|---|---|
| “Paperclip 可以直接替换 workspace/sandbox” | 迁出 lifecycle ownership，但 PF 仍声明 workspace requirement；provider/隔离能力/持久化/权限必须验证 | S03/S10；branch/worktree 不是机器安全边界 |
| “Plugin 能 createWorkspace” | 这是自定义 WorkspacePort，不是已有 SDK CRUD 保证 | S03 的 execution workspace metadata read-only |
| “Plugin 可以处理 Approval” | read/decide 能力不代表任意创建或自主批准；默认不授 approvals.respond | S03；必须有真实人类身份与 supported action path |
| “Policy 都归 Paperclip” | 平台身份/资源授权归 PC；工程时序、contract、evidence/gate 仍归 PF；实际权限取交集 | 与原工程 Policy/TransitionContract 保持一致 |
| “not_creator 就是独立 reviewer” | 平台保证不能由 interaction creator 解决；PF 还需检查 artifact author 与 reviewer capability/分离规则 | Plugin 可能代创建 interaction，二者身份不同 |
| “Issue event → Graph transition” | event 只是 observation/intent；必须过契约、证据、权限、版本核验 | 防止拖 done / adapter success 绕过 gate |
| “自动换 Agent 不需要改变 Graph” | definition 不变；具体 transition 的 actor/adapter binding 若已固定，需要合法 replacement/resume 流程 | 现有合同禁止同一身份下悄悄改 binding |
| “同一个 workspace 给所有 agents” | 适合串行工作或有互斥写 lease；并行 writer 默认隔离，reviewer 固定只读 snapshot | 避免并行改写和评审输入漂移 |
| “Graph 编辑可直接发布” | 先固定 draft revision、validation、compile、diff/review；发布与默认激活分开 | 防止验证后修改与旧 run 漂移 |
| “全部节点建 child issue” | 只为需要可分配工作或操作可见性的节点建 Issue；Core 内部确定性节点可不建 | 降低任务噪声，不丢工程 journal |
| “Cases = Pipeline Cases” | 使用不同 provider kind 与兼容 adapter，不能互换 ID | S07 的路由共存逻辑 |
| “插件 manifest 是沙箱” | 只约束相应 host API；当前同源 UI 和安装代码需信任 | S02/S04 |
| “把图当 agent tool” | tools 访问 durable Runtime，Graph 不在 tool call 内生灭 | 用户已确认的最终方向 |

## 4. 兼容性锁文件与能力探针

建议 Phase 0 产生以下结构，值必须来自实际选定制品；这里的 `UNSET` 是明确待实施项，不是可直接部署配置。

```json
{
  "paperclip": {"release": "UNSET", "commit": "UNSET", "imageDigest": "UNSET"},
  "pluginSdk": {"version": "UNSET", "tarballSha256": "UNSET"},
  "hermesAdapter": {"packageVersion": "UNSET", "mode": "UNSET"},
  "hermesRuntime": {"version": "UNSET", "capabilitiesDigest": "UNSET"},
  "polyforge": {"protocolVersion": 1, "schemaVersion": "UNSET", "compilerVersion": "UNSET"},
  "experimental": {"cases": false, "decisions": false, "pipelines": false},
  "deployment": {"workspaceProvider": "UNSET", "toolGatewayProfile": "UNSET"},
  "contractTestReport": "UNSET"
}
```

每次升级执行：构建/类型检查 → port fixture diff → SDK harness → 真实 host auth/issue/workspace/governance/adapter suite → persisted-state restore → rollout canary。需要新 manifest 权限时单独审查；旧版必须仍可读回滚窗口内的数据，否则不得直接升级生产。

| 编号 | 必须回答的问题 | 推荐保守处理 | Owner |
|---|---|---|---|
| V-01 | 实际 host/SDK/adapter 版本是什么？ | 固定发布制品和 SHA，不追 latest | Integration |
| V-02 | Issue create/wakeup 是否原生幂等？如何找回超时结果？ | 关联键 + provider lookup；无法确认时 ambiguous，不盲重试 | Integration |
| V-03 | 哪些 event 实际发出、是否 durable、是否有 cursor？ | 实测并存 mapping；没有 replay 就 bindings reconciliation | Integration |
| V-04 | Workspace 如何创建/复用、何时清理、什么是真隔离？ | SDK read + supported policy/provision path；未验证 provider 禁用 | SRE |
| V-05 | 每一种敏感 action 的真实 authorization route 是什么？ | 不支持则 BLOCKED；不能用普通 confirmation 代替 | Security |
| V-06 | Hermes cancel、session restore、effect reconciliation 能力怎样？ | 只启用通过测试的模式；缺查询则 UNKNOWN 人工核对 | Runtime Integration |
| V-07 | 如何给 Core 转交可信的人类/agent 身份？ | scoped short-lived assertion + host validation，禁止自报 userId | Security |
| V-08 | MCP gateway 是否覆盖选定 Hermes 模式及其工具配置？ | 实测 deny/audit/绕过；缺控制的敏感路径不开放 | Security + SRE |
| V-09 | 平台 capability matcher 是否足以表达工程需求？ | bridge 使用受治理 CapabilityBinding，不依赖自由文本 capabilities | Core |
| V-10 | Cases/Decisions 的 SDK/REST/auth/flag 是否可用？ | 默认关闭；Root Issue + verified human-only Interaction | Integration |
| V-11 | Project/Issue/Agent/Run tab 是否全支持？ | 测试 exact SDK；缺 slot 用 plugin page deep link | UI |
| V-12 | 成本归因与工程 budgets 怎样关联？ | PC financial ledger 为唯一来源，PF 只管逻辑计数与 references | Core + Finance Ops |
| V-13 | 当前 Python mirror 与真实主分支有何差异？ | 在真实 repo 复核 symbols、schema、tests，先适配不先改名 | Tech Lead |
| V-14 | 初始规模、RPO/RTO、审计保留期是否满足业务？ | 采用本文建议作为测试目标，实测并由 owner 调整 | SRE + Product |

V 项是实施阶段必须完成的验证，不需要用户在本次文档导出前逐项回答。

## 5. Architecture Decision Records

### ADR-01 — Paperclip control plane / PolyForge graph authority

状态：沿用已讨论的目标。Paperclip 持有工作管理、物理执行与平台治理；PolyForge 持有工程状态和合法 transition。成本：跨服务 eventual consistency 与 bridge；收益：不把工程正确性压缩为 Issue status。

### ADR-02 — Thin plugin anti-corruption layer

状态：沿用目标。SDK/REST/events/capabilities 只出现在 integration package。Core ports 按业务语义定义；plugin 不实现 graph rules。成本：显式 DTO、mapping、contract suite；收益：API churn 局限在 adapter。

### ADR-03 — Preserve Python Core and durable service

状态：本规格建议。保留当前 Python contracts/runtime，增加服务 API，TypeScript plugin 通过受认证协议访问。避免为了 SDK 重写 Core；额外承担一个服务进程、部署与监控。

### ADR-04 — Reuse Hermes adapters; no custom adapter in MVP

状态：沿用目标。Paperclip 负责 invocation/context/budget/run identity；Graph tools 返回 durable IDs。若有证明 builtin 无法表达的 runtime 能力缺口，再评估 external adapter，且不能把整个长时 Graph 伪装成单次 heartbeat。

### ADR-05 — EntryPoint/capability many-to-many

状态：沿用目标。Graph 不写死 PC Agent ID，Coordinator 和 Node Executor 分离。Core 定义工程能力，bridge 选择真实 worker，PC 最终执行平台权限与调度。成本：binding registry 和角色分离检查。

### ADR-06 — Immutable published definitions / pinned runs

状态：沿用目标。Draft 可变；Published 不可变；activation 只影响未来 admission；运行中改结构走显式 migration。首版 successor run migration 保留 source history，牺牲任意即时修改以换取可追溯和恢复。

### ADR-07 — Interaction, Decision, Approval are distinct

状态：沿用讨论最终解释。首版用 human-only Interaction 承载工程 decision，Core 保留独立 decision semantics。安全授权只通过真实 action mechanism；任何 decision effect 都不直接通过 Graph gate。

### ADR-08 — Cases/Decisions/Pipelines optional

状态：沿用保守迁移顺序。Root Issue 模式是完整有效基线，不是临时残缺方案；实验性对象在独立 port 后方渐进采用。Pipeline 可作外层流程，不能替换 PF Runtime。

### ADR-09 — Outbox/inbox and explicit UNKNOWN

状态：本规格细化。不使用跨数据库事务或假设 exactly-once 网络投递；用事务日志、幂等、fencing 与 reconciliation。外部 effect 无法确认时阻塞，而非重试到“看似成功”。

### ADR-10 — Graph UI is an authoring/projection surface

状态：沿用目标。Definition 编辑、Runtime 检查分开；Canvas 不持有工程真值。UI 可选 React Flow 类组件，但所有验证和发布在 Core；普通 Kanban 继续复用 PC。

### ADR-11 — Financial budgets vs engineering budgets

状态：本规格细化。财务成本与平台 hard stop 迁至 PC；attempt/rework/QA/recursion 等工程上限保留。两者都可 block，不把重复账本当“保留 Core 语义”。

### ADR-12 — Single execution owner during migration

状态：本规格细化。按 WorkOrder/run 保留 ownerEpoch；shadow 只读比较，切换必须 quiescent；旧 worker 没被确认停止不能派新 owner。回滚同样保留 external effect ledger 与治理结果。

## 6. 后续实现禁止误读的事项

- 文档中的 API/表名/事件是建议规范，并未创建实际插件、注册工具或更改 Paperclip。
- Graph Registry 发布权限、Graph transition authority 与 PC platform authorization 是不同判定，互不自动授予。
- `GraphStore` 的事务只保证本地 canonical mutation 原子性；Git、部署、外部 API 不参与同一个事务。
- Case adoption 只加 container link，不重新标识 GraphRun 或把旧 evidence 当新证据。
- 同源 Plugin UI 与 worker 都属于可信安装代码；公司 scope 校验是应用授权，不是敌对插件隔离。
- “可套用”表示推荐所有权归属；只有固定版本的实现、配置和测试才能证明上线可用。

## 7. 文档交付检查

交付范围：目标架构、四类迁移矩阵、Paperclip 对象用法、实验功能、治理语义、图编辑/版本/迁移、子图/入口/能力映射、durable Runtime/tools、模块/API/model/event/state、安全、失败恢复、阶段、测试、rollout 与 rollback。

文档检查只验证文件存在、编码、链接、Markdown fence 和内容覆盖；没有把规格中的待执行测试计为通过。后续实施验收以 [AT 测试矩阵](03-MIGRATION-ROLLOUT-ACCEPTANCE.md) 的真实报告为准。
