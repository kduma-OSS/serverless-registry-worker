/**
 * Package listing for the home page, the panel and the CLI (docs/api.md 6.6–6.7). `read`
 * credentials see only the versions their explicit grants cover, and under each package the
 * dependencies its grant opens transitively (5.3); `admin` sees everything; `publish`
 * credentials may not list packages.
 */

import { enabledAdapters, getAdapter } from "../adapters/index";
import type { Adapter, Eco, Manifest } from "../adapters/types";
import type { Env } from "../env";
import { toPackageVersion, type PackageVersion } from "./admin";
import { hasRole, requireRole, type Identity } from "./auth";
import {
  DependencyGraph,
  needsClosure,
  transitiveSources,
  walkDependencies,
  type VersionRef,
} from "./closure";
import { ValidationError } from "./errors";
import { isAllowed, isPackageAllowed } from "./grants";
import { listManifests, listVersionNames, readManifest, readPackagesMeta } from "./storage";

export type PackagesEnv = Pick<Env, "R2_BUCKET" | "ECOSYSTEMS">;

/** A package that a grant opens transitively (docs/api.md 5.3 and 6.6). */
export interface PackageDependency {
  name: string;
  /** The distinct declared constraints that lead to the package, as written. */
  constraints: string[];
  /** The versions opened, highest first. */
  versions: string[];
}

/** One package with the versions the caller may see, highest first. */
export interface PackageView {
  eco: Eco;
  /**
   * Decoded name, e.g. `@acme/sdk`; for NuGet and Swift with the casing of the highest visible
   * version's manifest (docs/api.md 6.6).
   */
  name: string;
  versions: PackageVersion[];
  /** `read` only: what the package's grant opens transitively, sorted by name. */
  dependencies?: PackageDependency[];
}

/** A package as the admin's list shows it: the versions, highest first, and whether the top one is yanked. */
export interface PackageSummary {
  eco: Eco;
  name: string;
  versions: { version: string; yanked?: boolean }[];
}

function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether the caller may see the package at all (any version). */
function mayList(identity: Identity, eco: Eco, name: string): boolean {
  return hasRole(identity, "admin") || isPackageAllowed(identity.grants.read, eco, name);
}

/** The manifests of a package the caller may see, lowest version first; yanked ones included. */
function visibleManifests(
  identity: Identity,
  adapter: Adapter,
  manifests: readonly Manifest[],
): Manifest[] {
  return manifests.filter(
    (m) =>
      hasRole(identity, "admin") ||
      isAllowed(identity.grants.read, adapter.eco, m.name, m.version, adapter.satisfies),
  );
}

/**
 * The name a listing shows: the adapter's display name from the manifest of the highest
 * visible version (NuGet and Swift: the casing it was published with), else the stored name.
 */
function listedName(adapter: Adapter, name: string, visible: readonly Manifest[]): string {
  const highest = visible[visible.length - 1];
  if (highest === undefined || adapter.displayName === undefined) return name;
  return adapter.displayName(highest);
}

/**
 * What a walk from `sources` (versions of `name`) reaches, direct and indirect, flattened and
 * sorted by name (byte order); the package itself and packages without an admitted version are
 * left out.
 */
function reachedFrom(
  graph: DependencyGraph,
  name: string,
  sources: readonly VersionRef[],
): PackageDependency[] {
  if (sources.length === 0) return [];
  const reached = walkDependencies(graph, sources);
  const compare = graph.adapter.compareVersions;
  return [...reached.entries()]
    .filter(([dep, entry]) => dep !== name && entry.versions.size > 0)
    .sort(([a], [b]) => byteOrder(a, b))
    .map(([dep, entry]) => ({
      name: dep,
      constraints: entry.constraints,
      versions: [...entry.versions].sort((a, b) => compare(b, a)),
    }));
}

/** The packages and versions that the transitive grants covering a package open from it. */
function dependenciesOf(
  graph: DependencyGraph,
  identity: Identity,
  name: string,
): PackageDependency[] {
  return reachedFrom(graph, name, transitiveSources(graph, identity, name));
}

/**
 * Every package of this registry that any version of a package (yanked included) depends on,
 * directly or through other packages, with the constraints that lead to it and the versions
 * they admit: what the admin's package page shows. `name` is the stored name.
 */
export async function allDependencies(
  env: PackagesEnv,
  adapter: Adapter,
  name: string,
): Promise<PackageDependency[]> {
  const graph = await DependencyGraph.load(env, adapter);
  const stored = graph.resolve(name) ?? name;
  const sources = graph.versions(stored).map((version) => ({ name: stored, version }));
  return reachedFrom(graph, stored, sources);
}

