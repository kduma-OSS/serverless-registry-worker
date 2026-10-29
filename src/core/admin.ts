/**
 * Administration (docs/api.md 6.8–6.18): yanking, deleting and reindexing packages, managing
 * credentials and their secrets, and the first-run creation of an admin credential. Callers
 * check that the identity is an `admin`; these functions only validate input and act.
 */

import { getAdapter, validateRange } from "../adapters/index";
import type { Adapter, Eco, Manifest, ManifestFile } from "../adapters/types";
import type { Env } from "../env";
import { tokenPrefix } from "./config";
import {
  GH_EXTRA_FIELDS,
  GRANT_ROLES,
  KINDS,
  SCOPE_ROLES,
  authEntryId,
  deleteCredential,
  effectiveRoles,
  emptyGrants,
  formatToken,
  generateSecret,
  getCredential,
  hashPassword,
  hashSecret,
  isActive,
  isRoleSet,
  isSlug,
  listCredentials,
  randomBase62,
  toAuthEntry,
  toCredential,
  writeCredential,
  type AuthEntry,
  type AuthRecordEntry,
  type Credential,
  type CredentialRecord,
  type GhAuthRecord,
  type GrantRole,
  type Kind,
  type LoginAuthRecord,
  type RoleGrants,
} from "./auth";
import { ValidationError } from "./errors";
import { syncGhRepoIndex } from "./ghindex";
import { validateGrants } from "./grants";
import { rebuildIndex } from "./publish";
import {
  addPackageToMeta,
  packageMetaEntry,
  deleteIndexFiles,
  deleteVersion as deleteVersionObjects,
  isManifest,
  listManifests,
  manifestKey,
  readManifest,
  readPackagesMeta,
  removePackageFromMeta,
  removeVersionDeps,
  replacePackageDeps,
  setVersionDeps,
  updateJson,
} from "./storage";
import { parseTimestamp, rfc3339 } from "./time";
import { encryptTotpSecret, generateTotpSecret, otpauthUri } from "./totp";

export type PackageAdminEnv = Pick<Env, "R2_BUCKET" | "AUTH" | "ECOSYSTEMS">;
export type CredentialAdminEnv = Pick<
  Env,
  "AUTH" | "TOKEN_PREFIX" | "SESSION_SECRET" | "PUBLIC_URL"
>;

/** One version as the API lists it (docs/api.md 6.6). */
export interface PackageVersion {
  version: string;
  published: string;
  yanked: boolean;
  files: ManifestFile[];
}

/** The API view of a version manifest. */
export function toPackageVersion(m: Manifest): PackageVersion {
  return { version: m.version, published: m.published, yanked: m.yanked, files: m.files };
}

function notFound(message = "Not found."): ValidationError {
  return new ValidationError("not_found", message);
}

function invalid(message: string): never {
  throw new ValidationError("invalid_request", message);
}

/** The enabled adapter of `eco`; `404` for an unknown or disabled ecosystem. */
export function requireAdapter(env: Pick<Env, "ECOSYSTEMS">, eco: string): Adapter {
  const adapter = getAdapter(env, eco);
  if (adapter === null) throw notFound("Unknown ecosystem.");
  return adapter;
}

/**
 * The stored form of a version from a path (NuGet: normalised, docs/api.md 1.3); `404` for a
 * version the ecosystem cannot have.
 */
function requireVersion(adapter: Adapter, version: string): string {
  if (version.includes("/") || !adapter.validateVersion(version)) {
    throw notFound("Version not found.");
  }
  return adapter.storedVersion?.(version) ?? version;
}

/** The stored form of a package name from a path (NuGet, Swift: lower case, docs/api.md 1.3). */
function storedName(adapter: Adapter, name: string): string {
  return adapter.storedName?.(name) ?? name;
}

