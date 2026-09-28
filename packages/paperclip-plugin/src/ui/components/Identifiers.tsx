/**
 * Identifiers: hashes, provider refs, and the live region.
 *
 * `copyTextToClipboard` comes from the host rather than the browser Clipboard API because
 * Paperclip also runs over plain HTTP, where `navigator.clipboard` is unavailable. It resolves
 * asynchronously and rejects on failure, so the button reports its own outcome instead of
 * pretending.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { copyTextToClipboard, useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import type { ProviderRefLike } from "@polyforge/protocol";
import { formatProviderRef, fullHash, providerRefPath, shortHash, shortId } from "../format.js";
import { RADIUS } from "../theme.js";
import { Row } from "./Layout.js";

/**
 * A hash in short form with the full value one copy away.
 *
 * A truncated hash is a correctness problem if the reader cannot recover the whole thing, so the
 * full value is in `title`, in the accessible name, and in the clipboard.
 */
export function CopyableHash(props: { hash: string | null | undefined; label?: string }): ReactNode {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const full = fullHash(props.hash);
  const copy = useCallback(() => {
    if (props.hash === null || props.hash === undefined) return;
    copyTextToClipboard(full)
      .then(() => setState("copied"))
      .catch(() => setState("failed"));
  }, [props.hash, full]);

  return (
    <Row gap={4} align="baseline">
      <code
        title={full}
        style={{ fontSize: 12, overflowWrap: "anywhere" }}
      >
        {shortHash(props.hash)}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy full ${props.label ?? "hash"} ${full}`}
        style={{ fontSize: 11, padding: "1px 6px", cursor: "pointer" }}
      >
        Copy
      </button>
      {state === "copied" ? (
        <span role="status" style={{ fontSize: 11 }}>
          copied
        </span>
      ) : null}
      {state === "failed" ? (
        <span role="status" style={{ fontSize: 11, color: "var(--pf-danger, #f87171)" }}>
          copy blocked by the host — select the text manually
        </span>
      ) : null}
    </Row>
  );
}

export function Identifier(props: { id: string | null | undefined; label: string; length?: number }): ReactNode {
  const value = shortId(props.id, props.length ?? 10);
  return <code title={props.id ?? "not reported"} style={{ fontSize: 12 }}>{value}</code>;
}

/**
 * A provider reference, linked only when the host owns the provider.
 *
 * A `github` or `jira` ref is rendered as text. Turning an unowned ref into a Paperclip route
 * produces a link that silently goes somewhere else, which is worse than no link.
 */
export function ProviderRefLink(props: {
  ref: ProviderRefLike | null | undefined;
  /** Text shown instead of the formatted ref. */
  label?: string;
  /** Rendered next to the link, e.g. "opened in a new tab by the host router". */
  suffix?: string;
}): ReactNode {
  const navigation = useHostNavigation();
  const path = providerRefPath(props.ref);
  const label = props.label ?? formatProviderRef(props.ref);
  if (path === null) {
    return (
      <code title={formatProviderRef(props.ref)} style={{ fontSize: 12 }}>
        {label}
      </code>
    );
  }
  const linkProps = navigation.linkProps(path);
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "baseline", flexWrap: "wrap" }}>
      <a {...linkProps} style={{ fontSize: 12 }}>
        {label}
      </a>
      {props.suffix === undefined ? null : (
        <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>{props.suffix}</span>
      )}
    </span>
  );
}

/**
 * A polite live region.
 *
 * Async results — a save that landed, a re-read that closed a gap, a command that was refused —
 * are announced here rather than only being drawn. `aria-live="polite"` and `aria-atomic` mean
 * the announcement waits for a pause in speech instead of interrupting.
 */
export function LiveRegion(props: { message: string | null; label?: string }): ReactNode {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={props.label ?? "Latest result"}
      style={{
        fontSize: 12,
        minHeight: 18,
        color: "var(--pf-muted, #6b7280)",
        padding: "2px 0",
      }}
    >
      {props.message ?? ""}
    </div>
  );
}

/**
 * Announcement queue.
 *
 * `announce` is stable across renders so it can be called from an async callback without
 * re-subscribing whatever effect issued the call.
 */
export function useAnnouncer(): { message: string | null; announce: (message: string) => void } {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const announce = useCallback((next: string) => {
    setMessage(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    // Cleared rather than left in place, so a screen reader re-announces an identical message on
    // a repeat action instead of treating it as unchanged text.
    timer.current = window.setTimeout(() => setMessage(null), 8000);
  }, []);
  return { message, announce };
}

export function Pill(props: { children: ReactNode; tone?: "default" | "problem" | "warning" | "unknown" }): ReactNode {
  const colour =
    props.tone === "problem"
      ? "var(--pf-danger, #f87171)"
      : props.tone === "warning"
        ? "var(--pf-warn, #fbbf24)"
        : props.tone === "unknown"
          ? "var(--pf-unknown, #94a3b8)"
          : "var(--pf-border, rgba(127,127,127,0.4))";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 6px",
        borderRadius: RADIUS.sm,
        border: `1px ${props.tone === "unknown" ? "dotted" : "solid"} ${colour}`,
        fontSize: 11,
      }}
    >
      {props.children}
    </span>
  );
}
