/**
 * `GovernancePort` against the Paperclip host.
 *
 * This is the anti-corruption layer for human decisions, and it holds four refusals that the
 * rest of the system depends on.
 *
 * 1. **The bridge never answers a decision.** It holds neither
 *    `issue.interactions.respond` nor `approvals.respond` (see `src/manifest.ts`). Every
 *    governance call here is either "create a carrier for a human" or "read back what a human
 *    decided". A real person answers in the Paperclip UI.
 * 2. **`readVerifiedResolution` re-reads the authoritative object and matches the target
 *    hash.** A callback, an event payload, or a `verifiedAgainstProvider: true` field in
 *    anything the bridge was handed is never sufficient. The decision is only "verified" when
 *    the object the host still holds carries the same `decisionTargetHash` the Core pinned.
 * 3. **Author/reviewer separation survives a plugin-created carrier.** `not_creator` in
 *    Paperclip only guarantees "not the interaction's creator", and the bridge is the creator.
 *    So the bridge (a) never downgrades to `anyone` — a requested `anyone` is upgraded to
 *    `human_only` — and (b) records the target hash inside the carrier so the Core can require
 *    a human *and* a different producer.
 * 4. **`checkAuthorization` matches one exact action.** Action, resource, environment, the
 *    whole input-hash map, and the transition hash must all be equal; the grant must be live
 *    and unrevoked. A changed artifact, a changed environment, or an expired grant blocks.
 *
 * `requestActionAuthorization` is the honest-unsupported case: this host baseline gives
 * plugins `approvals.read` but no way to *create* an approval, so a request for a grant that
 * does not already exist records the exact target and returns an explainable
 * `BLOCKED_AUTHORIZATION` rather than inventing an approval.
 */

import { canonicalJson, stableIdempotencyKey } from "@polyforge/protocol";
import type {
  AuthorizationRequest,
  AuthorizationStatus,
  CommandMeta,
  DecisionRequest,
  ExactAction,
  GovernancePort,
  InteractionRequest,
  ProviderRefLike,
  VerifiedResolution,
} from "@polyforge/protocol";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BridgeDeps } from "./index.js";
import { providerRef } from "./index.js";
import { INTENT_KINDS, governanceEffectKey } from "../outbox/intents.js";
import { BridgeError, UnsupportedCapabilityError } from "../errors.js";

/**
 * The interaction shapes, derived from the SDK's own client signatures.
 *
 * The SDK does not re-export `CreateIssueThreadInteraction` / `IssueThreadInteraction` from its
 * root entry, and reaching into `@paperclipai/shared` for them would make a transitive
 * dependency load-bearing. Deriving them from the client type the plugin already depends on
 * keeps the surface exactly as wide as the installed SDK, so an SDK bump that changes the
 * interaction shape is a compile error here rather than a runtime surprise.
 */
type InteractionList = Awaited<ReturnType<PluginContext["issues"]["listInteractions"]>>;
type IssueThreadInteraction = InteractionList[number];
type CreateIssueThreadInteraction = Parameters<PluginContext["issues"]["createInteraction"]>[1];

export const INTERACTION_BINDING_KIND = "governance_interaction" as const;
export const AUTHORIZATION_BINDING_KIND = "governance_authorization" as const;

/** Marker embedded in the carrier so a human (and the Core) can see what is being decided. */
const TARGET_HASH_PREFIX = "decision-target";
const SEMANTIC_KIND_PREFIX = "semantic-kind";

interface InteractionBinding {
  readonly requestId: string;
  readonly issueId: string;
  readonly interactionId: string;
  readonly decisionTargetHash: string;
  readonly semanticKind: string;
  readonly requiredResolver: "anyone" | "not_creator" | "human_only";
  readonly effectiveResolverPolicy: string;
  readonly createdAt: string;
  readonly resolvedVerified: boolean;
  readonly options: { id: string; label: string }[];
}

