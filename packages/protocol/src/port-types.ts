/** Small shared shapes used by the port contracts. */

export interface ProviderRefLike {
  provider: string;
  kind: string;
  id: string;
  revision?: string;
}

export interface Scope {
  companyRef: string;
  projectRef: string;
}

export interface CommandMeta {
  commandId: string;
  idempotencyKey: string;
  correlationId: string;
  causationId?: string;
  expectedVersion?: number;
}

export interface VerifiedArtifact {
  ref: ProviderRefLike;
  kind: string;
  contentHash: string;
  mediaType: string;
  size: number;
  /** True when the bytes were re-read and the digest matched. */
  digestVerified: boolean;
  /** True when the referenced object is immutable for the recorded revision. */
  immutable: boolean;
  repository?: { repoRef: string; commit: string } | null;
}
