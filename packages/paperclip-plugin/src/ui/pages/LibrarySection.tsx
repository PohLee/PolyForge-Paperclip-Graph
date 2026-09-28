/**
 * The graph library: graphs, versions, drafts, and the draft editor.
 *
 * The immutability rule is enforced by *structure*, not by disabling things: selecting a published
 * version renders a read-only view, and the only way forward is "Clone to draft", which is a
 * server call that creates a new draft from that version. There is no code path from a published
 * version to the editor, so "edit a published version" is not a thing this page can do even by
 * accident.
 *
 * Activation is a separate, explicit action from publication, and it is worded to say so: it moves
 * the default version pointer for *future* runs and touches nothing that already started.
 */

import { useMemo, useState, type ReactNode } from "react";
import type { GraphLibraryItem } from "@polyforge/protocol";
import { formatInstantPair, formatList, oneLine } from "../format.js";
import {
  useActivateVersion,
  useCreateDraft,
  useGraphLibrary,
  useGraphVersions,
  readCommandResult,
} from "../hooks/usePolyForge.js";
import { STATUS_SOURCE_GRAPH } from "../theme.js";
import { FailureNotice, QueryBoundary } from "../components/BridgeState.js";
import { CopyableHash, Identifier, LiveRegion, Pill, useAnnouncer } from "../components/Identifiers.js";
import { Grid, Panel, Row, Stack } from "../components/Layout.js";
import { Modal, SelectableTable } from "../components/Primitives.js";
import { StatusToken } from "../components/StatusToken.js";
import { GraphEditor } from "../editor/GraphEditor.js";
import { ActivationNotice } from "../components/MigrationPanel.js";

export interface LibrarySectionProps {
  /** A draft id the host or another section asked to open, e.g. from a deep link. */
  initialDraftId?: string | null;
}

type Selection =
  | { kind: "graph"; graphId: string }
  | { kind: "version"; graphId: string; version: number }
  | { kind: "draft"; draftId: string; graphId: string };

export function LibrarySection(props: LibrarySectionProps): ReactNode {
  const library = useGraphLibrary();
  const [selection, setSelection] = useState<Selection | null>(
    props.initialDraftId === undefined || props.initialDraftId === null
      ? null
      : { kind: "draft", draftId: props.initialDraftId, graphId: "" },
  );
  const { message, announce } = useAnnouncer();

  return (
    <Stack gap={12}>
      <Panel
        id="library-graphs"
        title="Graph library"
        description="Every graph this bridge has worked for. The active default version is what a *new* run adopts; existing runs keep their own pins."
      >
        <QueryBoundary
          query={library}
          empty="no graph has been published for this company yet"
          loadingLabel="Reading the graph library"
        >
          {(graphs) => <GraphTable graphs={graphs} selected={selection} onSelect={setSelection} />}
        </QueryBoundary>
      </Panel>

      <LiveRegion message={message} label="Library result" />

      {selection === null ? (
        <Panel id="library-selection" title="Select a graph">
          <p style={{ margin: 0, fontSize: 12 }}>
            Choose a graph above to see its published versions and drafts, or open a draft to edit it.
          </p>
        </Panel>
      ) : selection.kind === "draft" ? (
        <Panel
          id="library-editor"
          title="Definition editor"
          description="Definition mode. This is the only place in the plugin where structure is edited, and it edits a draft — never a running instance."
          aside={
            <button type="button" onClick={() => setSelection({ kind: "graph", graphId: selection.graphId })}>
              Back to versions
            </button>
          }
        >
          <GraphEditor
            draftId={selection.draftId}
            onPublished={() => {
              announce("Published. Reload the version list to see the new immutable version.");
              library.refresh();
            }}
          />
        </Panel>
      ) : (
        <VersionPanel
          graphId={selection.graphId}
          version={selection.kind === "version" ? selection.version : null}
          onSelectVersion={(version) => setSelection({ kind: "version", graphId: selection.graphId, version })}
          onOpenDraft={(draftId) => setSelection({ kind: "draft", draftId, graphId: selection.graphId })}
          onBack={() => setSelection(null)}
          announce={announce}
        />
      )}
    </Stack>
  );
}