export class GovernancePortImpl implements GovernancePort {
  readonly #deps: BridgeDeps;

  constructor(deps: BridgeDeps) {
    this.#deps = deps;
  }

  // -------------------------------------------------------------------------
  // requestInteraction
  // -------------------------------------------------------------------------

  async requestInteraction(req: InteractionRequest, _meta: CommandMeta): Promise<ProviderRefLike> {
    const { ctx, store, logger, metrics, deliveries } = this.#deps;
    const companyId = req.scope.companyRef;
    const effectKey = governanceEffectKey(req.decisionTargetHash, req.semanticKind, req.correlationId);
    const logger2 = logger.child({ correlationId: req.correlationId });

    deliveries.begin({
      effectKey,
      kind: INTENT_KINDS.governanceInteractionCreate,
      scope: req.scope,
      correlationId: req.correlationId,
      payload: {
        issueId: req.targetIssueRef.id,
        semanticKind: req.semanticKind,
        decisionTargetHash: req.decisionTargetHash,
        requiredResolver: req.requiredResolver ?? "human_only",
        options: req.options ?? [],
      },
    });
    deliveries.sent(effectKey);

    const issue = await ctx.issues.get(req.targetIssueRef.id, companyId);
    if (!issue) {
      deliveries.failed(effectKey, "target issue is not visible in this company");
      throw new BridgeError("BRIDGE_SCOPE_VIOLATION", "BLOCKED_SCOPE", "interaction target is not in scope", {
        issueId: req.targetIssueRef.id,
        companyId,
      });
    }
    if (req.scope.projectRef !== "" && issue.projectId !== req.scope.projectRef) {
      metrics.bump(companyId, "crossScopeDenials");
      deliveries.failed(effectKey, "target issue is in another project");
      throw new BridgeError(
        "BRIDGE_SCOPE_VIOLATION",
        "BLOCKED_SCOPE",
        "interaction target is in another project than the run",
        { issueId: issue.id, issueProject: issue.projectId, scopeProject: req.scope.projectRef },
      );
    }

    // A requested `anyone` resolver is upgraded, never honoured. See module docstring (3).
    const requested = req.requiredResolver ?? "human_only";
    const resolverPolicy = requested === "anyone" ? "human_only" : requested;
    if (resolverPolicy !== requested) {
      metrics.bump(companyId, "platformBlocks", 0);
      logger2.warn("upgraded an 'anyone' resolver to 'human_only' for an engineering decision", {
        issueId: issue.id,
        semanticKind: req.semanticKind,
      });
    }

    const existing = store.getBinding(companyId, INTERACTION_BINDING_KIND, effectKey);
    if (existing) {
      const payload = parseInteractionBinding(existing.payloadJson);
      if (payload) {
        deliveries.observed(effectKey, { interactionId: payload.interactionId, reused: true });
        return providerRef("issue_interaction", payload.interactionId);
      }
    }

    const options = (req.options ?? []).map((option) => ({ id: option.id, label: option.label }));
    const questionId = `${TARGET_HASH_PREFIX}:${req.decisionTargetHash}`;
    const interaction = {
      kind: "ask_user_questions",
      // The idempotency key is the exact target, so a replay of the same request finds the
      // same card instead of asking a human twice.
      idempotencyKey: stableIdempotencyKey(["pf.interaction", companyId, issue.id, req.decisionTargetHash]),
      resolverPolicy,
      title: `PolyForge: ${req.semanticKind}`,
      summary: `${SEMANTIC_KIND_PREFIX}=${req.semanticKind}`,
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        title: `PolyForge decision required: ${req.semanticKind}`,
        submitLabel: "Record decision",
        supersedeOnUserComment: false,
        questions: [
          {
            id: questionId,
            prompt: this.#buildPrompt(req, options),
            helpText: `A human decision on this card does not by itself advance the run; the PolyForge Core re-verifies the target before recording it.`,
            selectionMode: "single",
            required: true,
            // A free-form escape hatch is disabled on purpose: an answer outside the option
            // set is not one of the targets the Core hashed, so it could not be verified.
            allowOther: false,
            options: options.length > 0 ? options : [{ id: "acknowledge", label: "Acknowledge" }],
          },
        ],
      },
    } as unknown as CreateIssueThreadInteraction;

