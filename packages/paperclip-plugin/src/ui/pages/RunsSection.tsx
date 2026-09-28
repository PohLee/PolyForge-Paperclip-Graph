/**
 * The run list, and the runtime view for the selected run.
 *
 * The list carries the two counts that decide whether a run needs a person: how many governance
 * requests are outstanding, and how many external effects have an unknown outcome. Neither is a
 * status — they are reasons a run looks idle while something is actually wrong — so they get their
 * own columns rather than being folded into the status badge.
 *
 * The root issue ref is linked only when the bridge recorded one. The worker reads that from its own
 * binding rather than from the run payload, so a link here cannot have been redirected by a Core
 * that echoed back another tenant's id.
 */

import { useMemo, useState, type ReactNode } from "react";
import type { RunSnapshot } from "@polyforge/protocol";
import { formatInstantPair } from "../format.js";
import {
  useMigrationPreview,
  usePlanMigration,
  useCommitMigration,
  useRefresh,
  useRetryNode,
  useRunCommand,
  useRunSnapshot,
  useRunTab,
  useRuntimeRuns,
} from "../hooks/usePolyForge.js";
import { STATUS_SOURCE_GRAPH, STATUS_SOURCE_ISSUE } from "../theme.js";
import { QueryBoundary } from "../components/BridgeState.js";
import { LiveRegion, Pill, ProviderRefLink, useAnnouncer } from "../components/Identifiers.js";
import { Panel, Row, Stack } from "../components/Layout.js";
import { SelectableTable } from "../components/Primitives.js";
import { StatusToken } from "../components/StatusToken.js";
import { MigrationPanel } from "../components/MigrationPanel.js";
import { RuntimeView } from "../components/RuntimeView.js";

export function RunsSection(): ReactNode {
  const runs = useRuntimeRuns({ limit: 100 });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const { message, announce } = useAnnouncer();

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle.length === 0) return runs.data ?? [];
    return (runs.data ?? []).filter(
      (run) =>
        run.runId.toLowerCase().includes(needle) ||
        run.graphId.toLowerCase().includes(needle) ||
        run.entrypoint.toLowerCase().includes(needle) ||
        run.status.toLowerCase().includes(needle),
    );
  }, [runs.data, search]);

  return (
    <Stack gap={12}>
      <Panel
        id="runs-list"
        title="Runs"
        description="Graph runs this bridge knows about. A run keeps the version closure it pinned when it started, whatever the default version is now."
        aside={
          <label style={{ fontSize: 12 }}>
            search
            <input
              type="search"
              value={search}
              placeholder="run, graph, entrypoint, status"
              onChange={(event) => setSearch(event.target.value)}
              style={{ marginLeft: 6, fontSize: 12 }}
            />
          </label>
        }
      >
        <QueryBoundary
          query={runs}
          empty="no run has been created for this company"
          loadingLabel="Reading runs"
        >
          {() => (
            <SelectableTable
              caption="Graph runs"
              rows={filtered.map((run) => ({ id: run.runId, run }))}
              selectedId={selectedRunId}
              onSelect={setSelectedRunId}
              emptyMessage={
                (runs.data ?? []).length === 0
                  ? "No runs have been created yet. A run starts from a Root Issue through an explicit start action."
                  : "No run matches the search."
              }
              columns={[
                {
                  header: "Run",
                  render: (row) => (
                    <Stack gap={2}>
                      <strong>{row.run.entrypoint}</strong>
                      <span style={{ fontSize: 11, fontWeight: 400 }}>
                        <code>{row.run.graphId}</code> v{row.run.graphVersion}
                      </span>
                    </Stack>
                  ),
                },
                {
                  header: "Engineering status",
                  width: "170px",
                  render: (row) => <StatusToken status={row.run.status} family="graph" source={STATUS_SOURCE_GRAPH} />,
                },
                {
                  header: "Awaiting a human",
                  width: "120px",
                  render: (row) =>
                    row.run.pendingGovernanceCount === 0 ? (
                      <span style={{ fontSize: 12 }}>0</span>
                    ) : (
                      <Pill tone="warning">{row.run.pendingGovernanceCount} pending</Pill>
                    ),
                },
                {
                  header: "Unknown effects",
                  width: "120px",
                  render: (row) =>
                    row.run.unknownEffectCount === 0 ? (
                      <span style={{ fontSize: 12 }}>0</span>
                    ) : (
                      <Pill tone="problem">{row.run.unknownEffectCount} unknown</Pill>
                    ),
                },
                {
                  header: "Root issue",
                  render: (row) =>
                    row.run.rootIssueRef === null ? (
                      <StatusToken status={null} family="issue" source={STATUS_SOURCE_ISSUE} />
                    ) : (
                      <ProviderRefLink
                        ref={row.run.rootIssueRef}
                        label={row.run.rootIssueRef.label ?? row.run.rootIssueRef.id}
                        suffix="linked by the bridge from its own binding"
                      />
                    ),
                },
                {
                  header: "State",
                  width: "130px",
                  render: (row) => (
                    <span style={{ fontSize: 11 }}>v{row.run.stateVersion} · {formatInstantPair(row.run.updatedAt)}</span>
                  ),
                },
              ]}
            />
          )}
        </QueryBoundary>
      </Panel>

      <LiveRegion message={message} label="Run list result" />

      {selectedRunId === null ? (
        <Panel id="runs-selection" title="Select a run">
          <p style={{ margin: 0, fontSize: 12 }}>
            Choose a run to see its nodes, gates, evidence, attempts, and event timeline. The runtime
            view has no structural editing: a running instance&apos;s structure is not editable from
            anywhere in this plugin.
          </p>
        </Panel>
      ) : (
        <SelectedRun runId={selectedRunId} announce={announce} onDeselect={() => setSelectedRunId(null)} />
      )}
    </Stack>
  );
}

