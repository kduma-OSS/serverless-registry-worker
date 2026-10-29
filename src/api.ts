/**
 * The `/api/v1` surface (docs/api.md). Requests are processed in the order of section 1.4:
 * client version check, routing, body parsing, authentication, kind check, then the endpoint.
 * Every response carries `X-Min-Client-Version`.
 */

import type { Eco } from "./adapters/types";
import {
  addSecret,
  createCredential,
  deletePackage,
  updateSecret,
  deleteVersion,
  expireSecret,
  listCredentialViews,
  readCredentialView,
  reindex,
  removeCredential,
  updateGrants,
  yank,
} from "./core/admin";
import {
  authenticate,
  emptyGrants,
  hasRole,
  legacyGrants,
  primaryKind,
  sessionIdentity,
  type Identity,
  type Kind,
  type KindHint,
} from "./core/auth";
import { acceptBucket } from "./core/bucket";
import { identityMayModify } from "./core/modify";
import { publicUrl } from "./core/config";
import { createLoginSession, opsAllow, pollLoginSession } from "./core/login";
import { ValidationError } from "./core/errors";
import { lookupRepository } from "./core/github";
import { errorResponse, jsonResponse } from "./core/http";
import { getPackage, listPackages } from "./core/packages";
import { commit, init } from "./core/publish";
import { compareVersions, parseVersion } from "./core/semver";
import type { Env } from "./env";
import { Router, type Params } from "./router";
import { MIN_CLIENT_VERSION, SCHEMA_VERSION, VERSION } from "./version";

/** Path prefix of the API. */
export const API_PREFIX = "/api/v1";

/** Headers on every `/api/v1` response. */
export const API_HEADERS: Readonly<Record<string, string>> = {
  "x-min-client-version": MIN_CLIENT_VERSION,
};

/** Request bodies are limited to 4 MiB. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** A semver version as the CLI sends it: no leading `v`. */
const CLIENT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const MUTATING = new Set(["POST", "PATCH", "DELETE"]);

/** Everything an endpoint handler gets. */
export interface ApiContext {
  env: Env;
  request: Request;
  params: Params;
  body: Record<string, unknown>;
  /** The caller; a placeholder that is never read for endpoints without authentication. */
  identity: Identity;
  now: Date;
  /** `PUBLIC_URL`, or the request's origin when it is not set. */
  publicUrl: string;
  /** Outgoing requests (GitHub); injectable for tests. */
  fetch: typeof fetch;
}

interface ApiResult {
  status: number;
  body: unknown;
}

interface ApiRoute {
  /** `none`: no credential; `any`: every kind; otherwise the kinds allowed. */
  auth: "none" | "any" | readonly Kind[];
  /**
   * What an admin login token (`identity.ops`, docs/api.md 2.6) may do here. Absent: nothing, the
   * route answers `403`. `"any"`: the route is open to it. Otherwise the operation the token
   * must have approved for the `eco`, `name` (and, with `version`, `version`) of the path.
   */
  ops?: "any" | { op: "yank" | "delete"; version: boolean };
  handler: (c: ApiContext) => Promise<ApiResult> | ApiResult;
}

const ok = (body: unknown): ApiResult => ({ status: 200, body });
const created = (body: unknown): ApiResult => ({ status: 201, body });

const ADMIN: readonly Kind[] = ["admin"];
const READERS: readonly Kind[] = ["read", "admin", "yank", "delete"];
const YANKERS: readonly Kind[] = ["admin", "yank"];
const DELETERS: readonly Kind[] = ["admin", "delete"];
const PUBLISHERS: readonly Kind[] = ["publish"];

const p = (c: ApiContext, name: string): string => c.params[name] ?? "";

/**
 * The kind a `_:gh.<jwt>` login must resolve to for a route (docs/api.md 2.5): `publish` for the
 * publishing endpoints, `admin` for routes that need the `admin` role alone, the roles of the
 * route for yank and delete (`admin` or `yank` / `delete`), otherwise `read`.
 */
