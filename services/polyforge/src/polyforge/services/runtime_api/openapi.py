"""The OpenAPI 3.1 description of the `/v1` surface.

Responsibility: emit a document that describes exactly what the router serves.

Invariants:

* **Derived, never written twice.** Every path, method, parameter, success status and failure
  status is read from :data:`polyforge.services.runtime_api.router.ENDPOINTS` and from
  ``polyforge.core.errors.ERROR_STATUS``. The only hand-written parts are the component
  *schemas*; nothing hand-written can introduce a route. The parity test asserts this by
  comparing the document's path/method set with the router's.
* **The auth scheme is the real one.** Six header schemes, all required together, so a
  generated client cannot accidentally produce a request that omits the nonce or the scope.
* **The signature is described, not approximated.** The component schema for the canonical
  request lists its nine keys, because that string is the interoperability contract with the
  TypeScript bridge and a mistake in it is a silent, total authentication failure.
"""

from __future__ import annotations

from typing import Any, Final

from polyforge import COMPILER_VERSION, PROTOCOL_VERSION, SCHEMA_VERSION
from polyforge.core.errors import ERROR_CODES, ERROR_STATUS
from polyforge.services.runtime_api.auth import (
    ACTOR_HEADER,
    AUDIENCE_HEADER,
    CANONICAL_FIELDS,
    ISSUER_HEADER,
    NONCE_HEADER,
    SCOPE_HEADER,
    SIGNATURE_HEADER,
    TIMESTAMP_HEADER,
)
from polyforge.services.runtime_api.config import DEFAULT_AUDIENCE, DEFAULT_REPLAY_WINDOW_SECONDS
from polyforge.services.runtime_api.router import API_BASE, ENDPOINTS, Endpoint

__all__ = ["SCHEMAS", "SECURITY_SCHEMES", "build_document", "documented_routes"]

_TAG_ORDER: Final[tuple[str, ...]] = ("authoring", "execution", "ops", "bridge")
_TAG_SUMMARY: Final[dict[str, str]] = {
    "authoring": "Graph authoring: drafts, validation, compilation, review, publication, activation.",
    "execution": "GraphRun execution: admission, claims, artifacts, evidence, transitions, commands.",
    "ops": "Operations: health, recovery, and bridge event intake.",
    "bridge": "The Core-to-platform intent queue the bridge drains.",
}

_ERROR_STATUS: Final[dict[str, int]] = {code.value: status for code, status in ERROR_STATUS.items()}


def _ref(name: str) -> dict[str, Any]:
    return {"$ref": f"#/components/schemas/{name}"}


def _obj(
    properties: dict[str, Any],
    *,
    required: tuple[str, ...] = (),
    description: str = "",
    additional: bool = False,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "additionalProperties": additional,
    }
    if required:
        body["required"] = list(required)
    if description:
        body["description"] = description
    return body


def _arr(items: dict[str, Any], description: str = "") -> dict[str, Any]:
    body: dict[str, Any] = {"type": "array", "items": items}
    if description:
        body["description"] = description
    return body


def _str(description: str = "", **extra: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"type": "string"}
    if description:
        body["description"] = description
    body.update(extra)
    return body


def _int(description: str = "", **extra: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"type": "integer"}
    if description:
        body["description"] = description
    body.update(extra)
    return body


def _bool(description: str = "") -> dict[str, Any]:
    body: dict[str, Any] = {"type": "boolean"}
    if description:
        body["description"] = description
    return body


def _any(description: str = "") -> dict[str, Any]:
    body: dict[str, Any] = {}
    if description:
        body["description"] = description
    return body


