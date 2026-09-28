# PolyForge `/v1` Protocol and Implementation Contract

Normative wire contract between the Paperclip bridge plugin and the PolyForge Runtime
Service. Implements `docs/02-TECHNICAL-PLAN.md` §4–§13 against the frozen host baseline in
`ops/compatibility-lock.json`.

This file is the contract that the Python Core, the Runtime Service, and the TypeScript
bridge are all written against. When code and this document disagree, the document is the
bug.

---

## 1. Trust boundary and authentication

Three hops, three different trust assumptions:

```text
Paperclip UI / board session
        │  host auth, company access, capability gate
        ▼
Plugin worker (bridge)  ── trusted instance-level code ──
        │  mTLS-equivalent: shared service secret + HMAC-signed, scope-bound
        │  actor assertion, short TTL, nonce + replay window
        ▼
Runtime Service (Core)   ── trusts ONLY assertions from the configured bridge issuer ──
        │  ports: WorkManagement / Governance / Workspace / Artifact / Observability
        ▼
Paperclip control plane (outbound intents, never direct mutation)
```

Rules:

* **The Core never reads a company or actor id from a request body.** Both come from the
  transport context. A body that names a different scope is rejected with
  `403 SCOPE_VIOLATION`.
* **A worker can never assert a human actor.** The bridge derives `actorType` from the host
  actor. A tool-call envelope has no field that can express `human`, and if a caller sends
  one it is ignored rather than trusted.
* **Requests are bound to an audience.** The signature covers method, path, body digest,
  timestamp, nonce, and audience (`polyforge-runtime`). A captured request cannot be
  replayed against a different endpoint or a different service.
* **The plugin does not hold a Paperclip user token and never impersonates one.**
  `approvals.respond` and `issue.interactions.respond` are *not* requested for the MVP:
  human decisions are resolved by a real human in the Paperclip UI, and the bridge reads
  the resulting authoritative object back.

### 1.1 Authentication headers

| Header | Value |
|---|---|
| `X-PF-Issuer` | Bridge issuer id. Must equal the configured `expectedIssuer`. |
| `X-PF-Timestamp` | RFC3339 UTC, within ±`replayWindowSeconds` (default 120). |
| `X-PF-Nonce` | 128-bit random, replay-cached for the window. |
| `X-PF-Actor` | Base64url JSON `ActorAssertion`. |
| `X-PF-Scope` | Base64url JSON `{companyRef, projectRef}`. |
| `X-PF-Signature` | `v1=<hex hmac-sha256(canonicalRequest, sharedSecret)>`. |

`canonicalRequest` is the canonical JSON of
`{audience, method, path, bodyHash, timestamp, nonce, issuer, actor, scope}` using the
canonical encoding in §2. The body hash is `sha256:` over the exact received bytes, so a
mutated body fails verification.

---

## 2. Canonical JSON and hashing

`polyforge.core.hashing` and `packages/protocol/src/canonical.ts` implement one algorithm.
Rules: UTF-8; object keys sorted ascending by code point; `None`/`undefined` values omitted
from objects and illegal inside arrays (use an explicit `null`); arrays keep order; numbers
finite, `-0` normalized to `0`, integral floats collapsed; no whitespace; `bool` is never a
number.

Hash identities and their domain strings:

| Identity | Domain | Binds |
|---|---|---|
| `definitionHash` | `pf.definition` | canonical definition, layout and timestamps excluded |
| `planHash` | `pf.plan` | compiled plan |
| `dependencyLockHash` | `pf.deplock` | full pinned version closure |
| `contractHash` | `pf.contract` | subject contract, operation, inputs, effective policy, authority, environment, intended mutations, required evidence/evaluators |
| `evidenceSetHash` | `pf.evidence-set` | sorted evidence ids + digests |
| `decisionTargetHash` | `pf.decision-target` | gate/action, transition hash, input+output digests, policy/evaluator versions, options, authority |
| `effectKey` | `pf.effect-key` | transition hash + stable step id + target/request hash |
| `idempotencyKey` | caller-supplied | see §8.1 |

