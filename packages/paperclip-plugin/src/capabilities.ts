/**
 * Engineering capability matching.
 *
 * ## Why this is not free text on a Paperclip agent
 *
 * A capability here is an *engineering* obligation ("this subject may perform
 * `code.modify`"), not a platform attribute. Reading it off `Agent.capabilities` would make
 * the grant as weak as the string that names it: anyone who can edit an agent can silently
 * widen what that agent is allowed to execute, and independent review collapses because a
 * subject can grant itself the reviewing capability. So bindings live in the bridge store,
 * are keyed by a stable subject, are bound to a Paperclip agent *reference*, and are written
 * only through the internal `seedBindings` method today. This checkout has no production
 * operator grant/revoke surface: the current Plugin SDK action/API actor does not expose a
 * verifiable administrator bit. Do not add a user-facing writer until the host can prove the
 * required operator authority; a generic board-user check is not sufficient for widening grants.
 *
 * ## The rule that matters most
 *
 * **A fallback that lacks the required capability is BLOCKED, never used.** `preferredRoles`
 * and `fallbackRoles` are *preferences*. They are applied strictly after the capability
 * filter, and the filter is never relaxed. A rejected fallback is still reported, with the
 * capability it is missing, so an operator can see "this run did not start because the only
 * fallback role lacks `security.review`" instead of "no eligible worker" (docs/01 REQ-ENTRY-04,
 * AT-24).
 *
 * ## Independence
 *
 * `independentFrom` names capability refs together with the subjects that produced them. A
 * reviewer candidate is rejected when it is one of those subjects: a subject cannot review
 * its own output. The bridge also keeps a per-binding `independentSubjects` list so an
 * operator can forbid a pairing that the graph definition does not name (e.g. two specific
 * agents that keep reviewing each other).
 */

import { stableIdempotencyKey } from "@polyforge/protocol";
import type { ProviderRefLike, WorkerCandidate, WorkerRequirement } from "@polyforge/protocol";
import type { BridgeStore } from "./store.js";
import { UnsupportedCapabilityError } from "./errors.js";

/** `provider_bindings.kind` for capability bindings. */
export const CAPABILITY_BINDING_KIND = "capability_binding";

export interface CapabilityBinding {
  /** Stable subject identity, e.g. `agent:paperclip/<agentId>`. */
  readonly subjectRef: string;
  /** The Paperclip agent this subject is bound to. */
  readonly agentId: string;
  /** The Paperclip project this engineering grant is scoped to. */
  readonly projectRef: string;
  readonly capabilities: readonly string[];
  /** Paperclip agent roles this subject may be preferred for. */
  readonly roles: readonly string[];
  /** Subjects this subject may never be paired with (for example a mutual-review pair). */
  readonly independentSubjects: readonly string[];
  /** Version of the agent capability contract this grant was made under. */
  readonly contractVersion: string;
  readonly enabled: boolean;
}

export interface CapabilityRejection {
  readonly subjectRef: string;
  readonly agentId: string;
  readonly code:
    | "missing_capability"
    | "excluded_subject"
    | "independence_violation"
    | "binding_disabled"
    | "no_agent_reference";
  readonly message: string;
  /** The exact requirement that failed, so the UI can render it without re-deriving. */
  readonly detail: Record<string, unknown>;
}

export interface ResolveReport {
  readonly requirement: WorkerRequirement;
  readonly candidates: WorkerCandidate[];
  readonly rejected: CapabilityRejection[];
  /**
   * Subjects that *would* have been selected by a role preference but are blocked because
   * they lack a required capability. This is the explicit "fallback is not an authorization"
   * record.
   */
  readonly blockedFallbacks: CapabilityRejection[];
}

/** The provider ref a candidate is dispatched through. The subject id is *not* the agent id. */
function ref(agentId: string): ProviderRefLike {
  return { provider: "paperclip", kind: "agent", id: agentId };
}

function parseBinding(payload: unknown): CapabilityBinding | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const subjectRef = record["subjectRef"];
  const agentId = record["agentId"];
  const projectRef = record["projectRef"];
  if (typeof subjectRef !== "string" || typeof agentId !== "string" || typeof projectRef !== "string") return null;
  return {
    subjectRef,
    agentId,
    projectRef,
    capabilities: Array.isArray(record["capabilities"]) ? (record["capabilities"] as string[]) : [],
    roles: Array.isArray(record["roles"]) ? (record["roles"] as string[]) : [],
    independentSubjects: Array.isArray(record["independentSubjects"])
      ? (record["independentSubjects"] as string[])
      : [],
    contractVersion: typeof record["contractVersion"] === "string" ? record["contractVersion"] : "unversioned",
    // A missing or malformed enable flag is not an implicit grant. Seeded bindings always write
    // an explicit boolean; old/corrupt rows must remain blocked until explicitly re-seeded.
    enabled: record["enabled"] === true,
  };
}

