/**
 * The full-page PolyForge workspace.
 *
 * The navigation is local rather than route-based on purpose. The host gives the plugin a page
 * slot and nothing inside it, so a router would have to be reimplemented here for three sections;
 * local state plus a hash fragment keeps the page refreshable and linkable without inventing a
 * route contract the host does not know about. The sidebar entry links to the page with a
 * fragment, and the page reads it on mount, so a shared link lands on the right section.
 *
 * Health is in the header rather than only in its own section, because "can I trust this page"
 * is a question that has to be answered before reading anything on it. When health is not `ready`
 * the header says so in words and names what is blocked.
 */

import { useEffect, useState, type ReactNode } from "react";
import { ErrorBoundary, useHostLocation } from "@paperclipai/plugin-sdk/ui";
import { useHealth, usePolyForgeScope } from "../hooks/usePolyForge.js";
import { Panel, Row, Stack } from "../components/Layout.js";
import { Pill } from "../components/Identifiers.js";
import { UnscopedNotice } from "../components/BridgeState.js";
import { HealthSection } from "./HealthSection.js";
import { LibrarySection } from "./LibrarySection.js";
import { RunsSection } from "./RunsSection.js";

export type PageSection = "library" | "runs" | "health";

const SECTIONS: ReadonlyArray<{ id: PageSection; label: string; blurb: string }> = [
  { id: "library", label: "Graph library", blurb: "Graphs, published versions, and the draft editor." },
  { id: "runs", label: "Runs", blurb: "Every run this bridge knows about, and its runtime view." },
  { id: "health", label: "Integration health", blurb: "Reachability, version compatibility, counters, and what an operator must act on." },
];

function readSectionFromHash(hash: string): PageSection | null {
  const cleaned = hash.replace(/^#/, "");
  const found = SECTIONS.find((section) => section.id === cleaned);
  return found === undefined ? null : found.id;
}

export function PolyForgePage(): ReactNode {
  const [section, setSection] = useState<PageSection>("library");
  const location = useHostLocation();
  const scope = usePolyForgeScope();
  const health = useHealth();

  // A shared `#health` link lands on the health section; a hash change re-selects it live.
  useEffect(() => {
    const fromHash = readSectionFromHash(location.hash);
    if (fromHash !== null) setSection(fromHash);
  }, [location.hash]);

  const go = (next: PageSection) => {
    setSection(next);
    if (typeof window !== "undefined" && window.history !== undefined) {
      window.history.replaceState(null, "", `#${next}`);
    }
  };

  const active = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0];
  const healthLine = describeHealth(health.data, health.failure, health.unscoped);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 12, minWidth: 0 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <Row gap={8} align="baseline">
          <h1 style={{ margin: 0, fontSize: 18 }}>PolyForge</h1>
          <Pill>company {scope.companyId ?? "not selected"}</Pill>
          <div style={{ marginLeft: "auto" }}>{healthLine}</div>
        </Row>
        <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>
          Durable engineering-graph orchestration. Paperclip stays the control plane for issues,
          agents, workspaces, budgets, and platform authorization; this page only reports what the
          graph actually recorded.
        </p>
      </header>

      {scope.scoped ? null : <UnscopedNotice />}

      <nav aria-label="PolyForge sections">
        <Row gap={4}>
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => go(entry.id)}
              aria-current={entry.id === section ? "page" : undefined}
              style={{
                fontWeight: entry.id === section ? 700 : 400,
                cursor: "pointer",
                textDecoration: entry.id === section ? "underline" : undefined,
              }}
            >
              {entry.label}
            </button>
          ))}
        </Row>
      </nav>

      <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>{active?.blurb}</p>

      <ErrorBoundary
        fallback={
          <div role="alert" style={{ border: "2px solid var(--pf-danger, #f87171)", borderRadius: 6, padding: 10 }}>
            <strong>This section failed to render.</strong> The host kept the rest of the page alive.
            Reload to retry; if it keeps happening, the plugin build is at fault rather than the
            data.
          </div>
        }
      >
        <Stack gap={12}>
          {section === "library" ? <LibrarySection /> : null}
          {section === "runs" ? <RunsSection /> : null}
          {section === "health" ? <HealthSection /> : null}
        </Stack>
      </ErrorBoundary>

      {health.failure !== null ? (
        <Panel
          id="page-health-failure"
          title="Health could not be read"
          tone="problem"
          description="The rest of this page still works, but nothing on it should be read as current state."
        >
          <p style={{ margin: 0, fontSize: 12 }}>
            {health.failure.message} {health.failure.remedy}
          </p>
          <button type="button" onClick={health.refresh}>
            Try again
          </button>
        </Panel>
      ) : null}
    </div>
  );
}

function describeHealth(
  data: import("@polyforge/protocol").HealthData | null,
  failure: import("../hooks/usePolyForge.js").BridgeFailure | null,
  unscoped: boolean,
): ReactNode {
  if (unscoped) return <Pill tone="warning">no company selected</Pill>;
  if (failure !== null) {
    return (
      <Pill tone="problem">
        health {failure.kind === "not_permitted" ? "not permitted" : failure.kind === "unreachable" ? "unreachable" : "unreadable"}
      </Pill>
    );
  }
  if (data === null) return <Pill>reading health…</Pill>;
  return (
    <Pill tone={data.status === "ready" ? "default" : "problem"}>
      health {data.status} · runtime {data.runtime.reachable ? "reachable" : "unreachable"} ·{" "}
      {data.issues.length} issue(s)
    </Pill>
  );
}
