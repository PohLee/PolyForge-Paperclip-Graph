/**
 * Runtime control: the *only* mutations a runtime view may offer.
 *
 * The rule this file implements is REQ-GRAPH-07: runtime mode has no structural editing. There is
 * no node insertion, no edge creation, no "edit contract" button, and no status setter. A running
 * instance is a pinned version closure with a durable state; rewiring it in place would be
 * exactly the "silent structural mutation of a live run" the Core refuses to do.
 *
 * The commands that *are* here are all server calls the worker re-authorizes. Hiding a button is
 * not the control, and this code does not pretend otherwise: the copy says "the server decides",
 * every command carries a reason string for the audit log, and a refusal is rendered as a refusal
 * with the server's message. The Core owns the rework budget, so `retry` here is a request.
 */

import { useState, type ReactNode } from "react";
import { RUNTIME_COMMANDS, type RuntimeCommandName } from "./commandSpecs.js";
import { RADIUS, SPACE } from "../theme.js";
import { Pill } from "./Identifiers.js";
import { Row, Stack } from "./Layout.js";
import { Modal } from "./Primitives.js";
import { FailureNotice } from "./BridgeState.js";
import type { ActionResult } from "../hooks/usePolyForge.js";

export interface RuntimeCommandProps {
  runId: string;
  /** Current Core run status; decides which commands are even *offered*. */
  runStatus: string;
  /** Node ids available for a node-scoped command. */
  nodeIds: ReadonlyArray<string>;
  /** Unknown external effects block retry: re-running an unknown effect duplicates it. */
  unknownEffectCount: number;
  /** Pending governance requests block retry on a node awaiting a human. */
  pendingGovernanceCount: number;
  onRunCommand: (params: {
    runId: string;
    command: "pause" | "resume" | "cancel" | "retry" | "resolve_block";
    nodeId?: string;
    reason: string;
  }) => Promise<ActionResult<unknown>>;
  onRetryNode: (params: { runId: string; nodeId?: string; reason: string }) => Promise<ActionResult<unknown>>;
  /** Called after a command the server accepted, so the caller can re-read the snapshot. */
  onApplied: (summary: string) => void;
  /** Opens the platform's own review surface. Navigation only; no engineering decision is taken. */
  onOpenReviewSurface?: (() => void) | undefined;
  busy: boolean;
}

interface PendingCommand {
  readonly name: RuntimeCommandName;
  readonly nodeId: string | null;
}