Never hashed into an immutable identity: mutable status, UI layout, wall-clock timestamps,
projection versions. `hashing.strip_for_hash` excludes wall-clock keys always; anything
else must be opted into by name by the caller.

---

## 3. Endpoints

Base `/v1`. All request and response bodies are JSON. All writes use the mutation envelope.

### 3.1 Authoring

| Method | Path | Notes |
|---|---|---|
| `POST` | `/graphs/{graphId}/drafts` | body: `{baseVersion?}`. Returns `DraftSummary`. Requires graph-author scope. |
| `GET` | `/graphs/{graphId}/drafts` | list drafts |
| `GET` | `/drafts/{draftId}` | draft + current definition |
| `PATCH` | `/drafts/{draftId}` | requires `If-Match: "<revision>"`. Bumps revision. Editing invalidates prior validation/compile/review refs. |
| `DELETE` | `/drafts/{draftId}` | only when no published version references its compile artifact |
| `POST` | `/drafts/{draftId}/validate` | `ValidationReport` for the current revision |
| `POST` | `/drafts/{draftId}/compile` | `CompileArtifact`; deterministic for the same (definition, compiler, dependency lock) |
| `POST` | `/drafts/{draftId}/publish` | body `{expectedRevision, definitionHash, compilerVersion, planHash, reviewTargetHash, authorizationRefs[]}`. Compare-and-swap. |
| `GET` | `/graphs/{graphId}/versions` | published versions |
| `POST` | `/graphs/{graphId}/activate` | body `{version, expectedGeneration}`. Independent CAS + audit. Affects future admission only. |
| `GET` | `/graphs/{graphId}/diff?from=&to=` | `SemanticDiff` |

### 3.2 Execution

| Method | Path | Notes |
|---|---|---|
| `POST` | `/work-orders` | `CreateWorkOrderRequest`. Idempotent on `startIntentId` + scope. |
| `GET` | `/runs` | list, filter by scope/graph/status |
| `GET` | `/runs/{runId}` | authoritative `RunSnapshot` with `stateVersion` + `eventSequence` |
| `GET` | `/runs/{runId}/events?after=N&limit=` | persisted incremental `DomainEvent[]` |
| `POST` | `/runs/{runId}/claims` | `ClaimRequest`. Establishes or replaces the lease fence. |
| `GET` | `/runs/{runId}/current` | current contract + inputs for the verified actor/claim |
| `POST` | `/runs/{runId}/artifacts` | create-or-verify fixed artifact refs |
| `POST` | `/runs/{runId}/evidence` | ingest + verify evidence candidates |
| `POST` | `/runs/{runId}/transitions` | request evaluation, commit on all-mandatory-pass |
| `POST` | `/runs/{runId}/help` | durable clarification/review/human-handling intent |
| `POST` | `/runs/{runId}/commands` | `RunCommandRequest` |
| `POST` | `/runs/{runId}/migrations/plan` | `MigrationPreview` (dry run) |
| `POST` | `/runs/{runId}/migrations/commit` | CAS on `stateVersion`, fences on `planHash` |
| `POST` | `/runs/{runId}/governance/{requestId}/resolution` | record a bridge-verified resolution |
| `GET` | `/health` | `HealthReport` |
| `GET` | `/events` | normalized `pf.*` event intake for the bridge |

### 3.3 Response envelope

Success: the resource body, or for a command
`{commandId, applied, stateVersion, status, resultRef?, blockers[], pending?, pendingReason?}`.

Failure: `{"error": {"code", "message", "details?", "pendingReason?"}}` with the status from
`ERROR_STATUS`. `202` carries `GATE_PENDING` semantics for a recorded-but-deferred command
and still uses the command envelope, not the error body.

---

## 4. State machine

```text
GraphRun: CREATED → ACTIVE ↔ WAITING ↔ PAUSED
                        ↘ BLOCKED → ACTIVE   (explicit authorized resolution)
                        → COMPLETED | FAILED | CANCELLED

Node:    PENDING → READY → DISPATCH_REQUESTED → RUNNING
         → EVIDENCE_READY → EVALUATING → PASSED
                            ├→ WAITING_GOVERNANCE → EVALUATING
                            ├→ REWORK_REQUIRED → READY   (new iteration)
                            └→ FAILED | BLOCKED

Attempt: PREPARED → RUNNING → CHECKPOINTED → RUNNING
                     → EVIDENCE_READY → COMPLETED
                     → FAILED | CANCELLED | UNKNOWN
         UNKNOWN → RECONCILING → EVIDENCE_READY | PREPARED | BLOCKED
```

