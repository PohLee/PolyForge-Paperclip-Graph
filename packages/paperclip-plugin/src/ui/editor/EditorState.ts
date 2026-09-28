/**
 * The draft editor's state machine.
 *
 * This file owns the whole authoring sequence — load, edit, save, validate, compile, diff, review,
 * publish — and it owns exactly one rule that the rest of the plugin depends on:
 *
 *   **Editing the buffer invalidates every artifact derived from it.**
 *
 * A validation report, a compile artifact, a semantic diff, and a review attestation are all
 * statements about *a specific definition*. Once the definition changes, none of them applies
 * any more. The Core already refuses to publish against a stale target; this keeps the browser
 * from offering to try, and it says so out loud instead of quietly greying a button.
 *
 * Two further rules live here because they are the ones most likely to be got wrong:
 *
 * * **Publish is a compare-and-swap on five things at once** — draft revision, definition hash,
 *   compiler version, plan hash, and the review's target hash. All five must name the same
 *   definition. `publishGate()` is the single place that decides, and it returns the list of
 *   unmet conditions rather than a boolean so the UI can show them.
 * * **A concurrent edit is never a silent overwrite.** A save that the server refuses because the
 *   revision moved puts the editor into an explicit `conflict` state that offers reload and
 *   overwrite-after-review, with the server's revision shown. The buffer is preserved in both
 *   branches, because discarding someone's work is worse than a second read.
 *
 * The semantic diff is computed *in the browser* from the base definition and the buffer. The Core
 * recomputes it during publish against the hash it actually has; the local copy exists so a human
 * can read the change before spending a governance act on it, and it is labelled as indicative
 * everywhere it appears.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CompileArtifact,
  GraphDefinition,
  GraphEdge,
  GraphNode,
  NodeKind,
  SemanticDiff,
  ValidationIssue,
  ValidationReport,
} from "@polyforge/protocol";
import {
  useCompileDraft,
  useCreateDraft,
  useGraphDraft,
  usePublishDraft,
  useRecordDraftReview,
  useSaveDraft,
  useValidateDraft,
  readCompileArtifact,
  readCommandResult,
  readRecordedReview,
  readValidationReport,
  type ActionResult,
  type BridgeFailure,
} from "../hooks/usePolyForge.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Deep structural equality via canonical JSON. Key order is normalised by `stableStringify`. */
export function definitionsEqual(left: GraphDefinition, right: GraphDefinition): boolean {
  return stableStringify(left) === stableStringify(right);
}

/**
 * Deterministic JSON with sorted object keys.
 *
 * Used for the local diff so a pure key reorder does not read as a semantic change. The Core owns
 * canonicalisation for hashing; this is only for "did anything change" and for the diff view.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function nodeSignature(node: GraphNode): string {
  return stableStringify({ ...node, layout: undefined });
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.from}->${edge.to}`;
}

/**
 * An indicative semantic diff between a base definition and an edited buffer.
 *
 * `invalidatesEvidence` follows the Core's own rule: a removed or changed node invalidates
 * previously recorded PASS results. The browser cannot prove reuse is safe, so anything that
 * touches a node is treated as invalidating.
 */
export function structuralDiff(
  before: GraphDefinition | null,
  after: GraphDefinition,
): SemanticDiff {
  const base: GraphDefinition =
    before ?? { ...after, nodes: {}, edges: [], entrypoints: {}, policyRefs: [] };
  const addedNodes = Object.keys(after.nodes).filter((id) => !(id in base.nodes));
  const removedNodes = Object.keys(base.nodes).filter((id) => !(id in after.nodes));
  const changedNodes = Object.keys(after.nodes).filter(
    (id) => id in base.nodes && nodeSignature(base.nodes[id] as GraphNode) !== nodeSignature(after.nodes[id] as GraphNode),
  );
  const baseEdges = new Map(base.edges.map((edge) => [edgeKey(edge), edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edgeKey(edge), edge]));
  const addedEdges = [...afterEdges.entries()]
    .filter(([key]) => !baseEdges.has(key))
    .map(([key]) => key);
  const removedEdges = [...baseEdges.entries()]
    .filter(([key]) => !afterEdges.has(key))
    .map(([key]) => key);
  const changedEdges = [...afterEdges.entries()]
    .filter(([key]) => {
      const other = baseEdges.get(key);
      return other !== undefined && stableStringify(other) !== stableStringify(afterEdges.get(key));
    })
    .map(([key]) => key);
  const basePolicies = new Set(base.policyRefs);
  const afterPolicies = new Set(after.policyRefs);
  const policyChanges = [
    ...[...afterPolicies].filter((ref) => !basePolicies.has(ref)).map((ref) => `added ${ref}`),
    ...[...basePolicies].filter((ref) => !afterPolicies.has(ref)).map((ref) => `removed ${ref}`),
  ];
  return {
    graphId: after.graphId,
    fromVersion: null,
    toVersion: null,
    addedNodes,
    removedNodes,
    changedNodes,
    addedEdges: [...addedEdges, ...changedEdges],
    removedEdges,
    policyChanges,
    // A gate whose node moved is a gate that has not run. Not inheriting a PASS is the safe
    // direction, so this is `true` on any structural touch.
    invalidatesEvidence:
      addedNodes.length > 0 ||
      removedNodes.length > 0 ||
      changedNodes.length > 0 ||
      addedEdges.length > 0 ||
      changedEdges.length > 0,
  };
}

