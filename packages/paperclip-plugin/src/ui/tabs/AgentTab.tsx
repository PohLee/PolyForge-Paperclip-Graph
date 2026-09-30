/**
 * The PolyForge tab on an agent.
 *
 * Two things it must get right. First, the separation between the *platform* fact (an agent
 * exists, its Paperclip role and status) and the *engineering* fact (which capabilities it holds
 * under a PolyForge capability binding). Those are different grants with different lifetimes, and a
 * UI that shows one under the other's heading is claiming an authorization the bridge never
 * checked.
 *
 * Second, the coordinator/executor distinction. A coordinator is matched on an entrypoint's
 * coordinator capabilities and decides the plan; an executor holds a node's required capabilities
 * and does the work. An agent can be both, and for different entrypoints — so this is computed
 * per entrypoint from the bindings and the dispatches, not asserted once.
 *
 * The tab is read-only. Assigning or widening a capability is a governed act; the bridge holds no
 * capability to do it, so there is nothing here a person could usefully press.
 */

import { useMemo, type ReactNode } from "react";
import { KeyValueList } from "@paperclipai/plugin-sdk/ui";
import { formatInstantPair, formatList, oneLine } from "../format.js";
import { useAgentViews, narrowAgentViews, type AgentView } from "../hooks/usePolyForge.js";
import { STATUS_SOURCE_PLATFORM } from "../theme.js";
import { EmptyNotice, FailureNotice, LoadingNotice } from "../components/BridgeState.js";
import { Identifier, Pill, ProviderRefLink } from "../components/Identifiers.js";
import { Panel, Row, Stack } from "../components/Layout.js";
import { StatusToken } from "../components/StatusToken.js";

export function PolyForgeAgentTab(props: { entityId: string }): ReactNode {
  const agents = useAgentViews();
  const list = useMemo(() => narrowAgentViews(agents.data), [agents.data]);
  const agent = list.find((entry) => entry.agentId === props.entityId) ?? null;

  if (agents.failure !== null) {
    return (
      <Panel id="agent-tab" title="PolyForge" tone="problem">
        <FailureNotice failure={agents.failure} onRetry={agents.refresh} />
      </Panel>
    );
  }
  if (agent === null) {
    if (agents.loading) return <LoadingNotice label="Reading the agent roster" />;
    return (
      <Panel id="agent-tab" title="PolyForge">
        <EmptyNotice what="this agent is not in the company roster the bridge can see." detail="No capability conclusion is drawn from its absence." />
      </Panel>
    );
  }

  return (
    <Stack gap={12}>
      <AgentIdentity agent={agent} />
      <CapabilityBindings agent={agent} />
      <CoordinationRoles agent={agent} />
      <Dispatches agent={agent} />
    </Stack>
  );
}

function AgentIdentity(props: { agent: AgentView }): ReactNode {
  const { agent } = props;
  return (
    <Panel
      id="agent-identity"
      title="Agent"
      description="The platform owns this record. PolyForge reports it and never asserts it."
    >
      <KeyValueList
        pairs={[
          { label: "Name", value: <ProviderRefLink ref={{ provider: "paperclip", kind: "agent", id: agent.agentId }} label={agent.name} /> },
          { label: "Agent id", value: <Identifier id={agent.agentId} label="agent" length={14} /> },
          { label: "Paperclip role", value: agent.role },
          {
            label: "Paperclip status",
            value: (
              <Row gap={4} align="baseline">
                <StatusToken status={agent.platformStatus} family="platform" source={STATUS_SOURCE_PLATFORM} />
                <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
                  a platform status, not an engineering one
                </span>
              </Row>
            ),
          },
          {
            label: "Engineering bindings are scoped",
            value: agent.bindingsAreEngineeringScoped ? "yes" : "not reported — treat every binding below as unverified",
          },
        ]}
      />
    </Panel>
  );
}

