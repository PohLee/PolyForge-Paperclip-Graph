# PolyForge Migration — Phases, Acceptance, Rollout and Rollback

版本：1.0 · 日期：2026-09-25 · 状态：待执行实施计划

关联：[需求](01-REQUIREMENTS.md) · [技术设计](02-TECHNICAL-PLAN.md) · [来源与决策](04-SOURCES-AND-DECISIONS.md)

本计划按可独立回退的交付阶段推进。未给未经估算的完成日期；各阶段在真实版本、团队容量及试点数据确认后排期。以下 owner 是职责角色，不是假定已经有人承诺交付。

## 1. 总体实施原则与依赖

```text
P0 Boundary / compatibility freeze
   ↓
P1 Infrastructure replacement preparation
   ↓
P2 Plugin integration and shadow execution
   ↓
P3 Execution ownership cutover
   ↓
P4 Complete governance/resource enforcement
   ├────────→ P5 Optional Cases / Decisions adoption
   └────────→ P6 Full Graph Editor / UI plugin
```

P4 的设计、auth stub、deny-by-default 和必要 gate 检查必须从 P0/P2 开始；P3 不允许在缺失安全条件时执行高风险动作。“P4 后做治理”不意味着前面阶段可绕过治理。P6 的只读原型可在 P2 后开发，完整编辑器放行依赖版本与授权完成，不依赖 P5。

**迁移期间保留旧系统只读历史，逐项替换，不在 Phase 1 立刻删掉所有实现。** 删代码是通过兼容性和回滚观察期后的退役任务。

## 2. Phase 0 — Freeze boundary and compatibility baseline

目标：冻结所有权、不变量、对外协议与真实依赖版本。

| 工作包 | Owner | 输出 | 验收/依赖 |
|---|---|---|---|
| P0-1 基线盘点 | Tech Lead + Core | 当前任务/Agent/workspace/审批/GraphStore/adapter 调用清单，标出直接 spawn 与 DB 依赖 | 完整列出可迁出的 infrastructure；不修改原始历史 |
| P0-2 架构边界 | Core + Integration | ports、状态所有权、ADR、现有 schema/hash 兼容说明 | Core 不依赖 PC 类型；scheduler 职责无重叠 |
| P0-3 固定依赖 | Integration | compatibility-lock：host release+SHA、SDK tarball/hash、adapter/runtime、schema/compiler、feature flags | 禁止 latest/master 作为生产部署版本 |
| P0-4 能力探针 | Integration + Security | 实际 SDK/REST methods、auth、events、workspace、approval、tool gateway、UI slots 的 smoke 报告 | 核实 unsupported 时 fail closed/fallback |
| P0-5 数据/恢复基线 | SRE + Core | backup/restore、ID map、effect ledger inventory、ownerEpoch 规则 | 旧数据可读取，备份恢复演练成功 |
| P0-6 试点选择 | Product + Engineering | 一个低风险、有审查与重试的工程变更；baseline metrics | 不从生产部署或不可逆数据库变更起步 |

Exit gate：批准 ADR-01 至 ADR-09；关键待验证项都有实测结果或明确禁用策略。必须验证“创建 Issue 后超时怎么查回”，以及“旧 worker 未停止能否阻止新 worker 产生 effect”。不具备的 provider 能力不能通过设计文档假设补齐。

## 3. Phase 1 — Replace generic infrastructure

目标：复用 Paperclip 任务、人员、项目、workspace、存储、预算、审计等能力，准备迁移路径。