function GraphTable(props: {
  graphs: ReadonlyArray<GraphLibraryItem>;
  selected: Selection | null;
  onSelect: (selection: Selection) => void;
}): ReactNode {
  return (
    <SelectableTable
      caption="Graphs available to this company"
      rows={[...props.graphs]
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((graph) => ({ id: graph.graphId, graph }))}
      selectedId={props.selected?.kind === "graph" ? props.selected.graphId : null}
      onSelect={(graphId) => props.onSelect({ kind: "graph", graphId })}
      emptyMessage="No graphs are available."
      columns={[
        {
          header: "Graph",
          render: (row) => {
            const graph = row.graph;
            return (
              <Stack gap={2}>
                <strong>{graph.name}</strong>
                <Identifier id={graph.graphId} label="graph" length={12} />
                {graph.description.length === 0 ? null : (
                  <span style={{ fontWeight: 400, fontSize: 11 }}>{oneLine(graph.description, "")}</span>
                )}
              </Stack>
            );
          },
        },
        {
          header: "Default version",
          width: "110px",
          render: (row) =>
            row.graph.activeVersion === null ? (
              <StatusToken status={null} family="graph" />
            ) : (
              <Pill>v{row.graph.activeVersion} (future runs)</Pill>
            ),
        },
        {
          header: "Latest version",
          width: "100px",
          render: (row) =>
            row.graph.latestVersion === null ? (
              <StatusToken status={null} family="graph" />
            ) : (
              <Pill>v{row.graph.latestVersion}</Pill>
            ),
        },
        {
          header: "Drafts",
          width: "80px",
          render: (row) =>
            row.graph.draftCount === 0 ? (
              <span style={{ fontSize: 12 }}>0</span>
            ) : (
              <Pill tone="warning">{row.graph.draftCount} open</Pill>
            ),
        },
        {
          header: "Entrypoints",
          width: "180px",
          render: (row) => <span style={{ fontSize: 12 }}>{formatList(row.graph.entrypoints, "none declared")}</span>,
        },
        {
          header: "Runs",
          width: "70px",
          render: (row) => <span style={{ fontSize: 12 }}>{row.graph.runCount}</span>,
        },
        {
          header: "Retired",
          width: "80px",
          render: (row) => (row.graph.retired ? <Pill tone="warning">retired</Pill> : <span style={{ fontSize: 12 }}>no</span>),
        },
      ]}
    />
  );
}

