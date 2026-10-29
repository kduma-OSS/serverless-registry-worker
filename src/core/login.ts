/**
 * Browser login (docs/api.md 2.6 and 6.20–6.21): the CLI asks for a login session, the user
 * signs in with a `login` secret on `/authorize/<session>` and approves one operation, and the
 * CLI collects a short-lived signed token.
 *
 * The session itself is a signed value, so creating it writes nothing (anonymous requests
 * cannot use up KV writes). Only an approval or a refusal is stored, at `login-session:<nonce>`
 * with a TTL, and the poll that collects it deletes it.
 */

import { getAdapter } from "../adapters/index";
import { ECOS, type Eco } from "../adapters/types";
import type { Env } from "../env";
import {
  activeLogins,
  authEntryId,
  effectiveRoles,
  emptyGrants,
  getCredential,
  issueLoginToken,
  timingSafeEqual,
  verifyLoginPassword,
  writeCredential,
  type AdminOp,
  type AuthRecordEntry,
  type CredentialRecord,
  type Kind,
  type LoginAuthRecord,
  type PublishScope,
} from "./auth";
import { mayModify } from "./modify";
import { loginTokenExtendedTtlHours, maxPublishScopes } from "./config";
import { ValidationError } from "./errors";
import { isAllowed } from "./grants";
import { keyedDigest, signPayload, verifyPayload } from "./signing";
import { decryptTotpSecret, verifyTotp } from "./totp";

/** Lifetime of a login session: the time to sign in and approve. */
export const LOGIN_SESSION_TTL = 10 * 60;
/** Seconds the CLI waits between polls. */
export const POLL_INTERVAL = 2;
/** Validity of a pull token approved without "extended validity". */
export const PULL_TOKEN_TTL = 60 * 60;
/** Validity of a publish token. */
export const PUBLISH_TOKEN_TTL = 15 * 60;
/** Validity of a yank or delete (admin) token. */
export const ADMIN_TOKEN_TTL = 15 * 60;
/** How long a one-time code verification stays good for approving a publish, yank or delete. */
export const TOTP_FRESH_SECONDS = 15 * 60;

/**
 * Longest approval link (`<PUBLIC_URL>/authorize/<id>`) a session may produce. The id is the
 * signed session, scopes included, so the link grows with every version a publish login names;
 * past this size `cmd /C start` (8191 characters) and long-URL limits of proxies get in the way.
 */
export const MAX_AUTHORIZE_URL_LENGTH = 8000;

const SESSION_TYP = "ls";
const POLL_LABEL = "sreg-login-poll-v1";
const KV_PREFIX = "login-session:";

export type LoginEnv = Pick<
  Env,
  | "AUTH"
  | "SESSION_SECRET"
  | "TOKEN_PREFIX"
  | "ECOSYSTEMS"
  | "PUBLIC_URL"
  | "LOGIN_TOKEN_EXTENDED_TTL_HOURS"
  | "MAX_PUBLISH_SCOPES"
>;

/** The purposes that ask for an admin token limited to named operations. */
export type AdminPurpose = "yank" | "delete";

/** Whether a purpose is a yank or a delete. */
export function isAdminPurpose(purpose: LoginSession["purpose"]): purpose is AdminPurpose {
  return purpose === "yank" || purpose === "delete";
}