export function RuntimeCommands(props: RuntimeCommandProps): ReactNode {
  const [pending, setPending] = useState<PendingCommand | null>(null);
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<ActionResult<unknown> | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const availability = RUNTIME_COMMANDS.map((command) => ({
    command,
    ...explainAvailability(command, props),
  }));

  const submit = async () => {
    if (pending === null) return;
    const trimmed = reason.trim();
    if (trimmed.length === 0) return;
    setFailure(null);
    const label = pending.name.replace(/_/g, " ");
    const outcome =
      pending.name === "retry"
        ? await props.onRetryNode({
            runId: props.runId,
            ...(pending.nodeId === null ? {} : { nodeId: pending.nodeId }),
            reason: trimmed,
          })
        : await props.onRunCommand({
            runId: props.runId,
            command: commandToWireName(pending.name),
            ...(pending.nodeId === null ? {} : { nodeId: pending.nodeId }),
            reason: trimmed,
          });
    if (outcome.ok) {
      setResult(
        `The server accepted "${label}". Applied: ${outcome.value === undefined ? "reported" : JSON.stringify(outcome.value)}. The screen below still shows the previous snapshot until it is re-read.`,
      );
      setPending(null);
      setReason("");
      props.onApplied(`issued ${label} with reason: ${trimmed}`);
      return;
    }
    setFailure(outcome);
  };

  return (
    <Stack gap={SPACE.xs}>
      <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>
        A running instance is a pinned version closure. Its structure is not editable here and the
        Core will not accept one. Every button below is a request the server re-authorizes against
        your identity, the run's recorded scope, and its state version; this panel does not decide
        whether you may.
      </p>
      <div style={{ display: "flex", gap: SPACE.xs, flexWrap: "wrap" }}>
        {availability.map((entry) => (
          <button
            key={entry.command.name}
            type="button"
            disabled={entry.available !== true || props.busy}
            aria-describedby={`cmd-${entry.command.name}-note`}
            onClick={() => {
              setFailure(null);
              setResult(null);
              setPending({
                name: entry.command.name,
                nodeId: entry.command.nodeScoped ? (props.nodeIds[0] ?? null) : null,
              });
              setReason("");
            }}
            style={{
              cursor: entry.available === true && !props.busy ? "pointer" : "not-allowed",
              opacity: entry.available === true ? 1 : 0.55,
            }}
          >
            {entry.command.label}
          </button>
        ))}
        {props.onOpenReviewSurface === undefined ? null : (
          <button
            type="button"
            onClick={props.onOpenReviewSurface}
            style={{ cursor: "pointer" }}
            title="Opens Paperclip's own review surface. A human decision is made there, by a person."
          >
            Open the platform review surface
          </button>
        )}
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 2 }}>
        {availability.map((entry) => (
          <li key={`${entry.command.name}-note`} id={`cmd-${entry.command.name}-note`} style={{ fontSize: 11 }}>
            <Row gap={4} align="baseline">
              <strong>{entry.command.label}:</strong>
              <span style={{ color: entry.available === true ? "var(--pf-muted, #6b7280)" : "var(--pf-warn, #fbbf24)" }}>
                {entry.available === true ? entry.command.effect : entry.reason}
              </span>
            </Row>
          </li>
        ))}
      </ul>

      {failure === null || failure.ok ? null : <FailureNotice failure={failure.failure} />}
      {result === null ? null : (
        <p role="status" style={{ margin: 0, fontSize: 12 }}>
          {result}
        </p>
      )}

      {pending === null ? null : (
        <Modal
          title={`${RUNTIME_COMMANDS.find((c) => c.name === pending.name)?.label ?? pending.name} — confirm with a reason`}
          onClose={() => setPending(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={reason.trim().length === 0}
                title={reason.trim().length === 0 ? "A reason is required: it goes into the audit log" : undefined}
              >
                Send to the server
              </button>
              <button type="button" onClick={() => setPending(null)}>
                Cancel
              </button>
            </>
          }
        >
          <div style={{ border: "1px solid var(--pf-border, rgba(127,127,127,0.3))", borderRadius: RADIUS.sm, padding: SPACE.sm }}>
            <p style={{ margin: 0, fontSize: 12 }}>
              {RUNTIME_COMMANDS.find((c) => c.name === pending.name)?.effect}
            </p>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>
              Run <code>{props.runId}</code>
              {pending.nodeId === null ? null : (
                <>
                  {" "}
                  · node <code>{pending.nodeId}</code>
                </>
              )}
            </p>
          </div>
          {pending.name === "retry" && props.nodeIds.length > 0 ? (
            <NodeScopePicker
              nodeIds={props.nodeIds}
              value={pending.nodeId}
              onChange={(nodeId) => setPending({ ...pending, nodeId })}
            />
          ) : null}
          <ReasonField value={reason} onChange={setReason} />
          <p style={{ margin: 0, fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
            The reason is stored with the command. A command without one cannot be audited, and an
            unauditable change to a running instance is not something this plugin will do.
          </p>
        </Modal>
      )}
    </Stack>
  );
}

function ReasonField(props: { value: string; onChange: (value: string) => void }): ReactNode {
  const id = "pf-runtime-reason";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <label htmlFor={id} style={{ fontSize: 12, fontWeight: 600 }}>
        Reason (required, recorded for audit)
      </label>
      <textarea
        id={id}
        rows={3}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        aria-required="true"
        aria-invalid={props.value.trim().length === 0 ? true : undefined}
        style={{ fontSize: 12 }}
      />
    </div>
  );
}