| 工作包 | Owner | 输出 | 验收 |
|---|---|---|---|
| P1-1 Project/Agent 导入映射 | Integration | company/project/agent 稳定引用与旧 ID mapping；验证角色配置 | tenant/project 映射完整；无隐式工程能力授予 |
| P1-2 Issues/Kanban 迁移 | Integration | Root/child issues、priority、assignee、blockers、comments 历史迁移工具 | 可重跑、不重建重复 Issue，普通看板可用 |
| P1-3 工作空间策略 | SRE + Integration | 按变更隔离、串行复用、review snapshot、多 repo 配置 | 两个变更不能互写；checkpoint 后可恢复 |
| P1-4 Documents/Attachments | Integration + Core | 上传/引用/校验流程与 EvidenceRef 映射 | 文档变更不替换历史证据；孤立附件可核对 |
| P1-5 Budget/Audit/Secrets | Security + SRE | 平台预算、审计、secret refs、gateway 基础配置 | 无明文 secret；预算中止可观测 |
| P1-6 旧 infrastructure 包装 | Core | legacy backend 实现同样 ports，migration switches | 禁止新增对旧 Kanban schema 的耦合 |

Exit gate：只读/导入模式数据对账通过；旧平台仍是未切换工作执行 owner。通用审批 UI 可先准备，但语义合同未接通前不得用“导入的 approved 字段”授权新工作。

## 4. Phase 2 — Thin plugin integration

目标：让 Root Issue → WorkOrder → GraphRun → Node WorkUnit → PC projection 成为可靠、可测试的闭环。

| 工作包 | Owner | 输出 | 验收 |
|---|---|---|---|
| P2-1 Runtime Service | Core | 包装现有 contracts/runtime 的 command/query API | 持久化命令、版本检查、旧 hash/schema 可读 |
| P2-2 Bridge ports | Integration | Issue/workspace/governance/artifact translation | SDK harness + 固定 host 实测 |
| P2-3 Routing/admission | Core + Integration | 显式 Issue binding 与 startIntent idempotency | 普通 Issue 不启动 Graph，重复事件一个 run |
| P2-4 Inbox/outbox | Core + Integration | durable delivery、quarantine、reconciliation、projection seq | crash/replay/乱序不重复创建或推进 |
| P2-5 Graph Tools | Core + Integration | status/current/artifact/evidence/transition/help | agent 不能自行 PASS/批准/注册 evaluator |
| P2-6 基础治理载体 | Security + Core | human-only Interaction 与 exact target binding | 伪造人类/旧批准/跨 run 证据全部拒绝 |
| P2-7 最小操作视图 | UI + SRE | Issue 的只读状态/证据/错误/health 链接 | pending 与 failed 原因可见，无 Graph 编辑 |
| P2-8 Shadow evaluator | Core + QA | 固定 inputs 上 legacy 与新 bridge 的比较报告 | shadow 不创建 worker/审批/副作用 |

Exit gate：用 synthetic fixtures 完整走 requirement → design → implementation → verification，含人工等待、重启与缺失证据。Shadow 只比较新 Core/bridge 的逻辑与投影；不允许第二套真实执行。

## 5. Phase 3 — Transfer execution ownership

目标：从 PolyForge/Hermes Kanban 直接派工迁到 Paperclip assignment → heartbeat → Hermes adapter。

| 工作包 | Owner | 输出 | 验收 |
|---|---|---|---|
| P3-1 Capability matcher | Core + Integration | many-to-many bindings、role preference、independent reviewer selector | agent 替换无需编辑 Graph；fallback 不越权 |
| P3-2 Hermes integration | Integration | 本地/网关中至少选定一种已认证路径；context injection、cancel/reconcile | session 丢失可从 PF 合同恢复 |
| P3-3 Execution claim | Core + Security | PC checkout + PF leaseEpoch fencing | 旧 worker late write 被拒绝、无双重 effect |
| P3-4 Owner cutover | SRE + Core | 按 WorkOrder/GraphRun 的 owner + epoch 切换脚本 | 切换时旧 dispatch 已停止并对账 |
| P3-5 Native automation 协调 | Integration | PC review/retry/continuation 与 PF 职责配置 | 不出现两个 reviewer、双 wake 或 retry storm |
| P3-6 Pilot canary | QA + SRE | 单项目/单入口真实低风险运行与故障演练 | 达到试点门槛；恢复不重新执行已完成 effect |

