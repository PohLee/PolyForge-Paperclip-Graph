/**
 * Health: the honest version.
 *
 * Two rules govern this section. First, a system that is not `ready` is described in words,
 * with the specific thing that is blocked, and never rendered with a green badge because its
 * *counters* happen to look fine — a degraded bridge with zero recorded denials is still degraded.
 * Second, `null` in a counter means the Core could not compute the gauge, and that renders as
 * "not reported" rather than as `0`, because a zero gauge and a missing gauge are different
 * facts and only one of them is good news.
 *
 * A missing capability, a lost connection, and an incompatible host version are three separate
 * lines here, not one "error".
 */

import type { ReactNode } from "react";
import type { HealthData } from "@polyforge/protocol";
import { formatAgeSeconds, formatInstantPair, oneLine } from "../format.js";
import { useHealth, useRefresh, type PolyForgeQuery } from "../hooks/usePolyForge.js";
import { STATUS_SOURCE_LOCAL } from "../theme.js";
import { QueryBoundary } from "../components/BridgeState.js";
import { DataGrid, type GridColumn } from "../components/Primitives.js";
import { LiveRegion, Pill, useAnnouncer } from "../components/Identifiers.js";
import { Grid, Panel, Row, Stack } from "../components/Layout.js";
import { StatusToken } from "../components/StatusToken.js";
import { StatusLegend } from "../components/StatusLegend.js";

/** Counters where a non-zero value is an operational problem worth surfacing first. */
const PROBLEM_COUNTERS: ReadonlySet<keyof HealthData["counters"]> = new Set([
  "schemaQuarantine",
  "reconcileMismatch",
  "unknownAttempts",
  "gateMissingEvidence",
  "budgetBlocks",
  "platformBlocks",
  "workspaceValidationFailures",
  "artifactDigestMismatch",
  "crossScopeDenials",
]);

/** Counters where a non-zero value is evidence the system is working. */
const HEALTHY_COUNTERS: ReadonlySet<keyof HealthData["counters"]> = new Set([
  "inboxDuplicates",
  "staleLeaseRejected",
  "duplicateEffectsPrevented",
]);

const COUNTER_LABELS: Readonly<Record<keyof HealthData["counters"], string>> = {
  inboxDuplicates: "Inbox duplicates suppressed",
  schemaQuarantine: "Events quarantined for an unknown schema",
  outboxOldestAgeSeconds: "Oldest queued outbox intent",
  projectionLagSeconds: "Board projection lag",
  reconcileMismatch: "Reconcile mismatches",
  unknownAttempts: "Attempts with an unknown outcome",
  staleLeaseRejected: "Stale leases rejected",
  duplicateEffectsPrevented: "Duplicate external effects prevented",
  waitingGovernanceOldestAgeSeconds: "Oldest waiting governance request",
  gateMissingEvidence: "Gates that found missing evidence",
  budgetBlocks: "Budget blocks",
  platformBlocks: "Platform blocks",
  workspaceValidationFailures: "Workspace validation failures",
  artifactDigestMismatch: "Artifact digest mismatches",
  crossScopeDenials: "Cross-scope denials",
  unknownCoreIntentKinds: "Core intents with no bridge equivalent",
  coreOutboxEnqueueFailed: "Core intents that could not be made durable",
  coreOutboxAckFailed: "Core intent acknowledgements that failed",
  controlPlaneUnavailable: "Passes that could not reach the Core",
};

const GAUGE_COUNTERS: ReadonlySet<keyof HealthData["counters"]> = new Set([
  "outboxOldestAgeSeconds",
  "projectionLagSeconds",
  "waitingGovernanceOldestAgeSeconds",
]);

