/**
 * The publish contract, as pure data.
 *
 * Everything here is a decision about *what to send* and *what counts as success*, with no React in
 * it, because those are the two decisions that were wrong and neither could be reached by a test
 * that needed a renderer to get there.
 *
 * The two hashes are deliberately not interchangeable:
 *
 * * `definitionHash` is the identity of the graph definition, and it is the compare-and-swap. It is
 *   what decides whether the buffer still matches what was compiled and reviewed.
 * * `reviewTargetHash` is the exact target the recorded review was taken against. The Core stores it
 *   at review time and refuses a publish whose value differs (`registry/store.py`, "the reviewed
 *   target hash does not match the recorded review"). In this system the review is taken against the
 *   compile artifact's `planHash`.
 *
 * Writing the definition hash into the review target made every publish fail with a 409 that the UI
 * had just reported as a successfully recorded review. The one place they were being used
 * interchangeably is the place they have to be kept apart.
 */

export interface Staged<T> {
  readonly value: T | null;
  readonly revision: number | null;
  readonly definitionHash: string | null;
  readonly recordedAt: string | null;
}

export type StagedMap = {
  validation: Staged<unknown>;
  compileArtifact: Staged<{ planHash: string; compilerVersion: string } | unknown>;
  diff: Staged<unknown>;
  review: Staged<ReviewValidityInput>;
};

/** The immutable version a successful publish creates. */
export interface PublishedVersion {
  readonly graphId: string;
  readonly version: number;
  readonly definitionHash: string;
  readonly planHash: string;
  readonly compilerVersion: string;
  readonly publishedAt: string;
  readonly publishedBy: string;
  readonly retired: boolean;
}

export type PublishRequest = {
  draftId: string;
  expectedRevision: number;
  definitionHash: string;
  compilerVersion: string;
  planHash: string;
  reviewTargetHash: string;
};

/** The two-hash question the review check asks, separated from the rest of the gate. */
export interface ReviewValidityInput {
  readonly targetHash: string;
  readonly definitionHash: string;
}

/**
 * Whether a recorded review still describes what is about to be published.
 *
 * Two independent conditions, deliberately checked against two different values:
 *
 * * the review was taken against the definition as it stands now, so an edit since the review
 *   invalidates it -- this is what `definitionHash` is for; and
 * * the review was taken against the plan being published, which is what publish sends back as
 *   `reviewTargetHash` and what the Core compares against the review it stored.
 *
 * Asking the first question with `targetHash` and the second with the same field is how one hash
 * ended up standing in for both, and how a correctly recorded review still could not be published.
 */
export function reviewAttestationIsCurrent(
  review: ReviewValidityInput | null,
  savedDefinitionHash: string | null,
  planHash: string | null,
): { ok: boolean; reason: string } {
  if (review === null) return { ok: false, reason: "no review attested" };
  if (savedDefinitionHash === null || review.definitionHash !== savedDefinitionHash) {
    return {
      ok: false,
      reason:
        `attested against definition ${review.definitionHash}, but the current definition hashes to ` +
        `${savedDefinitionHash ?? "nothing"}`,
    };
  }
  if (planHash === null || review.targetHash !== planHash) {
    return {
      ok: false,
      reason: "the attested target is not the current compile artifact's plan hash",
    };
  }
  return { ok: true, reason: "" };
}

export function buildPublishRequest(input: {
  draftId: string;
  revision: number;
  definitionHash: string;
  compilerVersion: string;
  planHash: string;
  reviewTargetHash: string;
}): PublishRequest {
  return {
    draftId: input.draftId,
    // A number, not a string: the Core parses this as an integer, and `String(revision)` failed
    // every publish with "expectedRevision must be an integer".
    expectedRevision: input.revision,
    definitionHash: input.definitionHash,
    compilerVersion: input.compilerVersion,
    planHash: input.planHash,
    reviewTargetHash: input.reviewTargetHash,
  };
}

/**
 * Read a successful publish answer.
 *
 * The publish route answers `201` with the `GraphVersion` it created, not with a `CommandResult`:
 * there is no `applied` field, and there is no pending state to wait on. Reading that body with a
 * command-result reader turned the absent `applied` into `false`, so the editor moved to `failed`,
 * told the user the publish was refused, and skipped the reload -- for a version that had in fact
 * been created and was sitting in the registry.
 *
 * So a success is read as what the route actually returns, and an object without a version number is
 * not a version.
 */
export function readPublishedVersion(value: unknown): PublishedVersion | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  const graphId = body["graphId"];
  const version = body["version"];
  if (typeof graphId !== "string" || graphId.length === 0) return null;
  if (typeof version !== "number" || !Number.isInteger(version)) return null;
  return {
    graphId,
    version,
    definitionHash: typeof body["definitionHash"] === "string" ? body["definitionHash"] : "",
    planHash: typeof body["planHash"] === "string" ? body["planHash"] : "",
    compilerVersion: typeof body["compilerVersion"] === "string" ? body["compilerVersion"] : "",
    publishedAt: typeof body["publishedAt"] === "string" ? body["publishedAt"] : "",
    publishedBy: typeof body["publishedBy"] === "string" ? body["publishedBy"] : "",
    retired: body["retired"] === true,
  };
}