/** Updates (or, without versions, removes) the package's meta entry from its manifests. */
async function refreshMeta(
  env: PackageAdminEnv,
  adapter: Adapter,
  name: string,
  manifests: readonly Manifest[],
  now: Date,
): Promise<void> {
  if (manifests.length === 0) await removePackageFromMeta(env, adapter.eco, name);
  else {
    await addPackageToMeta(
      env,
      adapter.eco,
      name,
      packageMetaEntry(adapter, manifests, rfc3339(now)),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------------------------

/** `POST /api/v1/packages/<eco>/<name>/<version>/yank` (idempotent). */
export async function yank(
  env: PackageAdminEnv,
  eco: string,
  rawName: string,
  rawVersion: string,
  now: Date,
  publicUrl: string,
): Promise<{ eco: Eco; name: string } & PackageVersion> {
  const adapter = requireAdapter(env, eco);
  const version = requireVersion(adapter, rawVersion);
  const name = storedName(adapter, rawName);
  const manifest = await updateJson<Manifest>(
    env,
    manifestKey(adapter.eco, name, version),
    (current) => {
      if (current === null) throw notFound("Version not found.");
      return current.yanked ? current : { ...current, yanked: true };
    },
    { isValid: isManifest },
  );
  const manifests = await rebuildIndex(env, adapter, name, { publicUrl });
  // Yanked versions stay in the graph unmarked (they keep taking part in transitive access);
  // setting the entry again only repairs a graph that missed the version.
  await setVersionDeps(env, adapter.eco, name, version, adapter.dependencies(manifest));
  await refreshMeta(env, adapter, name, manifests, now);
  return { eco: adapter.eco, name, ...toPackageVersion(manifest) };
}

/** `DELETE /api/v1/packages/<eco>/<name>/<version>`: the version can be published again. */
export async function deleteVersion(
  env: PackageAdminEnv,
  eco: string,
  rawName: string,
  rawVersion: string,
  now: Date,
  publicUrl: string,
): Promise<{ eco: Eco; name: string; version: string; deleted: true }> {
  const adapter = requireAdapter(env, eco);
  const version = requireVersion(adapter, rawVersion);
  const name = storedName(adapter, rawName);
  const manifest = await readManifest(env, adapter.eco, name, version);
  if (manifest === null) throw notFound("Version not found.");
  await deleteVersionObjects(env, adapter.eco, name, version);
  const ctx = { publicUrl };
  const manifests = await rebuildIndex(env, adapter, name, ctx);
  if (manifests.length === 0) {
    await deleteIndexFiles(
      env,
      adapter.buildIndex(name, [manifest], ctx).map((f) => f.key),
    );
  }
  await removeVersionDeps(env, adapter.eco, name, version);
  await refreshMeta(env, adapter, name, manifests, now);
  return { eco: adapter.eco, name, version, deleted: true };
}

/** `DELETE /api/v1/packages/<eco>/<name>`: every version, the indexes and the meta entry. */
export async function deletePackage(
  env: PackageAdminEnv,
  eco: string,
  rawName: string,
  publicUrl: string,
): Promise<{ eco: Eco; name: string; deletedVersions: string[] }> {
  const adapter = requireAdapter(env, eco);
  const name = storedName(adapter, rawName);
  const manifests = await listManifests(env, adapter.eco, name, adapter.compareVersions);
  const listed = Object.hasOwn((await readPackagesMeta(env))[adapter.eco], name);
  if (manifests.length === 0 && !listed) throw notFound("Package not found.");
  for (const m of manifests) await deleteVersionObjects(env, adapter.eco, name, m.version);
  if (manifests.length > 0) {
    await deleteIndexFiles(
      env,
      adapter.buildIndex(name, manifests, { publicUrl }).map((f) => f.key),
    );
  }
  await removePackageFromMeta(env, adapter.eco, name);
  await replacePackageDeps(env, adapter.eco, name, new Map());
  return {
    eco: adapter.eco,
    name,
    deletedVersions: manifests.map((m) => m.version).reverse(),
  };
}

/**
 * `POST /api/v1/packages/<eco>/<name>/reindex`: rebuilds the index and the package's entries
 * of the dependency graph from the manifests.
 */
export async function reindex(
  env: PackageAdminEnv,
  eco: string,
  rawName: string,
  now: Date,
  publicUrl: string,
): Promise<{ eco: Eco; name: string; manifests: number }> {
  const adapter = requireAdapter(env, eco);
  const name = storedName(adapter, rawName);
  const manifests = await rebuildIndex(env, adapter, name, { publicUrl });
  if (manifests.length === 0) throw notFound("Package not found.");
  await replacePackageDeps(
    env,
    adapter.eco,
    name,
    new Map(manifests.map((m) => [m.version, adapter.dependencies(m)])),
  );
  await refreshMeta(env, adapter, name, manifests, now);
  return { eco: adapter.eco, name, manifests: manifests.length };
}

// ---------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------

/** `owner/repo`, or `owner/*` for every repository of an owner. */
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+|\*)$/;
const ENTRY_ID_PREFIX_RE = /^[0-9a-f]{8,12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks a `<project>` path parameter: a provider-backed name (with `.`) is
 * `400 invalid_request`, anything else that is not a slug cannot exist (`404`).
 */
export function checkProjectParam(project: string): void {
  if (project.includes(".")) invalid("Provider-backed projects are not managed here.");
  if (!isSlug(project)) throw notFound("Credential not found.");
}

async function requireCredential(
  env: CredentialAdminEnv,
  project: string,
): Promise<CredentialRecord> {
  checkProjectParam(project);
  const record = await getCredential(env, project, { fresh: true });
  if (record === null) throw notFound("Credential not found.");
  return record;
}

function parseExpires(value: unknown, field = "expires"): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") invalid(`\`${field}\` must be a timestamp or null.`);
  const date = parseTimestamp(value);
  if (date === null) invalid(`\`${field}\` must be RFC 3339 or YYYY-MM-DD.`);
  return rfc3339(date);
}

function optionalClaim(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value === "") {
    invalid(`\`${field}\` must be a non-empty string or null.`);
  }
  return value;
}

/** An optional numeric GitHub id: a string of digits, or `null`. */
function optionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) {
    invalid(`\`${field}\` must be a string of digits or null.`);
  }
  return value;
}