Exit gate：仅在 workspace、预算、身份和该节点所需治理均通过测试时扩大执行范围。High-risk action 继续禁用直到 P4 的针对性验证通过。现有 active runs 优先由旧 owner drain 完；若必须转移，需 checkpoint migration，不迁移仍在 RUNNING/UNKNOWN 的工作。

## 6. Phase 4 — Complete governance integration

目标：工程语义与平台资源权限正确组合，所有高风险动作只有受治理入口。

| 工作包 | Owner | 输出 | 验收 |
|---|---|---|---|
| P4-1 工程/资源 capability 分离 | Core + Security | mapping、authority ceilings、拒绝原因 | 任一侧 deny 都无法执行 |
| P4-2 Interaction governance | Integration | default/cap、human-only、not-creator 与角色分离测试 | plugin requester 不削弱独立审查 |
| P4-3 Privileged action gate | Security + Integration | 真实 Approval/ToolAction 支持表、exact-target binding | 未批、过期、撤销、改 target 都阻断 |
| P4-4 Gateway/环境限制 | SRE + Security | PC-managed tool config、egress/secret/FS rails | 尝试直接 upstream/凭据绕过被阻止或该执行模式不放行 |
| P4-5 Budget + audit 链 | Core + Integration | token/cost refs、工程 retry budgets、audit correlations | 无重复计费/绕过财务 hard stop，效果和审计可追溯 |
| P4-6 Governed improvement | Core | 原有 learning/rules/operation/policy promotion 的桥接 | 批准只作用于目标 hash 和未来版本 |

Exit gate：MVP 核心控制完成。可开始正常工程变更的分批 rollout；部署类特权工作另有端到端授权测试，不因普通代码变更通过就自动开通。

## 7. Phase 5 — Optional Cases and Decisions

进入条件：在计划采用的固定 host 版本上，feature flag、权限、REST/SDK、幂等、audit、UI 与 migration semantics 均有通过记录。成熟度由证据判定，不单看“已有 REST”。

| 工作包 | Owner | 输出 | 验收 |
|---|---|---|---|
| P5-1 Cases port | Integration | 新 domain kind 的 CaseBinding；Root Issue 仍保留 | 关闭 Cases 后 GraphRun 正常可读/继续 |
| P5-2 Root → Case adoption | Core + Integration | create-or-get Case + link existing Issues/WorkOrder | 不改 run identity、证据 hash 或历史 approval |
| P5-3 Decisions port | Integration + Security | human identity、选项、target、expiry、effects 白名单 | 不把 Decision 当 tool/deploy 授权 |
| P5-4 In-flight governance | Core | 按 request 固定 backend，保持旧 Interaction 收尾 | 无双重 pending request 或重复 resolution |
| P5-5 Pipeline spike（可选） | Product + Core | 仅外层业务状态映射，独立评估报告 | 不接管 PF state；无法满足则不采用 |

Cases 与 Pipeline Cases 可能是不同 domain、甚至共享部分路由；ProviderRef 必须区分 `case` 与 `pipeline_case`，不按 URL 片段判断类型。

Exit gate：完整 disabling/rollback 演练，实验性服务关闭不会使已绑定工程记录不可解释。未达标则长期保留 Root Issue + Interaction 模式，项目仍可成功完成迁移。

## 8. Phase 6 — Full Graph UI plugin

目标：工程用户在 Paperclip 内编辑定义、发布新版本、检查 Runtime 和申请实例迁移。

