/**
 * The bridge's durable state has to survive a restart, and it has to be where the operator was
 * told it is.
 *
 * This file exists because the pilot caught the opposite. The process-level store was resolved to
 * `<tmpdir>/polyforge-bridge/instance-<random>/bridge.sqlite`: a temp directory, under a name
 * regenerated on every process start. Every restart therefore abandoned the previous worker's
 * inbox, outbox, delivery ledger, and command log, and the operator's configured `stateDir` was
 * used for nothing at all. Nothing failed loudly; undelivered work simply stopped being
 * remembered. These tests are the guard.
 */

import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));
const workerSource = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
const configSource = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");

test("the default state root is not the system temp directory", () => {
  assert.doesNotMatch(
    workerSource,
    /function fallbackStateRoot\(\)[^}]*tmpdir\(/,
    "a durable inbox and outbox under the temp directory do not survive a reboot or a tmpfiles sweep",
  );
});

test("the default state root honours an operator override", () => {
  assert.match(
    workerSource,
    /POLYFORGE_BRIDGE_STATE_ROOT/,
    "an operator must be able to choose where the bridge keeps its durable state",
  );
});

test("the default state root falls back to a persistent per-user location", () => {
  assert.match(workerSource, /homedir\(\)/, "the fallback must be a persistent per-user path");
});

test("the store location does not change between processes", () => {
  // A pid, a uuid, or a timestamp in the tag all mean "a fresh empty store on every restart".
  const tag = workerSource.slice(
    workerSource.indexOf("function instanceTag("),
    workerSource.indexOf("function instanceTag(") + 600,
  );
  assert.doesNotMatch(tag, /process\.pid/, "a pid-derived path abandons the previous worker's state");
  assert.doesNotMatch(tag, /randomUUID|Date\.now|getTime\(\)/, "a random or time-derived path is not stable");
  assert.match(tag, /manifest\.id/, "the tag must be derived from the plugin key, which does not change");
});

test("the store path is decided once by the worker, not derived from a company config", () => {
  // The store is instance-scoped: one SQLite file for the whole installation, with every row
  // namespaced by company. It is opened before any company is known, because `config.get` needs a
  // company context — so there is no company config available at that moment to derive a path from.
  //
  // Deriving it anyway produced a second, fictional location. Config validation then probed the
  // writability of a file the worker never opens, and health named that file in its error message:
  // both would confidently describe a store that does not exist. The invariant is therefore that
  // there is exactly one place that decides the path, and everything else is handed that value.
  assert.doesNotMatch(
    configSource,
    /storePath: `\$\{stateDir/,
    "the store path must not be re-derived from stateDir inside the resolver",
  );
  assert.match(
    configSource,
    /readonly storePath: string;/,
    "resolveConfig must take the store path as an input",
  );

  const decisions = workerSource.match(/bridgeStorePath\(\)/g) ?? [];
  assert.ok(decisions.length >= 3, `expected the one decision to be reused, saw ${decisions.length} uses`);
  assert.match(
    workerSource,
    /const storePath = bridgeStorePath\(\);/,
    "the worker must open the file the single decision names",
  );
  assert.match(
    workerSource,
    /storePath: bridgeStorePath\(\)/,
    "config validation must check the file the worker actually opens, not a derived one",
  );
  assert.match(
    workerSource,
    /new ConfigRegistry\(storePath\)/,
    "every company config must be told the real store path",
  );
});

test("stateDir is recorded as the operator's declaration, not as the store location", () => {
  // It is still accepted and still reported. What it must not do is claim to be where the store is,
  // because an operator reading that and looking in that directory finds nothing.
  assert.match(configSource, /stateDir = asString\(raw\["stateDir"\]\)/, "the operator's value must be honoured");
  assert.match(
    configSource,
    /storePath: input\.storePath/,
    "storePath must come from the worker, not from the operator's directory",
  );
});

test("the schema documents the store location an operator can set", () => {
  const properties = (h.manifest.instanceConfigSchema as { properties?: Record<string, unknown> })
    .properties as Record<string, { description?: string }>;
  assert.ok(properties["stateDir"], "stateDir must be configurable");
  assert.match(
    properties["stateDir"]!.description ?? "",
    /durable/i,
    "the description must say this is durable state, because that is what it is",
  );
  assert.match(
    properties["stateDir"]!.description ?? "",
    /instance-scoped|not the store|one file/i,
    "the description must not imply the store lives here; it does not",
  );
});

test("a store written by one worker is found by the next", async () => {
  // The property that actually matters, exercised through the real store: a record written by one
  // bridge is visible to another that opens the same path.
  const { BridgeStore } = await load<typeof import("../src/store.ts")>(
    new URL("../src/store.ts", import.meta.url),
  );
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const path = join(mkdtempSync(join(tmpdir(), "pf-store-persist-")), "bridge.sqlite");

  const first = BridgeStore.open({ path });
  first.bumpCounter("company-a", "inbox_duplicates", 3);
  first.close();

  // A restart: a brand new store object over the same file, exactly what a new worker does.
  const second = BridgeStore.open({ path });
  assert.equal(
    second.counters("company-a", ["inbox_duplicates"]).inbox_duplicates,
    3,
    "a counter written before a restart must still be there after it",
  );
  second.close();
});

test("AT-26: an expired sent delivery survives SQLite restart as ambiguous and is not reclaimed", async () => {
  const { BridgeStore } = await load<typeof import("../src/store.ts")>(new URL("../src/store.ts", import.meta.url));
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tempDir = mkdtempSync(join(tmpdir(), "pf-outbox-restart-"));
  const path = join(tempDir, "bridge.sqlite");
  let nowMs = 1_700_000_000_123;
  let store = BridgeStore.open({ path, now: () => new Date(nowMs) });

  try {
    store.enqueueDelivery({
      id: "delivery-restart-ambiguous",
      companyId: "company-a",
      projectId: "project-a",
      kind: "event.intake",
      effectKey: "effect:restart-ambiguous",
      correlationId: "restart-ambiguous",
      payload: { eventId: "event-1" },
    });
    const [claimed] = store.claimDueDeliveries({
      companyId: "company-a",
      owner: "worker-before-restart",
      limit: 1,
      leaseMs: 10_000,
    });
    assert.equal(claimed?.status, "sent");
    assert.equal(claimed?.leaseExpiresAt, new Date(nowMs + 10_000).toISOString());
    store.close();

    // Reopening just before expiry must not lose precision and steal the still-live lease.
    nowMs += 9_999;
    store = BridgeStore.open({ path, now: () => new Date(nowMs) });
    assert.deepEqual(
      store.claimDueDeliveries({
        companyId: "company-a",
        owner: "worker-after-restart",
        limit: 1,
        leaseMs: 10_000,
      }),
      [],
      "a millisecond lease is still active one millisecond before its expiry",
    );
    let row = store.getDeliveryByEffectKey("company-a", "effect:restart-ambiguous");
    assert.equal(row?.status, "sent");
    assert.equal(row?.leaseOwner, "worker-before-restart");

    // Once expired, the write's outcome is unknown. It is moved to reconciliation, not sent again.
    nowMs += 1;
    assert.deepEqual(
      store.claimDueDeliveries({
        companyId: "company-a",
        owner: "worker-after-restart",
        limit: 1,
        leaseMs: 10_000,
      }),
      [],
    );
    row = store.getDeliveryByEffectKey("company-a", "effect:restart-ambiguous");
    assert.equal(row?.status, "ambiguous");
    assert.equal(row?.leaseOwner, null);
    assert.match(row?.lastError ?? "", /outcome was unknown/);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
