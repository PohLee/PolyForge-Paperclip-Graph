/**
 * The PolyForge tab on a Paperclip agent run.
 *
 * The one job here is to make the relationship between the two runs explicit and *unidirectional in
 * meaning*: the Paperclip agent run **executes** a PolyForge attempt. It does not own it, it does not
 * decide whether it passed, and it is not the record of what happened. The PolyForge attempt is the
 * record; the platform run is one execution of it.
 *
 * So the wording is deliberate throughout. A claim state, a lease epoch, and an attempt id are all
 * PolyForge's; a platform run id is Paperclip's; and nothing here lets the platform's success
 * become the graph's `PASSED`. The effect ledger is shown as its own block because an attempt that
 * the platform reported as finished can still have an external effect whose outcome is unknown.
 */

import { useMemo, type ReactNode } from "react";
import { KeyValueList } from "@paperclipai/plugin-sdk/ui";
import { formatElapsed, formatInstantPair, formatList, oneLine } from "../format.js";
import { useRunTab, type RunTabNode, type RunTabView } from "../hooks/usePolyForge.js";
import { STATUS_SOURCE_GRAPH, STATUS_SOURCE_ISSUE, STATUS_SOURCE_PLATFORM, STATUS_SOURCE_SNAPSHOT } from "../theme.js";
import { EmptyNotice, FailureNotice, LoadingNotice } from "../components/BridgeState.js";
import { CopyableHash, Identifier, Pill, ProviderRefLink } from "../components/Identifiers.js";
import { Panel, Row, Stack } from "../components/Layout.js";
import { StatusPair } from "../components/StatusPair.js";
import { StatusToken } from "../components/StatusToken.js";

export function PolyForgeRunTab(props: { entityId: string }): ReactNode {
  const runTab = useRunTab(props.entityId);

  if (runTab.failure !== null) {
    return (
      <Panel id="run-tab" title="PolyForge attempt" tone="problem">
        <FailureNotice failure={runTab.failure} onRetry={runTab.refresh} />
      </Panel>
    );
  }
  if (runTab.data === null) {
    if (runTab.loading) return <LoadingNotice label="Reading the attempt bound to this run" />;
    return (
      <Panel id="run-tab" title="PolyForge attempt">
        <EmptyNotice
          what="this Paperclip run is not bound to a PolyForge attempt."
          detail="The binding is recorded by the bridge when it dispatches work. Nothing about this run's engineering state can be concluded without it."
        />
      </Panel>
    );
  }

  return (
    <Stack gap={12}>
      <LinkDirection data={runTab.data} />
      <AttemptLedger data={runTab.data} />
      <Artifacts data={runTab.data} />
      <EvidenceForRun data={runTab.data} />
      <EffectLedger data={runTab.data} />
      <NodesInRun data={runTab.data} />
    </Stack>
  );
}