| 工作包 | Owner | 输出 | 验收 |
|---|---|---|---|
| P6-1 Library/版本 UI | UI + Core | Graph/version/draft/run 列表、semantic diff | Published 只读，权限与 scope 正确 |
| P6-2 Editor/validator | UI + Core | node/edge/entrypoint/gate/policy 编辑与错误定位 | 非法图不能发布；并发修改冲突可恢复 |
| P6-3 Compile/publish flow | Core + UI + Security | draft revision→plan hash→review→publish | 修改后旧 validation/review 失效 |
| P6-4 Runtime/inspectors | UI + Integration | Project/Issue/Agent/Run tabs，gate/evidence/transition/history | UI 断线可重新获得权威 snapshot |
| P6-5 Migration UI | Core + UI | dry-run、invalidations、quiescence、approval、successor lineage | 没停旧 worker/UNKNOWN effect 不可迁移 |
| P6-6 Accessibility/performance | UI + QA | 键盘操作、列表模式、大图折叠、性能基准 | 达到约定负载与可访问性验收 |

Exit gate：编辑→验证→编译→diff/review→发布→新 run 固定版本完整通过。已有 run 仍使用旧版。Graph view 不复制通用 Issue 看板，也不提供任意状态修改按钮。

## 9. 数据迁移设计与对账

### 9.1 分类与映射

| 旧对象 | 新对象 | 迁移处理 |
|---|---|---|
| Project/repo 配置 | PC Project/ProjectWorkspace | 校验实际 repo identity、权限和默认 ref |
| Hermes Kanban task/tree | Root/Child Issues、relations | 保存 legacy ID、原状态、时间、作者信息；不伪装原生历史事件 |
| Worker profile | PC Agent + PF CapabilityBinding | 平台身份与工程能力分别迁移，授予需审查 |
| Branch/worktree | PC ExecutionWorkspace reference | 先登记或受控接管；不盲 move/delete 工作目录 |
| 文档/附件 | PC Document/Attachment | digest 校验与映射，原引用作为 provenance |
| GraphRun/node/contract/evidence | 原 PF GraphStore | 默认原地保留，不转换成 Issue status |
| Approval/Decision 历史 | PF 历史记录 + PC reference/link | 不重新颁发权限，不默认信任 legacy approval |
| Runtime effect journal | 原 PF ledger | 必须保留 effect identity 和 UNKNOWN 状态 |
| 通用审计历史 | 可读 archive + 平台链接 | 不篡改 actor/occurredAt 或制造真实旧 run |

### 9.2 可重复执行的步骤

1. Snapshot 旧数据库、配置、mapping、GraphStore 与 artifact manifest；记录一致性点及 hash。
2. 建立 `migrationBatchId`、只追加的 object mapping、source digest 和每条记录的 imported/verified/error 状态。
3. 按公司→项目→agent→root issue→child issue→relation→workspace binding→documents/attachments 顺序导入；孤立引用入 error queue。
4. 对每个对象执行 create-or-verify，保留 source snapshot；同 ID 不同内容不得静默覆盖。
5. 校验数量、关系完整性、scope、digests、root/child cardinality、状态投影和 active owner。不能仅比较总行数。
6. Active runs 使用 drain 或有审批的 quiescent handoff；未知 effect 保持隔离，不因“迁移成功”清零。
7. 导出对账报告与异常清单；全部高严重度异常清除后允许新 owner admission。

旧系统退役前，抽样与全量约束检查都要完成：所有活跃 WorkOrder 有唯一 owner；所有输出可读且 hash 一致；所有 pending governance 可找回；所有旧 ID 有可查映射；所有跨公司引用为零。

## 10. 验收测试矩阵

状态：以下是完整验收基准，不等同于已执行或通过。当前 checkout 的 harness/单元覆盖、真实 Paperclip host 验收和未覆盖项按
[`07-VERIFICATION-STATUS.md`](07-VERIFICATION-STATUS.md) 记录；本地测试通过不能替代真实 host integration、故障演练或 UAT。当前 checkout 最近一轮完整 `npm.cmd run verify` 运行了 253 项 plugin tests 与 947 项 Core/Runtime tests（含缺失证据拒绝、同一 SQLite 文件上重建 Runtime API service 后恢复 human wait 的 loopback HTTP E2E），但这不代表 AT-01–35 全部通过；完整的分项和边界见验证状态记录。

