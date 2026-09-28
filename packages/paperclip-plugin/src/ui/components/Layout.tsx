/**
 * Layout primitives.
 *
 * Small, unopinionated wrappers whose only job is to make the plugin look like it belongs next to
 * the host's own surfaces. They are deliberately inline-style based: the host injects only four
 * modules into the plugin bundle, so there is no stylesheet to ship and no class name to rely on.
 */

import type { CSSProperties, ReactNode } from "react";
import { MONO_FONT, RADIUS, SPACE } from "../theme.js";

export const MUTED = "color: var(--pf-muted, #6b7280);";

export function Panel(props: {
  title: string;
  /** Rendered on the title row, right-aligned. */
  aside?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  tone?: "default" | "warning" | "problem" | "unknown";
  id?: string;
}): ReactNode {
  const border =
    props.tone === "problem"
      ? "var(--pf-danger, #f87171)"
      : props.tone === "warning"
        ? "var(--pf-warn, #fbbf24)"
        : props.tone === "unknown"
          ? "var(--pf-unknown, #94a3b8)"
          : "var(--pf-border, rgba(127, 127, 127, 0.3))";
  return (
    <section
      aria-labelledby={props.id === undefined ? undefined : `${props.id}-title`}
      id={props.id}
      style={{
        border: `1px solid ${border}`,
        borderRadius: RADIUS.md,
        padding: SPACE.md,
        display: "flex",
        flexDirection: "column",
        gap: SPACE.sm,
        minWidth: 0,
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", gap: SPACE.sm, flexWrap: "wrap" }}>
        <h3
          id={props.id === undefined ? undefined : `${props.id}-title`}
          style={{ margin: 0, fontSize: 14, fontWeight: 600 }}
        >
          {props.title}
        </h3>
        {props.aside === undefined ? null : <div style={{ marginLeft: "auto" }}>{props.aside}</div>}
      </header>
      {props.description === undefined ? null : (
        <p style={{ margin: 0, fontSize: 12, ...{ color: "var(--pf-muted, #6b7280)" } }}>{props.description}</p>
      )}
      {props.children}
    </section>
  );
}

export function Stack(props: {
  children: ReactNode;
  gap?: number;
  row?: boolean;
  wrap?: boolean;
  align?: CSSProperties["alignItems"];
}): ReactNode {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: props.row === true ? "row" : "column",
        gap: props.gap ?? SPACE.sm,
        flexWrap: props.wrap === true ? "wrap" : "nowrap",
        alignItems: props.align,
        minWidth: 0,
      }}
    >
      {props.children}
    </div>
  );
}

export function Row(props: { children: ReactNode; gap?: number; wrap?: boolean; align?: CSSProperties["alignItems"] }): ReactNode {
  return <Stack row gap={props.gap ?? SPACE.sm} wrap={props.wrap ?? true} align={props.align}>{props.children}</Stack>;
}

export function Grid(props: {
  children: ReactNode;
  minColumnWidth?: number;
  gap?: number;
}): ReactNode {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fit, minmax(${props.minColumnWidth ?? 220}px, 1fr))`,
        gap: props.gap ?? SPACE.sm,
        minWidth: 0,
      }}
    >
      {props.children}
    </div>
  );
}

export function Muted(props: { children: ReactNode; title?: string }): ReactNode {
  return <span style={{ fontSize: 12, color: "var(--pf-muted, #6b7280)" }} title={props.title}>{props.children}</span>;
}

export function Mono(props: { children: ReactNode; title?: string }): ReactNode {
  return <span style={{ fontFamily: MONO_FONT, fontSize: 12 }} title={props.title}>{props.children}</span>;
}

export function Truncate(props: { children: string; max?: number }): ReactNode {
  const max = props.max ?? 48;
  const value = props.children.length <= max ? props.children : `${props.children.slice(0, max - 1)}…`;
  return <span title={props.children}>{value}</span>;
}

export function Separator(): ReactNode {
  return <hr style={{ border: "none", borderTop: "1px solid var(--pf-border, rgba(127,127,127,0.25))", margin: `${SPACE.sm} 0` }} />;
}

/**
 * Text available to assistive technology but not painted.
 *
 * Used to attach the provenance and the raw reported value to a status, so a screen-reader user
 * hears "reported as PASSED; from Paperclip issue (projection)" rather than just the word "Done".
 * The inline clip is the standard technique and is not a `display: none` — a hidden element is
 * removed from the accessibility tree.
 */
export function SROnly(props: { children: ReactNode }): ReactNode {
  return (
    <span
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        padding: 0,
        margin: -1,
        overflow: "hidden",
        clip: "rect(0 0 0 0)",
        clipPath: "inset(50%)",
        whiteSpace: "nowrap",
        border: 0,
      }}
    >
      {props.children}
    </span>
  );
}

/** A count that is deliberately readable at a glance, with the full number in `title`. */
export function Count(props: { value: number; label: string; tone?: "default" | "problem" | "warning" }): ReactNode {
  const color =
    props.tone === "problem"
      ? "var(--pf-danger, #f87171)"
      : props.tone === "warning"
        ? "var(--pf-warn, #fbbf24)"
        : undefined;
  return (
    <span style={{ fontWeight: 600, color }} title={`${props.value} ${props.label}`}>
      {props.value} <span style={{ fontWeight: 400, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>{props.label}</span>
    </span>
  );
}
