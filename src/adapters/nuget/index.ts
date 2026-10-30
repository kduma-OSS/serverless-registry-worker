/**
 * NuGet adapter (see "NuGet" in docs/spec.md and the NuGet feed in docs/api.md section 9):
 * validates the package metadata the CLI reads from the `.nuspec`, stores versions in their
 * normalised form and serves the NuGet V3 protocol: the service index, the flat container
 * (version list, `.nupkg` downloads, `.nuspec`), an inlined registration index and a simple
 * search.
 *
 * Package ids are case-insensitive. The manifest's `name` is the lower-cased id, so R2 keys,
 * `_meta/packages.json` and grant checks all use one spelling; the id as published (original
 * casing) is kept in `native.id` and served in the registration and search responses.
 */

import { ValidationError } from "../../core/errors";
import { fileKey, indexKey } from "../../core/storage";
import {
  RawIndexBody,
  archiveFileOf,
  type Adapter,
  type Dependency,
  type IndexContext,
  type IndexFile,
  type IndexRoute,
  type ListingContext,
  type Manifest,
  type ManifestFile,
  type NativeRoute,
  type PublishInit,
  type Snippet,
} from "../types";
import {
  compareNuGetVersions,
  isNuGetPrerelease,
  isValidNuGetRange,
  isValidNuGetVersion,
  normalizeNuGetVersion,
  satisfiesNuGetRange,
} from "./version";

type Json = Record<string, unknown>;

/** NuGet package ids as the registry accepts them (docs/api.md 6.4). */
export const NUGET_ID_RE = /^[A-Za-z0-9_.-]{1,100}$/;

const JSON_TYPE = "application/json";
const XML_TYPE = "application/xml; charset=utf-8";

/** Default and parameters of the search (docs/api.md 9.7). */
export const DEFAULT_TAKE = 20;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new ValidationError("invalid_request", message);
}

function notFound(): never {
  throw new ValidationError("not_found");
}

function malformed(): never {
  throw new ValidationError("internal_error", "A stored NuGet index is malformed.");
}

// ---------------------------------------------------------------------------------------------
// Keys and URLs
// ---------------------------------------------------------------------------------------------

/** `nuget/index/<id>/<file>` with the id in lower case. */
export function nugetIndexKey(id: string, file: "flat.json" | "registration.json" | "nuspec.json") {
  return indexKey("nuget", id.toLowerCase(), file);
}

/** `<publicUrl>/nuget/flat/<id>/<ver>/<id>.<ver>.nupkg`, in lower case. */
export function packageContentUrl(publicUrl: string, id: string, version: string): string {
  const lower = id.toLowerCase();
  const ver = version.toLowerCase();
  return `${publicUrl}/nuget/flat/${lower}/${ver}/${lower}.${ver}.nupkg`;
}

/** `<publicUrl>/nuget/registration/<id>/index.json`, in lower case. */
export function registrationUrl(publicUrl: string, id: string): string {
  return `${publicUrl}/nuget/registration/${id.toLowerCase()}/index.json`;
}

// ---------------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------------

/** One dependency group of the package metadata (docs/api.md 6.4). */
export interface DependencyGroup {
  targetFramework: string | null;
  dependencies: { id: string; range: string }[];
}

/** `native` of a NuGet manifest: the package metadata as normalised by the adapter. */
export interface NuGetNative {
  id: string;
  version: string;
  nuspec: string;
  description?: string;
  authors?: string;
  projectUrl?: string;
  licenseExpression?: string;
  tags?: string[];
  dependencyGroups: DependencyGroup[];
}

const OPTIONAL_STRINGS = ["description", "authors", "projectUrl", "licenseExpression"] as const;

function parseDependencyGroups(value: unknown): DependencyGroup[] {
  if (!Array.isArray(value)) invalid("`manifest.dependencyGroups` must be an array.");
  return value.map((group: unknown, i): DependencyGroup => {
    const where = `manifest.dependencyGroups[${i}]`;
    if (!isRecord(group)) invalid(`\`${where}\` must be an object.`);
    const { targetFramework = null, dependencies } = group;
    if (targetFramework !== null && (typeof targetFramework !== "string" || !targetFramework)) {
      invalid(`\`${where}.targetFramework\` must be a non-empty string or null.`);
    }
    if (!Array.isArray(dependencies)) invalid(`\`${where}.dependencies\` must be an array.`);
    return {
      targetFramework,
      dependencies: dependencies.map((dep: unknown, j) => {
        if (!isRecord(dep) || typeof dep.id !== "string" || !NUGET_ID_RE.test(dep.id)) {
          invalid(`\`${where}.dependencies[${j}].id\` must be a package id.`);
        }
        if (typeof dep.range !== "string") {
          invalid(`\`${where}.dependencies[${j}].range\` must be a string.`);
        }
        return { id: dep.id, range: dep.range };
      }),
    };
  });
}

