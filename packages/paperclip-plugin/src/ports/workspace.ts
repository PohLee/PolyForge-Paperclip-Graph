/**
 * `WorkspacePort` — read-only metadata, no provisioning.
 *
 * The manifest grants `project.workspaces.read` and `execution.workspaces.read` and nothing
 * that creates, moves, resets or writes to a workspace. That is deliberate and it is the whole
 * design: Paperclip owns the working directory, its lifecycle, its branch and its cleanup
 * policy, and a bridge that could create a worktree would be a second owner of the same
 * resource (REQ-WS-01, AT-08).
 *
 * Three consequences are implemented rather than documented:
 *
 * * **A reviewer is always read-only.** `readOnly` is computed from the *requirement*, not from
 *   what the host reports, because the host cannot express "this directory is read-only for
 *   this reviewer but writable for the producer". A requirement that asks for
 *   `requireReadOnlyForReviewer` with a writable mode is refused outright rather than
 *   satisfied with a promise.
 * * **A pinned commit that cannot be verified is a problem, not a detail.** The Core pins
 *   commits; the bridge cannot read them from this baseline, so `commits` comes back empty and
 *   `problems` names `commit_pin_unverified`. The Core then has a `BLOCKED_WORKSPACE` to reason
 *   about instead of a silent assumption that the current HEAD is the pinned one.
 * * **Paths are re-validated even though the host produced them.** `path` is returned to the
 *   Core as metadata, so it is checked for absoluteness, for `..` segments, and for a NUL byte
 *   before it leaves this module. Defence in depth: trusted input is still input.
 */

import type {
  CommandMeta,
  WorkspaceBinding,
  WorkspaceObservation,
  WorkspacePort,
  WorkspaceRequirement,
} from "@polyforge/protocol";
import type { PluginExecutionWorkspaceMetadata, PluginWorkspace } from "@paperclipai/plugin-sdk";
import type { BridgeDeps } from "./index.js";
import { providerRef } from "./index.js";
import { BridgeError, UnsupportedCapabilityError } from "../errors.js";
import { readPinnedGitObjectId } from "../workspace-metadata.ts";

export const WORKSPACE_BINDING_KIND = "workspace" as const;

/**
 * The binding plus the scope the port needs.
 *
 * The protocol's `WorkspaceBinding` carries no company, and `inspect` has no `meta` argument,
 * so the binding is widened with the scope the bridge resolved it under. The extra fields are
 * bridge-owned and are what let `inspect` re-read the object without guessing the tenant.
 */
export interface ScopedWorkspaceBinding extends WorkspaceBinding {
  readonly companyRef: string;
  readonly projectRef: string;
  readonly mode: WorkspaceRequirement["mode"];
  readonly problems: string[];
}

function validatePathShape(path: string | null, problems: string[]): string | null {
  if (path === null) return null;
  if (path.includes("\0")) {
    problems.push("path_contains_nul");
    return null;
  }
  if (!path.startsWith("/")) {
    problems.push("path_is_not_absolute");
    return null;
  }
  const segments = path.split("/");
  if (segments.includes("..")) {
    // Defence in depth. A trusted host producing a traversing path would be a host bug; the
    // bridge refuses it rather than forwarding it to the Core's path handling.
    problems.push("path_contains_traversal");
    return null;
  }
  return path;
}

