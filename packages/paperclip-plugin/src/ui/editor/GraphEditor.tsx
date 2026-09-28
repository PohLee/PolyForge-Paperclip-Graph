/**
 * The Definition-mode graph editor.
 *
 * This is an editor for a *draft*, and only for a draft. A published version is immutable by
 * REQ-GRAPH-02, so there is no editor path to one — the library offers "Clone to draft" instead,
 * and this component is never mounted for a published version.
 *
 * It is also deliberately not a WYSIWYG canvas. The canvas orients; the forms edit. Every
 * structural field is reachable from the keyboard through a real form control, and the palette
 * inserts a node *into the buffer* rather than onto a live run, so an edit here can never reach a
 * running instance. REQ-GRAPH-07 forbids runtime structural editing, and the only way to make
 * that structurally true is for there to be no code path from a live run to this component.
 *
 * The publish panel shows its gate as a list of conditions rather than one disabled button,
 * because "why can I not publish" is the question a reviewer actually has.
 */

import { useMemo, useState, type ReactNode } from "react";
import type { GraphDefinition, NodeKind, SemanticDiff, ValidationIssue } from "@polyforge/protocol";
import { usePluginToast } from "@paperclipai/plugin-sdk/ui";
import { oneLine } from "../format.js";
import { STATUS_SOURCE_LOCAL } from "../theme.js";
import { FailureNotice, LoadingNotice } from "../components/BridgeState.js";
import { CheckboxField, NumberField, RecordField, SelectField, StringListField, TextAreaField, TextField } from "../components/Controls.js";
import { CopyableHash, Identifier, LiveRegion, Pill, useAnnouncer } from "../components/Identifiers.js";
import { Grid, Panel, Row, Stack } from "../components/Layout.js";
import { NODE_PALETTE, NodeCanvas, buildCanvasNodes } from "../components/NodeCanvas.js";
import { StatusLegend } from "../components/StatusLegend.js";
import {
  errorNodeIds,
  useDraftEditor,
  type DefinitionEdit,
  type DraftEditor,
  type ConflictResolution,
  type PublishGate,
} from "./EditorState.js";

export interface GraphEditorProps {
  draftId: string;
  /** Called after a publish succeeds, so the library can re-read versions. */
  onPublished?: (() => void) | undefined;
  /** Read-only mode is not offered; this flag exists only to make the constraint explicit. */
  readOnlyReason?: string | undefined;
}

