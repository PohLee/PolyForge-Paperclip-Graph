#!/usr/bin/env node
/**
 * `pfctl` — a signed command line for the PolyForge Runtime Service.
 *
 * Operations and the end-to-end harness both need to talk to the Core the way the bridge does,
 * which means signing every request. Reusing the bridge's own client here would prove nothing
 * about the client, so this is an independent second implementation: if the two ever disagree
 * on a signature, one of them is wrong and the harness fails.
 *
 *   node ops/pfctl.mjs health
 *   node ops/pfctl.mjs runs --company <id> --project <id>
 *   node ops/pfctl.mjs get-run <runId> --company <id> --project <id>
 *   node ops/pfctl.mjs events <runId> --after 0 --company <id> --project <id>
 *   node ops/pfctl.mjs post /v1/work-orders --body @file.json --company <id> --project <id> \
 *        --actor-type agent --actor-id agent-1
 *   node ops/pfctl.mjs bootstrap --company <id> --project <id>   # publish + activate the requirement graph
 *
 * The secret is read from `$POLYFORGE_SECRET_FILE` (default `$PF_DATA_DIR/bridge.secret`) or
 * `$POLYFORGE_BRIDGE_SECRET`. It is never echoed, never logged, and never accepted as an argument.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

/**
 * The generated dependency lock for one library graph.
 *
 * Throws when the graph is absent. The previous form fell back to `{}`, which compiles: the compiler
 * then has no pins to check a child against and will resolve one to a default. An unpinned child is
 * precisely what the design refuses to admit, so a missing lock must stop the operator here, with a
 * message that says how to fix it, rather than producing a graph whose children are not pinned.
 */
function readLibrary(graphId) {
  const path = new URL("./graph-library-lock.json", import.meta.url);
  if (!existsSync(path)) {
    throw new Error(
      `ops/graph-library-lock.json is missing. Generate it with:\n` +
        `  PYTHONPATH=services/polyforge/src python3 ops/build-graph-library-lock.py --write`,
    );
  }
  const document = JSON.parse(readFileSync(path, "utf8"));
  const lock = document.graphs?.[graphId];
  if (lock === undefined) {
    throw new Error(
      `graph-library-lock.json has no entry for graph "${graphId}". It knows: ` +
        `${Object.keys(document.graphs ?? {}).sort().join(", ") || "<nothing>"}. ` +
        `Regenerate it with: PYTHONPATH=services/polyforge/src python3 ops/build-graph-library-lock.py --write`,
    );
  }
  // The definition is required, not optional. `create_draft` takes the definition from the caller
  // and never invents one, and an empty draft compiles without complaint - so omitting this
  // published a valid, empty version of a library graph and reported success.
  const definition = document.definitions?.[graphId];
  if (definition === undefined) {
    throw new Error(
      `graph-library-lock.json has no definition for graph "${graphId}". ` +
        `Regenerate it with: PYTHONPATH=services/polyforge/src python3 ops/build-graph-library-lock.py --write`,
    );
  }
  return { lock, definition };
}

const BASE = opt("url", process.env.PF_SERVICE_URL ?? "http://127.0.0.1:8787");
const ISSUER = opt("issuer", process.env.POLYFORGE_BRIDGE_ISSUER ?? "polyforge-bridge");
const AUDIENCE = opt("audience", process.env.POLYFORGE_AUDIENCE ?? "polyforge-runtime");
const SECRET =
  process.env.POLYFORGE_BRIDGE_SECRET ??
  (() => {
    const file = opt("secret-file", process.env.POLYFORGE_SECRET_FILE ?? null);
    if (file) return readFileSync(file, "utf8").trim();
    throw new Error("set POLYFORGE_BRIDGE_SECRET or pass --secret-file");
  })();

