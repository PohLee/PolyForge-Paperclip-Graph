/**
 * Operator configuration for the bridge, resolved per company.
 *
 * `ctx.config.get(companyId)` returns *company-scoped* config, and the worker is a
 * multi-company worker (`multiCompanyConfig: true`). Every derived value is therefore
 * cached and returned **per company**: collapsing a multi-company instance onto whichever
 * config arrived last is the cross-tenant identity bug the SDK documents, and a plugin
 * that keeps one derived graph id or state dir for all companies would repeat it.
 *
 * Validation is fail-closed. A config that cannot produce a signed request never yields a
 * `BridgeConfig`; it yields a `BridgeConfigError`, which `worker.ts` turns into
 * `health: "blocked"` for that company rather than into a half-configured client.
 */

import { dirname } from "node:path";

import { BridgeConfigError } from "./errors.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type WorkspaceProviderMode = "metadata_only" | "inherited";

/**
 * How requests to the Runtime Service leave the worker.
 *
 * `governed` routes them through `ctx.http.fetch`, so the host owns SSRF guarding, HTTP audit, and
 * tracing. `direct` uses Node's own `fetch` and exists only so a Runtime Service co-located on the
 * same machine can be reached at all: the host's governed client resolves the target and refuses
 * when every address is loopback or RFC1918, with no per-plugin opt-in. That is a deployment
 * topology constraint, not a tunable — see `ops/compatibility-lock.json`.
 *
 * `direct` is never a silent fallback. It requires this key to be set, it keeps this plugin's own
 * refusal of link-local and cloud-metadata addresses, and it is recorded in the bridge's durable
 * state and reported as a named degraded posture.
 */
export type RuntimeTransport = "governed" | "direct";

export interface SecretRefConfig {
  readonly type: "secret_ref";
  readonly secretId: string;
  readonly version?: string;
}

export interface BridgeConfig {
  readonly companyId: string;
  readonly runtimeUrl: string;
  /**
   * Whether a loopback or RFC1918 `runtimeUrl` is permitted.
   *
   * This is a security decision, so it is part of the resolved configuration rather than something
   * the guard reads again at use time. That matters because a resolved config can be projected
   * back to its raw form to rebuild a bridge without another host round trip: a field missing from
   * that projection is a field the rebuilt bridge silently loses, and losing *this* one turns a
   * working local deployment into "refuse my own Runtime Service". The link-local and
   * cloud-metadata ranges are refused unconditionally and this flag does not reach them.
   */
  readonly allowPrivateRuntimeHost: boolean;
  readonly bridgeIssuer: string;
  readonly sharedSecretRef: SecretRefConfig;
  readonly requestTimeoutMs: number;
  readonly replayWindowSeconds: number;
  readonly audience: string;
  /**
   * The directory the operator declared for this company's state.
   *
   * It is *not* the store location. The bridge's SQLite file is instance-scoped and namespaces every
   * row by company, so there is one file for the whole installation; `stateDir` is recorded and
   * reported, and `storePath` below is the truth about where state actually lives.
   */
  readonly stateDir: string;
  readonly defaultGraphId: string | null;
  readonly engineeringEntryLabel: string;
  readonly engineeringOriginPrefix: string;
  readonly workspaceProviderMode: WorkspaceProviderMode;
  readonly runtimeTransport: RuntimeTransport;
  readonly experimental: { decisions: boolean; cases: boolean; pipelines: boolean };
  readonly enableProjections: boolean;
  readonly logLevel: LogLevel;
  /** Absolute path of the bridge's SQLite file, decided once by the worker. */
  readonly storePath: string;
  /** Hard cap on a single artifact body the bridge will read or store. */
  readonly maxArtifactBytes: number;
}

const DEFAULT_AUDIENCE = "polyforge-runtime";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_REPLAY_WINDOW_SECONDS = 120;
const DEFAULT_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

function readSecretRef(raw: unknown): SecretRefConfig {
  if (typeof raw === "string") {
    // The SDK's legacy string form fails closed at resolve time. Reject it here with a
    // precise message rather than letting a resolve call fail deep inside an HTTP request.
    throw new BridgeConfigError(
      "sharedSecretRef must be the object form { type: 'secret_ref', secretId }",
      { got: "string" },
    );
  }
  if (typeof raw !== "object" || raw === null) {
    throw new BridgeConfigError("sharedSecretRef is required as an object", { got: typeof raw });
  }
  const record = raw as Record<string, unknown>;
  if (record["type"] !== "secret_ref") {
    throw new BridgeConfigError("sharedSecretRef.type must be exactly 'secret_ref'", {
      got: String(record["type"]),
    });
  }
  const secretId = asString(record["secretId"]);
  if (!secretId) {
    throw new BridgeConfigError("sharedSecretRef.secretId is required");
  }
  const version = asString(record["version"]);
  return version
    ? { type: "secret_ref", secretId, version }
    : { type: "secret_ref", secretId };
}

