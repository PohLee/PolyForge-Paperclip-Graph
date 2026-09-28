/**
 * Browser-safe protocol surface.
 *
 * Everything a same-origin plugin UI bundle may import: wire types, state vocabularies,
 * the error contract, the normalized event vocabulary, the provider-neutral ports, the
 * agent tool schemas, the bridge key contract, and the canonical JSON encoder.
 *
 * The one thing deliberately absent is the `node:crypto` digest surface in `./hashing`.
 * A UI must never compute an engineering identity: a hash it produced would be a second,
 * unverified source of truth for what "this contract" means. If a UI needs a digest, it
 * displays the one the Core computed.
 */

export * from "./api.js";
export * from "./bridge-contract.js";
export * from "./canonical.js";
export * from "./enums.js";
export * from "./errors.js";
export * from "./events.js";
export * from "./port-types.js";
export * from "./ports.js";
export * from "./tool-params.js";