/**
 * The engineering capability matcher.
 *
 * Stateless apart from the store: every resolution is a pure function of the current bindings
 * and the requirement, so the same requirement resolves the same way after a restart.
 */
export class CapabilityMatcher {
  readonly #store: BridgeStore;

  constructor(store: BridgeStore) {
    this.#store = store;
  }

  bindings(companyId: string, projectId?: string): CapabilityBinding[] {
    return this.#store
      .listBindings(companyId, CAPABILITY_BINDING_KIND)
      .filter((row) => projectId === undefined || row.projectId === projectId)
      .map((row) => parseBinding(row.payloadJson && safeParse(row.payloadJson)))
      .filter((value): value is CapabilityBinding => value !== null);
  }

  bindingForAgent(companyId: string, projectId: string, agentId: string): CapabilityBinding | null {
    return this.bindings(companyId, projectId).find((binding) => binding.agentId === agentId) ?? null;
  }

  /**
   * The grant for one subject ref.
   *
   * Separate from `bindingForAgent` because the two are different keys. A subject ref is the
   * stable string the graph and the Core name (`agent:paperclip/agent-1`); an agent id is a
   * Paperclip row id. Looking a subject ref up by agent id can never match, so a dispatch that
   * resolved its worker that way would find no grant and refuse the work.
   */
  bindingForSubject(companyId: string, projectId: string, subjectRef: string): CapabilityBinding | null {
    return this.bindings(companyId, projectId).find((binding) => binding.subjectRef === subjectRef) ?? null;
  }