function kindHintFor(auth: ApiRoute["auth"]): KindHint {
  if (auth === "none" || auth === "any") return "read";
  if (auth.includes("publish")) return "publish";
  if (auth === YANKERS || auth === DELETERS) return auth;
  return auth.length > 0 && auth.every((kind) => kind === "admin") ? "admin" : "read";
}

/**
 * Throws `403 forbidden` unless the caller's grants allow the yank or delete: an `admin` may do
 * both anywhere, a `yank` or `delete` credential only what its grants of that role cover. A
 * login token was checked when it was approved and by the router against its operations.
 */
function requireMayModify(
  c: ApiContext,
  op: "yank" | "delete",
  eco: string,
  name: string,
  version?: string,
): void {
  const target = {
    op,
    eco: eco as Eco,
    package: name,
    ...(version === undefined ? {} : { version }),
  };
  if (!identityMayModify(c.env, c.identity, target)) {
    throw new ValidationError(
      "forbidden",
      `This credential's ${op} grants do not cover ${version === undefined ? "this package" : "this version"}.`,
    );
  }
}

const routes = new Router<ApiRoute>()
  .add("GET", "/api/v1/version", {
    auth: "none",
    handler: () =>
      ok({ version: VERSION, minClientVersion: MIN_CLIENT_VERSION, schemaVersion: SCHEMA_VERSION }),
  })
  .add("GET", "/api/v1/whoami", {
    auth: "any",
    ops: "any",
    handler: (c) => {
      const { roles, grants, scopes, ops } = c.identity;
      return ok({
        project: c.identity.project,
        kind: primaryKind(roles),
        grants: legacyGrants(roles, grants),
        roles,
        access: {
          ...(roles.includes("read") ? { read: grants.read } : {}),
          ...(roles.includes("publish") ? { publish: grants.publish } : {}),
          ...(roles.includes("yank") ? { yank: grants.yank } : {}),
          ...(roles.includes("delete") ? { delete: grants.delete } : {}),
        },
        ...(scopes === undefined ? {} : { scopes }),
        ...(ops === undefined ? {} : { ops }),
      });
    },
  })
  .add("POST", "/api/v1/bucket/accept", {
    auth: ADMIN,
    handler: async (c) => {
      await acceptBucket(c.env);
      return ok({ accepted: true });
    },
  })
  .add("POST", "/api/v1/auth/sessions", {
    auth: "none",
    handler: async (c) => created(await createLoginSession(c.env, c.body, c.publicUrl, c.now)),
  })
  .add("POST", "/api/v1/auth/sessions/poll", {
    auth: "none",
    handler: async (c) => {
      const result = await pollLoginSession(c.env, c.body, c.now);
      return result.status === "pending"
        ? { status: 202, body: { status: "pending" } }
        : ok({ status: "approved", ...result.issued });
    },
  })
  .add("POST", "/api/v1/publish/init", {
    auth: PUBLISHERS,
    handler: async (c) => ok(await init(c.env, c.identity, c.body, c.now)),
  })
  .add("POST", "/api/v1/publish/commit", {
    auth: PUBLISHERS,
    handler: async (c) => created(await commit(c.env, c.identity, c.body, c.now, c.publicUrl)),
  })
  .add("GET", "/api/v1/packages", {
    auth: READERS,
    handler: async (c) => ok(await listPackages(c.env, c.identity)),
  })
  .add("GET", "/api/v1/packages/:eco/:name", {
    auth: READERS,
    handler: async (c) => ok(await getPackage(c.env, c.identity, p(c, "eco"), p(c, "name"))),
  })
  .add("POST", "/api/v1/packages/:eco/:name/:version/yank", {
    auth: YANKERS,
    ops: { op: "yank", version: true },
    handler: async (c) => {
      requireMayModify(c, "yank", p(c, "eco"), p(c, "name"), p(c, "version"));
      return ok(await yank(c.env, p(c, "eco"), p(c, "name"), p(c, "version"), c.now, c.publicUrl));
    },
  })
  .add("DELETE", "/api/v1/packages/:eco/:name/:version", {
    auth: DELETERS,
    ops: { op: "delete", version: true },
    handler: async (c) => {
      requireMayModify(c, "delete", p(c, "eco"), p(c, "name"), p(c, "version"));
      return ok(
        await deleteVersion(c.env, p(c, "eco"), p(c, "name"), p(c, "version"), c.now, c.publicUrl),
      );
    },
  })
  .add("DELETE", "/api/v1/packages/:eco/:name", {
    auth: DELETERS,
    ops: { op: "delete", version: false },
    handler: async (c) => {
      requireMayModify(c, "delete", p(c, "eco"), p(c, "name"));
      return ok(await deletePackage(c.env, p(c, "eco"), p(c, "name"), c.publicUrl));
    },
  })
  .add("POST", "/api/v1/packages/:eco/:name/reindex", {
    auth: ADMIN,
    handler: async (c) => ok(await reindex(c.env, p(c, "eco"), p(c, "name"), c.now, c.publicUrl)),
  })
  .add("GET", "/api/v1/credentials", {
    auth: ADMIN,
    handler: async (c) => ok(await listCredentialViews(c.env)),
  })
  .add("POST", "/api/v1/credentials", {
    auth: ADMIN,
    handler: async (c) => created(await createCredential(c.env, c.body, c.now)),
  })
  .add("GET", "/api/v1/credentials/:project", {
    auth: ADMIN,
    handler: async (c) => ok(await readCredentialView(c.env, p(c, "project"))),
  })
  .add("PATCH", "/api/v1/credentials/:project", {
    auth: ADMIN,
    handler: async (c) => ok(await updateGrants(c.env, p(c, "project"), c.body)),
  })
  .add("DELETE", "/api/v1/credentials/:project", {
    auth: ADMIN,
    handler: async (c) => ok(await removeCredential(c.env, p(c, "project"))),
  })
  .add("POST", "/api/v1/credentials/:project/secrets", {
    auth: ADMIN,
    handler: async (c) => created(await addSecret(c.env, p(c, "project"), c.body, c.now)),
  })
  .add("GET", "/api/v1/github/repository", {
    auth: ADMIN,
    handler: async (c) =>
      ok(await lookupRepository(new URL(c.request.url).searchParams.get("name") ?? "", c.fetch)),
  })
  .add("PATCH", "/api/v1/credentials/:project/secrets/:id", {
    auth: ADMIN,
    handler: async (c) => ok(await updateSecret(c.env, p(c, "project"), p(c, "id"), c.body, c.now)),
  })
  .add("DELETE", "/api/v1/credentials/:project/secrets/:id", {
    auth: ADMIN,
    handler: async (c) => ok(await expireSecret(c.env, p(c, "project"), p(c, "id"), c.body, c.now)),
  });

