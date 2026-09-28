/**
 * Live-stream hints plus authoritative re-reads.
 *
 * `usePluginStream` is a *notification*, not a data source. The host accumulates whatever the
 * worker pushes and hands it over as a growing array, with no delivery guarantee, no resume
 * cursor, and no way to ask what was missed. Treating that as truth is how a UI ends up showing
 * a confident, wrong, gap-filled run.
 *
 * So the rule here is:
 *
 * * Any stream event, any reconnect, and every manual refresh re-reads the run through the
 *   bridge: the snapshot plus events after the last applied `eventSequence`. The stream's only
 *   job is to say "a re-read is probably worth it".
 * * `lastAppliedSequence` is displayed. It is the highest event sequence this view has actually
 *   incorporated, not the highest sequence anyone has mentioned.
 * * A discontinuity in `eventSequence` is *surfaced*. When the stream skips a range, or when the
 *   Core's authoritative `eventSequence` is ahead of what the view holds, the gap is named. The
 *   view below the banner is the Core's snapshot, not a reconstruction, and it says which.
 *
 * A dropped SSE connection is therefore not a degraded mode: it degrades to "polling on demand",
 * and a complete snapshot is always one click — or one reconnect — away.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePluginStream } from "@paperclipai/plugin-sdk/ui";
import type { DomainEvent, RunSnapshot } from "@polyforge/protocol";
import { usePolyForgeScope, useRunEvents, useRunSnapshot, type BridgeFailure } from "./usePolyForge.js";

/** The stream channel for a run. The only place a channel string is formed. */
export function runChannel(runId: string | null): string {
  // An inert channel for "no run selected". The worker does not have to emit on it; the point is
  // that the hook is still called, so React's hook order does not change with the selection.
  return `run:${runId ?? "none"}`;
}

/** A pushed event. Every field is optional: the UI uses it only as "something may have changed". */
export interface RunStreamHint {
  readonly runId?: string;
  readonly type?: string;
  readonly eventSequence?: number;
  readonly stateVersion?: number;
}

export type StreamPhase = "idle" | "connecting" | "live" | "recovering" | "disconnected";

/** A range of event sequences the view does not hold. Rendered, never silently filled. */
export interface StreamGap {
  readonly from: number;
  readonly to: number;
  readonly detectedAt: string;
  readonly cause: "stream_skip" | "snapshot_ahead";
}

export interface SnapshotEvent {
  readonly seq: number;
  readonly type: string;
  readonly at: string;
  readonly runId: string;
  readonly payload: Record<string, unknown>;
}

export interface SnapshotStream {
  readonly phase: StreamPhase;
  readonly connected: boolean;
  readonly recovering: boolean;
  /** Highest `DomainEvent.seq` incorporated into the rendered view. */
  readonly lastAppliedSequence: number;
  /** `eventSequence` from the authoritative snapshot. Normally >= `lastAppliedSequence`. */
  readonly authoritativeSequence: number;
  readonly authoritativeStateVersion: number;
  /** The open gap, or `null` when the view is contiguous with the Core. */
  readonly gap: StreamGap | null;
  /** How many discontinuities this view has seen. Retained after a clean catch-up. */
  readonly gapsObserved: number;
  readonly lastRecoveredAt: string | null;
  /** A failure of the re-read itself. A dropped *stream* is not one; it is `phase`. */
  readonly failure: BridgeFailure | null;
  /** True when the Core is ahead of this view even with no open gap. */
  readonly behind: boolean;
  recover(): void;
}

export interface SnapshotStreamOptions {
  readonly runId: string | null;
  /** Called with the authoritative snapshot whenever a re-read completes. */
  readonly onSnapshot: (snapshot: RunSnapshot) => void;
  /** Called with newly incorporated events, in sequence order, never including a repeat. */
  readonly onEvents: (events: readonly SnapshotEvent[]) => void;
}

function toSnapshotEvent(event: DomainEvent): SnapshotEvent {
  return { seq: event.seq, type: event.type, at: event.at, runId: event.runId, payload: event.payload };
}

/**
 * Subscribe to a run's stream and re-read the authoritative state on every hint.
 *
 * `appliedRef` and `seenSeqsRef` are refs rather than state because they are read inside effects
 * that must not re-subscribe when they change; only the rendered `lastAppliedSequence` needs to
 * be state.
 */
