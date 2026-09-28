/**
 * The PolyForge tab on an issue.
 *
 * The one thing this tab exists to prevent: a person dragging an issue to `done` and the board
 * then reporting that the engineering work passed. The Core's own rule is that an issue dragged to
 * `done` produces a *completion observation* that still has to clear a gate, so the two statuses
 * are shown side by side with their sources named, and the "needs engineering verification" state
 * is a first-class panel rather than a footnote.
 *
 * It also carries the gate and evidence inspection for the run bound to this issue, and the run's
 * history. Nothing here decides anything: a human decision is made in Paperclip and re-read
 * afterwards.
 */

import { useMemo, type ReactNode } from "react";
import { KeyValueList } from "@paperclipai/plugin-sdk/ui";
import type { IssueView } from "@polyforge/protocol";
import { formatInstantPair, formatList, oneLine } from "../format.js";
import {
  useIssueViews,
  useRunTab,
  usePolyForgeScope,
  readIssueViews,
  type RunTabView,
} from "../hooks/usePolyForge.js";
import { STATUS_SOURCE_GRAPH, STATUS_SOURCE_ISSUE, STATUS_SOURCE_SNAPSHOT } from "../theme.js";
import { EmptyNotice, FailureNotice, LoadingNotice } from "../components/BridgeState.js";
import { CopyableHash, Identifier, Pill, ProviderRefLink } from "../components/Identifiers.js";
import { Panel, Stack } from "../components/Layout.js";
import { NodeList, SnapshotProvenance, type NodeInspection } from "../components/NodeList.js";
import { NeedsEngineeringVerification, StatusPair } from "../components/StatusPair.js";
import { StatusToken } from "../components/StatusToken.js";

export function PolyForgeIssueTab(props: { entityId: string }): ReactNode {
  const scope = usePolyForgeScope();
  const views = useIssueViews(props.entityId);
  const list = useMemo(() => readIssueViews(views.data), [views.data]);
  const view = list.find((entry) => entry.issueId === props.entityId) ?? list[0] ?? null;
  const runId = view?.runId ?? null;
  const runTab = useRunTab(runId);

  if (!scope.scoped) {
    return (
      <Panel id="issue-tab" title="PolyForge" tone="warning">
        <p style={{ margin: 0, fontSize: 12 }}>
          No company is selected, so this issue cannot be checked against the engineering graph. Nothing
          is inferred from the board alone.
        </p>
      </Panel>
    );
  }
  if (views.failure !== null) {
    return (
      <Panel id="issue-tab" title="PolyForge" tone="problem">
        <FailureNotice failure={views.failure} onRetry={views.refresh} />
      </Panel>
    );
  }
  if (view === null) {
    if (views.loading) return <LoadingNotice label="Checking this issue against the engineering graph" />;
    return (
      <Panel id="issue-tab" title="PolyForge">
        <EmptyNotice
          what="no PolyForge run is bound to this issue."
          detail="An ordinary issue never enters the graph; only a Root Issue marked for engineering work does. That is not an error — it means this issue is not engineering work, or the binding has not been recorded yet."
        />
      </Panel>
    );
  }

  return (
    <Stack gap={12}>
      <StatusPanel view={view} />

      {view.needsEngineeringVerification ? (
        <NeedsEngineeringVerification
          reason={`No PolyForge run is bound to this issue${runId === null ? "" : ` yet, or the bound run (${runId}) has not recorded a terminal pass`}. Until a node reaches PASSED on evidence, the engineering work is unverified.`}
        />
      ) : null}

      {runId === null ? (
        <Panel id="issue-run" title="Bound run">
          <EmptyNotice what="this issue is not bound to a PolyForge run." detail="Nothing below is inferred." />
        </Panel>
      ) : runTab.failure !== null ? (
        <Panel id="issue-run" title="Bound run" tone="problem">
          <FailureNotice failure={runTab.failure} onRetry={runTab.refresh} />
        </Panel>
      ) : runTab.data === null ? (
        <LoadingNotice label="Reading the bound run" />
      ) : (
        <BoundRun runId={runId} data={runTab.data} />
      )}
    </Stack>
  );
}

function StatusPanel(props: { view: IssueView }): ReactNode {
  const { view } = props;
  return (
    <Panel
      id="issue-status"
      title="Graph status and board status"
      description="Two different claims about the same work. Reading one as the other is the mistake this panel exists to prevent."
    >
      <StatusPair
        graphStatus={view.graphStatus}
        graphFamily="graph"
        projectedIssueStatus={view.issueStatus}
        graphSource={view.graphStatusSource === null ? undefined : STATUS_SOURCE_GRAPH}
        issueSource={STATUS_SOURCE_ISSUE}
        disagreement={
          view.needsEngineeringVerification ? (
            <strong> These disagree: the board says done, the graph has not passed. </strong>
          ) : undefined
        }
      />
      {view.graphStatusSource === null ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>
          The worker reported no graph status source for this issue. A board status with no graph behind
          it is not evidence that anything was verified.
        </p>
      ) : null}
      <KeyValueList
        pairs={[
          { label: "Issue", value: <ProviderRefLink ref={{ provider: "paperclip", kind: "issue", id: view.issueId }} label={view.issueId} /> },
          { label: "Bound run", value: view.runId === null ? "not bound" : <Identifier id={view.runId} label="run" length={14} /> },
          {
            label: "Graph status source",
            value: view.graphStatusSource === null ? "not reported" : STATUS_SOURCE_GRAPH.label,
          },
          { label: "Needs engineering verification", value: view.needsEngineeringVerification ? "yes" : "no" },
        ]}
      />
    </Panel>
  );
}

