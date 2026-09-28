/**
 * The five states every data panel can be in.
 *
 * REQ-UI-04 asks for "no data, loading, no permission, disconnected, version conflict" as
 * *distinct* states. A panel that collapses them into an empty box is the specific defect the
 * requirement names, so this file renders each one in words, with the server's own message, and
 * gives the reader something to do.
 *
 * The `reserveSpace` flag is what keeps a dashboard widget from reflowing as it loads: the
 * skeleton has the same box as the loaded state, so nothing below it jumps.
 */

import type { ReactNode } from "react";
import { JsonTree, Spinner, StatusBadge } from "@paperclipai/plugin-sdk/ui";
import { failureHeadline, type BridgeFailure, type PolyForgeQuery } from "../hooks/usePolyForge.js";
import { RADIUS, SPACE } from "../theme.js";
import { Row, Stack } from "./Layout.js";

const TONE_BY_KIND = {
  not_permitted: "warning",
  unreachable: "error",
  conflict: "warning",
  refused: "error",
  unknown: "warning",
} as const;

/**
 * A failure, rendered as a state rather than an exception.
 *
 * The message is shown verbatim and the `details` object is rendered as a tree, because a
 * refusal whose blocker detail is dropped is indistinguishable from a bug. The remedy line is
 * never empty: a dead end with no next step is a defect.
 */
export function FailureNotice(props: {
  failure: BridgeFailure;
  onRetry?: (() => void) | undefined;
  children?: ReactNode;
}): ReactNode {
  const tone = TONE_BY_KIND[props.failure.kind];
  return (
    <div
      role="group"
      aria-label={failureHeadline(props.failure)}
      style={{
        border: `1px solid var(--pf-${tone === "error" ? "danger" : "warn"}, ${tone === "error" ? "#f87171" : "#fbbf24"})`,
        borderStyle: props.failure.kind === "conflict" ? "double" : "solid",
        borderWidth: props.failure.kind === "conflict" ? 3 : 1,
        borderRadius: RADIUS.md,
        padding: SPACE.md,
        display: "flex",
        flexDirection: "column",
        gap: SPACE.xs,
      }}
    >
      <Row gap={SPACE.xs} align="baseline">
        <strong style={{ fontSize: 13 }}>{failureHeadline(props.failure)}</strong>
        <StatusBadge label={`bridge code ${props.failure.code}`} status={tone} />
      </Row>
      <p style={{ margin: 0, fontSize: 12 }}>{props.failure.message}</p>
      <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>{props.failure.remedy}</p>
      {props.failure.detail === null ? null : (
        <details>
          <summary style={{ fontSize: 12, cursor: "pointer" }}>Bridge error detail</summary>
          <JsonTree data={props.failure.detail} defaultExpandDepth={3} />
        </details>
      )}
      {props.children}
      {props.onRetry === undefined ? null : (
        <div>
          <button type="button" onClick={props.onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

/** Shown when the host has not told us which company to act in. Not an error, not an empty list. */
export function UnscopedNotice(): ReactNode {
  return (
    <div
      style={{
        border: "1px dashed var(--pf-border, rgba(127,127,127,0.4))",
        borderRadius: RADIUS.md,
        padding: SPACE.md,
        fontSize: 12,
      }}
    >
      <strong>No company selected.</strong> PolyForge scopes every read and every write to the
      company the host is currently showing. Open a company and this panel will load; the plugin
      will not fall back to a company it was not given.
    </div>
  );
}

/** The loading state. `reserveSpace` keeps the box from collapsing while data arrives. */
export function LoadingNotice(props: { label: string; reserveSpace?: boolean }): ReactNode {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        minHeight: props.reserveSpace === true ? 56 : undefined,
        display: "flex",
        alignItems: "center",
        gap: SPACE.sm,
        fontSize: 12,
        color: "var(--pf-muted, #6b7280)",
      }}
    >
      <Spinner size="sm" label={props.label} />
      <span>{props.label}…</span>
    </div>
  );
}

/** A successful read that produced nothing. Named, so it is never confused with a failure. */
export function EmptyNotice(props: { what: string; detail?: string }): ReactNode {
  return (
    <div
      style={{
        border: "1px dashed var(--pf-border, rgba(127,127,127,0.35))",
        borderRadius: RADIUS.md,
        padding: SPACE.md,
        fontSize: 12,
      }}
    >
      <strong>Nothing to show.</strong> {props.what}
      {props.detail === undefined ? null : <> {props.detail}</>}
    </div>
  );
}

export interface QueryBoundaryProps<T> {
  query: PolyForgeQuery<T>;
  /** Noun phrase for the empty state, e.g. "no graph has been published yet". */
  empty: string;
  loadingLabel: string;
  children: (data: T) => ReactNode;
  reserveSpace?: boolean;
}

/**
 * One place that decides which of the five states a panel is in.
 *
 * Order matters: an unscoped host and a failure both outrank a spinner, because a request that
 * cannot be scoped must not be shown as in-flight.
 */
export function QueryBoundary<T>(props: QueryBoundaryProps<T>): ReactNode {
  const { query } = props;
  if (query.unscoped) return <UnscopedNotice />;
  if (query.failure !== null) return <FailureNotice failure={query.failure} onRetry={query.refresh} />;
  if (query.data === null) return <LoadingNotice label={props.loadingLabel} reserveSpace={props.reserveSpace} />;
  if (query.empty) return <EmptyNotice what={props.empty} />;
  return <>{props.children(query.data)}</>;
}

/** For a panel that is allowed to render stale data alongside a live failure. */
export function QueryWithStale<T>(props: {
  query: PolyForgeQuery<T>;
  empty: string;
  loadingLabel: string;
  children: (data: T) => ReactNode;
}): ReactNode {
  if (props.query.unscoped) return <UnscopedNotice />;
  if (props.query.data === null) {
    if (props.query.failure !== null) {
      return <FailureNotice failure={props.query.failure} onRetry={props.query.refresh} />;
    }
    return <LoadingNotice label={props.loadingLabel} />;
  }
  return (
    <Stack>
      {props.query.failure === null ? null : (
        <FailureNotice failure={props.query.failure} onRetry={props.query.refresh}>
          <p style={{ margin: 0, fontSize: 12 }}>
            The panel below is the last successful read. It is <strong>stale</strong> and must not be
            read as current state.
          </p>
        </FailureNotice>
      )}
      {props.children(props.query.data)}
    </Stack>
  );
}