追溯规则：只有测试标题明确标注的 AT 编号才映射到下表；Python 方法名以 `AT_XX` 表示标题中的 `AT-XX`，文件名和类 docstring 本身不是验收编号。工具 claim/fencing 与 outbox suite 已按行为重命名，避免和本表的 AT-06（workspace isolation）及 AT-09（evidence immutability）混淆；outbox 内只有明确标注的测试映射到 AT-26。当前 AT-06 的局部负向证据拒绝 shared/missing workspace 和错误 commit；matching isolated workspace 只在本地 harness 放行。虽然代码要求匹配 repo/ref/commit 的 host 元数据，仍不代表并发隔离、固定 commit reviewer 或真实 host 隔离验收通过。

| ID | 对应需求 | 测试与验收结果要求 |
|---|---|---|
| AT-01 | ARCH-01/03/05 | Core import/dependency 检查无 PC SDK；legacy contracts/hash fixtures 不变；plugin 无 evaluator/GraphStore 写入口 |
| AT-02 | ARCH-02, WORK-03 | 同一 Root Issue 重放 100 次相同 start intent，只创建 1 run；普通 Issue 创建 0 run |
| AT-03 | WORK-01/02 | Root/child/workspace/agent refs 在同 scope；跨 scope 访问/提交全部拒绝 |
| AT-04 | WORK-04 | 人工拖 Issue 为 done 或伪造 agent success，缺证据的 node 不能 PASS/downstream dispatch |
| AT-05 | WORK-05, ENTRY-06 | all/any/quorum/条件分支只释放合法后继；parent 必须验证 child exports |
| AT-06 | WS-01/02/03 | 两个变更写入隔离，parallel writers 受 lease 限制，reviewer 无写权限且读取固定 commit |
| AT-07 | WS-04/06 | 删除/漂移 workspace 后 BLOCKED；重建需要同样输入/产物校验，保留期不清理 active 引用 |
| AT-08 | WS-05, ARCH-02 | PC 作为唯一 runtime invoker；直接 PF spawn 路径禁用；adapter cancel/reconcile 实测 |
| AT-09 | DATA-01/02 | mutable doc 更新不改变既有 evidence；错误 hash、错误 producer、旧 revision 不通过 gate |
| AT-10 | DATA-03, GOV-07 | 财务 hard stop 阻断唤醒；换 agent 不绕过；工程 rework 达上限也 BLOCKED |
| AT-11 | DATA-04, NFR-03 | 给定 transition 可追踪 Issue、AgentRun、evidence、approval、effect；关键 audit write 失败可见并停止敏感操作 |
| AT-12 | GOV-01/02 | human_only、not_creator、company cap 的真实服务端测试；plugin 创建者不同于产物作者时仍拒绝作者自审 |
| AT-13 | GOV-03, TOOL-02 | agent 伪造 actorUserId/approved/record_approval/evaluator registration 全部失败 |
| AT-14 | GOV-04/05 | 修改 artifact/authority/environment 后旧 approval 不适用；撤销/过期阻断；外部 effect 不被虚假回滚 |
| AT-15 | GOV-06 | governed tool allow/deny/approval/audit；尝试直接 upstream、local credentials/网络绕过；未被强制约束的模式不放行敏感节点 |
| AT-16 | GOV-08/09 | Cases/Decisions/Pipelines 全关闭仍可跑 MVP；Decision effect 改 Issue 不改变 PF gate |
| AT-17 | GRAPH-01/02/03 | 并发 draft 更新产生 conflict；Published 不可写；validation/compile/review 与 exact revision 一致 |
| AT-18 | GRAPH-04/05 | 错误 schema、断边、无终止、无限循环、缺 gate、弱化 policy、side entry 缺事实被拒绝；compile 同输入同 hash |
| AT-19 | GRAPH-06 | 发布/激活 v14 后 v13 run/child 继续使用原 pin；安全撤销仍暂停旧 run |
| AT-20 | GRAPH-07, UI-01/02/05 | Runtime 无结构编辑；各 tab 显示正确 entity context；越权 action 服务端拒绝 |
| AT-21 | MIG-01/02/03/04 | 无 mapping/旧 source version/活跃 worker/UNKNOWN effect 时迁移拒绝；新 gate 不继承旧 PASS |
| AT-22 | MIG-05, ENTRY-06 | bounded fan-out 产生稳定 child IDs；replay 无重复 child；显式 rework generation 可新建 |
| AT-23 | ENTRY-01/02/03 | 独立 workflow 输入输出完整；侧入口不能跳 gate，resume 只允许合法 checkpoint |
| AT-24 | ENTRY-04/05 | 一个 agent 多入口/一个入口多 agent；Coordinator 与 executor 分离；fallback 缺能力则 BLOCKED |
| AT-25 | TOOL-01/03/04 | 工具快速返回 durable refs；关闭 agent session 后 Graph 保留，另一合格 agent 可受控接管 |
| AT-26 | NFR-01 | 重复/乱序 event、HTTP timeout、bridge crash 无重复 transition；ambiguous create 不盲重发 |
| AT-27 | NFR-01/06 | DB commit 前后逐点 crash；Core committed state 恢复、PC projection 收敛；已执行 effect 不重跑 |
| AT-28 | NFR-01, ARCH-02 | 租约过期但旧 worker 未停时禁止新 effect；迟到输出拒绝；两 owner 竞争只一方获得 admission |
| AT-29 | NFR-02 | 跨公司 SSE、artifact、tool、API、workspace refs 全拒绝；SSRF/path traversal payload 拒绝 |
| AT-30 | NFR-04 | 固定 baseline suite 通过；缺安全能力/未知 event schema fail closed；升级不改变原 run semantics |
| AT-31 | UI-03/04/06, NFR-05 | 断 SSE 后完整补 snapshot；未知状态不显示 PASS；键盘/列表可用；负载基准达标 |
| AT-32 | NFR-06/07 | 从备份恢复并对账后续 external effects；保留/清理符合 active refs 与 hold；RPO/RTO 演练达标 |
| AT-33 | ARCH-05, GOV-07 | 原有 deny precedence、exact hash review、Learning/Rule promotion、family pin regression 全通过 |
| AT-34 | 全局 rollback | 切回时新 owner fenced、旧 owner 不重复执行已发生 effect；pending human decision 仍能处理 |
| AT-35 | GOV-08 | Interaction → Decision 切换只影响新 request；同一 pending request 不在两个 backend 同时生效 |

