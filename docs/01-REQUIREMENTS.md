# PolyForge Migration — Requirement Specification

版本：1.0 · 日期：2026-09-25 · 关联：[技术实施](02-TECHNICAL-PLAN.md) · [验收与迁移](03-MIGRATION-ROLLOUT-ACCEPTANCE.md)

## 1. 目标、术语与边界

迁移目标是减少 PolyForge 的通用平台职责，把工程正确性集中在可版本化、可验证、可恢复的 Graph Core。业务用户使用 Paperclip 管理工作；工程用户通过 Plugin 定义和检查 Graph；agent 通过受限 Graph Tools 领取当前合同、提交产物及请求状态转移。

| 对象 | 本规格语义 | 权威来源 |
|---|---|---|
| Company / Project | 组织范围 / 产品或代码库群组，一个 Project 可覆盖多个 repository | Paperclip |
| Project Workspace | 稳定代码来源、repository/ref、source workspace 配置 | Paperclip |
| Execution Workspace | 某项变更的工作目录、branch/worktree、环境与 runtime 绑定 | Paperclip/provider |
| WorkOrder | PolyForge 接受的工程工作请求，绑定 Root Issue，未来可附加 Case | PolyForge；外部对象仅引用 |
| Issue | 可分配、可调度、可观察的工作单元 | Paperclip |
| Agent | 实际 worker 身份、runtime 配置、生命周期 | Paperclip |
| Agent Capability Contract | worker 承担某项工程职责必须满足的能力、输入输出和权限约束 | PolyForge |
| Graph Definition | 可执行工作流结构、入口、节点、边、join、policy/gate 引用 | PolyForge Registry |
| Engineering Graph | 需求、设计、实现、测试、产物与证据的版本化语义及追溯关系 | PolyForge GraphStore |
| GraphRun | 已固定工作流版本的持久化执行实例 | PolyForge Runtime |
| EntryPoint | 具备明确输入、前置条件、输出及可进入范围的工作流入口 | PolyForge |
| Coordinator | 协调某次 GraphRun 的 agent 角色，不拥有任意迁移或执行权限 | Paperclip identity + PolyForge contract |
| Node Executor | 执行某个具体节点的 worker，可与 Coordinator 不同 | Paperclip identity + PolyForge contract |
| Transition | 对精确工程状态与产物版本提出的受约束变更 | PolyForge |

Graph Definition 与 Engineering Graph 不是同一个对象：前者定义“怎么工作”，后者记录“工程事实是什么”；两者都属于 Graph Core。修改工作流定义、运行时实例扩展、发布工程事实是三种独立的受治理操作。

非目标：重写 Paperclip；复制 RBAC/公司成员体系；建立第二个通用 Kanban；将 GraphRuntime 改成一次性 agent tool；把 Schedule/Cron 加入工程 Operation；首版以 Cases、Decisions 或 Pipelines 替换工程状态机。

## 2. 目标架构

```text
Human / Paperclip UI / External work intake
                    |
                    v
Paperclip Control Plane
  Projects • Issues • Kanban • Agents • Workspaces
  Interactions • Approvals • Tool Governance • Budget • Audit
                    |
          @polyforge/paperclip-plugin
  routing • identity bridge • ports • projections • UI
                    |
                    v
PolyForge Graph Core + Durable Runtime
  Registry / Compiler / EntryPoints / Engineering Graph
  Contracts / Policies / Gates / Evidence / Evaluators
  GraphRun / Transitions / Checkpoints / Idempotency
                    |
           authorized node work intent
                    |
                    v
Paperclip Issue assignment → Heartbeat → Hermes adapter → Agent
                                                           |
                    Graph Tools / evidence <---------------+
```

**REQ-ARCH-01** Core 不得 import Paperclip SDK、直接读取其数据库或依赖具体 Agent ID。Paperclip 对象在桥接层映射为 provider-neutral references。

**REQ-ARCH-02** Runtime 是工程 ready/running/passed、依赖与 join 的唯一权威；Paperclip 是 Issue checkout、worker 唤醒、run lifecycle、预算和平台权限的唯一权威。Runtime 发出工作意图，不能绕过 Paperclip 启动 Hermes。