function LinkDirection(props: { data: RunTabView }): ReactNode {
  const { data } = props;
  return (
    <Panel
      id="run-tab-link"
      title="How these two runs relate"
      description="Stated explicitly, because the relationship is easy to read backwards."
    >
      <p style={{ margin: 0, fontSize: 12 }}>
        This Paperclip agent run <strong>executes</strong> a PolyForge attempt. It does not own the
        attempt, it cannot decide that the attempt passed, and the Core&apos;s record of what happened is
        the attempt — not this run. A platform run reporting success is an execution observation; a node
        reaches <code>PASSED</code> only when every mandatory evaluator has passed on evidence bound to
        that exact transition.
      </p>
      <KeyValueList
        pairs={[
          { label: "Paperclip run", value: <Identifier id={data.run.runId} label="platform run" length={14} /> },
          { label: "PolyForge run", value: <Identifier id={data.run.graphId} label="graph" length={10} /> },
          { label: "PolyForge run id", value: <Identifier id={data.run.runId} label="PolyForge run" length={14} /> },
          { label: "Pinned graph version", value: `v${data.run.graphVersion}` },
          { label: "Owner epoch", value: `not reported by the worker; state version ${data.run.stateVersion}` },
          { label: "Scope", value: `${data.run.scope.companyRef} / ${data.run.scope.projectRef || "(no project)"}` },
        ]}
      />
      <p style={{ margin: 0, fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
        Source: {STATUS_SOURCE_SNAPSHOT.label}. {data.authoritative ? "The Core confirmed this document is authoritative." : "The Core did not confirm authority for this document, so treat it as unverified."}{" "}
        {data.streamIsHintOnly ? "The live stream is a refresh hint only." : ""}
      </p>
      <StatusPair
        graphStatus={data.run.status}
        graphFamily="graph"
        projectedIssueStatus={data.nodes[0]?.projectedIssueStatus ?? null}
        graphQualifier={`state version ${data.run.stateVersion}`}
      />
    </Panel>
  );
}

function AttemptLedger(props: { data: RunTabView }): ReactNode {
  const { data } = props;
  if (data.attempts.length === 0) {
    return (
      <Panel id="run-tab-attempts" title="Attempts">
        <EmptyNotice
          what="no attempt has been created for this run."
          detail="Without a claim and a lease epoch, no contract-level side effect is permitted. An empty ledger is a blocked state, not a quiet one."
        />
      </Panel>
    );
  }
  return (
    <Panel
      id="run-tab-attempts"
      title="Attempts"
      description="The PolyForge-side record. A lease epoch fences a stale writer: a worker presenting an older epoch is refused, which is why an attempt's epoch matters more than its timestamp."
    >
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
        <thead>
          <tr>
            {["Attempt", "Node", "Status", "Lease epoch", "Claim subject", "Platform run", "Started", "Duration"].map((header) => (
              <th key={header} scope="col" style={{ textAlign: "left", padding: "2px 6px" }}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...data.attempts]
            .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))
            .map((attempt) => (
              <tr key={attempt.attemptId} style={{ borderTop: "1px solid var(--pf-border, rgba(127,127,127,0.18))" }}>
                <td>
                  <Identifier id={attempt.attemptId} label="attempt" length={12} />
                </td>
                <td>
                  <code>{attempt.nodeId}</code>
                </td>
                <td>
                  <StatusToken status={attempt.status} family="attempt" source={STATUS_SOURCE_GRAPH} qualifier={`#${attempt.attemptNo}`} />
                </td>
                <td>{attempt.leaseEpoch}</td>
                <td>{attempt.agentSubject ?? <StatusToken status={null} family="generic" />}</td>
                <td>
                  {attempt.agentRunRef === null ? (
                    <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>not linked</span>
                  ) : (
                    <ProviderRefLink
                      ref={attempt.agentRunRef}
                      label={attempt.agentRunRef.id}
                      suffix="— executes this attempt; does not own it"
                    />
                  )}
                </td>
                <td>{formatInstantPair(attempt.startedAt)}</td>
                <td>{formatElapsed(attempt.startedAt, attempt.finishedAt)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </Panel>
  );
}

function Artifacts(props: { data: RunTabView }): ReactNode {
  const artifacts = props.data.evidence.flatMap((record) => record.artifacts);
  if (artifacts.length === 0) {
    return (
      <Panel id="run-tab-artifacts" title="Artifacts">
        <EmptyNotice what="no artifact has been registered for this run's evidence." detail="Registering an artifact is idempotent per digest; a conflicting digest for the same identity is rejected." />
      </Panel>
    );
  }
  return (
    <Panel
      id="run-tab-artifacts"
      title="Artifacts"
      description="Content-addressed references. A digest is verified before the bytes are trusted."
    >
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
        <thead>
          <tr>
            {["Kind", "Digest", "Media type", "Reference", "Repository", "Recorded"].map((header) => (
              <th key={header} scope="col" style={{ textAlign: "left", padding: "2px 6px" }}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {artifacts.map((artifact) => (
            <tr key={artifact.artifactId} style={{ borderTop: "1px solid var(--pf-border, rgba(127,127,127,0.18))" }}>
              <td>{artifact.kind}</td>
              <td>
                <CopyableHash hash={artifact.contentHash} label="content hash" />
              </td>
              <td>{artifact.mediaType}</td>
              <td>
                <ProviderRefLink ref={artifact.providerRef} label={artifact.providerRef === null ? "no provider reference" : undefined} />
              </td>
              <td>
                {artifact.repository === null || artifact.repository === undefined ? (
                  <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>none</span>
                ) : (
                  <>
                    <code>{artifact.repository.repoRef}</code> @ <code>{artifact.repository.commit}</code>
                  </>
                )}
              </td>
              <td>{formatInstantPair(artifact.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function EvidenceForRun(props: { data: RunTabView }): ReactNode {
  const { data } = props;
  if (data.evidence.length === 0) {
    return (
      <Panel id="run-tab-evidence" title="Evidence">
        <EmptyNotice
          what="no evidence is archived for this run."
          detail="A worker's claim that tests passed stays a candidate until a trusted source confirms it. An empty evidence set cannot back a gate."
        />
      </Panel>
    );
  }
  return (
    <Panel
      id="run-tab-evidence"
      title="Evidence"
      description="Each record is bound to a transition, a producer, and the input revisions it was computed against."
    >
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
        <thead>
          <tr>
            {["Kind", "Node", "Producer", "Transition", "Input revisions", "Valid", "Recorded"].map((header) => (
              <th key={header} scope="col" style={{ textAlign: "left", padding: "2px 6px" }}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.evidence.map((record) => (
            <tr key={record.evidenceId} style={{ borderTop: "1px solid var(--pf-border, rgba(127,127,127,0.18))" }}>
              <td>{record.kind}</td>
              <td>
                <code>{record.nodeId}</code>
              </td>
              <td>
                {record.producerSubject}
                {record.producerRunRef === null ? null : (
                  <>
                    {" "}
                    <ProviderRefLink ref={record.producerRunRef} label="producing run" />
                  </>
                )}
              </td>
              <td>
                <CopyableHash hash={record.transitionHash} label="transition hash" />
              </td>
              <td>{formatList(Object.keys(record.inputRevisionBindings), "none bound")}</td>
              <td>
                {record.valid ? (
                  <Pill>valid</Pill>
                ) : (
                  <Row gap={4} align="baseline">
                    <Pill tone="problem">invalid</Pill>
                    {record.invalidatedReason === null || record.invalidatedReason === undefined ? null : (
                      <span style={{ fontSize: 11 }}>{oneLine(record.invalidatedReason)}</span>
                    )}
                  </Row>
                )}
              </td>
              <td>{formatInstantPair(record.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function EffectLedger(props: { data: RunTabView }): ReactNode {
  const { data } = props;
  const unknown = data.effects.filter((effect) => effect.status === "UNKNOWN");
  return (
    <Panel
      id="run-tab-effects"
      title="External effect ledger"
      tone={unknown.length === 0 ? "default" : "problem"}
      description="The durable record of what happened outside Paperclip. An `UNKNOWN` entry is not a failure to be retried — it is an outcome to be reconciled, because a blind retry of a create duplicates it."
    >
      {data.effects.length === 0 ? (
        <EmptyNotice
          what="no external effect has been recorded for this run."
          detail="That is the correct state for a run whose nodes do not touch the world outside Paperclip."
        />
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
          <thead>
            <tr>
              {["Effect", "Step", "Status", "Target", "Request", "Result", "Note", "Updated"].map((header) => (
                <th key={header} scope="col" style={{ textAlign: "left", padding: "2px 6px" }}>
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.effects.map((effect) => (
              <tr key={effect.effectKey} style={{ borderTop: "1px solid var(--pf-border, rgba(127,127,127,0.18))" }}>
                <td>
                  <code>{effect.effectKey}</code>
                </td>
                <td>{effect.stepId}</td>
                <td>
                  <StatusToken status={effect.status} family="effect" source={STATUS_SOURCE_GRAPH} />
                </td>
                <td>
                  <ProviderRefLink ref={effect.providerRef} />
                </td>
                <td>
                  <CopyableHash hash={effect.requestHash} label="request hash" />
                </td>
                <td>
                  <CopyableHash hash={effect.resultHash} label="result hash" />
                </td>
                <td>{effect.reconciliationNote ?? <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>none</span>}</td>
                <td>{formatInstantPair(effect.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function NodesInRun(props: { data: RunTabView }): ReactNode {
  const rows = useMemo(() => props.data.nodes, [props.data.nodes]);
  return (
    <Panel
      id="run-tab-nodes"
      title="Nodes in this run"
      description="Graph status beside the board projection, per node, with each source named."
    >
      {rows.length === 0 ? (
        <EmptyNotice what="this run reports no nodes." detail="Check the pinned graph version and whether the entrypoint released anything." />
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
          <thead>
            <tr>
              {["Node", "Kind", "Engineering status", "Board projection", "Worker", "Waiting", "Blocked", "Child run"].map((header) => (
                <th key={header} scope="col" style={{ textAlign: "left", padding: "2px 6px" }}>
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((node) => (
              <NodeLine key={node.nodeId} node={node} />
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function NodeLine(props: { node: RunTabNode }): ReactNode {
  const { node } = props;
  return (
    <tr style={{ borderTop: "1px solid var(--pf-border, rgba(127,127,127,0.18))" }}>
      <td>
        <code>{node.nodeId}</code>
      </td>
      <td>
        <Pill>{node.kind}</Pill>
      </td>
      <td>
        <StatusToken status={node.status} family="node" source={STATUS_SOURCE_GRAPH} qualifier={`iteration ${node.iteration}`} />
      </td>
      <td>
        <StatusToken status={node.projectedIssueStatus} family="issue" source={STATUS_SOURCE_ISSUE} />
      </td>
      <td>
        {node.assignedSubject === null ? (
          <StatusToken status={null} family="generic" />
        ) : (
          <Row gap={4} align="baseline">
            {node.assignedSubject}
            <span style={{ fontSize: 10, color: "var(--pf-muted, #6b7280)" }}>{STATUS_SOURCE_PLATFORM.label}</span>
          </Row>
        )}
      </td>
      <td>{node.waitReason ?? <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>not waiting</span>}</td>
      <td>
        {node.blockReason === null ? (
          <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>not blocked</span>
        ) : (
          <StatusToken status={node.blockReason} family="block" />
        )}
      </td>
      <td>
        {node.childRunId === null ? (
          <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>none</span>
        ) : (
          <Identifier id={node.childRunId} label="child run" length={12} />
        )}
      </td>
    </tr>
  );
}
