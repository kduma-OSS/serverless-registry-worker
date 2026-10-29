/**
 * Credentials: token parsing, `Authorization` header normalisation, credential records in KV,
 * secret verification (`key`, GitHub OIDC `gh` and the signed login tokens `st` issued after a
 * `login` secret was used) and panel sessions. See "Credentials" in docs/spec.md and section 2
 * of docs/api.md.
 */

import type { Eco } from "../adapters/types";
import type { Env } from "../env";
import { tokenPrefix } from "./config";
import { ValidationError } from "./errors";
import { ghRepoCandidates, syncGhRepoIndex } from "./ghindex";
import { IsolateCache } from "./isolatecache";
import { normalizeGrant, type Grant } from "./grants";
import { base64UrlDecode, signPayload, verifyPayload } from "./signing";

/** Secret types a token can carry. `st` is a signed login token (see {@link issueLoginToken}). */
export type SecretType = "key" | "gh" | "st";

const SECRET_TYPES: readonly string[] = ["key", "gh", "st"];

/** A local project or source slug. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** A generated `key` secret: 32 base62 characters. */
const KEY_SECRET_RE = /^[A-Za-z0-9]{32}$/;

/** Longest `key` secret accepted by the parser (an admin password is at most 128 characters). */
const MAX_KEY_SECRET_LENGTH = 512;

