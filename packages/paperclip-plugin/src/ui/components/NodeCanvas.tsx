/**
 * The definition canvas.
 *
 * Deliberately not a WYSIWYG editor and deliberately not built on a graph library. Two reasons,
 * both load-bearing:
 *
 * 1. **Runtime-mode structural editing is forbidden** (REQ-GRAPH-07). A live run may not be
 *    rewired by dragging. The only way to make that structurally true rather than a matter of
 *    discipline is for the canvas to have no drag-to-connect affordance at all. This component
 *    therefore renders positions and never writes them from a pointer gesture; the properties
 *    form sets `layout.x` / `layout.y` numerically.
 * 2. **Layout is not execution state.** REQ-GRAPH-02 lets layout be versioned separately because
 *    it must not change the execution hash. Writing positions through the canvas would put them
 *    in the same edit as the contract and quietly put them in the same hash.
 *
 * The canvas exists for orientation. A reviewer who needs to inspect a gate, read evidence, or
 * follow a transition uses the non-canvas list view, which is complete on its own.
 *
 * Node positions come from `layout` when present, and otherwise from a deterministic grid keyed
 * on the node id — a stable layout means the picture does not reshuffle between two reads of the
 * same definition, which matters when the picture is what you are using to navigate.
 */

import { useMemo, useState, type ReactNode } from "react";
import type { GraphDefinition, GraphEdge, GraphNode, NodeKind } from "@polyforge/protocol";
import { RADIUS, SPACE } from "../theme.js";
import { Row, Stack } from "./Layout.js";
import { StatusText } from "./StatusToken.js";
import { STATUS_SOURCE_GRAPH } from "../theme.js";

const NODE_WIDTH = 148;
const NODE_HEIGHT = 46;
const COLUMN_GAP = 60;
const ROW_GAP = 28;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;

export interface CanvasNode {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  /** Runtime status, or `null` in Definition mode where no node has a status yet. */
  readonly status: string | null;
  readonly x: number;
  readonly y: number;
  readonly hasError: boolean;
  readonly warning: boolean;
  readonly selected: boolean;
}

