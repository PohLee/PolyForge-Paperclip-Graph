/**
 * The reconciler: the safety net for what the event stream cannot promise.
 *
 * The host has no durable replay for plugin event delivery, so the bridge cannot assume it
 * will ever see an event again. Everything the bridge does therefore has a re-derivable path:
 *
 * ```text
 * ambiguous delivery ──> look the object up by its correlation key ──> observed | failed
 * work-unit binding ───> re-read the issue; re-materialize if gone; re-project if drifted
 * dispatch binding ────> inspect the execution; report an observation (never a pass)
 * governance binding ──> re-read the carrier; record a verified resolution for the Core
 * authorization binding > check the exact action again (expiry/revocation/target drift)
 * inbox rows in `received` > replay through the normal normalize path
 * ```
 *
 * Two rules make this safe to run on a timer:
 *
 * * **It never re-executes a completed effect.** Everything here is a read, a re-projection,
 *   or a *durable intent* whose effect key dedupes. Nothing re-runs a worker or a side effect.
 * * **An `UNKNOWN` execution stays `UNKNOWN`.** If the platform cannot authoritatively say
 *   whether a run finished, the reconciler reports `unknown` again and increments
 *   `unknownAttempts`. It never converts uncertainty into a retry, because that is the exact
 *   path to two workers producing the same external effect.
 */

import { canonicalJson, type ActorAssertion, type ProviderRefLike, type Scope } from "@polyforge/protocol";
import type { BridgeDeps } from "./ports/index.js";
import { eventIntakeEffectKey, INTENT_KINDS } from "./outbox/intents.js";
import { DISPATCH_BINDING_KIND, RUN_BINDING_KIND, WORK_UNIT_BINDING_KIND } from "./ports/work-management.js";
import { AUTHORIZATION_BINDING_KIND, INTERACTION_BINDING_KIND } from "./ports/governance.js";
import { providerRef } from "./ports/index.js";

export interface ReconcileReport {
  readonly companyId: string;
  readonly ambiguousResolved: number;
  readonly ambiguousStillUnknown: number;
  readonly workUnitsChecked: number;
  readonly workUnitsRematerialized: number;
  readonly projectionsReapplied: number;
  readonly executionsInspected: number;
  readonly executionsStillUnknown: number;
  readonly governanceObserved: number;
  readonly authorizationsChecked: number;
  readonly inboxReplayed: number;
  readonly issues: string[];
}

const SYSTEM_ACTOR: ActorAssertion = {
  actorType: "system",
  actorId: "paperclip:system",
  agentId: null,
  runId: null,
  roles: [],
};

export class Reconciler {
  readonly #deps: BridgeDeps;

  constructor(deps: BridgeDeps) {
    this.#deps = deps;
  }

