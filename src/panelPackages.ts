/**
 * Data of the panel's package routes (docs/spec.md "Home page and panel"): one package, one
 * version and a file download, each checked against the session identity the same way the
 * native routes check a token. `read` sees the packages of its explicit grants and those its
 * transitive grants open, `admin` sees everything; `publish` sees nothing (the callers answer
 * it before asking). Functions answer `null` for anything the identity may not see, so a
 * hidden package and a missing one look the same. Names of the ecosystems that compare them
 * case-insensitively (npm, Composer, NuGet, Swift) are found in any casing.
 */

import { getAdapter } from "./adapters/index";
import type { Adapter, Manifest } from "./adapters/types";
import { toPackageVersion } from "./core/admin";
import { hasRole, type Identity } from "./core/auth";
import { accessFor, allowsVersion } from "./core/closure";
import { presignConfig } from "./core/config";
import { ValidationError } from "./core/errors";
import { foldCase } from "./core/grants";
import { allDependencies, getPackage, type PackageView } from "./core/packages";
import { presignGet } from "./core/presign";
import { fileKey, listManifests, readManifest } from "./core/storage";
import type { Env } from "./env";
import type { PackageDetails } from "./pages/package";
import type { VersionFile, VersionPageData } from "./pages/version";

/** A package the identity may see. */
export interface VisiblePackage {
  adapter: Adapter;
  view: PackageView;
  /** Visible only through the closure of a transitive grant, not an explicit one. */
  transitive: boolean;
  /** What the package page shows from the highest visible version's manifest. */
  details: PackageDetails;
}

function isNotFound(err: unknown): boolean {
  return err instanceof ValidationError && err.code === "not_found";
}

/**
 * The stored name of a package typed in any casing: the adapter's `storedName` (NuGet, Swift),
 * else the name folded as grants compare it (npm and Composer names are stored in lower case;
 * cargo, generic and Maven names are kept as typed).
 */
function storedName(adapter: Adapter, name: string): string {
  return adapter.storedName?.(name) ?? foldCase(adapter.eco, name);
}

/** The page details taken from the manifest of a package's highest visible version. */
function detailsOf(manifest: Manifest): PackageDetails {
  if (manifest.eco !== "generic") return {};
  const details: PackageDetails = {};
  const labelled = manifest.files.find((f) => Object.keys(f.labels ?? {}).length > 0);
  const [key, value] = Object.entries(labelled?.labels ?? {})[0] ?? [];
  if (key !== undefined && value !== undefined) details.label = { key, value };
  return details;
}

/**
 * The details of a package whose versions are listed highest first; only generic packages have
 * any, so other ecosystems skip reading the manifest.
 */
async function packageDetails(
  env: Env,
  adapter: Adapter,
  stored: string,
  view: PackageView,
): Promise<PackageDetails> {
  const top = view.versions[0];
  if (adapter.eco !== "generic" || top === undefined) return {};
  const manifest = await readManifest(env, adapter.eco, stored, top.version);
  return manifest === null ? {} : detailsOf(manifest);
}

/**
 * The package with the versions the identity may see, highest first: through an explicit grant
 * (with the dependencies the grant opens, as in the package listing; for `admin` what any
 * version depends on), or for `read` through the closure of a transitive grant (no
 * dependencies).
 */
export async function visiblePackage(
  env: Env,
  identity: Identity,
  eco: string,
  name: string,
): Promise<VisiblePackage | null> {
  const adapter = getAdapter(env, eco);
  if (adapter === null || !hasRole(identity, "read", "admin", "yank", "delete")) return null;
  const stored = storedName(adapter, name);
  try {
    const found = await getPackage(env, identity, eco, stored);
    // An admin has no grants: the page lists what any version depends on instead.
    const view = hasRole(identity, "admin")
      ? { ...found, dependencies: await allDependencies(env, adapter, stored) }
      : found;
    const details = await packageDetails(env, adapter, stored, view);
    return { adapter, view, transitive: false, details };
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  if (!hasRole(identity, "read")) return null;
  const access = await accessFor(env, identity, adapter.eco, adapter);
  if (!access.listable(stored)) return null;
  const manifests = await listManifests(env, adapter.eco, stored, adapter.compareVersions);
  const visible = manifests.filter((m) => access.allows(m.name, m.version));
  const highest = visible[visible.length - 1];
  if (highest === undefined) return null;
  const shown = adapter.displayName?.(highest) ?? stored;
  const versions = visible.map(toPackageVersion).reverse();
  return {
    adapter,
    view: { eco: adapter.eco, name: shown, versions },
    transitive: true,
    details: detailsOf(highest),
  };
}

/**
 * The native download URL of a file: `null` when the adapter has no endpoint for this file,
 * `undefined` when it has none at all (it throws, like the placeholder adapters).
 */
function nativeUrl(
  adapter: Adapter,
  ...args: Parameters<Adapter["fileUrl"]>
): string | null | undefined {
  try {
    return adapter.fileUrl(...args);
  } catch {
    return undefined;
  }
}

/** One version the identity may see, with its files; `null` otherwise. */
export async function visibleVersion(
  env: Env,
  identity: Identity,
  eco: string,
  name: string,
  version: string,
  publicUrl: string,
): Promise<VersionPageData | null> {
  const adapter = getAdapter(env, eco);
  if (adapter === null || !hasRole(identity, "read", "admin") || version.includes("/")) return null;
  const stored = storedName(adapter, name);
  if (!(await allowsVersion(env, identity, adapter.eco, adapter, stored, version))) return null;
  const manifest = await readManifest(env, adapter.eco, stored, version);
  if (manifest === null) return null;
  const files: VersionFile[] = manifest.files.map((file) => {
    const url = nativeUrl(adapter, manifest, file, publicUrl);
    return url === undefined ? { ...file } : { ...file, nativeUrl: url };
  });
  const shown = adapter.displayName?.(manifest) ?? manifest.name;
  return {
    eco: adapter.eco,
    name: shown,
    version: manifest.version,
    published: manifest.published,
    yanked: manifest.yanked,
    files,
    ...(manifest.eco === "generic" ? { meta: manifest.native } : {}),
    snippets: adapter.versionSnippets?.(publicUrl, shown, manifest.version) ?? [],
  };
}

/** `attachment; filename="<name>"` with quotes and backslashes replaced. */
function attachment(file: string): string {
  return `attachment; filename="${file.replace(/["\\]/g, "_")}"`;
}

/**
 * A presigned `GET` URL (15 minutes) of one file of a version the identity may see; `null`
 * when the version or the file is not visible or does not exist. Works for every ecosystem:
 * the key comes from the storage layout, not the adapter.
 */
export async function downloadUrl(
  env: Env,
  identity: Identity,
  eco: string,
  name: string,
  version: string,
  file: string,
  now: Date,
): Promise<string | null> {
  const adapter = getAdapter(env, eco);
  if (adapter === null || !hasRole(identity, "read", "admin") || version.includes("/")) return null;
  const stored = storedName(adapter, name);
  if (!(await allowsVersion(env, identity, adapter.eco, adapter, stored, version))) return null;
  const manifest = await readManifest(env, adapter.eco, stored, version);
  const entry = manifest?.files.find((f) => f.name === file);
  if (manifest === null || entry === undefined) return null;
  const signed = await presignGet({
    ...presignConfig(env),
    key: fileKey(adapter.eco, manifest.name, manifest.version, entry.name),
    responseContentDisposition: attachment(entry.name),
    now,
  });
  return signed.url;
}
