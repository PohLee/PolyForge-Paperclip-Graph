/**
 * Runtime migration: plan, review, commit.
 *
 * A migration is the one operation that changes the structure *underneath* a live run, so it is
 * gated on three independent things and the panel says which of them is missing rather than
 * simply disabling a button:
 *
 * 1. a **reviewed plan** — a `planHash` the human has read, together with the node mapping, the
 *    invalidations, and the pending governance that will have to be answered again;
 * 2. **quiescence** — no running node, no live worker lease, no `UNKNOWN` external effect, and
 *    the message watermark reconciled;
 * 3. a **compare-and-swap** on the source `stateVersion`, so a plan built against one state cannot
 *    be committed onto a state that has moved.
 *
 * The preview is read-only. Planning a migration never changes anything, and a preview that
 * arrives unreadable is treated as *not* quiescent: an unparseable answer must never enable a
 * commit.
 */

import { useMemo, useState, type ReactNode } from "react";
import type { MigrationPreview, RunSnapshot } from "@polyforge/protocol";
import { oneLine } from "../format.js";
import type { ActionResult, BridgeFailure } from "../hooks/usePolyForge.js";
import { FailureNotice } from "./BridgeState.js";
import { Pill } from "./Identifiers.js";
import { Grid, Row, Stack } from "./Layout.js";
import { Modal } from "./Primitives.js";
import { StatusToken } from "./StatusToken.js";

export interface MigrationPanelProps {
  runId: string;
  snapshot: RunSnapshot | null;
  preview: MigrationPreview | null;
  previewLoading: boolean;
  previewFailure: BridgeFailure | null;
  /** Versions a migration could target. Published and active only; drafts are not targets. */
  targetVersions: ReadonlyArray<number>;
  targetGraphVersion: number | null;
  onTargetChange: (version: number) => void;
  onPlan: (params: { runId: string; targetGraphVersion: number }) => Promise<ActionResult<unknown>>;
  onCommit: (params: {
    runId: string;
    planHash: string;
    expectedStateVersion: number;
  }) => Promise<ActionResult<unknown>>;
  busy: boolean;
  onApplied: (summary: string) => void;
}

