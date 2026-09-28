/**
 * The non-canvas node list: a complete inspection surface with no pointer required.
 *
 * REQ-UI-06 requires that a reviewer can complete a full gate and evidence inspection *without*
 * touching the canvas, and that large graphs collapse and virtualize. Both are handled here:
 * every node is a disclosure row that expands to show its attempt, gates, evidence, blockers, and
 * waiting reason as text, and the flattened row set is windowed once it grows past
 * `VIRTUALIZE_ABOVE`.
 *
 * The pairing with `NodeCanvas` is the point: the canvas shows shape, this list shows facts. A
 * reviewer never has to choose between them.
 */

import { useMemo, useState, type ReactNode } from "react";
import type {
  Blocker,
  EffectRecord,
  EvidenceRecord,
  ExecutionAttempt,
  GateEvaluationRecord,
} from "@polyforge/protocol";
import { formatAgeSeconds, formatBytes, formatInstantPair, formatList, oneLine } from "../format.js";
import type { RunTabNode } from "../hooks/usePolyForge.js";
import { STATUS_SOURCE_GRAPH, STATUS_SOURCE_ISSUE, STATUS_SOURCE_SNAPSHOT } from "../theme.js";
import { CopyableHash, Identifier, Pill, ProviderRefLink } from "./Identifiers.js";
import { Row, SROnly, Stack } from "./Layout.js";
import { VirtualList } from "./Primitives.js";
import { StatusToken, UnknownValue } from "./StatusToken.js";

const ROW_HEIGHT = 34;

/** What one node's expansion shows. Kept as a prop so the editor can reuse the list read-only. */
export interface NodeInspection {
  readonly attempts: ReadonlyArray<ExecutionAttempt>;
  readonly gates: ReadonlyArray<GateEvaluationRecord>;
  readonly evidence: ReadonlyArray<EvidenceRecord>;
  readonly effects: ReadonlyArray<EffectRecord>;
  readonly blockers: ReadonlyArray<Blocker>;
}

const NOTHING: NodeInspection = { attempts: [], gates: [], evidence: [], effects: [], blockers: [] };

export interface NodeListProps {
  nodes: ReadonlyArray<RunTabNode>;
  inspection: (nodeId: string) => NodeInspection;
  /** Node ids that carry a blocking validation error, highlighted in the editor. */
  errorNodeIds?: ReadonlySet<string>;
  onSelect?: (nodeId: string) => void;
  selectedId?: string | null;
  search: string;
  /** Collapsed node ids in a large graph; `undefined` means "start collapsed". */
  initiallyCollapsed?: boolean;
  caption: string;
}

function matchSearch(node: RunTabNode, needle: string): boolean {
  if (needle.length === 0) return true;
  const lowered = needle.toLowerCase();
  return (
    node.nodeId.toLowerCase().includes(lowered) ||
    node.kind.toLowerCase().includes(lowered) ||
    node.status.toLowerCase().includes(lowered) ||
    node.requiredCapabilities.some((capability) => capability.toLowerCase().includes(lowered)) ||
    (node.assignedSubject ?? "").toLowerCase().includes(lowered)
  );
}

export function NodeList(props: NodeListProps): ReactNode {
  // `collapseAll` is the default posture for a large graph and is *not* state the reader toggles:
  // the per-row disclosure buttons are. A separate "expand all" switch would let a large graph be
  // blown open by accident, which is the opposite of what collapsing is for.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set<string>());
  const collapseAll = props.initiallyCollapsed !== false;

  const filtered = useMemo(
    () => props.nodes.filter((node) => matchSearch(node, props.search)),
    [props.nodes, props.search],
  );

  const toggle = (nodeId: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const setAll = (open: boolean) => {
    if (!open) {
      setExpanded(new Set<string>());
      return;
    }
    setExpanded(new Set(filtered.map((node) => node.nodeId)));
  };

  if (props.nodes.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>
        This run reports no nodes. That is a fact about the run, not an absence of detail — check the
        graph version pin and whether the entrypoint released anything.
      </p>
    );
  }

  return (
    <Stack gap={4}>
      <Row gap={4} align="baseline">
        <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
          {collapseAll ? "Groups are collapsed." : "All groups are expanded."}
        </span>
        <button type="button" onClick={() => setAll(!collapseAll)} style={{ fontSize: 12 }}>
          {collapseAll ? `Expand all ${filtered.length}` : "Collapse all"}
        </button>
      </Row>
      <VirtualList
        items={filtered}
        rowHeight={ROW_HEIGHT}
        height={Math.min(420, Math.max(ROW_HEIGHT * 6, filtered.length * ROW_HEIGHT))}
        getKey={(node) => node.nodeId}
        ariaLabel={props.caption}
        windowSummary={
          filtered.length === props.nodes.length
            ? `Listing all ${props.nodes.length} nodes.`
            : `Listing ${filtered.length} of ${props.nodes.length} nodes; the search hides the rest.`
        }
        renderRow={(node) => {
          const isOpen = !collapseAll || expanded.has(node.nodeId);
          return (
            <NodeRow
              node={node}
              open={isOpen}
              onToggle={() => toggle(node.nodeId)}
              inspection={props.inspection(node.nodeId)}
              hasError={props.errorNodeIds?.has(node.nodeId) === true}
              selected={props.selectedId === node.nodeId}
              onSelect={props.onSelect}
            />
          );
        }}
      />
    </Stack>
  );
}