**REQ-ARCH-03** Plugin 不保存第二份可独立修改的 canonical graph state，不实现 compiler、gate evaluator、policy resolver；它可以保存映射、消息 inbox/outbox、投影版本和兼容性状态。

**REQ-ARCH-04** 任何有副作用的工作必须同时通过平台权限与工程策略：有效权限为两者及实际环境约束的交集。任一 deny/未知/撤销都不能被另一侧 allow 覆盖。

**REQ-ARCH-05** 现有工程 Policy/EffectivePolicy、Operation、AgentDefinition、TransitionContract、Evidence、Evaluator、Gate、GraphStore、Learning/Rule promotion 继续保留；仅迁出通用基础设施职责。

## 3. 完整 feature migration matrix

分类：**R** = ready-made replacement 的目标；**H** = hybrid；**C** = Core 保留/自行实现；**E** = experimental 或尚不作为基线。R 不代表所有 SDK CRUD 已齐备，仍须满足所列集成条件。Paperclip 已有功能的证据在 [来源与兼容性](04-SOURCES-AND-DECISIONS.md)。

| 现有/计划能力 | 分类 | 目标使用方式与边界 | 迁移阶段 |
|---|---|---|---|
| Backlog、Task、Story | R | Paperclip Issues；外部用户名称可保留，存储不再自建 | 1 |
| 子任务、优先级、负责人 | R | Parent/child Issue、priority、agent/user assignment | 1 |
| 通用 blocker/dependency | R | Issue relation；复杂 join 的真值仍由 Core 决定 | 1–2 |
| 普通 Kanban | R | 复用 Paperclip Kanban；拖动状态不提交 Graph transition | 1 |
| 评论、线程、通知入口 | R | Issue comments/interactions；不从自由文本解析批准事实 | 1–2 |
| Documents / Attachments | H | PC 存储/协作；PF 固定 revision/hash/provenance 和证据意义 | 1–2 |
| 产品/代码库分组 | R | Project；不假定 Project 与 repo 一对一 | 1 |
| Multi-repo 来源 | R | Project Workspaces；PF 保留各 repo 输入 commit pin | 1 |
| Branch、worktree、cwd 生命周期 | H | PC Execution Workspace 管资源；PF 声明需要的语义和校验条件 | 1–3 |
| Sandbox、runtime services | H | PC/provider 管环境；可用性与机器隔离须实际验证 | 1–3 |
| Agent registry、配置、状态 | R | PC Agents；工程能力合同仍保留 | 1 |
| Agent 启动、停止、session、heartbeat | R | PC runtime + Hermes adapters | 3 |
| Agent 选择 | H | PF 给 capability/independence 条件；bridge 匹配 PC roster 并分配 | 2–3 |
| 成本、token、财务预算、hard stop | R | PC cost/budget；PF 引用额度结果，不维护竞争账本 | 1–4 |
| 工程 retry/rework/QA/递归预算 | C | PF 控制逻辑循环和恢复上限，和财务预算分别计数 | 0–4 |
| 通用 activity/audit | R | PC activity；PF 保留工程事件与证据链并交叉链接 | 1–2 |
| Secrets 与平台资源权限 | R | PC/provider secret references、authorization；不放进 Graph | 3–4 |
| External tool/MCP policy | H | 经过 PC governed gateway 的调用由其治理；环境另行阻止绕过 | 4 |
| 人工问题/确认 | R | Interaction；human-only/not-creator 由 PC 服务端执行 | 2–4 |
| 特权操作授权 | H | PC Approval/受治理 action 机制；PF 绑定精确 action/transition | 4 |
| 工程/业务 Decision | E | 可选持久化人类判断；首版以 human-only Interaction 承载 | 5 |
| Feature/Change/Incident Case | E | 首版 Root Issue；后续附加 Case binding | 5 |
| Generic Pipeline | E | 可选外层业务流程，不接管 PF GraphRuntime | 5 以后 |
| Skills 分发与安装 | H | PC 管包和可用性；PF Operation 固定需要的 skill 版本/能力 | 2–4 |
| Schedule / Cron | R | PC Routines/外部触发；PF 只接收标准 WorkOrder | 1–2 |
| Operation registry | C | 工程行为、输入输出、证据、authority，不等同 Routine | 0 |
| Agent / Directive / Report Contract | C | 结构化工程义务与输出，不等同 Agent 配置或聊天 | 0–2 |
| Engineering Policy / progressive authority | H | PF 定义可请求的工程 authority；PC 及环境执行资源限制 | 4 |
| TransitionContract | C | 版本、条件、输入输出、policy、evidence、mutations、authority | 0–2 |
| Requirement / Design / Implementation / Verification Graph | C | 可复用、可分解、可编译的工程子图 | 0–6 |
| 动态 Graph mutation / invalidation | C | 受 schema、预算、policy 和精确版本控制 | 2–6 |
| Quality Gate / Evaluator | C | 自动/独立评估/人工判断的组合；PC 提供交互和授权载体 | 2–4 |
| Evidence / artifact semantics | C | 证据身份、有效对象、hash、producer、有效期与失效传播 | 0–4 |
| GraphRun / NodeState / TransitionAttempt | C | 持久化工程执行状态，不能用 HeartbeatRun 替代 | 0–3 |
| Graph checkpoint / resume / idempotency | C | 跨 agent/session/restart 恢复，包含外部 effect reconciliation | 0–3 |
| SDLC traceability | H | PF trace graph + PC issue/run/activity references | 2 |
| Governed self-improvement | H | PF proposal/review/compile/version；PC 人类决策/授权载体 | 4–6 |
| Graph editor / runtime visualization | C | Plugin UI；保存语义调用 Core，不操作 Canonical DB | 6 |
| Graph-specific board / gate / evidence inspector | C | PF 投影视图，可链接 Issue Kanban，不再复制任务平台 | 6 |