/** A compact JWS: three base64url segments. */
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** A signed login token secret: `<base64url payload>.<base64url HMAC-SHA256>`. */
const ST_SECRET_RE = /^[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{43}$/;

/** A token split into its parts. Nothing but `secret` is secret. */
export interface ParsedToken {
  /** External credential provider, `null` for credentials stored in KV. */
  source: string | null;
  /** A project slug, or `_` when the project is resolved from a `gh` JWT. */
  project: string;
  type: SecretType;
  secret: string;
  /** `[<source>.]<project>`, the left side of the token's colon. */
  login: string;
}

/** Whether a string is a valid project (or source) slug. */
export function isSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

function stripPrefix(value: string, prefix: string): string {
  return prefix !== "" && value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/**
 * Parses `[<TOKEN_PREFIX>][<source>.]<project>:[<type>.]<secret>` (docs/api.md 2.1). The
 * prefix is optional even when configured. The reserved login `_` is accepted alone and only
 * with type `gh`. Returns `null` for anything malformed.
 */
export function parseToken(token: string, prefix = ""): ParsedToken | null {
  const value = stripPrefix(token, prefix);
  const colon = value.indexOf(":");
  if (colon === -1) return null;
  const login = value.slice(0, colon);
  const password = value.slice(colon + 1);

  const segments = login.split(".");
  let source: string | null = null;
  let project: string;
  if (segments.length === 1) {
    project = segments[0] ?? "";
  } else if (segments.length === 2) {
    source = segments[0] ?? "";
    project = segments[1] ?? "";
    if (!isSlug(source)) return null;
  } else {
    return null;
  }
  // The reserved login `_` stands alone and only with a `gh` secret (docs/api.md 2.5).
  const resolved = source === null && project === "_";
  if (!resolved && !isSlug(project)) return null;

  // `<type>.<secret>` only when the part before the first `.` names a secret type; otherwise
  // the whole password is a `key` secret (an admin password may contain dots).
  const dot = password.indexOf(".");
  const typed = dot !== -1 && SECRET_TYPES.includes(password.slice(0, dot));
  const type = typed ? password.slice(0, dot) : "key";
  const secret = typed ? password.slice(dot + 1) : password;
  if (resolved && type !== "gh") return null;
  if (type === "gh" && !JWT_RE.test(secret)) return null;
  if (type === "st" && !ST_SECRET_RE.test(secret)) return null;
  if (type === "key" && (secret === "" || secret.length > MAX_KEY_SECRET_LENGTH)) return null;

  return { source, project, type: type as SecretType, secret, login };
}

function decodeBase64Utf8(value: string): string | null {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Normalises an `Authorization` header to a token (docs/api.md 2.2):
 *
 * - `Bearer <token>`;
 * - `Basic base64(<token>)`, where the Basic login and password are the two sides of the
 *   token's colon;
 * - `Basic base64(<login>:<token>)`, where the password itself contains a colon and is the
 *   whole token; the Basic login must equal the token's login;
 * - `<token>` (raw, as cargo sends it).
 *
 * Scheme names are case-insensitive. Returns `null` when no valid token can be extracted.
 */
export function parseAuthorization(header: string | null, prefix = ""): ParsedToken | null {
  const value = header?.trim() ?? "";
  if (value === "") return null;

  const bearer = /^bearer\s+(\S+)$/i.exec(value);
  if (bearer) return parseToken(bearer[1] ?? "", prefix);

  const basic = /^basic\s+(\S+)$/i.exec(value);
  if (basic) {
    const decoded = decodeBase64Utf8(basic[1] ?? "");
    if (decoded === null) return null;
    const colon = decoded.indexOf(":");
    const password = colon === -1 ? "" : decoded.slice(colon + 1);
    if (!password.includes(":")) return parseToken(decoded, prefix);
    const parsed = parseToken(password, prefix);
    const login = stripPrefix(decoded.slice(0, colon), prefix);
    return parsed !== null && parsed.login === login ? parsed : null;
  }

  return parseToken(value, prefix);
}

// ---------------------------------------------------------------------------------------------
// Credential records in KV
// ---------------------------------------------------------------------------------------------

/**
 * A role of a credential. A credential holds one or more of them; each secret is limited to some
 * of them with its `scope` (docs/spec.md "Credentials").
 */
export type Kind = "read" | "publish" | "yank" | "delete" | "admin";

export const KINDS: readonly Kind[] = ["read", "publish", "yank", "delete", "admin"];

/** The roles a secret can be limited to: any role of its credential. */
export const SCOPE_ROLES: readonly Kind[] = KINDS;

/** The roles that carry their own list of grants (`admin` has none). */
export type GrantRole = "read" | "publish" | "yank" | "delete";

export const GRANT_ROLES: readonly GrantRole[] = ["read", "publish", "yank", "delete"];

/** The grants of a credential, one list per role (always `[]` for a role it does not hold). */
export interface RoleGrants {
  read: Grant[];
  publish: Grant[];
  yank: Grant[];
  delete: Grant[];
}

/** Grants lists of a credential that holds no grants at all. */
export function emptyGrants(): RoleGrants {
  return { read: [], publish: [], yank: [], delete: [] };
}

/** A static secret, stored as its SHA-256. */
export interface KeyAuthRecord {
  type: "key";
  /**
   * The roles this secret may use; absent means every role of the credential. Always a subset of
   * the credential's roles once read ({@link effectiveRoles}).
   */
  scope?: Kind[];
  /**
   * `sha256:<64 hex>` of a generated secret, or `pbkdf2-sha256$<iterations>$<salt>$<hash>`
   * (base64) of a user-chosen password (admin credentials only).
   */
  hash: string;
  /** RFC 3339 (or `YYYY-MM-DD`). */
  created: string;
  /** RFC 3339 (or `YYYY-MM-DD`); `null` = never. */
  expires: string | null;
  /** A note for the people who manage the credential; editable, never part of the `id`. */
  description?: string;
}

/**
 * A login (docs/api.md 2.6): a password and, optionally, a TOTP shared secret. It is never sent
 * as a token; it is used on the browser login page, which then issues a signed `st` token.
 */
export interface LoginAuthRecord {
  type: "login";
  /** As {@link KeyAuthRecord.scope}. */
  scope?: Kind[];
  /** `pbkdf2-sha256$<iterations>$<salt>$<hash>` (base64). */
  password: string;
  /** Present when a one-time code is required besides the password. */
  totp?: {
    /** The base32 shared secret, AES-GCM encrypted (see `totp.ts`). */
    secret: string;
    /** The last time step accepted; a code of this step or an earlier one is refused. */
    last_step: number;
  };
  /** RFC 3339 (or `YYYY-MM-DD`). */
  created: string;
  /** RFC 3339 (or `YYYY-MM-DD`); `null` = never. */
  expires: string | null;
  /** A note for the people who manage the credential; editable, never part of the `id`. */
  description?: string;
}

/** A GitHub Actions OIDC identity. */
export interface GhAuthRecord {
  type: "gh";
  /** As {@link KeyAuthRecord.scope}. */
  scope?: Kind[];
  /** `owner/repo` (compared case-insensitively) or `owner/*`, against the `repository` claim. */
  repository: string;
  /** Glob over the `ref` claim, `*` matching any characters; `null` = any ref. */
  ref: string | null;
  /** Workflow file path, against the `workflow_ref` claim without `owner/repo/` and `@<ref>`. */
  workflow: string | null;
  /** The JWT `repository_id` claim (digits); `null` or absent = any. */
  repository_id?: string | null;
  /** The JWT `repository_owner_id` claim (digits); `null` or absent = any. */
  repository_owner_id?: string | null;
  /** The JWT `environment` claim; `null` or absent = any. */
  environment?: string | null;
  /**
   * Whether the first matching token fills in a missing `repository_id` (exact entries) and
   * `repository_owner_id` from its claims, so that a repository or owner re-created under the
   * same name no longer matches (docs/api.md 2.5). Absent means `true`.
   */
  pin_on_first_use?: boolean;
  created: string;
  expires: string | null;
  /** A note for the people who manage the credential; editable, never part of the `id`. */
  description?: string;
}

/** The optional fields of a `gh` entry besides `ref` and `workflow`, matched by equality. */
export const GH_EXTRA_FIELDS = ["repository_id", "repository_owner_id", "environment"] as const;

/** An auth entry as stored in KV. */
export type AuthRecordEntry = KeyAuthRecord | GhAuthRecord | LoginAuthRecord;

/** The record stored at `cred:<project>`. */
export interface CredentialRecord {
  project: string;
  /** A non-empty subset of `["read", "publish", "admin"]`. */
  roles: Kind[];
  auth: AuthRecordEntry[];
  /** A role the credential does not hold has no grants; `admin` has none of its own. */
  grants: RoleGrants;
}

/** An auth entry as the API exposes it: the hash is replaced by `id` (docs/api.md 6.1). */
export type AuthEntry = (
  | Omit<KeyAuthRecord, "hash" | "description" | "scope">
  | Omit<GhAuthRecord, "description" | "scope">
  | Omit<LoginAuthRecord, "password" | "totp" | "description" | "scope">
) & {
  id: string;
  /** The roles this secret may use (a subset of the credential's roles). */
  scope: Kind[];
  totp?: boolean;
  description?: string | null;
};

/** A credential as the API exposes it (docs/api.md 5). */
export interface Credential {
  project: string;
  /** Deprecated: `read` when the credential holds it, else its only other role. */
  kind: Kind;
  roles: Kind[];
  auth: AuthEntry[];
  /** Deprecated: the grants of `kind`. */
  grants: Grant[];
  read_grants: Grant[];
  publish_grants: Grant[];
  yank_grants: Grant[];
  delete_grants: Grant[];
}

/**
 * The role the legacy `kind` field reports for a set of roles: `admin` first, then `read`,
 * `publish`, `yank` and `delete`.
 */
export function primaryKind(roles: readonly Kind[]): Kind {
  if (roles.includes("admin")) return "admin";
  if (roles.includes("read")) return "read";
  if (roles.includes("publish")) return "publish";
  return roles.includes("yank") ? "yank" : "delete";
}

/** The grants the legacy flat `grants` field reports for a set of roles. */
export function legacyGrants(roles: readonly Kind[], grants: RoleGrants): Grant[] {
  const kind = primaryKind(roles);
  return kind === "admin" ? [] : grants[kind];
}

/** The grants of a role the credential holds, `[]` otherwise. */
export function grantsFor(roles: readonly Kind[], grants: RoleGrants, role: GrantRole): Grant[] {
  return roles.includes(role) ? grants[role] : [];
}

/** The roles a secret may use: its `scope` (default: all) within the credential's roles. */
export function effectiveRoles(
  record: { roles: readonly Kind[] },
  entry: Pick<AuthRecordEntry, "scope">,
): Kind[] {
  const scope = entry.scope ?? record.roles;
  return record.roles.filter((role) => scope.includes(role));
}

const CRED_PREFIX = "cred:";

const SHA256_PREFIX = "sha256:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `roles` is a non-empty duplicate-free list of roles. */
export function isRoleSet(roles: unknown): roles is Kind[] {
  return (
    Array.isArray(roles) &&
    roles.length > 0 &&
    new Set(roles).size === roles.length &&
    roles.every((r) => (KINDS as readonly unknown[]).includes(r))
  );
}

function isStoredRecord(value: unknown): value is Record<string, unknown> & {
  project: string;
  auth: Record<string, unknown>[];
} {
  return (
    isRecord(value) &&
    typeof value.project === "string" &&
    Array.isArray(value.auth) &&
    value.auth.every(
      (e) => isRecord(e) && (e.type === "key" || e.type === "gh" || e.type === "login"),
    )
  );
}

/**
 * A stored value as a record of the current shape. Records written before roles existed
 * (`kind` and one flat `grants` list) read as `roles: [kind]` with the list under that role;
 * `null` when the value is neither shape.
 */
function upgradeRecord(value: unknown): CredentialRecord | null {
  if (!isStoredRecord(value)) return null;
  const { project, auth } = value;
  const entries = auth as unknown as AuthRecordEntry[];
  if (isRoleSet(value.roles) && isRecord(value.grants) && !Array.isArray(value.grants)) {
    const { read, publish, yank = [], delete: del = [] } = value.grants;
    if (
      !Array.isArray(read) ||
      !Array.isArray(publish) ||
      !Array.isArray(yank) ||
      !Array.isArray(del)
    ) {
      return null;
    }
    // Records written before the `yank` and `delete` roles have no such lists: they read as `[]`.
    return {
      project,
      roles: value.roles,
      auth: entries,
      grants: {
        read: read as Grant[],
        publish: publish as Grant[],
        yank: yank as Grant[],
        delete: del as Grant[],
      },
    };
  }
  const kind = value.kind;
  if (!(KINDS as readonly unknown[]).includes(kind) || !Array.isArray(value.grants)) return null;
  const grants = value.grants as Grant[];
  return {
    project,
    roles: [kind as Kind],
    auth: entries,
    grants: {
      read: kind === "read" ? grants : [],
      publish: kind === "publish" ? grants : [],
      yank: [],
      delete: [],
    },
  };
}

/**
 * Credential records read or written by this isolate, by project (`null`: no such record),
 * served for up to 60 seconds; see `isolatecache.ts`.
 */
const credentialCache = new IsolateCache<CredentialRecord | null>();

/** Forgets every credential record cached by this isolate (tests, migrations). */
export function clearCredentialCache(): void {
  credentialCache.clear();
}

/** A stored value as a credential record of `project`, grants normalised; else `null`. */
function toCredentialRecord(value: unknown, project: string): CredentialRecord | null {
  const record = upgradeRecord(value);
  if (record === null || record.project !== project) return null;
  // Records written before grants carried `transitive` read as `transitive: true`.
  const normalize = (list: Grant[]) => list.map((g) => (isRecord(g) ? normalizeGrant(g) : g));
  const grants = {
    read: normalize(record.grants.read),
    publish: normalize(record.grants.publish),
    yank: normalize(record.grants.yank),
    delete: normalize(record.grants.delete),
  };
  return { ...record, grants };
}

/** Options of {@link getCredential}. */
export interface GetCredentialOptions {
  /** Current time in ms since the epoch, for the cache's TTL. */
  now?: number;
  /** Skip the isolate cache (read-modify-write paths); the result is cached again. */
  fresh?: boolean;
}

/**
 * Reads `cred:<project>`; `null` when missing, not JSON or not a credential record. Served
 * from the isolate cache for up to 60 seconds unless `fresh`; every write through
 * {@link putCredential} or {@link deleteCredential} updates it.
 */
export async function getCredential(
  env: Pick<Env, "AUTH">,
  project: string,
  options: GetCredentialOptions = {},
): Promise<CredentialRecord | null> {
  const now = options.now ?? Date.now();
  const cached = options.fresh ? undefined : credentialCache.get(project, now);
  if (cached !== undefined) return cached;
  const text = await env.AUTH.get(CRED_PREFIX + project, "text");
  let record: CredentialRecord | null = null;
  if (text !== null) {
    try {
      record = toCredentialRecord(JSON.parse(text), project);
    } catch {
      record = null;
    }
  }
  credentialCache.set(project, record, now);
  return record;
}

/** Writes `cred:<project>` (no TTL) and caches it in this isolate. */
export async function putCredential(
  env: Pick<Env, "AUTH">,
  record: CredentialRecord,
): Promise<void> {
  const text = JSON.stringify(record);
  await env.AUTH.put(CRED_PREFIX + record.project, text);
  credentialCache.set(record.project, toCredentialRecord(JSON.parse(text), record.project));
}

/**
 * Stores a credential record and keeps the `gh-repo:` index in step with it (docs/api.md 2.5).
 * `previous` is the record before the write, `null` for a new credential. Every credential
 * write goes through here (admin edits, pinning on first use).
 */
export async function writeCredential(
  env: Pick<Env, "AUTH">,
  previous: CredentialRecord | null,
  next: CredentialRecord,
): Promise<void> {
  await putCredential(env, next);
  await syncGhRepoIndex(env, previous, next);
}

/** Deletes `cred:<project>`, also from this isolate's cache. */
export async function deleteCredential(env: Pick<Env, "AUTH">, project: string): Promise<void> {
  await env.AUTH.delete(CRED_PREFIX + project);
  credentialCache.set(project, null);
}

/** Every credential record in KV, sorted by project. */
export async function listCredentials(env: Pick<Env, "AUTH">): Promise<CredentialRecord[]> {
  const projects: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.AUTH.list({ prefix: CRED_PREFIX, cursor });
    for (const key of page.keys) projects.push(key.name.slice(CRED_PREFIX.length));
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  const records = await Promise.all(
    projects.map((project) => getCredential(env, project, { fresh: true })),
  );
  return records
    .filter((r): r is CredentialRecord => r !== null)
    .sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
}

/**
 * Whether an auth entry is active at `now` (ms since the epoch): `expires` is `null` or in the
 * future. An unparsable `expires` counts as expired.
 */
export function isActive(entry: AuthRecordEntry, now: number): boolean {
  if (entry.expires === null || entry.expires === undefined) return true;
  const expires = Date.parse(entry.expires);
  return !Number.isNaN(expires) && expires > now;
}

/**
 * The stable 12-hex `id` of an auth entry (docs/api.md 6.1):
 *
 * - `key`: the first 12 hex characters of the secret's SHA-256, i.e. of the digest stored in
 *   `hash` (`sha256:<hex>`); for a password (`pbkdf2-sha256$…`), of the SHA-256 of the stored
 *   string;
 * - `gh`: the first 12 hex characters of the SHA-256 of the JSON array
 *   `[repository, ref, workflow, created]`. `created` is included so that an entry re-added
 *   with the same claims never shares an id with an expired one still awaiting cleanup;
 * - `login`: the first 12 hex characters of the SHA-256 of the JSON array
 *   `["login", password hash, created]`.
 */
export async function authEntryId(entry: AuthRecordEntry): Promise<string> {
  if (entry.type === "key") {
    return entry.hash.startsWith(SHA256_PREFIX)
      ? entry.hash.slice(SHA256_PREFIX.length, SHA256_PREFIX.length + 12)
      : (await sha256Hex(entry.hash)).slice(0, 12);
  }
  if (entry.type === "login") {
    const material = JSON.stringify(["login", entry.password, entry.created]);
    return (await sha256Hex(material)).slice(0, 12);
  }
  const material = JSON.stringify([entry.repository, entry.ref, entry.workflow, entry.created]);
  return (await sha256Hex(material)).slice(0, 12);
}

/** The API view of a stored auth entry (without the secret hash). */
export async function toAuthEntry(
  entry: AuthRecordEntry,
  record: Pick<CredentialRecord, "roles">,
): Promise<AuthEntry> {
  const id = await authEntryId(entry);
  const scope = effectiveRoles(record, entry);
  if (entry.type === "key") {
    return {
      id,
      type: "key",
      scope,
      created: entry.created,
      expires: entry.expires ?? null,
      description: entry.description ?? null,
    };
  }
  if (entry.type === "login") {
    return {
      id,
      type: "login",
      scope,
      totp: entry.totp !== undefined,
      created: entry.created,
      expires: entry.expires ?? null,
      description: entry.description ?? null,
    };
  }
  return {
    id,
    type: "gh",
    scope,
    description: entry.description ?? null,
    repository: entry.repository,
    ref: entry.ref ?? null,
    workflow: entry.workflow ?? null,
    repository_id: entry.repository_id ?? null,
    repository_owner_id: entry.repository_owner_id ?? null,
    environment: entry.environment ?? null,
    pin_on_first_use: entry.pin_on_first_use !== false,
    created: entry.created,
    expires: entry.expires ?? null,
  };
}

/** The API view of a stored credential record. */
export async function toCredential(record: CredentialRecord): Promise<Credential> {
  return {
    project: record.project,
    kind: primaryKind(record.roles),
    roles: record.roles,
    auth: await Promise.all(record.auth.map((entry) => toAuthEntry(entry, record))),
    grants: legacyGrants(record.roles, record.grants),
    read_grants: grantsFor(record.roles, record.grants, "read"),
    publish_grants: grantsFor(record.roles, record.grants, "publish"),
    yank_grants: grantsFor(record.roles, record.grants, "yank"),
    delete_grants: grantsFor(record.roles, record.grants, "delete"),
  };
}

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Random base62 string from `crypto.getRandomValues`, without modulo bias. */
export function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      // 248 = 4 * 62: bytes above it are rejected so every character is equally likely.
      if (byte < 248 && out.length < length) out += BASE62[byte % 62];
    }
  }
  return out;
}