/** Longest description of a secret, in characters (code points). */
export const DESCRIPTION_MAX_LENGTH = 200;

/**
 * A secret's description (docs/api.md 6.17): trimmed, at most 200 characters, no control
 * characters. Absent, `null` and blank mean no description (`undefined`).
 */
export function parseDescription(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") invalid("`description` must be a string or null.");
  const text = value.trim();
  if ([...text].length > DESCRIPTION_MAX_LENGTH) {
    invalid(`\`description\` must be at most ${DESCRIPTION_MAX_LENGTH} characters long.`);
  }
  if (/\p{Cc}/u.test(text)) invalid("`description` must not contain control characters.");
  return text === "" ? undefined : text;
}

/** Bounds of a user-chosen password, in characters (code points). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Checks a user-chosen password of a `login` secret: 12 to 128 printable characters, any
 * script, without `:` and without whitespace or control characters.
 */
function checkPassword(value: unknown): string {
  if (typeof value !== "string") invalid("`password` must be a string.");
  const length = [...value].length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    invalid(
      `\`password\` must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters long.`,
    );
  }
  if (/[:\s\p{Cc}\p{Cs}\p{Co}\p{Cn}]/u.test(value)) {
    invalid("`password` must be printable and contain no `:` and no whitespace.");
  }
  return value;
}

/** What is shown once when a `login` secret is created (docs/api.md 6.17). */
export interface LoginReveal {
  /** The password: the one chosen, or the generated one. */
  password: string;
  /** The one-time code enrolment, when the secret has TOTP. */
  totp?: { secret: string; otpauth_uri: string };
}

