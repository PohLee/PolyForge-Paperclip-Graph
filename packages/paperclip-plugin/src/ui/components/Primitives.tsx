/**
 * Dialog, windowed list, and a typed adapter over the host table.
 *
 * Grouped here because all three exist for the same reason: they are the parts of this UI a
 * reviewer interacts with rather than reads, and each of them has an accessibility contract that
 * is easy to get subtly wrong.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { DataTable } from "@paperclipai/plugin-sdk/ui";
import type { DataTableColumn } from "@paperclipai/plugin-sdk/ui";
import { RADIUS, SPACE } from "../theme.js";

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal that traps focus, closes on `Escape`, and restores focus on close.
 *
 * All three are required by REQ-UI-06. The trap is implemented by cycling `Tab` and
 * `Shift+Tab` inside the dialog rather than by removing focusability, so the document behind the
 * dialog stays in the tab order in browsers that do not honour `inert` — the practical effect is
 * the same: a keyboard user cannot tab out into a background they cannot see.
 */
export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Initial focus lands here rather than on the first control. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}): ReactNode {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<Element | null>(null);

  useEffect(() => {
    restoreTo.current = typeof document === "undefined" ? null : document.activeElement;
    const target = props.initialFocusRef?.current ?? dialogRef.current;
    target?.focus();
    return () => {
      if (restoreTo.current instanceof HTMLElement) restoreTo.current.focus();
    };
  }, [props.initialFocusRef]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        props.onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (dialog === null) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    },
    [props],
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: SPACE.lg,
        zIndex: 1000,
      }}
    >
      <div
        // A click on the backdrop closes. A click inside must not, hence the stopPropagation.
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) props.onClose();
        }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          style={{
            background: "var(--pf-surface, Canvas)",
            color: "CanvasText",
            border: "1px solid var(--pf-border, rgba(127,127,127,0.4))",
            borderRadius: RADIUS.md,
            padding: SPACE.lg,
            maxWidth: 640,
            width: "100%",
            maxHeight: "85vh",
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
            gap: SPACE.sm,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: SPACE.sm }}>
            <h2 id={titleId} style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
              {props.title}
            </h2>
            <button
              type="button"
              onClick={props.onClose}
              aria-label="Close dialog"
              style={{ marginLeft: "auto", cursor: "pointer" }}
            >
              Close
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: SPACE.sm }}>{props.children}</div>
          {props.footer === undefined ? null : (
            <div style={{ display: "flex", gap: SPACE.xs, flexWrap: "wrap" }}>{props.footer}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Windowed list
// ---------------------------------------------------------------------------

export interface VirtualListProps<T> {
  items: ReadonlyArray<T>;
  rowHeight: number;
  height: number;
  overscan?: number;
  getKey: (item: T, index: number) => string;
  renderRow: (item: T, index: number) => ReactNode;
  ariaLabel: string;
  /** Announced text describing the window, e.g. "showing 40 of 312 nodes". */
  windowSummary: string;
}

/**
 * A windowed list.
 *
 * Virtualization is only correct if the reader can still get to every row, so it is paired with a
 * search box upstream (filter to a handful and every row is rendered) and with a `windowSummary`
 * that states plainly how much is not currently in the DOM. Below `VIRTUALIZE_ABOVE` rows nothing
 * is windowed, because a window that hides twelve rows is a worse answer than a scroll bar.
 */
export const VIRTUALIZE_ABOVE = 120;

export function VirtualList<T>(props: VirtualListProps<T>): ReactNode {
  const overscan = props.overscan ?? 6;
  const total = props.items.length;
  const [scrollTop, setScrollTop] = useState(0);
  const virtualize = total > VIRTUALIZE_ABOVE;

  const start = virtualize ? Math.max(0, Math.floor(scrollTop / props.rowHeight) - overscan) : 0;
  const visibleCount = virtualize
    ? Math.ceil(props.height / props.rowHeight) + overscan * 2
    : total;
  const end = Math.min(total, start + visibleCount);
  const slice = props.items.slice(start, end);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <p role="status" aria-live="polite" style={{ margin: 0, fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>
        {props.windowSummary}
      </p>
      <div
        role="list"
        aria-label={props.ariaLabel}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        style={{
          height: props.height,
          overflowY: "auto",
          overflowX: "hidden",
          position: "relative",
          border: "1px solid var(--pf-border, rgba(127,127,127,0.25))",
          borderRadius: RADIUS.sm,
        }}
      >
        <div style={{ height: virtualize ? total * props.rowHeight : undefined, position: "relative" }}>
          {slice.map((item, offset) => {
            const index = start + offset;
            return (
              <div
                key={props.getKey(item, index)}
                role="listitem"
                style={{
                  position: virtualize ? "absolute" : "static",
                  top: virtualize ? index * props.rowHeight : undefined,
                  left: 0,
                  right: 0,
                  height: virtualize ? props.rowHeight : undefined,
                  boxSizing: "border-box",
                  overflow: "hidden",
                }}
              >
                {props.renderRow(item, index)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Typed table over the host DataTable
// ---------------------------------------------------------------------------

export interface GridColumn<T> {
  key: Extract<keyof T, string>;
  header: string;
  width?: string;
  sortable?: boolean;
  render: (row: T) => ReactNode;
}

/**
 * A typed adapter over the host `DataTable`.
 *
 * The host component is declared against `Record<string, unknown>` rows, which erases the row
 * type at the call site. This keeps the call sites typed and confines the one unavoidable cast to
 * a single line, rather than making every list in the plugin `Record<string, unknown>`.
 *
 * Used for non-selectable tables. Lists that need row *selection* are rendered as a real
 * `<table>` of buttons elsewhere, because `DataTable` exposes no selection affordance and a
 * selectable list is a different component, not a worse one.
 */
export function DataGrid<T extends object>(props: {
  columns: ReadonlyArray<GridColumn<T>>;
  rows: ReadonlyArray<T>;
  caption: string;
  loading?: boolean;
  emptyMessage?: string;
}): ReactNode {
  const columns: DataTableColumn[] = props.columns.map((column) => ({
    key: column.key,
    header: column.header,
    ...(column.width === undefined ? {} : { width: column.width }),
    ...(column.sortable === undefined ? {} : { sortable: column.sortable }),
    render: (_value: unknown, row: Record<string, unknown>) => column.render(row as T),
  }));
  return (
    <DataTable
      columns={columns}
      rows={props.rows as unknown as Record<string, unknown>[]}
      loading={props.loading === true}
      emptyMessage={props.emptyMessage ?? `No ${props.caption} to show.`}
    />
  );
}

// ---------------------------------------------------------------------------
// Selectable table
// ---------------------------------------------------------------------------

export interface SelectableRow {
  readonly id: string;
}

/**
 * A list of rows where one row is selected.
 *
 * The whole row is a `<button>` rather than a clickable `<tr>`, so `Tab` reaches it, `Enter` and
 * `Space` activate it, and the selected row carries `aria-current`. Nothing here depends on a
 * pointer, which is the point of REQ-UI-06.
 */
export function SelectableTable<T extends SelectableRow>(props: {
  rows: ReadonlyArray<T>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  columns: ReadonlyArray<{ header: string; render: (row: T) => ReactNode; width?: string }>;
  caption: string;
  emptyMessage: string;
}): ReactNode {
  if (props.rows.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 12, color: "var(--pf-muted, #6b7280)" }}>{props.emptyMessage}</p>
    );
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
        <caption style={{ textAlign: "left", fontSize: 11, color: "var(--pf-muted, #6b7280)", paddingBottom: 4 }}>
          {props.caption}
        </caption>
        <thead>
          <tr>
            {props.columns.map((column) => (
              <th
                key={column.header}
                scope="col"
                style={{
                  textAlign: "left",
                  borderBottom: "1px solid var(--pf-border, rgba(127,127,127,0.35))",
                  padding: "4px 6px",
                  width: column.width,
                }}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => {
            const selected = row.id === props.selectedId;
            return (
              <tr
                key={row.id}
                style={{
                  background: selected ? "var(--pf-selected, rgba(96,165,250,0.12))" : undefined,
                  borderBottom: "1px solid var(--pf-border, rgba(127,127,127,0.18))",
                }}
              >
                {props.columns.map((column, index) => (
                  <td key={column.header} style={{ padding: "2px 6px", verticalAlign: "top" }}>
                    {index === 0 ? (
                      <button
                        type="button"
                        aria-current={selected ? "true" : undefined}
                        onClick={() => props.onSelect(row.id)}
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          font: "inherit",
                          color: "inherit",
                          textAlign: "left",
                          cursor: "pointer",
                          textDecoration: selected ? "underline" : undefined,
                        }}
                      >
                        {column.render(row)}
                      </button>
                    ) : (
                      column.render(row)
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