export function MigrationPanel(props: MigrationPanelProps): ReactNode {
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<ActionResult<unknown> | null>(null);
  const [error, setError] = useState<ActionResult<unknown> | null>(null);

  const preview = props.preview;
  const stalePlan =
    preview !== null && props.snapshot !== null && preview.sourceGraphVersion !== props.snapshot.graphVersion;

  const gate = useMemo(() => buildGate(preview, props.snapshot, acknowledged, stalePlan), [
    preview,
    props.snapshot,
    acknowledged,
    stalePlan,
  ]);

  const commit = async () => {
    if (preview === null || props.snapshot === null) return;
    setError(null);
    const result = await props.onCommit({
      runId: props.runId,
      planHash: preview.planHash,
      expectedStateVersion: props.snapshot.stateVersion,
    });
    setConfirming(false);
    setOutcome(result);
    if (result.ok) props.onApplied(`committed migration ${preview.planHash}`);
  };

  return (
    <Stack gap={8}>
      <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>
        Migrating a live run is rare and always explicit. It never happens as a side effect of
        publishing: the default version moving is a different operation and never rewrites a run
        that already pinned its own closure.
      </p>
      <MigrationExplainer />

      <Grid minColumnWidth={220}>
        <Stack gap={4}>
          <Caption>Source</Caption>
          <span style={{ fontSize: 12 }}>
            {props.snapshot === null
              ? "not yet read from the Core"
              : `version ${props.snapshot.graphVersion} at state version ${props.snapshot.stateVersion}`}
          </span>
          <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
            the plan is a compare-and-swap against that state version
          </span>
        </Stack>
        <Stack gap={4}>
          <Caption>Target</Caption>
          <label htmlFor="pf-migration-target" style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "baseline" }}>
            published version
            <select
              id="pf-migration-target"
              value={props.targetGraphVersion ?? ""}
              onChange={(event) => {
                const raw = event.target.value;
                props.onTargetChange(raw === "" ? 0 : Number(raw));
                setAcknowledged(false);
              }}
              style={{ fontSize: 12 }}
            >
              <option value="">(choose a target)</option>
              {props.targetVersions.map((version) => (
                <option key={version} value={version}>
                  v{version}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={props.busy || props.targetGraphVersion === null}
            onClick={() => {
              if (props.targetGraphVersion === null) return;
              void props.onPlan({ runId: props.runId, targetGraphVersion: props.targetGraphVersion });
            }}
          >
            Compute a dry-run plan
          </button>
          <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
            Planning is read-only. It changes nothing, which is the point: you read the plan before
            anything moves.
          </span>
        </Stack>
      </Grid>

      {props.previewFailure === null ? null : <FailureNotice failure={props.previewFailure} />}
      {props.previewLoading ? (
        <p role="status" style={{ margin: 0, fontSize: 12 }}>
          Computing the plan…
        </p>
      ) : null}

      {preview === null ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>
          No plan has been computed for this target. Without a plan there is no `planHash` to review
          and nothing to commit.
        </p>
      ) : (
        <PlanBody preview={preview} />
      )}

      {preview === null ? null : (
        <>
          <label style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 12 }}>
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={!gate.canAcknowledge}
              onChange={(event) => setAcknowledged(event.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              I have read this plan for <code>{preview.planHash}</code>, including its node mapping
              and invalidations, and I am the person accountable for the outcome.
            </span>
          </label>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, display: "grid", gap: 2 }}>
            {gate.checks.map((check) => (
              <li key={check.id}>
                <Row gap={4} align="baseline">
                  <strong style={{ fontSize: 12 }}>{check.label}:</strong>
                  <span style={{ color: check.ok ? "var(--pf-muted, #6b7280)" : "var(--pf-warn, #fbbf24)" }}>
                    {check.detail}
                  </span>
                </Row>
              </li>
            ))}
          </ul>
          <div>
            <button
              type="button"
              disabled={!gate.canCommit || props.busy}
              onClick={() => setConfirming(true)}
            >
              Commit the migration
            </button>
            {!gate.canCommit ? (
              <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)", marginLeft: 8 }}>
                Every condition above must be satisfied. The server checks all of them again.
              </span>
            ) : null}
          </div>
        </>
      )}

      {error === null || error.ok ? null : <FailureNotice failure={error.failure} />}
      {outcome === null ? null : (
        <p role="status" style={{ margin: 0, fontSize: 12 }}>
          {outcome.ok
            ? `The server accepted the commit. The successor run is created from the plan; the source run becomes superseded and is not deleted. Re-read the snapshot to see the lineage.`
            : "The server refused the commit."}
        </p>
      )}

      {confirming && preview !== null ? (
        <Modal
          title="Commit this migration"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button type="button" onClick={() => void commit()} disabled={props.busy}>
                Commit
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          }
        >
          <p style={{ margin: 0, fontSize: 12 }}>
            This creates a successor run from <code>{preview.planHash}</code>, fences the source run,
            and keeps the lineage. The source run is <strong>superseded, not deleted</strong>, and its
            history and already-executed external effects stay on the record.
          </p>
          <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>
            The commit is a compare-and-swap on state version{" "}
            {props.snapshot?.stateVersion ?? "unknown"}. If the source has moved since the plan was
            made, the server refuses and the plan has to be recomputed.
          </p>
        </Modal>
      ) : null}
    </Stack>
  );
}