  /**
   * Create or update a binding from an explicit list.
   *
   * Idempotent on `(company, project, subject)`, so re-running the operator seed converges instead of
   * creating a second grant for the same subject. A binding that narrows capabilities is
   * accepted; nothing here can widen a grant implicitly because the caller supplies the full
   * desired set.
   */
  seedBindings(companyId: string, bindings: readonly CapabilityBinding[]): number {
    let written = 0;
    for (const binding of bindings) {
      if (binding.subjectRef.length === 0 || binding.agentId.length === 0 || binding.projectRef.length === 0) {
        throw new UnsupportedCapabilityError(
          "capability_binding",
          "a capability binding needs a subjectRef, agentId and projectRef",
          { binding: { subjectRef: binding.subjectRef, agentId: binding.agentId } },
        );
      }
      this.#store.putBinding({
        companyId,
        kind: CAPABILITY_BINDING_KIND,
        providerId: `${binding.projectRef}:${binding.subjectRef}`,
        projectId: binding.projectRef,
        payload: {
          subjectRef: binding.subjectRef,
          agentId: binding.agentId,
          projectRef: binding.projectRef,
          capabilities: [...binding.capabilities],
          roles: [...binding.roles],
          independentSubjects: [...binding.independentSubjects],
          contractVersion: binding.contractVersion,
          enabled: binding.enabled,
        },
      });
      written += 1;
    }
    return written;
  }

  removeBinding(companyId: string, subjectRef: string): void {
    // providerId includes the project (`<projectRef>:<subjectRef>`), so deleting by subjectRef
    // directly silently leaves every grant active. Match the durable payload instead and remove
    // each exact provider key; a subject's revocation applies across all project scopes.
    for (const row of this.#store.listBindings(companyId, CAPABILITY_BINDING_KIND)) {
      const payload = safeParse(row.payloadJson);
      if (
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload) &&
        (payload as Record<string, unknown>)["subjectRef"] === subjectRef
      ) {
        this.#store.deleteBinding(companyId, CAPABILITY_BINDING_KIND, row.providerId);
      }
    }
  }

  /**
   * Resolve eligible workers, ordered by role preference.
   *
   * Ordering is deterministic: preferred role index, then fallback role index, then subject
   * ref. Two runs of the same requirement therefore pick the same worker, which is what
   * makes a dispatch replayable.
   */
  resolve(requirement: WorkerRequirement): ResolveReport {
    const bindings = this.bindings(requirement.scope.companyRef, requirement.scope.projectRef);
    const preferred = requirement.preferredRoles ?? [];
    const fallback = requirement.fallbackRoles ?? [];
    const excluded = new Set(requirement.excludeSubjects ?? []);
    const independenceRules = requirement.independentFrom ?? [];
    const required = requirement.requiredCapabilities;

    const candidates: RankedCandidate[] = [];
    const rejected: CapabilityRejection[] = [];
    const blockedFallbacks: CapabilityRejection[] = [];

    for (const binding of bindings) {
      if (!binding.enabled) {
        rejected.push({
          subjectRef: binding.subjectRef,
          agentId: binding.agentId,
          code: "binding_disabled",
          message: "capability binding is disabled",
          detail: { contractVersion: binding.contractVersion },
        });
        continue;
      }

      if (excluded.has(binding.subjectRef)) {
        rejected.push({
          subjectRef: binding.subjectRef,
          agentId: binding.agentId,
          code: "excluded_subject",
          message: "subject is explicitly excluded for this node",
          detail: { excludeSubjects: [...excluded] },
        });
        continue;
      }

      const missing = required.filter((capability) => !binding.capabilities.includes(capability));
      if (missing.length > 0) {
        const rejection: CapabilityRejection = {
          subjectRef: binding.subjectRef,
          agentId: binding.agentId,
          code: "missing_capability",
          message: `subject lacks required capability(s): ${missing.join(", ")}`,
          detail: { missingCapabilities: missing, requiredCapabilities: required },
        };
        rejected.push(rejection);
        // A role preference never overrides the capability filter. If this subject *would*
        // have been picked purely by role, record it as a blocked fallback so the reason a
        // run did not start is visible instead of silent.
        if (matchesAnyRole(binding.roles, preferred) || matchesAnyRole(binding.roles, fallback)) {
          blockedFallbacks.push({
            ...rejection,
            message: `role-matched subject blocked: ${rejection.message}`,
          });
        }
        continue;
      }

      const independenceConflict = findIndependenceConflict(binding.subjectRef, independenceRules);
      if (independenceConflict !== null) {
        rejected.push({
          subjectRef: binding.subjectRef,
          agentId: binding.agentId,
          code: "independence_violation",
          message: `subject produced the capability the review must be independent of (${independenceConflict.capabilityRef})`,
          detail: { capabilityRef: independenceConflict.capabilityRef, producers: independenceConflict.subjectRefs },
        });
        continue;
      }

      if (binding.independentSubjects.length > 0) {
        const clash = binding.independentSubjects.find(
          (other) => independenceRules.some((rule) => rule.subjectRefs.includes(other)),
        );
        if (clash !== undefined) {
          rejected.push({
            subjectRef: binding.subjectRef,
            agentId: binding.agentId,
            code: "independence_violation",
            message: "subject is bound as independent from a subject this review is about",
            detail: { conflictingSubject: clash },
          });
          continue;
        }
      }

      const preferredIndex = firstRoleIndex(binding.roles, preferred);
      const fallbackIndex = firstRoleIndex(binding.roles, fallback);
      const tier = preferredIndex >= 0 ? 0 : fallbackIndex >= 0 ? 1 : 2;
      const roleIndex = preferredIndex >= 0 ? preferredIndex : fallbackIndex >= 0 ? fallbackIndex : 0;
      const reasons = [
        `capabilities satisfied: ${required.join(", ")}`,
        preferredIndex >= 0
          ? `preferred role match: ${binding.roles[preferredIndex]}`
          : fallbackIndex >= 0
            ? `fallback role match: ${binding.roles[fallbackIndex]}`
            : "no role preference; capability-only match",
        "independence satisfied",
      ];

      candidates.push({
        candidate: {
          subjectRef: binding.subjectRef,
          providerRef: ref(binding.agentId),
          matchedCapabilities: required.filter((capability) => binding.capabilities.includes(capability)),
          independenceSatisfied: true,
          reasons,
        },
        tier,
        roleIndex,
      });
    }

    candidates.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.roleIndex !== b.roleIndex) return a.roleIndex - b.roleIndex;
      return a.candidate.subjectRef.localeCompare(b.candidate.subjectRef);
    });

    return {
      requirement,
      // The ranking fields are a sorting detail, not part of the port shape, so they do not
      // leak into the returned candidates.
      candidates: candidates.map((entry) => entry.candidate),
      rejected,
      blockedFallbacks,
    };
  }

  /** `WorkManagementPort.resolveWorker`. Returns only the candidates the port contract carries. */
  async resolveWorker(requirement: WorkerRequirement): Promise<WorkerCandidate[]> {
    return this.resolve(requirement).candidates;
  }

  /** Correlation key for a dispatch, stable across replays of the same binding. */
  dispatchKey(requirement: WorkerRequirement, subjectRef: string, nodeId: string, iteration: number): string {
    return stableIdempotencyKey([
      requirement.scope.companyRef,
      requirement.runId,
      nodeId,
      String(iteration),
      subjectRef,
    ]);
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function matchesAnyRole(roles: readonly string[], wanted: readonly string[]): boolean {
  return wanted.some((role) => roles.includes(role));
}

function firstRoleIndex(roles: readonly string[], wanted: readonly string[]): number {
  for (let index = 0; index < wanted.length; index += 1) {
    const role = wanted[index];
    if (role !== undefined && roles.includes(role)) return index;
  }
  return -1;
}

function findIndependenceConflict(
  subjectRef: string,
  rules: readonly { capabilityRef: string; subjectRefs: string[] }[],
): { capabilityRef: string; subjectRefs: string[] } | null {
  for (const rule of rules) {
    if (rule.subjectRefs.includes(subjectRef)) return rule;
  }
  return null;
}

/** A candidate plus the two numbers the deterministic ordering uses. */
interface RankedCandidate {
  readonly candidate: WorkerCandidate;
  readonly tier: number;
  readonly roleIndex: number;
}
