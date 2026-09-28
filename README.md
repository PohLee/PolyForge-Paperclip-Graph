# PolyForge → Paperclip Adapter/Plugin

PolyForge engineering-graph core plus a thin Paperclip plugin (anti-corruption bridge) implementing
[`docs/01-REQUIREMENTS.md`](docs/01-REQUIREMENTS.md) … [`docs/04-SOURCES-AND-DECISIONS.md`](docs/04-SOURCES-AND-DECISIONS.md).

* **Paperclip** is the control plane: issues, projects, agents, workspaces, budgets, platform
  authorization, tool governance, audit.
* **PolyForge** is the authoritative durable orchestration engine for engineering state: graph
  registry/compiler, contracts, policies, gates, evidence, traceability, versions, recovery.
* The **plugin** is a thin bridge. It maps objects and events, forwards trusted actor context, projects
  progress, and renders UI. It contains no graph evaluator and no second agent scheduler.

## Layout

```text
services/polyforge/            Python Graph Core + Runtime Service (ADR-03)
  src/polyforge/
    core/                      registry · compiler · entrypoints · contracts
                                evidence · gates · runtime · ports · migrations
    graph_library/             requirement · design · implementation · verification · release
    services/runtime_api/      versioned /v1 command/query service
  tests/                       unit · contract · integration · recovery
packages/protocol/             @polyforge/protocol — shared wire contract
packages/paperclip-plugin/     @polyforge/paperclip-plugin — worker + React UI
ops/
  compatibility-lock.json      pinned host / SDK / runtime / schema baseline (P0-3)
  probe-host.mjs               live host capability probe (P0-4)
docs/                          the migration specification pack
```

## Quick start

```bash
# 1. Python Graph Core + Runtime Service tests
make test-core

# 2. Runtime Service on 127.0.0.1:8787
make run-service

# 3. Build and install the plugin into the local Paperclip instance
make plugin-build
make plugin-install

# 4. Full local verification (unit → contract → host probe → e2e)
make verify
```

See [`docs/06-OPERATIONS.md`](docs/06-OPERATIONS.md) for the runbooks, the cutover procedure, and the
rollback procedure.

## Invariants this codebase enforces

1. Issue `done`, agent exit, or a human confirmation never sets an engineering node `PASSED` on its
   own. A node passes only through a committed `TransitionContract` evaluation against pinned
   versions, evidence, policy, and lease epoch.
2. A `GraphRun` pins its graph version, compiled plan, contract, policy, and child-graph versions at
   admission. Publishing a new version never mutates a running instance; that requires an explicit
   migration.
3. `Interaction`, `Decision`, and `Approval` stay distinct. A decision may record an engineering
   "approval" but never substitutes for authorization of a privileged action.
4. Effective permission is the **intersection** of platform authorization, engineering policy, and
   the real environment. A deny, an unknown, or a revocation on either side blocks.
5. There is exactly one execution owner per work unit, fenced by `ownerEpoch` + `leaseEpoch`.
6. No cross-database transaction is assumed. Cross-plane work uses durable intents, at-least-once
   delivery, idempotent results, and explicit reconciliation. An unknown external effect blocks
   instead of retrying into a false success.

## Status

See [`docs/07-VERIFICATION-STATUS.md`](docs/07-VERIFICATION-STATUS.md) for what is implemented, what is
tested, and what remains open. Nothing in this repository is claimed production-ready without a
recorded test report.
