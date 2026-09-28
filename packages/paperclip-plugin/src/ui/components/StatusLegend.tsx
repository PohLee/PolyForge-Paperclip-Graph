/**
 * The status legend.
 *
 * REQ-UI-06 asks for text status *and* a legend. The legend is what makes the glyph+label pairing
 * learnable: without it, `◐` and `✓` and `?` are decoration. Each entry states what the state
 * means, and — for the states that look like success — what it does *not* mean.
 */

import { useState, type ReactNode } from "react";
import { STATUS_LEGEND, statusToken } from "../theme.js";
import { Panel, Stack } from "./Layout.js";
import { StatusToken, tokenMeaning } from "./StatusToken.js";

export function StatusLegend(props: { defaultOpen?: boolean }): ReactNode {
  const [open, setOpen] = useState(props.defaultOpen === true);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} style={{ fontSize: 12, cursor: "pointer" }}>
        Show the status legend
      </button>
    );
  }
  return (
    <Panel
      id="status-legend"
      title="Status legend"
      aside={
        <button type="button" onClick={() => setOpen(false)} style={{ fontSize: 12, cursor: "pointer" }}>
          Hide
        </button>
      }
      description="Every status in this plugin is shown as a glyph, a text label, and a border shape, with colour as a fourth redundant channel. A reader who cannot use colour loses nothing."
    >
      <Stack gap={12}>
        {STATUS_LEGEND.map((group) => (
          <div key={group.title}>
            <h4 style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 600 }}>{group.title}</h4>
            <div style={{ display: "grid", gap: 6 }}>
              {group.entries.map((entry) => {
                const token = statusToken(entry.raw, entry.family);
                return (
                  <div
                    key={`${entry.family}:${entry.raw}`}
                    style={{ display: "grid", gridTemplateColumns: "minmax(180px, max-content) 1fr", gap: 8 }}
                  >
                    <StatusToken status={entry.raw} family={entry.family} />
                    <div>
                      <div style={{ fontSize: 12 }}>
                        {entry.note === undefined ? null : <strong>{entry.note}. </strong>}
                        {tokenMeaning(token)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </Stack>
    </Panel>
  );
}