/** A new auth entry from a request body (docs/api.md 6.17) and what is shown once. */
async function newAuthEntry(
  env: CredentialAdminEnv,
  project: string,
  spec: unknown,
  roles: readonly Kind[],
  existing: readonly AuthRecordEntry[],
  now: Date,
): Promise<{ entry: AuthRecordEntry; secret: string | null; login?: LoginReveal }> {
  if (!isRecord(spec)) invalid("The secret must be an object.");
  const { type, repository, ref, workflow, repository_id, repository_owner_id, environment } = spec;
  const { password } = spec;
  if (password !== undefined && type !== "login") {
    invalid("`password` only applies to `login` secrets; a `key` is always generated.");
  }
  const pin = spec.pin_on_first_use;
  const expires = parseExpires(spec.expires);
  const description = parseDescription(spec.description);
  const note = description === undefined ? {} : { description };
  const created = rfc3339(now);
  const scope = parseScope(spec.scope, roles);
  if (spec.totp !== undefined && type !== "login")
    invalid("`totp` only applies to `login` secrets.");
  if (spec.replaces !== undefined && type !== "gh") {
    invalid("`replaces` only applies to `gh` secrets.");
  }
  if (type === "login") {
    const claims = [repository, ref, workflow, repository_id, repository_owner_id, environment];
    if (claims.some((value) => value !== undefined) || pin !== undefined) {
      invalid("Claims and `pin_on_first_use` only apply to `gh` secrets.");
    }
    if (spec.totp !== undefined && typeof spec.totp !== "boolean") {
      invalid("`totp` must be a boolean.");
    }
    const chosen = password === undefined ? randomBase62(24) : checkPassword(password);
    const entry: LoginAuthRecord = withScope(
      { type: "login", password: await hashPassword(chosen), created, expires, ...note },
      scope,
    );
    const reveal: LoginReveal = { password: chosen };
    if (spec.totp === true) {
      const shared = generateTotpSecret();
      entry.totp = { secret: await encryptTotpSecret(env, shared), last_step: 0 };
      reveal.totp = { secret: shared, otpauth_uri: otpauthUri(otpIssuer(env), project, shared) };
    }
    return { entry, secret: null, login: reveal };
  }
  if (type === "key") {
    const claims = [repository, ref, workflow, repository_id, repository_owner_id, environment];
    if (claims.some((value) => value !== undefined) || pin !== undefined) {
      invalid(
        "`repository`, `repository_id`, `repository_owner_id`, `ref`, `workflow`, " +
          "`environment` and `pin_on_first_use` only apply to `gh` secrets.",
      );
    }
    const secret = generateSecret();
    const hash = await hashSecret(secret);
    return { entry: withScope({ type: "key", hash, created, expires, ...note }, scope), secret };
  }
  if (type !== "gh") invalid("`type` must be `key`, `gh` or `login`.");
  if (typeof repository !== "string" || !REPOSITORY_RE.test(repository)) {
    invalid("`repository` must be `owner/repo` or `owner/*`.");
  }
  const entry: GhAuthRecord = withScope(
    {
      type: "gh",
      repository,
      ref: optionalClaim(ref, "ref"),
      workflow: optionalClaim(workflow, "workflow"),
      repository_id: optionalId(repository_id, "repository_id"),
      repository_owner_id: optionalId(repository_owner_id, "repository_owner_id"),
      environment: optionalClaim(environment, "environment"),
      pin_on_first_use: pinOnFirstUse(pin),
      created,
      expires,
      ...note,
    },
    scope,
  );
  // The same claims may be listed twice only for different scopes.
  const scopeKey = (e: AuthRecordEntry) => effectiveRoles({ roles }, e).join();
  const same = (e: GhAuthRecord) => sameGhClaims(e, entry) && scopeKey(e) === scopeKey(entry);
  const duplicate = existing.some((e) => e.type === "gh" && isActive(e, now.getTime()) && same(e));
  if (duplicate) invalid("An identical active `gh` entry already exists.");
  return { entry, secret: null };
}

/** Whether two `gh` entries trust the same claims (the scope is compared separately). */
function sameGhClaims(a: GhAuthRecord, b: GhAuthRecord): boolean {
  return (
    a.repository === b.repository &&
    (a.ref ?? null) === (b.ref ?? null) &&
    (a.workflow ?? null) === (b.workflow ?? null) &&
    GH_EXTRA_FIELDS.every((field) => (a[field] ?? null) === (b[field] ?? null))
  );
}

/** The entry with `scope` set (`undefined` stores none: the credential has a single role). */
function withScope<T extends AuthRecordEntry>(entry: T, scope: Kind[] | undefined): T {
  return scope === undefined ? entry : { ...entry, scope };
}

/**
 * The `scope` of a new secret (docs/api.md 6.17): a non-empty list of the credential's roles.
 * Required when the credential holds more than one; with one role the default is that role and
 * nothing is stored. `undefined` stores no scope.
 */