#: Component schemas. Written by hand because the Core's wire shapes live in Python; every
#: path/method/status in the document comes from the router table instead.
SCHEMAS: Final[dict[str, dict[str, Any]]] = {
    "Error": _obj(
        {
            "code": _str(
                "A stable error code. The bridge branches on this, never on the message.",
                enum=list(ERROR_CODES),
            ),
            "message": _str("A human-readable explanation. Never an internal detail."),
            "details": _any("Machine-readable context. Its shape depends on the code."),
            "pendingReason": _str("Why a recorded command is waiting on something else."),
        },
        required=("code", "message"),
        description="The failure body every non-2xx response uses.",
    ),
    "ErrorEnvelope": _obj({"error": _ref("Error")}, required=("error",)),
    "ProviderRef": _obj(
        {
            "provider": _str("The platform that owns the object, e.g. `paperclip`."),
            "kind": _str("Object kind, e.g. `issue`, `agent_run`, `attachment`."),
            "id": _str("Provider-local identity."),
        },
        required=("provider", "kind", "id"),
        description="A provider-neutral reference. The Core never resolves one.",
    ),
    "Scope": _obj(
        {
            "companyRef": _str("Company identity, from X-PF-Scope. Never from a body."),
            "projectRef": _str("Project identity, from X-PF-Scope. Never from a body."),
        },
        required=("companyRef", "projectRef"),
        description="The tenant pair. Every read and every write is scoped by it.",
    ),
    "ActorAssertion": _obj(
        {
            "actorType": _str(
                "Who is calling. A worker can never assert `human`.",
                enum=["human", "agent", "system"],
            ),
            "actorId": _str("Subject identity inside the caller's company."),
            "agentId": _str("Agent identity when the actor is an agent run."),
            "runId": _str("Platform heartbeat run id, when applicable."),
            "roles": _arr(_str(), "Roles the platform asserted for this actor."),
        },
        required=("actorType", "actorId"),
        description="The decoded X-PF-Actor payload. Carried in the signature, never in a body.",
    ),
    "CanonicalRequest": _obj(
        {
            "actor": _ref("ActorAssertion"),
            "audience": _str("The service this request is bound to, e.g. `polyforge-runtime`."),
            "bodyHash": _str("`sha256:<hex>` over the exact received body bytes."),
            "issuer": _str("The bridge issuer id."),
            "method": _str("Upper-case HTTP method."),
            "nonce": _str("128-bit random, replay-cached for the window."),
            "path": _str(
                "Request target relative to the base, INCLUDING the query string. Excluding it "
                "would leave parameters such as a diff's `from`/`to` unauthenticated."
            ),
            "scope": _ref("Scope"),
            "timestamp": _str("RFC3339 UTC, verbatim as sent."),
        },
        required=tuple(CANONICAL_FIELDS),
        description=(
            "The exact object both sides serialise with the canonical JSON encoder and sign with "
            "HMAC-SHA256 under the shared secret. The result is `v1=<hex>`."
        ),
    ),
    "Blocker": _obj(
        {
            "code": _str("Stable blocker code."),
            "reason": _str("Why the work is not progressing."),
            "message": _str("Explanation for a person."),
            "detail": _any("Machine context."),
        },
        required=("code", "reason", "message"),
    ),
    "CommandResult": _obj(
        {
            "commandId": _str("The command this result belongs to."),
            "applied": _bool(
                "False means the command was recorded, not that it was attempted and failed."
            ),
            "stateVersion": _int("The run's state version after the command."),
            "status": _str("Node or run status after the command."),
            "resultRef": _str("Ids or a hash the caller needs, comma separated."),
            "blockers": _arr(_ref("Blocker")),
            "pending": _bool("Set when the command is recorded and its effect waits."),
            "pendingReason": _str("Why it waits."),
        },
        required=("commandId", "applied", "stateVersion", "status", "blockers"),
        description="The command envelope. A 202 with pending is success, not an error.",
    ),
    "ArtifactRef": _obj(
        {
            "artifactId": _str("Stable artifact identity."),
            "kind": _str("What the artifact is, e.g. `architecture_spec`."),
            "contentHash": _str("`sha256:<hex>` over the artifact content."),
            "mediaType": _str("Content type."),
            "size": _int("Byte size."),
            "providerRef": _ref("ProviderRef"),
            "repository": _obj(
                {"repoRef": _str(), "commit": _str()}, required=("repoRef", "commit")
            ),
            "createdAt": _str("RFC3339 UTC."),
        },
        required=("kind", "contentHash", "mediaType", "size"),
    ),
    "EvidenceRecord": _obj(
        {
            "evidenceId": _str("Stable evidence identity."),
            "runId": _str(),
            "nodeId": _str(),
            "kind": _str("The evidence kind the node must produce or consume."),
            "transitionHash": _str("The contract hash this evidence is bound to."),
            "artifacts": _arr(_ref("ArtifactRef")),
            "producerSubject": _str("The subject that produced it."),
            "valid": _bool("False once an input or contract moved under it."),
            "invalidatedReason": _str("Why it stopped being usable."),
            "createdAt": _str(),
        },
        required=("evidenceId", "runId", "nodeId", "kind", "valid"),
    ),
    "AttemptView": _obj(
        {
            "attemptId": _str(),
            "runId": _str(),
            "nodeId": _str(),
            "iteration": _int("The rework iteration. One active claim per (run, node, iteration)."),
            "attemptNo": _int(),
            "transitionHash": _str(),
            "status": _str(),
            "leaseEpoch": _int(
                "Every write carries this. A stale epoch is 409 LEASE_FENCED, never applied."
            ),
            "agentSubject": _str("The qualified subject holding the claim."),
            "agentRunRef": _ref("ProviderRef"),
            "startedAt": _str(),
            "finishedAt": _str(),
            "checkpointRef": _str(),
        },
        required=("attemptId", "nodeId", "iteration", "leaseEpoch", "status"),
    ),
    "NodeExecutionView": _obj(
        {
            "nodeId": _str(),
            "kind": _str(),
            "status": _str(),
            "iteration": _int(),
            "contractHash": _str("`pf.contract` digest the node is bound to."),
            "inputRefs": _arr(_str()),
            "outputRefs": _arr(_str()),
            "activeAttemptId": _str(),
            "waitReason": _str("Why a waiting node is waiting. `WAITING` implies no live process."),
            "blockReason": _str(),
            "requiredCapabilities": _arr(_str()),
            "assignedSubject": _str(),
            "assignedIssueRef": _ref("ProviderRef"),
            "childRunId": _str(),
            "updatedAt": _str(),
        },
        required=("nodeId", "status", "iteration"),
    ),
    "PendingGovernance": _obj(
        {
            "requestId": _str(),
            "kind": _str(enum=["interaction", "decision", "authorization"]),
            "gateId": _str(),
            "nodeId": _str(),
            "transitionHash": _str(),
            "decisionTargetHash": _str(
                "Binds gate/action, transition, input and output digests, policy and evaluator "
                "versions, options and authority. The Core keeps this; the platform object only "
                "references the id."
            ),
            "semanticKind": _str(),
            "providerRef": _ref("ProviderRef"),
            "createdAt": _str(),
            "expiresAt": _str(),
            "resolvedAt": _str(),
        },
        required=("requestId", "nodeId", "decisionTargetHash", "semanticKind"),
    ),
    "RunSnapshot": _obj(
        {
            "runId": _str(),
            "familyId": _str(),
            "workOrderId": _str(),
            "graphId": _str(),
            "graphVersion": _int("The version this run is pinned to, whatever is active now."),
            "status": _str(),
            "stateVersion": _int("The compare-and-swap token. Send it as expectedStateVersion."),
            "eventSequence": _int("Highest persisted event seq. The `after` cursor for events."),
            "ownerEpoch": _int(),
            "entrypoint": _str(),
            "parentRunId": _str(),
            "parentNodeId": _str(),
            "invocationGeneration": _int(),
            "scope": _ref("Scope"),
            "pins": _any("Everything this run is pinned to, so later drift cannot reach it."),
            "nodes": _arr(_ref("NodeExecutionView")),
            "attempts": _arr(_ref("AttemptView")),
            "gates": _arr(_any("Gate evaluation records.")),
            "evidence": _arr(_ref("EvidenceRecord")),
            "pendingGovernance": _arr(_ref("PendingGovernance")),
            "effects": _arr(_any("External effect records.")),
            "blockers": _arr(_ref("Blocker")),
            "createdAt": _str(),
            "updatedAt": _str(),
        },
        required=("runId", "graphId", "graphVersion", "status", "stateVersion", "eventSequence"),
        description="The authoritative run snapshot.",
    ),
    "RunSnapshotList": _obj({"runs": _arr(_ref("RunSnapshot")), "count": _int()}),
    "DomainEvent": _obj(
        {
            "seq": _int("Monotonic per run, gap free."),
            "runId": _str(),
            "type": _str("A `pf.*` event type."),
            "at": _str(),
            "payload": _any(),
        },
        required=("seq", "runId", "type", "at"),
    ),
    "DomainEventPage": _obj(
        {
            "runId": _str(),
            "events": _arr(_ref("DomainEvent")),
            "count": _int(),
            "after": _int("The cursor this page was read with."),
            "nextAfter": _int("The cursor to send next. Equal to `after` when nothing is new."),
            "eventSequence": _int("The run's highest seq, so a client can tell idle from behind."),
        },
        required=("runId", "events", "nextAfter", "eventSequence"),
    ),
    "MutationEnvelope": _obj(
        {
            "schemaVersion": _int(),
            "commandId": _str("Required on every mutation."),
            "idempotencyKey": _str(
                "Required. The identity of the effect, never a per-HTTP-attempt id. See "
                "`docs/05-PROTOCOL.md` section 8.1."
            ),
            "correlationId": _str(),
            "causationId": _str(),
            "runId": _str("Must match the path. Taken from the path when absent."),
            "nodeId": _str(),
            "iteration": _int(),
            "attemptId": _str(),
            "leaseEpoch": _int(),
            "expectedStateVersion": _int(
                "Stale values are 409 VERSION_CONFLICT carrying `currentVersion`."
            ),
            "contractHash": _str("Optional fence: a transition may only commit against its own."),
            "payload": _any("The command's own body."),
        },
        required=("commandId", "idempotencyKey", "payload"),
        description=(
            "The write envelope. `scope` is absent by design: it is injected from the signed "
            "transport context and a body that carries it disagrees is refused."
        ),
    ),
    "CreateWorkOrderRequest": _obj(
        {
            "commandId": _str(),
            "idempotencyKey": _str(),
            "correlationId": _str(),
            "startIntentId": _str(
                "Half the admission identity. With scope and entrypoint it makes the create "
                "idempotent, so a replayed wakeup produces one run."
            ),
            "graphId": _str(),
            "graphVersion": _int("Omit to use the graph's active default version."),
            "entrypoint": _str(
                "An entry point the graph does not declare creates NO run at all: that is how "
                "ordinary work stays out of the Graph."
            ),
            "rootIssueRef": _ref("ProviderRef"),
            "inputSnapshot": _any("Facts this run is admitted with."),
            "requiredFacts": _any("External prerequisites, each with verifiable provenance."),
            "policyRules": _arr(
                _any("The governed rules this run is pinned to. Naming a policy grants nothing.")
            ),
            "definition": _any(
                "Inline definition for a graph that is not published yet. It is still validated."
            ),
        },
        required=("commandId", "idempotencyKey", "startIntentId", "graphId", "entrypoint", "rootIssueRef"),
    ),
    "ClaimRequest": _obj(
        {
            "commandId": _str(),
            "correlationId": _str(),
            "runId": _str("Must match the path."),
            "nodeId": _str(),
            "iteration": _int(),
            "attemptId": _str("Optional; the Core allocates one when absent."),
            "leaseEpoch": _int("Presented for a takeover. A stale value is 409 LEASE_FENCED."),
            "agentSubject": _str("The qualified subject. It must hold the node's capabilities."),
            "agentRunRef": _ref("ProviderRef"),
            "issueRef": _ref("ProviderRef"),
            "contractHash": _str("Optional fence."),
            "priorWorkerState": _str(
                "What the platform confirmed about a previous worker. A replacement attempt is "
                "only admissible once the old one is stopped or fenced."
            ),
        },
        required=("nodeId", "iteration", "agentSubject"),
    ),
    "SubmitArtifactRequest": _obj(
        {
            "commandId": _str(),
            "idempotencyKey": _str(),
            "correlationId": _str(),
            "runId": _str(),
            "nodeId": _str(),
            "attemptId": _str(),
            "leaseEpoch": _int(),
            "expectedStateVersion": _int(),
            "contractHash": _str(),
            "payload": _obj({"artifacts": _arr(_ref("ArtifactRef"))}, required=("artifacts",)),
        },
        required=("commandId", "idempotencyKey", "payload"),
        description="A mutation envelope whose payload carries artifacts. Create-or-verify.",
    ),
    "SubmitEvidenceRequest": _obj(
        {
            "commandId": _str(),
            "idempotencyKey": _str(),
            "correlationId": _str(),
            "runId": _str(),
            "nodeId": _str(),
            "attemptId": _str(),
            "leaseEpoch": _int(),
            "expectedStateVersion": _int(),
            "contractHash": _str(),
            "payload": _obj(
                {"evidence": _arr(_ref("EvidenceRecord"))}, required=("evidence",)
            ),
        },
        required=("commandId", "idempotencyKey", "payload"),
        description=(
            "A mutation envelope whose payload carries evidence candidates. Ingestion verifies; "
            "it never advances a node by itself."
        ),
    ),
    "RequestTransitionRequest": _obj(
        {
            "commandId": _str(),
            "idempotencyKey": _str(),
            "correlationId": _str(),
            "runId": _str(),
            "nodeId": _str(),
            "attemptId": _str(),
            "leaseEpoch": _int(),
            "expectedStateVersion": _int(),
            "contractHash": _str(),
            "payload": _obj(
                {
                    "evidenceIds": _arr(_str(), "The evidence to evaluate."),
                    "summary": _str(),
                    "reviewerSubject": _str(),
                    "platformGrants": _any(),
                    "authorizationRef": _ref("ProviderRef"),
                },
                required=("evidenceIds",),
            ),
        },
        required=("commandId", "idempotencyKey", "payload"),
        description=(
            "The only path that can write PASSED, and only when every mandatory evaluator "
            "returns PASS."
        ),
    ),
    "RequestHelpRequest": _obj(
        {
            "commandId": _str(),
            "idempotencyKey": _str(),
            "correlationId": _str(),
            "runId": _str(),
            "nodeId": _str(),
            "attemptId": _str(),
            "leaseEpoch": _int(),
            "payload": _obj(
                {
                    "kind": _str(enum=["clarification", "review", "human_handling"]),
                    "question": _str("The durable question a human will read."),
                    "context": _any(),
                },
                required=("kind", "question"),
            ),
        },
        required=("commandId", "idempotencyKey", "payload"),
        description="Records an intent and returns 202. It never auto-approves anything.",
    ),
    "RunCommandRequest": _obj(
        {
            "commandId": _str(),
            "idempotencyKey": _str(),
            "correlationId": _str(),
            "runId": _str(),
            "command": _str(
                "Which run-level operation to perform.",
                enum=["pause", "resume", "cancel", "retry", "resolve_block"],
            ),
            "nodeId": _str(),
            "reason": _str("Recorded on the run. Required: an unexplained action is not an action."),
            "resolutionDetail": _any(),
        },
        required=("commandId", "idempotencyKey", "command", "reason"),
        description=(
            "The actor's capabilities come from the Core's own grants and the signed platform "
            "roles. A body field cannot widen them."
        ),
    ),
    "MigrationPlanRequest": _obj(
        {
            "commandId": _str(),
            "idempotencyKey": _str(),
            "correlationId": _str(),
            "runId": _str(),
            "targetGraphVersion": _int(),
            "nodeMapping": _any("Old node id to new node id. A missing mapping blocks the preview."),
        },
        required=("targetGraphVersion",),
        description="A dry run. Nothing is written.",
    ),
    "MigrationCommitRequest": _obj(
        {
            "commandId": _str(),
            "idempotencyKey": _str(),
            "correlationId": _str(),
            "runId": _str(),
            "targetGraphVersion": _int(),
            "nodeMapping": _any(),
            "planHash": _str("Fence: must equal the plan hash the preview returned."),
            "expectedStateVersion": _int("CAS on the source run."),
            "approvalRefs": _arr(_str(), "A migration is a governed operation."),
        },
        required=("targetGraphVersion", "planHash", "approvalRefs"),
        description=(
            "Freezes the source and creates a successor. The source becomes SUPERSEDED; history "
            "is never deleted."
        ),
    ),
    "GovernanceResolutionRequest": _obj(
        {
            "commandId": _str(),
            "idempotencyKey": _str(),
            "correlationId": _str(),
            "responderSubject": _str(
                "The human who answered, as the bridge read it back from the provider object."
            ),
            "responderKind": _str(enum=["human", "agent", "system"]),
            "outcome": _str(enum=["accept", "reject", "approve", "deny"]),
            "verifiedAgainstProvider": _bool(
                "Required true. A callback carrying `approved=true` is never trusted on its own; "
                "the bridge must re-read the authoritative object and match the target hash."
            ),
            "detail": _any(),
        },
        required=("responderSubject", "responderKind", "outcome", "verifiedAgainstProvider"),
    ),
    "CurrentView": _obj(
        {
            "runId": _str(),
            "nodeId": _str(),
            "iteration": _int(),
            "stateVersion": _int(),
            "status": _str(),
            "attempt": _ref("AttemptView"),
            "contract": _any("The pinned subject contract and its `pf.contract` hash."),
            "inputs": _any("Input digests this attempt is bound to."),
            "pendingGovernance": _arr(_ref("PendingGovernance")),
            "permittedActions": _arr(
                _str("Derived from state, never granted by the caller.")
            ),
        },
        required=("runId", "nodeId", "status", "permittedActions"),
    ),
    "AdoptRequest": _obj(
        {
            "adopt": _bool("Defaults to true on this route."),
            "nodeId": _str("Node to take over; defaults to the current one."),
            "priorWorkerState": _str(
                "What the platform confirmed about the previous worker. A replacement attempt is "
                "only admissible once the old one is stopped or fenced at the provider, and the "
                "Core refuses a takeover without it."
            ),
            "leaseEpoch": _int("Presented for a takeover. A stale value is 409 LEASE_FENCED."),
            "agentRunRef": _ref("ProviderRef"),
            "commandId": _str("Allocated for the takeover when absent."),
        }
    ),
    "RefusalList": _obj(
        {
            "refusals": _arr(
                _any(
                    "An isolated diagnostic record of a refused write. Append-only: it never "
                    "changes state and is never read back as state."
                )
            )
        }
    ),
    "CreateDraftRequest": _obj(
        {
            "baseVersion": _int("The published version this draft is based on."),
            "definition": _any("An initial definition. Defaults to a valid empty graph."),
        }
    ),
    "SaveDraftRequest": _obj(
        {"definition": _any("The full replacement definition.")},
        required=("definition",),
        description=(
            "Requires `If-Match: \"<revision>\"`. Saving bumps the revision and clears the "
            "validation, compile and review references, because they described the old one."
        ),
    ),
    "CompileDraftRequest": _obj(
        {
            "dependencyLock": _any(
                "A pinned lock. Defaults to the shipped lock for a library graph, or one built "
                "from the version tables for the draft's own definition."
            )
        }
    ),
    "RecordReviewRequest": _obj(
        {
            "reviewTargetHash": _str("The exact target the reviewer approved."),
            "authorizationRefs": _arr(_str()),
        },
        required=("reviewTargetHash",),
        description=(
            "The reviewer is the signed actor, never a body field, must be a `human` assertion, "
            "and may not be the draft's author."
        ),
    ),
    "PublishRequest": _obj(
        {
            "expectedRevision": _int(),
            "definitionHash": _str("`pf.definition` digest of the revision being published."),
            "compilerVersion": _str("The compiler that produced the recorded artifact."),
            "planHash": _str("`pf.plan` digest."),
            "reviewTargetHash": _str("Must equal the recorded review for this revision."),
            "authorizationRefs": _arr(
                _str("Required for a graph that performs an authorized action.")
            ),
        },
        required=(
            "expectedRevision",
            "definitionHash",
            "compilerVersion",
            "planHash",
            "reviewTargetHash",
        ),
        description=(
            "Compare-and-swap over the whole chain that must describe one revision. Any mismatch "
            "refuses the publish."
        ),
    ),
    "ActivateRequest": _obj(
        {
            "version": _int("The version future admissions should use."),
            "expectedGeneration": _int("CAS on the pointer's own generation counter."),
        },
        required=("version", "expectedGeneration"),
        description=(
            "Affects future admission only. A run in flight keeps the pins it was admitted with."
        ),
    ),
    "DraftView": _obj(
        {
            "draftId": _str(),
            "graphId": _str(),
            "scope": _ref("Scope"),
            "author": _str("The asserted actor that created it."),
            "revision": _int("The `If-Match` / `ETag` concurrency token."),
            "definition": _any(),
            "definitionHash": _str(),
            "baseVersion": _int(),
            "validationRef": _str(),
            "validationRevision": _int(),
            "validationOk": _bool(),
            "compileRef": _str(),
            "compileRevision": _int(),
            "reviewTargetHash": _str(),
            "reviewRevision": _int(),
            "reviewReviewer": _str(),
            "authorizationRefs": _arr(_str()),
            "createdAt": _str(),
            "updatedAt": _str(),
            "validation": _any("The recorded ValidationReport, if any."),
            "compile": _any("The recorded CompileArtifact, if any."),
        },
        required=("draftId", "graphId", "revision", "definitionHash", "author"),
    ),
    "DraftSummaryList": _obj({"drafts": _arr(_ref("DraftView"))}),
    "GraphVersionView": _obj(
        {
            "graphId": _str(),
            "version": _int(),
            "scope": _ref("Scope"),
            "definition": _any(),
            "definitionHash": _str(),
            "compilerVersion": _str(),
            "planHash": _str(),
            "dependencyLockHash": _str("`pf.deplock` over the full pinned version closure."),
            "closure": _any("The complete version closure a run created from this gets."),
            "draftId": _str(),
            "publishedBy": _str(),
            "publishedAt": _str(),
            "schemaVersion": _int(),
            "reviewTargetHash": _str(),
            "authorizationRefs": _arr(_str()),
            "retired": _bool(
                "Retired versions stay readable forever: a run, an approval or an audit record "
                "may still cite them."
            ),
        },
        required=("graphId", "version", "definitionHash", "compilerVersion", "planHash"),
    ),
    "GraphVersionSummaryList": _obj(
        {
            "graphId": _str(),
            "versions": _arr(_ref("GraphVersionView")),
            "activeVersion": _int("The default pointer's version, or null when unset."),
        },
        required=("graphId", "versions"),
    ),
    "DefaultPointer": _obj(
        {
            "graphId": _str(),
            "scope": _ref("Scope"),
            "version": _int(),
            "generation": _int("CAS token for the next activation."),
            "activatedBy": _str(),
            "activatedAt": _str(),
            "previousVersion": _int(),
        },
        required=("graphId", "version", "generation"),
    ),
    "ValidationReport": _obj(
        {
            "draftId": _str(),
            "revision": _int("The exact revision this report describes."),
            "definitionHash": _str(),
            "ok": _bool(),
            "issues": _arr(
                _obj(
                    {
                        "severity": _str(enum=["error", "warning"]),
                        "code": _str(),
                        "path": _str("Where in the definition the issue is."),
                        "message": _str(),
                    },
                    required=("severity", "code", "path", "message"),
                )
            ),
        },
        required=("ok", "issues", "definitionHash"),
    ),
    "CompileArtifact": _obj(
        {
            "draftId": _str(),
            "revision": _int(),
            "definitionHash": _str(),
            "compilerVersion": _str(),
            "planHash": _str(),
            "dependencyLockHash": _str(),
            "closure": _any("The complete pinned version closure."),
            "plan": _any("The compiled execution plan."),
        },
        required=("definitionHash", "compilerVersion", "planHash", "dependencyLockHash", "closure"),
        description="Deterministic for the same (definition, compiler, dependency lock).",
    ),
    "SemanticDiff": _obj(
        {
            "graphId": _str(),
            "fromVersion": _int("Null means the empty graph."),
            "toVersion": _int(),
            "addedNodes": _arr(_str()),
            "removedNodes": _arr(_str()),
            "changedNodes": _arr(_str()),
            "addedEdges": _arr(_str()),
            "removedEdges": _arr(_str()),
            "policyChanges": _arr(_str()),
            "invalidatesEvidence": _bool(
                "True when a removed or changed node invalidates previously recorded PASSes."
            ),
        },
        required=("graphId", "addedNodes", "removedNodes", "changedNodes", "invalidatesEvidence"),
    ),
    "MigrationPreview": _obj(
        {
            "runId": _str(),
            "sourceGraphVersion": _int(),
            "targetGraphVersion": _int(),
            "planHash": _str("Fence value the commit must present."),
            "quiescent": _bool("False when a blocker makes the migration inadmissible."),
            "blockers": _arr(_ref("Blocker")),
            "nodeMapping": _any(),
            "invalidations": _any("Which recorded results a new graph would not inherit."),
            "pendingGovernance": _arr(_any()),
        },
        required=("runId", "targetGraphVersion", "planHash", "quiescent", "blockers"),
    ),
    "MigrationCommitResult": _any(
        "The frozen source and its successor, as the Core recorded them."
    ),
    "IntakeEventRequest": _obj(
        {
            "type": _str("A published `pf.*` event type. An unknown one is quarantined."),
            "runId": _str(),
            "source": _str("The platform, e.g. `paperclip`."),
            "sourceEventId": _str(
                "Dedupe key with source and scope, so a replayed webhook is a no-op."
            ),
            "revision": _str("Authoritative source revision. Older revisions are recorded as lag."),
            "correlationId": _str(),
            "payload": _any(),
        },
        required=("type", "payload"),
    ),
    "IntakeResult": _obj(
        {
            "accepted": _bool(),
            "quarantined": _bool("An unknown schema was kept for triage and nothing was applied."),
            "duplicate": _bool(),
            "stale": _bool("Recorded as lag; arrival order does not decide state."),
            "applied": _any("What the observation triggered, if anything."),
            "reason": _str(),
            "payloadHash": _str(),
            "runId": _str(),
        },
        required=("accepted",),
        description=(
            "An observation is recorded, never applied as a pass. Engineering state advances only "
            "through a transition whose mandatory evaluators all pass."
        ),
    ),
    "HealthReport": _obj(
        {
            "status": _str(
                "Honest readiness.",
                enum=["ready", "read_only", "degraded", "blocked"],
            ),
            "protocolVersion": _int(),
            "schemaVersion": _int(),
            "compilerVersion": _str(),
            "database": _obj({"ok": _bool(), "detail": _str()}, required=("ok",)),
            "store": _obj(
                {
                    "runs": _int(),
                    "outboxPending": _int(),
                    "unknownEffects": _int(),
                    "registryWired": _bool(
                        "False makes the whole service `blocked`: without the registry a "
                        "published version cannot be resolved."
                    ),
                },
                required=("runs", "outboxPending", "unknownEffects", "registryWired"),
            ),
            "bridge": _obj(
                {
                    "issuer": _str(),
                    "expectedIssuer": _str(),
                    "compatible": _bool("False makes the whole service `blocked`."),
                },
                required=("issuer", "expectedIssuer", "compatible"),
            ),
            "checkedAt": _str(),
            "issues": _arr(_str()),
            "instanceRole": _str(),
            "acceptingAdmissions": _bool(),
            "uptimeSeconds": _int(),
            "backgrounds": _any("Reconciler and outbox reaper state."),
        },
        required=("status", "protocolVersion", "database", "store", "bridge", "checkedAt"),
    ),
    "LivenessReport": _obj(
        {
            "status": _str(enum=["alive", "stopping"]),
            "protocolVersion": _int(),
            "instanceRole": _str(),
            "uptimeSeconds": _int(),
            "checkedAt": _str(),
        },
        required=("status", "protocolVersion"),
        description=(
            "The one unauthenticated route. It touches no tenant data, because a container probe "
            "cannot sign a request."
        ),
    ),
    "RecoveryReport": _obj(
        {
            "effects": _arr(
                _any("Per-effect reconciliation. An UNKNOWN effect is blocked, never retried.")
            ),
            "leases": _arr(_any("Expired leases fenced to UNKNOWN; the node is blocked, not requeued.")),
            "outbox": _arr(_any("Outbound intents that are still undelivered.")),
            "nodesBlocked": _int(),
            "runsBlocked": _arr(_str()),
        },
        required=("effects", "leases", "outbox", "nodesBlocked", "runsBlocked"),
        description="Idempotent. Running it twice changes nothing the second time.",
    ),
    "RecoverRequest": _obj(
        {
            "commandId": _str("For the caller's own tracing."),
            "idempotencyKey": _str(),
            "correlationId": _str(),
        }
    ),
    "OutboxIntent": _obj(
        {
            "intentId": _str(),
            "kind": _str(
                "Which port call the bridge is being asked to make.",
                enum=[
                    "work.unit.ensure",
                    "work.dispatch",
                    "work.stop",
                    "status.project",
                    "governance.request",
                    "governance.decision",
                    "governance.authorization",
                    "effect.deliver",
                    "artifact.publish",
                    "migration.applied",
                ],
            ),
            "runId": _str(),
            "nodeId": _str(),
            "scope": _ref("Scope"),
            "correlationKey": _str(
                "Stable per logical operation, so a redelivery is recognisable as the same one."
            ),
            "payload": _any(),
            "deliveryAttempt": _int(),
            "maxDeliveryAttempts": _int(),
            "claimExpiresAt": _str(
                "A claim is a lease. After this the intent is claimable again, so a bridge that "
                "crashes mid-delivery loses at most one lease."
            ),
        },
        required=("intentId", "kind", "scope", "correlationKey", "deliveryAttempt"),
    ),
    "OutboxBatch": _obj(
        {
            "intents": _arr(_ref("OutboxIntent")),
            "count": _int(),
            "leaseSeconds": _int(),
        },
        required=("intents", "count", "leaseSeconds"),
    ),
    "DeliveryReportRequest": _obj(
        {
            "state": _str(
                "The delivery outcome. `ambiguous_create` is first class: a create that timed "
                "out stays UNKNOWN and is looked up by its correlation key, never re-sent.",
                enum=[
                    "pending",
                    "sent",
                    "observed",
                    "delivered",
                    "reconciled",
                    "failed",
                    "ambiguous_create",
                ],
            ),
            "receipt": _any("The exact receipt, when the effect definitively happened."),
            "error": _any("The failure, when it definitively did not."),
        },
        required=("state",),
    ),
    "DeliveryReport": _obj(
        {
            "intentId": _str(),
            "state": _str(),
            "deliveryAttempts": _int(),
            "effect": _str("`effect_confirmed_effected` or `effect_marked_unknown`, when applicable."),
            "blocked": _bool("True once the delivery budget is exhausted; the run needs an operator."),
            "duplicate": _bool("A redelivery report for an already-delivered intent is a no-op."),
        },
        required=("intentId", "state", "deliveryAttempts"),
    ),
    "OpenApiDocument": _any("This document."),
}