/** What a login session asks for. */
export interface LoginSession {
  purpose: "pull" | "publish" | AdminPurpose;
  /** For a pull: the ecosystem the token is for, when the client names one. */
  eco?: Eco;
  /** For a publish: the operations to approve. */
  scopes?: PublishScope[];
  /** For a yank or delete: the operations to approve. */
  ops?: AdminOp[];
  nonce: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

function invalid(message: string): never {
  throw new ValidationError("invalid_request", message);
}

/** A package version, or (`version` absent) a whole package, named by a yank or delete login. */
interface Target {
  eco: Eco;
  package: string;
  version?: string;
}

function parseScopes(
  env: Pick<Env, "ECOSYSTEMS" | "MAX_PUBLISH_SCOPES">,
  value: unknown,
): PublishScope[] {
  return parseTargets(env, value, "publish") as PublishScope[];
}

/**
 * Validates the `scopes` of a login. A publish and a yank name an exact `version` in every
 * scope; a delete may leave it out (or send `null`) for the whole package.
 */
function parseTargets(
  env: Pick<Env, "ECOSYSTEMS" | "MAX_PUBLISH_SCOPES">,
  value: unknown,
  purpose: "publish" | AdminPurpose,
): Target[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalid("`scopes` must list the operations to approve.");
  }
  const max = maxPublishScopes(env);
  if (value.length > max) invalid(`\`scopes\` may name at most ${max} operations.`);
  const scopes: Target[] = [];
  const whole = purpose === "delete";
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      invalid("Each scope must be an object.");
    }
    const { eco, package: name, version } = item as Record<string, unknown>;
    const wholePackage = whole && (version === undefined || version === null);
    if (
      typeof eco !== "string" ||
      typeof name !== "string" ||
      (typeof version !== "string" && !wholePackage)
    ) {
      invalid(
        whole
          ? "Each scope needs `eco` and `package` strings and a `version` string or null."
          : "Each scope needs `eco`, `package` and `version` strings.",
      );
    }
    const adapter = getAdapter(env, eco);
    if (adapter === null) invalid(`The ${eco} ecosystem is not enabled in this registry.`);
    if (name === "" || name.length > 214 || /\s/.test(name))
      invalid("A scope `package` is invalid.");
    if (typeof version === "string" && !adapter.validateVersion(version))
      invalid(`A scope \`version\` is not a valid ${eco} version.`);
    const scope: Target = {
      eco: adapter.eco,
      package: adapter.storedName?.(name) ?? name,
      ...(typeof version === "string"
        ? { version: adapter.storedVersion?.(version) ?? version }
        : {}),
    };
    const duplicate = scopes.some(
      (s) => s.eco === scope.eco && s.package === scope.package && s.version === scope.version,
    );
    if (!duplicate) scopes.push(scope);
  }
  return scopes;
}

/** The poll token that belongs to a session id (only the CLI that created it knows it). */
async function pollTokenFor(env: LoginEnv, id: string): Promise<string> {
  const digest = await keyedDigest(env, POLL_LABEL, id);
  if (digest === null) {
    throw new ValidationError(
      "internal_error",
      "Login is not configured: set SESSION_SECRET in the Worker settings.",
    );
  }
  return digest;
}

/** The response of `POST /api/v1/auth/sessions`. */
export interface CreatedLoginSession {
  /** Opaque id, passed back to {@link pollLoginSession}. */
  session: string;
  /** Where the user signs in and approves. */
  url: string;
  poll_token: string;
  /** Seconds between polls. */
  interval: number;
  expires_at: string;
}

/**
 * `POST /api/v1/auth/sessions`: validates what is asked for and returns a signed session id,
 * the page to open and the poll token. Writes nothing.
 */