/** Section 3: `400` for a malformed `X-Client-Version`, `426` below the minimum. */
function checkClientVersion(request: Request): void {
  const header = request.headers.get("x-client-version");
  if (header === null) return;
  const value = header.trim();
  if (!CLIENT_VERSION_RE.test(value) || parseVersion(value) === null) {
    throw new ValidationError("invalid_request", "X-Client-Version must be a semver version.");
  }
  if (compareVersions(value, MIN_CLIENT_VERSION) < 0) {
    throw new ValidationError(
      "client_too_old",
      `This registry requires sreg ${MIN_CLIENT_VERSION} or newer.`,
    );
  }
}

/** Section 1.2: a JSON object body of at most 4 MiB; an empty body is `{}`. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const tooLarge = () =>
    new ValidationError("payload_too_large", "Request bodies are limited to 4 MiB.");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooLarge();
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) throw tooLarge();
  if (bytes.byteLength === 0) return {};
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new ValidationError("invalid_request", "Request bodies must be application/json.");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new ValidationError("invalid_request", "The request body is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("invalid_request", "The request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

/**
 * Section 2: the `Authorization` header wins; without it the panel's session cookie is used.
 * Returns `null` when no valid credential is found.
 */
async function identify(
  request: Request,
  env: Env,
  kindHint: KindHint,
): Promise<{ identity: Identity; viaCookie: boolean } | null> {
  if (request.headers.has("authorization")) {
    const auth = await authenticate(request, env, { kindHint });
    return auth === null ? null : { identity: auth.identity, viaCookie: false };
  }
  const session = await sessionIdentity(request, env);
  return session === null ? null : { identity: session.identity, viaCookie: true };
}

