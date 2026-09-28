/**
 * The configuration contract, and the reason it needs its own file.
 *
 * The host validates every saved plugin configuration against `manifest.instanceConfigSchema`
 * with `additionalProperties: false`. That makes the schema an *enforcement* surface, not
 * documentation: a key the worker reads but the schema omits is a setting the operator
 * physically cannot apply, and the only symptom is a 400 at save time.
 *
 * That is not hypothetical. `allowPrivateRuntimeHost` was read by `resolveConfig` and absent
 * from the schema, so the pilot could not be pointed at a loopback Runtime Service at all.
 * These tests make that class of bug a build failure instead of an operator's afternoon.
 */

import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));
const manifest = h.manifest;

/** Every `raw["key"]` the config resolver reads, read out of the source rather than restated. */
function keysTheResolverReads(): string[] {
  const source = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  const keys = new Set<string>();
  for (const match of source.matchAll(/raw\["([A-Za-z][A-Za-z0-9]*)"\]/g)) {
    keys.add(match[1]!);
  }
  // `experimental` is a nested object; its sub-keys are declared inline in the schema.
  return [...keys].sort();
}

interface SchemaShape {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
  additionalProperties?: boolean;
}

function schema(): SchemaShape {
  return manifest.instanceConfigSchema as SchemaShape;
}

test("the config schema accepts every key the resolver reads", () => {
  const declared = new Set(Object.keys(schema().properties ?? {}));
  const missing = keysTheResolverReads().filter((key) => !declared.has(key));
  assert.deepEqual(
    missing,
    [],
    "these keys are read by resolveConfig but absent from instanceConfigSchema, so an operator " +
      "cannot set them and the host rejects the config with a 400",
  );
});

test("the config schema declares no key the resolver ignores", () => {
  // A declared key that nothing reads is a setting an operator can change with no effect, which
  // is worse than a missing one: it looks like it works.
  const read = new Set([...keysTheResolverReads(), "experimental"]);
  const ignored = Object.keys(schema().properties ?? {}).filter((key) => !read.has(key));
  assert.deepEqual(ignored, [], "these keys are configurable but read by nothing");
});

test("the config schema is closed and names its three required fields", () => {
  assert.equal(schema().additionalProperties, false, "an open schema hides the drift above");
  assert.deepEqual([...(schema().required ?? [])].sort(), [
    "bridgeIssuer",
    "runtimeUrl",
    "sharedSecretRef",
  ]);
});

test("the SSRF opt-in is an explicit, per-company boolean", () => {
  const allow = (schema().properties ?? {})["allowPrivateRuntimeHost"] as
    | { type?: string; default?: unknown }
    | undefined;
  assert.ok(allow, "allowPrivateRuntimeHost must be configurable");
  assert.equal(allow!.type, "boolean");
  assert.equal(allow!.default, false, "a local Runtime Service must be opted into, not assumed");
});

test("the secret reference shape is enforced at the schema, not only in code", () => {
  const ref = (schema().properties ?? {})["sharedSecretRef"] as
    | { type?: string; required?: string[]; additionalProperties?: boolean; properties?: Record<string, { const?: string }> }
    | undefined;
  assert.ok(ref);
  assert.equal(ref!.type, "object");
  assert.deepEqual([...(ref!.required ?? [])].sort(), ["secretId", "type"]);
  assert.equal(ref!.properties?.["type"]?.const, "secret_ref");
  assert.equal(ref!.additionalProperties, false, "a legacy string ref must not be smuggled in");
});

test("the cache projection carries every key, so a rebuild cannot lose a decision", () => {
  // A resolved config is projected back into the raw shape so a company can rebuild its bridge
  // without another host round trip. Every field that projection drops is a field the rebuilt
  // bridge silently loses. `allowPrivateRuntimeHost` was dropped, so a rebuilt bridge refused its
  // own loopback Runtime Service and reported "no configuration" while the operator's
  // configuration was plainly visible — a failure that looks like a missing config and is not.
  const worker = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
  const at = worker.indexOf("function configFromCache(");
  assert.notEqual(at, -1, "expected configFromCache in worker.ts");
  const body = worker.slice(at, worker.indexOf("\n}", at));
  const carried = new Set([...body.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]!));

  // The resolver reads these keys; every one of them must survive the round trip.
  const required = new Set(keysTheResolverReads());
  const missing = [...required].filter((key) => !carried.has(key));
  assert.deepEqual(
    [...missing].sort(),
    [],
    "these keys are lost when a company bridge is rebuilt from a resolved config, so the rebuilt " +
      "bridge would not behave like the one the operator configured",
  );
  for (const key of carried) {
    assert.ok(
      required.has(key) || key === "experimental",
      `${key} is projected into a resolved config but nothing reads it back`,
    );
  }
});

test("the SSRF opt-in survives the cache projection", () => {
  const worker = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
  const at = worker.indexOf("function configFromCache(");
  const body = worker.slice(at, worker.indexOf("\n}", at));
  assert.match(
    body,
    /allowPrivateRuntimeHost:\s*config\.allowPrivateRuntimeHost/,
    "a rebuild must not silently change whether a private address is permitted",
  );
});

test("every experimental capability defaults to off", () => {
  const experimental = (schema().properties ?? {})["experimental"] as
    | { properties?: Record<string, { default?: unknown }> }
    | undefined;
  assert.ok(experimental);
  const keys = Object.keys(experimental!.properties ?? {});
  assert.deepEqual(keys.sort(), ["cases", "decisions", "pipelines"]);
  for (const key of keys) {
    assert.equal(
      experimental!.properties![key]!.default,
      false,
      `${key} must default to off: the Root Issue plus human-only Interaction path has to keep ` +
        "working with every experimental capability disabled",
    );
  }
});