## 4. Paperclip 对象使用要求

### 4.1 Issues、Projects、Kanban

**REQ-WORK-01** 一个 WorkOrder 绑定一个 Root Issue 作为首版变更容器；一项可分配的 node execution 绑定一个 Child Issue。确定性 Core 内部节点可不建 Issue。一个 Issue 可以承载同一逻辑节点的多个 attempt，但不能混合两个无关 transition identity。

**REQ-WORK-02** 项目身份取自受信的 Issue/Project 关系；不能相信 agent 自报 companyId。Root Issue 与全部子任务、工作空间、文档和证据必须在允许的公司/项目范围内。

**REQ-WORK-03** 只对显式配置的工程工作入口启动 Graph；普通 operational task 继续走 Paperclip 原生流程。重复 assignment/wakeup/import 必须返回同一个 start intent 的 GraphRun。

**REQ-WORK-04** 普通 Kanban 状态只表现运行投影。外部 `done` 触发核验，缺证据时显示“待工程验证”；外部 cancel/pause 是控制请求，须由 Runtime 记录并协调停止，不能删除历史。

**REQ-WORK-05** 不将 PF 的 all/any/quorum、条件分支、循环直接翻译成所有 Issue 都具有静态 blocker。优先仅物化已获准的工作；需要提前展示的工作必须保持不可执行。

### 4.2 工作空间与 Hermes

**REQ-WS-01** Project Workspace 表示来源；Execution Workspace 表示变更的可恢复工作状态。PF 保存引用及 repo/commit 证据，不负责 clone/worktree/provider provisioning 的实现。

**REQ-WS-02** 默认按独立变更隔离写入；同一变更的串行 rework 可复用工作空间。并行写同一 worktree 必须有互斥 lease 或拆分工作空间再整合；shared workspace 不能被视为天然安全。

**REQ-WS-03** Reviewer 使用固定 commit 的只读 snapshot 或受验证的只读环境；同一个可写目录不是独立评审证据。多 repo 必须分别记录 repoId/ref/commit，并验证跨 repo 输出一致性。

**REQ-WS-04** 恢复前验证 workspace 身份、branch、commit、持久化产物与环境能力。工作空间丢失时按已持久化产物恢复或 BLOCKED；不得把“目录存在”当作内容正确。