// ---------------------------------------------------------------------------
// Canonical JSON — the same normative encoding as polyforge.core.hashing.
// Written out again rather than imported, so this client is an independent witness.
// ---------------------------------------------------------------------------
function canonicalJson(value) {
  const out = [];
  const encode = (v, path) => {
    if (v === null) return out.push("null");
    if (typeof v === "boolean") return out.push(v ? "true" : "false");
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error(`non-finite number at ${path}`);
      if (Object.is(v, -0)) return out.push("0");
      return out.push(JSON.stringify(v));
    }
    if (typeof v === "string") return out.push(JSON.stringify(v));
    if (Array.isArray(v)) {
      out.push("[");
      v.forEach((item, i) => {
        if (i) out.push(",");
        encode(item, `${path}[${i}]`);
      });
      return out.push("]");
    }
    if (v && typeof v === "object") {
      out.push("{");
      const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
      keys.forEach((k, i) => {
        if (i) out.push(",");
        out.push(JSON.stringify(k), ":");
        encode(v[k], path ? `${path}.${k}` : k);
      });
      return out.push("}");
    }
    throw new Error(`unsupported value of type ${typeof v} at ${path}`);
  };
  encode(value, "");
  return out.join("");
}

const b64url = (text) => Buffer.from(text, "utf8").toString("base64url").replace(/=+$/, "");
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * The service signs the *mount-relative* target, with the `/v1` prefix removed and the query
 * kept. Removing the prefix is deliberate on the service side — a proxy that rewrites the mount
 * point must not invalidate in-flight signatures — and the query must stay, or
 * `/graphs/g/diff?from=1&to=2` would be replayable as `?to=3`.
 */
const signedPath = (pathAndQuery) => pathAndQuery.replace(/^\/v1(?=\/|$)/, "") || "/";

function actorAssertion() {
  const actorType = opt("actor-type", "system");
  const actorId = opt("actor-id", "pfctl");
  const roles = (opt("roles", actorType === "system" ? "polyforge.operator" : "")).split(",").filter(Boolean);
  const assertion = { actorType, actorId, roles };
  if (opt("agent-id")) assertion.agentId = opt("agent-id");
  if (opt("run-id")) assertion.runId = opt("run-id");
  if (actorType === "agent" && !assertion.agentId) assertion.agentId = actorId;
  return assertion;
}

/**
 * One signed request.
 *
 * `overrides.actorType` exists for exactly one caller: recording a graph review, which the Core
 * refuses unless the assertion is a human's. The default stays whatever `--actor-type` says, so no
 * other command can acquire a human assertion by accident.
 */