export function buildCanvasNodes(
  nodes: Readonly<Record<string, GraphNode>>,
  options: {
    statusOf?: (nodeId: string) => string | null;
    errorNodeIds?: ReadonlySet<string>;
    warningNodeIds?: ReadonlySet<string>;
    selectedId?: string | null;
  } = {},
): CanvasNode[] {
  // Sorted by id rather than by insertion order so the fallback grid is deterministic: two reads
  // of the same definition produce the same picture, which is what makes the picture usable for
  // navigation between requests.
  const ordered = Object.entries(nodes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return ordered.map(([id, node], index) => {
    const layout = node.layout;
    const fallbackX = 24 + (index % 4) * (NODE_WIDTH + COLUMN_GAP);
    const fallbackY = 24 + Math.floor(index / 4) * (NODE_HEIGHT + ROW_GAP);
    return {
      id,
      kind: str(node.kind),
      label: id,
      status: options.statusOf?.(id) ?? null,
      x: typeof layout?.x === "number" && Number.isFinite(layout.x) ? layout.x : fallbackX,
      y: typeof layout?.y === "number" && Number.isFinite(layout.y) ? layout.y : fallbackY,
      hasError: options.errorNodeIds?.has(id) === true,
      warning: options.warningNodeIds?.has(id) === true,
      selected: options.selectedId === id,
    };
  });
}

function str(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown_kind";
}

export interface NodeCanvasProps {
  nodes: ReadonlyArray<CanvasNode>;
  edges: ReadonlyArray<GraphEdge>;
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
  /** Free-text filter over node id and kind. Empty means "show everything". */
  search: string;
  /** Height of the scroll area, in pixels. */
  height?: number;
  caption: string;
  emptyMessage: string;
}

function matchesSearch(node: CanvasNode, needle: string): boolean {
  if (needle.length === 0) return true;
  const lowered = needle.toLowerCase();
  return node.id.toLowerCase().includes(lowered) || node.kind.toLowerCase().includes(lowered);
}

export function NodeCanvas(props: NodeCanvasProps): ReactNode {
  const [zoom, setZoom] = useState(1);
  const visible = useMemo(
    () => props.nodes.filter((node) => matchesSearch(node, props.search)),
    [props.nodes, props.search],
  );
  const visibleIds = useMemo(() => new Set(visible.map((node) => node.id)), [visible]);
  const drawnEdges = useMemo(
    () => props.edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to)),
    [props.edges, visibleIds],
  );
  const byId = useMemo(() => new Map(visible.map((node) => [node.id, node])), [visible]);

  const bounds = useMemo(() => {
    let maxX = NODE_WIDTH;
    let maxY = NODE_HEIGHT;
    for (const node of visible) {
      maxX = Math.max(maxX, node.x + NODE_WIDTH);
      maxY = Math.max(maxY, node.y + NODE_HEIGHT);
    }
    return { width: maxX + 24, height: maxY + 24 };
  }, [visible]);

  if (props.nodes.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>{props.emptyMessage}</p>
    );
  }

  return (
    <Stack gap={SPACE.xs}>
      <Row gap={SPACE.xs} align="baseline">
        <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
          Orientation only. Positions are layout metadata and are set numerically in the properties
          form; this canvas cannot rewire a graph and never touches a running instance.
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 4, alignItems: "center" }}>
          <span style={{ fontSize: 11 }}>zoom {Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setZoom((z) => clamp(z - 0.2))} aria-label="Zoom out">
            −
          </button>
          <button type="button" onClick={() => setZoom(1)} aria-label="Reset zoom to 100 percent">
            Reset
          </button>
          <button type="button" onClick={() => setZoom((z) => clamp(z + 0.2))} aria-label="Zoom in">
            +
          </button>
        </div>
      </Row>
      <p role="status" aria-live="polite" style={{ margin: 0, fontSize: 11 }}>
        {visible.length === props.nodes.length
          ? `Showing all ${props.nodes.length} nodes.`
          : `Showing ${visible.length} of ${props.nodes.length} nodes; the rest are hidden by the search.`}
      </p>
      <div
        style={{
          height: props.height ?? 340,
          overflow: "auto",
          border: "1px solid var(--pf-border, rgba(127,127,127,0.3))",
          borderRadius: RADIUS.sm,
          background:
            "repeating-linear-gradient(0deg, rgba(127,127,127,0.06) 0 1px, transparent 1px 24px), repeating-linear-gradient(90deg, rgba(127,127,127,0.06) 0 1px, transparent 1px 24px)",
        }}
      >
        <div style={{ width: bounds.width * zoom, height: bounds.height * zoom, position: "relative" }}>
          <svg
            width={bounds.width * zoom}
            height={bounds.height * zoom}
            viewBox={`0 0 ${bounds.width} ${bounds.height}`}
            role="img"
            aria-label={props.caption}
            style={{ display: "block" }}
          >
            <g>
              {drawnEdges.map((edge) => {
                const from = byId.get(edge.from);
                const to = byId.get(edge.to);
                if (from === undefined || to === undefined) return null;
                const x1 = from.x + NODE_WIDTH;
                const y1 = from.y + NODE_HEIGHT / 2;
                const x2 = to.x;
                const y2 = to.y + NODE_HEIGHT / 2;
                const mid = (x1 + x2) / 2;
                return (
                  <g key={`${edge.from}->${edge.to}`}>
                    <path
                      d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                      fill="none"
                      stroke="var(--pf-edge, rgba(127,127,127,0.6))"
                      strokeWidth={1.5}
                      markerEnd="url(#pf-arrow)"
                    />
                    {edge.guard === undefined || edge.guard.length === 0 ? null : (
                      <text
                        x={mid}
                        y={(y1 + y2) / 2 - 4}
                        textAnchor="middle"
                        fontSize={9}
                        fill="var(--pf-muted, #6b7280)"
                      >
                        {edge.guard}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
            <defs>
              <marker
                id="pf-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--pf-edge, rgba(127,127,127,0.6))" />
              </marker>
            </defs>
            {visible.map((node) => (
              <g
                key={node.id}
                transform={`translate(${node.x}, ${node.y})`}
                onClick={() => props.onSelect(node.id)}
                style={{ cursor: "pointer" }}
              >
                <rect
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx={RADIUS.sm}
                  fill={node.selected ? "var(--pf-selected, rgba(96,165,250,0.16))" : "var(--pf-node-bg, transparent)"}
                  stroke={
                    node.hasError
                      ? "var(--pf-danger, #f87171)"
                      : node.warning
                        ? "var(--pf-warn, #fbbf24)"
                        : "var(--pf-border, rgba(127,127,127,0.5))"
                  }
                  strokeWidth={node.selected || node.hasError ? 2 : 1}
                  strokeDasharray={node.hasError ? "4 2" : undefined}
                />
                <text x={8} y={17} fontSize={10} fontWeight={600}>
                  {truncate(node.id, 20)}
                </text>
                <text x={8} y={30} fontSize={9} fill="var(--pf-muted, #6b7280)">
                  {node.kind}
                </text>
                {node.status === null ? null : (
                  <text x={8} y={41} fontSize={9}>
                    {node.status}
                  </text>
                )}
              </g>
            ))}
          </svg>
        </div>
      </div>
      {visible.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12 }}>No node matches the current search.</p>
      ) : null}
      <details>
        <summary style={{ fontSize: 12, cursor: "pointer" }}>
          Node statuses (text, from {STATUS_SOURCE_GRAPH.label})
        </summary>
        <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12 }}>
          {visible.map((node) => (
            <li key={node.id}>
              {node.id} — <StatusText status={node.status} family="node" source={STATUS_SOURCE_GRAPH} /> ({node.kind})
            </li>
          ))}
        </ul>
      </details>
    </Stack>
  );
}

function clamp(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Build canvas nodes straight from a `GraphDefinition`. */
export function canvasNodesFromDefinition(
  definition: GraphDefinition,
  options: {
    statusOf?: (nodeId: string) => string | null;
    errorNodeIds?: ReadonlySet<string>;
    warningNodeIds?: ReadonlySet<string>;
    selectedId?: string | null;
  } = {},
): CanvasNode[] {
  return buildCanvasNodes(definition.nodes, options);
}

/** Node kinds offered by the editor palette, with the requirement each one carries. */
export const NODE_PALETTE: ReadonlyArray<{ kind: NodeKind; summary: string }> = [
  { kind: "agent_operation", summary: "Executed by a worker holding a claim and a lease fence." },
  { kind: "deterministic", summary: "A reproducible transform. No agent, no external effect." },
  { kind: "gate", summary: "Decides a transition. The only place a PASS originates." },
  { kind: "subgraph", summary: "A child run with its own version closure and entrypoint." },
  { kind: "external_effect", summary: "Touches the world outside Paperclip. Governed and reconciled." },
];
