/**
 * The event timeline.
 *
 * Rendered from the events the Core returned for a sequence range, with the range stated above
 * the list. A timeline with no stated range reads as "everything", and on a long run it is not:
 * saying "events 240–339 of 1,482" is what lets a reviewer trust that a transition they are
 * looking at actually happened in the order shown.
 */

import { useMemo, useState, type ReactNode } from "react";
import type { DomainEvent } from "@polyforge/protocol";
import { formatInstantPair, oneLine, truncate } from "../format.js";
import { RADIUS, SPACE } from "../theme.js";
import { Pill } from "./Identifiers.js";
import { Row, Stack } from "./Layout.js";
import { JsonTree } from "@paperclipai/plugin-sdk/ui";

/**
 * Events worth pinning to the top of the timeline.
 *
 * These are the ones that change what a reader concludes, so they get summarised rather than
 * buried in a payload. The match is deliberately narrow: a wrong highlight is worse than none.
 */
const SIGNIFICANT: ReadonlyArray<{ pattern: RegExp; note: string }> = [
  { pattern: /gate|evaluat/i, note: "gate evaluation" },
  { pattern: /pass|transition/i, note: "transition" },
  { pattern: /block/i, note: "block" },
  { pattern: /governance|decision|approval|interaction/i, note: "governance" },
  { pattern: /evidence/i, note: "evidence" },
  { pattern: /effect|reconcil/i, note: "external effect" },
  { pattern: /lease|fenc/i, note: "lease fence" },
];

function significanceOf(type: string): string | null {
  for (const candidate of SIGNIFICANT) {
    if (candidate.pattern.test(type)) return candidate.note;
  }
  return null;
}

export function EventTimeline(props: {
  events: ReadonlyArray<DomainEvent>;
  /** The sequence the list starts at, and the range actually held. */
  rangeFrom: number;
  /** What the Core says the run is at, so "of N" is honest rather than "of what I fetched". */
  authoritativeSequence: number;
  onLocate?: ((seq: number) => void) | undefined;
  height?: number;
}): ReactNode {
  const [filter, setFilter] = useState("");
  const ordered = useMemo(
    () => [...props.events].sort((a, b) => a.seq - b.seq),
    [props.events],
  );
  const visible = useMemo(() => {
    if (filter.trim().length === 0) return ordered;
    const needle = filter.trim().toLowerCase();
    return ordered.filter(
      (event) => event.type.toLowerCase().includes(needle) || oneLine(JSON.stringify(event.payload)).toLowerCase().includes(needle),
    );
  }, [ordered, filter]);

  return (
    <Stack gap={SPACE.xs}>
      <Row gap={6} align="baseline">
        <Pill>
          holding #{ordered[0]?.seq ?? 0}–#{ordered[ordered.length - 1]?.seq ?? 0}
        </Pill>
        <Pill>Core is at #{props.authoritativeSequence}</Pill>
        {ordered.length < Math.max(0, props.authoritativeSequence - props.rangeFrom + 1) ? (
          <Pill tone="warning">this list does not cover the whole run</Pill>
        ) : null}
        <label htmlFor="pf-event-filter" style={{ fontSize: 12, marginLeft: "auto" }}>
          filter
          <input
            id="pf-event-filter"
            type="search"
            value={filter}
            placeholder="type or payload"
            onChange={(event) => setFilter(event.target.value)}
            style={{ marginLeft: 6, fontSize: 12 }}
          />
        </label>
      </Row>
      {ordered.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>
          No events are held for this run yet. That is not the same as "nothing happened": the Core
          reports its own sequence, and a mismatch with what this view holds is shown above.
        </p>
      ) : null}
      <ol
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          maxHeight: props.height ?? 320,
          overflowY: "auto",
          border: "1px solid var(--pf-border, rgba(127,127,127,0.25))",
          borderRadius: RADIUS.sm,
        }}
      >
        {visible.map((event) => {
          const note = significanceOf(event.type);
          return (
            <li
              key={event.seq}
              style={{
                borderBottom: "1px solid var(--pf-border, rgba(127,127,127,0.15))",
                padding: "3px 6px",
                fontSize: 12,
              }}
            >
              <Row gap={6} align="baseline">
                <code style={{ fontSize: 11 }}>#{event.seq}</code>
                <strong style={{ fontSize: 12 }}>{event.type}</strong>
                {note === null ? null : <Pill>{note}</Pill>}
                <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
                  {formatInstantPair(event.at)}
                </span>
                {props.onLocate === undefined ? null : (
                  <button
                    type="button"
                    onClick={() => props.onLocate?.(event.seq)}
                    style={{ fontSize: 11, marginLeft: "auto" }}
                  >
                    locate
                  </button>
                )}
              </Row>
              <details>
                <summary style={{ fontSize: 11, cursor: "pointer", color: "var(--pf-muted, #6b7280)" }}>
                  {truncate(oneLine(JSON.stringify(event.payload)), 120)}
                </summary>
                <JsonTree data={event.payload} defaultExpandDepth={2} />
              </details>
            </li>
          );
        })}
      </ol>
    </Stack>
  );
}
