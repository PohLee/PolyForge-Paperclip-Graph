const COMMIT_METADATA_KEYS = new Set([
  "commit",
  "headcommit",
  "resolvedcommit",
  "pinnedcommit",
  "currentcommit",
  "checkoutcommit",
  "commitsha",
]);
const FULL_GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * Extract one unambiguous, full Git object ID from provider-owned workspace metadata.
 *
 * Providers may nest their Git fields (for example `providerMetadata.git.headCommit`). Only
 * explicit commit field names are considered; a generic `sha` or branch name is never a pin.
 * If the provider reports conflicting commits, the metadata is not usable as an exact pin.
 */
export function readPinnedGitObjectId(metadata: Record<string, unknown> | null | undefined): string | null {
  if (metadata === null || metadata === undefined) return null;
  const seen = new Set<object>();
  const commits = new Set<string>();

  const visit = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== "object" || depth > 8 || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (COMMIT_METADATA_KEYS.has(key.toLowerCase()) && typeof nested === "string" && FULL_GIT_OBJECT_ID.test(nested)) {
        commits.add(nested.toLowerCase());
      }
      visit(nested, depth + 1);
    }
  };

  visit(metadata, 0);
  return commits.size === 1 ? [...commits][0]! : null;
}

export function isFullGitObjectId(value: unknown): value is string {
  return typeof value === "string" && FULL_GIT_OBJECT_ID.test(value);
}
