import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isFullGitObjectId, readPinnedGitObjectId } from "../src/workspace-metadata.ts";

test("a nested provider Git head is extracted as a full commit pin", () => {
  const sha = "a".repeat(40);
  assert.equal(readPinnedGitObjectId({ git: { headCommit: sha } }), sha);
});

test("short IDs and generic SHA fields are not treated as commit pins", () => {
  assert.equal(readPinnedGitObjectId({ git: { headCommit: "abcdef0" } }), null);
  assert.equal(readPinnedGitObjectId({ git: { sha: "a".repeat(40) } }), null);
  assert.equal(isFullGitObjectId("abcdef0"), false);
});

test("conflicting commit values in provider metadata are ambiguous and unusable", () => {
  assert.equal(
    readPinnedGitObjectId({ commit: "a".repeat(40), git: { headCommit: "b".repeat(40) } }),
    null,
  );
});

test("repeated or differently cased copies of the same Git ID are unambiguous", () => {
  const sha = "a".repeat(40);
  assert.equal(readPinnedGitObjectId({ commit: sha.toUpperCase(), git: { headCommit: sha } }), sha);
  assert.equal(isFullGitObjectId("b".repeat(64)), true);
});
