/**
 * Status rendering.
 *
 * The invariant this file exists to hold: **a reader must be able to read the state with the
 * colour, the shape, or the font switched off.** Each status therefore renders three redundant
 * channels — a glyph (shape), a text label, and a border style — with the host `StatusBadge`
 * supplying the colour so the plugin matches the host's palette instead of inventing one.
 *
 * The fourth channel, provenance, is rendered as visible text rather than a tooltip. A projected
 * Paperclip `done` sitting next to a Core `PASSED` has to be distinguishable *at a glance*,
 * because reading the projection as an engineering pass is the failure this whole UI exists to
 * prevent.
 */

import type { ReactNode } from "react";
import { StatusBadge } from "@paperclipai/plugin-sdk/ui";
import { TONE_COLOR, statusToken, type StatusFamily, type StatusSource, type StatusToken } from "../theme.js";
import { Row, SROnly } from "./Layout.js";

export interface StatusTokenProps {
  /** The raw vocabulary value. `null` renders as "not reported", never as a pass. */
  status: string | null | undefined;
  family?: StatusFamily;
  /** Where the value came from. Rendered as text; omit only inside the legend. */
  source?: StatusSource;
  /** Extra context that qualifies the value, e.g. `graph v12` or `attempt 3`. */
  qualifier?: string;
  /** Hide the provenance caption where the surrounding heading already names the source. */
  hideSource?: boolean;
  title?: string;
}

export function StatusToken(props: StatusTokenProps): ReactNode {
  const token = statusToken(props.status, props.family);
  const colour = TONE_COLOR[token.tone];
  const accessible = [
    props.source === undefined ? null : `from ${props.source.label}`,
    props.qualifier,
    token.label,
    props.status === null || props.status === undefined || props.status.trim().length === 0
      ? "no value was reported"
      : `reported as ${props.status}`,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("; ");

  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "wrap", minWidth: 0 }}
      title={props.title ?? accessible}
    >
      <span
        aria-hidden="true"
        data-tone={token.tone}
        data-shape={token.shape}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          minWidth: 18,
          height: 18,
          padding: "0 3px",
          borderRadius: 3,
          borderStyle: token.shape,
          borderWidth: 1,
          borderColor: colour.border,
          color: colour.fg,
          fontSize: 11,
          lineHeight: 1,
          flex: "0 0 auto",
        }}
      >
        {token.glyph}
      </span>
      <StatusBadge label={token.label} status={token.variant} />
      {props.qualifier === undefined ? null : (
        <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>{props.qualifier}</span>
      )}
      {props.source === undefined || props.hideSource === true ? null : (
        <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
          · source: {props.source.label}
        </span>
      )}
      <SROnly>{accessible}</SROnly>
    </span>
  );
}

/** Text-only status, for dense table cells where a badge would wrap. */
export function StatusText(props: StatusTokenProps): ReactNode {
  const token = statusToken(props.status, props.family);
  const colour = TONE_COLOR[token.tone];
  return (
    <span
      style={{ display: "inline-flex", alignItems: "baseline", gap: 4, minWidth: 0 }}
      title={props.source === undefined ? undefined : `from ${props.source.label}`}
    >
      <span aria-hidden="true" style={{ color: colour.fg, fontSize: 11 }}>
        {token.glyph}
      </span>
      <span style={{ fontSize: 12 }}>{token.label}</span>
    </span>
  );
}

/** A `?` badge used for a value the source did not report, with the reason beside it. */
export function UnknownValue(props: { reason: string; label?: string }): ReactNode {
  return (
    <Row gap={4} align="baseline">
      <StatusToken status={null} />
      <span style={{ fontSize: 12 }}>{props.label ?? "unknown"}</span>
      <span style={{ fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>— {props.reason}</span>
    </Row>
  );
}

export function tokenMeaning(token: StatusToken): ReactNode {
  return (
    <span style={{ fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>{token.meaning}</span>
  );
}