function parseNative(input: PublishInit): NuGetNative {
  const m = input.manifest;
  if (!isRecord(m)) invalid("`manifest` must be the package metadata object.");
  if (m.id !== input.name) invalid("`manifest.id` must equal `name`.");
  if (m.version !== input.version) invalid("`manifest.version` must equal `version`.");
  if (typeof m.nuspec !== "string" || m.nuspec.trim() === "") {
    invalid("`manifest.nuspec` must be the .nuspec XML.");
  }
  const native: NuGetNative = {
    id: input.name,
    version: input.version,
    nuspec: m.nuspec,
    dependencyGroups: parseDependencyGroups(m.dependencyGroups),
  };
  for (const field of OPTIONAL_STRINGS) {
    const value = m[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") invalid(`\`manifest.${field}\` must be a string.`);
    native[field] = value;
  }
  if (m.tags !== undefined && m.tags !== null) {
    if (!Array.isArray(m.tags) || !m.tags.every((t) => typeof t === "string")) {
      invalid("`manifest.tags` must be an array of strings.");
    }
    native.tags = m.tags;
  }
  return native;
}

/** The `.nupkg` (role `archive`) and the optional `.snupkg` (role `symbols`) of an upload. */
function parseFiles(input: PublishInit, version: string): ManifestFile[] {
  const { files } = input;
  const single = files.length === 1 ? archiveFileOf(files) : null;
  if (single === null) {
    const roles = files.map((f) => f.role);
    const ok =
      files.length === 2 &&
      roles.filter((r) => r === "archive").length === 1 &&
      roles.filter((r) => r === "symbols").length === 1;
    if (!ok) invalid("A NuGet version has one .nupkg (`archive`) and optionally one .snupkg.");
  }
  const id = input.name.toLowerCase();
  const sent = input.version.toLowerCase();
  const bases = new Set([sent, sent.split("+")[0] ?? sent, version].map((v) => `${id}.${v}`));
  const archive = single ?? files.find((f) => f.role === "archive");
  if (archive === undefined) invalid("The .nupkg file is missing.");
  const base = archive.name.endsWith(".nupkg") ? archive.name.slice(0, -".nupkg".length) : "";
  if (!bases.has(base)) {
    invalid(`The .nupkg must be named ${id}.${version}.nupkg (lower case).`);
  }
  const out: ManifestFile[] = [
    { name: archive.name, size: archive.size, sha256: archive.sha256, role: "archive" },
  ];
  const symbols = files.find((f) => f.role === "symbols");
  if (symbols !== undefined) {
    if (symbols.name !== `${base}.snupkg`) {
      invalid(`The symbols package must be named ${base}.snupkg.`);
    }
    out.push({ name: symbols.name, size: symbols.size, sha256: symbols.sha256, role: "symbols" });
  }
  return out;
}

function parseManifest(input: PublishInit): Manifest {
  const { name, version } = input;
  if (typeof name !== "string" || !NUGET_ID_RE.test(name)) {
    invalid("`name` must be a NuGet package id, [A-Za-z0-9_.-]{1,100}.");
  }
  if (typeof version !== "string" || !isValidNuGetVersion(version)) {
    invalid("`version` must be a NuGet version.");
  }
  if (input.tag !== undefined) invalid("`tag` is only accepted for npm.");
  const normalised = normalizeNuGetVersion(version);
  const native = parseNative(input);
  return {
    eco: "nuget",
    name: name.toLowerCase(),
    version: normalised,
    files: parseFiles(input, normalised),
    published: "",
    publishedBy: "",
    yanked: false,
    native: { ...native },
  };
}

/** The package metadata of a stored manifest (tolerant of hand-edited manifests). */
function nativeOf(m: Manifest): NuGetNative {
  const n = m.native;
  const groups = Array.isArray(n.dependencyGroups) ? n.dependencyGroups : [];
  const out: NuGetNative = {
    id: typeof n.id === "string" ? n.id : m.name,
    version: typeof n.version === "string" ? n.version : m.version,
    nuspec: typeof n.nuspec === "string" ? n.nuspec : "",
    dependencyGroups: groups.filter(isRecord).map((g) => ({
      targetFramework: typeof g.targetFramework === "string" ? g.targetFramework : null,
      dependencies: (Array.isArray(g.dependencies) ? g.dependencies : [])
        .filter(isRecord)
        .filter((d) => typeof d.id === "string" && typeof d.range === "string")
        .map((d) => ({ id: String(d.id), range: String(d.range) })),
    })),
  };
  for (const field of OPTIONAL_STRINGS) {
    const value = n[field];
    if (typeof value === "string") out[field] = value;
  }
  if (Array.isArray(n.tags)) out.tags = n.tags.filter((t) => typeof t === "string");
  return out;
}

/** The id as published (`native.id`), or the stored lower-case name. */
function displayName(m: Manifest): string {
  const id = m.native.id;
  return typeof id === "string" && id.toLowerCase() === m.name.toLowerCase() ? id : m.name;
}

/** Every `dependencyGroups[].dependencies[]` entry with its range (docs/api.md 5.3). */
function dependencies(m: Manifest): Dependency[] {
  return nativeOf(m).dependencyGroups.flatMap((g) =>
    g.dependencies.map((d) => ({ name: d.id, constraint: d.range })),
  );
}

// ---------------------------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------------------------

/** The stored flat container index: `{ name, versions }`, ascending, yanked included. */
interface StoredFlat {
  name: string;
  versions: string[];
}

/** The stored `.nuspec` files: `{ name, nuspecs: { <version>: <xml> } }`. */
interface StoredNuspecs {
  name: string;
  nuspecs: Record<string, string>;
}

function catalogEntry(m: Manifest, publicUrl: string): Json {
  const native = nativeOf(m);
  const leaf = `${registrationUrl(publicUrl, m.name)}#${m.version}`;
  const entry: Json = {
    "@id": leaf,
    id: native.id,
    version: m.version,
    listed: !m.yanked,
    published: m.published,
    packageContent: packageContentUrl(publicUrl, m.name, m.version),
    dependencyGroups: native.dependencyGroups.map((g) => ({
      ...(g.targetFramework === null ? {} : { targetFramework: g.targetFramework }),
      dependencies: g.dependencies,
    })),
  };
  if (native.description !== undefined) entry.description = native.description;
  if (native.authors !== undefined) entry.authors = native.authors;
  if (native.tags !== undefined) entry.tags = native.tags;
  return entry;
}

function leafOf(m: Manifest, publicUrl: string): Json {
  return {
    "@id": `${registrationUrl(publicUrl, m.name)}#${m.version}`,
    packageContent: packageContentUrl(publicUrl, m.name, m.version),
    catalogEntry: catalogEntry(m, publicUrl),
  };
}

/** The registration index with one inlined page holding `leaves` (ascending, non-empty). */
function registrationIndex(base: string, leaves: Json[]): Json {
  const versionOf = (leaf: Json | undefined) =>
    isRecord(leaf?.catalogEntry) ? String(leaf.catalogEntry.version) : "";
  const lower = versionOf(leaves[0]);
  const upper = versionOf(leaves[leaves.length - 1]);
  return {
    count: 1,
    items: [
      {
        "@id": `${base}#page/${lower}/${upper}`,
        count: leaves.length,
        lower,
        upper,
        items: leaves,
      },
    ],
  };
}

function buildIndex(name: string, manifests: Manifest[], ctx: IndexContext): IndexFile[] {
  const id = name.toLowerCase();
  const sorted = manifests
    .filter((m) => m.name.toLowerCase() === id)
    .sort((a, b) => compareNuGetVersions(a.version, b.version));
  const flat: StoredFlat = { name: id, versions: sorted.map((m) => m.version) };
  const nuspecs: StoredNuspecs = {
    name: id,
    nuspecs: Object.fromEntries(sorted.map((m) => [m.version, nativeOf(m).nuspec])),
  };
  const leaves = sorted.map((m) => leafOf(m, ctx.publicUrl));
  const registration = registrationIndex(registrationUrl(ctx.publicUrl, id), leaves);
  return [
    { key: nugetIndexKey(id, "flat.json"), body: JSON.stringify(flat), contentType: JSON_TYPE },
    {
      key: nugetIndexKey(id, "registration.json"),
      body: JSON.stringify(registration),
      contentType: JSON_TYPE,
    },
    {
      key: nugetIndexKey(id, "nuspec.json"),
      body: JSON.stringify(nuspecs),
      contentType: JSON_TYPE,
    },
  ];
}

/** A registration leaf whose catalog entry has an id and a version. */
interface Leaf extends Json {
  "@id": string;
  catalogEntry: Json & { id: string; version: string; listed?: unknown };
}

function isLeaf(value: unknown): value is Leaf {
  return (
    isRecord(value) &&
    typeof value["@id"] === "string" &&
    isRecord(value.catalogEntry) &&
    typeof value.catalogEntry.id === "string" &&
    typeof value.catalogEntry.version === "string"
  );
}

/**
 * The leaves of a stored registration index the caller may see, ascending, and the URL of the
 * index; `null` when the body is not a registration index.
 */
function visibleLeaves(
  body: unknown,
  allowed: (name: string, version: string) => boolean,
): { base: string; leaves: Leaf[] } | null {
  if (!isRecord(body) || !Array.isArray(body.items)) return null;
  const pages = body.items.filter(isRecord);
  const first = pages[0]?.["@id"];
  if (typeof first !== "string") return null;
  const leaves = pages
    .flatMap((page) => (Array.isArray(page.items) ? page.items : []))
    .filter(isLeaf)
    .filter((leaf) => allowed(leaf.catalogEntry.id.toLowerCase(), leaf.catalogEntry.version));
  return { base: first.split("#")[0] ?? first, leaves };
}

function filterIndex(
  body: unknown,
  allowed: (name: string, version: string) => boolean,
  route?: IndexRoute,
): unknown {
  if (!isRecord(body)) malformed();
  if (Array.isArray(body.items)) {
    const visible = visibleLeaves(body, allowed);
    if (visible === null) malformed();
    if (visible.leaves.length === 0) notFound();
    return registrationIndex(visible.base, visible.leaves);
  }
  if (typeof body.name !== "string") malformed();
  const name = body.name;
  if (isRecord(body.nuspecs)) {
    const version = route?.selector?.version;
    const nuspec = version === undefined ? undefined : body.nuspecs[version];
    if (version === undefined || typeof nuspec !== "string" || !allowed(name, version)) {
      notFound();
    }
    return new RawIndexBody(nuspec, XML_TYPE);
  }
  if (Array.isArray(body.versions)) {
    const versions = body.versions.filter(
      (v): v is string => typeof v === "string" && allowed(name, v),
    );
    if (versions.length === 0) notFound();
    return { versions };
  }
  malformed();
}

// ---------------------------------------------------------------------------------------------
// Routing, service index and search
// ---------------------------------------------------------------------------------------------

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** A path id: a valid package id, lower-cased; `null` otherwise. */
function pathId(segment: string): string | null {
  const id = decodeSegment(segment);
  return id !== null && NUGET_ID_RE.test(id) ? id.toLowerCase() : null;
}

function parseCount(value: string | null, name: string, fallback: number): number {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) invalid(`\`${name}\` must be a non-negative integer.`);
  return Math.min(Number(value), Number.MAX_SAFE_INTEGER);
}