/**
 * Validate the *shape* of the SDK secret ref without resolving it.
 *
 * `onValidateConfig` must be able to tell an operator "your ref is malformed" without
 * touching the secret provider, because the provider may itself be the thing that is down.
 */
export function validateSecretRefShape(raw: unknown): string[] {
  const errors: string[] = [];
  try {
    readSecretRef(raw);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors;
}

function normaliseRuntimeUrl(raw: string, allowPrivateRuntimeHost: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BridgeConfigError("runtimeUrl is not an absolute URL", { runtimeUrl: raw });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BridgeConfigError("runtimeUrl must be http or https", { protocol: parsed.protocol });
  }
  // SSRF: the signed client is the one component that makes outbound requests on this host, so a
  // `runtimeUrl` aimed at an internal address turns every delivery into a probe of the network the
  // plugin is running inside. The link-local range is refused outright — a cloud metadata service
  // lives there and a Runtime Service never legitimately does. Loopback and RFC1918 are refused by
  // default and allowed only when the operator opts in, because a local Core is a real development
  // setup and silently breaking it would be its own kind of wrong.
  //
  // The flag is a parameter, never module state: one worker serves many companies, and a shared
  // "allow private" switch would be one company's operator choice applied to every other tenant.
  const host = parsed.hostname.toLowerCase();
  if (isLinkLocalOrMetadata(host)) {
    throw new BridgeConfigError(
      "runtimeUrl must not point at a link-local or cloud-metadata address",
      { runtimeUrl: raw, host },
    );
  }
  if (isPrivateOrLoopback(host) && !allowPrivateRuntimeHost) {
    throw new BridgeConfigError(
      "runtimeUrl points at a private or loopback address; set allowPrivateRuntimeHost to true to permit a local Runtime Service",
      { runtimeUrl: raw, host },
    );
  }
  // The signed path must be the exact request path, so a base with a path prefix is kept
  // and the per-call path is appended to it. A trailing slash is removed so the joined
  // path never contains an empty segment.
  const withoutTrailing = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${withoutTrailing}`;
}

function isLinkLocalOrMetadata(host: string): boolean {
  if (host === "localhost") return false;
  if (host === "::1" || host === "[::1]") return false;
  if (host === "0.0.0.0" || host === "::") return true;
  if (host.startsWith("169.254.")) return true;
  if (host.startsWith("[fe80:") || host.startsWith("[fc") || host.startsWith("[fd")) return true;
  // A cloud metadata service is reachable by name as well as by address, and a name that resolves
  // to 169.254.169.254 is exactly what an SSRF payload looks like.
  if (host === "metadata.google.internal" || host === "metadata.goog") return true;
  if (host === "instance-data.ec2.internal") return true;
  return false;
}

function isPrivateOrLoopback(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "[::1]" || host.startsWith("[fe80:")) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4 === null) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export interface ResolveConfigInput {
  readonly companyId: string;
  readonly raw: Record<string, unknown>;
  /**
   * The absolute path of the bridge's SQLite file, decided once by the worker.
   *
   * This is passed *in* rather than derived from `stateDir` because the store is instance-scoped and
   * is opened before any company is known — `config.get` needs a company context, so there is no
   * company config to read at that moment. Deriving the path here instead produced a second, fictional
   * location: `onValidateConfig` then probed the writability of a file the worker never opens, and
   * health named that file in its error. One path, supplied by the thing that actually opens it, is
   * the only version of this that cannot lie.
   */
  readonly storePath: string;
}

export function resolveConfig(input: ResolveConfigInput): BridgeConfig {
  const raw = input.raw;
  const errors: string[] = [];

  const runtimeUrl = asString(raw["runtimeUrl"]);
  if (!runtimeUrl) errors.push("runtimeUrl is required");

  const bridgeIssuer = asString(raw["bridgeIssuer"]);
  if (!bridgeIssuer) errors.push("bridgeIssuer is required");

  let sharedSecretRef: SecretRefConfig | null = null;
  try {
    sharedSecretRef = readSecretRef(raw["sharedSecretRef"]);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (errors.length > 0) {
    throw new BridgeConfigError(`invalid plugin config: ${errors.join("; ")}`, { errors });
  }

  const allowPrivateRuntimeHost = asBoolean(raw["allowPrivateRuntimeHost"], false);
  const normalisedUrl = normaliseRuntimeUrl(runtimeUrl as string, allowPrivateRuntimeHost);
  // The operator's declared state directory. It is *not* where the store lives — the store is
  // instance-scoped and every row in it is namespaced by company — so it is kept for the paths the
  // bridge does write per company, and reported so an operator can see it next to the real store
  // path rather than instead of it.
  const stateDir = asString(raw["stateDir"]) ?? dirname(input.storePath);

  const mode = raw["workspaceProviderMode"];
  if (mode !== undefined && mode !== "metadata_only" && mode !== "inherited") {
    throw new BridgeConfigError("workspaceProviderMode must be 'metadata_only' or 'inherited'", {
      got: String(mode),
    });
  }

  const transport = raw["runtimeTransport"];
  if (transport !== undefined && transport !== "governed" && transport !== "direct") {
    throw new BridgeConfigError("runtimeTransport must be 'governed' or 'direct'", {
      got: String(transport),
    });
  }
  // `direct` removes the host's SSRF guard from the request path, so the plugin's own guard becomes
  // the only thing between an operator-supplied URL and the network this host sits in. That guard
  // already refuses link-local and cloud-metadata targets unconditionally in
  // `normaliseRuntimeUrl` — including the metadata hostnames, which resolve to 169.254.169.254
  // and so never pass by address — and it runs on every config, transport aside. This check
  // therefore adds nothing, and a redundant second copy of a security rule is worse than none:
  // it drifts. The asymmetry that does matter, and that `direct` gives up, is the loopback and
  // RFC1918 range, which the host would have refused and the plugin only permits on explicit
  // opt-in. `direct` is recorded in the bridge's durable state and surfaced in health precisely
  // because that opt-in is real and an operator must be able to see it.

  const level = raw["logLevel"];
  if (level !== undefined && level !== "debug" && level !== "info" && level !== "warn" && level !== "error") {
    throw new BridgeConfigError("logLevel must be one of debug|info|warn|error", { got: String(level) });
  }

  const experimentalRaw = (raw["experimental"] ?? {}) as Record<string, unknown>;
  return {
    companyId: input.companyId,
    runtimeUrl: normalisedUrl,
    allowPrivateRuntimeHost,
    bridgeIssuer: bridgeIssuer as string,
    sharedSecretRef: sharedSecretRef as SecretRefConfig,
    requestTimeoutMs: asNumber(raw["requestTimeoutMs"], DEFAULT_TIMEOUT_MS, 100, 600_000),
    replayWindowSeconds: asNumber(
      raw["replayWindowSeconds"],
      DEFAULT_REPLAY_WINDOW_SECONDS,
      10,
      3600,
    ),
    audience: asString(raw["audience"]) ?? DEFAULT_AUDIENCE,
    stateDir,
    defaultGraphId: asString(raw["defaultGraphId"]),
    engineeringEntryLabel: asString(raw["engineeringEntryLabel"]) ?? "",
    engineeringOriginPrefix: asString(raw["engineeringOriginPrefix"]) ?? "polyforge",
    workspaceProviderMode: (mode as WorkspaceProviderMode | undefined) ?? "metadata_only",
    runtimeTransport: (transport as RuntimeTransport | undefined) ?? "governed",
    experimental: {
      decisions: asBoolean(experimentalRaw["decisions"], false),
      cases: asBoolean(experimentalRaw["cases"], false),
      pipelines: asBoolean(experimentalRaw["pipelines"], false),
    },
    enableProjections: asBoolean(raw["enableProjections"], true),
    logLevel: (level as LogLevel | undefined) ?? "info",
    storePath: input.storePath,
    maxArtifactBytes: asNumber(
      raw["maxArtifactBytes"],
      DEFAULT_MAX_ARTIFACT_BYTES,
      1024,
      256 * 1024 * 1024,
    ),
  };
}

/**
 * Per-company config cache.
 *
 * `invalidate(companyId)` is what `onConfigChanged` calls: a company-scoped config change
 * must not disturb any other company's derived client, and a `null` companyId means an
 * instance-level save, which invalidates every company because the instance defaults moved.
 */
export class ConfigRegistry {
  readonly #byCompany = new Map<string, BridgeConfig>();
  readonly #errors = new Map<string, Error>();
  readonly #storePath: string;

  constructor(storePath: string) {
    this.#storePath = storePath;
  }

  /** Resolve, cache, and return. A previously failed resolution is retried, not cached as poison. */
  load(companyId: string, raw: Record<string, unknown>): BridgeConfig {
    try {
      const config = resolveConfig({
        companyId,
        raw,
        storePath: this.#storePath,
      });
      this.#byCompany.set(companyId, config);
      this.#errors.delete(companyId);
      return config;
    } catch (error) {
      const wrapped = error instanceof Error ? error : new BridgeConfigError(String(error));
      this.#errors.set(companyId, wrapped);
      throw wrapped;
    }
  }

  get(companyId: string): BridgeConfig | null {
    return this.#byCompany.get(companyId) ?? null;
  }

  errorFor(companyId: string): Error | null {
    return this.#errors.get(companyId) ?? null;
  }

  invalidate(companyId: string | null): void {
    if (companyId === null) {
      this.#byCompany.clear();
      this.#errors.clear();
      return;
    }
    this.#byCompany.delete(companyId);
    this.#errors.delete(companyId);
  }

  companies(): string[] {
    return [...this.#byCompany.keys()];
  }
}
