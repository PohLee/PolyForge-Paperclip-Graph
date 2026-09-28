/**
 * Shared port plumbing and the port factory.
 *
 * The five ports in `ports/` are the *only* place the bridge touches Paperclip host APIs.
 * They receive their collaborators through `BridgeDeps` and return provider-neutral refs and
 * receipts. Nothing here knows about `PluginContext` method names beyond the clients it is
 * handed, and nothing in a port reaches into the Runtime Service directly: a port that needed
 * the Core would be a second execution path, which docs/02 §2 forbids.
 *
 * This module imports the concrete ports (value imports) and the port modules import their
 * shared types from here with `import type` only, so there is no runtime import cycle.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { BridgeConfig } from "../config.js";
import type { BridgeLogger } from "../logger.js";
import type { BridgeStore } from "../store.js";
import type { CapabilityMatcher } from "../capabilities.js";
import type { BridgeMetrics } from "../metrics.js";
import type { RuntimeClient } from "../runtime-client.js";
import type { OutboxPump } from "../outbox/delivery.js";
import type { Reconciler } from "../reconciler.js";
import type { Router } from "../router.js";
import type { AdmissionGate } from "../admission.js";
import type { Inbox } from "../events/inbox.js";
import type { ProviderRefLike, Scope } from "@polyforge/protocol";
import { ScopeViolationError } from "../errors.js";
import { WorkManagementPortImpl } from "./work-management.js";
import { GovernancePortImpl } from "./governance.js";
import { WorkspacePortImpl } from "./workspace.js";
import { ArtifactPortImpl } from "./artifacts.js";
import { ObservabilityPortImpl } from "./observability.js";
import type {



  Ports,


} from "@polyforge/protocol";

/**
 * Record the lifecycle of one delivery operation.
 *
 * Ports call these instead of touching the store, so every external effect the bridge causes
 * ends up in `delivery_operations` with the same `pending → sent → observed → reconciled`
 * vocabulary the protocol requires — and a crash between any two steps is recoverable because
 * the next reader can see exactly how far the effect got.
 */
export interface DeliveryRecorder {
  /** Insert the intent. Returns `false` when an intent with the same effect key already exists. */
  begin(input: {
    effectKey: string;
    kind: string;
    scope: Scope;
    correlationId: string;
    runId?: string | null;
    nodeId?: string | null;
    payload: unknown;
    notBefore?: string;
  }): boolean;
  /** The request is on the wire. */
  sent(effectKey: string, receiptHint?: string | null): void;
  /** The provider answered. `ambiguous: true` means the answer did not establish the outcome. */
  observed(effectKey: string, result: unknown, options?: { receiptRef?: string | null; ambiguous?: boolean; error?: string | null }): void;
  /** The effect is confirmed applied and consistent with the Core. */
  reconciled(effectKey: string, note?: string | null): void;
  /** A permanent refusal. No further attempts. */
  failed(effectKey: string, reason: string): void;
}

export interface BridgeDeps {
  readonly ctx: PluginContext;
  readonly store: BridgeStore;
  readonly config: BridgeConfig;
  readonly logger: BridgeLogger;
  readonly capabilities: CapabilityMatcher;
  readonly metrics: BridgeMetrics;
  readonly deliveries: DeliveryRecorder;
  /** The signed client, or `null` when this company's config is not resolvable. */
  readonly runtime: RuntimeClient | null;
  readonly pump: OutboxPump;
  readonly reconciler: Reconciler;
  readonly router: Router;
  readonly admission: AdmissionGate;
  readonly inbox: Inbox;
  readonly now: () => Date;
  /**
   * The company (and, when known, the project) this bundle serves.
   *
   * One bundle per company, because two port contracts (`WorkspacePort.resolve` and
   * `GovernancePort.requestActionAuthorization`) receive a request that carries no scope at
   * all. Resolving the tenant from a caller-supplied string would be a cross-tenant read; a
   * per-company bundle makes the scope a property of the wiring instead.
   */
  readonly scope: Scope;
  /**
   * The port bundle, resolved lazily.
   *
   * The ports and the reconciler/pump are mutually dependent: a port records a delivery that
   * the pump executes, and the reconciler calls a port. A getter breaks the construction cycle
   * without a mutable "set later" field that a future change could read before it was set.
   */
  ports(): PortBundle;
}

export const PROVIDER = "paperclip";

/** Build the provider-neutral ref shape. `revision` is required whenever the object is mutable. */
export function providerRef(kind: string, id: string, revision?: string | null): ProviderRefLike {
  return revision === undefined || revision === null
    ? { provider: PROVIDER, kind, id }
    : { provider: PROVIDER, kind, id, revision };
}

export function refKey(ref: ProviderRefLike): string {
  return `${ref.provider}:${ref.kind}:${ref.id}`;
}

export function parseRefKey(key: string): { provider: string; kind: string; id: string } | null {
  const parts = key.split(":");
  const [provider, kind, id] = parts;
  if (provider === undefined || kind === undefined || id === undefined) return null;
  return { provider, kind, id: parts.slice(2).join(":") };
}

/**
 * The single scope guard every port applies before touching the host.
 *
 * The expected scope comes from the Core's intent; the authenticated scope comes from the
 * event or action that triggered it. A mismatch is a `SCOPE_VIOLATION` and is counted, never
 * downgraded to a read of a "probably the same" tenant.
 */
export function guardScope(
  expected: Scope,
  authenticated: { companyId: string; projectId: string | null },
  what: string,
  metrics: BridgeMetrics,
): void {
  if (expected.companyRef !== authenticated.companyId) {
    metrics.bump(authenticated.companyId, "crossScopeDenials");
    throw new ScopeViolationError(`${what}: cross-company access refused`, {
      expectedCompany: expected.companyRef,
      authenticatedCompany: authenticated.companyId,
    });
  }
  // An empty project half means "any project inside this company", used only by the
  // deliberately company-wide reads. A concrete project must match exactly.
  if (expected.projectRef !== "" && expected.projectRef !== (authenticated.projectId ?? "")) {
    metrics.bump(authenticated.companyId, "crossScopeDenials");
    throw new ScopeViolationError(`${what}: cross-project access refused`, {
      expectedProject: expected.projectRef,
      authenticatedProject: authenticated.projectId ?? "",
    });
  }
}

export interface PortBundle extends Ports {
  readonly work: WorkManagementPortImpl;
  readonly governance: GovernancePortImpl;
  readonly workspace: WorkspacePortImpl;
  readonly artifacts: ArtifactPortImpl;
  readonly observability: ObservabilityPortImpl;
}

export function createPorts(deps: BridgeDeps): PortBundle {
  return {
    work: new WorkManagementPortImpl(deps),
    governance: new GovernancePortImpl(deps),
    workspace: new WorkspacePortImpl(deps),
    artifacts: new ArtifactPortImpl(deps),
    observability: new ObservabilityPortImpl(deps),
  };
}