function parseSearch(url: URL): Record<string, string | number | boolean> {
  const params = url.searchParams;
  const prerelease = (params.get("prerelease") ?? "false").toLowerCase();
  if (prerelease !== "true" && prerelease !== "false") {
    invalid("`prerelease` must be `true` or `false`.");
  }
  return {
    q: (params.get("q") ?? "").trim(),
    skip: parseCount(params.get("skip"), "skip", 0),
    take: parseCount(params.get("take"), "take", DEFAULT_TAKE),
    prerelease: prerelease === "true",
  };
}

const FLAT_INDEX_RE = /^\/nuget\/flat\/([^/]+)\/index\.json$/;
const FLAT_FILE_RE = /^\/nuget\/flat\/([^/]+)\/([^/]+)\/([^/]+)$/;
const REGISTRATION_RE = /^\/nuget\/registration\/([^/]+)\/index\.json$/;

function route(req: Request, url: URL): NativeRoute | null {
  if (req.method !== "GET") return null;
  const path = url.pathname;
  if (path === "/nuget/index.json") return { kind: "listing", listing: "service" };
  if (path === "/nuget/search") {
    return { kind: "listing", listing: "search", options: parseSearch(url) };
  }
  const flat = FLAT_INDEX_RE.exec(path);
  if (flat) {
    const id = pathId(flat[1] ?? "");
    return id === null ? null : { kind: "index", key: nugetIndexKey(id, "flat.json"), name: id };
  }
  const registration = REGISTRATION_RE.exec(path);
  if (registration) {
    const id = pathId(registration[1] ?? "");
    if (id === null) return null;
    return { kind: "index", key: nugetIndexKey(id, "registration.json"), name: id };
  }
  const file = FLAT_FILE_RE.exec(path);
  if (file) {
    const id = pathId(file[1] ?? "");
    const ver = decodeSegment(file[2] ?? "");
    const fileName = decodeSegment(file[3] ?? "")?.toLowerCase();
    if (id === null || ver === null || !isValidNuGetVersion(ver)) return null;
    const version = normalizeNuGetVersion(ver);
    if (fileName === `${id}.nuspec`) {
      return {
        kind: "index",
        key: nugetIndexKey(id, "nuspec.json"),
        name: id,
        selector: { version },
      };
    }
    if (fileName === `${id}.${ver.toLowerCase()}.nupkg`) {
      return { kind: "archive", name: id, version, file: null };
    }
  }
  return null;
}