function parseScope(value: unknown, roles: readonly Kind[]): Kind[] | undefined {
  if (value === undefined || value === null) {
    if (roles.length > 1) invalid("`scope` is required for a credential with several roles.");
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) {
    invalid("`scope` must be a non-empty list of unique roles.");
  }
  for (const role of value) {
    if (!SCOPE_ROLES.includes(role as Kind)) {
      invalid("`scope` may only list read, publish, yank, delete and admin.");
    }
    if (!roles.includes(role as Kind)) invalid(`This credential has no ${String(role)} role.`);
  }
  return roles.filter((role) => value.includes(role));
}

/** The issuer shown by authenticator apps: the registry's host, or a fixed name. */
function otpIssuer(env: Pick<Env, "PUBLIC_URL">): string {
  try {
    return new URL(env.PUBLIC_URL ?? "").host || "Serverless Registry";
  } catch {
    return "Serverless Registry";
  }
}

/** `pin_on_first_use` of a new `gh` entry: a boolean, `true` when absent or `null`. */
function pinOnFirstUse(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "boolean") invalid("`pin_on_first_use` must be a boolean.");
  return value;
}

function isKind(value: unknown): value is Kind {
  return (KINDS as readonly unknown[]).includes(value);
}

/** The roles of a new credential: `roles`, or the legacy single `kind` (docs/api.md 6.13). */
function parseRoles(body: Record<string, unknown>): Kind[] {
  const { roles, kind } = body;
  if (roles !== undefined) {
    if (kind !== undefined) invalid("Give `roles` or `kind`, not both.");
    if (!isRoleSet(roles)) {
      invalid("`roles` must be a non-empty list of read, publish, yank, delete and admin.");
    }
    return roles;
  }
  if (!isKind(kind)) invalid("`kind` must be read, publish, yank, delete or admin.");
  return [kind];
}

/**
 * The grants a request body sets for a credential holding `roles`, on top of `base`: the legacy
 * flat `grants` (only with one role) and/or `read_grants`, `publish_grants`, `yank_grants` and
 * `delete_grants`. A role the credential does not hold takes none, and `admin` has no grants of
 * its own.
 */
function parseRoleGrants(
  roles: readonly Kind[],
  body: Record<string, unknown>,
  base: RoleGrants = emptyGrants(),
): RoleGrants {
  const next: RoleGrants = {
    read: [...base.read],
    publish: [...base.publish],
    yank: [...base.yank],
    delete: [...base.delete],
  };
  const check = (value: unknown) => validateGrants(value, validateRange);
  if (roles.length === 1 && roles[0] === "admin") {
    for (const field of ["grants", ...GRANT_ROLES.map((role) => `${role}_grants`)]) {
      if (body[field] !== undefined && check(body[field]).length > 0) {
        invalid("Admin credentials have no grants.");
      }
    }
    return emptyGrants();
  }
  if (body.grants !== undefined) {
    if (GRANT_ROLES.some((role) => body[`${role}_grants`] !== undefined)) {
      invalid("Give `grants` or the `<role>_grants` lists, not both.");
    }
    const [only, ...more] = roles;
    if (only === undefined || more.length > 0) {
      invalid(
        "`grants` needs a credential with one role: use `read_grants`, `publish_grants`, " +
          "`yank_grants` and `delete_grants`.",
      );
    }
    next[only as GrantRole] = check(body.grants);
  } else {
    for (const role of GRANT_ROLES) {
      const value = body[`${role}_grants`];
      if (value === undefined) continue;
      const grants = check(value);
      if (!roles.includes(role) && grants.length > 0) {
        invalid(`This credential has no ${role} role, so it takes no \`${role}_grants\`.`);
      }
      next[role] = grants;
    }
  }
  for (const role of GRANT_ROLES) {
    if (!roles.includes(role)) next[role] = [];
  }
  return next;
}

/** `GET /api/v1/credentials`: every KV credential, sorted by project. */
export async function listCredentialViews(
  env: CredentialAdminEnv,
): Promise<{ credentials: Credential[] }> {
  return { credentials: await Promise.all((await listCredentials(env)).map(toCredential)) };
}

/** `GET /api/v1/credentials/<project>`. */
export async function readCredentialView(
  env: CredentialAdminEnv,
  project: string,
): Promise<Credential> {
  return toCredential(await requireCredential(env, project));
}

