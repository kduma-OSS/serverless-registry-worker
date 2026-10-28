/**
 * The home page and the admin panel (docs/spec.md "Home page and panel"): `GET /` shows the
 * first-run form, the login page or the view of the session's credential kind (an admin is sent
 * on to `/admin/packages`); `POST /login`, `POST /logout` and `POST /first-run` handle the
 * forms; `GET /packages/<eco>/<name>[/<version>]` show a package and a version, and
 * `…/<version>/files/<file>` downloads a file. The admin pages live under `/admin/`: packages,
 * credentials (list, `new`, one credential) and settings. HTML is rendered here
 * (`src/pages/`); styles and scripts are static assets. Mutations go through `/api/v1` with the
 * session cookie, except the two admin forms whose answer is a one-time token ("new
 * credential", "add a secret"), which are form posts checked like the login form.
 */

import { ECOS } from "./adapters/types";
import {
  addSecret,
  updateSecret,
  createCredential,
  createFirstAdmin,
  hasAnyCredential,
  listCredentialViews,
  readCredentialView,
} from "./core/admin";
import {
  activeLogins,
  authenticate,
  clearPendingCookie,
  clearSessionCookie,
  createPending,
  createSession,
  effectiveRoles,
  getCredential,
  hasRole,
  KINDS,
  pendingCookie,
  readPending,
  sessionCookie,
  sessionIdentity,
  sessionValueFrom,
  type Authentication,
  type AuthRecordEntry,
  type Kind,
  type CredentialRecord,
  type Identity,
} from "./core/auth";
import {
  DEFAULT_APPEND_WINDOW_HOURS,
  DEFAULT_BUCKET_NAME,
  DEFAULT_CHECK_UPDATES,
  DEFAULT_LOGIN_TOKEN_EXTENDED_TTL_HOURS,
  DEFAULT_MAX_PUBLISH_SCOPES,
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_TOKEN_PREFIX,
  enabledEcosystems,
  loginTokenExtendedTtlHours,
  missingRequired,
  publicUrl,
  setupStatus,
  tokenPrefix,
} from "./core/config";
import { ValidationError } from "./core/errors";
import { WWW_AUTHENTICATE } from "./core/http";
import {
  approvalProblem,
  checkPassword,
  checkScopes,
  decideLoginSession,
  findLogin,
  needsFreshTotp,
  readDecision,
  readLoginSession,
  verifyEntryTotp,
  type LoginSession,
} from "./core/login";
import { listPackageSummaries } from "./core/packages";
import { checkLatestRelease, releaseForHeader, updateStatus, updatesEnabled } from "./core/updates";
import type { Env } from "./env";
import { adminPackagesPage, credentialHref } from "./pages/admin";
import {
  authorizeApprovePage,
  authorizeCodePage,
  authorizeDonePage,
  authorizeSignInPage,
} from "./pages/authorize";
import { consumerPage } from "./pages/consumer";
import { MIN_PASSWORD_LENGTH } from "./pages/components";
import {
  credentialPage,
  credentialsPage,
  credentialTab,
  newCredentialPage,
  type ScopeEdit,
  type SecretFormValues,
} from "./pages/credentials";
import { firstRunPage } from "./pages/firstRun";
import { markup } from "./pages/html";
import { ADMIN_SECTIONS, htmlResponse, type PageContext } from "./pages/layout";
import { loginCodePage, loginPage, type LoginMode } from "./pages/login";
import { messagePage } from "./pages/message";
import { packagePage } from "./pages/package";
import { publishPage } from "./pages/publish";
import { settingsPage, type AdminSettings, type Setting } from "./pages/settings";
import { setupPage } from "./pages/setup";
import { placeholderSnippets } from "./pages/snippets";
import { loginSecretPage, tokenPage } from "./pages/token";
import { versionPage } from "./pages/version";
import { credentialForm, formScope, secretForm } from "./panelForms";
import type { Credential as CredentialView } from "./core/auth";
import { acceptBucket, bucketProblem } from "./core/bucket";
import { downloadUrl, visiblePackage, visibleVersion } from "./panelPackages";
import { Router, type Params } from "./router";
import { MIN_CLIENT_VERSION, SCHEMA_VERSION, VERSION } from "./version";

/** Form bodies are small: a token, or a login and a password (a `gh` JWT fits easily). */
const MAX_FORM_BYTES = 64 * 1024;

/** Injectable clock and network for tests. */
export interface PanelDeps {
  now?: () => Date;
  fetch?: typeof fetch;
  /** Keeps a background task alive after the response (`ExecutionContext.waitUntil`). */
  waitUntil?: (promise: Promise<unknown>) => void;
}

interface PanelRequest {
  request: Request;
  env: Env;
  url: URL;
  now: Date;
  fetch: typeof fetch;
  waitUntil?: (promise: Promise<unknown>) => void;
  ctx: PageContext;
  /** Decoded path parameters of the route. */
  params: Params;
}

type PanelHandler = (r: PanelRequest) => Promise<Response>;

const LOGIN_FAILED = "The token, or the login and password, are not valid.";

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "private, no-store", ...headers },
  });
}