function serviceIndex(publicUrl: string): Json {
  return {
    version: "3.0.0",
    resources: [
      { "@id": `${publicUrl}/nuget/flat/`, "@type": "PackageBaseAddress/3.0.0" },
      { "@id": `${publicUrl}/nuget/registration/`, "@type": "RegistrationsBaseUrl/3.6.0" },
      { "@id": `${publicUrl}/nuget/search`, "@type": "SearchQueryService/3.5.0" },
    ],
  };
}

/** One search result: the considered versions of a package, or `null` when there are none. */
async function searchResult(
  name: string,
  ctx: ListingContext,
  prerelease: boolean,
): Promise<Json | null> {
  const visible = visibleLeaves(
    await ctx.readIndex(nugetIndexKey(name, "registration.json")),
    ctx.allowed,
  );
  if (visible === null) return null;
  const considered = visible.leaves.filter(
    (leaf) =>
      leaf.catalogEntry.listed !== false &&
      (prerelease || !isNuGetPrerelease(leaf.catalogEntry.version)),
  );
  const highest = considered[considered.length - 1]?.catalogEntry;
  if (highest === undefined) return null;
  const registration = registrationUrl(ctx.publicUrl, name);
  const result: Json = {
    "@id": registration,
    id: highest.id,
    version: highest.version,
  };
  for (const field of ["description", "authors", "tags"] as const) {
    if (highest[field] !== undefined) result[field] = highest[field];
  }
  result.registration = registration;
  result.totalDownloads = 0;
  result.versions = considered.map((leaf) => ({
    version: leaf.catalogEntry.version,
    downloads: 0,
    "@id": leaf["@id"],
  }));
  return result;
}