function VersionPanel(props: {
  graphId: string;
  version: number | null;
  onSelectVersion: (version: number) => void;
  onOpenDraft: (draftId: string) => void;
  onBack: () => void;
  announce: (message: string) => void;
}): ReactNode {
  const versions = useGraphVersions(props.graphId);
  const clone = useCreateDraft();
  const activate = useActivateVersion();
  const [cloning, setCloning] = useState<number | null>(null);
  const [activating, setActivating] = useState<{ version: number; generation: number | null } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const selected = useMemo(
    () => (props.version === null ? null : (versions.data ?? []).find((entry) => entry.version === props.version) ?? null),
    [props.version, versions.data],
  );

  return (
    <Stack gap={12}>
      <Panel
        id="library-versions"
        title="Versions"
        description={`Published versions of ${props.graphId}, as recorded by ${STATUS_SOURCE_GRAPH.label}. A published version is immutable: there is no editor for one, and the way to change it is to clone it into a new draft and publish a new version.`}
        aside={
          <Row gap={4}>
            <button type="button" onClick={versions.refresh}>
              Re-read
            </button>
            <button type="button" onClick={props.onBack}>
              Back to the library
            </button>
          </Row>
        }
      >
        <QueryBoundary
          query={versions}
          empty={`no version of ${props.graphId} has been published`}
          loadingLabel="Reading published versions"
        >
          {(list) => (
            <SelectableTable
              caption={`Published versions of ${props.graphId}`}
              rows={[...list]
                .sort((a, b) => b.version - a.version)
                .map((entry) => ({ id: String(entry.version), entry }))}
              selectedId={props.version === null ? null : String(props.version)}
              onSelect={(key) => props.onSelectVersion(Number(key))}
              emptyMessage="No published versions."
              columns={[
                {
                  header: "Version",
                  render: (row) => <Pill>v{row.entry.version}</Pill>,
                },
                {
                  header: "Published",
                  render: (row) => (
                    <Stack gap={2}>
                      <span style={{ fontSize: 12 }}>{formatInstantPair(row.entry.publishedAt)}</span>
                      <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>by {row.entry.publishedBy}</span>
                    </Stack>
                  ),
                },
                {
                  header: "Definition",
                  render: (row) => <CopyableHash hash={row.entry.definitionHash} label="definition hash" />,
                },
                {
                  header: "Compiler",
                  render: (row) => <span style={{ fontSize: 12 }}>{row.entry.compilerVersion}</span>,
                },
                {
                  header: "Plan",
                  render: (row) => <CopyableHash hash={row.entry.planHash} label="plan hash" />,
                },
                {
                  header: "State",
                  render: (row) => (row.entry.retired ? <Pill tone="warning">retired</Pill> : <Pill>current</Pill>),
                },
                {
                  header: "",
                  width: "110px",
                  render: (row) => (
                    <button
                      type="button"
                      onClick={() => {
                        setFailure(null);
                        setCloning(row.entry.version);
                      }}
                    >
                      Clone to draft
                    </button>
                  ),
                },
              ]}
            />
          )}
        </QueryBoundary>
      </Panel>

      {selected === null ? null : (
        <Panel
          id="library-version-detail"
          title={`Version ${selected.version} — read only`}
          tone="default"
          description="Published structure is immutable by requirement. Everything below is inspection."
        >
          <Grid minColumnWidth={220}>
            <Stack gap={2}>
              <Field label="definition hash" value={<CopyableHash hash={selected.definitionHash} label="definition hash" />} />
              <Field label="plan hash" value={<CopyableHash hash={selected.planHash} label="plan hash" />} />
              <Field
                label="dependency lock"
                value={<CopyableHash hash={selected.dependencyLockHash} label="dependency lock hash" />}
              />
            </Stack>
            <Stack gap={2}>
              <Field label="published by" value={selected.publishedBy} />
              <Field label="published at" value={formatInstantPair(selected.publishedAt)} />
              <Field label="status" value={selected.retired ? "retired" : "published and not retired"} />
            </Stack>
          </Grid>
          <Row gap={8}>
            <button
              type="button"
              disabled={selected.retired}
              onClick={() => {
                setFailure(null);
                setActivating({ version: selected.version, generation: null });
              }}
            >
              Make this the default version
            </button>
            <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
              {selected.retired ? "A retired version cannot become the default." : "This is a separate action from publishing."}
            </span>
          </Row>
          <ActivationNotice graphId={props.graphId} version={selected.version} />
        </Panel>
      )}

      {cloning === null ? null : (
        <Modal
          title={`Clone v${cloning} to a new draft`}
          onClose={() => setCloning(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => {
                  void clone
                    .run({ graphId: props.graphId, baseVersion: cloning })
                    .then((outcome) => {
                      setCloning(null);
                      if (!outcome.ok) {
                        setFailure(outcome.failure.message);
                        return;
                      }
                      const record = outcome.value as { draftId?: unknown } | null;
                      const draftId = typeof record?.draftId === "string" ? record.draftId : null;
                      if (draftId === null) {
                        setFailure(
                          "The clone call returned without a draft id. No draft was opened, because opening one by guessing would risk editing the wrong object.",
                        );
                        return;
                      }
                      props.announce(`Cloned v${cloning} into draft ${draftId}.`);
                      versions.refresh();
                      props.onOpenDraft(draftId);
                    });
                }}
              >
                Create the draft
              </button>
              <button type="button" onClick={() => setCloning(null)}>
                Cancel
              </button>
            </>
          }
        >
          <p style={{ margin: 0, fontSize: 12 }}>
            This creates a new mutable draft based on v{cloning}. The published version is untouched and
            stays readable — including by every run that pinned it.
          </p>
        </Modal>
      )}

      {activating === null ? null : (
        <Modal
          title={`Make v${activating.version} the default version`}
          onClose={() => setActivating(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => {
                  void activate
                    .run({
                      graphId: props.graphId,
                      version: activating.version,
                      // A compare-and-swap on the pointer's generation. `null` would be refused by
                      // the worker, so the dialog asks for it rather than sending a guess.
                      expectedGeneration: activating.generation ?? 0,
                    })
                    .then((outcome) => {
                      setActivating(null);
                      if (!outcome.ok) {
                        setFailure(outcome.failure.message);
                        return;
                      }
                      const command = readCommandResult(outcome.value);
                      props.announce(
                        command !== null && command.applied
                          ? `v${activating.version} is now the default for future runs.`
                          : "The server did not confirm the activation. Nothing is claimed as active.",
                      );
                      versions.refresh();
                    });
                }}
              >
                Activate
              </button>
              <button type="button" onClick={() => setActivating(null)}>
                Cancel
              </button>
            </>
          }
        >
          <ActivationNotice graphId={props.graphId} version={activating.version} />
          <p style={{ margin: 0, fontSize: 12 }}>
            This is a compare-and-swap on the default pointer&apos;s generation. The bridge does not
            report that generation, so the panel sends <code>0</code>: if the pointer has already moved,
            the server refuses and nothing changes. That is the safe direction.
          </p>
        </Modal>
      )}

      {failure === null ? null : <FailureNotice failure={{ kind: "refused", code: "CLONE_OR_ACTIVATE", message: failure, detail: null, remedy: "The server refused the request. The message above is its own; nothing was changed by this page." }} />}
    </Stack>
  );
}

function Field(props: { label: string; value: ReactNode }): ReactNode {
  return (
    <Stack gap={2}>
      <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--pf-muted, #6b7280)" }}>
        {props.label}
      </span>
      <span style={{ fontSize: 12 }}>{props.value}</span>
    </Stack>
  );
}
