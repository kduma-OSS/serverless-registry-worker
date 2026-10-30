/**
 * The only module that talks to R2 for package data: key layout, version manifests, generated
 * index files, `_meta/packages.json`, the dependency graphs `_meta/deps/<eco>.json` and the staging area of uploads (see "Data layout" and
 * "Publishing" in docs/spec.md).
 */

import type {
  Adapter,
  Dependency,
  DigestAlgorithm,
  Eco,
  IndexFile,
  Manifest,
  ManifestFile,
} from "../adapters/types";
import { DIGEST_ALGORITHMS, ECOS, isEco, isManifestFile } from "../adapters/types";
import type { Env } from "../env";
import { ValidationError } from "./errors";
import { compareVersions, parseVersion } from "./semver";

export type StorageEnv = Pick<Env, "R2_BUCKET">;

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

const NAME_SEPARATOR = "__";
const STAGING_PREFIX = "_staging/";
const MANIFEST_FILE = "manifest.json";
const JSON_TYPE = "application/json";

/** Key of the list of all packages per ecosystem. */
export const PACKAGES_META_KEY = "_meta/packages.json";

/** Key of the marker that ties the bucket to the installation (its id is also kept in KV). */
export const INSTALLATION_MARKER_KEY = "_meta/installation.json";

/**
 * Encodes a package name for use as one key segment: `/` becomes `__`, `@` is kept
 * (`acme/sdk` → `acme__sdk`, `@acme/sdk` → `@acme__sdk`).
 */
export function encodePackageName(name: string): string {
  return name.replaceAll("/", NAME_SEPARATOR);
}

/** Ecosystems whose package names never contain `/`, so their keys are not decoded. */
const FLAT_NAMES: ReadonlySet<Eco> = new Set<Eco>(["cargo", "nuget", "swift", "maven"]);

/**
 * Reverses {@link encodePackageName}. Composer and npm names contain exactly one `/`, so only
 * the first `__` is turned back into `/`; cargo, NuGet, swift (`scope.name`) and maven
 * (`group:artifact`) names never contain `/` and are returned as they are (they may contain
 * `__`). `.` and `:` are never encoded.
 */
export function decodePackageName(encoded: string, eco?: Eco): string {
  return eco !== undefined && FLAT_NAMES.has(eco) ? encoded : encoded.replace(NAME_SEPARATOR, "/");
}

/** `<eco>/pkg/<name>/`: everything stored for one package. */
export function packagePrefix(eco: Eco, name: string): string {
  return `${eco}/pkg/${encodePackageName(name)}/`;
}

function versionPrefix(eco: Eco, name: string, version: string): string {
  if (version === "" || version.includes("/")) throw new TypeError("Invalid version.");
  return `${packagePrefix(eco, name)}${version}/`;
}

/** `<eco>/pkg/<name>/<version>/manifest.json`. */
export function manifestKey(eco: Eco, name: string, version: string): string {
  return versionPrefix(eco, name, version) + MANIFEST_FILE;
}

/** `<eco>/pkg/<name>/<version>/<file>`: one file (archive, binary, …) of a version. */
export function fileKey(eco: Eco, name: string, version: string, fileName: string): string {
  if (fileName === "" || fileName.includes("/") || fileName === MANIFEST_FILE) {
    throw new TypeError("Invalid file name.");
  }
  return versionPrefix(eco, name, version) + fileName;
}

/** `<eco>/index/<parts…>`, the parts joined with `/` as given (the adapter's layout). */
export function indexKey(eco: Eco, ...parts: string[]): string {
  return `${eco}/index/${parts.join("/")}`;
}

/** `_staging/<upload-id>/<file>`. */
export function stagingKey(uploadId: string, file: string): string {
  return `${stagingPrefix(uploadId)}${file}`;
}

/** `_staging/<upload-id>/meta.json`: the `init` declaration. */
export function stagingMetaKey(uploadId: string): string {
  return stagingKey(uploadId, "meta.json");
}

/** `_staging/<upload-id>/result.json`: the `commit` response, kept for idempotent retries. */
export function stagingResultKey(uploadId: string): string {
  return stagingKey(uploadId, "result.json");
}