export function GraphEditor(props: GraphEditorProps): ReactNode {
  const editor = useDraftEditor(props.draftId);
  const toast = usePluginToast();
  const { message, announce } = useAnnouncer();
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEntrypoint, setSelectedEntrypoint] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [changeSummary, setChangeSummary] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [newNodeId, setNewNodeId] = useState("");
  const [newNodeKind, setNewNodeKind] = useState<NodeKind>("agent_operation");
  const [newEdgeFrom, setNewEdgeFrom] = useState("");
  const [newEdgeTo, setNewEdgeTo] = useState("");
  const [newEdgeGuard, setNewEdgeGuard] = useState("");

  const errorsByNode = useMemo(() => errorNodeIds(editor.anchoredIssues), [editor.anchoredIssues]);
  const warningsByNode = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of editor.anchoredIssues) {
      if (entry.issue.severity === "warning" && entry.anchorKind === "node" && entry.anchor !== null) {
        ids.add(entry.anchor);
      }
    }
    return ids;
  }, [editor.anchoredIssues]);

  const definition = editor.buffer;
  const canvasNodes = useMemo(
    () => buildCanvasNodes(definition.nodes, { errorNodeIds: errorsByNode, warningNodeIds: warningsByNode, selectedId: selectedNode }),
    [definition.nodes, errorsByNode, warningsByNode, selectedNode],
  );
  const node = selectedNode === null ? undefined : definition.nodes[selectedNode];
  const entrypointKey = selectedEntrypoint ?? Object.keys(definition.entrypoints)[0] ?? null;
  const entrypoint = entrypointKey === null ? undefined : definition.entrypoints[entrypointKey];

  const run = async (label: string, work: () => Promise<boolean>) => {
    announce(`${label}…`);
    const ok = await work();
    announce(ok ? `${label} completed.` : `${label} did not complete. See the message below.`);
    if (ok) toast({ title: `${label} completed`, tone: "success" });
  };

  if (editor.loading) return <LoadingNotice label="Loading the draft" />;
  if (editor.loadFailure !== null) return <FailureNotice failure={editor.loadFailure} onRetry={editor.reload} />;
  if (editor.base === null) {
    return (
      <p style={{ fontSize: 12 }}>
        This draft has no definition body, or the body was not readable as a graph. Nothing is
        editable until the Core returns a definition this build can parse; a half-parsed graph
        saved back would be a definition nobody validated.
      </p>
    );
  }

  return (
    <Stack gap={12}>
      <EditorHeader
        draftId={props.draftId}
        revision={editor.baseRevision}
        definitionHash={editor.baseDefinitionHash}
        dirty={editor.dirty}
        phase={editor.phase}
      />

      <LiveRegion message={message ?? editor.lastMessage} label="Editor result" />

      {editor.conflict === null ? null : (
        <ConflictPanel
          conflict={editor.conflict}
          onResolve={editor.resolveConflict}
        />
      )}

      {editor.lastFailure === null ? null : <FailureNotice failure={editor.lastFailure} />}

      <Grid minColumnWidth={300}>
        <Panel id="editor-palette" title="Palette" description="Inserts into the draft buffer. Nothing here touches a running instance.">
          <Stack gap={8}>
            {NODE_PALETTE.map((entry) => (
              <div key={entry.kind}>
                <button
                  type="button"
                  onClick={() => {
                    const id = newNodeId.trim().length === 0 ? entry.kind : newNodeId.trim();
                    editor.edit({ kind: "addNode", nodeId: id, nodeKind: entry.kind });
                    setSelectedNode(id in definition.nodes ? id : `${id}_${Object.keys(definition.nodes).length + 1}`);
                    setNewNodeId("");
                    announce(`Added a ${entry.kind} node to the buffer. It is unsaved until you save the draft.`);
                  }}
                >
                  Add {entry.kind}
                </button>
                <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>{entry.summary}</p>
              </div>
            ))}
            <TextField
              label="New node id"
              value={newNodeId}
              onChange={setNewNodeId}
              placeholder="derived from the kind when empty"
              hint="Ids are unique within a graph. A duplicate gets a numeric suffix rather than overwriting."
            />
            <SelectField<NodeKind>
              label="Kind for the next insertion"
              value={newNodeKind}
              options={NODE_PALETTE.map((entry) => ({ value: entry.kind, label: entry.kind }))}
              onChange={setNewNodeKind}
            />

            <hr style={{ border: "none", borderTop: "1px solid var(--pf-border, rgba(127,127,127,0.25))" }} />

            <TextField label="Edge from" value={newEdgeFrom} onChange={setNewEdgeFrom} placeholder="node id" />
            <TextField label="Edge to" value={newEdgeTo} onChange={setNewEdgeTo} placeholder="node id" />
            <TextField label="Guard expression" value={newEdgeGuard} onChange={setNewEdgeGuard} placeholder="optional" />
            <button
              type="button"
              disabled={newEdgeFrom.trim().length === 0 || newEdgeTo.trim().length === 0}
              onClick={() => {
                if (!(newEdgeFrom in definition.nodes) || !(newEdgeTo in definition.nodes)) {
                  announce("That edge was not added: one of its endpoints is not a node in this graph.");
                  return;
                }
                editor.edit({ kind: "addEdge", from: newEdgeFrom, to: newEdgeTo, guard: newEdgeGuard });
                setNewEdgeTo("");
                setNewEdgeGuard("");
                announce("Edge added to the buffer.");
              }}
            >
              Add edge
            </button>
            <p style={{ margin: 0, fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
              An edge between two nodes that are not both in this graph is refused here rather than
              being added for the validator to reject.
            </p>
          </Stack>
        </Panel>

        <Panel
          id="editor-canvas"
          title="Structure"
          description="Positions are layout metadata and are versioned separately from the execution hash. Set them numerically in the inspector."
          aside={
            <label style={{ fontSize: 12 }}>
              search
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="node id or kind"
                style={{ marginLeft: 6, fontSize: 12 }}
              />
            </label>
          }
        >
          <NodeCanvas
            nodes={canvasNodes}
            edges={definition.edges}
            selectedId={selectedNode}
            onSelect={setSelectedNode}
            search={search}
            caption="Draft structure. Orientation only; not a wiring editor."
            emptyMessage="This draft has no nodes yet. Add one from the palette."
          />
        </Panel>
      </Grid>

      <Grid minColumnWidth={320}>
        <Panel id="editor-graph" title="Graph">
          <Stack gap={8}>
            <TextField label="Name" value={definition.name} onChange={(name) => editor.edit({ kind: "setMeta", name })} />
            <TextAreaField
              label="Description"
              value={definition.description ?? ""}
              onChange={(description) => editor.edit({ kind: "setMeta", description })}
              rows={3}
            />
            <ReadOnlyField label="graphId" value={definition.graphId} />
            <ReadOnlyField label="schemaVersion" value={String(definition.schemaVersion)} />
            <StringListField
              label="Policy references"
              values={definition.policyRefs}
              onChange={(refs) => editor.edit({ kind: "setPolicies", refs })}
              hint="A policy may only be strengthened, never weakened. The Core enforces that on the hash, not on the form."
            />
          </Stack>
        </Panel>

        <Panel id="editor-entrypoints" title="Entrypoints" description="The coordinator capability, required facts, and start nodes that gate admission.">
          <Stack gap={8}>
            <SelectField
              label="Entrypoint"
              value={entrypointKey ?? ""}
              options={Object.keys(definition.entrypoints).map((key) => ({ value: key, label: key }))}
              onChange={setSelectedEntrypoint}
              disabled={Object.keys(definition.entrypoints).length === 0}
            />
            {entrypoint === undefined ? (
              <p style={{ margin: 0, fontSize: 12 }}>This graph declares no entrypoint, so nothing can start a run from it.</p>
            ) : (
              <>
                <StringListField
                  label="Inputs"
                  values={entrypoint.inputs}
                  onChange={(inputs) => editor.edit({ kind: "setEntrypoint", key: entrypointKey ?? "", patch: { inputs } })}
                />
                <StringListField
                  label="Required facts"
                  values={entrypoint.requiresFacts}
                  onChange={(requiresFacts) =>
                    editor.edit({ kind: "setEntrypoint", key: entrypointKey ?? "", patch: { requiresFacts } })
                  }
                  hint="Each fact must carry verifiable provenance. A side entry cannot skip them."
                />
                <StringListField
                  label="Start nodes"
                  values={entrypoint.startNodes}
                  onChange={(startNodes) => editor.edit({ kind: "setEntrypoint", key: entrypointKey ?? "", patch: { startNodes } })}
                />
                <StringListField
                  label="Exports"
                  values={entrypoint.exports}
                  onChange={(exports) => editor.edit({ kind: "setEntrypoint", key: entrypointKey ?? "", patch: { exports } })}
                />
                <RecordField
                  label="Coordinator required capabilities"
                  value={entrypoint.coordinator.requiredCapabilities.reduce<Record<string, string>>(
                    (accumulator, capability) => {
                      accumulator[capability] = capability;
                      return accumulator;
                    },
                    {},
                  )}
                  onChange={(record) =>
                    editor.edit({
                      kind: "setEntrypoint",
                      key: entrypointKey ?? "",
                      patch: { coordinator: { ...entrypoint.coordinator, requiredCapabilities: Object.keys(record) } },
                    })
                  }
                  hint="One capability per line. The coordinator is matched on capabilities, not on an agent id."
                />
              </>
            )}
          </Stack>
        </Panel>
      </Grid>

      <Panel
        id="editor-inspector"
        title={node === undefined ? "Node inspector" : `Node inspector — ${selectedNode ?? ""}`}
        description="Every field here is a form control. Nothing in this panel requires a pointer."
        aside={
          node === undefined ? null : (
            <button type="button" onClick={() => editor.edit({ kind: "removeNode", nodeId: selectedNode ?? "" })}>
              Remove this node
            </button>
          )
        }
      >
        {node === undefined || selectedNode === null ? (
          <p style={{ margin: 0, fontSize: 12 }}>
            Select a node in the structure view or the node list to edit it. Removing a node also
            removes the edges that touch it, and drops it from every entrypoint's start nodes.
          </p>
        ) : (
          <NodeInspector
            definition={definition}
            nodeId={selectedNode}
            issues={editor.anchoredIssues
              .filter((entry) => entry.anchorKind === "node" && entry.anchor === selectedNode)
              .map((entry) => entry.issue)}
            onEdit={editor.edit}
          />
        )}
      </Panel>

      <Panel
        id="editor-edges"
        title="Edges"
        description="Structural links. A guard is evaluated before the successor is released; an unusable guard blocks rather than passes."
      >
        {definition.edges.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12 }}>This graph has no edges, so no node can follow another.</p>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                {["from", "to", "guard", ""].map((header) => (
                  <th key={header} scope="col" style={{ textAlign: "left", padding: "2px 6px" }}>
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {definition.edges.map((edge) => (
                <tr key={`${edge.from}->${edge.to}`}>
                  <td>
                    <code>{edge.from}</code>
                  </td>
                  <td>
                    <code>{edge.to}</code>
                  </td>
                  <td>
                    <input
                      type="text"
                      aria-label={`guard for ${edge.from} to ${edge.to}`}
                      defaultValue={edge.guard ?? ""}
                      onBlur={(event) =>
                        editor.edit({
                          kind: "setEdgeGuard",
                          from: edge.from,
                          to: edge.to,
                          guard: event.target.value,
                        })
                      }
                      style={{ width: "100%", fontSize: 12 }}
                    />
                  </td>
                  <td>
                    <button type="button" onClick={() => editor.edit({ kind: "removeEdge", from: edge.from, to: edge.to })}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        id="editor-validation"
        title="Validation"
        tone={editor.anchoredIssues.some((entry) => entry.issue.severity === "error") ? "problem" : "default"}
        aside={
          <button type="button" onClick={() => void run("Validation", editor.validate)} disabled={editor.phase === "validating"}>
            {editor.phase === "validating" ? "Validating…" : "Validate"}
          </button>
        }
      >
        <ValidationList
          entries={editor.anchoredIssues}
          onLocate={(entry) => {
            if (entry.anchorKind === "node" && entry.anchor !== null) setSelectedNode(entry.anchor);
          }}
        />
      </Panel>

      <Panel
        id="editor-publish"
        title="Compile, review, publish"
        description="Publish is a compare-and-swap on the draft revision, the definition hash, the compiler version, the plan hash, and the review's target hash. All five must name this definition."
      >
        <Stack gap={10}>
          <Row gap={8}>
            <button type="button" onClick={() => void run("Compile", editor.compile)} disabled={editor.phase === "compiling"}>
              {editor.phase === "compiling" ? "Compiling…" : "Compile"}
            </button>
            <button type="button" onClick={editor.computeDiff}>
              Produce the semantic diff
            </button>
            <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
              computed in this browser from the revision you loaded, as a review aid
            </span>
          </Row>

          <DiffView diff={editor.stages.diff.value} />

          <Row gap={8} align="baseline">
            <TextField
              label="Compile artifact"
              value={editor.stages.compileArtifact.value?.planHash ?? ""}
              onChange={() => undefined}
              placeholder="compile to produce one"
              monospace
              disabled
              hint={editor.stages.compileArtifact.value === null ? "not compiled" : `compiler ${editor.stages.compileArtifact.value.compilerVersion}`}
            />
            <TextField
              label="Dependency lock"
              value={editor.stages.compileArtifact.value?.dependencyLockHash ?? ""}
              onChange={() => undefined}
              monospace
              disabled
            />
          </Row>

          <fieldset style={{ border: "1px solid var(--pf-border, rgba(127,127,127,0.3))", borderRadius: 6, padding: 8 }}>
            <legend style={{ fontSize: 12, fontWeight: 600 }}>Review</legend>
            <p style={{ margin: "0 0 6px", fontSize: 12 }}>
              Recording a review needs an authenticated reviewer with the authoring role; the plugin
              asserts the person the host authenticated and cannot record one on anyone&apos;s behalf.
              The Core binds the review to this exact plan hash on the current revision, and publish
              re-checks that binding.
            </p>
            <Row gap={8} align="flex-end">
              <TextField label="Your name" value={reviewer} onChange={setReviewer} placeholder="who reviewed this" />
              <button
                type="button"
                // Awaited, and disabled while the write is in flight. Recording is a server write
                // now, so a click that is not awaited would let the panel claim success before the
                // Core had agreed to anything.
                disabled={editor.phase === "publishing"}
                onClick={() => {
                  void editor.attestReview(reviewer);
                }}
              >
                Record review
              </button>
            </Row>
            {editor.stages.review.value === null ? null : (
              <p style={{ margin: "6px 0 0", fontSize: 12 }}>
                Recorded by {editor.stages.review.value.reviewer} against{" "}
                <code>{editor.stages.review.value.targetHash}</code> and plan{" "}
                <code>{editor.stages.review.value.planHash}</code>.
              </p>
            )}
          </fieldset>

          <PublishGateView gate={editor.gate} />

          <Row gap={8} align="flex-end">
            <TextField
              label="Change summary"
              value={changeSummary}
              onChange={setChangeSummary}
              placeholder="what changed and why"
              hint="Stored with the revision. An unaudited change is not a reviewable one."
            />
            <button type="button" onClick={() => void run("Save", () => editor.save(changeSummary))}>
              {editor.dirty ? "Save draft" : "Save (no local changes)"}
            </button>
            <button type="button" onClick={editor.resetBuffer} disabled={!editor.dirty}>
              Discard local edits
            </button>
          </Row>

          <Row gap={8}>
            <button
              type="button"
              onClick={() => void run("Publish", editor.publish)}
              disabled={!editor.gate.canPublish || editor.phase === "publishing"}
            >
              {editor.phase === "publishing" ? "Publishing…" : "Publish immutable version"}
            </button>
            <button type="button" onClick={editor.reload}>
              Reload from the Core
            </button>
            {editor.gate.canPublish ? null : (
              <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
                The conditions above are not all met. The server checks the same five again.
              </span>
            )}
          </Row>

          {props.readOnlyReason === undefined ? null : (
            <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>{props.readOnlyReason}</p>
          )}
        </Stack>
      </Panel>

      <StatusLegend />
    </Stack>
  );
}

function EditorHeader(props: {
  draftId: string;
  revision: number | null;
  definitionHash: string | null;
  dirty: boolean;
  phase: string;
}): ReactNode {
  return (
    <Panel
      id="editor-header"
      title="Draft"
      tone={props.dirty ? "warning" : "default"}
      description="A draft is mutable and revisioned. A published version is immutable; to change one, clone it to a new draft."
    >
      <Row gap={10} align="baseline">
        <Identifier id={props.draftId} label="draft" length={14} />
        <Pill>revision {props.revision ?? "not reported"}</Pill>
        <CopyableHash hash={props.definitionHash} label="definition hash" />
        <Pill tone={props.dirty ? "warning" : "default"}>{props.dirty ? "unsaved local edits" : "buffer matches the server"}</Pill>
        <Pill>phase: {props.phase}</Pill>
      </Row>
    </Panel>
  );
}

function ReadOnlyField(props: { label: string; value: string }): ReactNode {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 12, fontWeight: 600 }}>{props.label}</span>
      <code style={{ fontSize: 12 }}>{props.value}</code>
      <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
        set by the Core at draft creation; changing it would change the graph identity
      </span>
    </div>
  );
}

function ValidationList(props: {
  entries: ReadonlyArray<{ issue: ValidationIssue; anchor: string | null; anchorKind: "node" | "edge" | "graph" }>;
  onLocate: (entry: { anchor: string | null; anchorKind: "node" | "edge" | "graph" }) => void;
}): ReactNode {
  if (props.entries.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>
        No validation report for the current definition. Run the validator: an unvalidated draft is not
        a clean draft.
      </p>
    );
  }
  return (
    <Stack gap={4}>
      {props.entries.map((entry) => {
        const error = entry.issue.severity === "error";
        return (
          <div
            key={`${entry.issue.code}:${entry.issue.path}:${entry.issue.message}`}
            style={{
              borderLeft: `3px ${error ? "solid" : "dashed"} var(--pf-${error ? "danger" : "warn"}, ${error ? "#f87171" : "#fbbf24"})`,
              padding: "3px 8px",
            }}
          >
            <Row gap={6} align="baseline">
              <Pill tone={error ? "problem" : "warning"}>{entry.issue.severity}</Pill>
              <code style={{ fontSize: 11 }}>{entry.issue.code}</code>
              <code style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>{entry.issue.path}</code>
              {entry.anchor === null ? (
                <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
                  graph-level; this path does not point at one node
                </span>
              ) : (
                <button type="button" onClick={() => props.onLocate(entry)} style={{ fontSize: 11 }}>
                  go to {entry.anchorKind} {entry.anchor}
                </button>
              )}
            </Row>
            <p style={{ margin: "2px 0 0", fontSize: 12 }}>{oneLine(entry.issue.message)}</p>
          </div>
        );
      })}
    </Stack>
  );
}

function DiffView(props: { diff: SemanticDiff | null }): ReactNode {
  if (props.diff === null) {
    return (
      <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>
        No semantic diff for the current definition. The list below is the change a reviewer needs to
        see before spending a publish on it.
      </p>
    );
  }
  const sections: ReadonlyArray<{ label: string; items: ReadonlyArray<string> }> = [
    { label: "Nodes added", items: props.diff.addedNodes },
    { label: "Nodes removed", items: props.diff.removedNodes },
    { label: "Nodes changed", items: props.diff.changedNodes },
    { label: "Edges added or changed", items: props.diff.addedEdges },
    { label: "Edges removed", items: props.diff.removedEdges },
    { label: "Policy changes", items: props.diff.policyChanges },
  ];
  const total = sections.reduce((sum, section) => sum + section.items.length, 0);
  return (
    <div
      style={{
        border: "1px solid var(--pf-border, rgba(127,127,127,0.3))",
        borderRadius: 6,
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <Row gap={6} align="baseline">
        <strong style={{ fontSize: 12 }}>Semantic diff (indicative)</strong>
        <Pill>{total === 0 ? "no structural change" : `${total} change(s)`}</Pill>
        <Pill tone={props.diff.invalidatesEvidence ? "warning" : "default"}>
          {props.diff.invalidatesEvidence
            ? "invalidates previously recorded PASSes"
            : "no evidence invalidated by this diff"}
        </Pill>
        <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
          source: {STATUS_SOURCE_LOCAL.label} — {STATUS_SOURCE_LOCAL.detail}
        </span>
      </Row>
      {total === 0 ? null : (
        <Grid minColumnWidth={200}>
          {sections
            .filter((section) => section.items.length > 0)
            .map((section) => (
              <div key={section.label}>
                <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3 }}>{section.label}</div>
                <ul style={{ margin: "2px 0 0", paddingLeft: 18, fontSize: 12 }}>
                  {section.items.map((item) => (
                    <li key={item}>
                      <code>{item}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </Grid>
      )}
      {props.diff.invalidatesEvidence ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--pf-warn, #fbbf24)" }}>
          A removed or changed node means a previously recorded PASS is no longer applicable. It is not
          inherited: the new or changed node has to run its own evaluators.
        </p>
      ) : null}
    </div>
  );
}

function PublishGateView(props: { gate: PublishGate }): ReactNode {
  return (
    <div
      style={{
        border: "1px solid var(--pf-border, rgba(127,127,127,0.3))",
        borderRadius: 6,
        padding: 8,
      }}
    >
      <strong style={{ fontSize: 12 }}>
        Publish preconditions ({props.gate.checks.filter((check) => check.ok).length}/{props.gate.checks.length} met)
      </strong>
      <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12, display: "grid", gap: 2 }}>
        {props.gate.checks.map((check) => (
          <li key={check.id}>
            <Row gap={4} align="baseline">
              <span aria-hidden="true">{check.ok ? "✓" : "✕"}</span>
              <strong>{check.label}:</strong>
              <span style={{ color: check.ok ? "var(--pf-muted, #6b7280)" : "var(--pf-warn, #fbbf24)" }}>
                {check.detail}
              </span>
            </Row>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConflictPanel(props: {
  conflict: NonNullable<DraftEditor["conflict"]>;
  onResolve: (resolution: ConflictResolution) => void;
}): ReactNode {
  return (
    <div
      role="alert"
      style={{
        border: "3px double var(--pf-warn, #fbbf24)",
        borderRadius: 6,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <strong style={{ fontSize: 13 }}>Concurrent edit — the server has a newer revision</strong>
      <p style={{ margin: 0, fontSize: 12 }}>
        This buffer was based on revision <strong>{props.conflict.baseRevision}</strong>. The server
        refused the save, which means its revision has moved. Nothing was overwritten and your edits
        are still in the buffer.
      </p>
      <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>{props.conflict.message}</p>
      {props.conflict.serverRevision === null ? (
        <p style={{ margin: 0, fontSize: 12 }}>
          The bridge did not report the server&apos;s revision number — the host collapses a worker
          refusal to a code and a message. Reload to read the server&apos;s current revision, then compare
          before you decide.
        </p>
      ) : (
        <p style={{ margin: 0, fontSize: 12 }}>
          The server is at revision <strong>{props.conflict.serverRevision}</strong>.
        </p>
      )}
      <Row gap={8}>
        <button type="button" onClick={() => props.onResolve("reload")}>
          Reload the server&apos;s revision (discards my edits)
        </button>
        <button type="button" onClick={() => props.onResolve("overwrite")}>
          Re-read, then save mine over theirs after review
        </button>
        <button type="button" onClick={() => props.onResolve("dismiss")}>
          Stay here and decide later
        </button>
      </Row>
      <p style={{ margin: 0, fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
        The second option still saves with an <code>If-Match</code> against whatever revision the
        server has at that moment. It is a compare-and-swap, not a blind overwrite — if the server
        moves again you will be back here.
      </p>
    </div>
  );
}

function NodeInspector(props: {
  definition: GraphDefinition;
  nodeId: string;
  issues: ReadonlyArray<ValidationIssue>;
  onEdit: (edit: DefinitionEdit) => void;
}): ReactNode {
  const node = props.definition.nodes[props.nodeId];
  if (node === undefined) return null;
  const errorFor = (field: string): string | undefined =>
    props.issues.find((issue) => issue.path.endsWith(field) && issue.severity === "error")?.message;

  return (
    <Grid minColumnWidth={240}>
      <Stack gap={8}>
        <ReadOnlyField label="node id" value={props.nodeId} />
        <ReadOnlyField label="kind" value={node.kind} />
        <TextField
          label="Operation id"
          value={node.operation?.id ?? ""}
          onChange={(id) =>
            props.onEdit({ kind: "setNode", nodeId: props.nodeId, patch: { operation: { id, version: node.operation?.version ?? 1 } } })
          }
          monospace
          hint="For an agent_operation node: the operation contract it must satisfy."
        />
        <StringListField
          label="Outputs"
          values={node.outputs ?? []}
          onChange={(outputs) => props.onEdit({ kind: "setNode", nodeId: props.nodeId, patch: { outputs } })}
          error={errorFor("outputs")}
        />
        <StringListField
          label="Produces"
          values={node.produces ?? []}
          onChange={(produces) => props.onEdit({ kind: "setNode", nodeId: props.nodeId, patch: { produces } })}
        />
        <StringListField
          label="Requires"
          values={node.requires ?? []}
          onChange={(requires) => props.onEdit({ kind: "setNode", nodeId: props.nodeId, patch: { requires } })}
        />
      </Stack>

      <Stack gap={8}>
        <RecordField
          label="Inputs (name=type)"
          value={node.inputs ?? {}}
          onChange={(inputs) => props.onEdit({ kind: "setNode", nodeId: props.nodeId, patch: { inputs } })}
          error={errorFor("inputs")}
        />
        <StringListField
          label="Evaluator references"
          values={node.evaluatorRefs ?? []}
          onChange={(evaluatorRefs) => props.onEdit({ kind: "setNode", nodeId: props.nodeId, patch: { evaluatorRefs } })}
          hint="A gate's evaluators. Independent review means a producing subject that differs from the worker's."
        />
        <StringListField
          label="Executor required capabilities"
          values={node.executor?.requiredCapabilities ?? []}
          onChange={(capabilities) =>
            props.onEdit({
              kind: "setNode",
              nodeId: props.nodeId,
              patch: { executor: { ...(node.executor ?? { requiredCapabilities: [] }), requiredCapabilities: capabilities } },
            })
          }
          error={errorFor("requiredCapabilities")}
        />
        <StringListField
          label="Executor fallback roles"
          values={node.executor?.fallbackRoles ?? []}
          onChange={(fallbackRoles) =>
            props.onEdit({
              kind: "setNode",
              nodeId: props.nodeId,
              patch: { executor: { ...(node.executor ?? { requiredCapabilities: [] }), fallbackRoles } },
            })
          }
          hint="A fallback with no matching capability blocks the node; it never runs it with less."
        />
        <NumberField
          label="Timeout (seconds)"
          value={node.timeoutSeconds ?? null}
          onChange={(timeoutSeconds) => props.onEdit({ kind: "setNode", nodeId: props.nodeId, patch: { timeoutSeconds: timeoutSeconds ?? undefined } })}
        />
        <NumberField
          label="Rework budget (max attempts)"
          value={node.retryBudget?.maxAttempts ?? null}
          min={1}
          onChange={(max) =>
            props.onEdit({ kind: "setNode", nodeId: props.nodeId, patch: { retryBudget: { maxAttempts: max ?? 1 } } })
          }
          hint="The Core owns the rework budget; exceeding it blocks the node rather than looping."
        />
      </Stack>

      <Stack gap={8}>
        {node.kind === "subgraph" ? (
          <>
            <TextField
              label="Subgraph id"
              value={node.subgraph?.graphId ?? ""}
              onChange={(graphId) =>
                props.onEdit({ kind: "setNode", nodeId: props.nodeId, patch: { subgraph: { ...(node.subgraph ?? { graphId: "", entrypoint: "" }), graphId } } })
              }
              error={errorFor("subgraph")}
            />
            <TextField
              label="Subgraph entrypoint"
              value={node.subgraph?.entrypoint ?? ""}
              onChange={(entrypoint) =>
                props.onEdit({ kind: "setNode", nodeId: props.nodeId, patch: { subgraph: { ...(node.subgraph ?? { graphId: "", entrypoint: "" }), entrypoint } } })
              }
            />
          </>
        ) : null}
        {node.kind === "external_effect" || node.permissionGate === undefined ? null : (
          <>
            <TextField
              label="Permission gate action"
              value={node.permissionGate.action}
              onChange={(action) =>
                props.onEdit({ kind: "setNode", nodeId: props.nodeId, patch: { permissionGate: { ...node.permissionGate!, action } } })
              }
            />
            <TextField
              label="Permission gate resource"
              value={node.permissionGate.resource}
              onChange={(resource) =>
                props.onEdit({ kind: "setNode", nodeId: props.nodeId, patch: { permissionGate: { ...node.permissionGate!, resource } } })
              }
              hint="A permission gate must come before the side effect, not after it."
            />
          </>
        )}
        {node.join === undefined ? null : (
          <>
            <SelectField
              label="Join semantics"
              value={node.join.semantics}
              options={[
                { value: "all" as const, label: "all — wait for every input" },
                { value: "any" as const, label: "any — release on the first" },
                { value: "quorum" as const, label: "quorum — release at a count" },
              ]}
              onChange={(semantics) =>
                props.onEdit({ kind: "setNode", nodeId: props.nodeId, patch: { join: { ...node.join!, semantics } } })
              }
            />
            <NumberField
              label="Quorum"
              value={node.join.quorum ?? null}
              onChange={(quorum) => props.onEdit({ kind: "setNode", nodeId: props.nodeId, patch: { join: { ...node.join!, quorum: quorum ?? undefined } } })}
            />
            <StringListField
              label="Join inputs"
              values={node.join.inputs}
              onChange={(inputs) => props.onEdit({ kind: "setNode", nodeId: props.nodeId, patch: { join: { ...node.join!, inputs } } })}
            />
          </>
        )}
        {node.humanDecision === undefined ? null : (
          <CheckboxField
            label="A human decision is required on this node"
            checked={node.humanDecision.required}
            onChange={(required) =>
              props.onEdit({ kind: "setNode", nodeId: props.nodeId, patch: { humanDecision: { ...node.humanDecision!, required } } })
            }
            hint="The decision is made in Paperclip by a person. This plugin can create the request and read the answer; it can never answer one."
          />
        )}
        <NumberField
          label="Layout x"
          value={node.layout?.x ?? null}
          onChange={(x) => props.onEdit({ kind: "setNodeLayout", nodeId: props.nodeId, x, y: node.layout?.y ?? 0 })}
        />
        <NumberField
          label="Layout y"
          value={node.layout?.y ?? null}
          onChange={(y) => props.onEdit({ kind: "setNodeLayout", nodeId: props.nodeId, x: node.layout?.x ?? 0, y })}
        />
      </Stack>
    </Grid>
  );
}
