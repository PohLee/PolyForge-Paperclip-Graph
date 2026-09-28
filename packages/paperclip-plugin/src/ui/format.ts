/**
 * Presentation-only formatting.
 *
 * Everything here is a pure function from a wire value to a string, and every one of them is
 * total: an absent, malformed, or unexpected value produces an explicit "not reported" string
 * rather than `NaN`, `Invalid Date`, or an empty cell. A blank field next to a green badge is
 * indistinguishable from a pass, so `—` is never used on its own — absence always names
 * itself.
 */

import type { ProviderRefLike } from "@polyforge/protocol";

const NOT_REPORTED = "not reported";

function text(value: string | null | undefined, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  const trimmed = value.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

function numeric(value: number | null | undefined, fallback: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  return String(value);
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Parse an ISO timestamp, or `null`. A malformed timestamp must not render as "Invalid Date". */
export function parseInstant(iso: string | null | undefined): Date | null {
  if (typeof iso !== "string" || iso.trim().length === 0) return null;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Absolute local time with the timezone spelled out, so a screenshot is unambiguous. */
export function formatTimestamp(iso: string | null | undefined, fallback = NOT_REPORTED): string {
  const parsed = parseInstant(iso);
  if (parsed === null) return fallback;
  const zone = resolvedZone();
  return `${parsed.toLocaleString(undefined, { hour12: false })} ${zone}`;
}

function resolvedZone(): string {
  try {
    const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date());
    return zone.find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    // A host without full ICU still has to render a timestamp; omitting the zone beats throwing.
    return "";
  }
}

const RELATIVE_UNITS: ReadonlyArray<readonly [limitSeconds: number, divisor: number, unit: Intl.RelativeTimeFormatUnit]> = [
  [60, 1, "second"],
  [3600, 60, "minute"],
  [86_400, 3600, "hour"],
  [604_800, 86_400, "day"],
  [2_629_800, 604_800, "week"],
  [31_557_600, 2_629_800, "month"],
  [Number.POSITIVE_INFINITY, 31_557_600, "year"],
];

/** "3 minutes ago". `now` is injectable so a snapshot and a stream event compare consistently. */
export function formatRelative(
  iso: string | null | undefined,
  now: number = Date.now(),
  fallback = NOT_REPORTED,
): string {
  const parsed = parseInstant(iso);
  if (parsed === null) return fallback;
  const deltaSeconds = (parsed.getTime() - now) / 1000;
  const magnitude = Math.abs(deltaSeconds);
  if (magnitude < 5) return "just now";
  for (const [limit, divisor, unit] of RELATIVE_UNITS) {
    if (magnitude < limit) {
      const value = Math.round(deltaSeconds / divisor);
      try {
        return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(value, unit);
      } catch {
        return `${Math.abs(value)} ${unit}${Math.abs(value) === 1 ? "" : "s"} ${value < 0 ? "ago" : "from now"}`;
      }
    }
  }
  return fallback;
}

/** Absolute plus relative. The absolute half is what a reviewer needs when the relative is wrong. */
export function formatInstantPair(iso: string | null | undefined, now: number = Date.now()): string {
  const parsed = parseInstant(iso);
  if (parsed === null) return NOT_REPORTED;
  return `${formatTimestamp(iso)} (${formatRelative(iso, now)})`;
}

/** Elapsed time between two instants. An unparseable end reads as "still open", not as zero. */
export function formatElapsed(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
  now: number = Date.now(),
): string {
  const start = parseInstant(startIso);
  if (start === null) return NOT_REPORTED;
  const end = parseInstant(endIso);
  if (end === null) {
    if (typeof endIso === "string" && endIso.trim().length > 0) return "end not reported";
    return `open for ${formatDurationSeconds(Math.max(0, (now - start.getTime()) / 1000))}`;
  }
  return formatDurationSeconds(Math.max(0, (end.getTime() - start.getTime()) / 1000));
}

/** Duration from a millisecond count. Sub-second work is reported in milliseconds, not as `0s`. */
export function formatDurationMilliseconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return NOT_REPORTED;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return formatDurationSeconds(ms / 1000);
}

export function formatDurationSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return NOT_REPORTED;
  }
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${trimNumber(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * Age of a counter that the Core reports in seconds.
 *
 * `null` means the Core could not compute the gauge — a missing gauge is not a zero gauge, so it
 * renders as "not reported" and never as "0s".
 */
export function formatAgeSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return NOT_REPORTED;
  if (seconds < 0) return NOT_REPORTED;
  return formatDurationSeconds(seconds);
}

// ---------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------

const BYTE_UNITS = ["B", "kB", "MB", "GB", "TB", "PB"] as const;

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return NOT_REPORTED;
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${BYTE_UNITS[unit]}`;
}

// ---------------------------------------------------------------------------
// Counters, counts, percentages
// ---------------------------------------------------------------------------

/** An integer counter. A null counter is "not reported", never `0`. */
export function formatCount(value: number | null | undefined, fallback = NOT_REPORTED): string {
  return numeric(value, fallback);
}

export function formatPercent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return NOT_REPORTED;
  return `${(fraction * 100).toFixed(fraction === 0 || fraction === 1 ? 0 : 1)}%`;
}

export function formatBoolean(value: boolean | null | undefined, whenUnknown = NOT_REPORTED): string {
  if (value === null || value === undefined) return whenUnknown;
  return value ? "yes" : "no";
}

/** A list that names its own emptiness. A bare empty list is ambiguous in a dense table. */
export function formatList(items: ReadonlyArray<string>, empty = "none"): string {
  return items.length === 0 ? empty : items.join(", ");
}

export function formatCounted(items: ReadonlyArray<string>, empty = "none"): string {
  return items.length === 0 ? empty : `${items.length} (${items.join(", ")})`;
}

// ---------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------

/** `sha256:abcdef…123456` — enough to eyeball, with the full value one copy away. */
export function shortHash(hash: string | null | undefined, lead = 8, tail = 6): string {
  const value = text(hash, "");
  if (value.length === 0) return NOT_REPORTED;
  const body = value.includes(":") ? value.slice(value.indexOf(":") + 1) : value;
  const prefix = value.includes(":") ? `${value.slice(0, value.indexOf(":") + 1)}` : "";
  if (body.length <= lead + tail + 1) return value;
  return `${prefix}${body.slice(0, lead)}…${body.slice(body.length - tail)}`;
}

export function fullHash(hash: string | null | undefined): string {
  return text(hash, NOT_REPORTED);
}

// ---------------------------------------------------------------------------
// Identifiers and provider refs
// ---------------------------------------------------------------------------

/** Ids are long and opaque; a short form keeps a table readable while the full id stays in `title`. */
export function shortId(id: string | null | undefined, length = 8): string {
  const value = text(id, "");
  if (value.length === 0) return NOT_REPORTED;
  return value.length <= length + 1 ? value : `${value.slice(0, length)}…`;
}

export function formatProviderRef(ref: ProviderRefLike | null | undefined): string {
  if (ref === null || ref === undefined) return NOT_REPORTED;
  const provider = text(ref.provider, "unknown-provider");
  const kind = text(ref.kind, "unknown-kind");
  const id = text(ref.id, "unknown-id");
  const revision = text(ref.revision, "");
  return revision.length === 0
    ? `${provider} · ${kind} · ${id}`
    : `${provider} · ${kind} · ${id} @ ${revision}`;
}

/**
 * A host-internal path for a provider ref, or `null` when the provider is not one the host owns.
 *
 * Only `paperclip` refs are resolved: a `github` or `jira` ref must never be turned into a
 * Paperclip route, because a link that silently points somewhere else is worse than no link.
 */
export function providerRefPath(ref: ProviderRefLike | null | undefined): string | null {
  if (ref === null || ref === undefined) return null;
  if (ref.provider !== "paperclip") return null;
  if (ref.kind === "issue") return `/issues/${ref.id}`;
  if (ref.kind === "agent") return `/agents/${ref.id}`;
  if (ref.kind === "run") return `/runs/${ref.id}`;
  if (ref.kind === "project") return `/projects/${ref.id}`;
  return null;
}

// ---------------------------------------------------------------------------
// Text safety
// ---------------------------------------------------------------------------

/**
 * Collapse a wire string to a single line of plain text.
 *
 * React escapes on render, so this is not an injection defence — it is a layout one, and it
 * also guarantees no control character (a bidi override, a NUL, a stray CR) reaches a table
 * cell where it could reorder what a reviewer reads.
 */
export function oneLine(value: string | null | undefined, fallback = NOT_REPORTED): string {
  if (value === null || value === undefined) return fallback;
  // C0/C1 controls, bidi overrides, bidi isolates, and the two line separators. Every one of
  // them can reorder or hide text a reviewer believes they are reading.
  const cleaned = value.replace(
    /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    " ",
  );
  const collapsed = cleaned.replace(/\s+/g, " ").trim();
  return collapsed.length === 0 ? fallback : collapsed;
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Readable rendering of an arbitrary JSON value, without ever injecting markup. */
export function formatJson(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return NOT_REPORTED;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return "[value could not be serialised]";
  }
}