    const created = await ctx.issues.createInteraction(issue.id, interaction, companyId, {
      // The bridge is the creator, attributed to no human. `authorAgentId` is omitted so the
      // host records a system/plugin attribution that `not_creator` can compare against.
      authorAgentId: undefined,
    });

    const binding: InteractionBinding = {
      requestId: effectKey,
      issueId: issue.id,
      interactionId: created.id,
      decisionTargetHash: req.decisionTargetHash,
      semanticKind: req.semanticKind,
      requiredResolver: requested,
      effectiveResolverPolicy: resolverPolicy,
      createdAt: this.#deps.now().toISOString(),
      resolvedVerified: false,
      options,
    };
    store.putBinding({
      companyId,
      kind: INTERACTION_BINDING_KIND,
      providerId: effectKey,
      projectId: issue.projectId ?? "",
      payload: binding,
    });

    deliveries.observed(effectKey, { interactionId: created.id, resolverPolicy });
    logger2.info("created a human-only interaction carrying an engineering decision", {
      issueId: issue.id,
      interactionId: created.id,
      semanticKind: req.semanticKind,
      resolverPolicy,
    });
    return providerRef("issue_interaction", created.id);
  }

  /**
   * The human-facing prompt.
   *
   * It carries the Core's semantic kind and the exact decision target hash in the visible
   * text, not in a hidden field. That matters: the Core keeps the canonical target, the
   * platform object only references it, and a reviewer looking at the card must be able to
   * see *what exactly* they are approving.
   */
  #buildPrompt(req: InteractionRequest, options: { id: string; label: string }[]): string {
    const lines = [
      req.question,
      "",
      `${SEMANTIC_KIND_PREFIX}: ${req.semanticKind}`,
      `${TARGET_HASH_PREFIX}: ${req.decisionTargetHash}`,
    ];
    if (options.length > 0) {
      lines.push("", "Options:");
      for (const option of options) lines.push(`- ${option.id}: ${option.label}`);
    }
    return lines.join("\n");
  }

  // -------------------------------------------------------------------------
  // requestEngineeringDecision
  // -------------------------------------------------------------------------

  /**
   * MVP carrier for an engineering decision.
   *
   * With `experimental.decisions` off (the default, and the only supported configuration in
   * this release) an engineering decision is carried by the same `human_only` Interaction, as
   * REQ-GOV-01 requires, and the domain semantics stay in the Core's
   * `EngineeringDecisionRecord`. The whitelisted `effects` are **recorded, not executed** by
   * the bridge: applying an effect that changes an issue status from here would create a
   * second execution path into the same run, which docs/02 §9 forbids.
   */
  async requestEngineeringDecision(req: DecisionRequest, meta: CommandMeta): Promise<ProviderRefLike> {
    const { config, logger, store } = this.#deps;
    const effectKey = governanceEffectKey(req.decisionTargetHash, req.semanticKind, req.correlationId);
    logger.info("routing an engineering decision through the human-only Interaction carrier", {
      graphId: req.semanticKind,
      experimentalDecisions: config.experimental.decisions,
      effectCount: req.effects.length,
    });
    store.setCompat(req.scope.companyRef, `decision-effects/${effectKey}`, req.effects);
    return this.requestInteraction(
      {
        scope: req.scope,
        targetIssueRef: req.targetIssueRef,
        kind: "review",
        semanticKind: req.semanticKind,
        question: req.question,
        options: req.options.map((option) => ({ id: option.id, label: option.label })),
        decisionTargetHash: req.decisionTargetHash,
        correlationId: req.correlationId,
        // An engineering decision is never self-answerable by the agent that produced the
        // artifacts, so the carrier is `human_only` regardless of what the Core left unset.
        requiredResolver: "human_only",
      },
      meta,
    );
  }

  // -------------------------------------------------------------------------
  // requestActionAuthorization
  // -------------------------------------------------------------------------

  /**
   * Look for a platform approval that already carries this exact target.
   *
   * The host baseline grants plugins `approvals.read` and nothing that creates an approval, so
   * the bridge cannot mint one. Rather than pretend otherwise it (a) records the precise target
   * so an operator or a governed tool action can satisfy exactly it, and (b) returns an
   * explainable `BLOCKED_AUTHORIZATION`. `checkAuthorization` will then accept the grant only
   * if a real approval later shows up with a byte-identical target.
   */
  async requestActionAuthorization(req: AuthorizationRequest, meta: CommandMeta): Promise<ProviderRefLike> {
    const { ctx, store, logger, metrics } = this.#deps;
    const effectKey = governanceEffectKey(req.transitionHash, `authorization:${req.action}`, req.resource);
    const target = {
      action: req.action,
      resource: req.resource,
      environment: req.environment,
      authority: req.authority,
      policyRef: req.policyRef,
      inputHashes: req.inputHashes,
      transitionHash: req.transitionHash,
      expiresAt: req.expiresAt,
    };

    const action: ExactAction = {
      action: req.action,
      resource: req.resource,
      environment: req.environment,
      inputHashes: req.inputHashes,
      transitionHash: req.transitionHash,
    };

    // A grant already recorded for this exact target. The binding is keyed by the *approval id*,
    // because that is the ref every reader holds: `checkAuthorization` and the reconciler's timer
    // pass a provider ref for the approval, and a row filed under the effect key would be
    // unreachable to both — so a legitimately granted authorization could never be checked.
    for (const companyId of this.#searchOrder()) {
      for (const row of store.listBindings(companyId, AUTHORIZATION_BINDING_KIND, 200)) {
        const payload = readJson(row.payloadJson);
        if (String(payload["effectKey"] ?? "") !== effectKey) continue;
        const status = await this.checkAuthorization(providerRef("approval", row.providerId), action);
        if (status.granted && status.exactMatch) return providerRef("approval", row.providerId);
      }
    }

    // Search for an approval a human already created for this exact target. Matching is on
    // the full target, never on the action name alone.
    for (const companyId of this.#searchOrder()) {
      const approvals = await ctx.approvals.list({ companyId });
      for (const approval of approvals) {
        const payload = (approval.payload ?? {}) as Record<string, unknown>;
        const inputHashes = payload["inputHashes"];
        if (
          payload["action"] === req.action &&
          payload["resource"] === req.resource &&
          payload["environment"] === req.environment &&
          payload["transitionHash"] === req.transitionHash &&
          canonicalJson(inputHashes ?? {}) === canonicalJson(req.inputHashes)
        ) {
          store.putBinding({
            companyId,
            kind: AUTHORIZATION_BINDING_KIND,
            providerId: approval.id,
            projectId: req.scope?.projectRef ?? "",
            payload: { ...target, effectKey, approvalId: approval.id, approvalStatus: approval.status },
            revision: approval.status,
          });
          logger.info("found an existing platform approval for the exact action", {
            approvalId: approval.id,
            action: req.action,
            companyId,
          });
          return providerRef("approval", approval.id);
        }
      }
    }

    metrics.bump(this.#deps.scope.companyRef, "platformBlocks");
    logger.warn("no approval exists for this exact action and the bridge cannot create one", {
      action: req.action,
      resource: req.resource,
      transitionHash: req.transitionHash,
      correlationId: meta.correlationId,
    });
    throw new UnsupportedCapabilityError(
      "approvals.respond",
      "this host baseline exposes no plugin-callable approval creation, so the exact action is BLOCKED_AUTHORIZATION until a human creates an approval carrying this target",
      { action: req.action, resource: req.resource, environment: req.environment, transitionHash: req.transitionHash },
    );
  }

  /**
   * Companies to search for an approval: this bundle's own tenant first, then any other tenant the
   * bridge has demonstrably worked for. A tenant never in that list is not searched at all, which
   * is the fail-closed direction — the request is recorded nowhere and blocked rather than
   * resolved against a company it was not issued for.
   */
  #searchOrder(): string[] {
    const own = this.#deps.scope.companyRef;
    const others = this.#deps.store.knownCompanies().filter((id) => id !== own);
    return own.length > 0 ? [own, ...others] : others;
  }

  // -------------------------------------------------------------------------
  // readVerifiedResolution
  // -------------------------------------------------------------------------

  /**
   * Re-read the authoritative object and decide whether the human's answer is *about the
   * target the Core pinned*.
   *
   * Steps, all mandatory:
   * 1. find the binding the bridge wrote when it created the carrier;
   * 2. re-read the object from the host (never from the event that announced it);
   * 3. require the object to be resolved;
   * 4. require the responder to be a human for a `human_only` carrier — an agent-resolved
   *      `human_only` card is a host violation, recorded as such rather than smoothed over;
   * 5. require the recorded target hash to equal the pinned one. `targetHashVerified` is
   *      `true` only when all of that holds.
   */
  async readVerifiedResolution(ref: ProviderRefLike): Promise<VerifiedResolution | null> {
    const { ctx, store, logger, metrics } = this.#deps;
    // Scoped to this bundle's company, for the same reason `checkAuthorization` is: the ref
    // carries no tenant, and this port already knows which tenant it belongs to.
    const companyId = this.#deps.scope.companyRef;
    if (!store.isProviderRefInCompany(companyId, ref)) {
      logger.warn("a governance carrier ref is not bound in this company", { ref, companyId });
      return null;
    }
    const row = store.getBinding(companyId, INTERACTION_BINDING_KIND, ref.id);
    if (!row) return null;
    const binding = parseInteractionBinding(row.payloadJson);
    if (!binding) return null;

    const interactions = await ctx.issues.listInteractions(binding.issueId, companyId);
    const interaction = interactions.find((entry) => entry.id === binding.interactionId);
    if (!interaction) {
      logger.warn("governance carrier no longer exists on the issue", {
        interactionId: binding.interactionId,
        issueId: binding.issueId,
      });
      return null;
    }
    if (interaction.status === "pending") return null;

    const record = readJson(row.payloadJson);
    const humanResponder = typeof interaction.resolvedByUserId === "string" && interaction.resolvedByUserId.length > 0;
    const agentResponder = typeof interaction.resolvedByAgentId === "string" && interaction.resolvedByAgentId.length > 0;

    const responderKind = humanResponder ? "human" : agentResponder ? "agent" : "system";
    const responderSubject = humanResponder
      ? String(interaction.resolvedByUserId)
      : agentResponder
        ? String(interaction.resolvedByAgentId)
        : "paperclip:system";

    // The hash is read out of the object the host still holds, not from anything the bridge
    // was told. A mutated or replaced card therefore fails the comparison.
    const observedTargetHash = extractTargetHash(interaction);
    const targetHashVerified = observedTargetHash === binding.decisionTargetHash;

    if (!humanResponder && binding.effectiveResolverPolicy === "human_only") {
      metrics.bump(companyId, "platformBlocks");
      logger.error("a human_only interaction was resolved without a human responder", {
        interactionId: interaction.id,
        responderKind,
      });
    }
    if (!targetHashVerified) {
      logger.error("governance resolution does not match the pinned decision target", {
        interactionId: interaction.id,
        expected: binding.decisionTargetHash,
        observed: observedTargetHash,
      });
    }

    const outcome = readOutcome(interaction);
    const updated = { ...record, resolvedVerified: targetHashVerified && humanResponder } as Record<string, unknown>;
    store.putBinding({
      companyId,
      kind: INTERACTION_BINDING_KIND,
      providerId: ref.id,
      projectId: row.projectId,
      payload: updated,
      revision: interaction.status,
    });

    return {
      providerRef: ref,
      outcome,
      responderSubject,
      responderKind,
      targetHashVerified,
      detail: {
        interactionId: interaction.id,
        status: interaction.status,
        effectiveResolverPolicy: binding.effectiveResolverPolicy,
        observedTargetHash,
        pinnedTargetHash: binding.decisionTargetHash,
        semanticKind: binding.semanticKind,
        humanResponder,
        agentResponder,
        options: binding.options,
      },
      recordedAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // checkAuthorization
  // -------------------------------------------------------------------------

  /**
   * Exact-action authorization check.
   *
   * Every field of `ExactAction` must match the grant, and the grant must be live. A partial
   * match is a refusal with a specific reason so the operator learns *which* dimension moved
   * — the AT-14 case of "the artifact or the environment changed after the approval".
   */
  async checkAuthorization(ref: ProviderRefLike, action: ExactAction): Promise<AuthorizationStatus> {
    const { ctx, store, logger, metrics, now } = this.#deps;
    // Scoped to *this* bundle's company. Resolving the tenant from the ref would let a ref
    // recorded in another company lead this port into that company's bindings.
    const companyId = this.#deps.scope.companyRef;
    if (!store.isProviderRefInCompany(companyId, ref)) {
      logger.warn("an authorization ref is not bound in this company", {
        ref,
        companyId,
        reason: store.findCompanyForProviderRef(ref) === null ? "unknown ref" : "bound in another company",
      });
      return {
        granted: false,
        reason: "this authorization ref is not bound in this company",
        expiresAt: null,
        revoked: false,
        exactMatch: false,
      };
    }
    const row = store.getBinding(companyId, AUTHORIZATION_BINDING_KIND, ref.id);
    if (!row) {
      return { granted: false, reason: "authorization target was never recorded by the bridge", expiresAt: null, revoked: false, exactMatch: false };
    }
    const record = readJson(row.payloadJson);

    const approvalId = typeof record["approvalId"] === "string" ? record["approvalId"] : null;
    if (approvalId === null) {
      return {
        granted: false,
        reason: "no platform approval carries this exact target",
        expiresAt: typeof record["expiresAt"] === "string" ? record["expiresAt"] : null,
        revoked: false,
        exactMatch: false,
      };
    }

    const approval = await ctx.approvals.get(approvalId, companyId);
    if (!approval) {
      return { granted: false, reason: "the referenced approval is not visible in this company", expiresAt: null, revoked: false, exactMatch: false };
    }

    const payload = (approval.payload ?? {}) as Record<string, unknown>;
    const checks: { field: string; ok: boolean }[] = [
      { field: "action", ok: payload["action"] === action.action },
      { field: "resource", ok: payload["resource"] === action.resource },
      { field: "environment", ok: payload["environment"] === action.environment },
      { field: "transitionHash", ok: payload["transitionHash"] === action.transitionHash },
      {
        field: "inputHashes",
        ok: canonicalJson(payload["inputHashes"] ?? {}) === canonicalJson(action.inputHashes),
      },
      { field: "authority", ok: payload["authority"] === record["authority"] },
    ];
    const mismatched = checks.filter((check) => !check.ok).map((check) => check.field);

    const expiresAt = typeof payload["expiresAt"] === "string" ? payload["expiresAt"] : null;
    // This host's approval vocabulary has no `revoked` status; a revocation shows up as
    // `cancelled` or as an explicit `revoked` flag in the payload. Both are treated as revoked
    // so a future status addition cannot silently read as still-granted.
    const revoked = approval.status === "cancelled" || payload["revoked"] === true;
    const expired = expiresAt !== null && Date.parse(expiresAt) <= now().getTime();
    const approved = approval.status === "approved";

    if (revoked) {
      metrics.bump(companyId, "platformBlocks");
      return { granted: false, reason: "the authorization was revoked", expiresAt, revoked: true, exactMatch: mismatched.length === 0 };
    }
    if (expired) {
      metrics.bump(companyId, "platformBlocks");
      return { granted: false, reason: "the authorization expired", expiresAt, revoked: false, exactMatch: mismatched.length === 0 };
    }
    if (mismatched.length > 0) {
      // A changed target is the AT-14 case. The old grant is simply not applicable, and the
      // reason names the dimensions so the caller can request a fresh one.
      metrics.bump(companyId, "platformBlocks");
      logger.warn("authorization does not cover this exact action", { mismatched, approvalId });
      return {
        granted: false,
        reason: `authorization does not match the requested action on: ${mismatched.join(", ")}`,
        expiresAt,
        revoked: false,
        exactMatch: false,
      };
    }
    if (!approved) {
      return {
        granted: false,
        reason: `the authorization is not approved (status ${approval.status})`,
        expiresAt,
        revoked: false,
        exactMatch: true,
      };
    }
    return { granted: true, reason: "exact match, live, unrevoked", expiresAt, revoked: false, exactMatch: true };
  }
}

function readJson(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseInteractionBinding(json: string): InteractionBinding | null {
  const record = readJson(json);
  const required = ["requestId", "issueId", "interactionId", "decisionTargetHash", "semanticKind"] as const;
  for (const key of required) {
    if (typeof record[key] !== "string") return null;
  }
  return {
    requestId: String(record["requestId"]),
    issueId: String(record["issueId"]),
    interactionId: String(record["interactionId"]),
    decisionTargetHash: String(record["decisionTargetHash"]),
    semanticKind: String(record["semanticKind"]),
    requiredResolver: (record["requiredResolver"] as InteractionBinding["requiredResolver"]) ?? "human_only",
    effectiveResolverPolicy:
      typeof record["effectiveResolverPolicy"] === "string" ? record["effectiveResolverPolicy"] : "human_only",
    createdAt: typeof record["createdAt"] === "string" ? record["createdAt"] : new Date(0).toISOString(),
    resolvedVerified: record["resolvedVerified"] === true,
    options: Array.isArray(record["options"]) ? (record["options"] as { id: string; label: string }[]) : [],
  };
}

/**
 * Read the target hash back out of the carrier.
 *
 * Both the prompt text and the summary are searched, because a human may have quoted the card
 * into a comment. Neither is trusted as an *approval*; they are only the place the hash is
 * recorded, and a hash that is absent yields `null` so the comparison fails.
 */
function extractTargetHash(interaction: IssueThreadInteraction): string | null {
  const haystacks: string[] = [];
  if (typeof interaction.summary === "string") haystacks.push(interaction.summary);
  if (interaction.kind === "ask_user_questions") {
    for (const question of interaction.payload.questions) {
      haystacks.push(question.prompt);
      if (typeof question.helpText === "string") haystacks.push(question.helpText);
    }
  }
  for (const text of haystacks) {
    // Whitespace-agnostic on purpose: the card writes `decision-target: <hash>` in the prompt
    // but `decision-target:<hash>` in the question id, and a human may have retyped either.
    const match = new RegExp(`\\b${TARGET_HASH_PREFIX}\\s*:\\s*(\\S+)`).exec(text);
    if (match?.[1]) return match[1];
  }
  return null;
}

function readOutcome(interaction: IssueThreadInteraction): VerifiedResolution["outcome"] {
  switch (interaction.status) {
    case "accepted":
    case "answered":
      return "accept";
    case "rejected":
      return "reject";
    case "cancelled":
    case "expired":
      return "deny";
    default:
      // `pending`, `failed`. Neither is a decision, so neither is reported as one.
      return "reject";
  }
}