async function request(method, pathAndQuery, body, overrides = {}) {
  const company = opt("company", "");
  const project = opt("project", "");
  // No company means an instance-scoped caller: the header is omitted entirely rather than sent
  // empty, because "no tenant" and "a tenant with an empty name" must not be the same request.
  const scope = company ? { companyRef: company, projectRef: project } : {};
  const actor =
    overrides.actorType === undefined
      ? actorAssertion()
      : {
          actorType: overrides.actorType,
          actorId: overrides.actorId ?? `pfctl:${overrides.actorType}`,
          // Roles are part of the signed assertion, so they are carried explicitly rather than
          // defaulted. The Core checks them, and a default would make that check meaningless.
          ...(overrides.roles === undefined ? {} : { roles: overrides.roles }),
        };
  const raw = body === undefined ? "" : JSON.stringify(body);
  const payload = raw ? Buffer.from(raw, "utf8") : Buffer.alloc(0);
  const canonical = canonicalJson({
    actor,
    audience: AUDIENCE,
    bodyHash: digest(payload),
    issuer: ISSUER,
    method: method.toUpperCase(),
    nonce: randomBytes(16).toString("hex"),
    path: signedPath(pathAndQuery),
    scope,
    timestamp: new Date().toISOString(),
  });
  const signed = JSON.parse(canonical);
  const headers = {
    "content-type": "application/json",
    "x-pf-audience": AUDIENCE,
    "x-pf-issuer": ISSUER,
    "x-pf-timestamp": signed.timestamp,
    "x-pf-nonce": signed.nonce,
    "x-pf-actor": b64url(JSON.stringify(actor)),
    "x-pf-signature": `v1=${createHmac("sha256", SECRET).update(canonical).digest("hex")}`,
  };
  if (company) headers["x-pf-scope"] = b64url(JSON.stringify(scope));
  const response = await fetch(`${BASE}${pathAndQuery}`, {
    method,
    headers,
    body: payload.length ? payload : undefined,
    signal: AbortSignal.timeout(Number(opt("timeout", "20000"))),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

const emit = (result) => {
  process.stdout.write(`${JSON.stringify(result.body, null, has("raw") ? 0 : 2)}\n`);
  if (result.status >= 400) process.exitCode = 1;
};

const [command, ...rest] = argv.filter((a) => !a.startsWith("--") && !isValue(a));
function isValue(token) {
  const index = argv.indexOf(token);
  return index > 0 && argv[index - 1].startsWith("--") && !["--raw", "--strict"].includes(argv[index - 1]);
}

const body = (() => {
  const inline = opt("body", null);
  if (!inline) return undefined;
  return inline.startsWith("@") ? JSON.parse(readFileSync(inline.slice(1), "utf8")) : JSON.parse(inline);
})();

switch (command) {
  case "health": {
    const [live, ready] = await Promise.all([
      fetch(`${BASE}/v1/health/live`).then((r) => r.json()),
      request("GET", "/v1/health"),
    ]);
    emit({ status: 200, body: { live, ready: ready.body, readyStatus: ready.status } });
    break;
  }
  case "runs":
    emit(await request("GET", `/v1/runs?limit=${opt("limit", "50")}`));
    break;
  case "get-run":
    emit(await request("GET", `/v1/runs/${rest[0]}`));
    break;
  case "events":
    emit(await request("GET", `/v1/runs/${rest[0]}/events?after=${opt("after", "0")}&limit=${opt("limit", "200")}`));
    break;
  case "refusals":
    emit(await request("GET", `/v1/runs/${rest[0]}/refusals`));
    break;
  case "current":
    emit(await request("GET", `/v1/runs/${rest[0]}/current${rest[1] ? `?nodeId=${rest[1]}` : ""}`));
    break;
  case "post":
    emit(await request(opt("method", "POST"), rest[0], body ?? {}));
    break;
  case "recover":
    emit(await request("POST", "/v1/recover", body ?? {}));
    break;
  case "bootstrap": {
    // Publish and activate the shipped requirement graph so an operator has a real version to
    // point a WorkOrder at. Deliberately explicit: activation is a separate decision from
    // publication, and both are audited.
    const graphId = opt("graph", "requirement");
    const author = opt("author", "pfctl");
    const library = readLibrary(graphId);
    const result = { steps: [] };
    const draft = await request("POST", `/v1/graphs/${graphId}/drafts`, {
      companyRef: opt("company"),
      projectRef: opt("project"),
      author,
      baseVersion: null,
      definition: library.definition,
    });
    result.steps.push({ step: "create-draft", ...draft });
    if (draft.status >= 400) {
      // `emit` prints `result.body`, so the composite has to be handed over in that shape. Passing
      // the composite directly printed `undefined` and exited 0, which is the worst possible
      // combination: a silent failure that looks like a success to any caller checking the exit code.
      emit({ status: draft.status, body: result });
      break;
    }
    const draftId = draft.body.draftId;
    const revision = draft.body.revision;

    // Validate first. Publishing requires a recorded validation for the draft's *current* revision,
    // and compiling does not produce one, so a draft that skipped this step reached publish and was
    // refused with "editing invalidated the earlier one" - a message about staleness for what was
    // really a step that was never taken.
    const validated = await request("POST", `/v1/drafts/${draftId}/validate`, {
      companyRef: opt("company"),
      projectRef: opt("project"),
    });
    result.steps.push({ step: "validate", ...validated });
    if (validated.status >= 400) {
      emit({ status: validated.status, body: result });
      break;
    }
    if (validated.body?.ok === false) {
      // A draft that does not validate must not go on to be compiled and reviewed; the issues are
      // the answer, and continuing would only bury them under a later, less useful error.
      emit({ status: 422, body: result });
      break;
    }

    const compiled = await request("POST", `/v1/drafts/${draftId}/compile`, {
      companyRef: opt("company"),
      projectRef: opt("project"),
      // The lock is generated from the Core's own graph library by
      // `ops/build-graph-library-lock.py`, which also stamps the capability, evaluator and policy
      // versions it was built against. Reading the nested `graphs` map (and failing loudly when the
      // graph is absent) is deliberate: an empty lock would let the compiler resolve a child to a
      // default, which is exactly the unpinned admission the design refuses.
      dependencyLock: library.lock,
    });
    result.steps.push({ step: "compile", ...compiled });
    if (compiled.status >= 400) {
      emit({ status: compiled.status, body: result });
      break;
    }
    // The Core refuses a review from an agent or a system assertion: a published version is a human
    // act, and that refusal is enforced in the Core rather than left to the client's good manners.
    //
    // So the reviewer here is this operator, running this command at a terminal, and the assertion
    // says so. What that does *not* establish is that a worker could not have done the same thing
    // with the shared secret: the Core trusts human assertions from the issuer it is configured
    // with, and the bridge and this CLI share that issuer. The separation that actually holds is
    // narrower than the vocabulary suggests - see the V-15 entry in ops/compatibility-lock.json.
    // Recording a review needs a platform role as well as a human assertion. The role is *not*
    // defaulted: an operator tool that granted itself `polyforge.operator` would make the check
    // decorative, and the refusal below is the only thing standing between "a human clicked" and
    // "anything that can sign can publish a graph". Pass it explicitly.
    const reviewRole = opt("review-role");
    if (reviewRole === null) {
      emit({
        status: 400,
        body: {
          ...result,
          error: {
            code: "OPERATOR_INPUT_REQUIRED",
            message:
              "recording a graph review needs a platform role. Re-run with, for example:\n" +
              "  --review-role polyforge.operator\n" +
              "The Core accepts polyforge.author, polyforge.operator, or the graph.author capability.",
          },
        },
      });
      break;
    }
    const reviewed = await request("POST", `/v1/drafts/${draftId}/reviews`, {
      companyRef: opt("company"),
      projectRef: opt("project"),
      reviewTargetHash: compiled.body.planHash,
    }, { actorType: "human", actorId: opt("reviewer", "pfctl:operator"), roles: [reviewRole] });
    result.steps.push({ step: "review", ...reviewed });
    if (reviewed.status >= 400) {
      emit({ status: reviewed.status, body: result });
      break;
    }
    const published = await request("POST", `/v1/drafts/${draftId}/publish`, {
      companyRef: opt("company"),
      projectRef: opt("project"),
      author,
      // The service compares against exactly these four names. The `expected*` spellings were
      // silently ignored, so publish failed with "definitionHash is required" while every hash the
      // client had computed was sitting in the body under a name nobody read.
      expectedRevision: revision,
      definitionHash: compiled.body.definitionHash,
      planHash: compiled.body.planHash,
      compilerVersion: compiled.body.compilerVersion,
      reviewTargetHash: compiled.body.planHash,
      authorizationRefs: [],
    });
    result.steps.push({ step: "publish", ...published });
    if (published.status < 400) {
      // No `actor` in the body. The Core refuses a body that names an identity, because a body is
      // the one part of a request the signature does not decide; carrying the author here would let
      // a caller publish as whoever it liked. The activation actor is the signed assertion, full stop.
      // The generation is read, not assumed. Activation is a compare-and-swap on the pointer's own
      // counter, so a hardcoded 0 is only ever correct the first time a graph is activated in a
      // scope; every later run failed with "default pointer generation is stale". Reading it first is
      // the whole discipline: a CAS whose current value you cannot read is not a CAS, it is a
      // one-shot that happens to look correct on a fresh database.
      const pointer = await request("GET", `/v1/graphs/${graphId}/versions`);
      if (pointer.status >= 400) {
        emit({ status: pointer.status, body: result });
        break;
      }
      const generation = typeof pointer.body?.generation === "number" ? pointer.body.generation : 0;
      const activated = await request("POST", `/v1/graphs/${graphId}/activate`, {
        companyRef: opt("company"),
        projectRef: opt("project"),
        version: published.body.version,
        expectedGeneration: generation,
      });
      result.steps.push({ step: "activate", ...activated });
    }
    // The exit status reflects the *worst* step, not merely the last one: a publish that failed
    // after a successful activate would otherwise exit 0.
    const worst = result.steps.reduce((acc, s) => Math.max(acc, typeof s.status === "number" ? s.status : 0), 200);
    emit({ status: worst, body: result });
    break;
  }
  default:
    process.stderr.write(
      "usage: pfctl <health|runs|get-run|events|refusals|current|post|recover|bootstrap> [args]\n" +
        "       --company <id> --project <id> [--body @file.json] [--actor-type system|agent|human]\n",
    );
    process.exit(2);
}
