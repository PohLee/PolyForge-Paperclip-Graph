# PolyForge Migration — Technical Implementation Plan

版本：1.0 · 日期：2026-09-25 · 状态：拟议实现设计

关联：[需求规格](01-REQUIREMENTS.md) · [迁移与验收](03-MIGRATION-ROLLOUT-ACCEPTANCE.md) · [来源与 ADR](04-SOURCES-AND-DECISIONS.md)

本文中的类型、表名、API 与 `pf.*` 事件是 PolyForge 新增设计。Paperclip 的调用点必须在 Phase 0 绑定实际固定版本，不把概念接口伪装成已有 SDK 方法。

## 1. 实现策略与部署形态

沿用现有 Python Graph Core，新增独立、常驻的 Runtime Service；用 TypeScript 实现 Paperclip Plugin worker 与 React UI。首版不为接 SDK 重写 Python。Graph 数据库、compiler、evaluator 与 checkpoint 不随 plugin worker 重启消失。

```text
Paperclip host process + database
  ├─ Issue / Agent / Workspace / Governance / Budget APIs
  ├─ Hermes adapters → local or gateway execution runtime
  └─ Plugin host → TypeScript plugin worker
                        ├─ authenticated RPC → Python Runtime Service
                        ├─ bridge mappings + inbox + delivery records
                        └─ UI data/action/stream handlers

Python Runtime Service
  ├─ command/query API
  ├─ graph registry/compiler + semantic policy/evaluators
  ├─ GraphStore + durable journal + transactional outbox
  └─ reconciler; sends work intents through the bridge
```

首版可使用现有 SQLite GraphStore、单个 canonical writer、WAL/事务及受控并发。多个 process 竞争必须由数据库 claim/CAS 约束，不只依赖进程锁。若实际吞吐或部署要求多副本，另立数据层迁移到支持所需事务/锁的数据库；不要因引入 Paperclip 默认做数据库重写。

Plugin 的数据库 namespace 只保存 bridge 自有记录；不能写 Paperclip core 表，不能把 Core schema 迁入 Paperclip 的 public schema。当前 authoring guide 已说明受限 namespace migrations，并明确插件与其同源 UI 属于可信代码；这与旧的纯目标 spec 部分说法不同，以实际版本和测试为准。[Authoring guide](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_AUTHORING_GUIDE.md)

### 1.1 建议模块布局

```text
polyforge/
  graph/engine/                     # 保留现有 Python 模块及兼容 imports
    engineering_contracts.py
    engineering_policy.py
    engineering_runtime.py
    controller.py
    subgraphs.py
    state.py
    ...
  core/
    registry/                       # definitions, drafts, versions, dependencies
    compiler/                       # validation, deterministic plans, schema adapters
    entrypoints/                    # admission and preconditions
    contracts/                      # agent capability, operation, transition, reports
    evidence/                       # ingestion, lineage, invalidation
    gates/                          # evaluator registry and gate aggregation
    runtime/                        # runs, claims, checkpoints, effects, recovery
    ports/                          # provider-neutral Protocol interfaces
    migrations/                     # additive Core schema migrations
  services/runtime_api/             # versioned command/query service, auth middleware
  packages/
    protocol/                       # JSON Schema/OpenAPI; generated TS/Python models
    paperclip-plugin/
      src/manifest.ts
      src/worker.ts
      src/router.ts
      src/ports/                    # SDK translation only
      src/experimental/             # case, decision, pipeline adapters
      src/identity/                 # trusted actor forwarding
      src/events/                   # inbox, normalization, replay, reconciliation
      src/tools/                    # constrained polyforge.* handlers
      src/ui/                       # library, editor, runtime, inspectors
      migrations/                   # bridge-owned schema only
      tests/                        # SDK harness + actual host contract tests
    paperclip-adapter/              # NOT created for MVP; reserved future option
  graph-library/
    requirement/
    design/
    implementation/
    verification/
    release/
  tests/
    contracts/ fixtures/ integration/ recovery/ e2e/
  ops/
    compatibility-lock.json
    runbooks/
```

`core/` 表示职责边界，可先在现有 `graph/engine` 内实现再逐步抽取；不要一次性重命名全部模块。`@polyforge/paperclip-plugin` 是发布包名，`@polyforge/protocol` 是协议包建议名，均不是已存在的产物。

## 2. 所有权与执行职责

| 决定/状态 | 唯一所有者 | 另一侧可以做什么 |
|---|---|---|
| 工程依赖、join、gate、ready | PF Runtime | PC 显示 blocker/summary，不推断 gate |
| Issue assignment / checkout / physical agent invocation | PC | PF 请求创建/分配工作，不 spawn worker |
| 节点 attempt admission / lease fence | PF Runtime | PC AgentRun 提供执行身份，bridge 取得绑定 |
| 心跳调度、排队、会话恢复、物理进程终止 | PC | PF 记录请求、等待平台确认并 reconciliation |
| 业务 retry/rework 和重试上限 | PF Runtime | PC 可以重投递唤醒，但不能自主批准新语义 attempt |
| 财务预算、平台 grants、工具授权 | PC | PF 请求/检查约束结果，不能 override |
| Artifact evidence / semantic state mutation | PF Runtime | PC 提供存储、交互与审计引用 |