function BoundRun(props: { runId: string; data: RunTabView }): ReactNode {
  const { data } = props;
  const inspection = useMemo(() => {
    const byNode = new Map<string, NodeInspection>();
    for (const node of data.nodes) {
      const attempts = data.attempts.filter((attempt) => attempt.nodeId === node.nodeId);
      const hashes = new Set(attempts.map((attempt) => attempt.transitionHash));
      byNode.set(node.nodeId, {
        attempts,
        gates: data.gates.filter((gate) => hashes.has(gate.transitionHash)),
        evidence: data.evidence.filter((record) => record.nodeId === node.nodeId),
        effects: data.effects.filter((effect) => hashes.has(effect.transitionHash)),
        blockers: data.blockers,
      });
    }
    return (nodeId: string): NodeInspection =>
      byNode.get(nodeId) ?? { attempts: [], gates: [], evidence: [], effects: [], blockers: [] };
  }, [data]);

  return (
    <Stack gap={12}>
      <Panel
        id="issue-run"
        title={`Bound run ${props.runId}`}
        description={`Gates, evidence, transitions, and history for the run bound to this issue. Read from ${STATUS_SOURCE_SNAPSHOT.label}.`}
      >
        <KeyValueList
          pairs={[
            { label: "Graph", value: <code>{data.run.graphId}</code> },
            { label: "Graph version", value: `v${data.run.graphVersion} (pinned at start)` },
            {
              label: "Definition pin",
              value: <CopyableHash hash={data.run.pins["definition"] ?? null} label="definition pin" />,
            },
            { label: "State version", value: String(data.run.stateVersion) },
            { label: "Event sequence", value: String(data.run.eventSequence) },
            {
              label: "Projection lag",
              value:
                data.projectionLagSeconds === null ? "not reported" : `${data.projectionLagSeconds}s behind the Core`,
            },
          ]}
        />
        <SnapshotProvenance
          stateVersion={data.authoritativeSnapshot.stateVersion}
          eventSequence={data.authoritativeSnapshot.eventSequence}
          lastRecoveredAt={null}
        />
      </Panel>

      {data.blockers.length === 0 ? null : (
        <Panel id="issue-blockers" title="Blockers" tone="warning">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
            {data.blockers.map((blocker) => (
              <li key={`${blocker.code}:${blocker.reason}`}>
                <StatusToken status={blocker.reason} family="block" hideSource />
                <span style={{ marginLeft: 6 }}>{oneLine(blocker.message)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel
        id="issue-nodes"
        title="Nodes, gates, and evidence"
        description="The complete inspection, without a canvas. Expand a node for its attempt, gate results, evidence set, and external effects."
      >
        <NodeList
          nodes={data.nodes}
          inspection={inspection}
          search=""
          caption={`Nodes of run ${props.runId}`}
        />
      </Panel>

      <Panel
        id="issue-history"
        title="History"
        description="Recorded transitions for this run. Each record is bound to the evidence set hash it was decided on."
      >
        {data.gates.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12 }}>
            No gate has been evaluated for this run. That is the absence of a decision, not a pass.
          </p>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                {["When", "Gate", "Result", "Evaluator", "Evidence set", "Reason"].map((header) => (
                  <th key={header} scope="col" style={{ textAlign: "left", padding: "2px 6px" }}>
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...data.gates]
                .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
                .map((gate) => (
                  <tr key={gate.evaluationId} style={{ borderTop: "1px solid var(--pf-border, rgba(127,127,127,0.18))" }}>
                    <td>{formatInstantPair(gate.createdAt)}</td>
                    <td>
                      <code>{gate.gateId}</code>
                    </td>
                    <td>
                      <StatusToken status={gate.result} family="gate" source={STATUS_SOURCE_GRAPH} />
                    </td>
                    <td>
                      {gate.evaluatorRef} <Pill>{gate.evaluatorKind}</Pill>
                    </td>
                    <td>
                      <CopyableHash hash={gate.evidenceSetHash} label="evidence set hash" />
                    </td>
                    <td>{oneLine(gate.reason)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel id="issue-evidence-summary" title="Evidence summary">
        <KeyValueList
          pairs={[
            { label: "Records", value: String(data.evidence.length) },
            {
              label: "Kinds",
              value: formatList(data.evidence.map((record) => record.kind), "none"),
            },
            {
              label: "Invalid",
              value:
                data.evidence.filter((record) => !record.valid).length === 0
                  ? "none — every record is currently valid"
                  : `${data.evidence.filter((record) => !record.valid).length} record(s) are invalid and cannot back a gate`,
            },
            {
              label: "External effects with an unknown outcome",
              value: String(data.effects.filter((effect) => effect.status === "UNKNOWN").length),
            },
          ]}
        />
      </Panel>
    </Stack>
  );
}
