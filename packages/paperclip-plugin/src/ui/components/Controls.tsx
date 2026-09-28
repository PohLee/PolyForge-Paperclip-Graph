/**
 * Form controls.
 *
 * Every control here is a real focusable form element with a real `<label>`, because REQ-UI-06
 * treats keyboard editability as acceptance criteria rather than polish. The canvas in this
 * plugin is an orientation aid; the properties form is the editor, and it has to be complete
 * without a pointer.
 *
 * Nothing here hides an error. A field that fails validation says so in text next to the field,
 * so the message is present whether the reviewer is looking at the field, tabbing to it, or
 * reading the validation list at the bottom of the editor.
 */

import { useId, type ChangeEvent, type ReactNode } from "react";
import { MONO_FONT, RADIUS, SPACE } from "../theme.js";
import { Stack } from "./Layout.js";

const CONTROL_STYLE = {
  width: "100%",
  boxSizing: "border-box" as const,
  padding: "4px 6px",
  borderRadius: RADIUS.sm,
  border: "1px solid var(--pf-border, rgba(127,127,127,0.45))",
  background: "var(--pf-input-bg, transparent)",
  color: "inherit",
  font: "inherit",
  fontSize: 13,
};

const ERROR_COLOUR = "var(--pf-danger, #f87171)";

function describedBy(...ids: Array<string | null | undefined>): string | undefined {
  const present = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  return present.length === 0 ? undefined : present.join(" ");
}

export function FieldShell(props: {
  label: string;
  labelFor: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
  /** Anchor target, e.g. the node id a validation issue points at. */
  anchor?: string | undefined;
}): ReactNode {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <label htmlFor={props.labelFor} style={{ fontSize: 12, fontWeight: 600 }}>
        {props.label}
        {props.anchor === undefined ? null : (
          <span style={{ fontWeight: 400, color: "var(--pf-muted, #6b7280)" }}> · {props.anchor}</span>
        )}
      </label>
      {props.children}
      {props.hint === undefined ? null : (
        <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)" }}>{props.hint}</span>
      )}
      {props.error === undefined ? null : (
        <span role="alert" style={{ fontSize: 11, color: ERROR_COLOUR }}>
          {props.error}
        </span>
      )}
    </div>
  );
}

export function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
  placeholder?: string;
  disabled?: boolean;
  anchor?: string;
  monospace?: boolean;
}): ReactNode {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <FieldShell label={props.label} labelFor={id} hint={props.hint} error={props.error} anchor={props.anchor}>
      <input
        id={id}
        type="text"
        value={props.value}
        disabled={props.disabled === true}
        placeholder={props.placeholder}
        aria-invalid={props.error === undefined ? undefined : true}
        aria-describedby={describedBy(props.hint === undefined ? null : hintId, props.error === undefined ? null : errorId)}
        onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value)}
        style={{
          ...CONTROL_STYLE,
          fontFamily: props.monospace === true ? MONO_FONT : undefined,
          borderColor: props.error === undefined ? undefined : ERROR_COLOUR,
        }}
      />
      {props.hint === undefined ? null : (
        <span id={hintId} style={{ display: "none" }}>
          {props.hint}
        </span>
      )}
      {props.error === undefined ? null : (
        <span id={errorId} style={{ display: "none" }}>
          {props.error}
        </span>
      )}
    </FieldShell>
  );
}

export function TextAreaField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  hint?: string;
  error?: string;
  disabled?: boolean;
  monospace?: boolean;
}): ReactNode {
  const id = useId();
  return (
    <FieldShell label={props.label} labelFor={id} hint={props.hint} error={props.error}>
      <textarea
        id={id}
        value={props.value}
        rows={props.rows ?? 4}
        disabled={props.disabled === true}
        aria-invalid={props.error === undefined ? undefined : true}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => props.onChange(event.target.value)}
        style={{
          ...CONTROL_STYLE,
          resize: "vertical",
          fontFamily: props.monospace === true ? MONO_FONT : undefined,
          borderColor: props.error === undefined ? undefined : ERROR_COLOUR,
        }}
      />
    </FieldShell>
  );
}

export function NumberField(props: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  hint?: string;
  error?: string;
  min?: number;
  disabled?: boolean;
}): ReactNode {
  const id = useId();
  return (
    <FieldShell label={props.label} labelFor={id} hint={props.hint} error={props.error}>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        value={props.value === null ? "" : String(props.value)}
        min={props.min}
        disabled={props.disabled === true}
        aria-invalid={props.error === undefined ? undefined : true}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const raw = event.target.value;
          if (raw.trim().length === 0) {
            props.onChange(null);
            return;
          }
          const parsed = Number(raw);
          props.onChange(Number.isFinite(parsed) ? parsed : null);
        }}
        style={{ ...CONTROL_STYLE, borderColor: props.error === undefined ? undefined : ERROR_COLOUR }}
      />
    </FieldShell>
  );
}

