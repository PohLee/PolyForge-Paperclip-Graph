/**
 * `ArtifactPort` — create-or-verify by content hash, with hostile sources refused.
 *
 * The threat model is a *capability* problem, not a URL problem: an agent that can name a
 * source can try to make the bridge fetch from inside the network, read a local file, or point
 * at a mutable URL that changes meaning later. Three rules follow.
 *
 * * **No URL is ever a source, and a mutable URL is never an identity.** The enabled sources are
 *   an issue document key or an inline body — resolved *through the company-scoped host client*,
 *   never dereferenced. Attachment reads are explicitly refused because the manifest does not
 *   request `issue.attachments.read`. A `source.ref` that looks like a URL,
 *   a UNC path, or that contains `..` is refused as a hostile source before any read. An
 *   identity is always `(issue, kind, contentHash)`, so a document whose body changes produces
 *   a *new* artifact rather than mutating the old one (REQ-DATA-02, AT-09). Mutable source
 *   documents are copied to content-addressed artifact documents; provider refs never follow them.
 * * **The bytes are hashed by the bridge, and the declared digest must match.** A mismatch
 *   increments `artifactDigestMismatch` and refuses. The Core is never told a digest the
 *   bridge did not compute from bytes it read.
 * * **`readVerified` re-reads and re-hashes.** `digestVerified` is true only when the bytes
 *   fetched now still hash to the recorded digest, and `immutable` is true only for a pinned
 *   attachment or document revision.
 */

import { digestBytes } from "@polyforge/protocol";
import type {
  ArtifactUpload,
  ArtifactPort,
  CommandMeta,
  ProviderRefLike,
  Scope,
  VerifiedArtifact,
} from "@polyforge/protocol";
import type { BridgeDeps } from "./index.js";
import { providerRef } from "./index.js";
import { INTENT_KINDS, effectKey } from "../outbox/intents.js";
import { BridgeError, HostileSourceError, UnsupportedCapabilityError } from "../errors.js";

export const ARTIFACT_BINDING_KIND = "artifact" as const;

/** Rejected outright: these shapes have no legitimate use as an artifact source reference. */
const HOSTILE_REF_PATTERNS: readonly RegExp[] = [
  /^[a-zA-Z][a-zA-Z0-9+.-]*:/, // scheme: http:, https:, file:, data:, gopher:, …
  /^\/\//, // protocol-relative
  /\\\\/, // UNC
  /\.\./, // traversal
  /\0/, // NUL byte
];

function assertSafeSourceRef(ref: string, kind: string): void {
  for (const pattern of HOSTILE_REF_PATTERNS) {
    if (pattern.test(ref)) {
      throw new HostileSourceError("artifact source reference is a URL, a UNC path, or contains traversal", {
        kind,
        pattern: pattern.source,
      });
    }
  }
}

function identityKey(issueId: string, kind: string, contentHash: string): string {
  return `${issueId}:${kind}:${contentHash}`;
}

export class ArtifactPortImpl implements ArtifactPort {
  readonly #deps: BridgeDeps;

  constructor(deps: BridgeDeps) {
    this.#deps = deps;
  }