function stagingPrefix(uploadId: string): string {
  if (uploadId === "" || uploadId.includes("/")) throw new TypeError("Invalid upload id.");
  return `${STAGING_PREFIX}${uploadId}/`;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(env: StorageEnv, key: string): Promise<unknown> {
  const object = await env.R2_BUCKET.get(key);
  if (object === null) return null;
  try {
    return JSON.parse(await object.text()) as unknown;
  } catch {
    return null;
  }
}

/** The installation id stored in the bucket's marker; `null` when missing or malformed. */
export async function readInstallationMarker(env: StorageEnv): Promise<string | null> {
  const value = await readJson(env, INSTALLATION_MARKER_KEY);
  return isRecord(value) && typeof value.id === "string" && value.id !== "" ? value.id : null;
}

/**
 * Stores the installation marker. Without `replace` an existing marker is kept (two isolates
 * racing to create it end up with one); the result says whether this call wrote it.
 */
export async function writeInstallationMarker(
  env: StorageEnv,
  id: string,
  options: { replace?: boolean } = {},
): Promise<boolean> {
  const written = await env.R2_BUCKET.put(INSTALLATION_MARKER_KEY, JSON.stringify({ id }), {
    httpMetadata: { contentType: JSON_TYPE },
    ...(options.replace === true ? {} : { onlyIf: { etagDoesNotMatch: "*" } }),
  });
  return written !== null;
}

/** Whether `_meta/packages.json` exists (every initialised bucket has it). */
export async function hasPackagesMeta(env: StorageEnv): Promise<boolean> {
  return (await env.R2_BUCKET.head(PACKAGES_META_KEY)) !== null;
}

/** Every object under a prefix, following list cursors. */
async function listAll(env: StorageEnv, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.R2_BUCKET.list({ prefix, cursor });
    objects.push(...page.objects);
    if (!page.truncated) return objects;
    cursor = page.cursor;
  }
}

/** Deletes keys in batches of 1000 (the R2 limit); returns how many were deleted. */
async function deleteKeys(env: StorageEnv, keys: string[]): Promise<number> {
  for (let i = 0; i < keys.length; i += 1000) {
    await env.R2_BUCKET.delete(keys.slice(i, i + 1000));
  }
  return keys.length;
}

/**
 * The default order of {@link listManifests}: semver precedence; strings that are not valid
 * semver sort before valid ones, in byte order. Adapters with their own version rules (NuGet)
 * pass their comparator instead.
 */
export function compareVersionStrings(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (va && vb) return compareVersions(va, vb) || (a < b ? -1 : a > b ? 1 : 0);
  if (va) return 1;
  if (vb) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------------------------

/** A non-empty list of well-formed files with unique names. */
function hasValidFiles(files: unknown): files is ManifestFile[] {
  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.every(isManifestFile) &&
    new Set(files.map((f) => f.name)).size === files.length
  );
}

/** Whether a stored value is a well-formed version manifest. */
export function isManifest(value: unknown): value is Manifest {
  return (
    isRecord(value) &&
    isEco(value.eco) &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    hasValidFiles(value.files) &&
    typeof value.published === "string" &&
    typeof value.publishedBy === "string" &&
    typeof value.yanked === "boolean" &&
    (value.deprecated === undefined || isDeprecation(value.deprecated)) &&
    isRecord(value.native)
  );
}

function isDeprecation(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    typeof value.at === "string" &&
    typeof value.by === "string"
  );
}

/** Reads a version manifest; `null` when missing or not a manifest. */
export async function readManifest(
  env: StorageEnv,
  eco: Eco,
  name: string,
  version: string,
): Promise<Manifest | null> {
  const value = await readJson(env, manifestKey(eco, name, version));
  return isManifest(value) ? value : null;
}

/** Whether the manifest of a version exists. */
export async function manifestExists(
  env: StorageEnv,
  eco: Eco,
  name: string,
  version: string,
): Promise<boolean> {
  return (await env.R2_BUCKET.head(manifestKey(eco, name, version))) !== null;
}

/**
 * Writes a version manifest under its own key. Versions are immutable: unless `overwrite` is
 * set (yank), the write is conditional on the key not existing, so of two concurrent commits
 * of one version exactly one succeeds and the other gets `409 version_exists`.
 */
