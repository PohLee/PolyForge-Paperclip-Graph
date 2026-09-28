/**
 * Content digests over the canonical encoding.
 *
 * Split out of `./canonical.ts` so the canonical encoder itself stays free of Node
 * built-ins: the plugin's browser bundle can then import the encoder, the wire types, and
 * the bridge key tables without pulling `node:crypto` into a platform that has no Node.
 *
 * Every immutable identity in PolyForge is `sha256:<hex>` over the canonical bytes, with
 * a domain mixed in so two identity classes can never collide. The Python Graph Core
 * implements the identical algorithm in `polyforge/core/hashing.py`; the contract suite
 * pins both sides to one fixture set.
 */

import { createHash } from "node:crypto";

import { canonicalBytes, canonicalJson } from "./canonical.js";

/** `sha256:<hex>` digest of raw bytes. */
export function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** `sha256:<hex>` digest of a UTF-8 string. */
export function digestText(text: string): string {
  return digestBytes(new TextEncoder().encode(text));
}

/** `sha256:<hex>` digest of the canonical encoding of `value`. */
export function hashCanonical(value: unknown): string {
  return digestBytes(canonicalBytes(value));
}

/**
 * Domain-separated hash. Mixing the domain in keeps identity classes disjoint: an
 * evidence-set hash can never collide with a contract hash even if the payloads match.
 */
export function hashDomain(domain: string, value: unknown): string {
  return hashCanonical({ domain, value });
}

export { canonicalBytes, canonicalJson };