`WAITING` and `WAITING_GOVERNANCE` never imply a live process. A human waiting for hours
occupies durable state and zero tool calls.

---

## 5. Atomic commit

One Core transaction per committed transition:

```text
verify command key + payload hash        (idempotency)
check stateVersion / claim / ownerEpoch  (fencing)
check pinned contract + fresh inputs + permissions
write semantic mutation + gate result + checkpoint
append domain event + increment eventSequence
insert outbox intents + command result
commit
```

There is no cross-database transaction with Paperclip. The two planes use durable intents,
at-least-once delivery, idempotent results, and reconciliation.

---

## 6. Claims, leases, and fencing

* One active claim per `(runId, nodeId, iteration)`.
* Every authoritative takeover increments `leaseEpoch`. All writes and side-effect requests
  carry the epoch; a stale epoch is `409 LEASE_FENCED` and the write is rejected.
* Paperclip checkout protects the issue layer; the Core claim protects the engineering
  attempt layer. Both must agree before a contract-level side effect is permitted.
* Lease expiry means "check", not "the old worker stopped". A new claim is only admissible
  once the bridge has confirmed the previous worker is stopped or fenced at the provider.
* A late write from an expired attempt is stored as an isolated diagnostic record. It never
  changes current state and never backfills a pass.

---

## 7. Gates, evidence, and decisions

* A gate aggregates typed evaluator results. Default aggregation is FAIL-wins; a missing
  required evaluator or evidence yields `ESCALATE`, never `PASS`.
* A graph's own `all`/`any`/`quorum` join semantics cannot bypass a gate marked mandatory.
* Evidence ingestion verifies, in order: scope, producer subject and platform run, active
  claim, contract-bound output type, content hash, source revision, trusted execution
  record, freshness.
* Human decisions record a `decisionTargetHash` binding gate/action, transition, input and
  output digests, policy and evaluator versions, options, and authority. The Core keeps the
  canonical target; the platform object only references the id. The bridge re-reads the
  authoritative object and verifies the target hash — a callback carrying `approved=true`
  is never trusted on its own.
* Decision effects are limited to a whitelist of work-management side effects. No decision
  effect advances a GraphRun; the Core decides when to advance.

---

## 8. Idempotency and effect identity

### 8.1 Idempotency keys per behavior

| Behavior | Key |
|---|---|
| first admission | `scope + startIntentId + entrypoint` |
| child run | `parentRun + parentNode + invocationGeneration + input/version binding` |
| external work unit | `scope + run + node + iteration` |
| transition | canonical contract hash |
| execution attempt | `transitionHash + attemptNo` |
| external effect | `transitionHash + stepId + targetHash/requestHash` |
| evidence/artifact | immutable id + content hash (create-or-verify) |
| governance request | `transitionHash + semanticGateOrActionId + exactTargetHash` |
| event intake | `source + scope + sourceEventId` |
| projection | `targetRef + projectionSequence` |

An `EffectKey` is never a per-HTTP-attempt random id and never just an attempt number,
because either would duplicate a side effect on retry. A genuinely new business effect
requires a new transition/step identity.

### 8.2 Replay semantics

* Same key + same payload → the recorded result, `applied` unchanged.
* Same key + different payload → `409 IDEMPOTENCY_CONFLICT`.
* `expectedVersion` mismatch → `409 VERSION_CONFLICT` with `currentVersion`.
* Timeout on an outbound create → the bridge records `ambiguous_create` and looks the
  object up by its correlation key before deciding. It never blindly re-sends a create.

---

## 9. Ports

Implemented by the bridge, declared by the Core. Signatures in
`packages/protocol/src/ports.ts`. Rules:

* Every mutation returns a durable operation or reference and may be pending. The bridge
  records `pending → sent → observed → reconciled` per delivery operation.