  /**
   * Publish one artifact, or verify an already-published identical one.
   *
   * The whole flow is: resolve the bytes from a company-scoped host read, hash them, compare
   * with the declared digest, then create-or-verify on `(issue, kind, contentHash)`. The
   * durable record of the digest is written *before* the Core is told the artifact exists, so
   * a later `readVerified` has something to compare against even after a restart.
   *
   * Returns the verified identity rather than a bare ref, so what reaches the Core is the digest of
   * the bytes actually stored and the immutable source they came from. Handing back only a ref
   * pushed the job of restating the identity onto the caller, which meant the Core recorded the
   * caller's claim rather than this port's finding.
   */
  async publish(
    req: ArtifactUpload,
    meta: CommandMeta,
  ): Promise<{
    providerRef: ProviderRefLike;
    contentHash: string;
    source: Record<string, unknown>;
  }> {
    const { store, logger, metrics, deliveries, config } = this.#deps;
    const scope: Scope = req.scope;
    const deliveryKey = effectKey([
      "artifact",
      scope.companyRef,
      scope.projectRef,
      meta.idempotencyKey,
      req.kind,
      req.contentHash,
    ]);
    const logger2 = logger.child({ correlationId: meta.correlationId });

    deliveries.begin({
      effectKey: deliveryKey,
      kind: INTENT_KINDS.artifactPublish,
      scope,
      correlationId: meta.correlationId,
      payload: { kind: req.kind, declaredHash: req.contentHash, sourceKind: req.source.kind },
    });
    deliveries.sent(deliveryKey);

    if (req.size > config.maxArtifactBytes) {
      metrics.bump(scope.companyRef, "artifactDigestMismatch", 0);
      deliveries.failed(deliveryKey, "declared size exceeds the configured cap");
      throw new UnsupportedCapabilityError("http.outbound", "artifact exceeds the configured size cap", {
        size: req.size,
        cap: config.maxArtifactBytes,
      });
    }

    if (req.source.kind === "attachment") {
      deliveries.failed(deliveryKey, "attachment reads are not enabled by the plugin capability manifest");
      throw new UnsupportedCapabilityError(
        "issue.attachments.read",
        "attachment evidence is not enabled; use a company-scoped issue document or inline artifact",
      );
    }

    const resolved = await this.#resolveBytes(req);
    const actualHash = digestBytes(resolved.bytes);
    if (actualHash !== req.contentHash) {
      metrics.bump(scope.companyRef, "artifactDigestMismatch");
      deliveries.failed(deliveryKey, "declared content hash does not match the bytes the host returned");
      logger2.error("artifact digest mismatch; refusing to register the reference", {
        kind: req.kind,
        declared: req.contentHash,
        actual: actualHash,
      });
      throw new BridgeError(
        "BRIDGE_INTEGRITY_FAILURE",
        "BLOCKED_STALE_INPUT",
        "artifact content hash does not match the bytes read from the host",
        { kind: req.kind, declared: req.contentHash, actual: actualHash },
      );
    }

    const issueId = this.#resolveIssueId(req, scope);
    const key = identityKey(issueId, req.kind, actualHash);
    const existing = store.getBinding(scope.companyRef, ARTIFACT_BINDING_KIND, key);
    if (existing) {
      // Create-or-verify. The identity already exists; re-read and confirm rather than
      // creating a second reference for the same bytes.
      const record = safeJson(existing.payloadJson);
      if (record["issueId"] !== issueId) {
        deliveries.failed(deliveryKey, "artifact identity collision across issues");
        throw new BridgeError(
          "BRIDGE_INTEGRITY_FAILURE",
          "BLOCKED_STALE_INPUT",
          "an artifact with this identity is already bound to a different issue",
          { key, recordedIssue: record["issueId"], requestedIssue: issueId },
        );
      }
      const ref = providerRef(String(record["refKind"]), String(record["providerId"]), String(record["revision"] ?? ""));
      deliveries.observed(deliveryKey, { reused: true, ref });
      deliveries.reconciled(deliveryKey, "artifact already published");
      // Reuse reports the *recorded* hash, not the declared one. They were verified equal when the
      // record was written, so this is the same fact read back rather than a fresh claim.
      return {
        providerRef: ref,
        contentHash: String(record["contentHash"] ?? actualHash),
        source: record["source"] && typeof record["source"] === "object"
          ? (record["source"] as Record<string, unknown>)
          : this.#sourceDescriptor(req.source, resolved),
      };
    }

    const stored = await this.#storeBytes(req, resolved, issueId, actualHash);
    store.putBinding({
      companyId: scope.companyRef,
      kind: ARTIFACT_BINDING_KIND,
      providerId: key,
      projectId: scope.projectRef,
      payload: {
        issueId,
        kind: req.kind,
        contentHash: actualHash,
        mediaType: req.mediaType,
        size: resolved.bytes.byteLength,
        refKind: stored.refKind,
        providerId: stored.providerId,
        revision: stored.revision,
        immutable: stored.immutable,
        source: this.#sourceDescriptor(req.source, resolved),
        repository: req.repository ?? null,
        publishedAt: this.#deps.now().toISOString(),
        commandId: meta.commandId,
      },
      revision: stored.revision,
    });
    // An alias keyed by the returned ref, so `readVerified(ref)` can find the record without
    // first re-deriving the identity. The alias carries the same content hash, so the two rows
    // cannot disagree about what the bytes were.
    store.putBinding({
      companyId: scope.companyRef,
      kind: ARTIFACT_BINDING_KIND,
      providerId: `${stored.refKind}:${stored.providerId}`,
      projectId: scope.projectRef,
      payload: {
        issueId,
        kind: req.kind,
        contentHash: actualHash,
        mediaType: req.mediaType,
        size: resolved.bytes.byteLength,
        refKind: stored.refKind,
        providerId: stored.providerId,
        revision: stored.revision,
        immutable: stored.immutable,
        source: this.#sourceDescriptor(req.source, resolved),
        repository: req.repository ?? null,
        identityKey: key,
        publishedAt: this.#deps.now().toISOString(),
      },
      revision: stored.revision,
    });

    deliveries.observed(deliveryKey, { refKind: stored.refKind, providerId: stored.providerId });
    deliveries.reconciled(deliveryKey);
    logger2.info("published an artifact reference", {
      kind: req.kind,
      contentHash: actualHash,
      refKind: stored.refKind,
    });
    // Everything the Core is told about this artifact is what was verified here: the digest of the
    // bytes actually stored, the ref they were stored under, and the immutable source they came
    // from. The caller's declared values are inputs to the check, never its output.
    return {
      providerRef: providerRef(stored.refKind, stored.providerId, stored.revision),
      contentHash: actualHash,
      source: this.#sourceDescriptor(req.source, resolved),
    };
  }

