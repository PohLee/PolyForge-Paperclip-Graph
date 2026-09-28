/**
 * The runtime view for one GraphRun.
 *
 * Composition only: this file decides *what* a reviewer must be able to see about a live instance
 * and in what order, and delegates the rendering. The list it is held to is REQ-UI-03 plus the
 * gap-closure part of AT-31:
 *
 * * node status, with the projected board status beside it and both labelled
 * * parallel branches — a node with more than one live successor is a fork, and a fork is shown
 * * child-graph expansion — `childRunId` is a real run with its own closure
 * * current worker, attempt, waiting reason, evidence freshness, approval link, budget and
 *   platform blocks, and the event timeline
 * * the last applied `eventSequence`, and a named gap when there is one
 *
 * And the thing it must *never* do: edit the running instance's structure. There is no entry point
 * for it here, and `RuntimeCommands` is a closed list of server calls.
 */

import { useMemo, useState, type ReactNode } from "react";
import type {
  Blocker,
  DomainEvent,
  EffectRecord,
  EvidenceRecord,
  ExecutionAttempt,
  GateEvaluationRecord,
  PendingGovernance,
  RunSnapshot,
} from "@polyforge/protocol";
import { formatAgeSeconds, formatInstantPair, formatList, oneLine } from "../format.js";
import { useSnapshotStream, type SnapshotEvent } from "../hooks/useSnapshotStream.js";
import type { RunTabNode } from "../hooks/usePolyForge.js";
import type { ActionResult } from "../hooks/usePolyForge.js";
import { STATUS_SOURCE_SNAPSHOT } from "../theme.js";
import { EventTimeline } from "./EventTimeline.js";
import { CopyableHash, Identifier, Pill, ProviderRefLink } from "./Identifiers.js";
import { Grid, Panel, Row, Stack } from "./Layout.js";
import { NodeCanvas, buildCanvasNodes } from "./NodeCanvas.js";
import { NodeList, SnapshotProvenance, type NodeInspection } from "./NodeList.js";
import { RuntimeCommands, WaitingSummary } from "./RuntimeCommands.js";
import { StatusPair } from "./StatusPair.js";
import { StatusToken } from "./StatusToken.js";
import { StreamState, gapAnnouncementText } from "./StreamState.js";
import { LiveRegion } from "./Identifiers.js";

export interface RuntimeViewProps {
  runId: string;
  /** The run's nodes as the worker reports them, with the projected status already separated out. */
  nodes: ReadonlyArray<RunTabNode>;
  /** The authoritative snapshot, once the first re-read lands. `null` before that. */
  snapshot: RunSnapshot | null;
  attempts: ReadonlyArray<ExecutionAttempt>;
  gates: ReadonlyArray<GateEvaluationRecord>;
  evidence: ReadonlyArray<EvidenceRecord>;
  effects: ReadonlyArray<EffectRecord>;
  pendingGovernance: ReadonlyArray<PendingGovernance>;
  blockers: ReadonlyArray<Blocker>;
  projectionLagSeconds: number | null;
  onRunCommand: (params: {
    runId: string;
    command: "pause" | "resume" | "cancel" | "retry" | "resolve_block";
    nodeId?: string;
    reason: string;
  }) => Promise<ActionResult<unknown>>;
  onRetryNode: (params: { runId: string; nodeId?: string; reason: string }) => Promise<ActionResult<unknown>>;
  onOpenReviewSurface?: (() => void) | undefined;
  onApplied: (summary: string) => void;
  commandBusy: boolean;
  /** Called when the user asks for a fresh authoritative read. */
  onRequestRefresh: () => void;
}