export async function createLoginSession(
  env: LoginEnv,
  body: Record<string, unknown>,
  publicUrl: string,
  now: Date,
): Promise<CreatedLoginSession> {
  const { purpose, eco, scopes } = body;
  const payload: Record<string, unknown> = {};
  if (purpose === "pull") {
    if (scopes !== undefined) invalid("`scopes` does not apply to a pull login.");
    if (eco !== undefined) {
      if (typeof eco !== "string" || !(ECOS as readonly string[]).includes(eco)) {
        invalid("`eco` must be an ecosystem.");
      }
      payload.eco = eco;
    }
  } else if (purpose === "publish") {
    if (eco !== undefined) invalid("`eco` only applies to a pull login.");
    payload.scopes = parseScopes(env, scopes);
  } else if (purpose === "yank" || purpose === "delete") {
    if (eco !== undefined) invalid("`eco` only applies to a pull login.");
    payload.ops = parseTargets(env, scopes, purpose).map((target): AdminOp => ({
      op: purpose,
      ...target,
    }));
  } else {
    invalid("`purpose` must be `pull`, `publish`, `yank` or `delete`.");
  }
  const exp = Math.floor(now.getTime() / 1000) + LOGIN_SESSION_TTL;
  const nonce = crypto.randomUUID();
  const id = await signPayload(env, SESSION_TYP, { ...payload, purpose, nonce, exp });
  if (id === null) {
    throw new ValidationError(
      "internal_error",
      "Login is not configured: set SESSION_SECRET in the Worker settings.",
    );
  }
  const url = `${publicUrl}/authorize/${id}`;
  if (url.length > MAX_AUTHORIZE_URL_LENGTH) {
    invalid(
      `The approval link would be ${url.length} characters long (at most ${MAX_AUTHORIZE_URL_LENGTH}): name fewer versions, or approve them in several logins.`,
    );
  }
  return {
    session: id,
    url,
    poll_token: await pollTokenFor(env, id),
    interval: POLL_INTERVAL,
    expires_at: new Date(exp * 1000).toISOString(),
  };
}

/** The session behind an id, or `null` when it is not valid or has expired. */
export async function readLoginSession(
  env: LoginEnv,
  id: string,
  now: Date,
): Promise<LoginSession | null> {
  const payload = await verifyPayload(env, SESSION_TYP, id);
  if (payload === null) return null;
  const { purpose, nonce, exp, eco, scopes, ops } = payload;
  if (
    (purpose !== "pull" && purpose !== "publish" && purpose !== "yank" && purpose !== "delete") ||
    typeof nonce !== "string"
  ) {
    return null;
  }
  if (typeof exp !== "number" || exp * 1000 <= now.getTime()) return null;
  const session: LoginSession = { purpose, nonce, exp };
  if (purpose === "pull" && typeof eco === "string") session.eco = eco as Eco;
  if (purpose === "publish") {
    if (!Array.isArray(scopes)) return null;
    session.scopes = scopes as PublishScope[];
  }
  if (purpose === "yank" || purpose === "delete") {
    if (!Array.isArray(ops)) return null;
    session.ops = ops as AdminOp[];
  }
  return session;
}

/** What the CLI receives once the session was approved. */
export interface IssuedLoginToken {
  token: string;
  expires_at: string;
  project: string;
  kind: Kind;
}

type Decision = { state: "approved"; issued: IssuedLoginToken } | { state: "denied" };

/** The stored decision of a session, or `null` while there is none. */
export async function readDecision(
  env: Pick<Env, "AUTH">,
  nonce: string,
): Promise<Decision | null> {
  const text = await env.AUTH.get(KV_PREFIX + nonce, "text");
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Decision;
    return value.state === "approved" || value.state === "denied" ? value : null;
  } catch {
    return null;
  }
}

async function writeDecision(
  env: Pick<Env, "AUTH">,
  session: LoginSession,
  decision: Decision,
  now: Date,
): Promise<void> {
  const remaining = session.exp - Math.floor(now.getTime() / 1000);
  // KV needs a TTL of at least 60 seconds.
  const expirationTtl = Math.max(60, remaining);
  await env.AUTH.put(KV_PREFIX + session.nonce, JSON.stringify(decision), { expirationTtl });
}

/** One operation of a publish login with whether the credential's grants allow it. */
export interface ScopeCheck {
  scope: PublishScope;
  allowed: boolean;
}

/** Checks each operation of a publish login against the grants of a credential. */
export function checkScopes(
  env: Pick<Env, "ECOSYSTEMS">,
  record: CredentialRecord,
  scopes: readonly PublishScope[],
): ScopeCheck[] {
  return scopes.map((scope) => {
    const adapter = getAdapter(env, scope.eco);
    const allowed =
      adapter !== null &&
      isAllowed(record.grants.publish, scope.eco, scope.package, scope.version, adapter.satisfies);
    return { scope, allowed };
  });
}

