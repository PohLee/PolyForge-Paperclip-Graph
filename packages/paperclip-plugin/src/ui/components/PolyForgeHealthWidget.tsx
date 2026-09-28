/**
 * The dashboard widget and the sidebar entry.
 *
 * Both are glanceable surfaces with the same honesty constraint as the rest of the plugin, and
 * both are built to *not move* while they load. A dashboard card that resizes when its data
 * arrives pushes everything below it down, and on a dashboard with several cards that is a layout
 * bug dressed as a loading state — so the loading state here occupies the same box as the loaded
 * state, and a degraded system says so in words rather than showing a neutral placeholder.
 */

import type { ReactNode } from "react";
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import type { HealthData, RunListItem } from "@polyforge/protocol";
import { formatInstantPair } from "../format.js";
import { useHealth, useRuntimeRuns } from "../hooks/usePolyForge.js";
import { STATUS_SOURCE_GRAPH } from "../theme.js";
import { Pill } from "./Identifiers.js";
import { Row, Stack } from "./Layout.js";
import { StatusToken } from "./StatusToken.js";

/** Reserved box height. Matches the loaded state closely enough that nothing below it jumps. */
const RESERVED = 76;

export function PolyForgeHealthWidget(): ReactNode {
  const health = useHealth();
  const runs = useRuntimeRuns({ limit: 25 });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minHeight: RESERVED,
        padding: 8,
        border: "1px solid var(--pf-border, rgba(127,127,127,0.3))",
        borderRadius: 6,
      }}
    >
      <Row gap={6} align="baseline">
        <strong style={{ fontSize: 13 }}>PolyForge</strong>
        {health.unscoped ? (
          <Pill tone="warning">no company selected</Pill>
        ) : health.failure !== null ? (
          <Pill tone="problem">
            {health.failure.kind === "not_permitted"
              ? "not permitted"
              : health.failure.kind === "unreachable"
                ? "worker unreachable"
                : "health unreadable"}
          </Pill>
        ) : health.data === null ? (
          <Pill>reading…</Pill>
        ) : (
          <StatusToken status={health.data.status} family="health" hideSource />
        )}
      </Row>

      {health.failure !== null ? (
        <p style={{ margin: 0, fontSize: 11 }}>{health.failure.message}</p>
      ) : health.data === null ? (
        <p role="status" aria-live="polite" style={{ margin: 0, fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
          Reading integration health. The box below will not resize when it arrives.
        </p>
      ) : (
        <HealthLines data={health.data} />
      )}

      <RunTally runs={runs} />
    </div>
  );
}

function HealthLines(props: { data: HealthData }): ReactNode {
  const { data } = props;
  const problemCounters = (Object.keys(data.counters) as Array<keyof HealthData["counters"]>).filter(
    (key) => data.counters[key] !== null && (data.counters[key] as number) > 0 && key !== "inboxDuplicates" && key !== "staleLeaseRejected" && key !== "duplicateEffectsPrevented",
  );
  return (
    <Stack gap={2}>
      <Row gap={6} align="baseline">
        <Pill>runtime {data.runtime.reachable ? "reachable" : "unreachable"}</Pill>
        <Pill>host {data.host.compatible ? "compatible" : "incompatible"}</Pill>
        {data.host.serverVersion === null ? <Pill>host version not reported</Pill> : <Pill>host {data.host.serverVersion}</Pill>}
      </Row>
      {data.status === "ready" && data.issues.length === 0 ? null : (
        <p style={{ margin: 0, fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
          {data.issues.length} issue(s) need an operator
          {problemCounters.length > 0 ? `; ${problemCounters.length} counter(s) are non-zero` : ""}. Open the
          PolyForge page for the detail.
        </p>
      )}
      {data.runtime.reachable ? null : (
        <p style={{ margin: 0, fontSize: 11, color: "var(--pf-danger, #f87171)" }}>
          The Runtime Service is unreachable. This is <strong>not</strong> a healthy state with no
          activity — it is an unknown one.
        </p>
      )}
    </Stack>
  );
}

function RunTally(props: { runs: import("../hooks/usePolyForge.js").PolyForgeQuery<RunListItem[]> }): ReactNode {
  const { runs } = props;
  if (runs.data === null) {
    return (
      <p role="status" aria-live="polite" style={{ margin: 0, fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
        Counting runs…
      </p>
    );
  }
  const active = runs.data.filter((run) => run.status === "ACTIVE" || run.status === "WAITING");
  const blocked = runs.data.filter((run) => run.status === "BLOCKED" || run.status === "FAILED");
  const unknownEffects = runs.data.reduce((sum, run) => sum + run.unknownEffectCount, 0);
  return (
    <Row gap={6} align="baseline">
      <Pill>{active.length} running</Pill>
      {blocked.length === 0 ? null : <Pill tone="problem">{blocked.length} blocked or failed</Pill>}
      {unknownEffects === 0 ? null : <Pill tone="problem">{unknownEffects} unknown effect(s)</Pill>}
    </Row>
  );
}

export function PolyForgeSidebar(): ReactNode {
  const navigation = useHostNavigation();
  const health = useHealth();
  const linkProps = navigation.linkProps("/plugins/polyforge#health");

  return (
    <nav aria-label="PolyForge">
      <Stack gap={4}>
        <a {...linkProps} style={{ fontWeight: 600, fontSize: 13 }}>
          PolyForge
        </a>
        <p style={{ margin: 0, fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
          Versioned graphs, durable gates, and evidence. Board columns are a projection of the graph,
          not the other way round.
        </p>
        {health.unscoped ? (
          <Pill tone="warning">no company selected</Pill>
        ) : health.failure !== null ? (
          <Pill tone="problem">health unreadable</Pill>
        ) : health.data === null ? (
          <Pill>reading health…</Pill>
        ) : (
          <Pill tone={health.data.status === "ready" ? "default" : "problem"}>
            {health.data.status} · {formatInstantPair(health.data.checkedAt, Date.now())}
          </Pill>
        )}
        <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
          Source of every engineering status on this page:{" "}
          <strong>{STATUS_SOURCE_GRAPH.label}</strong>.
        </span>
      </Stack>
    </nav>
  );
}