### 10.1 测试层次

- **Core unit/property tests**：合同、策略优先级、哈希、validator/compiler、状态转移、join、mutation invalidation、child identity。
- **Port contract tests**：provider-neutral 请求与响应 fixtures；同 key/body、同 key/异 body、缺权限、缺 API、stale revision。
- **Plugin harness tests**：routing、capabilities、UI data/actions、event normalization；harness 不能证明真实 host enforcement。
- **真实 host integration**：固定 PC release/SDK、真实数据库、测试公司、实际 Hermes 路径与 workspace provider。
- **故障注入**：crash points、断网、迟到 worker、丢消息、重复创建、revocation、budget stop、disk/audit failure。
- **E2E/UAT**：业务人员从 Root Issue 看进度；设计者发布新图；reviewer 审查证据；operator 恢复/回滚。

至少保留这些 fixtures：带并行 backend/frontend 的设计实现流程；独立 reviewer；人工拒绝再 rework；child graph 失败；UNKNOWN deployment-like 模拟 effect；跨 tenant 恶意请求；Graph v12→v13 migration。

现有工程测试应在真实仓库正确 package layout 中运行。参考文件提到的 `python -m unittest graph.engine.test_engineering_core -v` 只是现有 suite 入口；不能在此零散 mirror 上宣称已跑完整仓库测试。

## 11. Rollout 策略与量化放行