export function SelectField<T extends string>(props: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  hint?: string;
  error?: string;
  disabled?: boolean;
}): ReactNode {
  const id = useId();
  return (
    <FieldShell label={props.label} labelFor={id} hint={props.hint} error={props.error}>
      <select
        id={id}
        value={props.value}
        disabled={props.disabled === true}
        aria-invalid={props.error === undefined ? undefined : true}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => props.onChange(event.target.value as T)}
        style={{ ...CONTROL_STYLE, borderColor: props.error === undefined ? undefined : ERROR_COLOUR }}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function CheckboxField(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  disabled?: boolean;
}): ReactNode {
  const id = useId();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <label htmlFor={id} style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 12 }}>
        <input
          id={id}
          type="checkbox"
          checked={props.checked}
          disabled={props.disabled === true}
          onChange={(event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>{props.label}</span>
      </label>
      {props.hint === undefined ? null : (
        <span style={{ fontSize: 11, color: "var(--pf-muted, #6b7280)", paddingLeft: 22 }}>{props.hint}</span>
      )}
    </div>
  );
}

/**
 * An editable list of strings, as one `key: value` line per entry.
 *
 * A list *editor* with add/remove buttons would be nicer to use, but a line-per-entry textarea is
 * fully keyboard operable, has no focus-management edge cases, and round-trips through the
 * canonical payload the Core expects. The format is stated in the hint so it is not a secret.
 */
export function StringListField(props: {
  label: string;
  values: ReadonlyArray<string>;
  onChange: (values: string[]) => void;
  hint?: string;
  error?: string;
  disabled?: boolean;
  /** Placeholder shown when the list is empty. */
  placeholder?: string;
}): ReactNode {
  const id = useId();
  const text = props.values.join("\n");
  return (
    <FieldShell
      label={props.label}
      labelFor={id}
      hint={props.hint ?? "One entry per line. Empty lines are ignored."}
      error={props.error}
    >
      <textarea
        id={id}
        value={text}
        rows={Math.min(10, Math.max(3, props.values.length + 1))}
        placeholder={props.placeholder}
        disabled={props.disabled === true}
        aria-invalid={props.error === undefined ? undefined : true}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
          props.onChange(
            event.target.value
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0),
          )
        }
        style={{
          ...CONTROL_STYLE,
          fontFamily: MONO_FONT,
          resize: "vertical",
          borderColor: props.error === undefined ? undefined : ERROR_COLOUR,
        }}
      />
    </FieldShell>
  );
}

/** An editable `Record<string, string>` — inputs, join inputs, subgraph bindings. */
export function RecordField(props: {
  label: string;
  value: Readonly<Record<string, string>>;
  onChange: (value: Record<string, string>) => void;
  hint?: string;
  error?: string;
  disabled?: boolean;
}): ReactNode {
  const id = useId();
  const lines = Object.entries(props.value).map(([key, item]) => `${key}=${item}`);
  return (
    <FieldShell
      label={props.label}
      labelFor={id}
      hint={props.hint ?? "One `key=value` per line. A value containing `=` is split on the first `=` only."}
      error={props.error}
    >
      <textarea
        id={id}
        value={lines.join("\n")}
        rows={Math.min(10, Math.max(3, lines.length + 1))}
        disabled={props.disabled === true}
        aria-invalid={props.error === undefined ? undefined : true}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
          const next: Record<string, string> = {};
          for (const line of event.target.value.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            const split = trimmed.indexOf("=");
            if (split <= 0) continue;
            next[trimmed.slice(0, split).trim()] = trimmed.slice(split + 1).trim();
          }
          props.onChange(next);
        }}
        style={{ ...CONTROL_STYLE, fontFamily: MONO_FONT, resize: "vertical", borderColor: props.error === undefined ? undefined : ERROR_COLOUR }}
      />
    </FieldShell>
  );
}

export function ButtonRow(props: { children: ReactNode; label?: string }): ReactNode {
  return (
    <Stack gap={SPACE.xs}>
      {props.label === undefined ? null : (
        <span style={{ fontSize: 12, fontWeight: 600 }}>{props.label}</span>
      )}
      <div style={{ display: "flex", gap: SPACE.xs, flexWrap: "wrap" }}>{props.children}</div>
    </Stack>
  );
}