async function storeNewCredential(
  env: CredentialAdminEnv,
  project: string,
  roles: Kind[],
  grants: RoleGrants,
  secretSpec: unknown,
  now: Date,
): Promise<{ credential: Credential; token?: string; login?: LoginReveal }> {
  if ((await getCredential(env, project, { fresh: true })) !== null)
    throw new ValidationError("credential_exists");
  // `null`: a credential without a secret yet; one is added later (6.17).
  if (secretSpec === null) {
    if (roles.includes("admin")) invalid("An admin credential needs a secret.");
    const record: CredentialRecord = { project, roles, auth: [], grants };
    await writeCredential(env, null, record);
    return { credential: await toCredential(record) };
  }
  const { entry, secret, login } = await newAuthEntry(env, project, secretSpec, roles, [], now);
  const record: CredentialRecord = { project, roles, auth: [entry], grants };
  await writeCredential(env, null, record);
  const credential = await toCredential(record);
  if (login !== undefined) return { credential, login };
  return secret === null
    ? { credential }
    : { credential, token: formatToken(project, secret, tokenPrefix(env)) };
}

/**
 * `POST /api/v1/credentials`: a credential with its first secret (default `key`; `secret: null`
 * creates it without one).
 */
export async function createCredential(
  env: CredentialAdminEnv,
  body: Record<string, unknown>,
  now: Date,
): Promise<{ credential: Credential; token?: string; login?: LoginReveal }> {
  const { project, secret } = body;
  if (typeof project !== "string" || !isSlug(project)) {
    invalid("`project` must match [a-z0-9][a-z0-9-]{1,62}.");
  }
  const roles = parseRoles(body);
  const grants = parseRoleGrants(roles, body);
  return storeNewCredential(
    env,
    project,
    roles,
    grants,
    secret === undefined ? { type: "key" } : secret,
    now,
  );
}

/**
 * `PATCH /api/v1/credentials/<project>`: replaces the grants of the roles given and/or changes
 * the roles (`admin` too, except that the last admin credential keeps it). Existing secrets keep
 * exactly the roles they had: adding a role never widens them.
 */
export async function updateGrants(
  env: CredentialAdminEnv,
  project: string,
  body: Record<string, unknown>,
  now: Date = new Date(),
): Promise<Credential> {
  const record = await requireCredential(env, project);
  for (const field of ["project", "kind", "auth"]) {
    if (field in body) invalid(`\`${field}\` cannot be changed.`);
  }
  const fields = ["grants", ...GRANT_ROLES.map((role) => `${role}_grants`), "roles"];
  if (!fields.some((field) => field in body)) {
    invalid(
      "`grants`, `read_grants`, `publish_grants`, `yank_grants`, `delete_grants` or `roles` is required.",
    );
  }
  let roles = record.roles;
  if (body.roles !== undefined) {
    if (!isRoleSet(body.roles)) {
      invalid("`roles` must be a non-empty list of read, publish, yank, delete and admin.");
    }
    if (record.roles.includes("admin") && !body.roles.includes("admin")) {
      const admins = (await listCredentials(env)).filter((r) => r.roles.includes("admin"));
      if (admins.length <= 1) {
        throw new ValidationError("forbidden", "The last admin credential must stay an admin.");
      }
    }
    roles = body.roles;
  }
  const grants = parseRoleGrants(roles, body, record.grants);
  let auth = record.auth;
  if (roles.join() !== record.roles.join()) {
    // Pin every secret to the roles it had, within the new set.
    auth = record.auth.map((entry) => ({
      ...entry,
      scope: effectiveRoles(record, entry).filter((role) => roles.includes(role)),
    }));
    const stranded = auth.find((e) => e.scope?.length === 0 && isActive(e, now.getTime()));
    if (stranded !== undefined) {
      const id = await authEntryId(stranded);
      invalid(`The active secret ${id} would be left without a role: expire it first.`);
    }
  }
  const updated: CredentialRecord = { ...record, roles, grants, auth };
  await writeCredential(env, record, updated);
  return toCredential(updated);
}