/** The dependency graph when the identity has transitive grants in the ecosystem, else `null`. */
async function graphFor(
  env: PackagesEnv,
  identity: Identity,
  adapter: Adapter,
): Promise<DependencyGraph | null> {
  return needsClosure(identity, adapter.eco) ? DependencyGraph.load(env, adapter) : null;
}

async function packageView(
  env: PackagesEnv,
  adapter: Adapter,
  graph: DependencyGraph | null,
  identity: Identity,
  name: string,
): Promise<PackageView> {
  const manifests = await listManifests(env, adapter.eco, name, adapter.compareVersions);
  const visible = visibleManifests(identity, adapter, manifests);
  const view: PackageView = {
    eco: adapter.eco,
    name: listedName(adapter, name, visible),
    versions: visible.map(toPackageVersion).reverse(),
  };
  if (hasRole(identity, "read") && view.versions.length > 0) {
    view.dependencies = graph === null ? [] : dependenciesOf(graph, identity, name);
  }
  return view;
}

/**
 * `GET /api/v1/packages`: every package of the enabled ecosystems with at least one visible
 * version, sorted by ecosystem and name (byte order).
 */
export async function listPackages(
  env: PackagesEnv,
  identity: Identity,
): Promise<{ packages: PackageView[] }> {
  requireRole(identity, "read", "admin");
  const meta = await readPackagesMeta(env);
  const adapters = enabledAdapters(env).sort((a, b) => byteOrder(a.eco, b.eco));
  const packages: PackageView[] = [];
  for (const adapter of adapters) {
    const names = Object.keys(meta[adapter.eco])
      .filter((name) => mayList(identity, adapter.eco, name))
      .sort(byteOrder);
    if (names.length === 0) continue;
    const graph = await graphFor(env, identity, adapter);
    const views = await Promise.all(
      names.map((name) => packageView(env, adapter, graph, identity, name)),
    );
    packages.push(...views.filter((view) => view.versions.length > 0));
  }
  return { packages };
}

/**
 * `GET /api/v1/packages/<eco>/<name>`: one package; `404` when it does not exist or, for
 * `read`, when no version of it is covered by an explicit grant (a package reachable only
 * transitively is listed under the `dependencies` of its source package instead).
 */
export async function getPackage(
  env: PackagesEnv,
  identity: Identity,
  eco: string,
  name: string,
): Promise<PackageView> {
  requireRole(identity, "read", "admin");
  const notFound = new ValidationError("not_found", "Package not found.");
  const adapter = getAdapter(env, eco);
  if (adapter === null) throw notFound;
  const stored = adapter.storedName?.(name) ?? name;
  if (!mayList(identity, adapter.eco, stored)) throw notFound;
  const graph = await graphFor(env, identity, adapter);
  const view = await packageView(env, adapter, graph, identity, stored);
  if (view.versions.length === 0) throw notFound;
  return view;
}

/**
 * The packages of the home page and the admin's list, without their manifests: `admin` sees
 * every package, `read` those with a version its explicit grants cover. A package costs one
 * listing and one read (the highest visible version's manifest, for its display name and
 * `yanked` flag) however many versions it has, so the page stays within the limit on the calls
 * to R2 that a single request may make. Only the highest version is described; the others
 * carry just their number.
 */
export async function listPackageSummaries(
  env: PackagesEnv,
  identity: Identity,
): Promise<PackageSummary[]> {
  requireRole(identity, "read", "admin");
  const meta = await readPackagesMeta(env);
  const summaries: PackageSummary[] = [];
  for (const adapter of enabledAdapters(env).sort((a, b) => byteOrder(a.eco, b.eco))) {
    const names = Object.keys(meta[adapter.eco])
      .filter((name) => mayList(identity, adapter.eco, name))
      .sort(byteOrder);
    const found = await Promise.all(
      names.map(async (name): Promise<PackageSummary | null> => {
        const versions = (
          await listVersionNames(env, adapter.eco, name, adapter.compareVersions)
        ).filter(
          (version) =>
            hasRole(identity, "admin") ||
            isAllowed(identity.grants.read, adapter.eco, name, version, adapter.satisfies),
        );
        const top = versions[versions.length - 1];
        if (top === undefined) return null;
        const manifest = await readManifest(env, adapter.eco, name, top);
        return {
          eco: adapter.eco,
          name: manifest === null ? name : listedName(adapter, name, [manifest]),
          versions: versions
            .reverse()
            .map((version, i) =>
              i === 0 ? { version, yanked: manifest?.yanked ?? false } : { version },
            ),
        };
      }),
    );
    summaries.push(...found.filter((p) => p !== null));
  }
  return summaries;
}