#: One scheme per header, all required together by each secured operation. Declared per header
#: rather than as a single opaque "auth" scheme so a generated client cannot build a request
#: that omits the nonce or the scope.
SECURITY_SCHEMES: Final[dict[str, dict[str, Any]]] = {
    "pfIssuer": {
        "type": "apiKey",
        "in": "header",
        "name": ISSUER_HEADER,
        "description": "Bridge issuer id. Must equal the configured issuer.",
    },
    "pfTimestamp": {
        "type": "apiKey",
        "in": "header",
        "name": TIMESTAMP_HEADER,
        "description": (
            "RFC3339 UTC with an explicit offset, inside ±"
            f"{DEFAULT_REPLAY_WINDOW_SECONDS}s by default."
        ),
    },
    "pfNonce": {
        "type": "apiKey",
        "in": "header",
        "name": NONCE_HEADER,
        "description": "128-bit random, 8-128 URL-safe characters, replay-cached for the window.",
    },
    "pfActor": {
        "type": "apiKey",
        "in": "header",
        "name": ACTOR_HEADER,
        "description": "Base64url canonical JSON ActorAssertion. Carried in the signature.",
    },
    "pfScope": {
        "type": "apiKey",
        "in": "header",
        "name": SCOPE_HEADER,
        "description": "Base64url canonical JSON {companyRef, projectRef}. The only tenant source.",
    },
    "pfSignature": {
        "type": "apiKey",
        "in": "header",
        "name": SIGNATURE_HEADER,
        "description": (
            "`v1=<hex hmac-sha256>` over the canonical JSON of the nine signed keys, keyed by the "
            "shared service secret. See the CanonicalRequest schema."
        ),
    },
    "pfAudience": {
        "type": "apiKey",
        "in": "header",
        "name": AUDIENCE_HEADER,
        "description": (
            f"Optional. Defaults to the configured audience, e.g. `{DEFAULT_AUDIENCE}`. A request "
            "signed for one audience cannot be presented at another."
        ),
    },
}