export function RuntimeView(props: RuntimeViewProps): ReactNode {
  const [events, setEvents] = useState<ReadonlyArray<DomainEvent>>([]);
  const [search, setSearch] = useState("");
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [canvasMode, setCanvasMode] = useState<"list" | "canvas">("list");

  const stream = useSnapshotStream({
    runId: props.runId,
    onSnapshot: () => {
      // The snapshot itself is delivered by the caller's own query; this hook only owns the
      // cursor. Nothing to copy here — the render reads `props.snapshot`.
    },
    onEvents: (incoming: readonly SnapshotEvent[]) => {
      setEvents((previous) => {
        const seen = new Set(previous.map((event) => event.seq));
        const merged = [...previous];
        for (const event of incoming) {
          if (seen.has(event.seq)) continue;
          seen.add(event.seq);
          merged.push({ seq: event.seq, runId: event.runId, type: event.type, at: event.at, payload: event.payload });
        }
        merged.sort((a, b) => a.seq - b.seq);
        // Bounded so a very long run cannot grow the tab without limit; the banner already states
        // the range held, so a truncated list is declared rather than quietly shortened.
        return merged.length > 600 ? merged.slice(merged.length - 600) : merged;
      });
    },
  });

  const inspection = useMemo(() => {
    const byNode = new Map<string, NodeInspection>();
    for (const node of props.nodes) {
      const attempts = props.attempts.filter((attempt) => attempt.nodeId === node.nodeId);
      // Gate records and effect records carry a `transitionHash` but no `nodeId`, so they are
      // attributed through the attempts of that node. A record whose transition matches no attempt
      // of the node is left out of the node row rather than shown against a guess — it still
      // appears in the run-level tables, so nothing is hidden, it is simply not asserted here.
      const transitionHashes = new Set(attempts.map((attempt) => attempt.transitionHash));
      byNode.set(node.nodeId, {
        attempts,
        gates: props.gates.filter((gate) => transitionHashes.has(gate.transitionHash)),
        evidence: props.evidence.filter((record) => record.nodeId === node.nodeId),
        effects: props.effects.filter((effect) => transitionHashes.has(effect.transitionHash)),
        blockers: props.blockers,
      });
    }
    return (nodeId: string): NodeInspection =>
      byNode.get(nodeId) ?? { attempts: [], gates: [], evidence: [], effects: [], blockers: [] };
  }, [props.nodes, props.attempts, props.gates, props.evidence, props.effects, props.blockers]);

  const snapshot = props.snapshot;
  const runStatus = snapshot?.status ?? null;
  const unknownEffects = props.effects.filter((effect) => effect.status === "UNKNOWN");
  const pendingGovernance = props.pendingGovernance.filter((request) => request.resolvedAt === null);

  const canvasNodes = useMemo(
    () =>
      buildCanvasNodes(
        Object.fromEntries(
          props.nodes.map((node) => [
            node.nodeId,
            {
              id: node.nodeId,
              kind: node.kind as never,
              layout: undefined,
            },
          ]),
        ),
        {
          statusOf: (nodeId) => props.nodes.find((node) => node.nodeId === nodeId)?.status ?? null,
          selectedId: selectedNode,
        },
      ),
    [props.nodes, selectedNode],
  );

  const parallelBranches = useMemo(() => {
    const successors = new Map<string, string[]>();
    for (const node of props.nodes) successors.set(node.nodeId, []);
    // A branch is inferred from the live node set plus the attempt ledger: two nodes holding an
    // unfinished attempt at the same time cannot both be on a linear path.
    const live = new Set(
      props.attempts
        .filter((attempt) => attempt.finishedAt === null && attempt.status !== "CANCELLED")
        .map((attempt) => attempt.nodeId),
    );
    return props.nodes.filter((node) => live.has(node.nodeId)).map((node) => node.nodeId);
  }, [props.nodes, props.attempts]);

  return (
    <Stack gap={SPACE_GAP}>
      <StreamState stream={stream} runId={props.runId} />
      <LiveRegion message={gapAnnouncementText(stream)} label="Snapshot currency" />

      <Panel
        id="runtime-summary"
        title="Run"
        description={
          <>
            Read from {STATUS_SOURCE_SNAPSHOT.label}. The live stream only decides when to re-read.
          </>
        }
      >
        <Grid minColumnWidth={200}>
          <Stack gap={2}>
            <Caption>Run identity</Caption>
            <Identifier id={props.runId} label="run" length={14} />
            <Pill>state version {snapshot?.stateVersion ?? "not yet read"}</Pill>
            <Pill>event sequence {snapshot?.eventSequence ?? "not yet read"}</Pill>
            {props.projectionLagSeconds === null ? null : (
              <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
                board projection lag {formatAgeSeconds(props.projectionLagSeconds)}
              </span>
            )}
          </Stack>
          <Stack gap={2}>
            <Caption>Pinned version closure</Caption>
            {snapshot === null ? (
              <span style={{ fontSize: 12 }}>not yet read from the Core</span>
            ) : (
              <>
                <span style={{ fontSize: 12 }}>
                  <code>{snapshot.graphId}</code> version <strong>{snapshot.graphVersion}</strong>
                </span>
                <CopyableHash hash={snapshot.pins["definition"] ?? null} label="definition pin" />
                <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
                  This run does not follow the default version. Activating a newer version changes what
                  future runs adopt and leaves this one alone.
                </span>
              </>
            )}
          </Stack>
          <Stack gap={2}>
            <Caption>Status, side by side</Caption>
            <StatusPair
              graphStatus={runStatus}
              graphFamily="graph"
              projectedIssueStatus={
                props.nodes.length === 0 ? null : (props.nodes[0]?.projectedIssueStatus ?? null)
              }
              graphQualifier={snapshot === null ? undefined : `graph v${snapshot.graphVersion}`}
            />
          </Stack>
          <Stack gap={2}>
            <Caption>Concurrency</Caption>
            <span style={{ fontSize: 12 }}>
              {parallelBranches.length <= 1
                ? "One node is executing."
                : `${parallelBranches.length} nodes hold an unfinished attempt: ${parallelBranches.join(", ")}.`}
            </span>
            {parallelBranches.length <= 1 ? null : (
              <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
                Two unfinished attempts cannot both sit on a linear path. The run is forked, and the
                join semantics of the joining node decide when it becomes one result again.
              </span>
            )}
          </Stack>
        </Grid>

        <SnapshotProvenance
          stateVersion={stream.authoritativeStateVersion}
          eventSequence={stream.authoritativeSequence}
          lastRecoveredAt={stream.lastRecoveredAt}
        />
      </Panel>

      <Panel id="runtime-commands" title="Runtime controls">
        <RuntimeCommands
          runId={props.runId}
          runStatus={runStatus ?? "unknown"}
          nodeIds={props.nodes.map((node) => node.nodeId)}
          unknownEffectCount={unknownEffects.length}
          pendingGovernanceCount={pendingGovernance.length}
          onRunCommand={props.onRunCommand}
          onRetryNode={props.onRetryNode}
          onApplied={props.onApplied}
          onOpenReviewSurface={props.onOpenReviewSurface}
          busy={props.commandBusy}
        />
      </Panel>

      <Panel
        id="runtime-waiting"
        title="What is blocking progress"
        tone={pendingGovernance.length > 0 || props.blockers.length > 0 ? "warning" : "default"}
      >
        <WaitingSummary pendingGovernance={pendingGovernance} blockers={props.blockers} />
        {props.blockers.length === 0 && pendingGovernance.length === 0 ? null : (
          <BudgetPlatformBlocks blockers={props.blockers} />
        )}
        {pendingGovernance.length === 0 ? null : (
          <Stack gap={6}>
            <strong style={{ fontSize: 12 }}>Where the outstanding decisions are answered</strong>
            {pendingGovernance.map((request) => (
              <Row key={request.requestId} gap={6} align="baseline">
                <Pill tone="warning">{request.semanticKind}</Pill>
                <span style={{ fontSize: 12 }}>
                  node <code>{request.nodeId}</code> · request <code>{request.requestId}</code>
                </span>
                <ApprovalLink request={request} />
              </Row>
            ))}
            <p style={{ margin: 0, fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
              A decision is only recorded once the bridge re-reads the authoritative provider object and
              its target hash matches <code>decisionTargetHash</code>. A response that does not match is
              not a resolution, and this plugin has no capability to answer one on anyone&apos;s behalf.
            </p>
          </Stack>
        )}
      </Panel>

      <Panel
        id="runtime-nodes"
        title="Nodes"
        description="Complete inspection without the canvas. Expand a node for its attempt, gates, evidence, effects, and blockers."
        aside={
          <Row gap={4}>
            <button
              type="button"
              onClick={() => setCanvasMode("list")}
              aria-pressed={canvasMode === "list"}
            >
              List view
            </button>
            <button
              type="button"
              onClick={() => setCanvasMode("canvas")}
              aria-pressed={canvasMode === "canvas"}
            >
              Canvas view
            </button>
          </Row>
        }
      >
        <label htmlFor="pf-runtime-node-search" style={{ fontSize: 12 }}>
          Search nodes by id, kind, status, capability, or worker
          <input
            id="pf-runtime-node-search"
            type="search"
            value={search}
            placeholder="filter nodes"
            onChange={(event) => setSearch(event.target.value)}
            style={{ marginLeft: 6, fontSize: 12 }}
          />
        </label>
        {canvasMode === "list" ? (
          <NodeList
            nodes={props.nodes}
            inspection={inspection}
            search={search}
            selectedId={selectedNode}
            onSelect={setSelectedNode}
            caption="Run nodes, gates, and evidence"
          />
        ) : (
          <NodeCanvas
            nodes={canvasNodes}
            edges={[]}
            selectedId={selectedNode}
            onSelect={setSelectedNode}
            search={search}
            caption="Orientation view of the run's nodes. Structure is not editable here."
            emptyMessage="This run reports no nodes."
          />
        )}
      </Panel>

      <Panel
        id="runtime-events"
        title="Event timeline"
        description="Sequence-numbered events from the Core, in the order the Core recorded them."
      >
        <EventTimeline
          events={events}
          rangeFrom={events[0]?.seq ?? stream.authoritativeSequence}
          authoritativeSequence={stream.authoritativeSequence}
          height={300}
        />
        <Row gap={6}>
          <button type="button" onClick={props.onRequestRefresh}>
            Re-read from the Core
          </button>
          <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
            Re-reading discards nothing: the view is rebuilt from the snapshot, and any sequence the
            stream skipped is reported above.
          </span>
        </Row>
      </Panel>
    </Stack>
  );
}

const SPACE_GAP = 16;

function Caption(props: { children: ReactNode }): ReactNode {
  return (
    <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--pf-muted, #6b7280)" }}>
      {props.children}
    </span>
  );
}

/**
 * Budget and platform blocks, called out separately from engineering blocks.
 *
 * The distinction matters because the remedy differs: a budget block is a finance decision, a
 * platform block is an authorization decision, and neither is something a gate or a rework
 * budget can clear. Reading either as an engineering failure sends a reviewer looking in the wrong
 * place.
 */
function BudgetPlatformBlocks(props: { blockers: ReadonlyArray<Blocker> }): ReactNode {
  const platform = props.blockers.filter(
    (blocker) => blocker.reason === "BLOCKED_BUDGET" || blocker.reason === "BLOCKED_PLATFORM" || blocker.reason === "BLOCKED_AUTHORIZATION",
  );
  if (platform.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>
        No budget or platform block is recorded. Budget and authorization decisions belong to
        Paperclip, not to the graph; a run stopped by either is reported here as such.
      </p>
    );
  }
  return (
    <Stack gap={4}>
      <span style={{ fontSize: 12 }}>
        <strong>Blocked by the platform, not by the engineering graph.</strong> These are Paperclip
        decisions. No gate, rework budget, or retry clears them.
      </span>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
        {platform.map((blocker) => (
          <li key={`${blocker.code}:${blocker.reason}`}>
            <StatusToken status={blocker.reason} family="block" hideSource />
            <span style={{ marginLeft: 6 }}>{oneLine(blocker.message)}</span>
          </li>
        ))}
      </ul>
    </Stack>
  );
}

/**
 * Evidence freshness for a run, as an age rather than a verdict.
 *
 * Freshness is a *statement about the record's age*, not a claim that the evidence is still valid:
 * validity is `EvidenceRecord.valid`, and the Core re-checks it against the input revisions. A
 * reviewer needs both, and conflating them would let a three-day-old record read as current.
 */
export function EvidenceFreshnessNote(props: { records: ReadonlyArray<EvidenceRecord> }): ReactNode {
  if (props.records.length === 0) {
    return (
      <span style={{ fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>
        no evidence has been archived for this run
      </span>
    );
  }
  const now = Date.now();
  const ages = props.records
    .map((record) => {
      const parsed = Date.parse(record.createdAt);
      return Number.isNaN(parsed) ? null : Math.max(0, (now - parsed) / 1000);
    })
    .filter((age): age is number => age !== null);
  const oldest = ages.length === 0 ? null : Math.max(...ages);
  const invalid = props.records.filter((record) => !record.valid).length;
  return (
    <Row gap={8} align="baseline">
      <span style={{ fontSize: 12 }}>
        {props.records.length} record(s) · {formatList(props.records.map((record) => record.kind), "no kinds recorded")}
      </span>
      <span style={{ fontSize: 12 }}>
        oldest {oldest === null ? "age not computable" : formatAgeSeconds(oldest)} old
      </span>
      {invalid === 0 ? (
        <span style={{ fontSize: 12 }}>all currently valid</span>
      ) : (
        <span style={{ fontSize: 12, color: "var(--pf-danger, #f87171)" }}>
          {invalid} invalid — an invalid record cannot back a gate
        </span>
      )}
    </Row>
  );
}

/** Approval link for a pending governance request: navigate to the platform, decide as a person. */
export function ApprovalLink(props: { request: PendingGovernance }): ReactNode {  if (props.request.resolvedAt !== null) {
    return (
      <span style={{ fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>
        resolved {formatInstantPair(props.request.resolvedAt)}
      </span>
    );
  }
  if (props.request.providerRef === null) {
    return (
      <span style={{ fontSize: 12 }}>
        no provider reference is attached to this request, so there is nothing to open. A human
        decision cannot be substituted by this plugin.
      </span>
    );
  }
  return (
    <ProviderRefLink
      ref={props.request.providerRef}
      label="Open the decision in Paperclip"
      suffix="— a person answers there; the bridge re-reads the object and records the resolution"
    />
  );
}
