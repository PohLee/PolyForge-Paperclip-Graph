# Operations

Everything an operator needs to run the pilot, in the order it is needed. Each procedure is
idempotent, names what it changes, and says how to undo it.

Two paths exist because the repository lives on a Windows drive reached through a 9p automount
that intermittently fails reads, and a running system must not depend on a mount that can vanish:

* **From the repository** — `tools/<script>.sh`, for a workstation.
* **Through `tools/px.sh`** — copies the scripts to the native filesystem, exports the
  environment, and runs them there as the host's own user. This is the supported path, and the one
  every command below assumes.

```bash
tools/px.sh tools/<script>.sh [args…]
```

---

## 1. One-time host preparation

```bash
# The pilot's directories, owned by the account the Paperclip host runs as. Root-created 0700
# directories make the plugin uninstallable, and the error says "path does not exist".
sudo tools/ensure-pilot-dirs.sh
```

This creates, under `~/.polyforge`:

| Path | Contents |
|---|---|
| `bridge.secret` | the shared HMAC secret, `0600`, owner only |
| `bridge/` | the bridge's per-company durable store, `0750` |
| `run/` | copies of these scripts and the ops directory |
| `plugin/` | the staged build the plugin is installed from |

It also sets the owner to `pohlee` (override with `POLYFORGE_OWNER`).

## 2. The Runtime Service

The Graph Core is a separate process on purpose: the Core, its GraphStore, and its reconciler must
survive a plugin worker restart, and a plugin must never hold canonical state in memory.

```bash
tools/px.sh tools/run-service.sh     # start; waits for /v1/health/live
tools/px.sh tools/stop-service.sh    # graceful stop; durable state untouched
```

| Variable | Default | Meaning |
|---|---|---|
| `POLYFORGE_DB` | `~/.polyforge/polyforge.sqlite` | GraphStore, WAL |
| `POLYFORGE_BIND` / `POLYFORGE_PORT` | `127.0.0.1` / `8787` | listener |
| `POLYFORGE_BRIDGE_ISSUER` | `polyforge-bridge` | the only issuer the service accepts |
| `POLYFORGE_BRIDGE_SECRET` | from `bridge.secret` | HMAC key |
| `POLYFORGE_INSTANCE_ROLE` | `polyforge.operator` | role required by `POST /v1/recover` |
| `POLYFORGE_READ_ONLY` | unset | serve reads and reconciliation, refuse admissions |

The service refuses to start without a non-empty shared secret.

## 3. Build, stage, install, provision

```bash
tools/px.sh tools/stage-plugin.sh      # build, then copy the artifacts to ~/.polyforge/plugin
tools/px.sh tools/install-plugin.sh    # install the staged build into the local instance
tools/px.sh tools/provision-pilot.sh <companyId>
```

**Staging is not a convenience.** Installing from a checkout on a mounted Windows drive makes the
running worker depend on a mount that can drop, and ties a live install to files nobody audited.
Staging copies exactly the artifacts the host loads and records their digests in
`~/.polyforge/plugin/staged-build.json`, so an operator can tell one build from another without
trusting a file name.

`provision-pilot.sh` does three reversible things:

1. creates (or reuses) a Paperclip-managed secret named `polyforge-bridge-signing-key`;
2. writes the company-scoped plugin configuration;
3. prints the plugin's health.

It never grants a capability or a permission. It stores a secret, points the bridge at the
Runtime Service, and sets `allowPrivateRuntimeHost` — a *per-company* opt-in that the SSRF guard
requires for a loopback Runtime Service, and which never reaches a link-local or metadata address.

### Configuration keys

The schema in `packages/paperclip-plugin/src/manifest.ts` is the enforcement surface, not
documentation: the host validates every save against it with `additionalProperties: false`, so a
key the worker reads but the schema omits is a setting the operator physically cannot apply.
`tests/config-schema.test.ts` pins the schema, the resolver, and the cache projection to one key
set.

| Key | Default | Note |
|---|---|---|
| `runtimeUrl` | — | required |
| `bridgeIssuer` | — | required; must equal the service's `POLYFORGE_BRIDGE_ISSUER` |
| `sharedSecretRef` | — | required; `{type:"secret_ref",secretId}` only |
| `allowPrivateRuntimeHost` | `false` | per-company SSRF opt-in |
| `audience` | `polyforge-runtime` | bound into the signature |
| `requestTimeoutMs` / `replayWindowSeconds` | 15000 / 120 | |
| `maxArtifactBytes` | 8 MiB | |
| `stateDir` | per-user default | the bridge's own durable store for this company |
| `engineeringEntryLabel` | `engineering` | empty disables label-based admission |
| `engineeringOriginPrefix` | `polyforge` | `originKind` prefix for materialised child issues |
| `workspaceProviderMode` | `metadata_only` | the bridge never provisions a workspace |
| `enableProjections` | `true` | off means read-only observation |
| `experimental.*` | all `false` | Root Issue + human-only Interaction must work with all off |

## 4. Reading state

