# Phase 0 source and infrastructure inventory

Snapshot: 2026-09-30. This inventory describes the checked-out implementation, not an assumed
legacy system. It exists to make ownership and migration boundaries auditable before any cutover.

## Scope and completeness

The repository contains the PolyForge protocol, Python Core/Runtime, and Paperclip plugin bridge.
The specification says the legacy `sources/` area is empty (see `docs/00-README.md`), and no such
directory is present in this checkout. A read-only survey of every local and remote Git ref at the
snapshot found only the initial LICENSE commit, the PolyForge implementation, and the current
integration-fix branch; no tracked ref contains `sources/`, a legacy Kanban/roster schema, database
export, or artifact manifest. This is evidence about repository history only: no legacy material
was found here, but infrastructure or exports may exist elsewhere. Therefore the current-stack
inventory below is reproducible, but it is not a complete inventory of infrastructure outside this
repository. P0-1 and P1 import acceptance remain open until any such source is identified and
inventoried without changing its history.

## Ownership and dependency inventory

| Surface | Authority / implementation | Direct dependencies in this checkout | Migration/readiness boundary |
|---|---|---|---|
| Work items and Kanban | Paperclip Issues, Projects, company and Agent records; adapted in `packages/paperclip-plugin/src/ports/work-management.ts` | Scoped issue/project/agent reads; issue create/update/relations/checkout/wakeup; event subscription | Root/child work-unit projection and replay lookup exist. There is no legacy task-tree importer or history rewrite. |
| Graph definitions, runs, attempts, gates and transitions | PolyForge Core in `services/polyforge/src/polyforge/core/` | Python Core over its own SQLite store; provider-neutral ports in Core; no Paperclip SDK import in Core | Authoritative engineering state stays in Core. Live-run graph-version migration is a separate reviewed plan/commit flow, not a legacy ID importer. |
| Runtime Service / GraphStore | `services/polyforge/src/polyforge/services/runtime_api/` | Python HTTP service, SQLite/WAL configured by `POLYFORGE_DB` | Separate process by design. `tools/run-service.sh` and `tools/stop-service.sh` start/stop this Runtime; the plugin does not spawn it. |
| Bridge delivery, bindings and command ledger | `packages/paperclip-plugin/src/store.ts` | Bridge-owned `node:sqlite` database, `BEGIN IMMEDIATE`, inbox/outbox, provider bindings, offsets, command log and nonce ledger | This is not the Paperclip database or the Core GraphStore. It holds adapter reconciliation state. Existing provider bindings are not a batch import ledger. |
| Execution workspaces | Paperclip/provider | `packages/paperclip-plugin/src/ports/workspace.ts` reads project/execution workspace metadata; manifest requests read-only workspace capabilities | No clone/worktree creation, reset, deletion, or filesystem isolation is implemented by the bridge. Unverifiable pins/isolation block the affected work. |
| Physical Agent invocation and Hermes | Paperclip scheduler + configured adapter | Work-management port requests assignment/wakeup and observes runs; Core never invokes a worker | Plugin/Core process spawning is absent by design. Shell process management is limited to the separate Runtime service scripts. Hermes references are exposed, but the live Agent's selected adapter and runtime are not established by this inventory. |
| Human interaction, reviews and action authorization | Paperclip carries interactions/approvals; Core binds engineering decisions to exact targets | `ports/governance.ts`; human-only interaction create/read and approval read; no plugin response/grant-write capability | A human interaction is not privileged-action authorization. The real authorization route and end-to-end revoke/expiry behavior remain a Phase 4 host gate. |
| Documents and evidence | Paperclip documents provide source bytes; Core stores evidence semantics | `ports/artifacts.ts` reads company-scoped issue documents, hashes bytes, and snapshots them under a full content-addressed artifact key with a pinned host revision; inline artifacts use the same snapshot path | `issue.attachments.read` is deliberately not requested, so attachment uploads are unsupported/fail closed. Existing artifact flow does not import a legacy attachment corpus or fabricate historical authorship. |
| Secrets and signing | Paperclip secret reference + bridge request signing | `sharedSecretRef` resolved at request time; secret value is not persisted in plugin config/store | Legacy secret migration is not present; no plain-text import is allowed. |
| Budget, audit and external effects | Paperclip is financial/platform authority; Core owns engineering policy and effect journal | Core command/event/effect tables, bridge command and delivery ledgers, host activity/audit surfaces | Cross-system correlation exists in the new path; no legacy audit/effect-ledger importer or full reconciliation report is present. |

## Direct process and database audit

The implementation boundary found by source inspection is:

* The Paperclip plugin source imports `node:sqlite` only in `src/store.ts`; it does not use
  `ctx.db` for multi-row inbox/outbox commits because the host API cannot provide the required
  transaction. No plugin `child_process`/shell invocation is used to start Hermes or another
  worker.
* Python Core/Runtime persistence is encapsulated in `core/store/db.py` and the registry store;
  the Paperclip database is not opened directly by Core.
* The operational shell scripts start or stop the separate PolyForge Runtime process. The
  Paperclip host starts the plugin worker and assigned Agents through its own runtime/scheduler.
* A Paperclip upgrade/restore, Runtime GraphStore, and bridge SQLite file are distinct recovery
  domains. Their backups and restore evidence must be tracked separately.

These findings describe code paths present in this checkout. They do not prove that a deployed
host, adapter, supervisor, or omitted legacy checkout has no additional process/database
dependency; that requires the selected host and legacy source inventory.

## Import and reconciliation status against P1

| Required migration object | Current support | Missing evidence/work |
|---|---|---|
| Company/project/Agent legacy ID map | New capability bindings are company/project scoped | No old ID snapshot, role mapping, or repeatable import batch. |
| Root/child Issue hierarchy, status, comments and blockers | Graph-origin child creation is idempotent; ordinary Issue events are scoped | No bulk importer, source-history snapshot, create-or-verify report, or orphan queue for legacy rows. |
| Workspace/repository/branch references | Read-only host metadata can be bound to a run | No legacy workspace takeover, multi-repo checkpoint import, or two-writer isolation rehearsal. |
| Documents/attachments and historical evidence | New artifacts are content-hashed and verified | No legacy manifest importer, immutable revision mapping, or orphan-attachment reconciliation. |
| Approvals, budgets, audit and effects | New governance/effect semantics are durable and fail closed | No legacy approval-to-reference map; no imported approval is trusted; no legacy effect watermark/reconciliation. |

Do not infer P1 completion from the existing runtime run-migration UI: that path migrates a
quiescent PolyForge run between Graph versions and is not the P1 legacy infrastructure/data
importer.