/** Why a credential cannot approve a session, or `null` when it can. */
export function approvalProblem(
  env: Pick<Env, "ECOSYSTEMS">,
  session: LoginSession,
  record: CredentialRecord,
  entry?: Pick<AuthRecordEntry, "scope">,
): string | null {
  // A pull login carries the `read` role and a publish login the `publish` role: the credential
  // must hold it and, when the `login` secret has a scope, the scope must include it. A yank or
  // delete login is approved by an `admin` credential, or by one that holds the `yank` or
  // `delete` role and whose grants of that role cover every operation.
  if (isAdminPurpose(session.purpose)) return adminApprovalProblem(env, session, record, entry);
  const role: Kind = session.purpose === "pull" ? "read" : "publish";
  const verb = role === "read" ? "download" : "publish";
  if (!record.roles.includes(role)) {
    return `This login cannot ${verb}: it belongs to a credential that is not a ${role} credential.`;
  }
  if (entry !== undefined && !effectiveRoles(record, entry).includes(role)) {
    return `This login cannot ${verb}: its scope does not include the ${role} role.`;
  }
  if (session.purpose === "pull") return null;
  const denied = checkScopes(env, record, session.scopes ?? []).filter((c) => !c.allowed);
  return denied.length === 0
    ? null
    : "This credential's grants do not allow every operation listed above.";
}

function adminApprovalProblem(
  env: Pick<Env, "ECOSYSTEMS">,
  session: LoginSession,
  record: CredentialRecord,
  entry?: Pick<AuthRecordEntry, "scope">,
): string | null {
  const purpose = session.purpose as AdminPurpose;
  if (!record.roles.includes("admin") && !record.roles.includes(purpose)) {
    return `This login cannot ${purpose}: it belongs to a credential that has neither the admin nor the ${purpose} role.`;
  }
  const roles = entry === undefined ? record.roles : effectiveRoles(record, entry);
  if (!roles.includes("admin") && !roles.includes(purpose)) {
    return `This login cannot ${purpose}: its scope includes neither the admin nor the ${purpose} role.`;
  }
  const denied = (session.ops ?? []).some((op) => !mayModify(env, roles, record.grants, op));
  return denied ? "This credential's grants do not allow every operation listed above." : null;
}

/** Options of {@link decideLoginSession}. */
export interface DecisionOptions {
  /** Pull only: approve with the extended validity. */
  extended?: boolean;
}

/**
 * Approves a session for the `login` entry `entryId` of `record`, issues the token and stores
 * it for the poll, or stores a refusal. Returns `false` when the session was already decided or
 * the credential may not approve it (the caller shows `approvalProblem`).
 */
export async function decideLoginSession(
  env: LoginEnv,
  session: LoginSession,
  record: CredentialRecord,
  entryId: string,
  approve: boolean,
  now: Date,
  options: DecisionOptions = {},
): Promise<boolean> {
  if ((await readDecision(env, session.nonce)) !== null) return false;
  if (!approve) {
    await writeDecision(env, session, { state: "denied" }, now);
    return true;
  }
  const entry = await findLogin(record, entryId, now.getTime());
  if (entry === null || approvalProblem(env, session, record, entry) !== null) return false;
  let seconds = isAdminPurpose(session.purpose) ? ADMIN_TOKEN_TTL : PUBLISH_TOKEN_TTL;
  if (session.purpose === "pull") {
    seconds = options.extended === true ? loginTokenExtendedTtlHours(env) * 3600 : PULL_TOKEN_TTL;
  }
  const expiresAt = now.getTime() + seconds * 1000;
  const token = await issueLoginToken(
    env,
    record.project,
    entryId,
    expiresAt,
    session.purpose === "publish" ? session.scopes : undefined,
    isAdminPurpose(session.purpose) ? session.ops : undefined,
  );
  const issued: IssuedLoginToken = {
    token,
    expires_at: new Date(Math.floor(expiresAt / 1000) * 1000).toISOString(),
    project: record.project,
    kind:
      session.purpose === "pull"
        ? "read"
        : session.purpose === "publish"
          ? "publish"
          : effectiveRoles(record, entry).includes("admin")
            ? "admin"
            : session.purpose,
  };
  await writeDecision(env, session, { state: "approved", issued }, now);
  return true;
}