PC scheduler 与 PF dependency planner 是两个不同层次：前者安排已经获准的 worker 工作，后者判断工程步骤是否可执行。禁止创建第三个 plugin agent queue。

Hermes adapter 成功退出只产生 `ExecutionObservation`。PF 读取证据、评估并提交 transition 后才投影 node success。PC 通用 auto-review 若也启用，必须在试点明确是否是工作管理复核还是 PF gate 的承载者；不能重复唤醒、各自生成同一 review 或形成循环。

## 3. Provider-neutral ports

这些接口由 Core 声明、bridge 实现。所有 mutation 返回 durable operation/ref，可异步 pending，禁止把 UI hook 当作可靠消息总线。

```ts
type Scope = { companyRef: string; projectRef: string };
type ProviderRef = { provider: "paperclip"; kind: string; id: string };
type CommandMeta = {
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  causationId?: string;
  expectedVersion?: number;
};

interface WorkManagementPort {
  ensureWorkUnit(intent: WorkUnitIntent, meta: CommandMeta): Promise<ProviderRef>;
  projectStatus(change: StatusProjection, meta: CommandMeta): Promise<void>;
  resolveWorker(requirement: WorkerRequirement): Promise<WorkerCandidate[]>;
  assignAndWake(binding: DispatchBinding, meta: CommandMeta): Promise<DispatchReceipt>;
  requestStop(ref: ProviderRef, meta: CommandMeta): Promise<StopReceipt>;
  inspectExecution(ref: ProviderRef): Promise<ExecutionObservation>;
}
interface GovernancePort {
  requestInteraction(req: InteractionRequest, meta: CommandMeta): Promise<ProviderRef>;
  requestEngineeringDecision(req: DecisionRequest, meta: CommandMeta): Promise<ProviderRef>;
  requestActionAuthorization(req: AuthorizationRequest, meta: CommandMeta): Promise<AuthorizationRef>;
  readVerifiedResolution(ref: ProviderRef): Promise<VerifiedResolution>;
  checkAuthorization(ref: AuthorizationRef, action: ExactAction): Promise<AuthorizationStatus>;
}
interface WorkspacePort {
  resolve(req: WorkspaceRequirement, meta: CommandMeta): Promise<WorkspaceBinding>;
  inspect(binding: WorkspaceBinding): Promise<WorkspaceObservation>;
}
interface ArtifactPort {
  publish(req: ArtifactUpload, meta: CommandMeta): Promise<ArtifactRef>;
  readVerified(ref: ArtifactRef): Promise<VerifiedArtifact>;
}
interface ObservabilityPort {
  publishProgress(event: ProgressProjection, meta: CommandMeta): Promise<void>;
}
```

`resolveWorker` 的 capability 过滤是 PolyForge bridge 的逻辑：读取平台 Agents，关联受治理的 CapabilityBinding，再选 worker。**不假定 PC 自动提供任意语义 capability matcher**。Core 不读取 SDK 类型，外部 identity 通过内部稳定 SubjectRef 绑定。

`WorkspacePort.resolve` 可触发 PC 既有 Issue workspace policy 或经认证 REST provisioning；不是宣称 `ctx.executionWorkspaces.create` 已存在。`GovernancePort.requestActionAuthorization` 分流至平台已支持的 Approval 类型或 governed tool action，不凭空创建自定义 Approval 类型。unsupported 必须返回可解释的 BLOCKED。

### 3.1 Bridge API 适配规则