async function search(packages: string[], ctx: ListingContext): Promise<Json> {
  const { q = "", skip = 0, take = DEFAULT_TAKE, prerelease = false } = ctx.route.options ?? {};
  const query = String(q).toLowerCase();
  const names = packages.filter((name) => name.toLowerCase().includes(query)).sort();
  const results = (
    await Promise.all(names.map((name) => searchResult(name, ctx, prerelease === true)))
  ).filter((r) => r !== null);
  const start = Number(skip);
  return { totalHits: results.length, data: results.slice(start, start + Number(take)) };
}

function buildListing(packages: string[], ctx: ListingContext): unknown {
  switch (ctx.route.listing) {
    case "service":
      return serviceIndex(ctx.publicUrl);
    case "search":
      return search(packages, ctx);
    default:
      return notFound();
  }
}

// ---------------------------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------------------------

function xmlAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** A `nuget.config` with the source `sreg` and its clear-text credentials. */
/**
 * `<packageSourceMapping>` that pins the granted package IDs to `sreg` (the most specific
 * pattern wins) and leaves everything else to nuget.org, so a public package of the same ID
 * is never picked (dependency confusion). Without known IDs a placeholder prefix is shown.
 */
function sourceMapping(packages: string[]): string {
  const ids = packages.length > 0 ? [...packages].sort() : ["Acme.*"];
  return (
    `  <packageSourceMapping>\n` +
    `    <packageSource key="sreg">\n` +
    ids.map((id) => `      <package pattern="${xmlAttr(id)}" />\n`).join("") +
    `    </packageSource>\n` +
    `    <packageSource key="nuget.org">\n` +
    `      <package pattern="*" />\n` +
    `    </packageSource>\n` +
    `  </packageSourceMapping>\n`
  );
}