export function HealthSection(): ReactNode {
  const health = useHealth();
  const refresh = useRefresh();
  const { message, announce } = useAnnouncer();

  return (
    <Stack gap={12}>
      <Panel
        id="health-overview"
        title="Integration health"
        description="Readiness of the bridge, the Runtime Service, and the required capabilities. Computed by the worker from its own stored counters."
        aside={
          <button
            type="button"
            onClick={() => {
              announce("Re-reading health…");
              void refresh.run({}).then((outcome) => {
                announce(
                  outcome.ok
                    ? "Health re-read. The counters below are from the latest read."
                    : `Health re-read failed: ${outcome.failure.message}`,
                );
                health.refresh();
              });
            }}
          >
            Re-read
          </button>
        }
      >
        <QueryBoundary query={health} empty="no health document has been produced yet" loadingLabel="Reading integration health">
          {(data) => <HealthBody data={data} />}
        </QueryBoundary>
        <LiveRegion message={message} label="Health re-read result" />
      </Panel>

      <StatusLegend defaultOpen={false} />
    </Stack>
  );
}

function HealthBody(props: { data: HealthData }): ReactNode {
  const { data } = props;
  const ready = data.status === "ready";
  return (
    <Stack gap={12}>
      <Row gap={8} align="baseline">
        <StatusToken
          status={data.status}
          family="health"
          source={STATUS_SOURCE_LOCAL}
          qualifier="the worker's own readiness computation"
        />
        <Pill>checked {formatInstantPair(data.checkedAt)}</Pill>
      </Row>

      {ready ? null : <DegradedExplanation data={data} />}

      <Grid minColumnWidth={260}>
        <Panel id="health-runtime" title="Runtime Service" tone={data.runtime.reachable ? "default" : "problem"}>
          <Stack gap={4}>
            <Line label="reachable" value={data.runtime.reachable ? "yes" : "no"} tone={data.runtime.reachable ? "default" : "problem"} />
            <Line label="reported status" value={data.runtime.status} />
            <Line label="protocol version" value={data.runtime.protocolVersion === null ? "not reported" : String(data.runtime.protocolVersion)} />
            <Line label="schema version" value={data.runtime.schemaVersion === null ? "not reported" : String(data.runtime.schemaVersion)} />
            <Line label="compiler version" value={data.runtime.compilerVersion} />
            {data.runtime.detail === null ? null : (
              <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--pf-danger, #f87171)" }}>{oneLine(data.runtime.detail)}</p>
            )}
          </Stack>
        </Panel>

        <Panel
          id="health-host"
          title="Host"
          tone={data.host.compatible ? "default" : "problem"}
        >
          <Stack gap={4}>
            <Line
              label="server version"
              value={data.host.serverVersion}
              unknown="the plugin SDK does not expose the host server version"
            />
            <Line label="compatible" value={data.host.compatible ? "yes" : "no"} tone={data.host.compatible ? "default" : "problem"} />
            {data.host.detail === null ? null : (
              <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>{oneLine(data.host.detail)}</p>
            )}
            <p style={{ margin: "4px 0 0", fontSize: 12 }}>
              Version compatibility is decided at install time against the manifest&apos;s{" "}
              <code>minimumHostVersion</code>. A plugin that installs is compatible; a plugin that will not
              install never reaches this screen.
            </p>
          </Stack>
        </Panel>
      </Grid>

      <Panel
        id="health-issues"
        title="Current issues"
        tone={data.issues.length === 0 ? "default" : "problem"}
        description="Everything an operator has to act on. An empty list means the worker recorded nothing; it does not mean the system was proven correct."
      >
        {data.issues.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12 }}>
            The worker recorded no issue at this reading. That is an absence of reported problems, not
            a proof that there are none.
          </p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, display: "grid", gap: 4 }}>
            {data.issues.map((issue) => (
              <li key={issue}>
                <Row gap={6} align="baseline">
                  <Pill tone="problem">action needed</Pill>
                  <span>{oneLine(issue)}</span>
                </Row>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel id="health-counters" title="Counters">
        <DataGrid
          caption="counters"
          rows={(Object.keys(COUNTER_LABELS) as Array<keyof HealthData["counters"]>).map((key) => ({
            key,
            value: data.counters[key],
            label: COUNTER_LABELS[key],
          }))}
          columns={COUNTER_COLUMNS as ReadonlyArray<GridColumn<{ key: keyof HealthData["counters"]; value: number | null; label: string }>>}
          emptyMessage="No counters are reported."
        />
      </Panel>
    </Stack>
  );
}

/**
 * The words for "not ready".
 *
 * Each readiness level names what is blocked and who can unblock it, because "degraded" on its own
 * tells an operator nothing about whether they may start a run.
 */
function DegradedExplanation(props: { data: HealthData }): ReactNode {
  const { data } = props;
  const copy: Record<Exclude<HealthData["status"], "ready">, string> = {
    read_only:
      "The bridge cannot persist its own state. Reads of what is already stored still work; no new privileged admission can be recorded. Nothing that depends on a durable write should be started until this clears.",
    degraded:
      "Something in the dependency chain is not working. Treat every derived number on this page as suspect, and do not start new engineering work until it is understood.",
    blocked:
      "The bridge has no usable configuration for this company, or a required capability is missing. Nothing PolyForge reports here can be trusted, because it is not talking to the Runtime Service.",
  };
  return (
    <div
      role="note"
      style={{
        border: "2px solid var(--pf-danger, #f87171)",
        borderRadius: 6,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <strong style={{ fontSize: 13 }}>
        PolyForge is <code>{data.status}</code>, not ready
      </strong>
      <p style={{ margin: 0, fontSize: 12 }}>{copy[data.status as Exclude<HealthData["status"], "ready">]}</p>
      {data.issues.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12 }}>
          The worker recorded no specific cause, only that it is not ready. That is itself the finding:
          the check failed without naming a reason.
        </p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
          {data.issues.map((issue) => (
            <li key={issue}>{oneLine(issue)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One labelled health value.
 *
 * An absent value reads "not reported" and, when the caller knows why, the reason. It never reads
 * `0` or an em dash, because a blank next to a green badge is indistinguishable from a pass.
 */
function Line(props: {
  label: string;
  value: string | null | number;
  tone?: "default" | "problem";
  unknown?: string;
}): ReactNode {
  const missing = props.value === null || props.value === undefined || props.value === "";
  return (
    <Row gap={6} align="baseline">
      <span style={{ fontSize: 12, color: "var(--pf-muted, #6b7280)", minWidth: 130 }}>{props.label}</span>
      {missing ? (
        <span style={{ fontSize: 12, color: "var(--pf-unknown, #94a3b8)" }}>
          not reported
          {props.unknown === undefined ? null : ` — ${props.unknown}`}
        </span>
      ) : (
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: props.tone === "problem" ? "var(--pf-danger, #f87171)" : undefined,
          }}
        >
          {props.value}
        </span>
      )}
    </Row>
  );
}

interface CounterRow {
  readonly key: keyof HealthData["counters"];
  readonly value: number | null;
  readonly label: string;
}

const COUNTER_COLUMNS: ReadonlyArray<GridColumn<CounterRow>> = [
  { key: "label", header: "Counter", render: (row) => row.label },
  {
    key: "value",
    header: "Value",
    render: (row) => {
      if (row.value === null || row.value === undefined) {
        return <StatusToken status={null} family="generic" />;
      }
      const tone = PROBLEM_COUNTERS.has(row.key)
        ? row.value > 0
          ? "problem"
          : "default"
        : HEALTHY_COUNTERS.has(row.key)
          ? row.value > 0
            ? "default"
            : "warning"
          : "default";
      if (GAUGE_COUNTERS.has(row.key)) {
        return (
          <span style={{ fontSize: 12, fontWeight: 600, color: tone === "problem" ? "var(--pf-danger, #f87171)" : undefined }}>
            {formatAgeSeconds(row.value)}
          </span>
        );
      }
      return (
        <span style={{ fontSize: 12, fontWeight: 600, color: tone === "problem" ? "var(--pf-danger, #f87171)" : undefined }}>
          {row.value}
        </span>
      );
    },
  },
  {
    key: "key",
    header: "Meaning",
    width: "40%",
    render: (row) => <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>{counterMeaning(row.key)}</span>,
  },
];

function counterMeaning(key: keyof HealthData["counters"]): string {
  switch (key) {
    case "inboxDuplicates":
      return "A redelivered event was recognised and dropped instead of being applied twice.";
    case "schemaQuarantine":
      return "An event arrived with a schema this build does not know. It is held, not discarded, and not applied.";
    case "outboxOldestAgeSeconds":
      return "Age of the oldest intent waiting to be delivered. A growing value means the bridge is behind.";
    case "projectionLagSeconds":
      return "How far the board projection trails the Core. A large lag makes board columns stale, not wrong.";
    case "reconcileMismatch":
      return "The reconciler found a durable difference between its record and the authoritative object.";
    case "unknownAttempts":
      return "Attempts whose outcome is not known. These are reconciled, never retried.";
    case "staleLeaseRejected":
      return "Writes refused because the presenting lease epoch was stale. A non-zero value here is the system working.";
    case "duplicateEffectsPrevented":
      return "External effects that would have been duplicated and were not. Also the system working.";
    case "waitingGovernanceOldestAgeSeconds":
      return "Age of the longest-outstanding human decision. It measures how long a person has been blocking a run.";
    case "gateMissingEvidence":
      return "Gates that refused because required evidence was absent. The gate did its job.";
    case "budgetBlocks":
      return "Runs stopped by a Paperclip budget. Not a graph decision and not clearable by a retry.";
    case "platformBlocks":
      return "Runs stopped by platform authorization or configuration.";
    case "workspaceValidationFailures":
      return "Executions refused because the workspace drifted, was missing, or was out of scope.";
    case "artifactDigestMismatch":
      return "Registered artifacts whose content hash did not match. Evidence built on these is rejected.";
    case "unknownCoreIntentKinds":
      return "The Core asked for work this build cannot express as a bridge intent. Those intents stay queued and are re-claimed; nothing was dropped. This clears when the mapping covers the kind.";
    case "coreOutboxEnqueueFailed":
      return "A Core intent could not be written to the bridge's durable queue, so the Core still owns it. Check that the store is writable.";
    case "coreOutboxAckFailed":
      return "The Core was not told the outcome of a delivery. Its lease expires and the intent is re-claimed, so this costs an attempt rather than the work.";
    case "controlPlaneUnavailable":
      return "A pass over the Core's queue could not run. Nothing was claimed and nothing was lost; the next pass retries.";
    case "crossScopeDenials":
      return "Calls refused for referencing another company's or project's object. A non-zero value is the isolation working.";
  }
}

/** The compact widget: glanceable, no layout shift, honest when degraded. */
export function HealthSummaryRow(props: { query: PolyForgeQuery<HealthData> }): ReactNode {
  if (props.query.failure !== null) {
    return (
      <Row gap={6} align="baseline">
        <StatusToken status={null} family="health" />
        <span style={{ fontSize: 12 }}>
          health unavailable — {props.query.failure.kind === "not_permitted" ? "not permitted" : props.query.failure.kind === "unreachable" ? "worker unreachable" : "the worker refused"}
        </span>
      </Row>
    );
  }
  if (props.query.data === null) {
    return (
      <Row gap={6} align="baseline" >
        <Pill>reading health…</Pill>
      </Row>
    );
  }
  const data = props.query.data;
  const problems = (Object.keys(COUNTER_LABELS) as Array<keyof HealthData["counters"]>).filter(
    (key) => PROBLEM_COUNTERS.has(key) && (data.counters[key] ?? 0) > 0,
  );
  return (
    <Stack gap={2}>
      <Row gap={6} align="baseline">
        <StatusToken status={data.status} family="health" />
        <Pill>runtime {data.runtime.reachable ? "reachable" : "unreachable"}</Pill>
        <Pill>issues {data.issues.length}</Pill>
        {problems.length === 0 ? null : <Pill tone="problem">{problems.length} counter(s) need attention</Pill>}
      </Row>
      <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
        checked {formatInstantPair(data.checkedAt)}
      </span>
    </Stack>
  );
}