function CapabilityBindings(props: { agent: AgentView }): ReactNode {
  const { agent } = props;
  if (agent.engineeringBindings.length === 0) {
    return (
      <Panel id="agent-bindings" title="Engineering capability bindings" tone="warning">
        <EmptyNotice
          what="this agent holds no PolyForge capability binding."
          detail="It can therefore be dispatched to no node: an unmatched capability set denies rather than falls back. A free-text capability field on the agent record would not change this, which is why the grant is a separate, reviewable binding."
        />
      </Panel>
    );
  }
  return (
    <Panel
      id="agent-bindings"
      title="Engineering capability bindings"
      description="The grant that actually decides dispatch. A capability is only as strong as the binding that carries it, so this is a separate record from the platform agent."
    >
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
        <thead>
          <tr>
            {["Capabilities", "Project", "Run", "Node", "Granted"].map((header) => (
              <th key={header} scope="col" style={{ textAlign: "left", padding: "2px 6px" }}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {agent.engineeringBindings.map((binding, index) => (
            <tr key={`${binding.agentId}:${index}`} style={{ borderTop: "1px solid var(--pf-border, rgba(127,127,127,0.18))" }}>
              <td>{formatList(binding.capabilities, "no capabilities recorded")}</td>
              <td>{binding.projectRef ?? "not project-bound"}</td>
              <td>{binding.runId === null ? "not run-scoped" : <Identifier id={binding.runId} label="run" />}</td>
              <td>{binding.nodeId === null ? "not node-scoped" : <code>{binding.nodeId}</code>}</td>
              <td>{binding.grantedAt === null ? "not reported" : formatInstantPair(binding.grantedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

/**
 * Coordinator or executor, per entrypoint.
 *
 * Derived from what the agent actually holds and has actually been dispatched, never from a label.
 * A capability set that matches nothing yields "neither" and says which entrypoints had no match,
 * because "not a coordinator" and "was never considered" are different answers.
 */
function CoordinationRoles(props: { agent: AgentView }): ReactNode {
  const { agent } = props;
  const capabilities = new Set(
    agent.engineeringBindings.flatMap((binding) => binding.capabilities),
  );
  const executed = new Set(agent.dispatches.map((dispatch) => dispatch.nodeId));

  if (capabilities.size === 0) {
    return (
      <Panel id="agent-roles" title="Coordinator and executor responsibilities">
        <p style={{ margin: 0, fontSize: 12 }}>
          Neither. With no capability binding, this agent is not eligible for a coordinator role and not
          eligible for any node, so there is no entrypoint for which it is either.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      id="agent-roles"
      title="Coordinator and executor responsibilities"
      description="Computed from the capabilities this agent holds and the nodes it has actually been dispatched to. A role is not a label on the agent."
    >
      <KeyValueList
        pairs={[
          {
            label: "Distinct capabilities held",
            value: `${capabilities.size} (${formatList([...capabilities].slice(0, 8), "none")}${capabilities.size > 8 ? ", …" : ""})`,
          },
          {
            label: "Executor",
            value:
              executed.size === 0
                ? "no execution recorded for this agent — eligible by capability, but nothing has been dispatched"
                : `yes, for ${executed.size} node(s): ${[...executed].slice(0, 6).join(", ")}`,
          },
          {
            label: "Coordinator",
            value:
              agent.dispatches.length > 0 && agent.engineeringBindings.some((binding) => binding.runId !== null && binding.nodeId === null)
                ? "yes — a run-scoped binding with no node scope is how a coordinator is bound"
                : "no run-scoped coordinator binding is recorded for this agent",
          },
          {
            label: "Both at once",
            value:
              executed.size > 0 &&
              agent.engineeringBindings.some((binding) => binding.runId !== null && binding.nodeId === null)
                ? "yes. Independent review requires a different producing subject; an agent that both plans and executes cannot be its own reviewer, and the Core will not accept that pairing"
                : "no — this agent has either an execution record or a coordinator binding, not both",
          },
        ]}
      />
    </Panel>
  );
}

function Dispatches(props: { agent: AgentView }): ReactNode {
  const { agent } = props;
  if (agent.dispatches.length === 0) {
    return (
      <Panel id="agent-dispatches" title="Dispatches">
        <EmptyNotice what="this agent has not been dispatched for any node." detail="No execution outcome is implied by an empty list." />
      </Panel>
    );
  }
  return (
    <Panel
      id="agent-dispatches"
      title="Dispatches"
      description="The bridge's record of what it asked the platform to execute. An observation of `unknown` is a real state and is shown as one."
    >
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
        <thead>
          <tr>
            {["Run", "Node", "Iteration", "Issue", "Last platform observation"].map((header) => (
              <th key={header} scope="col" style={{ textAlign: "left", padding: "2px 6px" }}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {agent.dispatches.map((dispatch) => (
            <tr key={`${dispatch.runId}:${dispatch.nodeId}:${dispatch.iteration}`} style={{ borderTop: "1px solid var(--pf-border, rgba(127,127,127,0.18))" }}>
              <td>
                <Identifier id={dispatch.runId} label="run" />
              </td>
              <td>
                <code>{dispatch.nodeId}</code>
              </td>
              <td>{dispatch.iteration}</td>
              <td>{dispatch.issueId === null ? <StatusToken status={null} family="issue" /> : <Pill>{dispatch.issueId}</Pill>}</td>
              <td>
                {dispatch.lastObservation === null ? (
                  <StatusToken status="UNKNOWN" family="attempt" />
                ) : (
                  <Row gap={4} align="baseline">
                    <StatusToken
                      status={dispatch.lastObservation.state}
                      family="attempt"
                      source={STATUS_SOURCE_PLATFORM}
                    />
                    {dispatch.lastObservation.detail === null ? null : (
                      <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
                        {oneLine(dispatch.lastObservation.detail)}
                      </span>
                    )}
                  </Row>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