  #sourceDescriptor(
    source: { kind: string; ref?: string },
    resolved: { bytes: Uint8Array; origin: string },
  ): Record<string, unknown> {
    return {
      kind: source.kind,
      ...(source.ref === undefined ? {} : { ref: source.ref }),
      ...(source.kind === "document" && resolved.origin.startsWith("document:")
        ? { revision: resolved.origin.slice("document:".length) }
        : {}),
    };
  }

  #resolveIssueId(req: ArtifactUpload, scope: Scope): string {
    const ref = req.source.ref;
    if (req.source.kind === "document" && ref !== undefined) {
      return this.#issueIdFromDocumentRef(ref);
    }
    if (ref !== undefined && ref.length > 0 && ref.startsWith("issue:")) {
      const issueId = ref.slice("issue:".length);
      if (!issueId.includes("/")) return issueId;
    }
    const recorded = this.#deps.store.listBindings(scope.companyRef, "work_unit", 1000);
    void recorded;
    throw new HostileSourceError(
      "artifact source must name its issue as 'issue:<issueId>' so the bridge can scope the write",
      { sourceKind: req.source.kind, ref: ref ?? null },
    );
  }

  async #resolveBytes(req: ArtifactUpload): Promise<{ bytes: Uint8Array; origin: string }> {
    const { ctx, config } = this.#deps;
    const companyId = req.scope.companyRef;
    if (req.source.kind === "attachment") {
      const attachmentId = req.source.ref ?? "";
      assertSafeSourceRef(attachmentId, "attachment");
      const content = await ctx.issues.getAttachmentContent(attachmentId, companyId, {
        maxBytes: config.maxArtifactBytes,
      });
      if (!content) {
        throw new BridgeError(
          "BRIDGE_INTEGRITY_FAILURE",
          "BLOCKED_SCOPE",
          "attachment is not readable in this company",
          { attachmentId },
        );
      }
      return { bytes: new Uint8Array(Buffer.from(content.contentBase64, "base64")), origin: "attachment" };
    }
    if (req.source.kind === "document") {
      const key = req.source.ref ?? "";
      // The shape is checked *before* the hostile-reference scan, because the documented shape is
      // `issue:<issueId>/<documentKey>` — which begins with a colon-delimited word and would
      // otherwise be rejected by the very scheme rule meant to catch `https:` and `file:`. Checking
      // the shape first also means the hostile scan only ever sees an issue id and a document key,
      // never a URL that happened to be spelled like our own prefix.
      const issueId = this.#issueIdFromDocumentRef(key);
      assertSafeSourceRef(issueId, "document issue id");
      assertSafeSourceRef(key.slice(`issue:${issueId}/`.length), "document key");
      const documentKey = key.slice(`issue:${issueId}/`.length);
      const doc = await ctx.issues.documents.get(issueId, documentKey, companyId);
      if (!doc) {
        throw new BridgeError("BRIDGE_INTEGRITY_FAILURE", "BLOCKED_SCOPE", "document is not readable in this company", {
          key,
        });
      }
      return { bytes: new TextEncoder().encode(doc.body), origin: `document:${doc.latestRevisionId}` };
    }
    if (req.source.kind === "inline") {
      const body = req.source.body ?? "";
      if (Buffer.byteLength(body, "utf8") > config.maxArtifactBytes) {
        throw new UnsupportedCapabilityError("http.outbound", "inline artifact body exceeds the configured cap", {
          cap: config.maxArtifactBytes,
        });
      }
      return { bytes: new TextEncoder().encode(body), origin: "inline" };
    }
    throw new HostileSourceError("artifact source kind is not one the bridge will read", {
      sourceKind: req.source.kind,
    });
  }

  #issueIdFromDocumentRef(key: string): string {
    const parts = key.split("/");
    const first = parts[0];
    if (first === undefined || !first.startsWith("issue:")) {
      throw new HostileSourceError("document source must be 'issue:<issueId>/<documentKey>'", { key });
    }
    return first.slice("issue:".length);
  }

  /**
   * Persist the bytes somewhere the host can serve back.
   *
   * Inline bodies and mutable source documents are snapshotted under a key derived from the full
   * content hash. Two uploads of the same bytes land on the same document key, while an updated
   * source document gets a new key and cannot rewrite old evidence.
   */
  async #storeBytes(
    req: ArtifactUpload,
    resolved: { bytes: Uint8Array; origin: string },
    issueId: string,
    contentHash: string,
  ): Promise<{ refKind: string; providerId: string; revision: string; immutable: boolean }> {
    const { ctx } = this.#deps;
    if (req.source.kind === "attachment") {
      return {
        refKind: "issue_attachment",
        providerId: req.source.ref ?? "",
        revision: contentHash,
        immutable: true,
      };
    }
    const kindHash = digestBytes(new TextEncoder().encode(req.kind)).slice("sha256:".length);
    const documentKey = `polyforge/artifact-${kindHash}-${contentHash.slice("sha256:".length)}`;
    const body = new TextDecoder().decode(resolved.bytes);
    const document = await ctx.issues.documents.upsert({
      issueId,
      key: documentKey,
      companyId: req.scope.companyRef,
      body,
      title: `PolyForge artifact ${req.kind}`,
      format: "markdown",
      changeSummary: `create-or-verify for ${contentHash}`,
    });
    // The revision id is the identity of these bytes. If the host does not report one, the
    // artifact is still stored but is *not* claimable as immutable, and `readVerified` will
    // say so rather than pretending the pin exists.
    const revision = typeof document.latestRevisionId === "string" ? document.latestRevisionId : "";
    return {
      refKind: "issue_document_revision",
      providerId: documentKey,
      revision,
      immutable: revision.length > 0,
    };
  }

  /**
   * Re-read an artifact and re-hash it.
   *
   * A mutable source whose bytes no longer match is reported as
   * `digestVerified: false` rather than as a failure, because the *caller* decides what an
   * invalidated artifact means (the Core turns it into `REWORK_REQUIRED` or
   * `BLOCKED_STALE_INPUT`). The bridge's job is only to state the fact precisely.
   */
  async readVerified(ref: ProviderRefLike): Promise<VerifiedArtifact> {
    const { store, metrics, logger } = this.#deps;
    const companyId = store.findCompanyForProviderRef(ref) ?? this.#deps.scope.companyRef;
    const bindingKey = ref.kind === "issue_attachment" ? ref.id : `${ref.kind}:${ref.id}`;
    const row = store.getBinding(companyId, ARTIFACT_BINDING_KIND, bindingKey);
    if (!row) {
      throw new BridgeError(
        "BRIDGE_INTEGRITY_FAILURE",
        "BLOCKED_STALE_INPUT",
        "artifact reference was never published by this bridge",
        { ref },
      );
    }
    const record = safeJson(row.payloadJson);
    const recordedHash = String(record["contentHash"] ?? "");
    const issueId = String(record["issueId"] ?? "");
    const kind = String(record["kind"] ?? "");

    const verification = await this.#reRead(ref, companyId, issueId);
    if (verification === null) {
      metrics.bump(companyId, "artifactDigestMismatch", 0);
      logger.warn("the artifact's bytes are no longer readable", { ref });
      return {
        ref,
        kind,
        contentHash: recordedHash,
        mediaType: String(record["mediaType"] ?? "application/octet-stream"),
        size: Number(record["size"] ?? 0),
        digestVerified: false,
        immutable: record["immutable"] === true,
        repository: (record["repository"] as { repoRef: string; commit: string } | null) ?? null,
      };
    }
    const digestVerified = verification.revisionMatches && digestBytes(verification.bytes) === recordedHash;
    if (!digestVerified) metrics.bump(companyId, "artifactDigestMismatch");
    return {
      ref,
      kind,
      contentHash: recordedHash,
      mediaType: String(record["mediaType"] ?? "application/octet-stream"),
      size: verification.bytes.byteLength,
      digestVerified,
      immutable: record["immutable"] === true,
      repository: (record["repository"] as { repoRef: string; commit: string } | null) ?? null,
    };
  }

  async #reRead(
    ref: ProviderRefLike,
    companyId: string,
    issueId: string,
  ): Promise<{ bytes: Uint8Array; revisionMatches: boolean } | null> {
    const { ctx, config } = this.#deps;
    if (ref.kind === "issue_attachment") {
      const content = await ctx.issues.getAttachmentContent(ref.id, companyId, { maxBytes: config.maxArtifactBytes });
      if (!content) return null;
      return { bytes: new Uint8Array(Buffer.from(content.contentBase64, "base64")), revisionMatches: true };
    }
    if (ref.kind === "issue_document_revision" || ref.kind === "issue_document") {
      let documentKey = ref.id;
      if (ref.id.startsWith("issue:")) {
        const refIssueId = this.#issueIdFromDocumentRef(ref.id);
        if (refIssueId !== issueId) return null;
        documentKey = ref.id.slice(`issue:${refIssueId}/`.length);
      }
      assertSafeSourceRef(documentKey, "document key");
      const doc = await ctx.issues.documents.get(issueId, documentKey, companyId);
      if (!doc) return null;
      // A document key is mutable: the host only exposes the latest revision. That is exactly
      // why the recorded `revision` matters — a caller holding an older revision must treat
      // the artifact as stale rather than as the current body.
      return {
        bytes: new TextEncoder().encode(doc.body),
        revisionMatches: ref.revision !== undefined && doc.latestRevisionId === ref.revision,
      };
    }
    return null;
  }
}

function safeJson(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
