/**
 * Canonical JSON encoding and content hashing.
 *
 * Every immutable identity in PolyForge (definition hash, plan hash, contract hash,
 * evidence set hash, decision target hash, idempotency payload hash) is derived through
 * this module, and the Python Graph Core implements the identical algorithm in
 * `polyforge/core/hashing.py`. `tests/contract/` contains a cross-language conformance
 * fixture set; a divergence fails the contract suite rather than silently producing two
 * incompatible identity spaces.
 *
 * Rules (normative — see docs/05-PROTOCOL.md §2):
 *
 * 1. Encoding is UTF-8.
 * 2. Object keys are sorted by their UTF-16 code unit sequence (JS default `Array#sort`
 *    on strings), which equals byte order for the subset of keys we emit.
 * 3. `undefined` object values are omitted; `undefined` inside an array is an error.
 * 4. `null` is preserved and is distinct from an omitted key.
 * 5. Arrays keep their order. Order is semantic for `edges`, `nodeIds`, `evidenceIds`.
 * 6. Numbers must be finite. `-0` is normalized to `0`. `NaN`/`Infinity` are an error.
 *    Integers are emitted without a fractional part; other numbers use the shortest
 *    round-tripping decimal form produced by `JSON.stringify`.
 * 7. No whitespace.
 * 8. Strings are emitted as JSON strings with the standard JSON escape rules. Values
 *    that are content digests are never normalised or lower-cased here.
 *
 * This module is deliberately free of Node built-ins: it is the one part of the protocol
 * the plugin's browser bundle needs. The `node:crypto` digests live in `./hashing.ts`,
 * which is only reachable from the Node entry point.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class CanonicalJsonError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} at ${path || "$"}`);
    this.name = "CanonicalJsonError";
  }
}

function encode(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }
  const t = typeof value;
  if (t === "boolean") {
    out.push(value ? "true" : "false");
    return;
  }
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new CanonicalJsonError(`non-finite number is not encodable (${String(n)})`, path);
    }
    out.push(Object.is(n, -0) ? "0" : JSON.stringify(n));
    return;
  }
  if (t === "string") {
    out.push(JSON.stringify(value as string));
    return;
  }
  if (Array.isArray(value)) {
    out.push("[");
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out.push(",");
      const item = (value as unknown[])[i];
      if (item === undefined) {
        throw new CanonicalJsonError("undefined is not encodable inside an array", `${path}[${i}]`);
      }
      encode(item, `${path}[${i}]`, out);
    }
    out.push("]");
    return;
  }
  if (t === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    out.push("{");
    let first = true;
    for (const key of keys) {
      if (!first) out.push(",");
      first = false;
      out.push(JSON.stringify(key), ":");
      encode(record[key], path ? `${path}.${key}` : key, out);
    }
    out.push("}");
    return;
  }
  throw new CanonicalJsonError(`unsupported value of type ${t}`, path);
}

/** Encode `value` to the canonical JSON text described in the module docblock. */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  encode(value, "", out);
  return out.join("");
}

/** UTF-8 bytes of the canonical encoding. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

/** Stable, human-readable key material for idempotency identities. */
export function stableIdempotencyKey(parts: readonly string[]): string {
  return parts
    .map((p) => encodeURIComponent(p))
    .join(":")
    .slice(0, 512);
}
