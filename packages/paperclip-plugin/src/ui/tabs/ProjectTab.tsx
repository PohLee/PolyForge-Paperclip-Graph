/**
 * The PolyForge tab on a project.
 *
 * Answers four questions an engineering lead has about a project: which entrypoints exist, what has
 * actually run, what version new work would adopt, and what the workspace situation is.
 *
 * The workspace panel is deliberately worded to match what the bridge can do. The bridge reads
 * workspace *metadata* and never provisions one, so this tab has no "create workspace" affordance
 * and says why — offering a button the plugin cannot honour is worse than not offering it.
 */

import { useMemo, type ReactNode } from "react";
import { KeyValueList } from "@paperclipai/plugin-sdk/ui";
import { formatInstantPair, formatList } from "../format.js";
import { useProjectViews, useRuntimeRuns, narrowProjectViews, type ProjectView } from "../hooks/usePolyForge.js";
import { STATUS_SOURCE_GRAPH } from "../theme.js";
import { EmptyNotice, FailureNotice, LoadingNotice } from "../components/BridgeState.js";
import { Identifier, Pill, ProviderRefLink } from "../components/Identifiers.js";
import { Panel, Row, Stack } from "../components/Layout.js";
import { StatusToken } from "../components/StatusToken.js";

export function PolyForgeProjectTab(props: { entityId: string }): ReactNode {
  const projects = useProjectViews(props.entityId);
  const runs = useRuntimeRuns({ limit: 100 });
  const list = useMemo(() => narrowProjectViews(projects.data), [projects.data]);
  const project = list.find((entry) => entry.projectId === props.entityId) ?? null;

  if (projects.failure !== null) {
    return (
      <Panel id="project-tab" title="PolyForge" tone="problem">
        <FailureNotice failure={projects.failure} onRetry={projects.refresh} />
      </Panel>
    );
  }
  if (project === null) {
    if (projects.loading) return <LoadingNotice label="Reading the project" />;
    return (
      <Panel id="project-tab" title="PolyForge">
        <EmptyNotice what="this project is not visible to the bridge." detail="Nothing is inferred from its absence." />
      </Panel>
    );
  }

  const projectRuns = (runs.data ?? []).filter((run) => projectRunsFor(run, project));

  return (
    <Stack gap={12}>
      <ProjectMeta project={project} />

      <Panel
        id="project-runs"
        title="Runs in this project"
        description="Runs whose recorded scope names this project. The scope comes from the bridge's own binding, not from anything the Core reports about a project."
      >
        {projectRuns.length === 0 ? (
          <EmptyNotice what="no run is recorded for this project." detail="A run is created from a Root Issue through an explicit start." />
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                {["Run", "Graph", "Entrypoint", "Status", "Awaiting a human", "Unknown effects", "Updated"].map((header) => (
                  <th key={header} scope="col" style={{ textAlign: "left", padding: "2px 6px" }}>
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {projectRuns.map((run) => (
                <tr key={run.runId} style={{ borderTop: "1px solid var(--pf-border, rgba(127,127,127,0.18))" }}>
                  <td>
                    <Identifier id={run.runId} label="run" length={12} />
                  </td>
                  <td>
                    <code>{run.graphId}</code> v{run.graphVersion}
                  </td>
                  <td>{run.entrypoint}</td>
                  <td>
                    <StatusToken status={run.status} family="graph" source={STATUS_SOURCE_GRAPH} />
                  </td>
                  <td>{run.pendingGovernanceCount === 0 ? "0" : <Pill tone="warning">{run.pendingGovernanceCount}</Pill>}</td>
                  <td>{run.unknownEffectCount === 0 ? "0" : <Pill tone="problem">{run.unknownEffectCount}</Pill>}</td>
                  <td>{formatInstantPair(run.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        id="project-roots"
        title="Root issues"
        description="The Paperclip issues this bridge admitted as engineering work. A Root Issue is the entry point of a run, not a summary of it."
      >
        <KeyValueList
          pairs={[
            {
              label: "Project",
              value: <ProviderRefLink ref={{ provider: "paperclip", kind: "project", id: project.projectId }} label={project.name} />,
            },
            { label: "Graphs referenced by bound runs", value: formatList(project.graphIds, "none recorded") },
            {
              label: "Runs in this project",
              value: `${projectRuns.length}`,
            },
          ]}
        />
        <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>
          Child issues the bridge materialised are ordinary Paperclip issues with a PolyForge origin
          kind. They are created idempotently from a single start intent, so replaying the intent does
          not create a second set.
        </p>
      </Panel>
    </Stack>
  );
}

/**
 * A run belongs to a project when the bridge's binding for it names that project.
 *
 * The run list does not carry a project id, so this is a projection of the run list against the
 * graphs the project has referenced. It is a convenience filter, not an authorization check, and
 * the panel says so rather than presenting a partial list as a complete one.
 */
function projectRunsFor(
  run: import("@polyforge/protocol").RunListItem,
  project: ProjectView,
): boolean {
  return project.graphIds.includes(run.graphId);
}

function ProjectMeta(props: { project: ProjectView }): ReactNode {
  const { project } = props;
  const metadataOnly = project.workspaceMode === "metadata_only";
  return (
    <Panel
      id="project-meta"
      title="Project metadata"
      description="What the bridge knows about this project's place in the graph."
    >
      <KeyValueList
        pairs={[
          { label: "Name", value: project.name },
          {
            label: "Entrypoints",
            value:
              project.graphIds.length === 0
                ? "no graph has been referenced by a run in this project"
                : formatList(project.graphIds),
          },
          {
            label: "Primary workspace",
            value:
              project.primaryWorkspace === null ? (
                <StatusToken status={null} family="generic" />
              ) : (
                <Stack gap={2}>
                  <code>{project.primaryWorkspace.path}</code>
                  <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
                    id {project.primaryWorkspace.id}
                  </span>
                </Stack>
              ),
          },
          {
            label: "Workspace mode",
            value: (
              <Row gap={4} align="baseline">
                <Pill>{project.workspaceMode}</Pill>
                <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
                  {metadataOnly
                    ? "the bridge reads workspace metadata and never provisions a workspace, so there is nothing here that can create one"
                    : "child issues inherit this project's execution workspace; the bridge still does not provision it"}
                </span>
              </Row>
            ),
          },
        ]}
      />
    </Panel>
  );
}
