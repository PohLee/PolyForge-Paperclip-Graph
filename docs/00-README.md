# PolyForge → Paperclip Migration Specification Pack

版本：1.0 · 日期：2026-09-25 · 状态：实施基线提案，尚未实施或完成生产兼容性认证

本文件组承接「了解 PaperClip 插件与治理」讨论，完整定义迁移后的产品需求、工程边界、接口方案、实施阶段和验收方式。正文使用中文，保留代码标识符与英文领域术语。

## 阅读顺序

1. [需求规格与迁移矩阵](01-REQUIREMENTS.md)：目标架构、产品行为、Graph Editor、EntryPoint、能力映射、治理、UI 与非功能需求。
2. [技术实施设计](02-TECHNICAL-PLAN.md)：模块、接口、数据模型、状态机、幂等、事件、执行、恢复与安全。
3. [分期迁移、测试与上线手册](03-MIGRATION-ROLLOUT-ACCEPTANCE.md)：Phase 0–6、可执行工作包、验收用例、数据迁移、切换、回滚。
4. [来源、兼容性与架构决策](04-SOURCES-AND-DECISIONS.md)：讨论来源、当前核查结果、现有代码衔接、假设、待验证项与 ADR。

## 已确定的架构方向

- **Paperclip 是组织、任务、执行资源与平台治理的 control plane。** 负责 Issues、Projects、Agents、工作空间、agent 唤醒、预算、平台授权、工具治理与通用审计。
- **PolyForge 是工程图的 authoritative durable orchestration engine。** 保留 Graph Library/Registry、Graph Runtime、工程策略、契约、证据、质量门禁、可追溯性、版本与恢复。
- **Plugin 是薄的 anti-corruption/control-plane bridge。** 负责对象与事件映射、认证上下文转交、进度投影及 UI，不复制 Graph evaluator，也不另建 agent 调度器。
- **Hermes 是执行 runtime。** 优先复用 Paperclip 的 `hermes_local` / `hermes_gateway`；不因迁移默认新增自定义 runtime adapter。
- **Graph Tools 是协议入口。** `status/current/submit_evidence/request_transition` 访问持久化 Runtime；Graph 生命周期不依附于一次 tool call 或 agent session。
- **普通 Issue Kanban 可复用；工程 Graph 编辑器与运行视图需要 PolyForge Plugin UI。**

## 三项不会被迁移破坏的规则

1. Issue `done`、Agent 成功退出、Human 点击确认，都不能直接令工程节点 `PASSED`；必须检查精确版本、权限、证据和 transition contract。
2. GraphRun 固定 definition、compiled plan、contract、policy 和 child graph 版本。发布新版不更新运行中实例；实例变更走显式 migration。
3. Interaction、Decision、Approval 分别表达交互、工程/业务判断、特权授权。Decision 可以是业务上的“审批”，但不替代 privileged action 的授权。

## 文档的证据边界

需求和设计中的 MUST/必须是 **PolyForge 的目标约束**，不是对 Paperclip 现有功能的承诺。所列 `/v1/...` 是拟新增的 PolyForge API；`pf.*` 是内部规范化事件；示例 YAML/TypeScript 是拟议合同。

已读取原讨论的五轮内容。读取服务对迁移矩阵那条长回复标记了末尾截断；其主要矩阵、Phase 0–6 与后续 Graph 讨论均可获取，不能声称未取得的尾部已逐字复原。用户本次明确列出的范围全部纳入本文件组。原讨论的截图未作为需求证据使用，因为本次任务不依赖其视觉细节。

核查了 Paperclip 官方仓库当前可访问的 `master` 文档与实现。**未取得一个经过集成测试的固定 release/commit 基线**；不能将这些观察等同于任何已部署版本的支持承诺。来源与差异见 [来源文件](04-SOURCES-AND-DECISIONS.md)。Phase 0 必须锁定真实版本、SDK 内容哈希与测试结果后才能上线。

项目的 `sources/` 本次为空且保持只读。现有 `implementation/` 中的 Python 合同和 Graph 文档被用作兼容性参考；它们不是已认证的完整生产仓库。本次只导出文档，不修改实现或部署环境。

## MVP 与可选范围

MVP：Phase 0–4，含最小运行状态/证据查看入口与全部安全条件。Phase 6 提供完整可视化编辑器，可在 Phase 2 后并行开发，不依赖 Phase 5。

可选：Phase 5 Cases/Decisions，及更晚的 Pipeline 外层业务流程。三者均不得成为首版成功运行的必要条件。Execution Workspace 与 sandbox 是否可启用，必须按实际版本、provider 和 deployment profile 验证；工作树隔离不等于安全沙箱。

## 完成的定义

一个真实试点变更能够经过需求、设计、实现、独立审查、验证及必要授权；重启、重复事件、人工等待、预算中止、证据失效都不会绕过门禁或重复外部副作用。退出旧系统前必须证明迁移完整、执行只有一个所有者、回滚可恢复。详细放行条件见 [验收与回滚手册](03-MIGRATION-ROLLOUT-ACCEPTANCE.md)。