/** A new `key` secret: 32 base62 characters (~190 bits). */
export function generateSecret(): string {
  return randomBase62(32);
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Lower-case hex SHA-256 of a UTF-8 string. */
export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** The stored form of a `key` secret: `sha256:<hex>`. */
export async function hashSecret(secret: string): Promise<string> {
  return SHA256_PREFIX + (await sha256Hex(secret));
}

/** The token handed to the user once: `[<prefix>]<project>:<secret>`. */
export function formatToken(project: string, secret: string, prefix = ""): string {
  return `${prefix}${project}:${secret}`;
}

/**
 * Constant-time string equality. Uses the Workers-specific `crypto.subtle.timingSafeEqual`
 * when present and falls back to an XOR loop elsewhere. Only the length leaks, which is fixed
 * for the values compared here.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.byteLength !== y.byteLength) return false;
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: unknown };
  if (typeof subtle.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(x, y);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Prefix of a password hash: `pbkdf2-sha256$<iterations>$<salt base64>$<hash base64>`. */
export const PBKDF2_PREFIX = "pbkdf2-sha256$";

/**
 * PBKDF2-SHA256 iterations of new password hashes. Deriving a key costs about 0.5 ms of CPU per
 * 1 000 iterations in the Workers runtime (measured in the test pool: 10 000 ≈ 5 ms, 20 000 ≈
 * 10 ms), and the free plan allows 10 ms of CPU per request, so 10 000 leaves room for the
 * rest of the request. Verification uses the count stored with each hash, so it can be raised
 * later without invalidating existing passwords.
 */
export const PBKDF2_ITERATIONS = 10_000;

/** Highest iteration count accepted from a stored hash (bounds the CPU a record can cost). */
const PBKDF2_MAX_ITERATIONS = 1_000_000;

function toBase64(bytes: Uint8Array | ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function pbkdf2(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

/**
 * The stored form of a user-chosen password (admin credentials only):
 * `pbkdf2-sha256$<iterations>$<salt base64>$<hash base64>` with a random 16-byte salt.
 */
export async function hashPassword(
  password: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `${PBKDF2_PREFIX}${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** Whether a password matches a stored `pbkdf2-sha256$…` hash (constant-time comparison). */
export async function verifyPasswordHash(stored: string, password: string): Promise<boolean> {
  const [algorithm, rounds = "", saltPart = "", hashPart = "", ...rest] = stored.split("$");
  if (`${algorithm}$` !== PBKDF2_PREFIX || rest.length > 0 || !/^\d{1,7}$/.test(rounds)) {
    return false;
  }
  const iterations = Number(rounds);
  const salt = fromBase64(saltPart);
  if (iterations < 1 || iterations > PBKDF2_MAX_ITERATIONS || salt === null) return false;
  const derived = toBase64(await pbkdf2(password, salt, iterations));
  return timingSafeEqual(derived, hashPart);
}

/**
 * Verifies a `key` secret against every active `key` entry of a record. Generated secrets
 * (`sha256:<hex>`) are compared by digest, in constant time, and only when the secret has
 * their shape (32 base62 characters); passwords (`pbkdf2-sha256$…`) are derived again with
 * their stored salt and iteration count. Returns the matching entry.
 */
export async function verifyKey(
  record: CredentialRecord,
  secret: string,
  now: number,
): Promise<KeyAuthRecord | null> {
  const hash = KEY_SECRET_RE.test(secret) ? await hashSecret(secret) : null;
  let match: KeyAuthRecord | null = null;
  for (const entry of record.auth) {
    if (entry.type !== "key" || !isActive(entry, now)) continue;
    const ok = entry.hash.startsWith(PBKDF2_PREFIX)
      ? await verifyPasswordHash(entry.hash, secret)
      : hash !== null && timingSafeEqual(entry.hash, hash);
    if (ok && match === null) match = entry;
  }
  return match;
}

// ---------------------------------------------------------------------------------------------
// Logins and login tokens
// ---------------------------------------------------------------------------------------------

/** One operation a publish login token allows: an exact package version (docs/api.md 2.6). */
export interface PublishScope {
  eco: Eco;
  package: string;
  version: string;
}

/**
 * One operation an admin login token allows (docs/api.md 2.6): yanking an exact package
 * version, deleting one, or (`delete` without `version`) deleting a whole package.
 */
export interface AdminOp {
  op: "yank" | "delete";
  eco: Eco;
  package: string;
  /** Absent for a `delete` of the whole package. */
  version?: string;
}

/** `typ` of the signed payload of a login token. */
const LOGIN_TOKEN_TYP = "st";

/** The active `login` entries of a record. */
export function activeLogins(record: CredentialRecord, now: number): LoginAuthRecord[] {
  return record.auth.filter((e): e is LoginAuthRecord => e.type === "login" && isActive(e, now));
}

/**
 * Verifies a password against the active `login` entries of a record and returns the match.
 * Every active entry is derived again, so the time does not depend on which one matches.
 */
export async function verifyLoginPassword(
  record: CredentialRecord,
  password: string,
  now: number,
): Promise<LoginAuthRecord | null> {
  let match: LoginAuthRecord | null = null;
  for (const entry of activeLogins(record, now)) {
    if ((await verifyPasswordHash(entry.password, password)) && match === null) match = entry;
  }
  return match;
}

/**
 * A signed login token for the `login` entry `entryId` of `project`, valid until `expiresAt`
 * (ms since the epoch): `[<prefix>]<project>:st.<payload>.<signature>`. A publish token names
 * the operations it allows in `scopes`; a pull token has none; an admin token (yank, delete)
 * names them in `ops`. It is verified against the credential on every request
 * ({@link verifyLoginToken}), so ending the `login` entry ends the token.
 */
export async function issueLoginToken(
  env: SessionEnv & Pick<Env, "TOKEN_PREFIX">,
  project: string,
  entryId: string,
  expiresAt: number,
  scopes?: readonly PublishScope[],
  ops?: readonly AdminOp[],
): Promise<string> {
  const payload: Record<string, unknown> = {
    project,
    entry: entryId,
    exp: Math.floor(expiresAt / 1000),
  };
  if (scopes !== undefined) payload.scopes = scopes;
  if (ops !== undefined) payload.ops = ops;
  const signed = await signPayload(env, LOGIN_TOKEN_TYP, payload);
  if (signed === null) {
    throw new ValidationError(
      "internal_error",
      "Login tokens are not configured: set SESSION_SECRET in the Worker settings.",
    );
  }
  return formatToken(project, `${LOGIN_TOKEN_TYP}.${signed}`, tokenPrefix(env));
}

function toPublishScopes(value: unknown): PublishScope[] | null {
  // The count was checked against `MAX_PUBLISH_SCOPES` when the token was issued, and the
  // signature proves it, so lowering the setting does not end tokens that are already out.
  if (!Array.isArray(value) || value.length === 0) return null;
  const scopes: PublishScope[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { eco, package: name, version } = item;
    if (typeof eco !== "string" || typeof name !== "string" || typeof version !== "string") {
      return null;
    }
    scopes.push({ eco: eco as Eco, package: name, version });
  }
  return scopes;
}

function toAdminOps(value: unknown): AdminOp[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ops: AdminOp[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { op, eco, package: name, version } = item;
    if ((op !== "yank" && op !== "delete") || typeof eco !== "string" || typeof name !== "string") {
      return null;
    }
    if (version !== undefined && typeof version !== "string") return null;
    // Only a delete may name a whole package.
    if (op === "yank" && version === undefined) return null;
    ops.push({
      op,
      eco: eco as Eco,
      package: name,
      ...(version === undefined ? {} : { version }),
    });
  }
  return ops;
}

/**
 * Verifies the secret of an `st` token for a credential: signature and `typ`, the project, the
 * expiry, a role the credential holds, and a `login` entry that is still active whose scope
 * includes it. Returns the entry's id and, for a publish token, its scopes or, for an admin
 * token, its operations; `null` for anything else.
 */
export async function verifyLoginToken(
  env: SessionEnv,
  record: CredentialRecord,
  secret: string,
  now: number,
): Promise<{ entryId: string; roles: Kind[]; scopes?: PublishScope[]; ops?: AdminOp[] } | null> {
  const payload = await verifyPayload(env, LOGIN_TOKEN_TYP, secret);
  if (payload === null) return null;
  const { project, entry, exp, scopes, ops } = payload;
  if (project !== record.project || typeof entry !== "string") return null;
  if (typeof exp !== "number" || exp * 1000 <= now) return null;
  if (scopes !== undefined && ops !== undefined) return null;
  const parsedScopes = scopes === undefined ? undefined : toPublishScopes(scopes);
  if (parsedScopes === null) return null;
  const parsedOps = ops === undefined ? undefined : toAdminOps(ops);
  if (parsedOps === null) return null;
  // A publish token names its operations and carries the `publish` role, a pull token names
  // none and carries `read`. An admin token (yank, delete) names its operations and carries
  // `admin`, or, for a credential without it, the `yank` and/or `delete` roles its operations
  // need: the credential must hold the roles and the `login` secret's scope must include them.
  for (const login of activeLogins(record, now)) {
    if ((await authEntryId(login)) === entry) {
      const held = effectiveRoles(record, login);
      let roles: Kind[];
      if (parsedOps !== undefined) {
        roles = held.includes("admin") ? ["admin"] : [...new Set(parsedOps.map((o) => o.op))];
        if (!roles.every((role) => held.includes(role))) return null;
      } else {
        roles = [parsedScopes === undefined ? "read" : "publish"];
        if (!held.includes(roles[0] as Kind)) return null;
      }
      return {
        entryId: entry,
        roles,
        ...(parsedScopes === undefined ? {} : { scopes: parsedScopes }),
        ...(parsedOps === undefined ? {} : { ops: parsedOps }),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// GitHub Actions OIDC
// ---------------------------------------------------------------------------------------------

export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;

/**
 * Synthetic URL under which GitHub's JWKS is kept in the Cache API (`caches.default`); it is
 * never fetched. The cache is per data centre and needs no KV write.
 */
export const JWKS_CACHE_URL = "https://cache.internal/jwks/github";
/** Lifetime of the cached JWKS in seconds (`Cache-Control: max-age`). */
export const JWKS_TTL = 24 * 60 * 60;
/** Header of the cached JWKS response holding when it was fetched (ms since the epoch). */
export const JWKS_FETCHED_AT_HEADER = "x-jwks-fetched-at";
/** An unknown `kid` refetches the JWKS at most this often (key rotation). */
const JWKS_REFRESH_MS = 5 * 60 * 1000;
/** Allowed clock skew for `nbf`, in seconds. */
const CLOCK_SKEW = 60;

/** The part of the Cache API the JWKS cache uses. */
export type JwksCache = Pick<Cache, "match" | "put">;

/** Injectable I/O for tests. */
export interface AuthDeps {
  fetch?: typeof fetch;
  /** Current time in ms since the epoch. */
  now?: () => number;
  /** Where GitHub's JWKS is cached; `caches.default` when omitted. */
  cache?: JwksCache;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

interface CachedJwks {
  keys: Jwk[];
  fetchedAt: number;
}

/** The claims of a verified GitHub Actions OIDC token that the registry uses. */
export interface GithubClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  repository: string;
  /** Digits; GitHub sends a string, a number is normalised to one. */
  repository_id?: string;
  /** Digits; GitHub sends a string, a number is normalised to one. */
  repository_owner_id?: string;
  ref?: string;
  /** The workflow's display name (not used for matching). */
  workflow?: string;
  /** `owner/repo/<path of the workflow file>@<ref>`. */
  workflow_ref?: string;
  environment?: string;
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlDecode(segment);
  if (bytes === null) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function loadJwks(
  cache: JwksCache,
  fetcher: typeof fetch,
  now: number,
): Promise<CachedJwks | null> {
  let response: Response;
  try {
    response = await fetcher(GITHUB_JWKS_URL, { headers: { accept: "application/json" } });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!isRecord(body) || !Array.isArray(body.keys)) return null;
  const jwks: CachedJwks = {
    keys: body.keys.filter((k): k is Jwk => isRecord(k) && typeof k.kty === "string"),
    fetchedAt: now,
  };
  await cache.put(
    JWKS_CACHE_URL,
    new Response(JSON.stringify({ keys: jwks.keys }), {
      headers: {
        "content-type": "application/json",
        "cache-control": `max-age=${JWKS_TTL}`,
        [JWKS_FETCHED_AT_HEADER]: String(now),
      },
    }),
  );
  return jwks;
}

/** The cached JWKS, or `null` when it is missing, malformed or older than its lifetime. */
async function cachedJwks(cache: JwksCache, now: number): Promise<CachedJwks | null> {
  const response = await cache.match(JWKS_CACHE_URL);
  if (response === undefined) return null;
  const fetchedAt = Number(response.headers.get(JWKS_FETCHED_AT_HEADER));
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!Number.isFinite(fetchedAt) || now - fetchedAt > JWKS_TTL * 1000) return null;
  if (!isRecord(body) || !Array.isArray(body.keys)) return null;
  return { keys: body.keys.filter((k): k is Jwk => isRecord(k)), fetchedAt };
}

async function findSigningKey(
  cache: JwksCache,
  kid: string,
  fetcher: typeof fetch,
  now: number,
): Promise<Jwk | null> {
  let jwks = await cachedJwks(cache, now);
  const find = (set: CachedJwks | null) =>
    set?.keys.find((k) => k.kid === kid && k.kty === "RSA") ?? null;
  if (jwks === null || (find(jwks) === null && now - jwks.fetchedAt > JWKS_REFRESH_MS)) {
    jwks = await loadJwks(cache, fetcher, now);
  }
  return find(jwks);
}

/**
 * Verifies a GitHub Actions OIDC JWT: RS256 signature against GitHub's JWKS (cached in the
 * Cache API for 24 h), `iss`, `aud` = `PUBLIC_URL`, `exp` and `nbf`. Returns the claims or
 * `null`. Nothing about the token itself is cached: every request verifies its signature.
 */
export async function verifyGithubJwt(
  env: Pick<Env, "PUBLIC_URL">,
  jwt: string,
  deps: AuthDeps = {},
): Promise<GithubClaims | null> {
  const now = deps.now?.() ?? Date.now();
  const nowSec = Math.floor(now / 1000);
  const audience = env.PUBLIC_URL?.replace(/\/+$/, "");
  if (!audience) return null;

  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const [headerPart = "", payloadPart = "", signaturePart = ""] = parts;
  const header = decodeJsonSegment(headerPart);
  const claims = decodeJsonSegment(payloadPart);
  const signature = base64UrlDecode(signaturePart);
  if (header === null || claims === null || signature === null) return null;
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

  const { iss, aud, exp, nbf } = claims;
  if (iss !== GITHUB_ISSUER) return null;
  if (!(aud === audience || (Array.isArray(aud) && aud.includes(audience)))) return null;
  if (typeof exp !== "number" || exp <= nowSec) return null;
  if (nbf !== undefined && (typeof nbf !== "number" || nbf > nowSec + CLOCK_SKEW)) return null;
  const parsed = parseGithubClaims(claims);
  if (parsed === null) return null;

  const cache = deps.cache ?? caches.default;
  const jwk = await findSigningKey(cache, header.kid, deps.fetch ?? fetch, now);
  if (jwk === null || typeof jwk.n !== "string" || typeof jwk.e !== "string") return null;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const data = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data))) return null;
  } catch {
    return null;
  }
  return parsed;
}

/**
 * The claims of a decoded JWT payload in the shape the registry uses, or `null` when a claim
 * has the wrong type. Numeric ids are normalised to strings. Signature, `iss`, `aud`, `exp`
 * and `nbf` are checked by {@link verifyGithubJwt}, not here.
 */
function parseGithubClaims(claims: Record<string, unknown>): GithubClaims | null {
  const { iss, aud, exp, nbf, repository } = claims;
  if (typeof iss !== "string" || typeof exp !== "number" || typeof repository !== "string") {
    return null;
  }
  if (!(typeof aud === "string" || (Array.isArray(aud) && aud.every((a) => typeof a === "string"))))
    return null;
  const out: GithubClaims = { iss, aud: aud as string | string[], exp, repository };
  if (typeof nbf === "number") out.nbf = nbf;
  for (const field of ["repository_id", "repository_owner_id"] as const) {
    const value = claims[field];
    if (value === undefined || value === null) continue;
    if (typeof value === "number" && Number.isSafeInteger(value)) out[field] = String(value);
    else if (typeof value === "string") out[field] = value;
    else return null;
  }
  for (const field of ["ref", "workflow", "workflow_ref", "environment"] as const) {
    const value = claims[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return null;
    out[field] = value;
  }
  return out;
}

/** An optional entry field: absent or `null` means "any". */
function isAny(value: string | null | undefined): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * Whether a `gh` entry's `repository` matches the `repository` claim (docs/api.md 2.5):
 * `owner/repo` equal case-insensitively, or `owner/*` for any repository of that owner.
 */
export function matchesRepository(pattern: string, repository: string): boolean {
  const p = pattern.toLowerCase();
  const r = repository.toLowerCase();
  if (!p.endsWith("/*")) return p === r;
  const owner = p.slice(0, -1);
  const rest = r.slice(owner.length);
  return r.startsWith(owner) && rest !== "" && !rest.includes("/");
}

/** A glob where `*` matches any sequence of characters (`/` included); case-sensitive. */
export function matchesGlob(pattern: string, value: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\S]*");
  return new RegExp(`^${source}$`).test(value);
}

/**
 * The workflow file path of a `workflow_ref` claim: without the leading `owner/repo/` and the
 * trailing `@<ref>` (`acme/sdk/.github/workflows/release.yml@refs/tags/v1` →
 * `.github/workflows/release.yml`). The ref is cut at the `@` before the `ref` claim when the
 * claim ends with it, otherwise at the last `@`. `null` when the claim is missing or malformed.
 */
export function workflowPath(claims: Pick<GithubClaims, "repository" | "ref" | "workflow_ref">) {
  const value = claims.workflow_ref;
  if (value === undefined) return null;
  const at =
    claims.ref !== undefined && value.endsWith(`@${claims.ref}`)
      ? value.length - claims.ref.length - 1
      : value.lastIndexOf("@");
  const withoutRef = at === -1 ? value : value.slice(0, at);
  const prefix = `${claims.repository}/`;
  if (withoutRef.toLowerCase().startsWith(prefix.toLowerCase())) {
    return withoutRef.slice(prefix.length) || null;
  }
  // A repository claim that does not prefix the path: drop the first two segments.
  const parts = withoutRef.split("/");
  return parts.length > 2 ? parts.slice(2).join("/") : null;
}

/**
 * Whether a `gh` entry matches verified claims (docs/api.md 2.5): `repository` (exact or
 * `owner/*`), `repository_id` and `repository_owner_id` (equal strings), `ref` (glob),
 * `workflow` (against `workflow_ref`) and `environment` (equal). An absent or `null` optional
 * field means "any". Whether the entry is active is checked separately ({@link isActive}).
 */
export function matchesGhEntry(entry: GhAuthRecord, claims: GithubClaims): boolean {
  if (!matchesRepository(entry.repository, claims.repository)) return false;
  for (const field of ["repository_id", "repository_owner_id", "environment"] as const) {
    const expected = entry[field];
    if (!isAny(expected) && expected !== claims[field]) return false;
  }
  if (!isAny(entry.ref) && (claims.ref === undefined || !matchesGlob(entry.ref, claims.ref))) {
    return false;
  }
  return isAny(entry.workflow) || entry.workflow === workflowPath(claims);
}

/** The roles a hint names: one, or any of several (a route open to `admin` and `yank`). */
function hintKinds(hint: KindHint): readonly Kind[] {
  return typeof hint === "string" ? [hint] : hint;
}

/**
 * The first active `gh` entry of a record that matches the claims. With a `role`, an entry
 * whose scope covers it wins over an earlier one that does not; `strict` drops the others.
 */
function matchingGhEntry(
  record: CredentialRecord,
  claims: GithubClaims,
  now: number,
  role?: KindHint,
  strict = false,
): GhAuthRecord | null {
  const matches = record.auth.filter(
    (e): e is GhAuthRecord =>
      e.type === "gh" &&
      isActive(e, now) &&
      effectiveRoles(record, e).length > 0 &&
      matchesGhEntry(e, claims),
  );
  const wanted = role === undefined ? [] : hintKinds(role);
  const covering =
    role === undefined
      ? undefined
      : matches.find((e) => effectiveRoles(record, e).some((r) => wanted.includes(r)));
  return covering ?? (strict ? null : (matches[0] ?? null));
}

/**
 * The ids a matching `gh` entry takes over from the claims on first use: `repository_id` for
 * an exact `owner/repo` entry and `repository_owner_id` for any entry, each only while unset
 * and present in the claims. `null` when there is nothing to pin or `pin_on_first_use` is
 * `false`.
 */
export function idsToPin(
  entry: GhAuthRecord,
  claims: GithubClaims,
): Pick<GhAuthRecord, "repository_id" | "repository_owner_id"> | null {
  if (entry.pin_on_first_use === false) return null;
  const pins: Pick<GhAuthRecord, "repository_id" | "repository_owner_id"> = {};
  if (
    !entry.repository.endsWith("/*") &&
    isAny(entry.repository_id) &&
    claims.repository_id !== undefined
  ) {
    pins.repository_id = claims.repository_id;
  }
  if (isAny(entry.repository_owner_id) && claims.repository_owner_id !== undefined) {
    pins.repository_owner_id = claims.repository_owner_id;
  }
  return Object.keys(pins).length > 0 ? pins : null;
}

/**
 * Pins the ids of a matched `gh` entry on first use ({@link idsToPin}) and returns the record
 * and entry to authenticate with, or `null` when the entry no longer matches. The record is
 * read again from KV right before the write and only still-unset ids are filled in, so
 * concurrent first requests write the same values and never lose each other's fields; the
 * write goes through {@link writeCredential}.
 */
async function pinOnFirstUse(
  env: Pick<Env, "AUTH">,
  record: CredentialRecord,
  entry: GhAuthRecord,
  claims: GithubClaims,
  now: number,
): Promise<{ record: CredentialRecord; entry: GhAuthRecord } | null> {
  if (idsToPin(entry, claims) === null) return { record, entry };
  const id = await authEntryId(entry);
  const fresh = await getCredential(env, record.project, { fresh: true, now });
  if (fresh === null) return null;
  const ids = await Promise.all(fresh.auth.map(authEntryId));
  const index = ids.indexOf(id);
  const current = fresh.auth[index];
  if (current === undefined || current.type !== "gh") return null;
  const pins = idsToPin(current, claims);
  const pinned: GhAuthRecord = pins === null ? current : { ...current, ...pins };
  if (!isActive(pinned, now) || !matchesGhEntry(pinned, claims)) return null;
  if (pins === null) return { record: fresh, entry: pinned };
  const next = { ...fresh, auth: fresh.auth.map((e, i) => (i === index ? pinned : e)) };
  await writeCredential(env, fresh, next);
  return { record: next, entry: pinned };
}

/**
 * Verifies a `gh` secret (a GitHub Actions OIDC JWT) and returns the first active `gh` entry
 * of the record that matches its claims. The signature is checked on every call; only the
 * JWKS is cached. Pure: it does not pin ids (authentication does, see {@link idsToPin}).
 */
export async function verifyGh(
  env: Pick<Env, "PUBLIC_URL">,
  record: CredentialRecord,
  jwt: string,
  deps: AuthDeps = {},
): Promise<GhAuthRecord | null> {
  const claims = await verifyGithubJwt(env, jwt, deps);
  return claims === null ? null : matchingGhEntry(record, claims, deps.now?.() ?? Date.now());
}

/** The reserved login of `_:gh.<jwt>`: the project is resolved from the JWT. */
export const RESOLVED_LOGIN = "_";

/** The `401` message when a `_` login matches more than one credential. */
export const AMBIGUOUS_GH_LOGIN =
  "more than one project matches this token; use <project>:gh.<jwt>";

/**
 * The kind a `_` login resolves to: `publish` for `/api/v1/publish/*`, `admin` for routes that
 * need the `admin` role alone (package administration, credentials, …), otherwise `read`.
 */
export type KindHint = Kind | readonly Kind[];

/**
 * Resolves `_:gh.<jwt>` (docs/api.md 2.5): verifies the JWT, takes the candidates from the
 * `gh-repo:` index of its `repository` claim, keeps the credentials of kind `kind` with a
 * matching active `gh` entry and returns the only one. `null` when none is left (or the JWT is
 * invalid); several throw `401 unauthorized` with {@link AMBIGUOUS_GH_LOGIN}. The hint may
 * be `admin`, so a credential with the `admin` role is resolved like any other.
 */
export async function resolveGhLogin(
  env: Pick<Env, "AUTH" | "PUBLIC_URL">,
  jwt: string,
  kind: KindHint,
  deps: AuthDeps = {},
): Promise<ResolvedCredential | null> {
  const now = deps.now?.() ?? Date.now();
  const claims = await verifyGithubJwt(env, jwt, deps);
  if (claims === null) return null;
  const projects = await ghRepoCandidates(env, claims.repository, now);
  const records = await Promise.all(
    projects.map((project) => getCredential(env, project, { now })),
  );
  const matches: { record: CredentialRecord; entry: GhAuthRecord }[] = [];
  for (const record of records) {
    if (record === null || !record.roles.some((role) => hintKinds(kind).includes(role))) continue;
    const entry = matchingGhEntry(record, claims, now, kind, true);
    if (entry !== null) matches.push({ record, entry });
  }
  if (matches.length > 1) throw new ValidationError("unauthorized", AMBIGUOUS_GH_LOGIN);
  const [match] = matches;
  if (match === undefined) return null;
  const pinned = await pinOnFirstUse(env, match.record, match.entry, claims, now);
  return pinned === null
    ? null
    : {
        record: pinned.record,
        entryId: await authEntryId(pinned.entry),
        roles: effectiveRoles(pinned.record, pinned.entry),
      };
}

// ---------------------------------------------------------------------------------------------
// Credential sources and authentication
// ---------------------------------------------------------------------------------------------

/** A credential record together with the auth entry that verified the secret. */
export interface ResolvedCredential {
  record: CredentialRecord;
  entryId: string;
  /** The roles the verifying entry may use ({@link effectiveRoles}). */
  roles: Kind[];
  /** For a login token issued for publishing: the only operations it may perform. */
  scopes?: PublishScope[];
  /** For a login token issued for yank or delete: the only operations it may perform. */
  ops?: AdminOp[];
}

/**
 * Where credential records come from. `KvSource` serves tokens without a source. `HttpSource`
 * (a provider from `AUTH_PROVIDERS`, see docs/spec.md "Record sources") is reserved: until it
 * exists, tokens naming a source are rejected with `401`; once it does, an unreachable
 * provider must throw `ValidationError("provider_unavailable")`.
 */
export interface CredentialSource {
  /** `role` is the role the request needs; it picks among `gh` entries with equal claims. */
  resolve(
    project: string,
    type: SecretType,
    secret: string,
    role?: KindHint,
  ): Promise<ResolvedCredential | null>;
}

/** Bindings and variables authentication needs. */
export type AuthEnv = Pick<Env, "AUTH" | "PUBLIC_URL" | "TOKEN_PREFIX" | "SESSION_SECRET">;

/** Credentials stored in KV under `cred:<project>`. */
export class KvSource implements CredentialSource {
  constructor(
    private readonly env: Pick<Env, "AUTH" | "PUBLIC_URL" | "SESSION_SECRET">,
    private readonly deps: AuthDeps = {},
  ) {}

  async resolve(
    project: string,
    type: SecretType,
    secret: string,
    role?: KindHint,
  ): Promise<ResolvedCredential | null> {
    const record = await getCredential(this.env, project, { now: this.deps.now?.() });
    if (record === null) return null;
    const now = this.deps.now?.() ?? Date.now();
    if (type === "key") {
      const entry = await verifyKey(record, secret, now);
      if (entry === null) return null;
      const roles = effectiveRoles(record, entry);
      return roles.length === 0 ? null : { record, entryId: await authEntryId(entry), roles };
    }
    if (type === "st") {
      const token = await verifyLoginToken(this.env, record, secret, now);
      if (token === null) return null;
      return {
        record,
        entryId: token.entryId,
        roles: token.roles,
        ...(token.scopes === undefined ? {} : { scopes: token.scopes }),
        ...(token.ops === undefined ? {} : { ops: token.ops }),
      };
    }
    const claims = await verifyGithubJwt(this.env, secret, this.deps);
    const entry = claims === null ? null : matchingGhEntry(record, claims, now, role);
    if (claims === null || entry === null) return null;
    const pinned = await pinOnFirstUse(this.env, record, entry, claims, now);
    return pinned === null
      ? null
      : {
          record: pinned.record,
          entryId: await authEntryId(pinned.entry),
          roles: effectiveRoles(pinned.record, pinned.entry),
        };
  }
}

/** The authenticated caller. */
export interface Identity {
  /** `[<source>.]<project>`, as recorded in `whoami` and `publishedBy`. */
  project: string;
  /** The roles this request may use: the credential's roles within the secret's scope. */
  roles: Kind[];
  /** The credential's grants per role (`admin` sees everything and has none of its own). */
  grants: RoleGrants;
  record: CredentialRecord;
  /** `id` of the auth entry that verified the secret. */
  entryId: string;
  /** For a login token issued for publishing: the only operations it may perform. */
  scopes?: PublishScope[];
  /** For a login token issued for yank or delete: the only operations it may perform. */
  ops?: AdminOp[];
}

/** Whether the identity may use any of the roles. */
export function hasRole(identity: Pick<Identity, "roles">, ...roles: Kind[]): boolean {
  return roles.some((role) => identity.roles.includes(role));
}

export interface Authentication {
  identity: Identity;
  via: SecretType;
}

/** Options of {@link authenticate}. */
export interface AuthenticateOptions extends AuthDeps {
  /**
   * The kind a `_:gh.<jwt>` login resolves to (docs/api.md 2.5): `publish` for the publishing
   * endpoints, `read` (the default) for every other route and the panel login.
   */
  kindHint?: KindHint;
}

/**
 * Authenticates a request by its `Authorization` header. Returns `null` when the header is
 * missing, malformed, or the credential cannot be verified (the caller answers `401`). A `_`
 * login that matches several credentials throws `401 unauthorized` with a message naming the
 * fix.
 */
export async function authenticate(
  request: Request,
  env: AuthEnv,
  options: AuthenticateOptions = {},
): Promise<Authentication | null> {
  const parsed = parseAuthorization(request.headers.get("authorization"), tokenPrefix(env));
  if (parsed === null) return null;
  // HttpSource is reserved: no provider is configured in v1, so a source is unknown (401).
  if (parsed.source !== null) return null;

  const hint = options.kindHint ?? "read";
  const resolved =
    parsed.project === RESOLVED_LOGIN
      ? await resolveGhLogin(env, parsed.secret, hint, options)
      : await new KvSource(env, options).resolve(parsed.project, parsed.type, parsed.secret, hint);
  if (resolved === null) return null;
  const { record, entryId, roles, scopes, ops } = resolved;
  return {
    identity: {
      // `_` never appears: the resolved project is what `whoami` and `publishedBy` record.
      project: parsed.project === RESOLVED_LOGIN ? record.project : parsed.login,
      roles,
      grants: record.grants,
      record,
      entryId,
      ...(scopes === undefined ? {} : { scopes }),
      ...(ops === undefined ? {} : { ops }),
    },
    via: parsed.type,
  };
}

/** Throws `403 forbidden` unless the identity may use one of the roles. */
export function requireRole(identity: Pick<Identity, "roles">, ...roles: Kind[]): void {
  if (!hasRole(identity, ...roles)) {
    throw new ValidationError("forbidden", "This credential may not perform this operation.");
  }
}

// ---------------------------------------------------------------------------------------------
// Panel sessions
// ---------------------------------------------------------------------------------------------

/** Name of the panel session cookie. */
export const SESSION_COOKIE = "sreg_session";
/** Session lifetime: 12 hours. */
export const SESSION_TTL = 12 * 60 * 60;

/** A signed session cookie value: `<base64url payload>.<base64url HMAC-SHA256>`. */
const SESSION_VALUE_RE = /^[A-Za-z0-9_-]{1,1024}\.[A-Za-z0-9_-]{43}$/;

/** `typ` of the signed payload of a panel session cookie. */
const SESSION_TYP = "sess";

/** What a session cookie carries; nothing is stored on the server. */
export interface Session {
  project: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
  /** For a session started with a `login` secret: the `id` of that auth entry. */
  entry?: string;
  /** For such a session: when a one-time code was last verified, seconds since the epoch. */
  totpAt?: number;
}

/** Bindings panel sessions need. */
export type SessionEnv = Pick<Env, "SESSION_SECRET">;

/** Optional fields of a session started with a `login` secret. */
export interface SessionLogin {
  entry: string;
  /** When a one-time code was last verified (ms since the epoch), if the entry has TOTP. */
  totpAt?: number;
}

/**
 * Creates a session for a local project: the signed cookie value carrying `{ project, exp }`
 * (12 hours from now), HMAC-SHA256 with a key derived from `SESSION_SECRET`. A session started
 * with a `login` secret also carries that entry's id and when its one-time code was verified.
 * Throws `500 internal_error` naming the setting when `SESSION_SECRET` is not set.
 */
export async function createSession(
  env: SessionEnv,
  project: string,
  deps: Pick<AuthDeps, "now"> = {},
  login?: SessionLogin,
): Promise<string> {
  const now = deps.now?.() ?? Date.now();
  const payload: Record<string, unknown> = {
    project,
    exp: Math.floor(now / 1000) + SESSION_TTL,
  };
  if (login !== undefined) {
    payload.entry = login.entry;
    if (login.totpAt !== undefined) payload.totp_at = Math.floor(login.totpAt / 1000);
  }
  const value = await signPayload(env, SESSION_TYP, payload);
  if (value === null) {
    throw new ValidationError(
      "internal_error",
      "Panel sessions are not configured: set SESSION_SECRET in the Worker settings.",
    );
  }
  return value;
}

/** The value of the request's `sreg_session` cookie, if it is shaped like a session. */
export function sessionValueFrom(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return SESSION_VALUE_RE.test(value) ? value : null;
  }
  return null;
}

/**
 * Reads the session of the request's `sreg_session` cookie: the HMAC is verified with
 * `crypto.subtle.verify` (constant time), the payload must be a session (`typ`) and must not
 * have expired. `null` when there is no valid session or `SESSION_SECRET` is not set.
 */
export async function readSession(
  request: Request,
  env: SessionEnv,
  deps: Pick<AuthDeps, "now"> = {},
): Promise<Session | null> {
  const value = sessionValueFrom(request);
  if (value === null) return null;
  const session = await verifyPayload(env, SESSION_TYP, value);
  if (session === null || typeof session.project !== "string" || typeof session.exp !== "number") {
    return null;
  }
  const now = deps.now?.() ?? Date.now();
  if (session.exp * 1000 <= now) return null;
  const out: Session = { project: session.project, exp: session.exp };
  if (typeof session.entry === "string") out.entry = session.entry;
  if (typeof session.totp_at === "number") out.totpAt = session.totp_at;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pending sign-ins
// ---------------------------------------------------------------------------------------------

/** Name of the cookie that holds a sign-in between its password and its one-time code. */
export const PENDING_COOKIE = "sreg_pending";
/** How long a password stays good for entering the one-time code: 5 minutes. */
export const PENDING_TTL = 5 * 60;

/** `typ` of the signed payload of a pending sign-in. */
const PENDING_TYP = "pending";

/** A sign-in whose password was right and whose one-time code is still to come. */
export interface PendingSignIn {
  project: string;
  /** The `id` of the `login` entry the password matched. */
  entry: string;
  /** What the sign-in is for: `panel`, or the nonce of a login session of `/authorize`. */
  context: string;
}

/**
 * The signed value of a pending sign-in, valid for {@link PENDING_TTL}. It carries no password
 * and grants nothing by itself: only the one-time code step reads it, and it is not a
 * session (`typ` differs, so it never verifies as one).
 */
export async function createPending(
  env: SessionEnv,
  pending: PendingSignIn,
  deps: Pick<AuthDeps, "now"> = {},
): Promise<string> {
  const now = deps.now?.() ?? Date.now();
  const value = await signPayload(env, PENDING_TYP, {
    project: pending.project,
    entry: pending.entry,
    ctx: pending.context,
    exp: Math.floor(now / 1000) + PENDING_TTL,
  });
  if (value === null) {
    throw new ValidationError(
      "internal_error",
      "Sign-in is not configured: set SESSION_SECRET in the Worker settings.",
    );
  }
  return value;
}

/** The pending sign-in of the request's cookie, or `null` when it is missing, forged or expired. */
export async function readPending(
  request: Request,
  env: SessionEnv,
  deps: Pick<AuthDeps, "now"> = {},
): Promise<PendingSignIn | null> {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  let value: string | null = null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === PENDING_COOKIE) value = part.slice(eq + 1).trim();
  }
  if (value === null || !SESSION_VALUE_RE.test(value)) return null;
  const payload = await verifyPayload(env, PENDING_TYP, value);
  if (payload === null) return null;
  const { project, entry, ctx, exp } = payload;
  if (typeof project !== "string" || typeof entry !== "string" || typeof ctx !== "string") {
    return null;
  }
  if (typeof exp !== "number" || exp * 1000 <= (deps.now?.() ?? Date.now())) return null;
  return { project, entry, context: ctx };
}

/** `Set-Cookie` value that stores a pending sign-in, only for requests under `path`. */
export function pendingCookie(value: string, path: string): string {
  return `${PENDING_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=${PENDING_TTL}`;
}

/** `Set-Cookie` value that removes the pending sign-in cookie of `path`. */
export function clearPendingCookie(path: string): string {
  return `${PENDING_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=0`;
}

/** `Set-Cookie` value that stores a session for 12 hours. */
export function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`;
}

/** `Set-Cookie` value that removes the session cookie (logout). */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** The identity behind a panel session. */
export interface SessionIdentity {
  identity: Identity;
  session: Session;
}

/**
 * Resolves the request's session cookie to the identity of its credential. Returns `null` when
 * there is no valid session, the credential no longer exists, or none of its auth entries is
 * still active (expiring every secret of a project also ends its panel sessions).
 */
export async function sessionIdentity(
  request: Request,
  env: Pick<Env, "AUTH" | "SESSION_SECRET">,
  deps: Pick<AuthDeps, "now"> = {},
): Promise<SessionIdentity | null> {
  const session = await readSession(request, env, deps);
  if (session === null) return null;
  const record = await getCredential(env, session.project, { now: deps.now?.() });
  if (record === null) return null;
  const now = deps.now?.() ?? Date.now();
  if (!record.auth.some((entry) => isActive(entry, now))) return null;
  // A session started with a `login` secret ends with that secret and has only its roles.
  let roles = record.roles;
  if (session.entry !== undefined) {
    let login: LoginAuthRecord | undefined;
    for (const candidate of activeLogins(record, now)) {
      if ((await authEntryId(candidate)) === session.entry) login = candidate;
    }
    if (login === undefined) return null;
    roles = effectiveRoles(record, login);
  }
  return {
    identity: {
      project: record.project,
      // A cookie never publishes, yanks or deletes outside `admin`: those endpoints take a
      // token (docs/api.md 2.3).
      roles: roles.filter((role) => role === "read" || role === "admin"),
      grants: record.grants,
      record,
      entryId: session.entry ?? "",
    },
    session,
  };
}