export async function writeManifest(
  env: StorageEnv,
  manifest: Manifest,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const key = manifestKey(manifest.eco, manifest.name, manifest.version);
  const body = JSON.stringify(manifest);
  const httpMetadata = { contentType: JSON_TYPE };
  if (options.overwrite) {
    await env.R2_BUCKET.put(key, body, { httpMetadata });
    return;
  }
  if ((await env.R2_BUCKET.head(key)) !== null) throw new ValidationError("version_exists");
  const written = await env.R2_BUCKET.put(key, body, {
    httpMetadata,
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (written === null) throw new ValidationError("version_exists");
}

/**
 * Deletes every object under the version prefix (manifest and all files); returns whether
 * anything was there.
 */
export async function deleteVersion(
  env: StorageEnv,
  eco: Eco,
  name: string,
  version: string,
): Promise<boolean> {
  const objects = await listAll(env, versionPrefix(eco, name, version));
  return (
    (await deleteKeys(
      env,
      objects.map((o) => o.key),
    )) > 0
  );
}

/**
 * Every manifest of a package (yanked included), lowest version first by `compare` (the
 * adapter's `compareVersions`; default {@link compareVersionStrings}).
 */
export async function listManifests(
  env: StorageEnv,
  eco: Eco,
  name: string,
  compare: (a: string, b: string) => number = compareVersionStrings,
): Promise<Manifest[]> {
  const prefix = packagePrefix(eco, name);
  const keys = (await listAll(env, prefix))
    .map((o) => o.key)
    .filter((key) => {
      const rest = key.slice(prefix.length).split("/");
      return rest.length === 2 && rest[1] === MANIFEST_FILE;
    });
  const values = await Promise.all(keys.map((key) => readJson(env, key)));
  return values.filter(isManifest).sort((a, b) => compare(a.version, b.version));
}

/**
 * The versions of a package that have a manifest (yanked included), lowest first by `compare`,
 * from a single listing and without reading any manifest.
 */
export async function listVersionNames(
  env: StorageEnv,
  eco: Eco,
  name: string,
  compare: (a: string, b: string) => number = compareVersionStrings,
): Promise<string[]> {
  const prefix = packagePrefix(eco, name);
  const versions: string[] = [];
  for (const { key } of await listAll(env, prefix)) {
    const rest = key.slice(prefix.length).split("/");
    if (rest.length === 2 && rest[1] === MANIFEST_FILE) versions.push(rest[0] ?? "");
  }
  return versions.sort(compare);
}

/** Decoded names of every package of an ecosystem that has anything stored, sorted. */
export async function listPackageNames(env: StorageEnv, eco: Eco): Promise<string[]> {
  const prefix = `${eco}/pkg/`;
  const names = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await env.R2_BUCKET.list({ prefix, delimiter: "/", cursor });
    for (const p of page.delimitedPrefixes) {
      names.add(decodePackageName(p.slice(prefix.length, -1), eco));
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------------------------
// Index files
// ---------------------------------------------------------------------------------------------

/** An index file as read from R2, with the etag for a conditional rewrite. */
export interface StoredIndex {
  body: string;
  etag: string;
  /** The content type the file was written with, if any. */
  contentType?: string;
}

/** Reads a generated index file; `null` when missing. */
export async function readIndex(env: StorageEnv, key: string): Promise<StoredIndex | null> {
  const object = await env.R2_BUCKET.get(key);
  if (object === null) return null;
  const contentType = object.httpMetadata?.contentType;
  return {
    body: await object.text(),
    etag: object.etag,
    ...(contentType === undefined ? {} : { contentType }),
  };
}

/** Writes generated index files (unconditionally; they are always derived from manifests). */
export async function writeIndexFiles(env: StorageEnv, files: readonly IndexFile[]): Promise<void> {
  await Promise.all(
    files.map((f) =>
      env.R2_BUCKET.put(f.key, f.body, { httpMetadata: { contentType: f.contentType } }),
    ),
  );
}

/**
 * Deletes generated index files by their full keys (as {@link IndexFile.key}); returns how many
 * keys were given. Keys outside `<eco>/index/` are refused with a `TypeError`.
 */
export async function deleteIndexFiles(env: StorageEnv, keys: readonly string[]): Promise<number> {
  for (const key of keys) {
    const eco = key.slice(0, key.indexOf("/"));
    if (!isEco(eco) || !key.startsWith(indexKey(eco)) || key === indexKey(eco)) {
      throw new TypeError("Not an index key.");
    }
  }
  return deleteKeys(env, [...keys]);
}

/**
 * Deletes every index file whose key starts with `<eco>/index/<prefix>`; returns how many were
 * deleted. The prefix is matched literally, so callers end it with `/` or a full file name.
 */
export async function deleteIndexPrefix(
  env: StorageEnv,
  eco: Eco,
  prefix: string,
): Promise<number> {
  const objects = await listAll(env, indexKey(eco, prefix));
  return deleteKeys(
    env,
    objects.map((o) => o.key),
  );
}

// ---------------------------------------------------------------------------------------------
// Optimistic concurrency
// ---------------------------------------------------------------------------------------------

/** Options of {@link updateJson}. */
export interface UpdateJsonOptions<T> {
  /** How many read-compute-write rounds to try before giving up (default 5). */
  attempts?: number;
  /** Shape check of the stored value; a value that fails it is passed to `update` as `null`. */
  isValid?: (value: unknown) => value is T;
}

/**
 * Read-modify-write of a JSON object with optimistic concurrency: reads the object, computes
 * the new value with `update` (which may throw to abort), and writes it with
 * `onlyIf: { etagMatches }` (or `etagDoesNotMatch: "*"` when the object did not exist). When
 * another writer got in between, the write is rejected and the whole round is retried. Throws
 * `500 internal_error` after `attempts` conflicts. An update that does not change the stored
 * text skips the write.
 */
export async function updateJson<T>(
  env: StorageEnv,
  key: string,
  update: (current: T | null) => T,
  options: UpdateJsonOptions<T> = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const object = await env.R2_BUCKET.get(key);
    let text: string | null = null;
    let current: T | null = null;
    if (object !== null) {
      text = await object.text();
      try {
        const parsed: unknown = JSON.parse(text);
        current = options.isValid === undefined || options.isValid(parsed) ? (parsed as T) : null;
      } catch {
        current = null;
      }
    }
    const next = update(current);
    const body = JSON.stringify(next);
    if (body === text) return next;
    const written = await env.R2_BUCKET.put(key, body, {
      httpMetadata: { contentType: JSON_TYPE },
      onlyIf: object === null ? { etagDoesNotMatch: "*" } : { etagMatches: object.etag },
    });
    if (written !== null) return next;
  }
  throw new ValidationError(
    "internal_error",
    `Concurrent updates of ${key} did not settle; try again.`,
  );
}

/**
 * Adds files to the manifest of an existing version (`append`). Throws `404 not_found` when
 * the version does not exist and `409 file_exists` when a name is already taken (or repeated).
 * Returns the updated manifest.
 */
export async function appendFilesToManifest(
  env: StorageEnv,
  eco: Eco,
  name: string,
  version: string,
  files: readonly ManifestFile[],
): Promise<Manifest> {
  return updateJson<Manifest>(
    env,
    manifestKey(eco, name, version),
    (current) => {
      if (current === null) throw new ValidationError("not_found", "Version not found.");
      const names = new Set(current.files.map((f) => f.name));
      for (const file of files) {
        if (names.has(file.name)) {
          throw new ValidationError("file_exists", `File ${file.name} already exists.`);
        }
        names.add(file.name);
      }
      return { ...current, files: [...current.files, ...files] };
    },
    { isValid: isManifest },
  );
}

// ---------------------------------------------------------------------------------------------
// _meta/packages.json
// ---------------------------------------------------------------------------------------------

/** What `_meta/packages.json` records about one package. */
export interface PackageMetaEntry {
  /** Number of versions (yanked ones included). */
  versions: number;
  /** RFC 3339 timestamp of the last change to the package's versions. */
  updated: string;
  /**
   * Every version (yanked ones included), lowest first by the ecosystem's order. With the next
   * two fields it lets the package lists describe the package without listing its versions and
   * reading a manifest. Absent from an entry written by an older release, and then the lists
   * read the bucket as before.
   */
  names?: string[];
  /** Whether the newest version is yanked (set with `names`). */
  latestYanked?: boolean;
  /** The name the lists show when it is not the stored one (NuGet, Swift: the listed casing). */
  display?: string;
}

/**
 * `_meta/packages.json`: every package per ecosystem, keyed by the decoded name, e.g.
 * `{ "composer": { "acme/sdk": { "versions": 2, "updated": "2026-10-28T10:12:00Z" } },
 * "npm": {}, "cargo": {}, "generic": {}, "nuget": {}, "swift": {}, "maven": {} }`. It is derived data: {@link rebuildPackagesMeta}
 * recreates it from the listing of manifests.
 */
export type PackagesMeta = Record<Eco, Record<string, PackageMetaEntry>>;

function emptyMeta(): PackagesMeta {
  return Object.fromEntries(ECOS.map((eco) => [eco, {}])) as PackagesMeta;
}

function isMetaEntry(value: unknown): value is PackageMetaEntry {
  return (
    isRecord(value) &&
    typeof value.versions === "number" &&
    Number.isInteger(value.versions) &&
    value.versions >= 0 &&
    typeof value.updated === "string"
  );
}

/**
 * The entry as stored: the optional description of the versions is kept only when it is
 * complete and agrees with the count, so a damaged or outdated one reads like an old entry.
 */
function toMetaEntry(entry: PackageMetaEntry): PackageMetaEntry {
  const out: PackageMetaEntry = { versions: entry.versions, updated: entry.updated };
  const { names, latestYanked, display } = entry;
  if (
    Array.isArray(names) &&
    names.length === entry.versions &&
    names.every((n) => typeof n === "string") &&
    typeof latestYanked === "boolean"
  ) {
    out.names = names;
    out.latestYanked = latestYanked;
    if (typeof display === "string" && display !== "") out.display = display;
  }
  return out;
}

/** Keeps the known ecosystems and well-formed entries of a stored value. */
function normaliseMeta(value: unknown): PackagesMeta {
  const meta = emptyMeta();
  if (!isRecord(value)) return meta;
  for (const eco of ECOS) {
    const packages = value[eco];
    if (!isRecord(packages)) continue;
    for (const [name, entry] of Object.entries(packages)) {
      if (isMetaEntry(entry)) meta[eco][name] = toMetaEntry(entry);
    }
  }
  return meta;
}

function sortedMeta(meta: PackagesMeta): PackagesMeta {
  const out = emptyMeta();
  for (const eco of ECOS) {
    for (const name of Object.keys(meta[eco]).sort()) {
      const entry = meta[eco][name];
      if (entry) out[eco][name] = entry;
    }
  }
  return out;
}

function updateMeta(env: StorageEnv, change: (meta: PackagesMeta) => void): Promise<PackagesMeta> {
  return updateJson<PackagesMeta>(env, PACKAGES_META_KEY, (current) => {
    const meta = normaliseMeta(current);
    change(meta);
    return sortedMeta(meta);
  });
}

/** Reads `_meta/packages.json`; every ecosystem is present, empty when the file is missing. */
export async function readPackagesMeta(env: StorageEnv): Promise<PackagesMeta> {
  return normaliseMeta(await readJson(env, PACKAGES_META_KEY));
}

/** Sets (adds or replaces) the entry of one package. */
export function addPackageToMeta(
  env: StorageEnv,
  eco: Eco,
  name: string,
  entry: PackageMetaEntry,
): Promise<PackagesMeta> {
  return updateMeta(env, (meta) => {
    meta[eco][name] = toMetaEntry(entry);
  });
}

/**
 * The entry of a package from its manifests, lowest version first (what the ecosystem's order
 * gives): the version numbers, whether the newest is yanked and the name the lists show.
 */
export function packageMetaEntry(
  adapter: Pick<Adapter, "displayName">,
  manifests: readonly Manifest[],
  updated: string,
): PackageMetaEntry {
  const entry: PackageMetaEntry = { versions: manifests.length, updated };
  const newest = manifests[manifests.length - 1];
  if (newest === undefined) return entry;
  entry.names = manifests.map((m) => m.version);
  entry.latestYanked = newest.yanked;
  const display = adapter.displayName?.(newest);
  if (display !== undefined && display !== newest.name) entry.display = display;
  return entry;
}

/**
 * Gives packages whose entry is an old one the full description, in one write. A package is
 * left alone when it changed in the meantime (its `updated` is not the one the description
 * was made for) or is gone. Returns how many entries were replaced.
 */
export async function upgradePackagesMeta(
  env: StorageEnv,
  upgrades: readonly { eco: Eco; name: string; expectedUpdated: string; entry: PackageMetaEntry }[],
): Promise<number> {
  if (upgrades.length === 0) return 0;
  let replaced = 0;
  await updateMeta(env, (meta) => {
    replaced = 0;
    for (const { eco, name, expectedUpdated, entry } of upgrades) {
      const current = meta[eco][name];
      if (current === undefined || current.updated !== expectedUpdated) continue;
      meta[eco][name] = toMetaEntry(entry);
      replaced += 1;
    }
  });
  return replaced;
}

/** Removes the entry of one package (a no-op when it is not listed). */
export function removePackageFromMeta(
  env: StorageEnv,
  eco: Eco,
  name: string,
): Promise<PackagesMeta> {
  return updateMeta(env, (meta) => {
    meta[eco] = Object.fromEntries(Object.entries(meta[eco]).filter(([n]) => n !== name));
  });
}

function rfc3339(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The entries of one ecosystem computed from the listing of its manifests. */
async function scanPackages(env: StorageEnv, eco: Eco): Promise<Record<string, PackageMetaEntry>> {
  const prefix = `${eco}/pkg/`;
  const found = new Map<string, { versions: number; updated: Date }>();
  for (const object of await listAll(env, prefix)) {
    const parts = object.key.slice(prefix.length).split("/");
    if (parts.length !== 3 || parts[2] !== MANIFEST_FILE || !parts[0]) continue;
    const name = decodePackageName(parts[0], eco);
    const entry = found.get(name);
    if (entry === undefined) found.set(name, { versions: 1, updated: object.uploaded });
    else {
      entry.versions += 1;
      if (object.uploaded > entry.updated) entry.updated = object.uploaded;
    }
  }
  const out: Record<string, PackageMetaEntry> = {};
  for (const [name, entry] of found) {
    out[name] = { versions: entry.versions, updated: rfc3339(entry.updated) };
  }
  return out;
}

/**
 * Recomputes `_meta/packages.json` from the listing of manifests (version count per package and
 * the newest manifest upload as `updated`), for one ecosystem or for all of them.
 */
export async function rebuildPackagesMeta(env: StorageEnv, eco?: Eco): Promise<PackagesMeta> {
  const ecos = eco === undefined ? ECOS : [eco];
  const scanned = await Promise.all(ecos.map((e) => scanPackages(env, e)));
  return updateMeta(env, (meta) => {
    ecos.forEach((e, i) => {
      meta[e] = scanned[i] ?? {};
    });
  });
}

// ---------------------------------------------------------------------------------------------
// _meta/deps/<eco>.json
// ---------------------------------------------------------------------------------------------

/** Key of the dependency graph of one ecosystem. */
export function depsGraphKey(eco: Eco): string {
  return `_meta/deps/${eco}.json`;
}

/**
 * The declared constraint of one dependency: a string, or the distinct constraints in
 * declaration order when a version names the dependency more than once with different
 * constraints (npm `dependencies` and `devDependencies`, NuGet target frameworks, cargo
 * targets). A version satisfying any of them is admitted.
 */
export type DepsConstraint = string | string[];

/** The dependencies of one version, by name as declared. */
export type VersionDeps = Record<string, DepsConstraint>;

/**
 * `_meta/deps/<eco>.json`: `{ "<package>": { "<version>": { "<dependency>": "<constraint>" } } }`
 * for every stored version of the ecosystem, yanked ones included and not marked (transitive
 * access treats them like any other version, docs/api.md 5.3). Dependencies keep the names and
 * constraints the adapter's `dependencies` returns; whether a name is a package of the registry
 * is decided when the graph is read. Derived data: {@link rebuildDepsGraph} recreates it from
 * the manifests.
 */
export type DepsGraph = Record<string, Record<string, VersionDeps>>;

function isDepsConstraint(value: unknown): value is DepsConstraint {
  return (
    typeof value === "string" ||
    (Array.isArray(value) && value.length > 0 && value.every((c) => typeof c === "string"))
  );
}

/** Keeps the well-formed packages, versions and dependencies of a stored value. */
function normaliseDepsGraph(value: unknown): DepsGraph {
  const graph: DepsGraph = {};
  if (!isRecord(value)) return graph;
  for (const [name, versions] of Object.entries(value)) {
    if (!isRecord(versions)) continue;
    const kept: Record<string, VersionDeps> = {};
    for (const [version, deps] of Object.entries(versions)) {
      if (!isRecord(deps)) continue;
      kept[version] = Object.fromEntries(
        Object.entries(deps).filter((entry): entry is [string, DepsConstraint] =>
          isDepsConstraint(entry[1]),
        ),
      );
    }
    if (Object.keys(kept).length > 0) graph[name] = kept;
  }
  return graph;
}

function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedRecord<T>(record: Record<string, T>, map: (value: T) => T = (v) => v) {
  return Object.fromEntries(
    Object.keys(record)
      .sort(byteOrder)
      .map((key) => [key, map(record[key] as T)]),
  ) as Record<string, T>;
}

/** Sorted by package, version and dependency name (byte order), so equal graphs are equal text. */
function sortedDepsGraph(graph: DepsGraph): DepsGraph {
  return sortedRecord(graph, (versions) => sortedRecord(versions, (deps) => sortedRecord(deps)));
}

/** The graph entry of one version from the dependencies its manifest declares. */
export function toVersionDeps(dependencies: readonly Dependency[]): VersionDeps {
  const constraints = new Map<string, string[]>();
  for (const { name, constraint } of dependencies) {
    const list = constraints.get(name);
    if (list === undefined) constraints.set(name, [constraint]);
    else if (!list.includes(constraint)) list.push(constraint);
  }
  const deps: VersionDeps = {};
  for (const [name, list] of constraints) deps[name] = list.length === 1 ? (list[0] ?? "") : list;
  return deps;
}

/** The constraints of a graph entry as a list. */
export function constraintList(constraint: DepsConstraint): string[] {
  return typeof constraint === "string" ? [constraint] : constraint;
}

/** A copy of a record without one key. */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

function updateDepsGraph(
  env: StorageEnv,
  eco: Eco,
  change: (graph: DepsGraph) => DepsGraph,
): Promise<DepsGraph> {
  return updateJson<DepsGraph>(env, depsGraphKey(eco), (current) =>
    sortedDepsGraph(change(normaliseDepsGraph(current))),
  );
}

/** Reads the dependency graph of an ecosystem; empty when the file is missing. */
export async function readDepsGraph(env: StorageEnv, eco: Eco): Promise<DepsGraph> {
  return normaliseDepsGraph(await readJson(env, depsGraphKey(eco)));
}

/** Sets (adds or replaces) the dependencies of one version (`commit`, yank). */
export function setVersionDeps(
  env: StorageEnv,
  eco: Eco,
  name: string,
  version: string,
  dependencies: readonly Dependency[],
): Promise<DepsGraph> {
  return updateDepsGraph(env, eco, (graph) => ({
    ...graph,
    [name]: { ...graph[name], [version]: toVersionDeps(dependencies) },
  }));
}

/** Removes one version, and the package with its last version (a no-op when missing). */
export function removeVersionDeps(
  env: StorageEnv,
  eco: Eco,
  name: string,
  version: string,
): Promise<DepsGraph> {
  return updateDepsGraph(env, eco, (graph) => {
    const versions = graph[name];
    if (versions === undefined) return graph;
    const rest = without(versions, version);
    return Object.keys(rest).length > 0 ? { ...graph, [name]: rest } : without(graph, name);
  });
}

/**
 * Replaces every version of one package with the given ones (`reindex`; an empty map, as for a
 * package delete, removes the package): `versions` maps each stored version to its declared
 * dependencies.
 */
export function replacePackageDeps(
  env: StorageEnv,
  eco: Eco,
  name: string,
  versions: ReadonlyMap<string, readonly Dependency[]>,
): Promise<DepsGraph> {
  return updateDepsGraph(env, eco, (graph) =>
    versions.size === 0
      ? without(graph, name)
      : {
          ...graph,
          [name]: Object.fromEntries(
            [...versions].map(([version, deps]) => [version, toVersionDeps(deps)]),
          ),
        },
  );
}

/**
 * Recomputes the dependency graph of an ecosystem from the listing of its manifests, with the
 * adapter's `dependencies` (migration and repair); every manifest is read once. Returns the
 * stored graph.
 */
export async function rebuildDepsGraph(
  env: StorageEnv,
  eco: Eco,
  dependencies: (m: Manifest) => readonly Dependency[],
): Promise<DepsGraph> {
  const prefix = `${eco}/pkg/`;
  const keys = (await listAll(env, prefix))
    .map((o) => o.key)
    .filter((key) => {
      const parts = key.slice(prefix.length).split("/");
      return parts.length === 3 && parts[2] === MANIFEST_FILE;
    });
  const graph: DepsGraph = {};
  for (const value of await Promise.all(keys.map((key) => readJson(env, key)))) {
    if (!isManifest(value) || value.eco !== eco) continue;
    graph[value.name] = {
      ...graph[value.name],
      [value.version]: toVersionDeps(dependencies(value)),
    };
  }
  return updateDepsGraph(env, eco, () => graph);
}

// ---------------------------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------------------------

/** `_staging/<upload-id>/meta.json`: the declaration accepted by `init`. */
export interface StagingMeta {
  eco: Eco;
  name: string;
  version: string;
  files: ManifestFile[];
  /** Ecosystem-native metadata as sent to `init`. */
  manifest: Record<string, unknown>;
  tag?: string;
  /** Files are added to an existing version. */
  append?: boolean;
  /** Extra digests the adapter declared at `init`, computed at `commit` (docs/api.md 6.5). */
  digests?: DigestAlgorithm[];
  /** `[<source>.]<project>` of the credential that called `init`. */
  publishedBy: string;
  /** RFC 3339. */
  createdAt: string;
  /** RFC 3339: when the presigned upload URLs expire. */
  expires: string;
}

/** `_staging/<upload-id>/result.json`: what a successful `commit` answered. */
export interface StagingResult {
  /** The credential that committed; a retry by another credential is not answered. */
  publishedBy: string;
  /** RFC 3339. */
  committedAt: string;
  /** The response body, returned again on a repeated `commit`. */
  response: Record<string, unknown>;
}

function isStagingMeta(value: unknown): value is StagingMeta {
  return (
    isRecord(value) &&
    isEco(value.eco) &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    hasValidFiles(value.files) &&
    isRecord(value.manifest) &&
    (value.tag === undefined || typeof value.tag === "string") &&
    (value.append === undefined || typeof value.append === "boolean") &&
    (value.digests === undefined ||
      (Array.isArray(value.digests) &&
        value.digests.every((d) => (DIGEST_ALGORITHMS as readonly unknown[]).includes(d)))) &&
    typeof value.publishedBy === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.expires === "string"
  );
}

function isStagingResult(value: unknown): value is StagingResult {
  return (
    isRecord(value) &&
    typeof value.publishedBy === "string" &&
    typeof value.committedAt === "string" &&
    isRecord(value.response)
  );
}

/** Writes the `init` declaration of an upload. */
export async function writeStagingMeta(
  env: StorageEnv,
  uploadId: string,
  meta: StagingMeta,
): Promise<void> {
  await env.R2_BUCKET.put(stagingMetaKey(uploadId), JSON.stringify(meta), {
    httpMetadata: { contentType: JSON_TYPE },
  });
}

/** Reads the `init` declaration of an upload; `null` when missing or malformed. */
export async function readStagingMeta(
  env: StorageEnv,
  uploadId: string,
): Promise<StagingMeta | null> {
  const value = await readJson(env, stagingMetaKey(uploadId));
  return isStagingMeta(value) ? value : null;
}

/** `head()` of one staged file (size and checksums); `null` when it was never uploaded. */
export function headStaged(
  env: StorageEnv,
  uploadId: string,
  fileName: string,
): Promise<R2Object | null> {
  return env.R2_BUCKET.head(stagingKey(uploadId, fileName));
}

/** Web Crypto names of the extra digest algorithms. */
const DIGEST_STREAM_NAMES: Readonly<Record<DigestAlgorithm, string>> = {
  sha1: "SHA-1",
  md5: "MD5",
  sha512: "SHA-512",
};

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads a stream to its end through one `DigestStream` per algorithm; lower-case hex. */
async function digestStream(
  stream: ReadableStream<Uint8Array>,
  algorithms: readonly DigestAlgorithm[],
): Promise<Record<string, string>> {
  const sinks = algorithms.map((a) => new crypto.DigestStream(DIGEST_STREAM_NAMES[a]));
  const writers = sinks.map((sink) => sink.getWriter());
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await Promise.all(writers.map((writer) => writer.write(value)));
  }
  await Promise.all(writers.map((writer) => writer.close()));
  const digests = await Promise.all(sinks.map((sink) => sink.digest));
  return Object.fromEntries(algorithms.map((a, i) => [a, hex(digests[i] ?? new ArrayBuffer(0))]));
}

/** A promoted file: the new object and the extra digests computed on the way. */
export interface PromotedObject {
  object: R2Object;
  /** Lower-case hex by algorithm; `{}` when none were asked for. */
  digests: Record<string, string>;
}

/**
 * Copies a staged file to its final key by streaming `get()` into `put()` (R2 verifies the
 * SHA-256: `sha256` when given, otherwise the checksum stored with the staged object), then
 * deletes the staged object. With `digests`, the body is teed: one branch goes through a
 * `FixedLengthStream` of the object's size into `put()` (R2 needs a stream of known length),
 * the other through a `DigestStream` per algorithm, so the bytes are read from R2 once and
 * never buffered whatever their size. Returns `null` when nothing is staged.
 */
export async function promoteStagedWithDigests(
  env: StorageEnv,
  uploadId: string,
  fileName: string,
  targetKey: string,
  options: { sha256?: string; digests?: readonly DigestAlgorithm[] } = {},
): Promise<PromotedObject | null> {
  const key = stagingKey(uploadId, fileName);
  const staged = await env.R2_BUCKET.get(key);
  if (staged === null) return null;
  const sha256 = options.sha256 ?? staged.checksums.sha256;
  const algorithms = [...new Set(options.digests ?? [])];
  let body: ReadableStream = staged.body;
  let digesting: Promise<Record<string, string>> = Promise.resolve({});
  if (algorithms.length > 0) {
    const [toPut, toDigest] = staged.body.tee();
    const fixed = new FixedLengthStream(staged.size);
    // A failed copy surfaces through `put()`, which then rejects.
    toPut.pipeTo(fixed.writable).catch(() => undefined);
    body = fixed.readable;
    digesting = digestStream(toDigest, algorithms);
  }
  const [object, digests] = await Promise.all([
    env.R2_BUCKET.put(targetKey, body, {
      httpMetadata: staged.httpMetadata,
      customMetadata: staged.customMetadata,
      ...(sha256 === undefined ? {} : { sha256 }),
    }),
    digesting,
  ]);
  await env.R2_BUCKET.delete(key);
  return { object, digests };
}

/** {@link promoteStagedWithDigests} without extra digests; returns the new object. */
export async function promoteStaged(
  env: StorageEnv,
  uploadId: string,
  fileName: string,
  targetKey: string,
  options: { sha256?: string } = {},
): Promise<R2Object | null> {
  const promoted = await promoteStagedWithDigests(env, uploadId, fileName, targetKey, options);
  return promoted === null ? null : promoted.object;
}

/** Records the result of a successful `commit` for idempotent retries. */
export async function writeStagingResult(
  env: StorageEnv,
  uploadId: string,
  result: StagingResult,
): Promise<void> {
  await env.R2_BUCKET.put(stagingResultKey(uploadId), JSON.stringify(result), {
    httpMetadata: { contentType: JSON_TYPE },
  });
}

/** Reads the recorded result of a `commit`; `null` when missing or malformed. */
export async function readStagingResult(
  env: StorageEnv,
  uploadId: string,
): Promise<StagingResult | null> {
  const value = await readJson(env, stagingResultKey(uploadId));
  return isStagingResult(value) ? value : null;
}

/** Deletes everything under `_staging/<upload-id>/`; returns how many objects were deleted. */
export async function deleteStaging(env: StorageEnv, uploadId: string): Promise<number> {
  const objects = await listAll(env, stagingPrefix(uploadId));
  return deleteKeys(
    env,
    objects.map((o) => o.key),
  );
}

/**
 * Upload ids whose staging prefix is older than `olderThan`: by `createdAt` of `meta.json`, or,
 * when the meta is missing or unreadable, by the newest `uploaded` of the prefix's objects.
 */
export async function listStaleStaging(env: StorageEnv, olderThan: Date): Promise<string[]> {
  const groups = new Map<string, { newest: Date; hasMeta: boolean }>();
  for (const object of await listAll(env, STAGING_PREFIX)) {
    const rest = object.key.slice(STAGING_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) continue;
    const uploadId = rest.slice(0, slash);
    const group = groups.get(uploadId) ?? { newest: object.uploaded, hasMeta: false };
    if (object.uploaded > group.newest) group.newest = object.uploaded;
    if (object.key === stagingMetaKey(uploadId)) group.hasMeta = true;
    groups.set(uploadId, group);
  }
  const stale: string[] = [];
  for (const [uploadId, group] of groups) {
    const meta = group.hasMeta ? await readStagingMeta(env, uploadId) : null;
    const created = meta === null ? NaN : Date.parse(meta.createdAt);
    const age = Number.isNaN(created) ? group.newest.getTime() : created;
    if (age < olderThan.getTime()) stale.push(uploadId);
  }
  return stale.sort();
}