/** `DELETE /api/v1/credentials/<project>`; the last admin cannot be deleted (`403`). */
export async function removeCredential(
  env: CredentialAdminEnv,
  project: string,
): Promise<{ project: string; deleted: true }> {
  const record = await requireCredential(env, project);
  if (record.roles.includes("admin")) {
    const admins = (await listCredentials(env)).filter((r) => r.roles.includes("admin"));
    if (admins.length <= 1) {
      throw new ValidationError("forbidden", "The last admin credential cannot be deleted.");
    }
  }
  await deleteCredential(env, project);
  await syncGhRepoIndex(env, record, null);
  return { project, deleted: true };
}

/** The index of the entry whose `id` starts with `idPrefix` (6.1); `404` or `400` otherwise. */
async function findEntryIndex(record: CredentialRecord, idPrefix: string): Promise<number> {
  if (!ENTRY_ID_PREFIX_RE.test(idPrefix)) {
    invalid("The secret id must be 8 to 12 lower-case hexadecimal characters.");
  }
  const ids = await Promise.all(record.auth.map(authEntryId));
  const matches = ids.flatMap((id, i) => (id.startsWith(idPrefix) ? [i] : []));
  if (matches.length === 0) throw notFound("Secret not found.");
  if (matches.length > 1) invalid("The secret id prefix is ambiguous.");
  return matches[0] ?? 0;
}

/** `entry` expired now, unless it already expires earlier (an entry is never extended). */
function expiredNow(entry: AuthRecordEntry, now: Date): AuthRecordEntry {
  const current = entry.expires === null ? NaN : Date.parse(entry.expires);
  const expires = Number.isNaN(current) ? now.getTime() : Math.min(now.getTime(), current);
  return { ...entry, expires: rfc3339(new Date(expires)) };
}

/**
 * `POST /api/v1/credentials/<project>/secrets`: adds an auth entry. With `replaces` (a `gh`
 * secret only) the entry it names, which must be a `gh` entry too, expires now in the same
 * write, and an identical active entry is not a duplicate (editing a `gh` entry, 6.17).
 */
export async function addSecret(
  env: CredentialAdminEnv,
  project: string,
  body: Record<string, unknown>,
  now: Date,
): Promise<{ secret: AuthEntry; token?: string; login?: LoginReveal }> {
  const record = await requireCredential(env, project);
  let replaced = -1;
  if (body.replaces !== undefined) {
    if (typeof body.replaces !== "string") invalid("`replaces` must be a secret id.");
    replaced = await findEntryIndex(record, body.replaces);
    if (record.auth[replaced]?.type !== "gh") invalid("`replaces` must name a `gh` secret.");
  }
  const others = record.auth.filter((_, i) => i !== replaced);
  const { entry, secret, login } = await newAuthEntry(
    env,
    project,
    body,
    record.roles,
    others,
    now,
  );
  // The id of a `gh` entry hashes its claims and `created` (the scope is left out so that it can
  // change), so two entries with the same claims made in the same second would share an id:
  // move `created` on until it is free.
  const taken = new Set(await Promise.all(record.auth.map(authEntryId)));
  for (let bump = 1; taken.has(await authEntryId(entry)); bump++) {
    entry.created = rfc3339(new Date(now.getTime() + bump * 1000));
  }
  const auth = record.auth.map((e, i) => (i === replaced ? expiredNow(e, now) : e));
  await writeCredential(env, record, { ...record, auth: [...auth, entry] });
  const view = await toAuthEntry(entry, record);
  if (login !== undefined) return { secret: view, login };
  return secret === null
    ? { secret: view }
    : { secret: view, token: formatToken(project, secret, tokenPrefix(env)) };
}

/**
 * `PATCH /api/v1/credentials/<project>/secrets/<hash-prefix>`: sets or clears the description
 * of an entry and/or replaces its `scope` (docs/api.md 6.22); `expires` and the `id` stay. A
 * `gh` entry cannot take a scope that would make it identical to another active one.
 */
