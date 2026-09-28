/**
 * The artifact DTO the Core reads, field for field.
 *
 * `RuntimeService.submit_artifacts` looks an artifact up by `(kind, contentHash)`, refuses a
 * reference without a well-formed digest, and reads `source` for the create-or-verify conflict
 * check. The tool was sending `{ kind, contentHash, ref }`: `source` never arrived, and the ref sat
 * under a name the Core does not read.
 *
 * Losing `source` is not cosmetic. It is what makes a reference immutable, and without it the same
 * source identity can be re-pointed at different bytes without the Core noticing.
 *
 * The digest matters just as much. It was the value the *caller* declared, echoed straight back. The
 * artifact port computes the digest of the bytes it actually read and refuses on a mismatch, so
 * echoing the declaration made the Core's record a restatement of the request rather than a finding.
 */

import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));

const bridges: { dispose(): void }[] = [];

function track<T extends { dispose(): void }>(bridge: T): T {
  bridges.push(bridge);
  return bridge;
}

// Each bridge starts an HTTP server for the fake Runtime. `after` closes them while the loop is
// still running; a `process.on("exit")` handler runs too late and node then reports the test file
// as having an unresolved promise.
after(() => {
  for (const bridge of bridges) {
    try {
      bridge.dispose();
    } catch {
      // A bridge that already tore itself down is not a failure worth reporting.
    }
  }
});

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * A bridge with the issue the artifact is stored against. The artifact port writes through a
 * company-scoped issue attachment, so an issue has to exist for the store to attach to — a missing
 * one is a real refusal, not a test-harness inconvenience.
 */
async function bridgeWithIssue() {
  return h.buildBridge({
    seed: {
      companies: [h.company(h.COMPANY_A)],
      projects: [h.project(h.PROJECT_A, h.COMPANY_A)],
      issues: [h.issue("root-a", h.COMPANY_A, h.PROJECT_A)],
      agents: [h.agent("agent-1", h.COMPANY_A)],
    },
  });
}

test("the artifact record carries the Core's fields, and the digest is the verified one", async () => {
  const bridge = track(await bridgeWithIssue());
  const port = bridge.company.ports.artifacts;

  const body = "design note\n";
  const contentHash = sha256(body);
  const published = await port.publish(
    {
      scope: { companyRef: h.COMPANY_A, projectRef: h.PROJECT_A },
      kind: "report",
      contentHash,
      mediaType: "text/plain",
      size: body.length,
      source: { kind: "inline", ref: "issue:root-a", body },
    },
    { commandId: "c1", idempotencyKey: "pf:artifact:1", correlationId: "corr" },
  );

  // The three fields the Core reads, named as the Core names them.
  assert.match(published.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal((published.source as Record<string, unknown>)["ref"], "issue:root-a");
  assert.equal((published.source as Record<string, unknown>)["kind"], "inline");
  // The ref names *where the bytes live* (a revision of an issue document), which is deliberately
  // not the business kind. The Core keys the artifact by `kind` + `contentHash`, and the ref is how
  // it finds the bytes again; conflating the two would make the two look interchangeable.
  const ref = published.providerRef as Record<string, unknown>;
  assert.equal(typeof ref["id"], "string");
  assert.equal(ref["kind"], "issue_document_revision");

  // The digest is the one computed from the bytes, which is what the port verified.
  const verified = await port.readVerified(published.providerRef);
  assert.equal(verified.digestVerified, true);
  assert.equal(verified.contentHash, contentHash);
});

test("a declared digest that does not match the bytes never produces a record", async () => {
  const bridge = track(await bridgeWithIssue());
  const port = bridge.company.ports.artifacts;

  const body = "real bytes\n";
  await assert.rejects(
    () =>
      port.publish(
        {
          scope: { companyRef: h.COMPANY_A, projectRef: h.PROJECT_A },
          kind: "report",
          contentHash: sha256("something else entirely"),
          mediaType: "text/plain",
          size: body.length,
          source: { kind: "inline", ref: "issue:root-a", body },
        },
        { commandId: "c2", idempotencyKey: "pf:artifact:2", correlationId: "corr" },
      ),
    (error: unknown) => {
      const err = error as { code?: string };
      assert.equal(err.code, "BRIDGE_INTEGRITY_FAILURE");
      return true;
    },
    "a caller cannot register an artifact by declaring a digest it did not produce",
  );
});