```bash
# Runtime Service, signed, with no tenant named (health is instance-scoped)
node ops/pfctl.mjs health
node ops/pfctl.mjs runs --company <id> --project <id>
node ops/pfctl.mjs get-run <runId> --company <id> --project <id>
node ops/pfctl.mjs events <runId> --after 0 --company <id> --project <id>
node ops/pfctl.mjs refusals <runId> --company <id> --project <id>
```

`ops/pfctl.mjs` is an **independent second implementation** of the signing client. If it ever
disagreed with the bridge about a signature, one of them would be wrong and the harness would
fail — which is the point of writing it twice. It signs the mount-relative path with the `/v1`
prefix removed and the query kept, matching the service.

Unsigned calls are refused: `GET /v1/health/ready` and `GET /v1/runs` both answer `403`.

### The bridge's own state

The bridge's SQLite store is the record of what the *bridge* knows, independent of host log
retention:

```bash
sqlite3 ~/.paperclip-plugin-state/polyforge/instance-polyforge/bridge.sqlite \
  "select company_id, key, value_json from compatibility_state order by company_id, key;"
```

`configuration_discovery` is the one to read first when a company looks idle. It says whether the
configuration was `loaded`, is `no_configuration_set`, or is `configuration_unusable` — with the
host's refusal message.

---

## 5. What the host will and will not let the bridge do

Three constraints shape the design. They are host behaviour, not preferences, and the pilot found
all three the hard way.

**The worker's RPC loop is single-threaded.** A handler the host is waiting on must never await a
call *back* into the host. The reply can never be read, the handler never completes, and the
plugin looks alive while delivering nothing. Every host-facing fetch is therefore deferred onto
the event loop. `tests/no-reentrant-rpc.test.ts` enforces the structure.

**`config.get` requires an active company-scoped invocation** — an event, an API route, a tool
run, or a UI bridge call. Outside one the host answers "company context is required". So a
scheduled job cannot discover a company; it serves only companies a company-scoped path has
already taught the bridge. `onConfigChanged` is the fast path; a `getData` call or an event is
the fallback.

**A bridge rebuilt from a resolved configuration must not change any decision.** The projection
back into the raw config shape has to carry every field, or a rebuilt bridge silently behaves
differently from the one the operator configured.

---

## 6. Cutover

The pilot never takes ownership of work that is already running. See
`docs/03-MIGRATION-ROLLOUT-ACCEPTANCE.md` §12 for the full procedure; in short:

1. confirm the compatibility lock and artifact digests; back up the Core store, the host database,
   the bridge mappings, and the artifact manifest;
2. stop admitting new work through the old path and let existing work drain;
3. classify what is left as safe-to-migrate, running, or unknown — **running and unknown are not
   migrated**; stop and reconcile them, or leave them with the current owner;
4. verify root and child issues, workspaces, capability bindings, budget, gateway, pending
   governance, and external effect references;
5. confirm the read-only health of both planes;
6. take the migration lock per work order, record the source checkpoint and effect-ledger
   watermark, and compare-and-swap the execution owner while raising its epoch — the old dispatcher
   must be *fenced*, not hidden;
7. do a no-side-effect `current`/`claim` verification, then admit canary work.

## 7. Rollback

A rollback is not "restore the old database and run everything again".

1. Stop admitting new work orders; pause dispatch. **Keep** the inbox, outbox, logs, approvals,
   and effect references — do not drain the queue.
2. Ask the platform to stop or finish in-flight workers. An unconfirmed stop becomes `UNKNOWN`; an
   unknown result must never start an old worker.
3. Export canonical events, effects, artifacts, and pending/completed governance since the cutover
   checkpoint, and reconcile them.
4. Prefer letting the existing Core keep running and closing new bridge admission. Only switch the
   executor back after proving the old path can read the current schema and contracts.
5. Compare-and-swap owner and epoch at a quiescent point. Import canonical mappings and
   checkpoints; do **not** import success inferred from a platform status.
6. Re-project completed transitions; retry only nodes whose effects are authoriously confirmed not
   to have happened. An unresolved `UNKNOWN` may not be rolled back to `READY`.
7. Verify with the rollback fixture, then resume at low volume and write the incident report.

| Layer | Rollback | Limit |
|---|---|---|
| Plugin UI | revert the UI package or disable the editor | published versions are never deleted |
| Plugin worker | revert to a compatible bridge build | never revert the namespace schema past data |
| Host | only a tested host + DB migration rollback | never assume an old binary reads a new schema |
| Graph default | point the default back | affects future runs only |
| Active migration | reverse plan or forward recovery | a new external effect usually makes lossless reversal impossible |
| Workspace | re-associate | never auto-delete a directory or reset a branch |

## 8. Upgrade

```bash
node ops/probe-host.mjs --json ops/host-capability-report.json --strict
```

then: build → typecheck → unit and contract suites → stage → install → provision → canary. A new
manifest capability is a separate review. If the old version cannot read data written in the
rollback window, do not upgrade production.

A capability that goes missing **fails closed**: the feature is disabled, never downgraded to a
weaker check. Read-only displays may degrade; execution authorization, identity verification, and
durable reconciliation may not.