  async reconcileCompany(companyId: string): Promise<ReconcileReport> {
    const { store, logger } = this.#deps;
    const report: MutableReport = {
      ambiguousResolved: 0,
      ambiguousStillUnknown: 0,
      workUnitsChecked: 0,
      workUnitsRematerialized: 0,
      projectionsReapplied: 0,
      executionsInspected: 0,
      executionsStillUnknown: 0,
      governanceObserved: 0,
      authorizationsChecked: 0,
      inboxReplayed: 0,
      issues: [],
    };

    await this.#resolveAmbiguous(companyId, report);
    this.#reportDeadLetters(companyId, report);
    await this.#reconcileRunPins(companyId, report);
    await this.#reconcileWorkUnits(companyId, report);
    await this.#reconcileGovernance(companyId, report);
    await this.#reconcileAuthorizations(companyId, report);
    await this.#reconcileExecutions(companyId, report);
    this.#replayInbox(companyId, report);

    const final: ReconcileReport = { companyId, ...report };
    store.setCompat(companyId, "reconcile/last", { ...final, at: this.#deps.now().toISOString() });
    logger.info("reconciliation pass complete", final as unknown as Record<string, unknown>);
    return final;
  }

  // -------------------------------------------------------------------------
  // Ambiguous deliveries
  // -------------------------------------------------------------------------

  /**
   * Resolve deliveries whose outcome the transport never established.
   *
   * A `work_order.create` is resolved by listing the Core's runs for the scope and matching
   * the `startIntentId` the intent recorded. Finding it means the create *did* take effect
   * and the delivery is `reconciled`; not finding it after a full re-read is the only
   * evidence that permits another attempt. Anything else stays `ambiguous`.
   */
  async #resolveAmbiguous(companyId: string, report: MutableReport): Promise<void> {
    const { store, logger, router } = this.#deps;
    const runtime = this.#deps.runtime;
    const rows = store.listDeliveries(companyId, ["ambiguous"], 200);
    for (const row of rows) {
      if (runtime === null) {
        report.issues.push("runtime client is not configured; ambiguous deliveries stay unresolved");
        continue;
      }
      const payload = safeJson(row.payloadJson);
      const scope: Scope = {
        companyRef: companyId,
        projectRef: row.projectId.length > 0 ? row.projectId : "",
      };
      try {
        if (row.kind === INTENT_KINDS.workOrderCreate) {
          const startIntentId = String(payload["startIntentId"] ?? "");
          const found = await this.#findRunByStartIntent(runtime, SYSTEM_ACTOR, scope, startIntentId);
          if (found !== null) {
            router.recordRun({
              scope,
              runId: found.runId,
              workOrderId: found.workOrderId,
              graphId: found.graphId,
              graphVersion: found.graphVersion,
              entrypoint: found.entrypoint,
              rootIssueId: String(safeJson(JSON.stringify(payload["rootIssueRef"] ?? {})).id ?? ""),
              startIntentId,
              pins: found.pins,
            });
            store.updateDelivery(companyId, row.effectKey, {
              status: "reconciled",
              leaseOwner: null,
              leaseExpiresAt: null,
              result: { runId: found.runId, recoveredBy: "correlation_key_lookup" },
              lastError: null,
            });
            report.ambiguousResolved += 1;
            logger.info("an ambiguous work-order create was resolved by correlation-key lookup", {
              runId: found.runId,
              startIntentId,
            });
            continue;
          }
          // An authoritative absence for this exact start intent is the only thing that
          // permits a retry. The Core's own `startIntentId` idempotency makes the resend safe.
          store.updateDelivery(companyId, row.effectKey, {
            status: "pending",
            nextAttemptAt: this.#deps.now().toISOString(),
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: "no run exists for this start intent; resending under the same idempotency key",
          });
          report.ambiguousResolved += 1;
          continue;
        }

        if (row.kind === INTENT_KINDS.eventIntake) {
          // Event intake is idempotent on `source + scope + sourceEventId` at the Core, so a
          // resend of the same body returns the recorded result. Prove that the durable body still
          // carries that exact identity and scope before using this safe retry path; a malformed or
          // corrupted row without the Core's dedupe key must remain UNKNOWN rather than be resent.
          const sourceEventId =
            typeof payload["sourceEventId"] === "string" && payload["sourceEventId"].trim().length > 0
              ? payload["sourceEventId"]
              : null;
          const eventScope = payload["scope"];
          const scopeMatches =
            typeof eventScope === "object" &&
            eventScope !== null &&
            !Array.isArray(eventScope) &&
            (eventScope as Record<string, unknown>)["companyRef"] === scope.companyRef &&
            (eventScope as Record<string, unknown>)["projectRef"] === scope.projectRef;
          if (
            sourceEventId === null ||
            !scopeMatches ||
            row.effectKey !== eventIntakeEffectKey(scope, sourceEventId)
          ) {
            this.#deps.metrics.bump(companyId, "unknownAttempts");
            store.updateDelivery(companyId, row.effectKey, {
              status: "ambiguous",
              nextAttemptAt: new Date(this.#deps.now().getTime() + 300_000).toISOString(),
              leaseOwner: null,
              leaseExpiresAt: null,
              lastError: "event intake has no matching source/scope idempotency identity; outcome remains unknown",
            });
            report.ambiguousStillUnknown += 1;
            report.issues.push(`event intake ${row.effectKey} has no verified Core idempotency identity`);
            continue;
          }
          store.updateDelivery(companyId, row.effectKey, {
            status: "pending",
            nextAttemptAt: this.#deps.now().toISOString(),
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: "resending idempotent event intake after an ambiguous transport failure",
          });
          report.ambiguousResolved += 1;
          continue;
        }

        // Anything else with an unknown outcome stays unknown. The Core is handed the
        // BLOCKED_EFFECT_UNKNOWN and a human decides; the bridge does not guess.
        this.#deps.metrics.bump(companyId, "unknownAttempts");
        store.updateDelivery(companyId, row.effectKey, {
          status: "ambiguous",
          nextAttemptAt: new Date(this.#deps.now().getTime() + 300_000).toISOString(),
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: "outcome still unknown; requires authorized reconciliation",
        });
        report.ambiguousStillUnknown += 1;
      } catch (error) {
        report.issues.push(
          `ambiguous delivery ${row.effectKey} could not be reconciled: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async #findRunByStartIntent(
    runtime: NonNullable<BridgeDeps["runtime"]>,
    actor: ActorAssertion,
    scope: Scope,
    startIntentId: string,
  ): Promise<{
    runId: string;
    workOrderId: string;
    graphId: string;
    graphVersion: number;
    entrypoint: string;
    pins: Record<string, string>;
  } | null> {
    if (startIntentId.length === 0) return null;
    const response = await runtime.listRuns(actor, scope, { limit: 200 });
    const runs = Array.isArray(response.runs) ? response.runs : [];
    for (const run of runs) {
      const pins = run.pins ?? {};
      if (pins["startIntentId"] === startIntentId) {
        return {
          runId: run.runId,
          workOrderId: run.workOrderId,
          graphId: run.graphId,
          graphVersion: run.graphVersion,
          entrypoint: run.entrypoint,
          pins,
        };
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Work units
  // -------------------------------------------------------------------------

  /**
   * Re-derive each child issue from the host.
   *
   * A missing child is re-materialized through the normal `ensureWorkUnit` path, which is
   * idempotent, so a reconciliation never doubles a work unit. A status that drifted from the
   * last projection is counted as a `reconcileMismatch` and re-projected from the Core's
   * snapshot rather than from the board.
   */
  async #reconcileWorkUnits(companyId: string, report: MutableReport): Promise<void> {
    const { ctx, store, logger } = this.#deps;
    const rows = store.listBindings(companyId, WORK_UNIT_BINDING_KIND, 200);
    for (const row of rows) {
      const payload = safeJson(row.payloadJson);
      const issueId = String(payload["issueId"] ?? "");
      if (issueId.length === 0) continue;
      report.workUnitsChecked += 1;
      const issue = await ctx.issues.get(issueId, companyId);
      if (!issue) {
        report.workUnitsRematerialized += 1;
        this.#deps.metrics.bump(companyId, "reconcileMismatch");
        logger.warn("a recorded work unit no longer exists; it will be re-materialized on the next dispatch", {
          issueId,
          runId: payload["runId"],
        });
        store.putBinding({
          companyId,
          kind: WORK_UNIT_BINDING_KIND,
          providerId: row.providerId,
          projectId: row.projectId,
          payload: { ...payload, issueId: "", missingSince: this.#deps.now().toISOString() },
        });
        continue;
      }
      if (issue.companyId !== companyId) {
        this.#deps.metrics.bump(companyId, "crossScopeDenials");
        report.issues.push(`work unit ${issueId} resolved into another company`);
        continue;
      }
      const lastProjected = store.getCompat<string | null>(companyId, `projected-status/${issueId}`, null);
      if (lastProjected !== null && lastProjected !== issue.status) {
        report.projectionsReapplied += 1;
        this.#deps.metrics.bump(companyId, "reconcileMismatch");
        logger.info("issue status drifted from the last projection; the Core snapshot will re-project it", {
          issueId,
          boardStatus: issue.status,
          lastProjected,
        });
        store.setCompat(companyId, `projected-status/${issueId}`, issue.status);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Governance
  // -------------------------------------------------------------------------

  /**
   * Re-read each governance carrier and, when a *verified* resolution exists, hand it to the
   * Core.
   *
   * `verifiedAgainstProvider` is copied straight from the port's re-read. An unverified
   * resolution is not recorded at all: the Core would have to treat it as advisory, and
   * recording an advisory resolution as a fact is the mistake this whole path exists to
   * prevent.
   */
  async #reconcileGovernance(companyId: string, report: MutableReport): Promise<void> {
    const { store, logger } = this.#deps;
    const governance = this.#deps.ports().governance;
    const runtime = this.#deps.runtime;
    const rows = store.listBindings(companyId, INTERACTION_BINDING_KIND, 200);
    for (const row of rows) {
      const payload = safeJson(row.payloadJson);
      if (payload["resolvedVerified"] === true) continue;
      // The ref must be the *binding's* provider id — the Core's governance request id — not the
      // interaction id. `readVerifiedResolution` looks the binding up by that id, so using the
      // interaction id here would find nothing and a resolved human decision would never reach
      // the Core after a restart.
      const ref = providerRef("issue_interaction", row.providerId);
      const interactionId = String(payload["interactionId"] ?? "");
      const resolution = await governance.readVerifiedResolution(ref);
      if (resolution === null) continue;
      report.governanceObserved += 1;
      logger.info("a governance carrier was resolved; recording it for the Core", {
        governanceRequestId: ref.id,
        interactionId,
        outcome: resolution.outcome,
        targetHashVerified: resolution.targetHashVerified,
        responderKind: resolution.responderKind,
      });
      if (!resolution.targetHashVerified) continue;
      // A `human_only` carrier that an agent somehow answered is a host violation. The bridge
      // refuses to hand it to the Core as a decision: AT-12's author-cannot-self-approve rule
      // has to hold on the bridge's side too, not only in the server's resolver.
      if (resolution.responderKind !== "human") {
        report.issues.push(
          `governance ${ref.id} was resolved by ${resolution.responderKind}, not a human; not recorded as a decision`,
        );
        logger.error("refusing to record a non-human resolution for a human_only carrier", {
          governanceRequestId: ref.id,
          responderKind: resolution.responderKind,
          responderSubject: resolution.responderSubject,
        });
        continue;
      }
      const transitionHash = String(payload["transitionHash"] ?? "");
      const runId = String(payload["runId"] ?? "");
      if (runtime === null || runId.length === 0 || transitionHash.length === 0) {
        report.issues.push(`governance ${ref.id} is verified but the run binding is incomplete`);
        continue;
      }
      const scope: Scope = { companyRef: companyId, projectRef: row.projectId };
      const effectKey = `pf.governance-resolution:${ref.id}`;
      const enqueued = this.#deps.deliveries.begin({
        effectKey,
        kind: INTENT_KINDS.governanceRecordResolution,
        scope,
        correlationId: String(payload["correlationId"] ?? runId),
        runId,
        payload: {
          requestId: String(payload["requestId"] ?? effectKey),
          resolution: {
            responderSubject: resolution.responderSubject,
            responderKind: resolution.responderKind,
            outcome: resolution.outcome,
            verifiedAgainstProvider: true,
            detail: resolution.detail,
            recordedAt: resolution.recordedAt,
          },
        },
      });
      if (!enqueued) continue;
    }
  }

  // -------------------------------------------------------------------------
  // Authorizations
  // -------------------------------------------------------------------------

  /**
   * Re-check every recorded authorization against the exact action it was granted for.
   *
   * A grant that has since expired, been revoked, or no longer covers the requested inputs is
   * reported so the Core can block the node. Re-checking on a timer is the only way an expiry
   * noticed between admission and commit still blocks (AT-14).
   */
  async #reconcileAuthorizations(companyId: string, report: MutableReport): Promise<void> {
    const { store, logger } = this.#deps;
    const governance = this.#deps.ports().governance;
    const rows = store.listBindings(companyId, AUTHORIZATION_BINDING_KIND, 200);
    for (const row of rows) {
      const payload = safeJson(row.payloadJson);
      const approvalId = typeof payload["approvalId"] === "string" ? payload["approvalId"] : null;
      if (approvalId === null) continue;
      const ref = providerRef("approval", approvalId);
      const status = await governance.checkAuthorization(ref, {
        action: String(payload["action"] ?? ""),
        resource: String(payload["resource"] ?? ""),
        environment: String(payload["environment"] ?? ""),
        inputHashes: (payload["inputHashes"] as Record<string, string>) ?? {},
        transitionHash: String(payload["transitionHash"] ?? ""),
      });
      report.authorizationsChecked += 1;
      const previous = String(payload["lastKnownGranted"] ?? "");
      const nowGranted = status.granted ? "granted" : "denied";
      if (previous !== nowGranted) {
        this.#deps.metrics.bump(companyId, "reconcileMismatch");
        logger.info("an authorization's grant state changed", {
          approvalId,
          was: previous.length > 0 ? previous : "unknown",
          now: nowGranted,
          reason: status.reason,
        });
        // A grant that lapsed between admission and commit has to reach the Core as well as the
        // log. Without this the node would keep executing on an authorization that stopped being
        // valid, and the only evidence would be a debug line nobody reads.
        if (nowGranted === "denied") {
          report.issues.push(
            `authorization ${approvalId} for ${String(payload["action"] ?? "")} is no longer valid: ${status.reason}`,
          );
          const effectKey = `pf.authorization-check:${companyId}:${approvalId}:${status.reason.length}`;
          this.#deps.deliveries.begin({
            effectKey,
            kind: INTENT_KINDS.authorizationCheck,
            scope: { companyRef: companyId, projectRef: row.projectId },
            correlationId: String(payload["transitionHash"] ?? approvalId),
            payload: {
              approvalRef: { provider: "paperclip", kind: "approval", id: approvalId },
              action: {
                action: String(payload["action"] ?? ""),
                resource: String(payload["resource"] ?? ""),
                environment: String(payload["environment"] ?? ""),
                inputHashes: (payload["inputHashes"] as Record<string, string>) ?? {},
                transitionHash: String(payload["transitionHash"] ?? ""),
              },
              result: { granted: false, reason: status.reason, revoked: status.revoked, expiresAt: status.expiresAt },
            },
          });
        }
      }
      store.putBinding({
        companyId,
        kind: AUTHORIZATION_BINDING_KIND,
        providerId: row.providerId,
        projectId: row.projectId,
        payload: { ...payload, lastKnownGranted: nowGranted, lastReason: status.reason },
        revision: nowGranted,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Run pins
  // -------------------------------------------------------------------------

  /**
   * Record the pin each run started under, and report any that moves.
   *
   * A pin is what makes an in-flight run reproducible: publishing and activating a new graph
   * version must not change the work a running graph is doing. The Core owns the pin, so the
   * bridge's job is to *remember* what it was and to notice when it changes — a pin that moves
   * under a live run is a semantic change to work already in flight, and it has to be surfaced
   * rather than accepted by overwriting the record.
   */
  async #reconcileRunPins(companyId: string, report: MutableReport): Promise<void> {
    const { store, logger, metrics } = this.#deps;
    const runtime = this.#deps.runtime;
    if (runtime === null) return;
    for (const row of store.listBindings(companyId, RUN_BINDING_KIND, 200)) {
      const payload = safeJson(row.payloadJson);
      const runId = String(payload["runId"] ?? row.providerId);
      if (runId.length === 0) continue;
      let snapshot: Record<string, unknown>;
      try {
        const read = await runtime.getRun(
          { actorType: "system", actorId: "polyforge-bridge", agentId: null, runId: null, roles: [] },
          { companyRef: companyId, projectRef: row.projectId },
          runId,
        );
        snapshot = read as unknown as Record<string, unknown>;
      } catch {
        // The Core is unreachable. Leaving the recorded pin alone is the correct answer: an
        // unread pin is not a moved pin.
        continue;
      }
      const pins =
        typeof snapshot["pins"] === "object" && snapshot["pins"] !== null
          ? (snapshot["pins"] as Record<string, unknown>)
          : {};
      const graphVersion = typeof snapshot["graphVersion"] === "number" ? snapshot["graphVersion"] : null;
      const recorded = payload["pins"];
      if (recorded === undefined) {
        store.putBinding({
          companyId,
          kind: RUN_BINDING_KIND,
          providerId: row.providerId,
          projectId: row.projectId,
          payload: { ...payload, pins, graphVersion, pinObservedAt: this.#deps.now().toISOString() },
        });
        continue;
      }
      const before = recorded as Record<string, unknown>;
      const moved = Object.keys(pins).filter((key) => String(pins[key]) !== String(before[key]));
      if (moved.length === 0) continue;
      metrics.bump(companyId, "reconcileMismatch");
      const message = `run ${runId} pin moved (${moved.join(", ")}): ${canonicalJson(before)} -> ${canonicalJson(pins)}`;
      report.issues.push(message);
      logger.error("a live run's graph pin changed under it", { runId, moved, before, now: pins });
    }
  }

  // -------------------------------------------------------------------------
  // Dead letters
  // -------------------------------------------------------------------------

  /**
   * Put permanently failed intents on the record, once.
   *
   * A dead letter is the one delivery state that will never resolve itself, so a report that omits
   * it makes abandoned work indistinguishable from work that quietly stopped happening. Each is
   * reported the first time it is seen and then remembered in `compatibility_state`, so a
   * permanently broken intent does not fill every report with the same line.
   */
  #reportDeadLetters(companyId: string, report: MutableReport): void {
    const { store, logger } = this.#deps;
    for (const row of store.listDeliveries(companyId, ["failed"], 200)) {
      const seenKey = `dead-letter-reported/${row.effectKey}`;
      if (store.getCompat<boolean>(companyId, seenKey, false) === true) continue;
      store.setCompat(companyId, seenKey, true);
      const message = `dead letter ${row.kind} ${row.effectKey} failed permanently: ${row.lastError ?? "unknown reason"}`;
      report.issues.push(message);
      logger.error("a delivery intent will never be retried and needs a human", {
        effectKey: row.effectKey,
        kind: row.kind,
        attempts: row.attempts,
        lastError: row.lastError,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Executions
  // -------------------------------------------------------------------------

  /**
   * Inspect every dispatched execution and record the observation.
   *
   * The observation goes into the store so an operator can see *what the platform last said*,
   * and into the Core as an `execution.inspect` intent so the Core can move an attempt out of
   * `UNKNOWN` when — and only when — the platform authoritatively reports a terminal state.
   * A still-unknown execution increments `unknownAttempts` and is left alone.
   */
  async #reconcileExecutions(companyId: string, report: MutableReport): Promise<void> {
    const { store, logger, metrics } = this.#deps;
    const work = this.#deps.ports().work;
    const rows = store.listBindings(companyId, DISPATCH_BINDING_KIND, 200);
    for (const row of rows) {
      const payload = safeJson(row.payloadJson);
      const ref = dispatchRef(payload);
      if (ref === null) continue;
      const observation = await work.inspectExecution(ref);
      report.executionsInspected += 1;
      store.putBinding({
        companyId,
        kind: DISPATCH_BINDING_KIND,
        providerId: row.providerId,
        projectId: row.projectId,
        payload: {
          ...payload,
          lastObservation: {
            state: observation.state,
            exitReason: observation.exitReason,
            finishedAt: observation.finishedAt,
            observedAt: this.#deps.now().toISOString(),
          },
        },
      });
      if (observation.state === "unknown") {
        report.executionsStillUnknown += 1;
        metrics.bump(companyId, "unknownAttempts");
        logger.warn("an execution is still unknown after reconciliation; not retrying", {
          runId: payload["runId"],
          nodeId: payload["nodeId"],
        });
        continue;
      }
      this.#deps.deliveries.begin({
        effectKey: `pf.execution-inspect:${companyId}:${row.providerId}:${observation.state}:${observation.finishedAt ?? ""}`,
        kind: INTENT_KINDS.executionInspect,
        scope: { companyRef: companyId, projectRef: row.projectId },
        correlationId: String(payload["runId"] ?? ""),
        runId: String(payload["runId"] ?? ""),
        nodeId: String(payload["nodeId"] ?? ""),
        payload: {
          ref,
          state: observation.state,
          exitReason: observation.exitReason,
          startedAt: observation.startedAt,
          finishedAt: observation.finishedAt,
          artifacts: observation.artifacts,
          // The observation is explicitly not a pass. The Core evaluates evidence.
          observationOnly: true,
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Inbox replay
  // -------------------------------------------------------------------------

  /**
   * Re-normalize inbox rows that were recorded but never handed onward.
   *
   * Only possible when the worker died between the inbox write and the outbox write. Because
   * the two writes are one store transaction in `handle`, this is a narrow window, and the
   * effect key dedupes anyway — so the worst case is a duplicate intake the Core ignores.
   */
  #replayInbox(companyId: string, report: MutableReport): void {
    const { inbox, store, logger } = this.#deps;
    const rows = inbox.pendingReplay(companyId, 100);
    for (const row of rows) {
      if (row.eventType.length === 0) continue;
      logger.info("replaying an inbox row that was never handed to the Core", {
        eventType: row.eventType,
        sourceEventId: row.sourceEventId,
      });
      store.updateInboxStatus("paperclip", companyId, row.sourceEventId, "ignored", {
        error: "replayed by reconciliation; the normalized form is already durable in the inbox row",
      });
      report.inboxReplayed += 1;
    }
  }
}

interface MutableReport {
  ambiguousResolved: number;
  ambiguousStillUnknown: number;
  workUnitsChecked: number;
  workUnitsRematerialized: number;
  projectionsReapplied: number;
  executionsInspected: number;
  executionsStillUnknown: number;
  governanceObserved: number;
  authorizationsChecked: number;
  inboxReplayed: number;
  issues: string[];
}

function dispatchRef(payload: Record<string, unknown>): ProviderRefLike | null {
  const runId = payload["agentRunRefId"];
  if (typeof runId === "string" && runId.length > 0) return providerRef("agent_run", runId);
  const issueId = payload["issueId"];
  if (typeof issueId === "string" && issueId.length > 0) return providerRef("issue", issueId);
  return null;
}

function safeJson(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