推荐次序：开发 fixture → shadow → 单 project/单 entrypoint canary → 少量低风险 WorkOrders → 更多 graph families → 经专项测试的高风险工作 → legacy retirement。

建议每个 canary 观察至少 7 天或 30 个具有代表性的完成 runs，以较晚达到者为准；团队可依据实际 volume 改指标，但必须在开始前固定。建议目标：

- 未授权 effect、重复外部 effect、跨 scope 泄漏、错误 PASS、dual-owner execution：**0**。
- 所有 active run 的 owned binding、effect、pending governance 对账完整率：**100%**。
- 常态 projection p95 ≤5 秒；PC 故障恢复后 backlog 在容量规划范围内收敛，不能悄悄丢事件。
- 状态 query 与 UI 大图性能达到 REQ-NFR-05 的已记录环境基准。
- 至少一次 plugin/Core/PC 重启、一次 worker unknown、一次 budget stop、一次 authorization revocation 与一次 rollback 演练成功。
- 所有 blocking/high-severity defects 清零，遗留低风险问题有 owner 与期限。

这些是拟议放行标准，不是已经测得的数据。SRE 记录部署规格、事件量、并发度与结果，避免用空载数字证明生产性能。

## 12. Production cutover runbook

### 12.1 切换前

1. 确认 compatibility-lock 和制品 digest，备份 Core、PC、bridge mappings 与 artifact manifest；验证恢复入口。
2. 关闭本次迁移范围的旧系统新 admission；旧任务 drain，剩余任务分类为 safe checkpoint、running、unknown。
3. running/unknown 不迁移；先停止、reconcile 或留给旧 owner 完成。不要同时启用旧 Kanban automation 和 PC wakeup。
4. 核对 Root/Child Issues、workspace、agent capabilities、budget、gateway、pending interaction/approval、external effect refs。
5. 新路径先 read-only health，确认关键 PC 和 Core API 可用。

### 12.2 执行切换

1. 对每个可迁移 WorkOrder 获取 migration lock，记录 source checkpoint、ownerEpoch 和 effect ledger watermark。
2. 在 Core CAS 更新 executionOwner 为 Paperclip path 并提升 epoch；旧 dispatcher 必须被 fence，而非仅隐藏 UI。
3. Bridge 更新对应 bindings，启用该范围的 PC dispatch，做一次 no-side-effect current/claim 验证。
4. 放入 canary 工作，验证证据提交→gate→状态投影；逐批放量。
5. 持续对账，任何安全不变量违例立即触发 freeze。

### 12.3 触发回滚的条件

出现未授权/重复 effect、双执行所有者、scope 泄漏、错误 gate PASS、无法恢复的状态丢失，立即冻结受影响入口与高风险 tool calls。一般 API 错误或 UI 故障可先降级只读、暂停新 admission；是否回滚由 runbook owner 根据影响判断。

## 13. Rollback runbook

回滚不是恢复旧数据库后重新跑所有任务。先保护已经发生的 effect 与人类决定，再恢复执行所有权。

1. 停止新 WorkOrder admission、暂停目标 dispatch，保留 outbox/inbox、logs、approval/effect refs，不清空队列。
2. 请求 PC 停止或完成在途 worker；确认 adapter/provider 状态。未知结果转 UNKNOWN，无法确认时不启动旧 worker。
3. 导出从切换 checkpoint 至今的 canonical events、effects、产物、pending/已完成 governance，进行 reconciliation。
4. 选择兼容回退路径：优先让既有 PF Runtime 继续，只关闭新 bridge admission；可用只读 UI/旧 frontend 检查状态。若切回 legacy executor，先证明它能读取新 schema/contract，否则保持暂停并修复。
5. 在 quiescent 点 CAS 更新 owner 与 epoch；旧 path 导入 canonical mapping/checkpoint，不导入从 PC status 猜测的成功事实。
6. 对已完成 transition 只补投影；对权威确认未发生 effect 的节点才允许重试。未解决 UNKNOWN 不可回退成 READY。
7. 用 rollback fixture 验证后恢复小流量；生成 incident report 和恢复批准记录。

