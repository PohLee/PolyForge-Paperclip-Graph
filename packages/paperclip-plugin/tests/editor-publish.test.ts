/**
 * Publishing sends the target that was reviewed, and reads the answer the Core actually gives.
 *
 * Two independent defects, both of which only show up as a refusal or a false failure in front of a
 * person, and both of which the previous tests could not see because they stopped at the action
 * layer:
 *
 * 1. **The review target and the definition hash are different values.** The review is recorded
 *    against the compile artifact's `planHash`, and the Core compares the publish request's
 *    `reviewTargetHash` against that recorded value (`registry/store.py`). The editor wrote the
 *    definition hash into the same field, so every publish came back 409 "the reviewed target hash
 *    does not match the recorded review" -- from a panel that had just told the user their review
 *    was recorded.
 * 2. **A successful publish is a `GraphVersion`, not a `CommandResult`.** The route answers 201 with
 *    the immutable version. Read as a `CommandResult`, the absent `applied` field is `false`, so a
 *    publish that created a version was reported to the user as a failure and the editor was not
 *    reloaded.
 *
 * These decisions are pure, so they live in `publish-contract.ts` and are tested here directly.
 */

import "./helpers/bootstrap.ts";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { load } from "./helpers/bootstrap.ts";

const contract = await load<typeof import("../src/ui/editor/publish-contract.ts")>(
  new URL("../src/ui/editor/publish-contract.ts", import.meta.url),
);

const DEFINITION_HASH = "sha256:definition-7";
const PLAN_HASH = "sha256:plan-9";

/** A review as the editor now records it: the Core's target, and the definition it was taken on. */
const CURRENT_REVIEW = {
  targetHash: PLAN_HASH,
  definitionHash: DEFINITION_HASH,
};

// ---------------------------------------------------------------------------
// R3: the reviewed target, not the definition hash
// ---------------------------------------------------------------------------

test("the publish request carries the recorded review target, not the definition hash", () => {
  const request = contract.buildPublishRequest({
    draftId: "drf-1",
    revision: 3,
    definitionHash: DEFINITION_HASH,
    compilerVersion: "polyforge-compiler/1.0.0",
    planHash: PLAN_HASH,
    reviewTargetHash: CURRENT_REVIEW.targetHash,
  });

  // The Core compares this against the `review_target_hash` it stored when the review was recorded,
  // which was the plan hash. Sending the definition hash is what produced the 409.
  assert.equal(request.reviewTargetHash, PLAN_HASH, "the reviewed target is the plan hash");
  assert.notEqual(
    request.reviewTargetHash,
    DEFINITION_HASH,
    "the definition hash is a different value and the Core will refuse it",
  );
  // The definition hash is still sent -- as the compare-and-swap, which is what it is for.
  assert.equal(request.definitionHash, DEFINITION_HASH);
  assert.equal(request.expectedRevision, 3, "a revision is a number, not a string");
  assert.equal(typeof request.expectedRevision, "number");
});

test("a review of the current plan against the current definition is publishable", () => {
  const result = contract.reviewAttestationIsCurrent(CURRENT_REVIEW, DEFINITION_HASH, PLAN_HASH);
  assert.equal(result.ok, true, result.reason);
});

test("a review whose target is not the current plan is not publishable", () => {
  const result = contract.reviewAttestationIsCurrent(
    { targetHash: "sha256:plan-of-last-week", definitionHash: DEFINITION_HASH },
    DEFINITION_HASH,
    PLAN_HASH,
  );
  assert.equal(result.ok, false, "a review of a superseded plan is not a review of this one");
  assert.match(result.reason, /plan hash/);
});

test("editing the definition after the review invalidates it", () => {
  // Same review, same target, but the definition it was taken against has moved on. This is what the
  // definition hash is for, and it is why it cannot also be the review target.
  const result = contract.reviewAttestationIsCurrent(
    CURRENT_REVIEW,
    "sha256:definition-8",
    PLAN_HASH,
  );
  assert.equal(result.ok, false, "a review does not follow the definition as it is edited");
  assert.match(result.reason, /definition/i);
});

test("there is no review and no plan to check against", () => {
  assert.equal(contract.reviewAttestationIsCurrent(null, DEFINITION_HASH, PLAN_HASH).ok, false);
  assert.equal(contract.reviewAttestationIsCurrent(CURRENT_REVIEW, DEFINITION_HASH, null).ok, false);
});

// ---------------------------------------------------------------------------
// R7: a successful publish answers with a GraphVersion
// ---------------------------------------------------------------------------

test("a 201 publish body is read as the immutable version it created", () => {
  const published = contract.readPublishedVersion({
    graphId: "design",
    version: 14,
    definitionHash: DEFINITION_HASH,
    planHash: PLAN_HASH,
    compilerVersion: "polyforge-compiler/1.0.0",
    publishedAt: "2026-01-01T00:00:00.000Z",
    publishedBy: "user-anna",
    retired: false,
  });
  assert.ok(published, "the version the publish created is a success, not a missing field");
  assert.equal(published.version, 14);
  assert.equal(published.graphId, "design");
  assert.equal(published.definitionHash, DEFINITION_HASH);
  assert.equal(published.publishedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(published.publishedBy, "user-anna");
});

test("a body that is not a version is not called a success", () => {
  assert.equal(contract.readPublishedVersion({ error: { code: "VERSION_CONFLICT" } }), null);
  assert.equal(contract.readPublishedVersion(null), null);
  assert.equal(contract.readPublishedVersion("201 Created"), null);
});

test("a version-shaped body with no version number is refused", () => {
  // The trap the old reader fell into: an object with no `applied` reads as applied=false, which the
  // UI rendered as a failure for a publish that had in fact succeeded.
  assert.equal(contract.readPublishedVersion({ graphId: "design", retired: false }), null);
  assert.equal(contract.readPublishedVersion({ graphId: "design", version: "14" }), null);
});
