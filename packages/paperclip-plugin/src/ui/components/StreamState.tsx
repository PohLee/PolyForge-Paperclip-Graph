/**
 * The live-stream status strip, and the gap banner.
 *
 * A dropped SSE connection is not a failure the UI should hide behind a spinner. The three facts
 * a reviewer needs are: is the stream connected, what is the highest event sequence this view has
 * actually applied, and did anything get skipped. The gap banner is the reason this file exists —
 * a gap is *disclosed* here, with the missing range named, and the strip states plainly that what
 * follows is the Core's authoritative snapshot rather than a gap-filled reconstruction.
 */

import type { ReactNode } from "react";
import { formatInstantPair, formatTimestamp } from "../format.js";
import type { SnapshotStream } from "../hooks/useSnapshotStream.js";
import { STATUS_SOURCE_SNAPSHOT } from "../theme.js";
import { Pill } from "./Identifiers.js";
import { Row, Stack } from "./Layout.js";

const PHASE_LABEL: Record<SnapshotStream["phase"], string> = {
  idle: "No run selected",
  connecting: "Opening the live stream…",
  live: "Live stream connected",
  recovering: "Re-reading the authoritative snapshot…",
  disconnected: "Live stream disconnected",
};

export function StreamState(props: { stream: SnapshotStream; runId: string | null }): ReactNode {
  const { stream } = props;
  return (
    <Stack gap={4}>
      <Row gap={6} align="baseline">
        <Pill tone={stream.connected ? "default" : "warning"}>{PHASE_LABEL[stream.phase]}</Pill>
        <Pill>applied event #{stream.lastAppliedSequence}</Pill>
        <Pill tone={stream.behind ? "warning" : "default"}>
          Core is at #{stream.authoritativeSequence}
        </Pill>
        <Pill>state version {stream.authoritativeStateVersion}</Pill>
        <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
          The stream only says "re-read me". Everything on this screen comes from{" "}
          {STATUS_SOURCE_SNAPSHOT.label}.
        </span>
        <button type="button" onClick={stream.recover} disabled={props.runId === null} style={{ marginLeft: "auto" }}>
          Re-read authoritative snapshot
        </button>
      </Row>
      {stream.failure === null ? null : (
        <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--pf-danger, #f87171)" }}>
          The re-read failed: {stream.failure.message} The panel below is the last successful read
          and is stale.
        </p>
      )}
      <StreamGapNotice stream={stream} />
    </Stack>
  );
}

function StreamGapNotice(props: { stream: SnapshotStream }): ReactNode {
  const { stream } = props;
  if (stream.gap === null) {
    return (
      <p role="status" style={{ margin: 0, fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
        Event sequence #{stream.lastAppliedSequence}–#{stream.authoritativeSequence} is contiguous with
        the Core.
        {stream.gapsObserved > 0
          ? ` ${stream.gapsObserved} earlier discontinuity/continuities were observed and recovered from.`
          : ""}
      </p>
    );
  }
  const { gap } = stream;
  return (
    <div
      role="alert"
      style={{
        border: "2px double var(--pf-warn, #fbbf24)",
        borderRadius: 6,
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <strong style={{ fontSize: 12 }}>Event sequence gap</strong>
      <p style={{ margin: 0, fontSize: 12 }}>
        Events <code>#{gap.from}</code> through <code>#{gap.to}</code> were not delivered to this view
        ({gap.cause === "stream_skip" ? "the stream skipped a range" : "the Core is ahead of this view"}),
        detected {formatTimestamp(gap.detectedAt)}. This view applied up to{" "}
        <code>#{stream.lastAppliedSequence}</code>; the Core is at{" "}
        <code>#{stream.authoritativeSequence}</code>.
      </p>
      <p style={{ margin: 0, fontSize: 12 }}>
        <strong>What is on screen below is the Core's authoritative snapshot as of state version{" "}
        {stream.authoritativeStateVersion}</strong>, not a gap-filled reconstruction. The missing
        events were not synthesised and no transition was inferred from them.
      </p>
      <div>
        <button type="button" onClick={stream.recover}>
          Re-read from the Core to catch up
        </button>
      </div>
    </div>
  );
}

/**
 * The sentence a live region should carry after a catch-up.
 *
 * Returned as a string rather than a component so the caller can decide when to re-announce: a
 * screen reader treats identical text as unchanged, so the caller clears and re-sets it rather
 * than re-rendering the same sentence.
 */
export function gapAnnouncementText(stream: SnapshotStream): string | null {
  if (stream.gap !== null) {
    return `Event sequence gap: events ${stream.gap.from} to ${stream.gap.to} were not delivered. The view below is the Core's authoritative snapshot at state version ${stream.authoritativeStateVersion}, not a reconstruction.`;
  }
  if (stream.lastRecoveredAt === null) return null;
  return `Authoritative snapshot re-read at ${formatInstantPair(stream.lastRecoveredAt)}; applied event #${stream.lastAppliedSequence} of #${stream.authoritativeSequence}.`;
}