**REQ-WS-05** 优先使用 `hermes_local` / `hermes_gateway`。Plugin 不通过 shell 或自建进程池调用 Hermes；自定义 adapter 只在明确、经测试证明的协议缺口出现后立项。官方 adapter overview 列出了两种 Hermes 入口，但部署仍须验证已安装包与目标能力。[Paperclip adapter overview](https://github.com/paperclipai/paperclip/blob/master/docs/adapters/overview.md)

**REQ-WS-06** 工作空间保留/清理遵守平台 policy、证据保留期和运行引用；不能假定所有 provider 永不自动清理。归档前证明产物已持久化且无活跃写入。

### 4.3 文档、附件、预算与审计

**REQ-DATA-01** Documents 用于可读规范、报告和评审；Attachments 用于测试日志、二进制、截图等。评论用于协作，不单独构成可信证据。

**REQ-DATA-02** 证据绑定不可变文档 revision 或内容 hash；若平台只能给 mutable URL，先产生可校验快照。内容变更必须形成新证据并使依赖 gate 重新评估；禁止最新文档覆盖旧证据语义。

**REQ-DATA-03** 财务 hard stop 服从 PC；工程 retry/iteration budget 服从 PF。预算不足进入可解释的 BLOCKED，不得改 agent、公司或 Issue 来绕过限制。

**REQ-DATA-04** 每次 graph mutation、policy decision、transition、人工响应、执行 attempt、外部 effect 都能链接 company/project/root issue/node/transition/agent run。平台审计和工程日志互相引用，各自存储自己的权威事实。

## 5. Interaction、Decision、Approval 与治理

| 类型 | 回答的问题 | 典型用途 | 对 Graph 的作用 | 不代表什么 |
|---|---|---|---|---|
| Interaction | “请回答/确认/审阅这项工作” | 澄清、任务建议、checkbox/item verdict、独立 agent review | 提供结构化回答或评审证据 | 不是通用特权授权 |
| Decision | “在这些工程/业务方案中作何选择” | 架构 A/B、需求基线、接受技术债、ship/delay | 提供有 provenance 的选择事实 | 不自动授予部署、工具或 secret 权限 |
| Approval / governed action authorization | “谁授权对哪个资源执行哪项敏感动作” | 平台支持的 board approval、工具写操作授权、预算例外 | 满足精确 action 的 permission prerequisite | 不证明代码正确，也不替代质量门禁 |

**REQ-GOV-01** 首版工程 human decision 使用 `human_only` Interaction，加上 Core 的 `EngineeringDecisionRecord` 绑定；这只是载体降级，领域语义仍是 engineering decision。未来切换 Decision 时不改变 Gate contract。

**REQ-GOV-02** `anyone/not_creator/human_only` 与 company default/cap 由 PC 服务端执行。PF 可以要求更严格的工程角色、能力、作者分离与证据有效性，不重新制造平台 resolver 身份判断。`not_creator` 只保证与 interaction 创建者不同；若由 plugin 代创建，仍须确保 reviewer 与 artifact author 不同。

**REQ-GOV-03** Human-only 意味着具有有效人类身份的真实决策。Plugin 不应默认持有 `approvals.respond`；若未来提供代理人类点击的 UI，必须传递可信用户身份并由 PC 复核，不接受 worker 参数伪造 actorUserId。

**REQ-GOV-04** 权限批准必须绑定 action、resource、environment、inputs/artifact hashes、authority、policy 与 transition identity，并包含 expiry/revocation 信息。批准后目标改变必须重新申请。Graph gate PASS 仍需重新确认权限有效。

**REQ-GOV-05** 必须区分执行前 permission gate 和执行后 quality gate。前者未批准不能产生外部副作用；后者验证结果。Approval 撤销不能自动撤回已发生的外部 effect，须进入修复/补偿流程。

**REQ-GOV-06** 工具访问经过 PC gateway 才具有其 policy/approval/audit 保障；直接 MCP、shell、网络凭据构成另一个执行路径，必须由选定 runtime/sandbox/egress policy 阻止或限制。禁止宣称 Paperclip 是机器级 firewall。[MCP governance boundary](https://github.com/paperclipai/paperclip/blob/master/doc/MCP-ACCESS-GOVERNANCE.md)

**REQ-GOV-07** Graph admission 不直接扩大平台 grants。Progressive authority 是申请更窄或经批准的临时资源权限，受平台上限约束；缺少可强制执行的权限控制时阻止敏感节点。

**REQ-GOV-08** Cases、Decisions、Pipelines 通过 feature flags 与独立 ports 隔离。Cases 绑定失败不阻断 Root Issue 模式；Decision 暂不可用时只能使用已认证的同等 human-only 载体，不允许退化成普通 comment 或自动同意。

**REQ-GOV-09** Pipeline 只能作为外层业务状态或展示投影；不得同时写同一 GraphRun 的阶段和 transition。Pipeline 的“approve”和 Decision effect 修改 Issue 状态后，仍须通过 PF gate。

## 6. Graph Definition、编辑器与发布

**REQ-GRAPH-01** 支持创建、复制、导入/导出、比较 Graph；编辑 node/edge、typed input/output、EntryPoint、executor requirements、subgraph binding、join、guard、gate、timeout、retry/rework budget 与 policy 引用。

**REQ-GRAPH-02** Draft 可修改并具有 revision/ETag；Published version 不可修改。结构与语义保存在 Core；位置、缩放和折叠等 layout 可独立版本化，不能改变执行 hash。

**REQ-GRAPH-03** 发布流程固定为：

```text
Edit → Save Draft → Static Validation → Contract/Policy Validation
     → Compile → Semantic Diff → Required Review/Authorization
     → Publish Immutable Version → Optional Default-Version Activation
```

修改 Draft 会使旧 validation/compile/review 失效。Publish 必须对同一 draft revision、definition hash、compiler version 和 review target 执行 compare-and-swap。Published 与 active default 是两种状态。

**REQ-GRAPH-04** 验证必须检查：唯一 ID、合法 edges、入口可达性、必需输出、输入类型、前置 facts、孤立节点、明确终止、join 语义、受限循环、child recursion 上限、capability、policy 不弱化、evidence/gate 引用存在、permission gate 在副作用之前。

**REQ-GRAPH-05** Compile 是确定性转换，输出执行 plan hash 与完整版本依赖闭包。相同 canonical definition、compiler、dependency lock 与 policy 输入应产生相同 hash。

**REQ-GRAPH-06** 新 run 选定完整版本闭包；已有 run 不随默认版本、skill、policy 或 graph registry 更新漂移。安全撤销是明确的暂停/拒绝信号，不以“版本固定”为理由继续被撤销的权限。

**REQ-GRAPH-07** UI 分 Definition 与 Runtime 两种模式。Runtime 不允许直接拖线改正在执行的结构；允许按权限请求 retry、pause、resume、cancel、迁移、查看 evidence/transition、进入平台审核。

### 6.1 运行中 graph migration

**REQ-MIG-01** 默认让旧 run 完成，或为新工作启动新版。运行中迁移是显式、稀少、可审计的操作，不能用 publish 暗中更新实例。

**REQ-MIG-02** 迁移必须提供 source/target version、node mapping、state transformation、artifact/evidence compatibility、pending gate/approval 处理、child run 处理、effect ledger 连续性和 rollback 条件；dry-run 后审阅。

**REQ-MIG-03** 只能在 quiescent checkpoint 执行：无 RUNNING/UNKNOWN effect，无有效旧 worker lease，消息水位已核对。首版采用“旧 run 冻结 + 新 successor run”，保留 lineage；不是原地覆写历史。

**REQ-MIG-04** 未变化且重新验证有效的证据可复用；变更 node semantics、policy、输入或 evaluator 时不得继承旧 PASS。新增 gate 必须实际执行；删除 node 不删除历史副作用。

**REQ-MIG-05** 动态 fan-out/remediation 用编译计划内声明的扩展点及有界 mutation journal。超出扩展模板的结构变更须发布新版并迁移。

## 7. 子图、EntryPoint 与 Agent 映射

**REQ-ENTRY-01** 子图边界应是可独立进入、完成、恢复、版本化且具备 input/output contract 的工作流；不能把 `read_file` 或单次 tool invocation 都包装成 Graph。

| 图族 | 候选子图/入口 | 输入 → 输出 | 完成条件示例 |
|---|---|---|---|
| Requirement | clarify、analyze、baseline | 问题/业务上下文 → 已确认需求与验收条目 | Requirement gate |
| Design | architecture、api-design、data-design、security-design、design-review | requirement baseline → ADR/API/data/threat model | Design gate |
| Implementation | implementation-plan、code、unit-test、integration、implementation-review | 已接受设计 → commit/构建/测试/审查 | Implementation gate |
| Verification | qa、security-review、regression、acceptance | 固定候选产物 → 独立验证报告 | Verification gate |
| Release / Migration | release.start、migration.plan、migration.verify | 已验证 release 与环境计划 → deployment/migration evidence | 质量 gate + privileged authorization |

表中每项是候选可复用工作流；是否形成独立子图由真实 ownership/recovery 边界决定。单步可保留为 Operation，不为了角色名称强行拆图。

**REQ-ENTRY-02** EntryPoint 指定 input/output schema、required facts、允许进入的节点集合、coordinator capability、前置 gate、policy 与 resume 条件。侧入口不能跳过必要 gate；导入的前置 facts 必须具备可验证 provenance。

**REQ-ENTRY-03** `design.resume_review` 是对既有状态和指定 checkpoint 的受控恢复入口，不是把任意 run 跳到 review。重新执行已完成部分需要新的 rework generation 和明确失效范围。

| EntryPoint | 默认协调角色（偏好） | 必须具备的能力示例 |
|---|---|---|
| requirement.start | Product | requirement.coordinate |
| design.start | Designer | design.coordinate |
| design.security_review | Security | security.review |
| implementation.start | Tech Lead | implementation.coordinate |
| implementation.code | Engineer | code.modify |
| verification.start | QA | verification.coordinate |
| release.start | Release | release.coordinate |

**REQ-ENTRY-04** EntryPoint ↔ Agent 是 capability-based many-to-many。一个 agent 可承担多个入口，一个入口可由多个合格 agent 承担；default/fallback role 只是选择偏好，不是授权条件。回退不能削弱 capability 或独立审查要求。

**REQ-ENTRY-05** Coordinator 可以解释状态、提出分解、请求帮助、协调输入，但不能替 executor 提交未经验证的输出、任意创建可执行节点或越过 gate。节点 executor 独立解析所需能力；Coordinator 不必执行全部节点。

**REQ-ENTRY-06** Child GraphRun 以稳定 child invocation key 创建一次；重试恢复同一子实例，显式新一轮 rework 才产生新 generation。父节点只有在 child 合法完成且 exports 全部通过验证后才 PASS。

## 8. Graph Tools 与执行协议

**REQ-TOOL-01** 最小 agent API：

| 工具 | 行为 | 权限 |
|---|---|---|
| polyforge.status | 获取 run/gate/node 摘要与 blockers | 当前可见项目/run |
| polyforge.current | 获取本 attempt 的合同、输入与允许动作 | 已绑定 agent run/lease |
| polyforge.submit_artifact | 登记固定产物引用与 digest | 当前节点允许的输出 |
| polyforge.submit_evidence | 提交证据候选；可信 ingestion 验证后存档 | 当前节点/transition |
| polyforge.request_transition | 请求评估；返回 PASS/FAIL/ESCALATE 或 pending | 合同允许的 transition |
| polyforge.request_help | 请求澄清、评审或人工处理 | 当前上下文 |

**REQ-TOOL-02** 不暴露任意 `run_any_graph`、`set_node_passed`、`record_approval`、evaluator registration 或直接 DB mutation。若保留 `node.complete` 别名，只能等价于 request_transition，不能把用户参数当作成功事实。

**REQ-TOOL-03** 默认由 Issue 路由自动 create/resume run，agent 启动时注入 run/node/contract references。可选 `graph.enter` 仅对已允许 EntryPoint 做幂等 admission，不在 tool call 内阻塞等待整个 Graph。

**REQ-TOOL-04** tool 返回 durable ID、state version、当前 pending 原因和下一步；等待数小时的人类回应不占用长期 tool call。agent 离线、换人、session 结束或 Paperclip 重启不终结 GraphRun。

## 9. Plugin UI 要求

**REQ-UI-01** 全局 PolyForge 页面包含 Graph Library、Draft/Published versions、Graph Editor、Run 列表及 Integration Health。Project Tab 显示入口、run、版本默认值、workspace 与根 Issue。Issue Tab 显示 Graph、Gates、Evidence、Transitions、History。Agent Tab 显示能力绑定和协调/执行职责；Run Tab 将 PC AgentRun 链接到 PF attempt。

**REQ-UI-02** Graph Editor 提供 palette、canvas、properties、contract/policy/gate inspector、validation error 列表、semantic diff、发布状态与并发编辑冲突处理。Published 显示只读和 Clone to Draft。字段错误可定位到 node/edge。

**REQ-UI-03** Runtime 显示节点状态、并行分支、子图展开、当前 worker、attempt、waiting reason、证据新鲜度、审批链接、预算/平台阻塞与事件时间。图状态与 Issue 状态并列呈现且清楚标注来源。

**REQ-UI-04** UI 经 data/action/stream bridge 访问服务；SSE 只作刷新提示，断线后按 sequence 获取权威 snapshot。支持无数据、loading、无权限、失联、版本冲突状态，不能把未知显示为通过。Paperclip SDK 已提供相关 React hooks；具体 slot 可用性由兼容测试确认。[Plugin SDK](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/README.md)

**REQ-UI-05** 所有敏感按钮由服务端重验身份与版本；按钮隐藏不是授权。审核跳转到平台原生 surface 或经认证的人类操作；不得由前端直接写 Runtime DB。

**REQ-UI-06** 键盘可编辑关键字段、可访问节点列表、文本状态/图例、非颜色唯一编码、缩放与搜索、大图折叠和虚拟化。审查者可在不拖动 canvas 的情况下完成 gate/evidence 检查。

## 10. 非功能需求与成功指标

**REQ-NFR-01 可靠性**：消息至少一次投递可安全处理；canonical transition 只提交一次；外部副作用依赖 provider idempotency/reconciliation，不虚称任意 exactly-once。

**REQ-NFR-02 隔离**：跨 company/project/run 的读取、工具调用、证据提交与 stream 访问均拒绝；信任边界取决于真实部署，插件安装为 instance-level trusted code。

**REQ-NFR-03 可观察性**：记录 queue age、projection lag、UNKNOWN attempts、重复消息抑制、workspace failure、gate wait、authorization denial 和 reconciliation drift；提供关联 ID。

**REQ-NFR-04 兼容性**：精确固定 host/SDK/adapter/runtime/schema/compiler；未知 API/缺失安全能力必须 fail closed。实验性能力有独立开关及 fallback。

**REQ-NFR-05 性能目标（待 Phase 0 基准确认）**：在记录硬件与 dataset 的环境，1,000 节点图初始概览 ≤3 秒，常见状态查询 p95 ≤1 秒，正常事件到 UI p95 ≤5 秒；100 concurrent runs 不丢 transition。超大图以折叠/分区加载处理，不要求一次渲染所有节点。

**REQ-NFR-06 恢复目标（初始建议）**：进程崩溃后已提交 GraphStore 事务不丢失，服务恢复后 5 分钟内开始 reconciliation；灾难恢复 RPO ≤15 分钟、RTO ≤60 分钟，需要部署与备份演练验证。恢复时必须重新核对备份时间以后发生的外部 effect。

**REQ-NFR-07 审计保留**：默认建议 canonical evidence、transition 与治理记录保留 365 天，执行日志 90 天；最终按公司政策配置，active run/hold/调查引用禁止提前清理，删除必须留 tombstone 和原因。

所有要求的验收分组见 [测试矩阵](03-MIGRATION-ROLLOUT-ACCEPTANCE.md)。本文描述目标，未表示已完成上述测试。