/**
 * An admin login token (docs/api.md 2.6) carries the `admin` role but may only perform the yank
 * and delete operations it was approved for, and `whoami`: every other route answers `403`.
 */
function checkOps(
  env: Env,
  ops: NonNullable<Identity["ops"]>,
  route: ApiRoute,
  params: Params,
): void {
  if (route.ops === undefined) {
    throw new ValidationError("forbidden", "This login token may not perform this operation.");
  }
  if (route.ops === "any") return;
  const allowed = opsAllow(
    env,
    ops,
    route.ops.op,
    params.eco ?? "",
    params.name ?? "",
    route.ops.version ? (params.version ?? "") : undefined,
  );
  if (!allowed) {
    throw new ValidationError("forbidden", "This login token was not approved for this operation.");
  }
}

/** A stand-in identity for endpoints without authentication; never used by them. */
const ANONYMOUS: Identity = {
  project: "",
  roles: ["read"],
  grants: emptyGrants(),
  record: { project: "", roles: ["read"], auth: [], grants: emptyGrants() },
  entryId: "",
};

async function dispatch(
  request: Request,
  env: Env,
  url: URL,
  now: Date,
  fetcher: typeof fetch,
): Promise<Response> {
  if (url.pathname !== `${API_PREFIX}/version`) checkClientVersion(request);

  const match = routes.match(request.method, url.pathname);
  if (match === null) throw new ValidationError("not_found");
  const route = match.value;

  const body = await readBody(request);

  let identity = ANONYMOUS;
  if (route.auth !== "none") {
    // A `_:gh.<jwt>` login resolves to the kind the route needs: `publish` on the publishing
    // endpoints, `admin` on the administrative ones, `read` everywhere else.
    const kindHint = kindHintFor(route.auth);
    const found = await identify(request, env, kindHint);
    if (found === null) throw new ValidationError("unauthorized");
    if (
      found.viaCookie &&
      MUTATING.has(request.method) &&
      (request.headers.get("x-requested-with") ?? "").trim() === ""
    ) {
      throw new ValidationError("forbidden", "Requests with a session need X-Requested-With.");
    }
    if (route.auth !== "any" && !hasRole(found.identity, ...route.auth)) {
      throw new ValidationError("forbidden", "This credential may not perform this operation.");
    }
    identity = found.identity;
    if (identity.ops !== undefined) checkOps(env, identity.ops, route, match.params);
  }

  const result = await route.handler({
    env,
    request,
    params: match.params,
    body,
    identity,
    now,
    publicUrl: publicUrl(env, request),
    fetch: fetcher,
  });
  return jsonResponse(result.body, result.status, API_HEADERS);
}

/** Answers an `/api/v1` request; errors become `{ error, message }` bodies. */
export async function handleApi(
  request: Request,
  env: Env,
  url: URL,
  now: Date = new Date(),
  // The global `fetch` must not be called as a method of another object.
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<Response> {
  try {
    return await dispatch(request, env, url, now, fetcher);
  } catch (err) {
    if (!(err instanceof ValidationError)) {
      console.error("Unhandled API error:", err instanceof Error ? err.message : String(err));
    }
    return errorResponse(err, API_HEADERS);
  }
}