function SelectedRun(props: {
  runId: string;
  announce: (message: string) => void;
  onDeselect: () => void;
}): ReactNode {
  const runTab = useRunTab(props.runId);
  const snapshot = useRunSnapshot(props.runId);
  const runCommand = useRunCommand();
  const retryNode = useRetryNode();
  const refresh = useRefresh();
  const [targetVersion, setTargetVersion] = useState<number | null>(null);
  const preview = useMigrationPreview(props.runId, targetVersion);
  const plan = usePlanMigration();
  const commit = useCommitMigration();
  const [busy, setBusy] = useState(false);

  const reRead = () => {
    runTab.refresh();
    snapshot.refresh();
    refresh.run({ runId: props.runId });
  };

  return (
    <Panel
      id="run-detail"
      title={`Run ${props.runId}`}
      aside={
        <Row gap={4}>
          <button type="button" onClick={reRead}>
            Re-read everything
          </button>
          <button type="button" onClick={props.onDeselect}>
            Close
          </button>
        </Row>
      }
    >
      <QueryBoundary
        query={runTab}
        empty={`no run is recorded for this company under ${props.runId}`}
        loadingLabel="Reading the run"
      >
        {(view) => {
          const authoritative: RunSnapshot | null = snapshot.data;
          return (
            <Stack gap={12}>
              <RuntimeView
                runId={props.runId}
                nodes={view.nodes}
                snapshot={authoritative}
                attempts={view.attempts}
                gates={view.gates}
                evidence={view.evidence}
                effects={view.effects}
                pendingGovernance={view.pendingGovernance}
                blockers={view.blockers}
                projectionLagSeconds={view.projectionLagSeconds}
                commandBusy={busy || runCommand.pending || retryNode.pending}
                onRunCommand={async (params) => {
                  setBusy(true);
                  const outcome = await runCommand.run(params);
                  setBusy(false);
                  if (outcome.ok) {
                    props.announce(`${params.command} accepted by the server. Re-reading the run.`);
                    reRead();
                  } else {
                    props.announce(`${params.command} refused: ${outcome.failure.message}`);
                  }
                  return outcome;
                }}
                onRetryNode={async (params) => {
                  setBusy(true);
                  const outcome = await retryNode.run(params);
                  setBusy(false);
                  if (outcome.ok) {
                    props.announce("Retry request accepted by the server. Re-reading the run.");
                    reRead();
                  } else {
                    props.announce(`Retry refused: ${outcome.failure.message}`);
                  }
                  return outcome;
                }}
                onApplied={() => reRead()}
                onRequestRefresh={reRead}
              />

              <Panel
                id="run-migration"
                title="Migrate to another version"
                tone="default"
                description="Rare, explicit, and auditable. A migration never happens as a side effect of publishing a new default version."
              >
                <MigrationPanel
                  runId={props.runId}
                  snapshot={authoritative}
                  preview={preview.data}
                  previewLoading={preview.loading}
                  previewFailure={preview.failure}
                  targetVersions={[]}
                  targetGraphVersion={targetVersion}
                  onTargetChange={setTargetVersion}
                  onPlan={async (params) => {
                    const outcome = await plan.run(params);
                    props.announce(
                      outcome.ok ? "Dry-run plan computed. Nothing has changed." : `Planning refused: ${outcome.failure.message}`,
                    );
                    preview.refresh();
                    return outcome;
                  }}
                  onCommit={async (params) => {
                    const outcome = await commit.run(params);
                    props.announce(
                      outcome.ok
                        ? "Migration committed. The source run is superseded, not deleted."
                        : `Commit refused: ${outcome.failure.message}`,
                    );
                    reRead();
                    return outcome;
                  }}
                  busy={plan.pending || commit.pending}
                  onApplied={() => reRead()}
                />
              </Panel>
            </Stack>
          );
        }}
      </QueryBoundary>
    </Panel>
  );
}