export function useSnapshotStream(options: SnapshotStreamOptions): SnapshotStream {
  const { runId, onSnapshot, onEvents } = options;
  const scope = usePolyForgeScope();

  // Called unconditionally, with an inert channel when no run is selected.
  const stream = usePluginStream<RunStreamHint>(runChannel(runId), { companyId: scope.companyId ?? undefined });

  const [applied, setApplied] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [authoritative, setAuthoritative] = useState({ eventSequence: 0, stateVersion: 0 });
  const [gap, setGap] = useState<StreamGap | null>(null);
  const [gapsObserved, setGapsObserved] = useState(0);
  const [lastRecoveredAt, setLastRecoveredAt] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [failure, setFailure] = useState<BridgeFailure | null>(null);

  const appliedRef = useRef(0);
  const seenSeqsRef = useRef<Set<number>>(new Set<number>());
  const lastEventRef = useRef<unknown>(null);
  const wasConnectedRef = useRef(false);
  const onSnapshotRef = useRef(onSnapshot);
  const onEventsRef = useRef(onEvents);
  onSnapshotRef.current = onSnapshot;
  onEventsRef.current = onEvents;

  const snapshot = useRunSnapshot(runId);
  const events = useRunEvents(runId, cursor);

  const { refresh: refreshSnapshot, failure: snapshotFailure } = snapshot;
  const { refresh: refreshEvents, failure: eventsFailure, data: eventPage } = events;

  const recover = useCallback(() => {
    if (runId === null || !scope.scoped) return;
    setRecovering(true);
    setFailure(null);
    refreshSnapshot();
    refreshEvents();
  }, [runId, scope.scoped, refreshSnapshot, refreshEvents]);

  // A new run starts from zero. Carrying the previous run's sequence forward would hide this
  // run's first events behind a cursor this run never had.
  useEffect(() => {
    appliedRef.current = 0;
    seenSeqsRef.current = new Set<number>();
    lastEventRef.current = null;
    wasConnectedRef.current = false;
    setApplied(0);
    setCursor(0);
    setAuthoritative({ eventSequence: 0, stateVersion: 0 });
    setGap(null);
    setFailure(null);
  }, [runId]);

  // Any hint means "re-read", never "apply this payload". A dropped connection, a duplicate, and
  // an out-of-order delivery all land in the same place: the Core is asked again.
  const lastEvent = stream.lastEvent;
  useEffect(() => {
    if (lastEvent === null) return;
    if (lastEvent === lastEventRef.current) return;
    lastEventRef.current = lastEvent;
    recover();
  }, [lastEvent, recover]);

  // A reconnect is the most important case: whatever was missed while the socket was down is
  // exactly what this re-read recovers.
  const connected = stream.connected;
  useEffect(() => {
    if (connected && !wasConnectedRef.current) recover();
    wasConnectedRef.current = connected;
  }, [connected, recover]);

  // Apply the event page. Deduplicated by `seq`: the host can hand back the same page across a
  // param change, and a repeated event in a reviewer's timeline misstates what the Core recorded.
  useEffect(() => {
    if (runId === null || eventPage === null) return;
    const list = Array.isArray(eventPage.events) ? eventPage.events : [];
    if (list.length === 0) return;
    const ordered = [...list].sort((a, b) => a.seq - b.seq);
    const fresh = ordered.filter((event) => !seenSeqsRef.current.has(event.seq));
    if (fresh.length === 0) return;

    const before = appliedRef.current;
    const firstSeq = fresh[0]?.seq ?? before;
    if (firstSeq > before + 1) {
      setGap({ from: before + 1, to: firstSeq - 1, detectedAt: new Date().toISOString(), cause: "stream_skip" });
      setGapsObserved((count) => count + 1);
    }
    const seen = new Set(seenSeqsRef.current);
    for (const event of fresh) seen.add(event.seq);
    seenSeqsRef.current = seen;
    const next = fresh[fresh.length - 1]?.seq ?? before;
    appliedRef.current = next;
    setApplied(next);
    // Advancing the cursor changes the `run-events` params, which makes the host re-read from
    // the new position. That terminates: an exhausted page is empty, and an empty page does not
    // advance the cursor again.
    setCursor(next);
    onEventsRef.current(fresh.map(toSnapshotEvent));
  }, [eventPage, runId]);

  // Apply the authoritative snapshot. This is the only thing that writes the rendered run state.
  const snapshotData = snapshot.data;
  useEffect(() => {
    if (runId === null || snapshotData === null) return;
    setAuthoritative({ eventSequence: snapshotData.eventSequence, stateVersion: snapshotData.stateVersion });
    if (snapshotData.eventSequence > appliedRef.current) {
      setGap({
        from: appliedRef.current + 1,
        to: snapshotData.eventSequence,
        detectedAt: new Date().toISOString(),
        cause: "snapshot_ahead",
      });
      setGapsObserved((count) => count + 1);
    }
    setLastRecoveredAt(new Date().toISOString());
    setRecovering(false);
    onSnapshotRef.current(snapshotData);
  }, [snapshotData, runId]);

  useEffect(() => {
    setFailure(snapshotFailure ?? eventsFailure);
  }, [snapshotFailure, eventsFailure]);

  const connecting = stream.connecting;
  const phase = useMemo<StreamPhase>(() => {
    if (runId === null) return "idle";
    if (recovering) return "recovering";
    if (!connected) return connecting ? "connecting" : "disconnected";
    return "live";
  }, [runId, recovering, connected, connecting]);

  return useMemo(
    () => ({
      phase,
      connected,
      recovering,
      lastAppliedSequence: applied,
      authoritativeSequence: authoritative.eventSequence,
      authoritativeStateVersion: authoritative.stateVersion,
      gap,
      gapsObserved,
      lastRecoveredAt,
      failure,
      behind: authoritative.eventSequence > applied,
      recover,
    }),
    [
      phase,
      connected,
      recovering,
      applied,
      authoritative.eventSequence,
      authoritative.stateVersion,
      gap,
      gapsObserved,
      lastRecoveredAt,
      failure,
      recover,
    ],
  );
}