function nugetConfig(source: string, login: string, password: string, packages: string[]): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<configuration>\n` +
    `  <packageSources>\n` +
    `    <add key="sreg" value="${xmlAttr(source)}" protocolVersion="3" />\n` +
    `  </packageSources>\n` +
    `  <packageSourceCredentials>\n` +
    `    <sreg>\n` +
    `      <add key="Username" value="${xmlAttr(login)}" />\n` +
    `      <add key="ClearTextPassword" value="${xmlAttr(password)}" />\n` +
    `    </sreg>\n` +
    `  </packageSourceCredentials>\n` +
    sourceMapping(packages) +
    `</configuration>\n`
  );
}

function clientConfig(baseUrl: string, token: string, packages: string[]): Snippet[] {
  const base = baseUrl.replace(/\/+$/, "");
  const source = `${base}/nuget/index.json`;
  const colon = token.indexOf(":");
  const login = colon === -1 ? token : token.slice(0, colon);
  const password = colon === -1 ? "" : token.slice(colon + 1);
  const snippets: Snippet[] = [
    {
      title: "Add the package source",
      description:
        "Add the registry as the package source sreg to your user-wide NuGet configuration. This command cannot pin package IDs: also add the packageSourceMapping from the nuget.config below, or a public package with the same ID may be installed instead.",
      group: "Set up the registry",
      variant: "Command",
      filename: "terminal",
      language: "shell",
      body:
        `dotnet nuget add source ${source} -n sreg -u ${login} -p ${password} ` +
        `--store-password-in-clear-text\n`,
    },
    {
      title: "nuget.config",
      description:
        "Declare the source in a nuget.config next to the solution instead; keep the credentials out of version control. The packageSourceMapping makes these package IDs come only from sreg (dependency confusion); nuget.org stays the source for everything else.",
      group: "Set up the registry",
      variant: "nuget.config",
      filename: "nuget.config",
      language: "xml",
      body: nugetConfig(source, login, password, packages),
    },
    {
      title: "nuget.config with the token from the environment",
      description:
        "NuGet expands %REGISTRY_TOKEN% from the environment, so this nuget.config holds no secret and can be committed; set the variable from a CI secret.",
      group: "Set up the registry",
      variant: "Environment variables",
      filename: "nuget.config",
      language: "xml",
      body: nugetConfig(source, login, "%REGISTRY_TOKEN%", packages),
    },
    {
      title: "Add the package source with the token from the environment",
      description: "Or add the source from a shell with the token taken from the environment.",
      group: "Set up the registry",
      variant: "Environment variables",
      filename: "terminal",
      language: "shell",
      body:
        `dotnet nuget add source ${source} -n sreg -u ${login} -p "$REGISTRY_TOKEN" ` +
        `--store-password-in-clear-text\n`,
    },
  ];
  if (packages.length > 0) {
    snippets.push({
      title: "Install",
      description: "Add the package to the project.",
      filename: "terminal",
      language: "shell",
      body: [...packages]
        .sort()
        .map((id) => `dotnet add package ${id}\n`)
        .join(""),
    });
  }
  return snippets;
}

/** The command that adds exactly one version, for the panel's version page. */
function versionSnippets(_baseUrl: string, name: string, version: string): Snippet[] {
  return [
    {
      title: "Add this version",
      description: "Add exactly this version to the project from the package source sreg.",
      filename: "terminal",
      language: "shell",
      body: `dotnet add package ${name} --version ${version} --source sreg\n`,
    },
  ];
}

/** The NuGet adapter. */
export const nugetAdapter: Adapter = {
  eco: "nuget",
  parseManifest,
  fileKey: (m, file) => fileKey("nuget", m.name.toLowerCase(), m.version, file.name),
  storedName: (name) => name.toLowerCase(),
  storedVersion: normalizeNuGetVersion,
  displayName,
  buildIndex,
  route,
  buildListing,
  filterIndex,
  fileUrl: (m, file, publicUrl) =>
    file.role === "symbols" ? null : packageContentUrl(publicUrl, m.name, m.version),
  versionUrl: (m, publicUrl) => packageContentUrl(publicUrl, m.name, m.version),
  clientConfig,
  versionSnippets,
  satisfies: satisfiesNuGetRange,
  validateRange: isValidNuGetRange,
  validateVersion: isValidNuGetVersion,
  compareVersions: compareNuGetVersions,
  dependencies,
};