/** The result of one poll. */
export type PollResult = { status: "pending" } | { status: "approved"; issued: IssuedLoginToken };

/**
 * `POST /api/v1/auth/sessions/poll`: checks the poll token and returns the stored decision.
 * An approval is returned once and deleted. A refusal is `403 forbidden`; a session that is
 * unknown or has expired is `404 not_found`.
 */
export async function pollLoginSession(
  env: LoginEnv,
  body: Record<string, unknown>,
  now: Date,
): Promise<PollResult> {
  const { session: id, poll_token: pollToken } = body;
  if (typeof id !== "string" || typeof pollToken !== "string") {
    invalid("`session` and `poll_token` are required.");
  }
  if (!timingSafeEqual(await pollTokenFor(env, id), pollToken)) {
    throw new ValidationError("unauthorized", "The poll token is not valid.");
  }
  const session = await readLoginSession(env, id, now);
  const decision = session === null ? null : await readDecision(env, session.nonce);
  if (session === null && decision === null) {
    throw new ValidationError("not_found", "The login session has expired.");
  }
  if (session === null || decision === null) return { status: "pending" };
  await env.AUTH.delete(KV_PREFIX + session.nonce);
  if (decision.state === "denied") {
    throw new ValidationError("forbidden", "The login was refused.");
  }
  return { status: "approved", issued: decision.issued };
}

// ---------------------------------------------------------------------------------------------
// Signing in on the authorize page
// ---------------------------------------------------------------------------------------------

/** A hash that no password matches, verified for unknown projects so that time does not tell. */
const DUMMY_HASH =
  "pbkdf2-sha256$10000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/** Stores the accepted step of a `login` entry (a code is never accepted twice). */
async function recordTotpStep(
  env: Pick<Env, "AUTH">,
  project: string,
  entryId: string,
  step: number,
  now: number,
): Promise<boolean> {
  const fresh = await getCredential(env, project, { fresh: true, now });
  if (fresh === null) return false;
  const ids = await Promise.all(fresh.auth.map(authEntryId));
  const index = ids.indexOf(entryId);
  const current = fresh.auth[index];
  if (current === undefined || current.type !== "login" || current.totp === undefined) {
    return false;
  }
  // Two sign-ins in the same step race on this read-modify-write; the later one is refused.
  if (current.totp.last_step >= step) return false;
  const updated: LoginAuthRecord = { ...current, totp: { ...current.totp, last_step: step } };
  const next = { ...fresh, auth: fresh.auth.map((e, i) => (i === index ? updated : e)) };
  await writeCredential(env, fresh, next);
  return true;
}

/**
 * Verifies a one-time code for a `login` entry and records its step. `false` when the entry has
 * no TOTP, the code is wrong or it was already used.
 */
export async function verifyEntryTotp(
  env: LoginEnv,
  record: CredentialRecord,
  entry: LoginAuthRecord,
  code: string,
  now: number,
): Promise<boolean> {
  if (entry.totp === undefined) return false;
  const secret = await decryptTotpSecret(env, entry.totp.secret);
  if (secret === null) return false;
  const step = await verifyTotp(secret, code, now, entry.totp.last_step);
  if (step === null) return false;
  return recordTotpStep(env, record.project, await authEntryId(entry), step, now);
}