* An unsupported capability returns an explainable `BLOCKED`, never a silent success and
  never a downgrade of an authorization check to a plain confirmation.
* Read-only displays may degrade; execution authorization, identity verification, and
  durable reconciliation may not.

---

## 10. Failure classification

| Failure | State / immediate action | Allowed recovery | Forbidden |
|---|---|---|---|
| duplicate event/command | dedupe, return recorded result | idempotent replay | second dispatch or commit |
| out-of-order/lost event | mark lag, re-fetch | converge on authoritative revision | overwrite newer state by arrival time |
| bridge worker crash | durable inbox/outbox survive | resume delivery after restart | rebuild in memory and re-create everything |
| Core crash before commit | transaction rolled back | resend, idempotent | treat an uncommitted UI message as fact |
| Core commit, projection failed | projection pending | re-project from outbox | re-execute completed work |
| worker exit unknown | `UNKNOWN` | authoritative reconciliation | re-run a side effect after a timeout |
| lease expired, old worker returned | reject stale fence | new claim only after confirmed stop | let an old checkpoint overwrite a new attempt |
| workspace lost / branch drift | `BLOCKED_WORKSPACE` | recover from pinned artifacts and re-verify | let a new directory pose as the old state |
| stale input / changed artifact | `BLOCKED_STALE_INPUT` or `REWORK_REQUIRED` | new contract, new evidence | inherit an old approval or PASS |
| approval expired/revoked | block admission and commit | re-authorize or cancel | execute on the old approval |
| budget exhausted | `BLOCKED_BUDGET` | resume after a legitimate platform recovery | switch agents to dodge the budget |
| evaluator error | `ESCALATE` + diagnostic | re-evaluate the same evidence after a fix | treat the exception as a pass |
| permanent policy/contract failure | `FAILED`/`BLOCKED`, no auto retry | new legitimate request or human handling | relax policy to make a test pass |
| human rejection | `REWORK_REQUIRED` / `FAILED` / `CANCELLED` | new revision per contract | re-ask until agreement |
| audit durable write failed | pause sensitive operations, keep the incident | resume after audit recovers | drop the log and continue a high-risk call |

Retries use bounded exponential backoff with jitter and are decided by failure class. The
network redelivery budget and the engineering rework budget are counted separately; waiting
for a human never consumes an execution retry.

---

## 11. External effect reconciliation

An adapter/provider must return one of three facts: the effect happened with an exact
receipt, the provider authoritatively confirms it did not happen, or it is still unknown.
Only an authoritative absence, plus a fenced or stopped old worker, permits another try. A
provider that cannot be queried and does not support idempotency stays `UNKNOWN` and is
handed to an authorized human. Compensation is a separate, authorizable workflow that is
allowed to fail; a database rollback is not an external undo.

---

## 12. Security controls

| Boundary | Required control |
|---|---|
| UI → bridge action | host auth + company access, server re-resolves the resource owner |
| agent → graph tool | authenticated platform run + issue checkout + capability binding + Core claim/epoch |
| bridge → Runtime | signed scope-bound request, audience, expiry, nonce replay window |
| Runtime → Paperclip | minimum service capability; human approvals only through native or trusted-user paths |
| runtime → external tool | governed gateway + scoped token + environment network/credential isolation |
| artifact URI → downloader | provider allowlist, size/type caps, digest check, SSRF and path-traversal rejection |
| workspace path → executor | trusted host metadata, normalized paths, symlink containment, read-only reviewer |
| company ↔ company | scope check on every query, stream, event, and binding |

A manifest capability is a constraint on host API use, not a sandbox for hostile code.
Plugin UI is same-origin JavaScript: it must not inject unsanitized HTML or leak tokens.

---

## 13. Compatibility

`ops/compatibility-lock.json` pins the host release, SDK, adapter/runtime, schema, and
compiler versions. Unknown APIs, unknown event schemas, and missing security capabilities
fail closed. Experimental capabilities (cases, decisions, pipelines) are behind their own
flags with verified fallbacks; the Root Issue + human-only Interaction path must keep
working with all of them off.