function readRepoRef(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const value = metadata["repoUrl"] ?? metadata["repoRef"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export class WorkspacePortImpl implements WorkspacePort {
  readonly #deps: BridgeDeps;

  constructor(deps: BridgeDeps) {
    this.#deps = deps;
  }

  /**
   * Resolve workspace *metadata* for a requirement.
   *
   * `mode` decides what is reported, not what the bridge does:
   * * `read_write` in `metadata_only` (the default) → the host's primary workspace is
   *   reported as **read-only** with `provisioning_not_exposed`, because the bridge cannot
   *   create an isolated one and must not pretend the shared primary is isolated.
   * * `read_write` in `inherited` → the child issue's inherited execution workspace is what
   *   the platform will use; the bridge still reports `readOnly: true` because it cannot
   *   observe the isolation, and says why.
   * * `read_only_snapshot` / `reuse_serially` → read-only, always.
   */
  async resolve(req: WorkspaceRequirement, meta: CommandMeta): Promise<ScopedWorkspaceBinding> {
    const { ctx, config, logger, metrics, store } = this.#deps;
    void meta;
    // `WorkspaceRequirement` carries no company and no project, so both are resolved from
    // capabilities the manifest actually grants (`projects.read`, `project.workspaces.read`) and
    // from data the host owns. The project is found by matching the requirement's repository
    // coordinates against each project's primary workspace: that is the only host-owned link
    // between a repo and a project, and it is metadata rather than an assertion.
    const companyId = this.#deps.scope.companyRef;
    const problems: string[] = [];

    if (req.requireReadOnlyForReviewer && req.mode === "read_write") {
      throw new UnsupportedCapabilityError(
        "project.workspaces.read",
        "the requirement asks for a writable workspace but also demands a read-only reviewer; this bridge cannot express that, so the node stays BLOCKED_WORKSPACE",
        { mode: req.mode, requireReadOnlyForReviewer: true },
      );
    }

    const projectId = await this.#resolveProjectIdFromRepositories(companyId, req);
    if (projectId === null) {
      metrics.bump(companyId, "workspaceValidationFailures");
      throw new BridgeError(
        "BRIDGE_SCOPE_VIOLATION",
        "BLOCKED_SCOPE",
        "the requirement's repositories do not identify exactly one project in this company; the project must come from the issue relation, not from the request",
        { repositories: req.repositories.map((repo) => repo.repoRef), companyId },
      );
    }

    const primary = await ctx.projects.getPrimaryWorkspace(projectId, companyId);
    if (!primary) {
      metrics.bump(companyId, "workspaceValidationFailures");
      logger.warn("no primary workspace is configured for the project", { projectId });
      return {
        workspaceRef: providerRef("project_workspace", "none"),
        path: null,
        branch: null,
        commits: [],
        readOnly: true,
        companyRef: companyId,
        projectRef: projectId,
        mode: req.mode,
        problems: ["no_primary_workspace_configured"],
      };
    }

    if (config.workspaceProviderMode === "metadata_only" && req.mode === "read_write") {
      problems.push("provisioning_not_exposed");
    }
    problems.push("commit_pin_unverified");

    const branch = primary.defaultRef;
    const path = validatePathShape(primary.path, problems);
    if (path === null) metrics.bump(companyId, "workspaceValidationFailures");

    const binding: ScopedWorkspaceBinding = {
      workspaceRef: providerRef("project_workspace", primary.id, primary.updatedAt),
      path,
      branch,
      commits: [],
      // Always true: the bridge reports a read-only view of a workspace it does not control.
      readOnly: true,
      companyRef: companyId,
      projectRef: projectId,
      mode: req.mode,
      problems,
    };

    store.putBinding({
      companyId,
      kind: WORKSPACE_BINDING_KIND,
      providerId: primary.id,
      projectId,
      payload: {
        repoUrl: primary.repoUrl,
        repoRef: primary.repoRef,
        defaultRef: primary.defaultRef,
        mode: req.mode,
        problems,
        repositories: req.repositories,
        resolvedAt: this.#deps.now().toISOString(),
      },
      revision: primary.updatedAt,
    });

    if (problems.length > 0) metrics.bump(companyId, "workspaceValidationFailures");
    logger.info("resolved workspace metadata (read-only)", {
      projectId,
      workspaceId: primary.id,
      problems,
    });
    return binding;
  }

  /**
   * Find the single project in this company whose primary workspace matches a required repo.
   *
   * Exactly one match, or a refusal. Two matches would mean the same repo is configured on two
   * projects, and picking one would silently bind a node's write to the wrong workspace — the
   * AT-06 isolation failure.
   */
  async #resolveProjectIdFromRepositories(
    companyId: string,
    req: WorkspaceRequirement,
  ): Promise<string | null> {
    if (req.repositories.length === 0) return null;
    const wanted = new Set(req.repositories.map((repo) => repo.repoRef));
    const projects = await this.#deps.ctx.projects.list({ companyId });
    const matches: string[] = [];
    for (const project of projects) {
      const workspaces = await this.#deps.ctx.projects.listWorkspaces(project.id, companyId);
      for (const workspace of workspaces) {
        const candidates = [workspace.repoUrl, workspace.repoRef, workspace.name].filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        );
        if (candidates.some((value) => wanted.has(value))) {
          matches.push(project.id);
          break;
        }
      }
    }
    const unique = [...new Set(matches)];
    return unique.length === 1 ? unique[0]! : null;
  }

  /**
   * Re-read a workspace binding and report what is observable.
   *
   * `writable` is always `false`. The bridge has no way to test writability without writing,
   * and reporting `true` on the strength of "the host gave us the path" would be the exact
   * "a directory exists so it must be correct" fallacy REQ-WS-04 forbids.
   */
  async inspect(binding: WorkspaceBinding): Promise<WorkspaceObservation> {
    const { ctx, metrics, logger } = this.#deps;
    const scoped = binding as ScopedWorkspaceBinding;
    const companyId = scoped.companyRef.length > 0 ? scoped.companyRef : this.#deps.scope.companyRef;
    const problems: string[] = [...(scoped.problems ?? [])];

    if (binding.workspaceRef.kind === "project_workspace") {
      const workspaces = await ctx.projects.listWorkspaces(scoped.projectRef, companyId);
      const found = workspaces.find((entry) => entry.id === binding.workspaceRef.id);
      if (!found) {
        problems.push("workspace_missing");
        metrics.bump(companyId, "workspaceValidationFailures");
        logger.warn("the resolved project workspace no longer exists", {
          workspaceId: binding.workspaceRef.id,
        });
        return {
          exists: false,
          path: null,
          branch: null,
          commits: [],
          readable: false,
          writable: false,
          problems,
        };
      }
      const path = validatePathShape(found.path, problems);
      return {
        exists: true,
        path,
        branch: found.defaultRef,
        commits: [],
        readable: path !== null,
        writable: false,
        problems: problems.length > 0 ? problems : ["commit_pin_unverified"],
      };
    }

    if (binding.workspaceRef.kind === "execution_workspace") {
      const metadata = await ctx.executionWorkspaces.get(binding.workspaceRef.id, companyId);
      if (!metadata) {
        problems.push("execution_workspace_missing");
        metrics.bump(companyId, "workspaceValidationFailures");
        return {
          exists: false,
          path: null,
          branch: null,
          commits: [],
          readable: false,
          writable: false,
          problems,
        };
      }
      return this.#observationFromExecution(metadata, problems, companyId);
    }

    problems.push(`unsupported_workspace_kind:${binding.workspaceRef.kind}`);
    metrics.bump(companyId, "platformBlocks");
    return {
      exists: false,
      path: null,
      branch: null,
      commits: [],
      readable: false,
      writable: false,
      problems,
    };
  }

  #observationFromExecution(
    metadata: PluginExecutionWorkspaceMetadata,
    problems: string[],
    companyId: string,
  ): WorkspaceObservation {
    const path = validatePathShape(metadata.path ?? metadata.cwd, problems);
    const commit = readPinnedGitObjectId(metadata.providerMetadata);
    const repoRef = readRepoRef(metadata.providerMetadata);
    if (commit === null || repoRef === null) problems.push("commit_pin_unverified");
    if (metadata.path === null) problems.push("workspace_not_locally_realized");
    const commits = commit !== null && repoRef !== null ? [{ repoRef, commit }] : [];
    if (problems.length > 0) this.#deps.metrics.bump(companyId, "workspaceValidationFailures");
    return {
      exists: true,
      path,
      branch: metadata.branchName,
      commits,
      readable: path !== null,
      writable: false,
      problems,
    };
  }

  /**
   * Look up the project workspace for an issue through the host's own convenience method.
   *
   * `getWorkspaceForIssue` resolves the issue's project *inside the host*, which is the
   * trusted issue→project relation the requirements demand. The bridge never accepts a
   * project id from an agent.
   */
  async resolveForIssue(issueId: string, companyId: string): Promise<PluginWorkspace | null> {
    return this.#deps.ctx.projects.getWorkspaceForIssue(issueId, companyId);
  }
}