#: Every scheme together: an AND. One object, not a list of objects, because a list is an OR.
_SECURITY: list[dict[str, list[str]]] = [
    {name: [] for name in ("pfIssuer", "pfTimestamp", "pfNonce", "pfActor", "pfScope", "pfSignature")}
]


def _error_response(description: str) -> dict[str, Any]:
    return {
        "description": description,
        "content": {"application/json": {"schema": _ref("ErrorEnvelope")}},
    }


def _operation(endpoint: Endpoint) -> dict[str, Any]:
    body: dict[str, Any] = {
        "operationId": endpoint.name,
        "summary": endpoint.summary,
        "tags": [endpoint.tag],
        "description": endpoint.response_description or endpoint.summary,
    }
    if endpoint.request_schema is not None:
        body["requestBody"] = {
            "required": endpoint.name
            not in {"compile_draft", "plan_migration", "recover", "bridge_outbox"},
            "content": {"application/json": {"schema": _ref(endpoint.request_schema)}},
        }
    if endpoint.parameters:
        body["parameters"] = [p.to_openapi() for p in endpoint.parameters]
    if endpoint.if_match:
        # Declared as a header parameter rather than left in prose: a client that does not send
        # it gets a 400, and that has to be discoverable from the document.
        body["parameters"] = list(body.get("parameters", [])) + [
            {
                "name": "If-Match",
                "in": "header",
                "required": True,
                "description": (
                    'The draft revision being replaced, as `"<revision>"`. A mismatch is '
                    "409 VERSION_CONFLICT carrying `currentVersion`; omitting it is 400."
                ),
                "schema": {"type": "string"},
            }
        ]
    body["responses"] = {
        str(endpoint.success_status): {
            "description": endpoint.response_description or "Success.",
            "content": {
                "application/json": {
                    "schema": _ref(endpoint.response_schema)
                    if endpoint.response_schema
                    else {"type": "object"}
                }
            },
        }
    }
    for code in endpoint.failure_codes:
        status = _ERROR_STATUS.get(code)
        if status is None:  # pragma: no cover - the table is checked by the parity test
            continue
        body["responses"].setdefault(
            str(status), _error_response(f"{code}. See `docs/05-PROTOCOL.md`.")
        )
    if endpoint.authenticated:
        body["security"] = _SECURITY
    else:
        # The single open route. Saying so explicitly keeps a generated client from attaching
        # headers to a probe it cannot usefully sign.
        body["security"] = []
    body["responses"]["500"] = _error_response(
        "INTERNAL. Carries a correlation id and no internal detail."
    )
    return body


