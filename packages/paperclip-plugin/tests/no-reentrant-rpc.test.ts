/**
 * Two host rules the bridge has to live inside, learned the hard way by the pilot.
 *
 * 1. **The worker's RPC loop is single-threaded.** A handler the host is waiting on must never
 *    await a call *back* into the host: the reply can never be read, the handler never completes,
 *    and the plugin looks alive while delivering nothing. A job handler that awaited
 *    `companies.list()` before pumping the outbox did exactly this.
 *
 * 2. **`config.get` requires an active company-scoped invocation.** Outside an event, an API
 *    route, a tool run, or a UI bridge call, the host refuses it with "company context is
 *    required". A scheduled job therefore *cannot* discover a company; it can only serve
 *    companies a company-scoped path has already taught the bridge.
 *
 * Together these fix where configuration is learned: company-scoped paths learn, and the fetch
 * itself is deferred onto the event loop. These tests hold that structure in place.
 */

import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const worker = readFileSync(new URL("../src/worker.ts", import.meta.url), "utf8");
const pump = readFileSync(new URL("../src/events/pump.ts", import.meta.url), "utf8");

function bodyOf(text: string, needle: string, span = 900): string {
  const at = text.indexOf(needle);
  assert.notEqual(at, -1, `expected to find ${needle}`);
  return text.slice(at, at + span);
}

test("no job handler awaits a host call", () => {
  for (const job of ['ctx.jobs.register("outbox-pump"', 'ctx.jobs.register("reconcile"']) {
    const handler = bodyOf(worker, job);
    assert.doesNotMatch(
      handler,
      /await\s+(warmConfiguredCompanies|shared\.ctx|ctx\.config|ctx\.companies)/,
      `${job} awaits a host call and will deadlock the worker's RPC loop`,
    );
  }
});

test("no lifecycle hook awaits a host call", () => {
  for (const hook of ["async onHealth(", "async onValidateConfig("]) {
    const at = worker.indexOf(hook);
    assert.notEqual(at, -1, `expected ${hook}`);
    // `onValidateConfig` legitimately probes the Runtime Service, which is an outbound HTTP call
    // to *this* plugin's own service rather than a call back into the host. Only the host-facing
    // `ctx.*` clients are forbidden here.
    const segment = worker.slice(at, at + 2500);
    assert.doesNotMatch(
      segment,
      /await\s+shared\.ctx[?!]?\./,
      `${hook} awaits a host call and will deadlock the worker's RPC loop`,
    );
  }
});

test("the company resolver learns the company without awaiting the host", () => {
  const resolver = bodyOf(worker, "function resolverFor(", 1600);
  assert.match(resolver, /learnCompany\(shared, companyId\)/, "the resolver must learn the company");
  assert.doesNotMatch(
    resolver,
    /await\s+shared\.ctx/,
    "the resolver runs on the getData RPC path; a host call awaited there re-enters the loop",
  );
});

test("the event path learns the company, because an event is company-scoped", () => {
  const handler = bodyOf(pump, "async handle(event: PluginEvent)");
  assert.match(
    handler,
    /learnCompany\(companyId\)/,
    "an event handler is one of the few contexts where the host answers config.get",
  );
});

test("learning defers the host call onto the event loop", () => {
  const learn = bodyOf(worker, "function learnCompany(", 1800);
  assert.match(learn, /setTimeout/, "the fetch must be deferred so no RPC is in flight");
  assert.doesNotMatch(learn, /^\s*await\s/m, "learnCompany itself is not async; it schedules");
  assert.match(learn, /learning\.add/, "concurrent triggers for one company must coalesce");
  assert.match(learn, /learning\.delete/, "and must be released when the pass finishes");
});

test("discovery records its outcome in the bridge's own durable store", () => {
  const record = bodyOf(worker, "function recordDiscovery(");
  assert.match(record, /store\.setCompat\(/, "the outcome must be readable without host logs");
  assert.match(record, /configuration_discovery/, "under a stable key an operator can query");
});

test("the store is only asked for companies it already knows are its own", () => {
  // Nothing here should reach for the whole company list from a job: that call has no company
  // context, and `config.get` for each company would not either.
  const outboxJob = bodyOf(worker, 'ctx.jobs.register("outbox-pump"');
  assert.doesNotMatch(outboxJob, /ctx\.companies\.list/, "a job has no company context to list against");
});