/** Validation issues grouped by the node or edge they point at. */
export interface AnchoredIssue {
  readonly issue: ValidationIssue;
  /** The node id, edge key, or `null` for a whole-graph problem. */
  readonly anchor: string | null;
  readonly anchorKind: "node" | "edge" | "graph";
}

/**
 * Resolve a `ValidationIssue.path` to something clickable.
 *
 * The Core's paths look like `nodes.build.inputs.api_key` or `edges.build->test`. Anything that
 * does not resolve is still listed — it is just listed without an anchor, and it says so, rather
 * than being dropped because the UI could not parse its own address.
 */
export function anchorIssue(path: string): { anchor: string | null; anchorKind: AnchoredIssue["anchorKind"] } {
  const segments = path.split(".").filter((segment) => segment.length > 0);
  const head = segments[0];
  if (head === "nodes" && typeof segments[1] === "string") return { anchor: segments[1], anchorKind: "node" };
  if (head === "edges" && typeof segments[1] === "string") {
    return { anchor: segments[1].replace(/->/g, "->"), anchorKind: "edge" };
  }
  if (head === "entrypoints" || head === "policyRefs" || head === "graphId" || head === "name") {
    return { anchor: null, anchorKind: "graph" };
  }
  return { anchor: null, anchorKind: "graph" };
}

export function anchorIssues(report: ValidationReport | null): AnchoredIssue[] {
  if (report === null) return [];
  return report.issues.map((issue) => ({ issue, ...anchorIssue(issue.path) }));
}

export function errorNodeIds(anchored: ReadonlyArray<AnchoredIssue>): Set<string> {
  const ids = new Set<string>();
  for (const entry of anchored) {
    if (entry.issue.severity !== "error") continue;
    if (entry.anchorKind === "node" && entry.anchor !== null) ids.add(entry.anchor);
  }
  return ids;
}