/** The first step of a sign-in: the password of a project. */
export type PasswordResult =
  | {
      ok: true;
      record: CredentialRecord;
      entry: LoginAuthRecord;
      entryId: string;
      /** The entry has a one-time code: the second step is still to come. */
      needsCode: boolean;
    }
  | { ok: false };

/** Options of {@link checkPassword}. */
export interface PasswordOptions {
  /**
   * Let a `login` that only has the `admin` role sign in (the panel does, and so does the
   * approval page of a yank or delete; the approval page of a pull or publish does not,
   * because that login token carries `read` or `publish`).
   */
  allowAdmin?: boolean;
}

/**
 * Checks the password of a project against its active `login` entries. It never says which of
 * project and password was wrong, and spends the same time for a project that does not exist.
 * A one-time code, when the entry has one, is the second step: {@link verifyEntryTotp}.
 */
export async function checkPassword(
  env: LoginEnv,
  input: { project: string; password: string },
  now: number,
  options: PasswordOptions = {},
): Promise<PasswordResult> {
  const record = await getCredential(env, input.project, { now });
  if (record === null) {
    // Spend the same time as for a real project.
    await verifyLoginPassword(
      { project: "", roles: ["read"], grants: emptyGrants(), auth: [dummyLogin()] },
      input.password,
      now,
    );
    return { ok: false };
  }
  const entry = await verifyLoginPassword(record, input.password, now);
  if (entry === null) return { ok: false };
  const roles = effectiveRoles(record, entry);
  // A pull or publish login token carries `read` or `publish`: a login with neither (an `admin`,
  // `yank` or `delete` only login) signs in on those pages no more than it issues such a token.
  if (options.allowAdmin !== true && !roles.some((role) => role === "read" || role === "publish")) {
    return { ok: false };
  }
  return {
    ok: true,
    record,
    entry,
    entryId: await authEntryId(entry),
    needsCode: entry.totp !== undefined,
  };
}

function dummyLogin(): LoginAuthRecord {
  return { type: "login", password: DUMMY_HASH, created: "2000-01-01T00:00:00Z", expires: null };
}

/** The `login` entry of a record with this id, if it is still active. */
export async function findLogin(
  record: CredentialRecord,
  entryId: string,
  now: number,
): Promise<LoginAuthRecord | null> {
  for (const login of activeLogins(record, now)) {
    if ((await authEntryId(login)) === entryId) return login;
  }
  return null;
}

/**
 * Whether approving needs a fresh one-time code: a publish, yank or delete login with TOTP
 * verified too long ago.
 */
export function needsFreshTotp(
  session: LoginSession,
  entry: LoginAuthRecord,
  totpAt: number | undefined,
  now: number,
): boolean {
  if (session.purpose === "pull" || entry.totp === undefined) return false;
  return totpAt === undefined || now / 1000 - totpAt > TOTP_FRESH_SECONDS;
}

/**
 * Whether a token's `ops` approve `op` on a package version (`version` given) or on a whole
 * package (`version` absent). The names are compared in their stored form (docs/api.md 1.3);
 * an ecosystem that is not enabled or a version the ecosystem cannot have never matches. A
 * whole-package `delete` does not approve deleting one version, nor the other way round.
 */
export function opsAllow(
  env: Pick<Env, "ECOSYSTEMS">,
  ops: readonly AdminOp[],
  op: AdminOp["op"],
  eco: string,
  rawName: string,
  rawVersion?: string,
): boolean {
  const adapter = getAdapter(env, eco);
  if (adapter === null) return false;
  const name = adapter.storedName?.(rawName) ?? rawName;
  let version: string | undefined;
  if (rawVersion !== undefined) {
    if (rawVersion.includes("/") || !adapter.validateVersion(rawVersion)) return false;
    version = adapter.storedVersion?.(rawVersion) ?? rawVersion;
  }
  return ops.some(
    (o) => o.op === op && o.eco === adapter.eco && o.package === name && o.version === version,
  );
}