export async function updateSecret(
  env: CredentialAdminEnv,
  project: string,
  idPrefix: string,
  body: Record<string, unknown>,
  now: Date = new Date(),
): Promise<{ secret: AuthEntry }> {
  const record = await requireCredential(env, project);
  for (const field of Object.keys(body)) {
    if (field !== "description" && field !== "scope") invalid(`\`${field}\` cannot be changed.`);
  }
  if (!("description" in body) && !("scope" in body)) {
    invalid("`description` or `scope` is required.");
  }
  const description = "description" in body ? parseDescription(body.description) : undefined;
  let scope: Kind[] | undefined;
  if ("scope" in body) {
    if (!Array.isArray(body.scope)) invalid("`scope` must be a list of roles.");
    scope = parseScope(body.scope, record.roles);
  }
  const index = await findEntryIndex(record, idPrefix);
  const entry = record.auth[index];
  if (entry === undefined) throw notFound("Secret not found.");
  const updated: AuthRecordEntry = { ...entry };
  if ("description" in body) {
    if (description === undefined) delete updated.description;
    else updated.description = description;
  }
  if (scope !== undefined) {
    updated.scope = scope;
    if (updated.type === "gh" && isActive(updated, now.getTime())) {
      const key = (e: AuthRecordEntry) => effectiveRoles(record, e).join();
      const clash = record.auth.some(
        (e, i) =>
          i !== index &&
          e.type === "gh" &&
          isActive(e, now.getTime()) &&
          sameGhClaims(e, updated) &&
          key(e) === key(updated),
      );
      if (clash) invalid("An identical active `gh` entry with that scope already exists.");
    }
  }
  const auth = record.auth.map((e, i) => (i === index ? updated : e));
  await writeCredential(env, record, { ...record, auth });
  return { secret: await toAuthEntry(updated, { roles: record.roles }) };
}

/** The earlier name of {@link updateSecret}, from when only the description could change. */
export const describeSecret = updateSecret;

/**
 * `DELETE /api/v1/credentials/<project>/secrets/<hash-prefix>`: sets `expires` (default now; a
 * past value means now). An entry is never extended: an earlier existing `expires` is kept.
 */
export async function expireSecret(
  env: CredentialAdminEnv,
  project: string,
  idPrefix: string,
  body: Record<string, unknown>,
  now: Date,
): Promise<{ secret: AuthEntry }> {
  const record = await requireCredential(env, project);
  const index = await findEntryIndex(record, idPrefix);
  const entry = record.auth[index];
  if (entry === undefined) throw notFound("Secret not found.");

  const requested = parseExpires(body.expires);
  let expires = Math.max(now.getTime(), requested === null ? 0 : Date.parse(requested));
  const current = entry.expires === null ? NaN : Date.parse(entry.expires);
  if (!Number.isNaN(current)) expires = Math.min(expires, current);
  const updated: AuthRecordEntry = { ...entry, expires: rfc3339(new Date(expires)) };
  const auth = record.auth.map((e, i) => (i === index ? updated : e));
  await writeCredential(env, record, { ...record, auth });
  return { secret: await toAuthEntry(updated, record) };
}

// ---------------------------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------------------------

/** Whether KV holds any credential at all. */
export async function hasAnyCredential(env: Pick<Env, "AUTH">): Promise<boolean> {
  const page = await env.AUTH.list({ prefix: "cred:", limit: 1 });
  return page.keys.length > 0;
}

/** Options of {@link createFirstAdmin}. */
export interface FirstAdminOptions {
  /** A chosen password; generated when absent. */
  password?: string;
  /** Also require a one-time code. */
  totp?: boolean;
}

/**
 * Creates the first `admin` credential with a `login` secret (a password, chosen or generated,
 * and optionally a one-time code); only while no credential exists (`403 forbidden`
 * afterwards).
 */
export async function createFirstAdmin(
  env: CredentialAdminEnv,
  project: string,
  now: Date,
  options: FirstAdminOptions = {},
): Promise<{ credential: Credential; login: LoginReveal }> {
  if (await hasAnyCredential(env)) {
    throw new ValidationError("forbidden", "The registry has already been set up.");
  }
  if (!isSlug(project)) invalid("The project must match [a-z0-9][a-z0-9-]{1,62}.");
  const spec: Record<string, unknown> = { type: "login", totp: options.totp === true };
  if (options.password !== undefined) spec.password = options.password;
  const { credential, login } = await storeNewCredential(
    env,
    project,
    ["admin"],
    emptyGrants(),
    spec,
    now,
  );
  if (login === undefined) throw new ValidationError("internal_error");
  return { credential, login };
}