1. 优先使用已验证 SDK host APIs；没有 SDK surface 时，只有单独允许、经过认证和合同测试的 REST client 可以调用官方路线。
2. REST client 不借用无关 agent token，不伪装人类，不查询平台 DB；每项能力记录认证方式、权限、是否需要 agent run、feature flag 与 fallback。
3. 默认不申请 `approvals.respond`、authorization grant 管理、任意 process execution。新增 capability 必须审查安装/升级权限影响。
4. Plugin SDK 的 `ctx.approvals` 支持 read/decide，但这不证明任意 approval creation 可用；对人类决定的代理有身份要求。Workspace metadata 为 read-only surface；Cases/Decisions/Pipelines 不应假定具有 first-class client。[SDK types](https://github.com/paperclipai/paperclip/blob/master/packages/plugins/sdk/src/types.ts)
5. 若 API unsupported：只读展示可以降级；执行授权、身份校验或 durable reconciliation 不可降级为“继续执行”。

## 4. 核心数据模型

以下是逻辑模型；迁移应复用现有表及字段，不重复创建已存在的 execution journal。

| 模型 | 必需字段/约束 |
|---|---|
| GraphDefinition | graphId、schemaVersion、nodes、edges、entrypoints、policyRefs、dependency constraints |
| GraphDraft | draftId、graphId、baseVersion、revision、author、definition、validation/compile refs；CAS revision |
| GraphVersion | graphId/version 唯一；definitionHash、compilerVersion、planHash、dependencyLockHash、publishedBy/At；不可变 |
| GraphDefaultPointer | graphId、environment/scope、version、generation；独立 CAS 与审计 |
| EntryPoint | key、input/output schema、required facts、admission capability、coordinator requirement、allowed start nodes、resume policy |
| WorkOrder | workOrderId、scope、source ref、startIntentId、input snapshot、entrypoint、rootIssueRef、optional CaseBinding |
| GraphRun | runId、familyId、parent invocation、workOrderId、GraphVersionRef、pins、status、stateVersion、eventSequence、ownerEpoch |
| NodeExecution | runId/nodeId/iteration 唯一；status、contractHash、input refs、output refs、activeAttemptId、workspace requirement |
| TransitionContract | immutable ID/version/hash；run/node/iteration、subject contract、operation、inputs、effective policy、authority、environment、intended mutations、evidence/evaluators |
| ExecutionAttempt | attemptId、transitionHash、attemptNo、leaseEpoch、agent subject、PC AgentRunRef、adapter binding、startedAt、lease status、checkpointRef |
| GraphCheckpoint | run/node/attempt、journalSequence、schemaVersion、planHash、contractHash、verified artifact refs、pending intents；不保存明文 secrets |
| EffectRecord | effectKey、transitionHash、stepId、providerRef、requestHash、status、reconciliation evidence、resultHash |
| ArtifactRef | kind、provider object/revision、contentHash、mediaType、size、repository/commit、scope |
| Evidence | evidenceId、kind、artifact refs/digests、producer subject/run、transitionHash、input revision binding、provenance、validity |
| GateEvaluation | evaluationId、gate/evaluator versions、transitionHash、evidence set hash、PASS/FAIL/ESCALATE、reason、createdAt |
| GovernanceBinding | bindingId、semantic kind、PC ref、exact target hash、requester、required role/independence、expiry、verified resolution |
| CapabilityBinding | subjectRef ↔ PC AgentRef、capability contract version、scope、allowed entrypoints、resource ceiling、review provenance、revocation |
| WorkBinding | run/node/iteration ↔ IssueRef、contractHash、workspace ref、projectionVersion、executionOwner、ownerEpoch |
| ChildRunLink | parentRun/node、invocationGeneration、inputHash、childRun、childVersion、export contract；组合唯一 |
| MigrationRecord | sourceRun、successorRun、planHash、mapping、approval refs、checkpoint refs、cutover epoch、status |

Bridge 持久化 `provider_bindings`、`event_inbox`、`delivery_operations`、`projection_offsets`、`compatibility_state`。Core 持久化领域事件、自己的 inbox/outbox 和 command results。所有唯一约束包含 scope 或不可跨 scope 使用的全局 ID。

### 4.1 Graph 示例：能力而非 Agent ID

```yaml
schema_version: 1
graph: design
version: 13
entrypoints:
  design.start:
    inputs: [requirement_baseline]
    requires_facts: [requirement_gate_passed]
    coordinator:
      required_capabilities: [design.coordinate]
      preferred_roles: [designer]
      fallback_roles: [tech_lead]
    start_nodes: [architecture]
    exports: [architecture_spec, api_contract, design_review]
  design.security_review:
    inputs: [architecture_spec, requirement_baseline]
    requires_facts: [architecture_candidate_validated]
    coordinator:
      required_capabilities: [security.review]
    start_nodes: [security_review]
    exports: [security_review]
nodes:
  architecture:
    kind: agent_operation
    operation: {id: architecture.design, version: 3}
    executor: {required_capabilities: [architecture.design]}
    produces: [architecture_spec, api_contract]
  security_review:
    kind: agent_operation
    operation: {id: security.review, version: 2}
    executor:
      required_capabilities: [security.review]
      independent_from: [architecture.producer]
    produces: [security_review]
  design_gate:
    kind: gate
    evaluator_refs: [contract_schema_v1, threat_model_review_v2]
    human_decision: {required: true, semantic_kind: design_acceptance}
edges:
  - {from: architecture, to: security_review}
  - {from: security_review, to: design_gate}
```

示例省略完整 schema，不可直接当作现有 compiler 输入。侧入口的外部前置事实必须由 admission 检查；其 exports 只承诺该子流程结果，不假装完整 Design Graph 已完成。

### 4.2 版本与 hash 规则

区分五类版本：definition version、draft revision、run stateVersion、attempt/lease epoch、external object revision。禁止混用一个 `version` 字段表示所有含义。

- 用固定 canonical JSON 规则计算 hash：编码、键排序、数值规则、数组有序语义、空值、时间格式必须在协议中定义；secret 只 hash 引用/版本，不 hash 明文。
- Graph run pin 包含 graph/child graph、compiler、schema、operation、policy、RuleSet、agent capability contract、evaluator 的版本或 hash。
- 沿用现有 transition identity/hash 规则并增加显式 schemaVersion；升级 hash 算法不能令旧 identity 重解释。
- mutable status、UI layout、日志时间不参与 immutable contract hash。
- 每次 attempt 复用同一 transitionHash；agent/adapter 的不可变执行绑定改变时必须按合同规则建立 replacement transition，旧 attempt 先失效，不能静默改绑定。
- policy pin 固定工程规则；实时平台 deny/revocation、凭据失效与紧急停止仍在 admission 和提交前重验。

## 5. PolyForge API 与工具协议

API base：`/v1`，由 Runtime Service 提供。外部调用经 bridge；内部服务可使用 mTLS 或短期 audience-bound token。下面不是 Paperclip 原生路由。

| API | 行为 | 主要约束 |
|---|---|---|
| POST /graphs/{id}/drafts | 从 published 或空模板建 draft | graph author scope |
| PATCH /drafts/{id} | 更新结构/属性 | If-Match draft revision |
| POST /drafts/{id}/validate | 返回 structural/contract/policy errors | 对指定 revision |
| POST /drafts/{id}/compile | 生成 plan 与 dependency lock | 输入 hash 不变 |
| POST /drafts/{id}/publish | 生成 immutable version | review/authorization + CAS |
| POST /graphs/{id}/activate | 更改未来 run 默认版本 | 独立权限，不改变旧 run |
| POST /work-orders | 校验入口、create-or-get run | startIntentId 幂等 |
| GET /runs/{id} | 权威 snapshot、stateVersion、seq | scoped read |
| GET /runs/{id}/events?after=N | 持久化增量事件 | cursor retention/分页 |
| POST /runs/{id}/claims | 将平台 run 绑定到获准 attempt | issue checkout + ownerEpoch |
| GET /runs/{id}/current | 当前 worker 合同与输入 | verified actor/claim |
| POST /runs/{id}/artifacts | create-or-verify 固定产物引用 | immutable content identity |
| POST /runs/{id}/evidence | ingest/verify evidence | transition + attempt fence |
| POST /runs/{id}/transitions | 请求评估与状态提交 | expectedStateVersion + contractHash |
| POST /runs/{id}/help | 建澄清/评审 intent | 幂等、不自动批准 |
| POST /runs/{id}/commands | pause/resume/cancel/retry | 管理权限 + 合法状态 |
| POST /runs/{id}/migrations/plan | 计算 successor dry-run | quiescence/compatibility report |
| POST /runs/{id}/migrations/commit | 提交批准的迁移计划 | CAS + fences + planHash |

### 5.1 Mutation envelope

```json
{
  "schemaVersion": 1,
  "commandId": "cmd-unique",
  "idempotencyKey": "transition-hash:submit-report:report-identity",
  "correlationId": "work-order-id",
  "runId": "graph-run-id",
  "nodeId": "security_review",
  "iteration": 0,
  "attemptId": "attempt-id",
  "leaseEpoch": 4,
  "expectedStateVersion": 23,
  "contractHash": "sha256:...",
  "payload": {"evidenceIds": ["evidence-immutable-id"]}
}
```

Actor/company 身份从可信 transport context 派生，不从此 body 读取。bridge 必须核对 host actor、Issue checkout、PC AgentRun 与 WorkBinding；发送 service credential + 有期限的 actor assertion，Core 只信任受限 bridge issuer。

响应包括 `commandId, applied, stateVersion, status, resultRef, blockers[]`。`202 pending` 表示请求已持久化；重试相同 key+payload 返回原结果；同 key 不同 payload 返回 `409 IDEMPOTENCY_CONFLICT`。版本冲突 `409 VERSION_CONFLICT` 带当前版本；`403 AUTHORIZATION_DENIED`、`422 CONTRACT_INVALID`、`423 RUN_BLOCKED`、`503 CONTROL_PLANE_UNAVAILABLE` 为拟议 error codes。

工具命名 `polyforge.*` 是逻辑产品名，发布时使用 host 实际 namespace 规则。Tools 做 schema 校验和调用上述 API，不承载长时间执行；Runtime 重启后恢复同一个命令结果。

## 6. 端到端执行序列

1. 用户或受权 automation 创建/标记工程 Root Issue；bridge 用可信规则确定 entrypoint，建立唯一 `startIntentId`，普通 Issue 不进入 PF。
2. Core 校验 scope、capability、输入 facts 和版本依赖，原子写 WorkOrder、GraphRun、初始 checkpoint、admission event 与 outbox。
3. Planner 只将 readiness/gate 已满足的 node 变成 READY；bridge 消费 WorkUnitIntent，幂等创建/绑定 Child Issue，记录 workspace requirement。
4. Bridge 从 PC roster 与 CapabilityBinding 选择合格 worker；先检查平台可调用状态、预算、权限和 workspace，创建 dispatch intent，再通过平台分配/唤醒。
5. Hermes 经 PC adapter 执行，启动上下文带 GraphRun/Node/ContractRef。首次 `current/claim` 必须取得 Core lease fence；无 claim 或过期 claim 不得执行合同内副作用。
6. Agent 在治理工具和环境限制内产生产物；`submit_artifact` / `submit_evidence` 提交候选，trusted ingestion 核对 hash、revision、producer、attempt 与范围。
7. `request_transition` 校验前置条件、输入新鲜度、权限与独立 evaluator。缺少人类判断时落盘 pending 并生成 governance intent，释放 worker，等待未来事件。
8. 人工/独立 reviewer 通过平台响应，bridge 重新读取权威对象、核对 target hash 和 responder，Core 收录 resolution 作为证据；不是直接将 gate 标成通过。
9. 所有 evaluator PASS，且 permission、输入、输出 CAS 仍有效时，在一个 Core 事务提交 graph mutations、invalidation、node status、checkpoint、event 与 outbox。
10. Bridge 投影 Issue 状态/文档/进度；投影失败不撤回已提交工程事实，只重试 outbox。父节点等待 child completion 及 typed exports，根完成后才投影 Root Issue done。

当同一 transition 发布失败而 external execution 已完成，重试 publication，不再执行 adapter。沿用现有 `ExecutionState`/effect journal 的语义。

## 7. 状态机、checkpoint 与并发

### 7.1 逻辑状态

```text
GraphRun:
CREATED → ACTIVE ↔ WAITING
             ↔ PAUSED
             → BLOCKED → ACTIVE (explicit authorized resolution)
             → COMPLETED | FAILED | CANCELLED

Node:
PENDING → READY → DISPATCH_REQUESTED → RUNNING
  → EVIDENCE_READY → EVALUATING → PASSED
                         ├→ WAITING_GOVERNANCE → EVALUATING
                         ├→ REWORK_REQUIRED → READY (new iteration/contract as needed)
                         └→ FAILED / BLOCKED

Attempt:
PREPARED → RUNNING → CHECKPOINTED → RUNNING
                  → EVIDENCE_READY → COMPLETED
                  → FAILED | CANCELLED | UNKNOWN
UNKNOWN → RECONCILING → EVIDENCE_READY | PREPARED | BLOCKED
```

这些逻辑状态适配到现有 enums，不要求破坏已有格式。GraphRun WAITING 与 node WAITING_GOVERNANCE 不等于 agent process 持续运行；长等待只保留 durable state。

### 7.2 原子提交

Core command transaction：

```text
verify command key + payload hash
check stateVersion / current claim / ownerEpoch
check pinned contract + fresh inputs + permissions
write semantic mutation + gate result + checkpoint
append domain event + increment sequence
insert outbox intents + command result
commit
```

不存在跨 PC 与 Core 数据库的原子事务。两者采用 durable intents、at-least-once delivery、幂等结果、reconciliation；不能把 HTTP success 当作全局提交。

### 7.3 Claim 与 fencing

- 同一 node/iteration 只允许一个 active attempt claim。每次权威接管增加 `leaseEpoch`，所有写入与副作用请求带 epoch。
- PC checkout 保护 Issue 层；PF claim 保护工程 attempt 层，两者都必须匹配。
- Lease 到期只意味着需要检查，不代表旧 worker 已停止。必须先确认 PC/adapter 终止或 provider fencing 有效，再考虑后续 dispatch。
- Late response 可保存为隔离的诊断记录，不得改变现行 state 或补写通过结果。
- pause 阻止新 admission；cancel 还要请求平台停止现行工作。停止无确认时进入 UNKNOWN/RECONCILING，不能立即派替代 worker。

### 7.4 Checkpoint 内容与恢复

Checkpoint 保存执行计划/contract hash、journal sequence、node/attempt/epoch、可验证产物、已记录 effect、pending governance 与 child refs。它不是 agent 对话摘要，也不以 volatile session memory 作为恢复真值。

恢复顺序：加载 snapshot → replay 后续已提交事件 → 检查 PC agent/workspace/tool authorization → reconciliation effects → 恢复等待或继续获准节点。Agent session 可用时只是优化，不可用时从合同与证据重建上下文。

## 8. 幂等、消息与事件映射

### 8.1 身份分层

| 行为 | 幂等身份 |
|---|---|
| 首次进入图 | scope + WorkOrder/startIntentId + entrypoint；用户显式新 run 需新 intent |
| Child run | parentRun + parentNode + invocationGeneration + 输入/版本绑定 |
| 外部工作单元 | scope + run + node + iteration |
| Transition | 原有 canonical TransitionContract hash |
| Execution attempt | transitionHash + attemptNo；不改变外部 effect 的业务 key |
| 外部副作用 | transitionHash + stable stepId + target/request hash |
| Evidence/Artifact | immutable ID + content hash，create-or-verify |
| Governance request | transitionHash + semantic gate/action ID + exact target hash |
| 事件接收 | source + scope + sourceEventId |
| 进度投影 | targetRef + PF event sequence / projection generation |

EffectKey 不应使用每次 HTTP 重试生成的随机 ID，也不应仅用 attemptNo，否则重试会重复副作用。新业务 effect 必须显式创建新的 transition/step identity。

### 8.2 Inbox/outbox

Core outbox 与工程事务同库提交；bridge inbox 先落盘再 acknowledge。bridge 将 API 操作记录为 pending → sent → observed → reconciled，最终 receipt 返回 Core。bridge 接收 PC events 同样先持久化，再转发规范化观察。

相同 event 重放不重复写事实；乱序事件使用 revision/sequence 或重新 fetch 当前对象。平台没提供可靠 cursor 时，定期按 owned bindings 枚举和核对状态，不假定 event stream 有 durable replay。未知 schema 放入 quarantine，保留 payload hash 和版本并告警。

对外 create 遇到超时：先按已记录 provider ID 或唯一关联键查询。**若 PC API 不支持原生幂等或可证明唯一的检索，则不盲重发 create**；进入 ambiguous_create 并人工/自动核对。缺少这项能力是 Phase 0 需解决的可用性限制，不能许诺已具备 exactly-once create。

### 8.3 规范化事件与动作

左侧是概念源事件；括号中的 PC 名称为讨论/当前 spec 中的候选，需要在固定 host 上验证。右侧 `pf.*` 由本系统定义。

| PC 观察 / PF 事件 | Bridge 动作 | Core 处理 / 平台投影 |
|---|---|---|
| Issue 创建/绑定/分配（issue.created / issue.updated / assignment wakeup） | 按显式 routing 生成 WorkOrder/start intent | `pf.work_order.accepted`，幂等 admission |
| PC agent run started | 读取 checkout 与身份；关联 dispatch | `pf.execution.observed`，claim 验证后 RUNNING |
| PC agent run finished | 获取产物/结果摘要 | 候选证据；**不直接 PASS** |
| PC agent run failed/cancelled | 保存退出原因，查 effect 状态 | transient / permanent / UNKNOWN 分类 |
| Issue status 被拖成 done | 发 completion observation | evaluate 或显示 missing evidence；不触发 downstream |
| Issue pause/cancel / tree control | 形成 authenticated control request | checkpoint/stop/reconcile；保留 audit |
| Interaction/Decision resolved | fetch 对象、验证人类/角色/target | `pf.governance.observed`，重新评估 gate |
| Approval decided/revoked | fetch current authorization | exact action 检查；暂停或重新授权 |
| Budget incident / agent pause | 保存平台阻塞原因 | BLOCKED_BUDGET / BLOCKED_PLATFORM；不绕过 |
| Workspace changed/deleted | 校验当前绑定与产物 | BLOCKED_WORKSPACE，禁止误用新目录 |
| Document revision changed | 验证是否影响当前 evidence | mark stale / dependency invalidation |
| pf.node.ready | ensure Issue、选 worker、检查资源 | PC assignment/wakeup |
| pf.gate.waiting | create-or-get governance request | PC Interaction 或可选 Decision/Approval |
| pf.transition.committed | 更新有序 projection | PC Issue summary/status、activity link |
| pf.run.completed | 检查所有 exports/root 完成合同 | Root Issue done，optional Case summary |

投影自带 origin/correlation marker；bridge 不将自身 status update 再视为新启动请求。Webhook sender identity 只证明消息来源，仍需授权读取被引用对象。

### 8.4 状态投影

| PF 语义 | PC Issue 建议投影 | 解释 |
|---|---|---|
| PENDING / 未 materialize | backlog 或不建 Child Issue | 不派 worker |
| READY | todo | 已获准工作，仍受 PC checkout/budget 限制 |
| DISPATCH_REQUESTED / RUNNING | in_progress | 显示实际 agent run 链接 |
| EVALUATING / WAITING_GOVERNANCE | in_review | 是否用 blocked 由平台 policy 决定，记录具体原因 |
| BLOCKED / UNKNOWN | blocked | 预算、环境、授权、证据或 effect 未知 |
| PASSED / GraphRun COMPLETED | done | 仅在 PF commit 后 |
| CANCELLED | cancelled | 外部 effect reconciliation 状态另行显示 |
| FAILED | blocked + failure summary | 平台无同名状态时不能伪装为 done |

## 9. 工程 gate、授权与 evidence ingestion

自动 evaluator、独立 agent evaluator 和 human decision 都返回 typed result，并固定 evaluator version、evidence set、输入 revision。聚合默认 FAIL 优先；缺少任一必需 evaluator/evidence 或等待人工时 ESCALATE；全部必需评估 PASS 才允许状态提交。Graph 自定义 all/any/quorum 不得绕过标记 mandatory 的 gate。

Evidence ingestion 依次验证 scope、producer/PC run、active claim、contract-bound output type、内容 hash、来源 revision、可信执行记录与 freshness。Agent 声称“测试已过”只能作为报告候选；要求 CI/deterministic test evidence 的 gate 必须读取相应可信来源。

人工决定的目标使用 `decisionTargetHash`，至少绑定 gate/action、transition、input/output digests、policy/evaluator versions、选择项与 authority。平台对象不能精确保存这些字段时，Core 保存 canonical target，平台只引用 ID/hash；bridge 重新查询结果并比对，不能信任 callback 带来的 `approved=true`。

Decision effects 只允许白名单中的 UI/工作管理副作用。初期优先使用无状态推进 effect 的选项；即使某 effect 更新 Issue done，Core 仍自行决定何时推进。禁止让 PC Decision 的 effect 与 Core transition 形成两个不同的执行入口。

Governed self-improvement 保留现有 LearningCatalog → independent review → proposal → deterministic evaluation → exact-target human approval → immutable new definition 的链路。Active pointer 只影响未来 run-family；任何 policy baseline 弱化需明确治理流程，不能从 agent feedback 自动学习并生效。

## 10. 故障分类与恢复语义

| 故障 | 立即状态/动作 | 允许恢复 | 禁止行为 |
|---|---|---|---|
| 重复 event/tool command | dedupe 返回既有结果 | 幂等 replay | 第二次 dispatch/提交 |
| event 乱序/丢失 | 标记 lag，fetch/reconcile | 按权威 revision 收敛 | 按到达时间覆盖新状态 |
| plugin worker crash | durable inbox/outbox 保留 | 重启后恢复 delivery | 在内存重建后全量重新创建 |
| Core 在 DB commit 前崩溃 | 事务回滚 | 重发命令、幂等判断 | 将未 commit 的 UI 消息当事实 |
| Core commit 后 PC 更新失败 | projection pending | outbox 重投影 | 再执行已完成工作 |
| Hermes/PC run 退出未知 | UNKNOWN | authoritative reconciliation | timeout 后直接重跑副作用 |
| lease 过期/旧 worker 返回 | reject stale fence | 确认停止后新 claim | 旧 checkpoint 覆盖新 attempt |
| Workspace 丢失/branch 漂移 | BLOCKED_WORKSPACE | 从固化产物恢复并重验 | 新目录冒充原工作状态 |
| stale input / changed artifact | BLOCKED_STALE_INPUT 或 REWORK_REQUIRED | 新 contract/新 evidence | 继承旧 approval/PASS |
| Approval 过期/撤销 | 阻止 admission/commit | 新授权或取消 | 旧批准继续执行 |
| Budget exhausted | BLOCKED_BUDGET | 由平台合法恢复后继续 | 切换 agent 绕过预算 |
| evaluator error | ESCALATE + diagnostic | 修复后对同一证据重评 | 把 exception 当 PASS |
| permanent policy/contract failure | FAILED/BLOCKED，不自动 retry | 新合法请求或人工处置 | 放宽 policy 让测试通过 |
| human rejection | REWORK_REQUIRED / FAILED / CANCELLED | 按合同新 revision | 不停重问直到同意 |
| child failed | 执行声明的 parent failure policy | local remediation 或 parent block | parent 仅凭 worker exit 完成 |
| Audit durable write 失败 | 暂停相关敏感操作、保留 incident | 审计恢复并 reconciliation | 静默丢日志继续高风险调用 |
| Experimental API 失效 | feature-specific degraded | Root Issue / verified Interaction fallback | 放宽身份、授权或 gate |

重试采用有限指数 backoff+jitter，并按 failure class 决定。网络重投递预算与工程 rework budget 分开；waiting human 不消耗执行重试次数。所有 timeout 都有明确 owner 和 escalation。

### 10.1 外部 effect reconciliation

Adapter/provider 必须返回三类事实之一：effect 已发生及精确 receipt、权威确认未发生、仍未知。只有权威 absence 且旧 worker 已 fenced/stopped 才允许再次尝试。provider 无法查询且不支持 idempotency 时，保持 UNKNOWN 交由有权人员核对。补偿是独立、可授权、可失败的新 workflow，不把数据库 rollback 等同外部撤回。

## 11. 编辑器与版本迁移实现

React canvas 可选 React Flow/XYFlow；该选择是实现建议，不要求固定库版本，需在实现时评估维护状态。图表组件只是输入法，领域逻辑在 Core。

Draft API 以 JSON Patch 或全量 canonical payload+ETag 保存；布局单独保存在 `GraphLayout`。界面先本地 schema 提示，再显示服务端完整 validator 结果。Compile artifact 记录源 hash 与 dependency lock；Publish 事务再次核对二者，防止“验证后被改”。

Published version 的 deletion 默认禁止；仅 deprecate/retire。仍有 run/approval/audit 引用的版本必须可读。默认版本回退只是更改未来 admission，不会重新启动/回退现有 run。

迁移首版步骤：

1. 生成 MigrationPlan，固定源 stateVersion/checkpoint 和目标 dependency closure。
2. 对比节点、输入/输出、evaluator、authority、effect identity 与 pending governance，生成兼容/失效报告。
3. 暂停新 dispatch，确认所有 active attempt 停止且 UNKNOWN 全部处理；child runs 逐个纳入计划，否则阻止迁移。
4. 审核并批准 planHash。若 source 有变化，计划失效。
5. 一个 Core 事务创建 successor run、复制经重验的事实引用、记录 lineage、迁移 ledger references、fence source，并写出新 mapping intents。
6. Bridge 将后续工作绑定到 successor；旧 Issue/attempt 保留历史链接。source 变为 superseded 但不可删除。
7. 若新 run 未产生任何新外部 effect，可按已审阅 reverse plan 恢复旧 run 并增加 epoch；否则只允许 forward recovery 或受治理补偿。

动态 mutation 使用计划内扩展模板、deterministic instance ID、scope/evidence/预算约束；每次新增节点记录 mutation hash。代码/数据 trace mutation 与 workflow structure mutation 使用不同命令，防止名称混淆导致越权。

## 12. 安全与授权边界

| 边界 | 强制控制 |
|---|---|
| PC UI → plugin action | 平台认证 + 公司访问，服务端重新解析 resource owner；CSRF/session controls 由部署验证 |
| PC agent → Graph Tool | authenticated PC run + checkout + CapabilityBinding + PF claim/epoch |
| plugin → Runtime | mTLS/短期 token、audience、expiry、nonce/replay protection、scope-bound actor assertion |
| Runtime → PC | 最小 service capability；人类批准必须原生或可信用户操作链 |
| runtime → external tool | governed gateway + scoped token/profile + 环境网络/凭据隔离 |
| artifact URI → downloader | provider allowlist、大小/类型上限、hash、SSRF/path traversal 防护 |
| workspace path → executor | 受信 host metadata、规范化路径、symlink/路径范围验证、只读 reviewer |
| company ↔ company | 每条查询/stream/event/binding scope 校验，不依赖前端过滤 |

Manifest capability 是 host API 使用约束，不是恶意 plugin 的完整 sandbox。UI 同源运行尤其需要可信安装、代码审核、依赖固定和安全渲染；禁止插入未清洗 HTML 或泄露 token。[Plugin authoring trust model](https://github.com/paperclipai/paperclip/blob/master/doc/plugins/PLUGIN_AUTHORING_GUIDE.md)

核心策略继续遵循 deny > require_approval > allow、无匹配则 deny，以及 org/project/workflow/agent/transition 的权限上限。工程语义不得扩大平台资源授权。对独立审查同时核对 artifact producer、reviewer capability、角色冲突与证据，而不只比较两段 agent 名字。

Secrets 只传 reference，日志与 UI 使用 redacted summaries。API 只允许引用受控对象，不接受任意 shell、任意 runtime path、任意 SQL 或让 caller 注册 evaluator。部署前测试凭据轮换和撤销后的立即拒绝。

## 13. 可观察性与运维接口

每条日志携带 workOrder/run/node/transition/attempt/PC issue/PC run/correlationId；避免把 prompt 与 secret 原文当日志字段。建议 counters/gauges：

- inbox duplicates、schema quarantine、outbox oldest age、projection lag、reconcile mismatch。
- attempts UNKNOWN、stale lease rejected、duplicate effects prevented、active execution owners。
- waiting governance age、approval stale/revoked、gate missing evidence、budget/platform blocks。
- workspace validation failure、artifact digest mismatch、cross-scope denial。

Health 分为 ready、read-only、degraded、blocked；readiness 检查包括 Core DB、bridge persistence、PC version compatibility 和必须的 auth/workspace capability。平台不可用期间允许读取已有 snapshot；禁止新 privileged admission。保留人工 resolution/reconcile 命令但要求权限、原因和审计。

## 14. 交付顺序与设计退出条件

先冻结 contracts/ownership，再实现 ports + fake provider、durable service、bridge read-only shadow，随后逐节点切 execution。所有 phase 的具体 work items 和 release gates 在 [迁移手册](03-MIGRATION-ROLLOUT-ACCEPTANCE.md)。

技术设计完成不等于集成完成。以下必须由实现证据关闭：真实 PC 版本与 SDK pin、Issue create 幂等策略、真实事件名和重放能力、workspace provisioning 路径、Approval 创建机制、Hermes checkpoint/reconcile/cancel 语义、tool governance 覆盖、host UI slots、灾难恢复演练。