function NodeRow(props: {
  node: RunTabNode;
  open: boolean;
  onToggle: () => void;
  inspection: NodeInspection;
  hasError: boolean;
  selected: boolean;
  onSelect?: ((nodeId: string) => void) | undefined;
}): ReactNode {
  const contentId = `node-detail-${props.node.nodeId}`;
  const data = props.inspection === undefined ? NOTHING : props.inspection;
  return (
    <div
      style={{
        borderBottom: "1px solid var(--pf-border, rgba(127,127,127,0.18))",
        borderLeft: props.hasError ? "3px solid var(--pf-danger, #f87171)" : undefined,
        background: props.selected ? "var(--pf-selected, rgba(96,165,250,0.1))" : undefined,
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center", minHeight: ROW_HEIGHT - 2, padding: "2px 4px" }}>
        <button
          type="button"
          onClick={props.onToggle}
          aria-expanded={props.open}
          aria-controls={contentId}
          style={{ fontSize: 12, cursor: "pointer", minWidth: 16, textAlign: "left" }}
        >
          <span aria-hidden="true">{props.open ? "▾" : "▸"}</span>
          <SROnly>{props.open ? "Collapse" : "Expand"} {props.node.nodeId}</SROnly>
        </button>
        {props.onSelect === undefined ? null : (
          <button
            type="button"
            onClick={() => props.onSelect?.(props.node.nodeId)}
            style={{ fontSize: 12, fontWeight: 600, cursor: "pointer", background: "none", border: "none", padding: 0, color: "inherit" }}
          >
            {props.node.nodeId}
          </button>
        )}
        {props.onSelect === undefined ? (
          <span style={{ fontSize: 12, fontWeight: 600 }}>{props.node.nodeId}</span>
        ) : null}
        <Pill>{props.node.kind}</Pill>
        <StatusToken
          status={props.node.status}
          family="node"
          source={STATUS_SOURCE_GRAPH}
          qualifier={`iteration ${props.node.iteration}`}
        />
        <StatusToken
          status={props.node.projectedIssueStatus}
          family="issue"
          source={STATUS_SOURCE_ISSUE}
          hideSource
        />
        {props.hasError ? <Pill tone="problem">validation error</Pill> : null}
        {data.blockers.length > 0 ? <Pill tone="problem">{data.blockers.length} blocker(s)</Pill> : null}
        {data.gates.length > 0 ? <Pill>{data.gates.length} gate record(s)</Pill> : null}
      </div>
      {props.open ? (
        <div id={contentId} style={{ padding: "2px 4px 10px 26px" }}>
          <NodeDetail node={props.node} data={data} />
        </div>
      ) : null}
    </div>
  );
}

function NodeDetail(props: { node: RunTabNode; data: NodeInspection }): ReactNode {
  const { node, data } = props;
  const unknownEffect = data.effects.filter((effect) => effect.status === "UNKNOWN");
  return (
    <Stack gap={8}>
      <Row gap={12} wrap align="baseline">
        <Field label="current worker" value={node.assignedSubject} unknown="no worker is assigned" />
        <Field label="waiting reason" value={node.waitReason} unknown="not waiting" />
        <Field
          label="block reason"
          value={node.blockReason}
          unknown="not blocked"
          statusValue={node.blockReason}
          statusFamily="block"
        />
        <Field label="required capabilities" value={formatList(node.requiredCapabilities)} unknown="none recorded" />
        <Field
          label="contract hash"
          value={<CopyableHash hash={node.contractHash} label="contract hash" />}
          unknown="no contract hash is bound to this node"
        />
      </Row>

      {node.childRunId === null ? null : (
        <Row gap={4} align="baseline">
          <span style={{ fontSize: 12 }}>Child graph run:</span>
          <Identifier id={node.childRunId} label="child run" />
          <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
            — a subgraph node runs its own version closure; it is not inlined into this run.
          </span>
        </Row>
      )}

      {data.blockers.length === 0 ? null : (
        <div>
          <h5 style={{ margin: "0 0 2px", fontSize: 12 }}>Blockers</h5>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
            {data.blockers.map((blocker) => (
              <li key={`${blocker.code}:${blocker.reason}:${blocker.message}`}>
                <StatusToken status={blocker.reason} family="block" hideSource />
                <span style={{ marginLeft: 6 }}>{oneLine(blocker.message)}</span>
                <Pill>{blocker.code}</Pill>
              </li>
            ))}
          </ul>
        </div>
      )}

      {unknownEffect.length === 0 ? null : (
        <p style={{ margin: 0, fontSize: 12, color: "var(--pf-danger, #f87171)" }}>
          <strong>
            {unknownEffect.length} external effect(s) with an unknown outcome.
          </strong>{" "}
          Reconcile before doing anything else. Retrying a create whose outcome is unknown is how one
          operation becomes two.
        </p>
      )}

      <DetailTable
        title={`Attempts (${data.attempts.length})`}
        empty="no attempt has been created for this node"
        rows={data.attempts.map((attempt) => ({
          id: attempt.attemptId,
          cells: [
            <Identifier key="id" id={attempt.attemptId} label="attempt" />,
            <StatusToken
              key="status"
              status={attempt.status}
              family="attempt"
              source={STATUS_SOURCE_GRAPH}
              qualifier={`#${attempt.attemptNo} · lease epoch ${attempt.leaseEpoch}`}
            />,
            <span key="subject">
              {attempt.agentSubject ?? "not reported"}
              {attempt.agentRunRef === null ? null : (
                <>
                  {" "}
                  <ProviderRefLink
                    ref={attempt.agentRunRef}
                    label="platform run"
                    suffix="— the platform executes this attempt; PolyForge owns the attempt itself"
                  />
                </>
              )}
            </span>,
            <span key="time">{formatInstantPair(attempt.startedAt)}</span>,
            <span key="hash">
              <CopyableHash hash={attempt.transitionHash} label="transition hash" />
            </span>,
          ],
        }))}
      />

      <DetailTable
        title={`Gate evaluations (${data.gates.length})`}
        empty="no evaluator has run for this node. That is not a pass — it is the absence of a decision."
        rows={data.gates.map((gate) => ({
          id: gate.evaluationId,
          cells: [
            <span key="gate">{gate.gateId}</span>,
            <StatusToken
              key="result"
              status={gate.result}
              family="gate"
              source={STATUS_SOURCE_GRAPH}
              qualifier={gate.evaluatorKind}
            />,
            <span key="evaluator">
              {gate.evaluatorRef} <Pill>v{gate.evaluatorVersion}</Pill>
            </span>,
            <span key="evidence">
              <CopyableHash hash={gate.evidenceSetHash} label="evidence set hash" />
            </span>,
            <span key="reason">{oneLine(gate.reason)}</span>,
          ],
        }))}
      />

      <DetailTable
        title={`Evidence (${data.evidence.length})`}
        empty="no evidence has been archived for this node"
        rows={data.evidence.map((record) => ({
          id: record.evidenceId,
          cells: [
            <span key="kind">
              {record.kind} {record.valid ? <Pill>valid</Pill> : <Pill tone="problem">invalid</Pill>}
            </span>,
            <span key="producer">
              {record.producerSubject}
              {record.producerRunRef === null ? null : (
                <>
                  {" "}
                  <ProviderRefLink ref={record.producerRunRef} label="producing run" />
                </>
              )}
            </span>,
            <span key="transition">
              <CopyableHash hash={record.transitionHash} label="transition hash" />
            </span>,
            <span key="freshness">
              {/* Freshness is the age of the record. Validity is a separate field above; keeping
                  them apart stops a stale-but-valid record from reading as a current pass. */}
              <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
                {formatAgeSeconds(recordAgeSeconds(record.createdAt))} old
              </span>
            </span>,
            <span key="bindings">
              {formatList(Object.keys(record.inputRevisionBindings), "no input revisions bound")}
            </span>,
            <span key="artifacts">
              {record.artifacts.length === 0
                ? "no artifacts"
                : record.artifacts
                    .map((artifact) => `${artifact.kind} ${formatBytes(artifact.size)} ${artifact.contentHash}`)
                    .join("; ")}
              {record.invalidatedReason === null || record.invalidatedReason === undefined
                ? null
                : <span style={{ color: "var(--pf-danger, #f87171)" }}> — invalidated: {record.invalidatedReason}</span>}
            </span>,
            <span key="created">{formatInstantPair(record.createdAt)}</span>,
          ],
        }))}
      />

      <DetailTable
        title={`External effects (${data.effects.length})`}
        empty="this node has recorded no external effect"
        rows={data.effects.map((effect) => ({
          id: effect.effectKey,
          cells: [
            <StatusToken
              key="status"
              status={effect.status}
              family="effect"
              source={STATUS_SOURCE_GRAPH}
              qualifier={effect.stepId}
            />,
            <span key="key">{effect.effectKey}</span>,
            <ProviderRefLink key="ref" ref={effect.providerRef} label="effect target" />,
            <span key="request">
              <CopyableHash hash={effect.requestHash} label="request hash" />
            </span>,
            <span key="result">
              <CopyableHash hash={effect.resultHash} label="result hash" />
            </span>,
            <span key="note">{effect.reconciliationNote ?? "no reconciliation note"}</span>,
          ],
        }))}
      />
    </Stack>
  );
}

function DetailTable(props: {
  title: string;
  empty: string;
  rows: ReadonlyArray<{ id: string; cells: ReactNode[] }>;
}): ReactNode {
  if (props.rows.length === 0) {
    return (
      <div>
        <h5 style={{ margin: 0, fontSize: 12 }}>{props.title}</h5>
        <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>{props.empty}</p>
      </div>
    );
  }
  return (
    <div>
      <h5 style={{ margin: "0 0 2px", fontSize: 12 }}>{props.title}</h5>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11 }}>
          <tbody>
            {props.rows.map((row) => (
              <tr key={row.id} style={{ borderTop: "1px solid var(--pf-border, rgba(127,127,127,0.18))" }}>
                {row.cells.map((cell, index) => (
                  <td key={index} style={{ padding: "3px 6px", verticalAlign: "top" }}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field(props: {
  label: string;
  value: ReactNode;
  unknown: string;
  statusValue?: string | null;
  statusFamily?: "block";
}): ReactNode {
  const isMissing = props.value === null || props.value === undefined;
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 1 }}>
      <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--pf-muted, #6b7280)" }}>
        {props.label}
      </span>
      {isMissing ? (
        <UnknownValue reason={props.unknown} label="not reported" />
      ) : props.statusValue === undefined ? (
        <span style={{ fontSize: 12 }}>{props.value}</span>
      ) : (
        <span style={{ fontSize: 12, display: "inline-flex", gap: 6, alignItems: "baseline" }}>
          <StatusToken status={props.statusValue ?? null} family={props.statusFamily ?? "block"} hideSource />
          <span>{props.value}</span>
        </span>
      )}
    </span>
  );
}

/** Seconds since `iso`, or `null` when the timestamp cannot be parsed. Never a negative age. */
function recordAgeSeconds(iso: string): number | null {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, (Date.now() - parsed) / 1000);
}

/** A one-line freshness statement for an evidence set, stated as an age rather than a verdict. */
export function EvidenceFreshness(props: { createdAt: string; now: number }): ReactNode {
  return (
    <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
      archived {formatInstantPair(props.createdAt, props.now)} · age{" "}
      {formatAgeSeconds((Date.parse(props.createdAt) - props.now) / -1000)}
    </span>
  );
}

/** Snapshot provenance strip: which read the numbers on this screen came from. */
export function SnapshotProvenance(props: {
  stateVersion: number;
  eventSequence: number;
  lastRecoveredAt: string | null;
}): ReactNode {
  return (
    <Row gap={8} align="baseline">
      <Pill>state version {props.stateVersion}</Pill>
      <Pill>event sequence {props.eventSequence}</Pill>
      {props.lastRecoveredAt === null ? (
        <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
          not yet re-read from {STATUS_SOURCE_SNAPSHOT.label}
        </span>
      ) : (
        <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
          re-read from {STATUS_SOURCE_SNAPSHOT.label} at {formatInstantPair(props.lastRecoveredAt)}
        </span>
      )}
    </Row>
  );
}