function NodeScopePicker(props: {
  nodeIds: ReadonlyArray<string>;
  value: string | null;
  onChange: (nodeId: string) => void;
}): ReactNode {
  const id = "pf-runtime-node";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <label htmlFor={id} style={{ fontSize: 12, fontWeight: 600 }}>
        Node
      </label>
      <select
        id={id}
        value={props.value ?? ""}
        onChange={(event) => props.onChange(event.target.value)}
        style={{ fontSize: 12 }}
      >
        <option value="">(every eligible node in this run)</option>
        {props.nodeIds.map((nodeId) => (
          <option key={nodeId} value={nodeId}>
            {nodeId}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Map a UI command name onto the wire command the Core accepts. */
function commandToWireName(name: RuntimeCommandName): "pause" | "resume" | "cancel" | "retry" | "resolve_block" {
  switch (name) {
    case "pause":
      return "pause";
    case "resume":
      return "resume";
    case "cancel":
      return "cancel";
    case "retry":
      return "retry";
    case "retry_node":
      return "retry";
    case "resolve_block":
      return "resolve_block";
  }
}

/**
 * Why a command is or is not offered.
 *
 * These are *offer* rules, not authorization. The server decides. A command disabled here because
 * a precondition is visibly false is a courtesy; a command enabled here that the server refuses is
 * the authorization working, and it is rendered as such rather than hidden.
 */
function explainAvailability(
  command: (typeof RUNTIME_COMMANDS)[number],
  props: RuntimeCommandProps,
): { available: boolean; reason: string } {
  switch (command.name) {
    case "pause":
      return withCondition(props.runStatus !== "COMPLETED" && props.runStatus !== "CANCELLED", "the run has already terminated");
    case "resume":
      return withCondition(props.runStatus === "PAUSED" || props.runStatus === "WAITING", "the run is not paused or waiting");
    case "cancel":
      return withCondition(props.runStatus !== "COMPLETED" && props.runStatus !== "CANCELLED", "the run has already terminated");
    case "retry":
      return withCondition(
        props.unknownEffectCount === 0,
        `${props.unknownEffectCount} external effect(s) have an unknown outcome; reconcile before retrying anything`,
      );
    case "retry_node":
      return withCondition(
        props.unknownEffectCount === 0 && props.pendingGovernanceCount === 0,
        props.unknownEffectCount > 0
          ? `${props.unknownEffectCount} external effect(s) have an unknown outcome; reconcile before retrying`
          : `${props.pendingGovernanceCount} governance request(s) are outstanding; a human decision is still open`,
      );
    case "resolve_block":
      return withCondition(props.nodeIds.length > 0, "no node in this run is blocked");
  }
}

function withCondition(condition: boolean, unmet: string): { available: boolean; reason: string } {
  return condition
    ? { available: true, reason: "" }
    : { available: false, reason: `not offered: ${unmet}. The server would refuse it anyway.` };
}

/** A short list of what the run is waiting on, for the panel header. */
export function WaitingSummary(props: {
  pendingGovernance: ReadonlyArray<{ requestId: string; nodeId: string; semanticKind: string; decisionTargetHash: string }>;
  blockers: ReadonlyArray<{ code: string; reason: string; message: string }>;
}): ReactNode {
  if (props.pendingGovernance.length === 0 && props.blockers.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>
        No outstanding governance request and no recorded blocker.
      </p>
    );
  }
  return (
    <Stack gap={4}>
      {props.pendingGovernance.map((request) => (
        <Row key={request.requestId} gap={6} align="baseline">
          <Pill tone="warning">awaiting a human</Pill>
          <span style={{ fontSize: 12 }}>
            node <code>{request.nodeId}</code> · {request.semanticKind}
          </span>
          <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
            decided against target <code>{request.decisionTargetHash}</code> — a resolution only counts
            if it re-reads the provider object and matches this hash.
          </span>
        </Row>
      ))}
      {props.blockers.map((blocker) => (
        <Row key={`${blocker.code}:${blocker.reason}`} gap={6} align="baseline">
          <Pill tone="problem">{blocker.code}</Pill>
          <span style={{ fontSize: 12 }}>{blocker.message}</span>
        </Row>
      ))}
    </Stack>
  );
}