def build_document() -> dict[str, Any]:
    """The complete OpenAPI 3.1 document for the served surface."""
    paths: dict[str, dict[str, Any]] = {}
    for endpoint in sorted(ENDPOINTS, key=lambda e: (e.path, e.method)):
        item = paths.setdefault(endpoint.full_path, {})
        item[endpoint.method.lower()] = _operation(endpoint)
    return {
        "openapi": "3.1.0",
        "info": {
            "title": "PolyForge Runtime Service",
            "version": str(PROTOCOL_VERSION),
            "summary": (
                "The Graph Core over HTTP. Every write is a single Core command in a single "
                "transaction; identity and tenant come from a signed, scope-bound assertion."
            ),
            "description": (
                "Contract: `docs/05-PROTOCOL.md`. This document is generated from the router's "
                "own route table, so a route cannot exist here without being served. "
                f"Schema version {SCHEMA_VERSION}, compiler {COMPILER_VERSION}."
            ),
        },
        "servers": [{"url": API_BASE}],
        "tags": [
            {"name": tag, "description": _TAG_SUMMARY[tag]}
            for tag in _TAG_ORDER
            if any(e.tag == tag for e in ENDPOINTS)
        ],
        "security": _SECURITY,
        "paths": paths,
        "components": {
            "securitySchemes": dict(SECURITY_SCHEMES),
            "schemas": dict(SCHEMAS),
        },
    }


def documented_routes() -> tuple[str, ...]:
    """``METHOD /path`` for every route the document declares, base prefix removed."""
    document = build_document()
    found: list[str] = []
    for path, methods in document["paths"].items():
        relative = path[len(API_BASE) :] or "/"
        for method in methods:
            if method in {"get", "post", "patch", "delete", "put", "head", "options"}:
                found.append(f"{method.upper()} {relative}")
    return tuple(sorted(found))