function PlanBody(props: { preview: MigrationPreview }): ReactNode {
  const { preview } = props;
  return (
    <Stack gap={6}>
      <Row gap={6} align="baseline">
        <Pill>plan {preview.planHash}</Pill>
        <Pill>
          v{preview.sourceGraphVersion} → v{preview.targetGraphVersion}
        </Pill>
        <Pill tone={preview.quiescent ? "default" : "problem"}>
          {preview.quiescent ? "quiescent" : "not quiescent"}
        </Pill>
        {preview.invalidations.length > 0 ? (
          <Pill tone="warning">
            {preview.invalidations.length} invalidation(s) — recorded PASSes are not inherited
          </Pill>
        ) : null}
      </Row>

      {preview.quiescent ? null : (
        <p style={{ margin: 0, fontSize: 12, color: "var(--pf-danger, #f87171)" }}>
          <strong>This run is not quiescent.</strong> A migration may only be committed at a
          checkpoint with no running node, no live worker lease, and no external effect whose
          outcome is unknown. The blockers are listed below.
        </p>
      )}

      {preview.blockers.length === 0 ? null : (
        <div>
          <strong style={{ fontSize: 12 }}>Blockers</strong>
          <ul style={{ margin: "2px 0 0", paddingLeft: 18, fontSize: 12 }}>
            {preview.blockers.map((blocker) => (
              <li key={`${blocker.code}:${blocker.reason}`}>
                <StatusToken status={blocker.reason} family="block" hideSource />
                <span style={{ marginLeft: 6 }}>{oneLine(blocker.message)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <strong style={{ fontSize: 12 }}>Node mapping ({preview.nodeMapping.length})</strong>
        {preview.nodeMapping.length === 0 ? (
          <p style={{ margin: "2px 0 0", fontSize: 12 }}>
            No node mapping was produced. A migration with no mapping is refused rather than guessed:
            an unmapped node would either lose its state or silently adopt another node's.
          </p>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                <th scope="col" style={{ textAlign: "left" }}>
                  from
                </th>
                <th scope="col" style={{ textAlign: "left" }}>
                  to
                </th>
                <th scope="col" style={{ textAlign: "left" }}>
                  state action
                </th>
              </tr>
            </thead>
            <tbody>
              {preview.nodeMapping.map((entry) => (
                <tr key={`${entry.from}->${entry.to}`}>
                  <td>
                    <code>{entry.from}</code>
                  </td>
                  <td>
                    <code>{entry.to}</code>
                  </td>
                  <td>{entry.stateAction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <strong style={{ fontSize: 12 }}>Invalidations ({preview.invalidations.length})</strong>
        {preview.invalidations.length === 0 ? (
          <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>
            Nothing is invalidated. Unchanged, re-validated evidence may be reused.
          </p>
        ) : (
          <ul style={{ margin: "2px 0 0", paddingLeft: 18, fontSize: 12 }}>
            {preview.invalidations.map((entry) => (
              <li key={`${entry.kind}:${entry.detail}`}>
                <Pill tone="warning">{entry.kind}</Pill> <span style={{ marginLeft: 6 }}>{oneLine(entry.detail)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <strong style={{ fontSize: 12 }}>
          Governance that must be answered again ({preview.pendingGovernance.length})
        </strong>
        {preview.pendingGovernance.length === 0 ? (
          <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>
            No outstanding decision is carried across.
          </p>
        ) : (
          <ul style={{ margin: "2px 0 0", paddingLeft: 18, fontSize: 12 }}>
            {preview.pendingGovernance.map((request) => (
              <li key={request.requestId}>
                node <code>{request.nodeId}</code> · {request.semanticKind} · request{" "}
                <code>{request.requestId}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Stack>
  );
}

interface GateCheck {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

function buildGate(
  preview: MigrationPreview | null,
  snapshot: RunSnapshot | null,
  acknowledged: boolean,
  stalePlan: boolean,
): { canAcknowledge: boolean; canCommit: boolean; checks: GateCheck[] } {
  const hasPlan = preview !== null;
  const hasMapping = preview !== null && preview.nodeMapping.length > 0;
  const quiescent = preview !== null && preview.quiescent;
  const noBlockers = preview !== null && preview.blockers.length === 0;
  const freshSource = hasPlan && !stalePlan && snapshot !== null;
  const checked = acknowledged;
  const checks: GateCheck[] = [
    {
      id: "plan",
      label: "a plan exists",
      ok: hasPlan,
      detail: hasPlan ? "computed" : "compute a dry-run plan first",
    },
    {
      id: "mapping",
      label: "every node is mapped",
      ok: hasMapping,
      detail: hasMapping
        ? `${preview?.nodeMapping.length ?? 0} node(s) mapped`
        : "an unmapped node would lose its state; the server refuses an empty mapping",
    },
    {
      id: "quiescent",
      label: "the run is quiescent",
      ok: quiescent,
      detail: quiescent ? "no running node, no live lease, no unknown effect" : "not quiescent",
    },
    {
      id: "blockers",
      label: "no blockers on the plan",
      ok: noBlockers,
      detail: noBlockers ? "none recorded" : `${preview?.blockers.length ?? 0} blocker(s) recorded`,
    },
    {
      id: "fresh",
      label: "the plan is against the current source state",
      ok: freshSource,
      detail: freshSource
        ? `state version ${snapshot?.stateVersion ?? "unknown"}`
        : "the source has moved since the plan was computed; recompute it",
    },
    {
      id: "acknowledged",
      label: "a person has read and accepted the plan",
      ok: checked,
      detail: checked ? "recorded in this session" : "tick the acknowledgement above",
    },
  ];
  return {
    canAcknowledge: hasPlan && hasMapping && quiescent && noBlockers && freshSource,
    canCommit: checks.every((check) => check.ok),
    checks,
  };
}

function Caption(props: { children: ReactNode }): ReactNode {
  return (
    <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--pf-muted, #6b7280)" }}>
      {props.children}
    </span>
  );
}

/** A note rendered next to the version default in the library, explaining the pin semantics. */
export function ActivationNotice(props: { graphId: string; version: number }): ReactNode {
  return (
    <p style={{ margin: 0, fontSize: 12 }}>
      Activating <code>{props.graphId}</code> v{props.version} changes what{" "}
      <strong>future</strong> runs adopt. It does not touch any run that already started: every run
      pins its own version closure at creation and keeps it. Nothing here restarts, rewrites, or
      re-plans a running instance.
    </p>
  );
}

export function MigrationExplainer(): ReactNode {
  return (
    <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>
      A migrated run keeps its history: the source becomes superseded rather than deleted, and effects
      it already performed stay on the ledger. Recovery backwards is only possible when the successor
      produced no new external effect.
    </p>
  );
}
