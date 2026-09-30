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
import { test } from "node:test";
import { createHash } from "node:crypto";
import { load } from "./helpers/bootstrap.ts";

const h = await load<typeof import("./helpers/harness.ts")>(new URL("./helpers/harness.ts", import.meta.url));

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

test("the artifact record carries the Core's fields, and the digest is the verified one", async () => {
  const bridge = await h.buildBridge({
    seed: {
      companies: [h.company(h.COMPANY_A)],
      projects: [h.project(h.PROJECT_A, h.COMPANY_A)],
      issues: [h.issue("root-a", h.COMPANY_A, h.PROJECT_A)],
    },
  });
  try {
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
  assert.equal((published.providerRef as Record<string, unknown>)["kind"], "issue_document_revision");
  assert.equal(typeof (published.providerRef as Record<string, unknown>)["id"], "string");

  // The digest is the one computed from the bytes, which is what the port verified.
  const verified = await port.readVerified(published.providerRef);
  assert.equal(verified.digestVerified, true);
    assert.equal(verified.contentHash, contentHash);
  } finally {
    await bridge.dispose();
  }
});

test("a declared digest that does not match the bytes never produces a record", async () => {
  const bridge = await h.buildBridge({
    seed: {
      companies: [h.company(h.COMPANY_A)],
      projects: [h.project(h.PROJECT_A, h.COMPANY_A)],
      issues: [h.issue("root-a", h.COMPANY_A, h.PROJECT_A)],
    },
  });
  try {
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
  } finally {
    await bridge.dispose();
  }
});

test("attachment evidence is refused explicitly when the manifest does not grant attachment reads", async () => {
  const bridge = await h.buildBridge({
    seed: {
      companies: [h.company(h.COMPANY_A)],
      projects: [h.project(h.PROJECT_A, h.COMPANY_A)],
      issues: [h.issue("root-a", h.COMPANY_A, h.PROJECT_A)],
    },
  });
  try {
    await assert.rejects(
      () => bridge.company.ports.artifacts.publish(
        {
          scope: { companyRef: h.COMPANY_A, projectRef: h.PROJECT_A },
          kind: "report",
          contentHash: sha256("attachment bytes"),
          mediaType: "text/plain",
          size: "attachment bytes".length,
          source: { kind: "attachment", ref: "attachment-1" },
        },
        { commandId: "attachment-c1", idempotencyKey: "pf:artifact:attachment", correlationId: "attachment-corr" },
      ),
      /attachment evidence is not enabled/,
    );
  } finally {
    await bridge.dispose();
  }
});

test("AT-09: updating a mutable document creates new evidence without rewriting the old snapshot", async () => {
  const bridge = await h.buildBridge({
    seed: {
      companies: [h.company(h.COMPANY_A)],
      projects: [h.project(h.PROJECT_A, h.COMPANY_A)],
      issues: [h.issue("root-a", h.COMPANY_A, h.PROJECT_A)],
    },
  });
  try {
    const port = bridge.company.ports.artifacts;
    const source = { kind: "document" as const, ref: "issue:root-a/spec" };
    const originalBody = "revision one\n";
    const updatedBody = "revision two\n";

    const originalDocument = await bridge.ctx.issues.documents.upsert({
      issueId: "root-a",
      key: "spec",
      companyId: h.COMPANY_A,
      body: originalBody,
      title: "Spec",
      format: "markdown",
      changeSummary: "initial source",
    });
    const original = await port.publish(
      {
        scope: { companyRef: h.COMPANY_A, projectRef: h.PROJECT_A },
        kind: "specification",
        contentHash: sha256(originalBody),
        mediaType: "text/markdown",
        size: originalBody.length,
        source,
      },
      { commandId: "doc-c1", idempotencyKey: "pf:artifact:doc-v1", correlationId: "doc-corr-1" },
    );
    assert.equal((original.source as Record<string, unknown>)["revision"], originalDocument.latestRevisionId);
    assert.notEqual((original.providerRef as Record<string, unknown>)["id"], source.ref);

    const sameBytesRevision = await bridge.ctx.issues.documents.upsert({
      issueId: "root-a",
      key: "spec",
      companyId: h.COMPANY_A,
      body: originalBody,
      title: "Spec",
      format: "markdown",
      changeSummary: "new revision with identical bytes",
    });
    assert.notEqual(sameBytesRevision.latestRevisionId, originalDocument.latestRevisionId);
    const sameBytesDifferentKind = await port.publish(
      {
        scope: { companyRef: h.COMPANY_A, projectRef: h.PROJECT_A },
        kind: "summary",
        contentHash: sha256(originalBody),
        mediaType: "text/markdown",
        size: originalBody.length,
        source,
      },
      { commandId: "doc-c1b", idempotencyKey: "pf:artifact:doc-summary", correlationId: "doc-corr-1b" },
    );
    assert.notEqual(
      (sameBytesDifferentKind.providerRef as Record<string, unknown>)["id"],
      (original.providerRef as Record<string, unknown>)["id"],
    );
    const retainedSameBytesSnapshot = await port.readVerified(original.providerRef);
    assert.equal(retainedSameBytesSnapshot.digestVerified, true);
    assert.equal(retainedSameBytesSnapshot.contentHash, original.contentHash);

    await bridge.ctx.issues.documents.upsert({
      issueId: "root-a",
      key: "spec",
      companyId: h.COMPANY_A,
      body: updatedBody,
      title: "Spec",
      format: "markdown",
      changeSummary: "updated source",
    });
    const updated = await port.publish(
      {
        scope: { companyRef: h.COMPANY_A, projectRef: h.PROJECT_A },
        kind: "specification",
        contentHash: sha256(updatedBody),
        mediaType: "text/markdown",
        size: updatedBody.length,
        source,
      },
      { commandId: "doc-c2", idempotencyKey: "pf:artifact:doc-v2", correlationId: "doc-corr-2" },
    );

    assert.notEqual(updated.contentHash, original.contentHash);
    assert.notEqual(
      (updated.providerRef as Record<string, unknown>)["id"],
      (original.providerRef as Record<string, unknown>)["id"],
    );
    const currentDocument = await bridge.ctx.issues.documents.get("root-a", "spec", h.COMPANY_A);
    assert.equal(currentDocument?.latestRevisionId, (updated.source as Record<string, unknown>)["revision"]);
    const retainedOriginal = await port.readVerified(original.providerRef);
    assert.equal(retainedOriginal.digestVerified, true);
    assert.equal(retainedOriginal.contentHash, original.contentHash);
    const verifiedUpdated = await port.readVerified(updated.providerRef);
    assert.equal(verifiedUpdated.digestVerified, true);
  } finally {
    await bridge.dispose();
  }
});