/** A `303` that sets several cookies (a `Headers` object keeps each `Set-Cookie` line). */
function redirectWithCookies(location: string, cookies: string[]): Response {
  const headers = new Headers({ location, "cache-control": "private, no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

/**
 * Cross-site form posts are refused. A post is accepted when its `Origin` is the registry's own
 * origin (the request's, or that of `PUBLIC_URL`), or when `Origin` is `null` or missing and
 * the browser vouches for it with `Sec-Fetch-Site: same-origin` (or `none`, a navigation the
 * user started). Browsers send `Origin: null` when the page was served with a referrer policy
 * that hides it; anything else, including a post with neither header, is refused.
 */
function sameOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "null") {
    return (
      origin === new URL(request.url).origin || origin === new URL(publicUrl(env, request)).origin
    );
  }
  const site = request.headers.get("sec-fetch-site");
  return site === "same-origin" || site === "none";
}

/** The `application/x-www-form-urlencoded` body, or `null` when it is missing or too large. */
async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(type)) return null;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) return null;
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_FORM_BYTES) return null;
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

function base64Utf8(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The `Authorization` value for a login form: `Bearer <token>`, or `Basic` with the login and
 * password, which accepts both the password half of a token and a whole pasted token.
 */
export function loginAuthorization(form: URLSearchParams): string | null {
  if (form.get("mode") === "password") {
    const login = (form.get("login") ?? "").trim();
    const password = (form.get("password") ?? "").trim();
    if (login === "" || password === "") return null;
    return `Basic ${base64Utf8(`${login}:${password}`)}`;
  }
  const token = (form.get("token") ?? "").trim();
  if (token === "") return null;
  // A header value must be bytes: a token with other characters (a non-ASCII admin password)
  // travels as Basic with its UTF-8 encoded in base64.
  return /^[\x21-\x7e]+$/.test(token) ? `Bearer ${token}` : `Basic ${base64Utf8(token)}`;
}

/**
 * The variables shown (read-only) on the settings page, with the value the Worker uses while
 * one is unset (`PUBLIC_URL`: the origin of the request).
 */
function settingsVars(r: PanelRequest): Setting[] {
  const defaults = {
    ECOSYSTEMS: ECOS.join(","),
    MAX_UPLOAD_BYTES: String(DEFAULT_MAX_UPLOAD_BYTES),
    TOKEN_PREFIX: DEFAULT_TOKEN_PREFIX,
    LOGIN_TOKEN_EXTENDED_TTL_HOURS: String(DEFAULT_LOGIN_TOKEN_EXTENDED_TTL_HOURS),
    MAX_PUBLISH_SCOPES: String(DEFAULT_MAX_PUBLISH_SCOPES),
    CHECK_UPDATES: String(DEFAULT_CHECK_UPDATES),
    APPEND_WINDOW_HOURS: String(DEFAULT_APPEND_WINDOW_HOURS),
    R2_BUCKET_NAME: DEFAULT_BUCKET_NAME,
    PUBLIC_URL: new URL(r.request.url).origin,
  } as const;
  return Object.entries(defaults).map(([name, fallback]) => ({
    name,
    value: r.env[name as keyof typeof defaults] ?? "",
    default: fallback,
  }));
}

async function adminSettings(r: PanelRequest): Promise<AdminSettings> {
  const settings: AdminSettings = {
    version: VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    setup: setupStatus(r.env),
    vars: settingsVars(r),
  };
  if (updatesEnabled(r.env)) {
    settings.update = await checkLatestRelease(
      r.env,
      r.fetch,
      r.now,
      caches.default,
      r.url.searchParams.get("check-updates") === "1",
    );
  }
  return settings;
}

/** The page context of a signed-in identity; an admin also learns whether a newer release exists. */
async function signedInContext(r: PanelRequest, identity: Identity): Promise<PageContext> {
  const ctx: PageContext = {
    ...r.ctx,
    user: { project: identity.project, roles: identity.roles },
  };
  if (hasRole(identity, "admin")) {
    const release = await releaseForHeader(r.env, r.fetch, r.now, r.waitUntil);
    if (release !== null && updateStatus(release.tag) === "available") {
      ctx.update = { tag: release.tag };
    }
  }
  return ctx;
}

async function renderHome(r: PanelRequest, identity: Identity): Promise<Response> {
  const ctx = await signedInContext(r, identity);
  if (hasRole(identity, "admin")) {
    // `/?tab=<section>` was the admin view before it had pages of its own.
    const tab = r.url.searchParams.get("tab");
    const section = ADMIN_SECTIONS.find((s) => s.id === tab) ?? ADMIN_SECTIONS[0];
    return redirect(section?.href ?? "/admin/packages");
  }
  if (hasRole(identity, "read")) {
    return htmlResponse(consumerPage(ctx, await listPackageSummaries(r.env, identity)));
  }
  return htmlResponse(publishPage(ctx));
}

/**
 * The first-run page: the setup checklist above the "create admin" form, or only the
 * checklist while `SESSION_SECRET` is missing, because nobody could sign in afterwards.
 */
function firstRunView(
  r: PanelRequest,
  options: { error?: string; project?: string; totp?: boolean } = {},
): string {
  const setup = setupStatus(r.env);
  if (sessionsMissing(setup)) return setupPage(r.ctx, setup);
  return firstRunPage(r.ctx, { ...options, setup });
}

function sessionsMissing(setup: ReturnType<typeof setupStatus>): boolean {
  return missingRequired(setup).some((item) => item.name === "SESSION_SECRET");
}

const home: PanelHandler = async (r) => {
  const session = await sessionIdentity(r.request, r.env, { now: () => r.now.getTime() });
  if (session !== null) return renderHome(r, session.identity);
  // A stale cookie (session ended, expired or credential gone) is cleared.
  const stale = sessionValueFrom(r.request) !== null;
  const headers: Record<string, string> = stale ? { "set-cookie": clearSessionCookie() } : {};
  if (!(await hasAnyCredential(r.env))) return htmlResponse(firstRunView(r), 200, headers);
  return htmlResponse(loginPage(r.ctx), 200, headers);
};

/** The identity of the request's panel session, or `null` without a valid one. */
async function sessionOf(r: PanelRequest): Promise<Identity | null> {
  const session = await sessionIdentity(r.request, r.env, { now: () => r.now.getTime() });
  return session?.identity ?? null;
}

function notFoundPage(ctx: PageContext): Response {
  return htmlResponse(
    messagePage(ctx, "Not found", "This package or version does not exist, or you may not see it."),
    404,
  );
}

/**
 * Runs a package route for a signed-in `read` or `admin` identity: without a session the
 * browser goes to the login page, a `publish` credential gets its notice with `403`.
 */
function packageRoute(
  handler: (r: PanelRequest, identity: Identity, ctx: PageContext) => Promise<Response>,
): PanelHandler {
  return async (r) => {
    const identity = await sessionOf(r);
    if (identity === null) return redirect("/");
    const ctx = await signedInContext(r, identity);
    if (!hasRole(identity, "read", "admin")) return htmlResponse(publishPage(ctx), 403);
    return handler(r, identity, ctx);
  };
}

const packageView = packageRoute(async (r, identity, ctx) => {
  const { eco = "", name = "" } = r.params;
  const visible = await visiblePackage(r.env, identity, eco, name);
  if (visible === null) return notFoundPage(ctx);
  const login = `${tokenPrefix(r.env)}${identity.project}`;
  const base = publicUrl(r.env, r.request);
  const snippets = placeholderSnippets(visible.adapter, base, login, [visible.view.name]);
  return htmlResponse(
    packagePage(ctx, {
      view: visible.view,
      snippets,
      transitive: visible.transitive,
      ...visible.details,
      admin: hasRole(identity, "admin"),
    }),
  );
});

const versionView = packageRoute(async (r, identity, ctx) => {
  const { eco = "", name = "", version = "" } = r.params;
  const base = publicUrl(r.env, r.request);
  const data = await visibleVersion(r.env, identity, eco, name, version, base);
  return data === null ? notFoundPage(ctx) : htmlResponse(versionPage(ctx, data));
});

const download = packageRoute(async (r, identity, ctx) => {
  const { eco = "", name = "", version = "", file = "" } = r.params;
  const url = await downloadUrl(r.env, identity, eco, name, version, file, r.now);
  if (url === null) return notFoundPage(ctx);
  return new Response(null, {
    status: 302,
    headers: { location: url, "cache-control": "private, no-store" },
  });
});

// ---------------------------------------------------------------------------------------------
// Admin pages
// ---------------------------------------------------------------------------------------------

/**
 * Runs an admin route: without a session the browser goes to the login page, a `publish`
 * credential gets its notice and a `read` credential a notice, both with `403`.
 */
function adminRoute(
  handler: (r: PanelRequest, identity: Identity, ctx: PageContext) => Promise<Response>,
): PanelHandler {
  return async (r) => {
    const identity = await sessionOf(r);
    if (identity === null) return redirect("/");
    const ctx = await signedInContext(r, identity);
    if (identity.record.roles.every((role) => role === "publish")) {
      return htmlResponse(publishPage(ctx), 403);
    }
    if (!hasRole(identity, "admin")) {
      const text = "This page is only for admin credentials.";
      return htmlResponse(messagePage(ctx, "Forbidden", text), 403);
    }
    return handler(r, identity, ctx);
  };
}

const adminPackages = adminRoute(async (r, identity, ctx) =>
  htmlResponse(adminPackagesPage(ctx, await listPackageSummaries(r.env, identity))),
);

const acceptBucketPost = adminRoute(async (r) => {
  await acceptBucket(r.env);
  return redirect("/admin/packages");
});

const adminCredentials = adminRoute(async (r, _identity, ctx) =>
  htmlResponse(credentialsPage(ctx, (await listCredentialViews(r.env)).credentials, r.now)),
);

const newCredential = adminRoute(async (r, _identity, ctx) =>
  htmlResponse(newCredentialPage(ctx, { ecosystems: enabledEcosystems(r.env) })),
);

/** The login of a project's tokens. */
function loginOf(env: Env, project: string): string {
  return `${tokenPrefix(env)}${project}`;
}

/** `POST /admin/credentials/new`: the page with the first secret, or the form again. */
const createCredentialPost = adminRoute(async (r, _identity, ctx) => {
  const form = (await readForm(r.request)) ?? new URLSearchParams();
  const { body, values, password, repeat } = credentialForm(form);
  const ecosystems = enabledEcosystems(r.env);
  const again = (error: string, status: number) =>
    htmlResponse(newCredentialPage(ctx, { ecosystems, error, values }), status);
  const problem = passwordProblem(password, repeat);
  if (problem !== null) return again(problem, 400);
  let created: Awaited<ReturnType<typeof createCredential>>;
  try {
    created = await createCredential(r.env, body, r.now);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    return again(err.message, err.status);
  }
  const { project, roles } = created.credential;
  const kind = roles.join(" + ");
  const next = { href: credentialHref(project), label: "Continue to the credential" };
  if (created.login !== undefined) {
    return htmlResponse(
      loginSecretPage(ctx, {
        title: "Credential created",
        text: markup`The ${kind} credential <strong>${project}</strong> has been created. Sign in as <code>${project}</code> with this password.`,
        project,
        password: created.login.password,
        ...totpOf(created.login),
        next,
      }),
    );
  }
  if (created.token === undefined) return redirect(`${credentialHref(project)}?tab=secrets`);
  return htmlResponse(
    tokenPage(ctx, {
      title: "Credential created",
      text: markup`The ${kind} credential <strong>${project}</strong> has been created.`,
      token: created.token,
      next,
    }),
  );
});

/** The `totp` field of {@link loginSecretPage} for a created `login` secret, if it has one. */
function totpOf(login: { totp?: { secret: string; otpauth_uri: string } }) {
  return login.totp === undefined
    ? {}
    : { totp: { secret: login.totp.secret, otpauthUri: login.totp.otpauth_uri } };
}

/** The values of the "add a secret" form that edit the `gh` entry `entry`. */
function editValues(entry: CredentialView["auth"][number]): SecretFormValues | null {
  if (entry.type !== "gh") return null;
  return {
    type: "gh",
    // The copy keeps the roles of the secret it replaces.
    scope: KINDS.filter((role) => entry.scope.includes(role)),
    totp: false,
    description: entry.description ?? "",
    replaces: entry.id,
    expire_old: true,
    repository: entry.repository,
    repository_id: entry.repository_id ?? "",
    repository_owner_id: entry.repository_owner_id ?? "",
    ref: entry.ref ?? "",
    workflow: entry.workflow ?? "",
    environment: entry.environment ?? "",
    pin_on_first_use: entry.pin_on_first_use !== false,
    expires: entry.expires === null ? "" : entry.expires.slice(0, 10),
  };
}

/**
 * The page of one credential: the tab named by `?tab=` (`?add=1` opens the "add a secret"
 * form), or the secrets tab with a refused "add a secret" form.
 */
async function renderCredential(
  r: PanelRequest,
  ctx: PageContext,
  project: string,
  refused?: { error: string; values: SecretFormValues; status: number },
  scopeRefused?: { id: string; scope: Kind[]; error: string; status: number },
): Promise<Response> {
  let credential;
  try {
    credential = await readCredentialView(r.env, project);
  } catch (err) {
    if (err instanceof ValidationError && err.code === "not_found") {
      return htmlResponse(messagePage(ctx, "Not found", "This credential does not exist."), 404);
    }
    throw err;
  }
  // `?edit=<id>` fills the "add a secret" form with that `gh` secret (docs/api.md 6.17).
  const editId = r.url.searchParams.get("edit") ?? "";
  const editing =
    refused !== undefined || editId === ""
      ? null
      : credential.auth.find((e) => e.id === editId || e.id.startsWith(editId));
  const edit = editing === null || editing === undefined ? null : editValues(editing);
  // Any other secret of a credential with both roles has its roles changed in place.
  let editScope: ScopeEdit | undefined;
  if (scopeRefused !== undefined) {
    editScope = { id: scopeRefused.id, scope: scopeRefused.scope, error: scopeRefused.error };
  } else if (
    editing !== null &&
    editing !== undefined &&
    edit === null &&
    credential.roles.length > 1
  ) {
    editScope = {
      id: editing.id,
      scope: KINDS.filter((role) => editing.scope.includes(role)),
    };
  }
  const page = credentialPage(ctx, {
    credential,
    ecosystems: enabledEcosystems(r.env),
    now: r.now,
    login: loginOf(r.env, project),
    tab:
      edit === null && editScope === undefined
        ? credentialTab(r.url.searchParams.get("tab"))
        : "secrets",
    addSecret: r.url.searchParams.get("add") === "1" || edit !== null,
    secretError: refused?.error,
    secretValues: refused?.values ?? edit ?? undefined,
    editScope,
  });
  return htmlResponse(page, refused?.status ?? scopeRefused?.status ?? 200);
}

const credentialView = adminRoute(async (r, _identity, ctx) =>
  renderCredential(r, ctx, r.params.project ?? ""),
);

/**
 * `POST /admin/credentials/<project>/secrets`: a `key` secret answers with the token page, a
 * `login` secret with the password page, a `gh` secret goes back to the credential; an error
 * shows the credential with the form again.
 */
const addSecretPost = adminRoute(async (r, _identity, ctx) => {
  const project = r.params.project ?? "";
  const form = (await readForm(r.request)) ?? new URLSearchParams();
  const { body, values, password, repeat } = secretForm(form);
  const problem = passwordProblem(password, repeat);
  if (problem !== null) {
    return renderCredential(r, ctx, project, { error: problem, values, status: 400 });
  }
  let added: Awaited<ReturnType<typeof addSecret>>;
  try {
    added = await addSecret(r.env, project, body, r.now);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    // A credential that is gone is answered with its `404` page.
    if (err.code === "not_found" && err.message === "Credential not found.") {
      return renderCredential(r, ctx, project);
    }
    return renderCredential(r, ctx, project, { error: err.message, values, status: err.status });
  }
  const next = { href: `${credentialHref(project)}?tab=secrets`, label: "Back to the credential" };
  if (added.login !== undefined) {
    return htmlResponse(
      loginSecretPage(ctx, {
        title: "Login added",
        text: markup`A new login (<code>${added.secret.id}</code>) has been added to <strong>${project}</strong>. Sign in as <code>${project}</code> with this password.`,
        project,
        password: added.login.password,
        ...totpOf(added.login),
        next,
      }),
    );
  }
  if (added.token === undefined) return redirect(`${credentialHref(project)}?tab=secrets`);
  return htmlResponse(
    tokenPage(ctx, {
      title: "Secret added",
      text: markup`A new key secret (<code>${added.secret.id}</code>) has been added to <strong>${project}</strong>.`,
      token: added.token,
      next,
    }),
  );
});

/**
 * `POST /admin/credentials/<project>/secrets/<id>`: changes the roles of a secret in place and
 * goes back to the secrets tab; an error shows the form again.
 */
const updateSecretPost = adminRoute(async (r, _identity, ctx) => {
  const project = r.params.project ?? "";
  const id = r.params.id ?? "";
  const form = (await readForm(r.request)) ?? new URLSearchParams();
  const scope = formScope(form);
  try {
    await updateSecret(r.env, project, id, { scope }, r.now);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    if (err.code === "not_found" && err.message === "Credential not found.") {
      return renderCredential(r, ctx, project);
    }
    return renderCredential(r, ctx, project, undefined, {
      id,
      scope,
      error: err.message,
      status: err.status,
    });
  }
  return redirect(`${credentialHref(project)}?tab=secrets`);
});

const adminSettingsView = adminRoute(async (r, _identity, ctx) =>
  htmlResponse(settingsPage(ctx, await adminSettings(r))),
);

/** The login page again after a failed sign-in. */
function loginFailed(
  r: PanelRequest,
  mode: LoginMode,
  form: URLSearchParams,
  error: string,
): Response {
  const page = loginPage(r.ctx, {
    error,
    mode,
    login: mode === "password" ? (form.get("login") ?? "").trim() : undefined,
  });
  return htmlResponse(page, 401, { "www-authenticate": WWW_AUTHENTICATE });
}

/** A session cookie for `project`, or the page that says sessions are not configured. */
async function startSession(
  r: PanelRequest,
  project: string,
  login?: { entry: string; totpAt?: number },
  extra: string[] = [],
): Promise<Response> {
  let value: string;
  try {
    value = await createSession(r.env, project, { now: () => r.now.getTime() }, login);
  } catch (err) {
    // SESSION_SECRET is missing: the message names the setting, never a secret.
    if (!(err instanceof ValidationError)) throw err;
    return htmlResponse(messagePage(r.ctx, "Sessions are not configured", err.message), 500);
  }
  return redirectWithCookies("/", [sessionCookie(value), ...extra]);
}

/**
 * Whether a secret opens the panel of its credential: a secret limited to `publish` does not
 * open one that can also read or administer (a credential that only publishes gets the publish
 * notice).
 */
function opensPanel(record: CredentialRecord, entry: Pick<AuthRecordEntry, "scope">): boolean {
  if (!record.roles.some((role) => role !== "publish")) return true;
  return effectiveRoles(record, entry).some((role) => role !== "publish");
}

/**
 * The login and password of a `login` secret (docs/api.md 2.6): a session straight away, or
 * a pending sign-in and the one-time code page. `null` when the project has no `login`
 * secret, so that an admin password stored as a `key` (older installations) still works.
 */
async function loginSecretSignIn(r: PanelRequest, form: URLSearchParams): Promise<Response | null> {
  const project = (form.get("login") ?? "").trim();
  const password = (form.get("password") ?? "").trim();
  const now = r.now.getTime();
  const record = project === "" ? null : await getCredential(r.env, project, { now });
  if (record !== null && activeLogins(record, now).length === 0) return null;
  const result =
    password === ""
      ? ({ ok: false } as const)
      : await checkPassword(r.env, { project, password }, now, { allowAdmin: true });
  if (!result.ok || !opensPanel(result.record, result.entry)) {
    return loginFailed(r, "password", form, LOGIN_PASSWORD_FAILED);
  }
  if (!result.needsCode) {
    return startSession(r, result.record.project, { entry: result.entryId });
  }
  const value = await createPending(
    r.env,
    { project: result.record.project, entry: result.entryId, context: PANEL_CONTEXT },
    { now: () => now },
  );
  return redirect("/login/code", { "set-cookie": pendingCookie(value, "/login") });
}

const LOGIN_PASSWORD_FAILED = "The login or the password is not valid.";
const CODE_FAILED = "The one-time code is not valid.";
/** The context of a pending sign-in that belongs to the panel login (not to `/authorize`). */
const PANEL_CONTEXT = "panel";

const login: PanelHandler = async (r) => {
  const form = (await readForm(r.request)) ?? new URLSearchParams();
  const mode: LoginMode = form.get("mode") === "token" ? "token" : "password";
  if (mode === "password") {
    const handled = await loginSecretSignIn(r, form);
    if (handled !== null) return handled;
  }
  const authorization = loginAuthorization(form);
  let auth: Authentication | null = null;
  // The same words for an unknown login, a wrong password and a login without a login secret.
  let error = mode === "password" ? LOGIN_PASSWORD_FAILED : LOGIN_FAILED;
  try {
    auth =
      authorization === null
        ? null
        : await authenticate(new Request(r.url, { headers: { authorization } }), r.env, {
            now: () => r.now.getTime(),
            fetch: r.fetch,
            kindHint: "read",
          });
  } catch (err) {
    // A `_` login that matches several credentials says how to name the project.
    if (!(err instanceof ValidationError) || err.code !== "unauthorized") throw err;
    error = err.message;
  }
  // A secret limited to `publish` does not open the panel of a credential that can also read.
  if (
    auth !== null &&
    auth.identity.record.roles.includes("read") &&
    !hasRole(auth.identity, "read")
  ) {
    auth = null;
  }
  if (auth === null) return loginFailed(r, mode, form, error);
  return startSession(r, auth.identity.record.project);
};

/** The pending sign-in of the panel login, with its credential and `login` entry. */
async function panelPending(r: PanelRequest) {
  const pending = await readPending(r.request, r.env, { now: () => r.now.getTime() });
  if (pending === null || pending.context !== PANEL_CONTEXT) return null;
  const record = await getCredential(r.env, pending.project, { now: r.now.getTime() });
  if (record === null) return null;
  const entry = await findLogin(record, pending.entry, r.now.getTime());
  return entry === null ? null : { pending, record, entry };
}

const loginCodeGet: PanelHandler = async (r) => {
  const found = await panelPending(r);
  if (found === null) return redirect("/", { "set-cookie": clearPendingCookie("/login") });
  return htmlResponse(loginCodePage(r.ctx, { project: found.pending.project }));
};

const loginCodePost: PanelHandler = async (r) => {
  const found = await panelPending(r);
  if (found === null) return redirect("/", { "set-cookie": clearPendingCookie("/login") });
  const form = (await readForm(r.request)) ?? new URLSearchParams();
  const now = r.now.getTime();
  const ok = await verifyEntryTotp(r.env, found.record, found.entry, form.get("code") ?? "", now);
  if (!ok) {
    const page = loginCodePage(r.ctx, { project: found.pending.project, error: CODE_FAILED });
    return htmlResponse(page, 401);
  }
  return startSession(r, found.pending.project, { entry: found.pending.entry, totpAt: now }, [
    clearPendingCookie("/login"),
  ]);
};

/** Sessions live only in the signed cookie, so logging out just clears it. */
const logout: PanelHandler = async () => redirect("/", { "set-cookie": clearSessionCookie() });

/** Why the optional password of the first-run form is refused, or `null` when it is fine. */
export function passwordProblem(password: string, repeat: string): string | null {
  if (password === "" && repeat === "") return null;
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `The password must have at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return password === repeat ? null : "The passwords do not match.";
}

const firstRun: PanelHandler = async (r) => {
  const done = () =>
    htmlResponse(
      messagePage(r.ctx, "Already set up", "The registry has already been set up."),
      403,
    );
  if (await hasAnyCredential(r.env)) return done();
  // An admin created now could not sign in: the page shows what is missing instead.
  if (sessionsMissing(setupStatus(r.env)))
    return htmlResponse(setupPage(r.ctx, setupStatus(r.env)), 409);
  const form = (await readForm(r.request)) ?? new URLSearchParams();
  const project = (form.get("project") ?? "").trim();
  const password = form.get("password") ?? "";
  const totp = form.has("totp");
  const problem = passwordProblem(password, form.get("password_repeat") ?? "");
  if (problem !== null) {
    return htmlResponse(firstRunView(r, { error: problem, project, totp }), 400);
  }
  try {
    const { login } = await createFirstAdmin(r.env, project, r.now, {
      ...(password === "" ? {} : { password }),
      totp,
    });
    return htmlResponse(
      loginSecretPage(r.ctx, {
        title: "Admin created",
        text: markup`The admin credential <strong>${project}</strong> has been created. Sign in as <code>${project}</code> with this password.`,
        project,
        password: login.password,
        ...totpOf(login),
        next: { href: "/", label: "Continue to sign in" },
      }),
    );
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    if (err.code === "invalid_request") {
      return htmlResponse(firstRunView(r, { error: err.message, project, totp }), 400);
    }
    return done();
  }
};

// ---------------------------------------------------------------------------------------------
// Browser login (docs/api.md 2.6)
// ---------------------------------------------------------------------------------------------

/** A page for a login request that is gone, expired or already decided. */
function authorizeGone(r: PanelRequest): Response {
  return htmlResponse(
    messagePage(
      r.ctx,
      "Login request not valid",
      "This login request has expired or was already handled. Run the command again.",
    ),
    410,
  );
}

/** The login request of the route and the browser's login session, if any. */
interface AuthorizeState {
  id: string;
  session: LoginSession;
  /** Set when the browser has a session started with a `login` secret that is still active. */
  web?: {
    identity: Identity;
    entryId: string;
    entry: NonNullable<Awaited<ReturnType<typeof findLogin>>>;
    totpAt: number | undefined;
  };
}

async function authorizeState(r: PanelRequest): Promise<AuthorizeState | Response> {
  const id = r.params.id ?? "";
  const session = await readLoginSession(r.env, id, r.now);
  if (session === null || (await readDecision(r.env, session.nonce)) !== null) {
    return authorizeGone(r);
  }
  const state: AuthorizeState = { id, session };
  const web = await sessionIdentity(r.request, r.env, { now: () => r.now.getTime() });
  if (web !== null && web.session.entry !== undefined) {
    const entry = await findLogin(web.identity.record, web.session.entry, r.now.getTime());
    if (entry !== null) {
      state.web = {
        identity: web.identity,
        entryId: web.session.entry,
        entry,
        totpAt: web.session.totpAt,
      };
    }
  }
  return state;
}

/** The pending sign-in (password right, one-time code to come) of this login request. */
async function authorizePending(r: PanelRequest, state: AuthorizeState) {
  const pending = await readPending(r.request, r.env, { now: () => r.now.getTime() });
  if (pending === null || pending.context !== state.session.nonce) return null;
  const record = await getCredential(r.env, pending.project, { now: r.now.getTime() });
  if (record === null) return null;
  const entry = await findLogin(record, pending.entry, r.now.getTime());
  if (entry === null || !effectiveRoles(record, entry).some((role) => role !== "admin"))
    return null;
  return { pending, record, entry };
}

const authorizePendingPath = "/authorize/";

async function authorizeView(
  r: PanelRequest,
  state: AuthorizeState,
  error?: string,
  status = 200,
): Promise<Response> {
  const { id, session, web } = state;
  if (web === undefined) {
    const checks = (session.scopes ?? []).map((scope) => ({ scope, allowed: true }));
    const pending = await authorizePending(r, state);
    if (pending !== null) {
      const page = authorizeCodePage(r.ctx, id, session, checks, {
        error,
        project: pending.pending.project,
      });
      return htmlResponse(page, status);
    }
    return htmlResponse(authorizeSignInPage(r.ctx, id, session, checks, { error }), status);
  }
  const record = web.identity.record;
  const checks = checkScopes(r.env, record, session.scopes ?? []);
  const problem = approvalProblem(r.env, session, record, web.entry) ?? undefined;
  const needsCode = needsFreshTotp(session, web.entry, web.totpAt, r.now.getTime());
  const extended = session.purpose === "pull" && session.eco !== "generic";
  return htmlResponse(
    authorizeApprovePage(r.ctx, {
      id,
      session,
      checks,
      project: record.project,
      problem,
      needsCode,
      extendedHours: extended ? loginTokenExtendedTtlHours(r.env) : undefined,
      error,
    }),
    status,
  );
}

const authorizeGet: PanelHandler = async (r) => {
  const state = await authorizeState(r);
  return state instanceof Response ? state : authorizeView(r, state);
};

/** Step 1 of signing in on the approval page: the project and its password. */
const authorizeLogin: PanelHandler = async (r) => {
  const state = await authorizeState(r);
  if (state instanceof Response) return state;
  const form = (await readForm(r.request)) ?? new URLSearchParams();
  const project = (form.get("project") ?? "").trim();
  const password = form.get("password") ?? "";
  const now = r.now.getTime();
  const result = await checkPassword(r.env, { project, password }, now);
  if (!result.ok) {
    const checks = (state.session.scopes ?? []).map((scope) => ({ scope, allowed: true }));
    return htmlResponse(
      authorizeSignInPage(r.ctx, state.id, state.session, checks, {
        error: LOGIN_PASSWORD_FAILED,
        project,
      }),
      401,
    );
  }
  const back = `/authorize/${state.id}`;
  if (result.needsCode) {
    const value = await createPending(
      r.env,
      {
        project: result.record.project,
        entry: result.entryId,
        context: state.session.nonce,
      },
      { now: () => now },
    );
    return redirect(back, { "set-cookie": pendingCookie(value, authorizePendingPath) });
  }
  let value: string;
  try {
    value = await createSession(
      r.env,
      result.record.project,
      { now: () => now },
      {
        entry: result.entryId,
      },
    );
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    return htmlResponse(messagePage(r.ctx, "Sessions are not configured", err.message), 500);
  }
  return redirect(back, { "set-cookie": sessionCookie(value) });
};

/** Step 2 of signing in on the approval page: the one-time code. */
const authorizeCode: PanelHandler = async (r) => {
  const state = await authorizeState(r);
  if (state instanceof Response) return state;
  const back = `/authorize/${state.id}`;
  const found = await authorizePending(r, state);
  if (found === null)
    return redirect(back, { "set-cookie": clearPendingCookie(authorizePendingPath) });
  const form = (await readForm(r.request)) ?? new URLSearchParams();
  const now = r.now.getTime();
  const ok = await verifyEntryTotp(r.env, found.record, found.entry, form.get("code") ?? "", now);
  if (!ok) return authorizeView(r, state, CODE_FAILED, 401);
  const value = await createSession(
    r.env,
    found.pending.project,
    { now: () => now },
    {
      entry: found.pending.entry,
      totpAt: now,
    },
  );
  return redirectWithCookies(back, [
    sessionCookie(value),
    clearPendingCookie(authorizePendingPath),
  ]);
};

const authorizeSwitch: PanelHandler = async (r) =>
  redirectWithCookies(`/authorize/${r.params.id ?? ""}`, [
    clearSessionCookie(),
    clearPendingCookie(authorizePendingPath),
  ]);

const authorizeTotp: PanelHandler = async (r) => {
  const state = await authorizeState(r);
  if (state instanceof Response) return state;
  if (state.web === undefined) return redirect(`/authorize/${state.id}`);
  const form = (await readForm(r.request)) ?? new URLSearchParams();
  const now = r.now.getTime();
  const ok = await verifyEntryTotp(
    r.env,
    state.web.identity.record,
    state.web.entry,
    form.get("code") ?? "",
    now,
  );
  if (!ok) return authorizeView(r, state, CODE_FAILED, 401);
  const value = await createSession(
    r.env,
    state.web.identity.record.project,
    { now: () => now },
    {
      entry: state.web.entryId,
      totpAt: now,
    },
  );
  return redirect(`/authorize/${state.id}`, { "set-cookie": sessionCookie(value) });
};

function authorizeDecision(approve: boolean): PanelHandler {
  return async (r) => {
    const state = await authorizeState(r);
    if (state instanceof Response) return state;
    const { web } = state;
    if (web === undefined) return redirect(`/authorize/${state.id}`);
    const now = r.now.getTime();
    if (approve && needsFreshTotp(state.session, web.entry, web.totpAt, now)) {
      return authorizeView(r, state, "Verify a one-time code first.", 403);
    }
    const form = (await readForm(r.request)) ?? new URLSearchParams();
    const extended =
      state.session.purpose === "pull" &&
      state.session.eco !== "generic" &&
      form.get("extended") === "1";
    const done = await decideLoginSession(
      r.env,
      state.session,
      web.identity.record,
      web.entryId,
      approve,
      r.now,
      { extended },
    );
    if (!done) {
      const problem = approvalProblem(r.env, state.session, web.identity.record, web.entry);
      return authorizeView(r, state, problem ?? "This request was already handled.", 403);
    }
    return htmlResponse(authorizeDonePage(r.ctx, approve));
  };
}

const authorizeApprove = authorizeDecision(true);
const authorizeDeny = authorizeDecision(false);

/** Form posts checked by `sameOrigin`. */
const POSTS = new Set<PanelHandler>([
  acceptBucketPost,
  login,
  logout,
  firstRun,
  createCredentialPost,
  addSecretPost,
  updateSecretPost,
  loginCodePost,
  authorizeLogin,
  authorizeCode,
  authorizeSwitch,
  authorizeTotp,
  authorizeApprove,
  authorizeDeny,
]);

const routes = new Router<PanelHandler>()
  .add("GET", "/", home)
  .add("POST", "/login", login)
  .add("GET", "/login/code", loginCodeGet)
  .add("POST", "/login/code", loginCodePost)
  .add("POST", "/admin/bucket/accept", acceptBucketPost)
  .add("POST", "/logout", logout)
  .add("POST", "/first-run", firstRun)
  .add("GET", "/packages/:eco/:name", packageView)
  .add("GET", "/packages/:eco/:name/:version", versionView)
  .add("GET", "/packages/:eco/:name/:version/files/:file", download)
  .add("GET", "/admin/packages", adminPackages)
  .add("GET", "/admin/credentials", adminCredentials)
  // Before `:project`, which would match `new` too (see `credentialHref`).
  .add("GET", "/admin/credentials/new", newCredential)
  .add("POST", "/admin/credentials/new", createCredentialPost)
  .add("GET", "/admin/credentials/:project", credentialView)
  .add("POST", "/admin/credentials/:project/secrets", addSecretPost)
  .add("POST", "/admin/credentials/:project/secrets/:id", updateSecretPost)
  .add("GET", "/admin/settings", adminSettingsView)
  .add("GET", "/authorize/:id", authorizeGet)
  .add("POST", "/authorize/:id/login", authorizeLogin)
  .add("POST", "/authorize/:id/code", authorizeCode)
  .add("POST", "/authorize/:id/switch", authorizeSwitch)
  .add("POST", "/authorize/:id/totp", authorizeTotp)
  .add("POST", "/authorize/:id/approve", authorizeApprove)
  .add("POST", "/authorize/:id/deny", authorizeDeny);

/**
 * Answers a panel route, or returns `null` when the path is not one (static assets and the
 * JSON `404` take over). `HEAD` is answered like `GET` without a body.
 */
export async function handlePanel(
  request: Request,
  env: Env,
  url: URL,
  deps: PanelDeps = {},
): Promise<Response | null> {
  const head = request.method === "HEAD";
  const match = routes.match(head ? "GET" : request.method, url.pathname);
  if (match === null) return null;
  const ctx: PageContext = { host: new URL(publicUrl(env, request)).host, version: VERSION };
  try {
    const problem = await bucketProblem(env);
    if (problem !== null) ctx.bucketProblem = problem;
  } catch {
    // The banner is a courtesy; the page itself decides what a failing bucket means for it.
  }
  if (POSTS.has(match.value) && !sameOrigin(request, env)) {
    return htmlResponse(messagePage(ctx, "Forbidden", "Cross-site form posts are refused."), 403);
  }
  let response: Response;
  try {
    response = await match.value({
      request,
      env,
      url,
      now: deps.now?.() ?? new Date(),
      // The global `fetch` must not be called as a method of another object.
      fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
      waitUntil: deps.waitUntil,
      ctx,
      params: match.params,
    });
  } catch (err) {
    console.error("Unhandled panel error:", err instanceof Error ? err.message : String(err));
    response = htmlResponse(
      messagePage(ctx, "Something went wrong", "The page could not be shown; try again later."),
      500,
    );
  }
  return head
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}