### 13.1 各层独立回退

| 层 | 回退方式 | 限制 |
|---|---|---|
| Plugin UI | 回退 UI 包或禁用 editor，只读 Runtime | 已发布 GraphVersion 不删除 |
| Plugin worker | 回退兼容 bridge 版本，保留 mappings/inbox/outbox | 不回退 namespace schema 到会丢数据的版本 |
| PC host | 仅使用已经测试的 host+DB migration rollback/runbook | 不假设旧 binary 能读取新 schema；必要时恢复匹配备份并对账 |
| Graph default | 切回旧 default pointer | 只影响新 run |
| Active Graph migration | source/successor reverse plan 或 forward recovery | 新外部 effect 后通常不能无损倒退 |
| Cases/Decisions | 关闭新 binding，保留既有 pending backend 处理 | 不复制旧决定成为新权限 |
| Workspace | 保留 worktree/provider 状态并重新关联 | 不自动删目录或 reset branch |

数据库采用 expand → migrate/backfill → dual-read compatibility → 后续版本 contract 的方式。观察期内不 drop 旧关键字段/ledger。降级不兼容时冻结执行比强行跑旧版安全且可恢复。

## 14. Legacy retirement 与最终完成标准

退出旧 Kanban/worker manager 前必须：

1. 所有旧 active runs 已完成或显式迁移；UNKNOWN 为零，或由独立保留机制持续管理且不再由退役系统执行。
2. 新模式经过约定观察期，无双 owner、错误 PASS 或丢失审计。
3. 旧 task/agent/workspace/document IDs 能从新 UI 或 archive 查到，历史证据仍可校验。
4. Legacy dispatch/cron/tool credentials 被撤销或禁用；只读档案不再产生工作。
5. 删除自建通用 Kanban、roster、spawn、workspace lifecycle、财务预算与 generic authorization 的代码路径；保留 Graph-specific planning、budget、evidence 和 policy。
6. 更新 README、操作手册、架构图与 onboarding，移除“Hermes Kanban 是 execution graph kernel”的旧运行说明并保留历史迁移说明。
7. 为 Paperclip 升级建立固定版本 contract suite 和 staging review，禁止自动追 latest。

最终验收交付物：兼容性锁文件、通过的 AT 测试报告、数据对账报告、权限/工具路径验证、性能与恢复实测、runbook 演练记录、完整 graph library 示例、可使用的 Plugin UI、退役清单。

## 15. 主要风险与负责人

| 风险 | 早期信号 | 处理 | Owner |
|---|---|---|---|
| SDK/API churn | 类型/事件/auth 与 baseline 不符 | exact pin、contract suite、隔离 REST adapters | Integration |
| 隐藏的双调度 | 同 node 多 AgentRun、重复 review | 统一 owner/epoch，关闭冲突 automation | Core + SRE |
| 权限与 graph 语义混淆 | Issue done/Decision effect 导致错误推进 | 独立 evaluator + exact target tests | Core + Security |
| Workspace 只是 worktree 而非 sandbox | agent 可访问 sibling repo/secret | runtime/provider 隔离与 egress 测试 | SRE + Security |
| 外部 effect 无幂等/查询 | timeout 后不知道是否完成 | UNKNOWN + reconciliation，限制该 provider | Integration |
| 过度拆分子图 | 入口多但没有独立合同/恢复边界 | 合并 trivial operations，保留真正 workflow | Tech Lead |
| 图编辑削弱 policy | 删除 mandatory gate、侧入口绕过 | 静态/语义 validation + reviewed publish | Core |
| 误把实验性功能当基线 | flag 关闭后系统不能启动 | defaults off + fallback tests | Integration |
| 数据回滚丢掉新 effect | 恢复旧 DB 后重复派工 | ledger watermark 与外部 reconciliation | SRE |