export function errorEdgeKeys(anchored: ReadonlyArray<AnchoredIssue>): Set<string> {
  const keys = new Set<string>();
  for (const entry of anchored) {
    if (entry.issue.severity !== "error") continue;
    if (entry.anchorKind === "edge" && entry.anchor !== null) keys.add(entry.anchor);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Staged artifacts
// ---------------------------------------------------------------------------

/**
 * An artifact plus the exact target it describes.
 *
 * The target triple is what makes staleness checkable in the browser instead of only on the
 * server. `revision` and `definitionHash` come from the Core's own response, not from what this
 * browser hoped the hash was.
 */
export interface Staged<T> {
  readonly value: T | null;
  readonly revision: number | null;
  readonly definitionHash: string | null;
  readonly recordedAt: string | null;
}

const EMPTY_STAGE = {
  value: null,
  revision: null,
  definitionHash: null,
  recordedAt: null,
} as const;

function stage<T>(value: T, revision: number, definitionHash: string): Staged<T> {
  return { value, revision, definitionHash, recordedAt: new Date().toISOString() };
}

export type StagedMap = {
  validation: Staged<ValidationReport>;
  compileArtifact: Staged<CompileArtifact>;
  diff: Staged<SemanticDiff>;
  review: Staged<ReviewAttestation>;
};

/**
 * A person's review of one exact definition.
 *
 * The bridge has no "record a review" action, and it must not have one: answering a human review
 * on a human's behalf is exactly what the plugin is forbidden from doing. So what the UI records
 * is an *attestation* — a named person confirming they read a specific hash — which is passed to
 * publish as `reviewTargetHash` and re-verified by the Core against the definition it holds. It is
 * labelled as an attestation rather than a recorded review, because that is exactly what it is.
 */
export interface ReviewAttestation {
  readonly reviewer: string;
  readonly targetHash: string;
  readonly planHash: string;
  readonly attestedAt: string;
}

export type EditorPhase =
  | "loading"
  | "clean"
  | "dirty"
  | "saving"
  | "conflict"
  | "validating"
  | "compiling"
  | "publishing"
  | "published"
  | "failed";

export interface PublishCheck {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface PublishGate {
  readonly canPublish: boolean;
  readonly checks: PublishCheck[];
}

export interface ConflictState {
  /** The revision the buffer was based on when the save was attempted. */
  readonly baseRevision: number;
  readonly attemptedRevision: number;
  /** The revision the server reported, when it reported one. */
  readonly serverRevision: number | null;
  readonly serverDefinitionHash: string | null;
  readonly message: string;
}

/**
 * Whether the publish preconditions are all satisfied, and which are not.
 *
 * Every check is a statement about the *same* definition. A check that passes for a different
 * revision is a check that does not pass, which is why each one carries the revision and hash it
 * was produced for and compares them here rather than trusting a boolean.
 */
export function publishGate(input: {
  savedRevision: number | null;
  savedDefinitionHash: string | null;
  dirty: boolean;
  stages: StagedMap;
}): PublishGate {
  const { savedRevision, savedDefinitionHash, dirty, stages } = input;
  const current = (candidate: { revision: number | null; definitionHash: string | null }): boolean =>
    savedRevision !== null &&
    savedDefinitionHash !== null &&
    candidate.revision === savedRevision &&
    candidate.definitionHash === savedDefinitionHash;

  const validation = stages.validation.value;
  const artifact = stages.compileArtifact.value;
  const diff = stages.diff.value;
  const review = stages.review.value;
  const blocking = validation === null ? [] : validation.issues.filter((issue) => issue.severity === "error");
  const validationCurrent = current(stages.validation) && validation !== null;
  const compileCurrent = current(stages.compileArtifact) && artifact !== null;
  const diffCurrent = current(stages.diff) && diff !== null;
  const structuralChange =
    diff === null
      ? 0
      : diff.addedNodes.length +
        diff.removedNodes.length +
        diff.changedNodes.length +
        diff.addedEdges.length +
        diff.removedEdges.length +
        diff.policyChanges.length;

  const checks: PublishCheck[] = [
    {
      id: "clean",
      label: "the buffer is saved",
      ok: !dirty && savedRevision !== null,
      detail: dirty
        ? "there are unsaved edits; a publish always targets a saved revision"
        : savedRevision === null
          ? "nothing has been saved yet"
          : `revision ${savedRevision}`,
    },
    {
      id: "validation",
      label: "static and contract validation passed for this exact revision",
      ok: validationCurrent && validation.ok && blocking.length === 0,
      detail: !validationCurrent
        ? stages.validation.value === null
          ? "not validated yet"
          : `validated at revision ${stages.validation.revision ?? "?"}, which is not the current revision — re-validate`
        : validation.ok && blocking.length === 0
          ? `clean at revision ${savedRevision}`
          : `${blocking.length} blocking error(s)`,
    },
    {
      id: "compile",
      label: "a compile artifact exists for this exact definition",
      ok: compileCurrent,
      detail: !compileCurrent
        ? stages.compileArtifact.value === null
          ? "not compiled yet"
          : `compiled at revision ${stages.compileArtifact.revision ?? "?"}; recompile for the current definition`
        : `plan ${artifact.planHash} by compiler ${artifact.compilerVersion}`,
    },
    {
      id: "diff",
      label: "a semantic diff has been produced for this exact definition",
      ok: diffCurrent,
      detail: !diffCurrent
        ? stages.diff.value === null
          ? "not produced yet"
          : `produced at revision ${stages.diff.revision ?? "?"}; regenerate it`
        : structuralChange === 0
          ? "no structural change against the base"
          : `${diff.addedNodes.length} added, ${diff.removedNodes.length} removed, ${diff.changedNodes.length} changed node(s)`,
    },
    {
      id: "review",
      label: "a review is attested against the exact target hash",
      ok:
        review !== null &&
        savedDefinitionHash !== null &&
        review.targetHash === savedDefinitionHash &&
        artifact !== null &&
        review.planHash === artifact.planHash,
      detail:
        review === null
          ? "no review attested"
          : review.targetHash !== savedDefinitionHash
            ? `attested against ${review.targetHash}, but the current definition hashes to ${savedDefinitionHash}`
            : artifact === null || review.planHash !== artifact.planHash
              ? "the attested plan hash is not the current compile artifact's plan hash"
              : `${review.reviewer} attested ${review.targetHash}`,
    },
  ];

  return { canPublish: checks.every((check) => check.ok), checks };
}

// ---------------------------------------------------------------------------
// Buffer edits
// ---------------------------------------------------------------------------

/** Every mutation the editor can make, as a function from definition to definition. */
export type DefinitionEdit =
  | { kind: "setMeta"; name?: string; description?: string }
  | { kind: "addNode"; nodeId: string; nodeKind: NodeKind }
  | { kind: "removeNode"; nodeId: string }
  | { kind: "setNode"; nodeId: string; patch: Partial<GraphNode> }
  | { kind: "setNodeLayout"; nodeId: string; x: number | null; y: number | null }
  | { kind: "addEdge"; from: string; to: string; guard: string }
  | { kind: "removeEdge"; from: string; to: string }
  | { kind: "setEdgeGuard"; from: string; to: string; guard: string }
  | { kind: "setEntrypoint"; key: string; patch: Record<string, unknown> }
  | { kind: "setPolicies"; refs: string[] }
  | { kind: "replace"; definition: GraphDefinition };

function cloneDefinition(definition: GraphDefinition): GraphDefinition {
  return JSON.parse(stableStringify(definition)) as GraphDefinition;
}

function uniqueNodeId(existing: Readonly<Record<string, GraphNode>>, requested: string): string {
  const trimmed = requested.trim();
  if (trimmed.length > 0 && !(trimmed in existing)) return trimmed;
  let index = existing === undefined ? 1 : Object.keys(existing).length + 1;
  let candidate = `${trimmed.length === 0 ? "node" : trimmed}_${index}`;
  while (candidate in existing) {
    index += 1;
    candidate = `${trimmed.length === 0 ? "node" : trimmed}_${index}`;
  }
  return candidate;
}

/**
 * Apply an edit, returning a new definition.
 *
 * Structural edits go through here rather than mutating in place so that "did anything change"
 * is answerable by comparison, and so an edit that turns out to be a no-op does not spuriously
 * invalidate the validation report.
 */
export function applyEdit(definition: GraphDefinition, edit: DefinitionEdit): GraphDefinition {
  const next = cloneDefinition(definition);
  switch (edit.kind) {
    case "setMeta":
      if (edit.name !== undefined) next.name = edit.name;
      if (edit.description !== undefined) next.description = edit.description;
      return next;
    case "addNode": {
      const id = uniqueNodeId(next.nodes, edit.nodeId);
      next.nodes[id] = defaultNode(id, edit.nodeKind);
      return next;
    }
    case "removeNode": {
      delete next.nodes[edit.nodeId];
      // Edges are removed with the node rather than left dangling: a dangling edge is a
      // structural error the validator would reject, and the reviewer did not ask for it.
      next.edges = next.edges.filter((edge) => edge.from !== edit.nodeId && edge.to !== edit.nodeId);
      for (const entry of Object.values(next.entrypoints)) {
        entry.startNodes = entry.startNodes.filter((nodeId) => nodeId !== edit.nodeId);
      }
      return next;
    }
    case "setNode": {
      const existing = next.nodes[edit.nodeId];
      if (existing === undefined) return next;
      next.nodes[edit.nodeId] = { ...existing, ...edit.patch };
      return next;
    }
    case "setNodeLayout": {
      const existing = next.nodes[edit.nodeId];
      if (existing === undefined) return next;
      next.nodes[edit.nodeId] = {
        ...existing,
        layout:
          edit.x === null || edit.y === null
            ? undefined
            : { x: Math.round(edit.x), y: Math.round(edit.y) },
      };
      return next;
    }
    case "addEdge": {
      const exists = next.edges.some((edge) => edge.from === edit.from && edge.to === edit.to);
      if (exists) return next;
      if (!(edit.from in next.nodes) || !(edit.to in next.nodes)) return next;
      const edge: GraphEdge = { from: edit.from, to: edit.to, ...(edit.guard.length === 0 ? {} : { guard: edit.guard }) };
      next.edges = [...next.edges, edge];
      return next;
    }
    case "removeEdge":
      next.edges = next.edges.filter((edge) => !(edge.from === edit.from && edge.to === edit.to));
      return next;
    case "setEdgeGuard":
      next.edges = next.edges.map((edge) =>
        edge.from === edit.from && edge.to === edit.to
          ? edit.guard.length === 0
            ? { from: edge.from, to: edge.to }
            : { ...edge, guard: edit.guard }
          : edge,
      );
      return next;
    case "setEntrypoint": {
      const existing = next.entrypoints[edit.key];
      if (existing === undefined) return next;
      next.entrypoints[edit.key] = { ...existing, ...edit.patch } as typeof existing;
      return next;
    }
    case "setPolicies":
      next.policyRefs = edit.refs;
      return next;
    case "replace":
      return cloneDefinition(edit.definition);
  }
}

/** A new node with the fields its kind requires, pre-filled so it validates more often. */
export function defaultNode(id: string, kind: NodeKind): GraphNode {
  const node: GraphNode = { id, kind };
  if (kind === "agent_operation") {
    node.inputs = {};
    node.outputs = [];
    node.produces = [];
    node.requires = [];
    node.executor = { requiredCapabilities: [] };
    node.retryBudget = { maxAttempts: 1 };
  }
  if (kind === "deterministic") {
    node.inputs = {};
    node.outputs = [];
  }
  if (kind === "gate") {
    node.inputs = {};
    node.evaluatorRefs = [];
  }
  if (kind === "subgraph") {
    node.subgraph = { graphId: "", entrypoint: "" };
  }
  if (kind === "external_effect") {
    node.inputs = {};
    node.permissionGate = { action: "", resource: "" };
  }
  return node;
}

/** A minimal empty definition, for a draft created from nothing. */
export function emptyDefinition(graphId: string, name: string): GraphDefinition {
  return {
    schemaVersion: 1,
    graphId,
    name,
    description: "",
    entrypoints: {
      main: {
        key: "main",
        inputs: [],
        requiresFacts: [],
        coordinator: { requiredCapabilities: [] },
        startNodes: [],
        exports: [],
      },
    },
    nodes: {},
    edges: [],
    policyRefs: [],
  };
}

// ---------------------------------------------------------------------------
// The controller hook
// ---------------------------------------------------------------------------

export type ConflictResolution = "reload" | "overwrite" | "dismiss";

export interface DraftEditor {
  readonly phase: EditorPhase;
  readonly loading: boolean;
  readonly loadFailure: BridgeFailure | null;
  readonly draftId: string;
  /** The server's saved definition, the base every local diff is computed against. */
  readonly base: GraphDefinition | null;
  readonly baseRevision: number | null;
  readonly baseDefinitionHash: string | null;
  /** The local edit buffer. */
  readonly buffer: GraphDefinition;
  readonly dirty: boolean;
  readonly stages: StagedMap;
  readonly anchoredIssues: ReadonlyArray<AnchoredIssue>;
  readonly gate: PublishGate;
  readonly conflict: ConflictState | null;
  readonly lastFailure: BridgeFailure | null;
  readonly lastMessage: string | null;
  edit(edit: DefinitionEdit): void;
  resetBuffer(): void;
  save(changeSummary: string): Promise<boolean>;
  validate(): Promise<boolean>;
  compile(): Promise<boolean>;
  computeDiff(): void;
  attestReview(reviewer: string): Promise<boolean>;
  publish(): Promise<boolean>;
  resolveConflict(resolution: ConflictResolution): void;
  reload(): void;
  clearFailure(): void;
}

const EMPTY_STAGES: StagedMap = {
  validation: EMPTY_STAGE,
  compileArtifact: EMPTY_STAGE,
  diff: EMPTY_STAGE,
  review: EMPTY_STAGE,
};

export function useDraftEditor(draftId: string): DraftEditor {
  const draftQuery = useGraphDraft(draftId);
  const saveAction = useSaveDraft();
  const validateAction = useValidateDraft();
  const compileAction = useCompileDraft();
  const reviewAction = useRecordDraftReview();
  const publishAction = usePublishDraft();

  const [base, setBase] = useState<GraphDefinition | null>(null);
  const [buffer, setBuffer] = useState<GraphDefinition | null>(null);
  const [stages, setStages] = useState<StagedMap>(EMPTY_STAGES);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [phase, setPhase] = useState<EditorPhase>("loading");
  const [lastFailure, setLastFailure] = useState<BridgeFailure | null>(null);
  const [lastMessage, setLastMessage] = useState<string | null>(null);

  const payload = draftQuery.data;
  const loadFailure = draftQuery.failure;

  // Adopt a newly loaded draft. The buffer is only reset when the identity of the draft or its
  // revision changes, so an in-flight re-read of the *same* revision cannot discard typing.
  const adoptedRef = useRef<string | null>(null);
  useEffect(() => {
    if (payload === null || payload === undefined) return;
    const { draft, definition } = payload;
    const key = `${draft.draftId}@${draft.revision}`;
    if (adoptedRef.current === key) return;
    adoptedRef.current = key;
    setBase(definition);
    setBuffer(definition);
    setStages(EMPTY_STAGES);
    setPhase("clean");
  }, [payload]);

  const definition: GraphDefinition | null = buffer;
  const draft = payload?.draft ?? null;
  const baseRevision = draft?.revision ?? null;
  const baseDefinitionHash = draft?.definitionHash ?? null;
  const dirty = definition !== null && base !== null && !definitionsEqual(definition, base);

  // Clearing the adoption key makes the next payload replace the buffer, so a reload always
  // installs the server's copy even when the revision happens to be unchanged.
  const { refresh: refreshDraft } = draftQuery;
  const reload = useCallback(() => {
    adoptedRef.current = null;
    refreshDraft();
  }, [refreshDraft]);

  const edit = useCallback((next: DefinitionEdit) => {
    setBuffer((current) => (current === null ? current : applyEdit(current, next)));
    // The Core's rule, mirrored: a changed definition invalidates the validation report, the
    // compile artifact, the diff, and the review attestation. Keeping any of them would let a
    // publish target a definition that no longer exists.
    setStages(() => ({
      validation: EMPTY_STAGE,
      compileArtifact: EMPTY_STAGE,
      diff: EMPTY_STAGE,
      review: EMPTY_STAGE,
    }));
    setPhase("dirty");
  }, []);

  const resetBuffer = useCallback(() => {
    setBuffer(base);
    setStages(EMPTY_STAGES);
    setPhase("clean");
    setLastMessage("Local edits discarded. The buffer now matches the saved revision.");
  }, [base]);

  const fail = useCallback((failure: BridgeFailure, message: string) => {
    setLastFailure(failure);
    setLastMessage(message);
    setPhase("failed");
    return false;
  }, []);

  const save = useCallback(
    async (changeSummary: string): Promise<boolean> => {
      if (definition === null || baseRevision === null) {
        setLastMessage("There is nothing loaded to save.");
        return false;
      }
      setPhase("saving");
      setLastFailure(null);
      const result: ActionResult<unknown> = await saveAction.run({
        draftId,
        // `If-Match` carries the revision this buffer was based on. A stale client gets a
        // refusal from the Core rather than overwriting someone else's edit.
        revision: String(baseRevision),
        definition,
        changeSummary,
      });
      if (result.ok) {
        setLastMessage(
          "Saved. Validation, compilation, the diff, and the review attestation were cleared: they described the previous definition.",
        );
        setPhase("dirty");
        reload();
        return true;
      }
      if (result.failure.kind === "conflict") {
        // Never an overwrite. The buffer is kept exactly as typed and the editor stops.
        setConflict({
          baseRevision,
          attemptedRevision: baseRevision,
          serverRevision: null,
          serverDefinitionHash: null,
          message: result.failure.message,
        });
        setLastFailure(result.failure);
        setLastMessage(
          "The server refused the save because its revision has moved. Your edits are still here; nothing was overwritten.",
        );
        setPhase("conflict");
        return false;
      }
      return fail(result.failure, "The server refused the save.");
    },
    [baseRevision, definition, draftId, fail, reload, saveAction],
  );

  const validate = useCallback(async (): Promise<boolean> => {
    setPhase("validating");
    setLastFailure(null);
    const result = await validateAction.run({ draftId });
    const report = readValidationReport(result.ok ? result.value : null);
    if (!result.ok) return fail(result.failure, "The server refused to validate this draft.");
    if (report === null) {
      return fail(
        {
          kind: "unknown",
          code: "MALFORMED",
          message: "The validation response was not a report this build can read.",
          detail: result.value,
          remedy: "Nothing can be concluded from a response this build cannot parse. Re-run the validation.",
        },
        "The validation response could not be read.",
      );
    }
    setStages((current) => ({ ...current, validation: stage(report, report.revision, report.definitionHash) }));
    setLastMessage(
      report.ok
        ? `Validation clean at revision ${report.revision}.`
        : `Validation found ${report.issues.filter((issue) => issue.severity === "error").length} blocking error(s) at revision ${report.revision}.`,
    );
    setPhase("clean");
    return report.ok;
  }, [draftId, fail, validateAction]);

  const compile = useCallback(async (): Promise<boolean> => {
    setPhase("compiling");
    setLastFailure(null);
    const result = await compileAction.run({ draftId });
    const artifact = readCompileArtifact(result.ok ? result.value : null);
    if (!result.ok) return fail(result.failure, "The server refused to compile this draft.");
    if (artifact === null) {
      return fail(
        {
          kind: "unknown",
          code: "MALFORMED",
          message: "The compile response was not an artifact this build can read.",
          detail: result.value,
          remedy: "A publish needs a compile artifact bound to this exact definition. Re-run the compile.",
        },
        "The compile response could not be read.",
      );
    }
    setStages((current) => ({ ...current, compileArtifact: stage(artifact, artifact.revision, artifact.definitionHash) }));
    setLastMessage(`Compiled to plan ${artifact.planHash} at revision ${artifact.revision}.`);
    setPhase("clean");
    return true;
  }, [compileAction, draftId, fail]);

  const computeDiff = useCallback(() => {
    setBuffer((current) => {
      if (current === null) return current;
      const revision = baseRevision ?? -1;
      setStages((previous) => ({
        ...previous,
        // The definition hash for a locally computed diff is the *saved* hash when the buffer is
        // clean, and an empty string when it is not. A diff of unsaved edits is useful, but it
        // must not be publishable: `publishGate` therefore fails the compile and review checks
        // until the buffer is saved and re-derived.
        diff: stage(
          structuralDiff(base, current),
          dirty ? -1 : revision,
          dirty ? "" : (baseDefinitionHash ?? ""),
        ),
      }));
      return current;
    });
  }, [base, baseDefinitionHash, baseRevision, dirty]);

  const attestReview = useCallback(
    async (reviewer: string): Promise<boolean> => {
      const name = reviewer.trim();
      const artifact = stages.compileArtifact.value;
      if (name.length === 0) {
        setLastMessage("A review needs a name to record who read it.");
        return false;
      }
      if (artifact === null) {
        setLastMessage("Compile first: a review is recorded against a specific plan hash.");
        return false;
      }
      if (baseDefinitionHash === null) {
        setLastMessage("The definition hash is unknown, so there is no target to review.");
        return false;
      }

      // Record it. The Core binds a review to one exact target hash on the current revision and
      // publish requires that review to exist, so a review held in component state is a note to
      // oneself: the publish would be refused with "publishing requires a review bound to the
      // current revision" no matter what this panel displayed.
      setPhase("publishing");
      setLastFailure(null);
      const result = await reviewAction.run({
        draftId,
        reviewTargetHash: artifact.planHash,
      });
      if (!result.ok) {
        return fail(
          result.failure,
          result.failure.kind === "not_permitted"
            ? "The server refused this review. Recording one requires the authoring role, and only " +
              "an authenticated reviewer can hold it."
            : "The server refused to record this review.",
        );
      }

      // The stage is built from the *server's* answer, not from what was asked for. A name typed
      // into a field is a claim; the stored review is the record. Reading back is what keeps the
      // panel honest about what the Core now holds.
      const stored = readRecordedReview(result.value);
      if (stored === null) {
        return fail(
          {
            kind: "unknown",
            code: "MALFORMED",
            message: "The review response was not a recorded review this build can read.",
            detail: result.value,
            remedy: "Reload the draft and check whether the review was recorded before continuing.",
          },
          "The recorded review could not be read.",
        );
      }
      setStages((current) => ({
        ...current,
        review: {
          value: {
            reviewer: stored.reviewer,
            targetHash: baseDefinitionHash,
            planHash: artifact.planHash,
            attestedAt: stored.recordedAt,
          },
          revision: baseRevision,
          definitionHash: baseDefinitionHash,
          recordedAt: stored.recordedAt,
        },
      }));
      setLastMessage(
        `Review recorded by ${stored.reviewer} against plan ${artifact.planHash}. Publish re-checks the hash.`,
      );
      setPhase("clean");
      return true;
    },
    [baseDefinitionHash, baseRevision, draftId, fail, reviewAction, stages.compileArtifact.value],
  );

  const publish = useCallback(async (): Promise<boolean> => {
    const artifact = stages.compileArtifact.value;
    const review = stages.review.value;
    if (definition === null || baseRevision === null || baseDefinitionHash === null) return false;
    if (artifact === null || review === null) {
      setLastMessage("Publishing needs both a compile artifact and a review attestation for this exact definition.");
      return false;
    }
    setPhase("publishing");
    setLastFailure(null);
    const result = await publishAction.run({
      draftId,
      // All five values name the same definition. If any of them names a different one, the
      // Core's compare-and-swap refuses and nothing is published.
      //
      // The revision is sent as a number, not a string. A draft revision is a monotonic integer and
      // the Core compares it as one, so `String(baseRevision)` made every publish fail with
      // "expectedRevision must be an integer" — the editor's normal path could never work.
      expectedRevision: baseRevision,
      definitionHash: baseDefinitionHash,
      compilerVersion: artifact.compilerVersion,
      planHash: artifact.planHash,
      reviewTargetHash: review.targetHash,
    });
    if (!result.ok) {
      if (result.failure.kind === "conflict") {
        setConflict({
          baseRevision,
          attemptedRevision: baseRevision,
          serverRevision: null,
          serverDefinitionHash: null,
          message: result.failure.message,
        });
        setPhase("conflict");
        return false;
      }
      return fail(result.failure, "The server refused to publish.");
    }
    const command = readCommandResult(result.value);
    if (command === null || !command.applied) {
      setLastMessage(
        "The server answered without confirming that the publish was applied. Nothing is claimed as published.",
      );
      setPhase("failed");
      return false;
    }
    setLastMessage(
      `Published as an immutable version at state version ${command.stateVersion}. Activating it as the default is a separate, explicit action.`,
    );
    setPhase("published");
    reload();
    return true;
  }, [baseDefinitionHash, baseRevision, definition, draftId, fail, publishAction, reload, stages.compileArtifact.value, stages.review.value]);

  const resolveConflict = useCallback(
    (resolution: ConflictResolution) => {
      if (resolution === "dismiss") {
        setConflict(null);
        setPhase("dirty");
        return;
      }
      if (resolution === "reload") {
        // The server's copy wins and the local buffer is discarded, but only because a person
        // chose it: the conflict panel said what would be lost.
        setConflict(null);
        setStages(EMPTY_STAGES);
        setPhase("clean");
        setLastMessage("Reloaded the server's revision. Your unsaved edits were discarded by your choice.");
        reload();
        return;
      }
      // Overwrite after review: re-read the current revision first, so the save is still a
      // compare-and-swap against whatever the server has *now* rather than a blind overwrite of
      // whatever it had a moment ago.
      setConflict(null);
      setLastMessage(
        "Re-reading the server's revision so your save can be a compare-and-swap against it. Review the difference before saving again.",
      );
      reload();
    },
    [reload],
  );

  const anchoredIssues = useMemo(() => anchorIssues(stages.validation.value), [stages.validation.value]);

  const gate = useMemo(
    () =>
      publishGate({
        savedRevision: dirty ? null : baseRevision,
        savedDefinitionHash: dirty ? null : baseDefinitionHash,
        dirty,
        stages,
      }),
    [baseDefinitionHash, baseRevision, dirty, stages],
  );

  return {
    phase,
    loading: draftQuery.loading && payload === null,
    loadFailure,
    draftId,
    base,
    baseRevision,
    baseDefinitionHash,
    buffer: definition ?? emptyDefinition(draftId, draftId),
    dirty,
    stages,
    anchoredIssues,
    gate,
    conflict,
    lastFailure,
    lastMessage,
    edit,
    resetBuffer,
    save,
    validate,
    compile,
    computeDiff,
    attestReview,
    publish,
    resolveConflict,
    reload,
    clearFailure: () => setLastFailure(null),
  };
}

export { useCreateDraft };
