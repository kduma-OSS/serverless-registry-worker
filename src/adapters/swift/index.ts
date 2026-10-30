/**
 * Swift adapter (see "Swift" in docs/spec.md and the Swift registry in docs/api.md section 10):
 * the Swift Package Registry protocol (SE-0292) for SwiftPM. A version is the source archive
 * produced by `swift package archive-source` (role `archive`) plus `Package.swift` and its
 * `Package@swift-X[.Y[.Z]].swift` variants (role `manifest`); `native` is the tools version,
 * the optional repository and README URLs and the output of `swift package dump-package`.
 *
 * Package identities `<scope>.<name>` are case-insensitive. The manifest's `name` is the
 * lower-cased identity, so R2 keys, `_meta/packages.json`, grants and the transitive closure
 * all use one spelling; the identity as published is kept in the manifest's `meta.id` and
 * served in URLs and in the release metadata (the casing of the highest version wins).
 *
 * Index layout: one JSON document per package, `swift/index/<scope>.<name>/releases.json`,
 * holds every release (yanked ones with their `problem`) together with the per-version
 * metadata (checksum, `publishedAt`, repository and README URLs, manifest variants). One
 * document rather than a file per version: the release metadata needs the neighbouring
 * releases for its `Link` headers anyway, so every request reads exactly one object and a
 * rebuild writes exactly one. `Package.swift` files are not copied into the index: they are
 * served from their R2 objects (inline archive routes).
 */

import { ValidationError } from "../../core/errors";
import { sha256HexToBase64 } from "../../core/presign";
import { isValidRange, parseVersion, satisfies } from "../../core/semver";
import { compareVersionStrings, fileKey, indexKey } from "../../core/storage";
import {
  RawIndexBody,
  archiveFileOf,
  type Adapter,
  type ArchiveRoute,
  type Dependency,
  type FileSelection,
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

type Json = Record<string, unknown>;

/** Registry scopes and package names (docs/api.md 6.4). */
export const SWIFT_SCOPE_RE = /^[A-Za-z0-9-]{1,39}$/;
export const SWIFT_NAME_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** `MAJOR.MINOR.PATCH[-PRERELEASE]`: semver 2.0.0 without a leading `v` or build metadata. */
const STRICT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Tools versions as the CLI reads them from `dump-package`: `X.Y` or `X.Y.Z`. */
const TOOLS_VERSION_RE = /^\d+\.\d+(?:\.\d+)?$/;

/** The manifest every Swift package has, and its Swift-version-specific variants. */
export const MANIFEST_FILE = "Package.swift";
const VARIANT_RE = /^Package@swift-(\d+(?:\.\d+){0,2})\.swift$/;
const SWIFT_VERSION_RE = /^\d+(?:\.\d+){0,2}$/;

/** The value of the `Content-Version` header of every response (docs/api.md 10.1). */
export const CONTENT_VERSION = "1";

const JSON_TYPE = "application/json";
const PROBLEM_TYPE = "application/problem+json";
const SWIFT_TYPE = "text/x-swift";

const PREFIX = "/swift/";

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
  throw new ValidationError("internal_error", "A stored Swift index is malformed.");
}

/** `scope` and `name` of an identity `<scope>.<name>`; `null` when it is not one. */
export function splitIdentity(id: string): { scope: string; name: string } | null {
  const dot = id.indexOf(".");
  if (dot === -1) return null;
  const scope = id.slice(0, dot);
  const name = id.slice(dot + 1);
  return SWIFT_SCOPE_RE.test(scope) && SWIFT_NAME_RE.test(name) ? { scope, name } : null;
}

/** Whether a version is a valid Swift package version (strict semver, no build metadata). */
export function validateSwiftVersion(version: string): boolean {
  return STRICT_SEMVER_RE.test(version) && parseVersion(version) !== null;
}

/** `swift/index/<scope>.<name>/releases.json` with the identity in lower case. */
export function swiftIndexKey(id: string): string {
  return indexKey("swift", id.toLowerCase(), "releases.json");
}

/** `<publicUrl>/swift/<scope>/<name>/<version>`, in the identity's casing. */
export function releaseUrl(publicUrl: string, id: string, version: string): string {
  const parts = splitIdentity(id);
  const path = parts === null ? id : `${parts.scope}/${parts.name}`;
  return `${publicUrl}/swift/${path}/${version}`;
}

/** Numeric comparison of Swift language versions (`5.9` = `5.9.0`). */
export function compareSwiftVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Problem details
// ---------------------------------------------------------------------------------------------

/** An RFC 7807 problem details body (docs/api.md 10.1). */
export interface Problem {
  status: number;
  title: string;
  detail: string;
}

const TITLES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  410: "Gone",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  426: "Upgrade Required",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

/** A problem body with the standard title of the status. */
export function problem(status: number, detail: string): Problem {
  return { status, title: TITLES[status] ?? "Error", detail };
}

const YANKED = problem(410, "this release was yanked");

// ---------------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------------

/** `native` of a Swift manifest: the init `manifest` as normalised by the adapter. */
export interface SwiftNative {
  toolsVersion: string;
  repositoryURL?: string;
  readmeURL?: string;
  dumpPackage: Json;
}

const OPTIONAL_URLS = ["repositoryURL", "readmeURL"] as const;

function parseNative(manifest: Json): SwiftNative {
  const { toolsVersion, dumpPackage } = manifest;
  if (typeof toolsVersion !== "string" || !TOOLS_VERSION_RE.test(toolsVersion)) {
    invalid("`manifest.toolsVersion` must be the tools version of Package.swift, X.Y or X.Y.Z.");
  }
  if (!isRecord(dumpPackage)) {
    invalid("`manifest.dumpPackage` must be the output of `swift package dump-package`.");
  }
  if (dumpPackage.dependencies !== undefined && !Array.isArray(dumpPackage.dependencies)) {
    invalid("`manifest.dumpPackage.dependencies` must be an array.");
  }
  const urls: Pick<SwiftNative, (typeof OPTIONAL_URLS)[number]> = {};
  for (const field of OPTIONAL_URLS) {
    const value = manifest[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value.trim() === "") {
      invalid(`\`manifest.${field}\` must be a non-empty string.`);
    }
    urls[field] = value;
  }
  // The key order of the CLI's `init` manifest.
  return { toolsVersion, ...urls, dumpPackage };
}

function roleOf(file: string, archive: string): "archive" | "manifest" | null {
  if (file === archive) return "archive";
  if (file === MANIFEST_FILE || VARIANT_RE.test(file)) return "manifest";
  return null;
}

/**
 * The source archive `<name>-<version>.zip` (role `archive`), `Package.swift` and its variants
 * (role `manifest`). A missing role is derived from the name; a sent one must agree.
 */
function parseFiles(input: PublishInit, packageName: string): ManifestFile[] {
  const archive = `${packageName}-${input.version}.zip`;
  const files = input.files.map((f): ManifestFile => {
    const role = roleOf(f.name, archive);
    if (role === null) {
      invalid(
        `A Swift version has the source archive ${archive}, Package.swift and ` +
          `Package@swift-<X[.Y[.Z]]>.swift files; ${f.name} is none of them.`,
      );
    }
    if (f.role !== undefined && f.role !== role) invalid(`${f.name} must have the role ${role}.`);
    return { name: f.name, size: f.size, sha256: f.sha256, role };
  });
  if (!files.some((f) => f.role === "archive"))
    invalid(`The source archive ${archive} is missing.`);
  if (!files.some((f) => f.name === MANIFEST_FILE)) invalid("Package.swift is missing.");
  return files;
}

function parseManifest(input: PublishInit): Manifest {
  const { name, version } = input;
  const parts = typeof name === "string" ? splitIdentity(name) : null;
  if (parts === null) {
    invalid("`name` must be <scope>.<name>: [A-Za-z0-9-]{1,39}, a dot, [A-Za-z0-9_-]{1,100}.");
  }
  if (typeof version !== "string" || !validateSwiftVersion(version)) {
    invalid("`version` must be a semver version without build metadata.");
  }
  if (input.tag !== undefined) invalid("`tag` is only accepted for npm.");
  if (!isRecord(input.manifest)) invalid("`manifest` must be an object.");
  const native = parseNative(input.manifest);
  return {
    eco: "swift",
    name: name.toLowerCase(),
    version,
    files: parseFiles(input, parts.name),
    published: "",
    publishedBy: "",
    yanked: false,
    native: { ...native },
    meta: { id: name },
  };
}

/** The identity as published (`meta.id`), or the stored lower-case name. */
function idOf(m: Manifest): string {
  const id = m.meta?.id;
  return typeof id === "string" && id.toLowerCase() === m.name.toLowerCase() ? id : m.name;
}

/** The native metadata of a stored manifest (tolerant of hand-edited manifests). */
function nativeOf(m: Manifest): SwiftNative {
  const n = m.native;
  const out: SwiftNative = {
    toolsVersion: typeof n.toolsVersion === "string" ? n.toolsVersion : "",
    dumpPackage: isRecord(n.dumpPackage) ? n.dumpPackage : {},
  };
  for (const field of OPTIONAL_URLS) {
    const value = n[field];
    if (typeof value === "string") out[field] = value;
  }
  return out;
}

/** A registry requirement as an npm range: `range` → `>=lower <upper`, `exact` → the version. */
function requirementOf(requirement: unknown): string | null {
  if (!isRecord(requirement)) return null;
  if (Array.isArray(requirement.range)) {
    const ranges = requirement.range
      .filter(isRecord)
      .filter((r) => typeof r.lowerBound === "string" && typeof r.upperBound === "string")
      .map((r) => `>=${String(r.lowerBound)} <${String(r.upperBound)}`);
    return ranges.length === 0 ? null : ranges.join(" || ");
  }
  if (Array.isArray(requirement.exact) && typeof requirement.exact[0] === "string") {
    return requirement.exact[0];
  }
  return null;
}

/**
 * The `registry` entries of `dumpPackage.dependencies` (docs/api.md 5.3), identities lower-cased
 * like package names; `sourceControl` and `fileSystem` dependencies do not take part.
 */
function dependencies(m: Manifest): Dependency[] {
  const deps = nativeOf(m).dumpPackage.dependencies;
  if (!Array.isArray(deps)) return [];
  const out: Dependency[] = [];
  for (const dep of deps) {
    if (!isRecord(dep) || !Array.isArray(dep.registry)) continue;
    for (const entry of dep.registry) {
      if (!isRecord(entry) || typeof entry.identity !== "string") continue;
      const constraint = requirementOf(entry.requirement);
      if (constraint !== null) out.push({ name: entry.identity.toLowerCase(), constraint });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------------------------

/** The release metadata's `metadata` object (docs/api.md 10.3). */
interface ReleaseMetadata {
  repositoryURLs?: string[];
  readmeURL?: string;
}

/** One release of the stored index. */
interface StoredRelease {
  /** The release's URL (`GET /swift/<scope>/<name>/<version>`). */
  url: string;
  /** Present when the release is yanked. */
  problem?: Problem;
  publishedAt: string;
  /** Hex SHA-256 of the source archive; `null` when the version has none. */
  checksum: string | null;
  metadata: ReleaseMetadata;
  /** The Swift versions of the `Package@swift-X.swift` variants, ascending. */
  manifests: string[];
}

/** `swift/index/<id>/releases.json`: every release, highest first, yanked included. */
interface StoredReleases {
  /** Lower-case identity, the name grants are checked against. */
  name: string;
  /** The identity as published by the highest version. */
  id: string;
  releases: Record<string, StoredRelease>;
}

function storedRelease(m: Manifest, id: string, publicUrl: string): StoredRelease {
  const native = nativeOf(m);
  const metadata: ReleaseMetadata = {};
  if (native.repositoryURL !== undefined) metadata.repositoryURLs = [native.repositoryURL];
  if (native.readmeURL !== undefined) metadata.readmeURL = native.readmeURL;
  return {
    url: releaseUrl(publicUrl, id, m.version),
    ...(m.yanked ? { problem: YANKED } : {}),
    publishedAt: m.published,
    checksum: archiveFileOf(m.files)?.sha256 ?? null,
    metadata,
    manifests: m.files
      .map((f) => VARIANT_RE.exec(f.name)?.[1])
      .filter((v): v is string => v !== undefined)
      .sort(compareSwiftVersions),
  };
}

function buildIndex(name: string, manifests: Manifest[], ctx: IndexContext): IndexFile[] {
  const key = name.toLowerCase();
  const sorted = manifests
    .filter((m) => m.name.toLowerCase() === key)
    .sort((a, b) => compareVersionStrings(b.version, a.version));
  const id = sorted[0] === undefined ? name : idOf(sorted[0]);
  const index: StoredReleases = {
    name: key,
    id,
    releases: Object.fromEntries(
      sorted.map((m) => [m.version, storedRelease(m, id, ctx.publicUrl)]),
    ),
  };
  return [{ key: swiftIndexKey(key), body: JSON.stringify(index), contentType: JSON_TYPE }];
}

function isStoredRelease(value: unknown): value is StoredRelease {
  return (
    isRecord(value) &&
    typeof value.url === "string" &&
    typeof value.publishedAt === "string" &&
    (typeof value.checksum === "string" || value.checksum === null) &&
    isRecord(value.metadata) &&
    Array.isArray(value.manifests) &&
    (value.problem === undefined || isRecord(value.problem))
  );
}

function parseStored(body: unknown): StoredReleases | null {
  if (
    !isRecord(body) ||
    typeof body.name !== "string" ||
    typeof body.id !== "string" ||
    !isRecord(body.releases)
  ) {
    return null;
  }
  return body as unknown as StoredReleases;
}

/** The releases of a stored index the caller may see, highest first. */
function visibleReleases(
  index: StoredReleases,
  allowed: (name: string, version: string) => boolean,
): [string, StoredRelease][] {
  return Object.entries(index.releases)
    .filter((entry): entry is [string, StoredRelease] => {
      const [version, release] = entry;
      return (
        validateSwiftVersion(version) && isStoredRelease(release) && allowed(index.name, version)
      );
    })
    .sort(([a], [b]) => compareVersionStrings(b, a));
}

/** `GET /swift/<scope>/<name>/<version>`: the metadata with `Link` headers, or `410`. */
function releaseMetadata(
  index: StoredReleases,
  visible: [string, StoredRelease][],
  version: string | undefined,
): RawIndexBody {
  const found = visible.find(([v]) => v === version);
  if (found === undefined) notFound();
  const [, release] = found;
  if (release.problem !== undefined) {
    return new RawIndexBody(JSON.stringify(release.problem), PROBLEM_TYPE, 410);
  }
  const listed = visible.filter(([, r]) => r.problem === undefined);
  const at = listed.findIndex(([v]) => v === version);
  const links = (
    [
      [listed[0], "latest-version"],
      [listed[at - 1], "successor-version"],
      [listed[at + 1], "predecessor-version"],
    ] as const
  )
    .filter(([entry]) => entry !== undefined)
    .map(([entry, rel]) => `<${entry?.[1].url ?? ""}>; rel="${rel}"`);
  const body = {
    id: index.id,
    version: found[0],
    resources:
      release.checksum === null
        ? []
        : [{ name: "source-archive", type: "application/zip", checksum: release.checksum }],
    metadata: release.metadata,
    publishedAt: release.publishedAt,
  };
  return new RawIndexBody(
    JSON.stringify(body),
    JSON_TYPE,
    200,
    links.length === 0 ? {} : { link: links.join(", ") },
  );
}

function filterIndex(
  body: unknown,
  allowed: (name: string, version: string) => boolean,
  route?: IndexRoute,
): unknown {
  const index = parseStored(body);
  if (index === null) malformed();
  const visible = visibleReleases(index, allowed);
  if (route?.view === "metadata") return releaseMetadata(index, visible, route.selector?.version);
  if (visible.length === 0) notFound();
  return {
    releases: Object.fromEntries(
      visible.map(([version, r]) => [
        version,
        r.problem === undefined ? { url: r.url } : { url: r.url, problem: r.problem },
      ]),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

/**
 * The archive with its `Digest`, or the manifest a `Package.swift` request asks for:
 * `Package@swift-X.swift` when it exists, else the variant with the highest version not above
 * `X`, else `Package.swift` (docs/api.md 10.4), with the other variants as `Link` alternates.
 */
function selectFile(m: Manifest, route: ArchiveRoute, publicUrl: string): FileSelection | null {
  if (route.file === null) {
    const archive = archiveFileOf(m.files);
    if (archive === null) return null;
    return { file: archive, headers: { digest: `sha-256=${sha256HexToBase64(archive.sha256)}` } };
  }
  const manifests = m.files.filter((f) => f.role === "manifest");
  const variants = manifests
    .map((f) => ({ file: f, version: VARIANT_RE.exec(f.name)?.[1] }))
    .filter((v): v is { file: ManifestFile; version: string } => v.version !== undefined)
    .sort((a, b) => compareSwiftVersions(a.version, b.version));
  const wanted = VARIANT_RE.exec(route.file)?.[1];
  const chosen =
    manifests.find((f) => f.name === route.file) ??
    (wanted === undefined
      ? undefined
      : variants.filter((v) => compareSwiftVersions(v.version, wanted) <= 0).pop()?.file) ??
    manifests.find((f) => f.name === MANIFEST_FILE);
  if (chosen === undefined) return null;
  const base = `${releaseUrl(publicUrl, idOf(m), m.version)}/${MANIFEST_FILE}`;
  const links = variants
    .filter((v) => v.file !== chosen)
    .map(
      (v) =>
        `<${base}?swift-version=${v.version}>; rel="alternate"; ` +
        `filename="${v.file.name}"; swift-tools-version="${v.version}"`,
    );
  return { file: chosen, headers: links.length === 0 ? {} : { link: links.join(", ") } };
}

function fileUrl(m: Manifest, file: ManifestFile, publicUrl: string): string {
  const release = releaseUrl(publicUrl, idOf(m), m.version);
  if (file.role !== "manifest") return `${release}.zip`;
  const variant = VARIANT_RE.exec(file.name)?.[1];
  return variant === undefined
    ? `${release}/${MANIFEST_FILE}`
    : `${release}/${MANIFEST_FILE}?swift-version=${variant}`;
}

// ---------------------------------------------------------------------------------------------
// Routing, identifiers and responses
// ---------------------------------------------------------------------------------------------

/**
 * A `415` when `Accept` names only other versions of the registry API (docs/api.md 10.1); a
 * missing or generic `Accept` is tolerated.
 */
function unsupportedAccept(req: Request): NativeRoute | null {
  const accept = req.headers.get("accept");
  if (accept === null) return null;
  const versions = [...accept.matchAll(/application\/vnd\.swift\.registry\.v([^+;,\s]*)/gi)].map(
    (m) => m[1],
  );
  if (versions.length === 0 || versions.includes("1")) return null;
  return {
    kind: "static",
    status: 415,
    contentType: PROBLEM_TYPE,
    body: JSON.stringify(problem(415, "Only version 1 of the registry API is supported.")),
  };
}

function decodeSegment(segment: string): string | null {
  if (segment === "") return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function route(req: Request, url: URL): NativeRoute | null {
  const path = url.pathname;
  if (!path.startsWith(PREFIX)) return null;
  const unsupported = unsupportedAccept(req);
  if (path === "/swift/login") {
    if (req.method !== "POST") return null;
    return unsupported ?? { kind: "static", body: "", contentType: "text/plain; charset=utf-8" };
  }
  if (req.method !== "GET") return null;
  if (unsupported !== null) return unsupported;
  if (path === "/swift/identifiers") {
    const repository = url.searchParams.get("url")?.trim() ?? "";
    if (repository === "") invalid("`url` is required.");
    return { kind: "listing", listing: "identifiers", options: { url: repository } };
  }
  const segments = path.slice(PREFIX.length).split("/").map(decodeSegment);
  if (segments.length < 2 || segments.length > 4 || segments.some((s) => s === null)) return null;
  const [scope, pkg, version, file] = segments as string[];
  const id = `${scope}.${pkg}`;
  if (splitIdentity(id) === null) return null;
  const name = id.toLowerCase();
  const key = swiftIndexKey(name);
  if (version === undefined) return { kind: "index", key, name, view: "releases" };
  if (file === undefined) {
    if (version.endsWith(".zip")) {
      const v = version.slice(0, -".zip".length);
      return validateSwiftVersion(v) ? { kind: "archive", name, version: v, file: null } : null;
    }
    if (!validateSwiftVersion(version)) return null;
    return { kind: "index", key, name, view: "metadata", selector: { version } };
  }
  if (file !== MANIFEST_FILE || !validateSwiftVersion(version)) return null;
  const swiftVersion = url.searchParams.get("swift-version");
  if (swiftVersion !== null && !SWIFT_VERSION_RE.test(swiftVersion)) {
    invalid("`swift-version` must look like 5, 5.9 or 5.9.2.");
  }
  return {
    kind: "archive",
    name,
    version,
    file: swiftVersion === null ? MANIFEST_FILE : `Package@swift-${swiftVersion}.swift`,
    inline: true,
    contentType: SWIFT_TYPE,
  };
}

/** A repository URL for comparison: lower case, without a trailing `/` or `.git`. */
export function normalizeRepositoryUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

/**
 * `GET /swift/identifiers?url=`: the identities of the visible packages one of whose visible
 * releases names the repository URL; `404` when there is none.
 */
async function buildListing(packages: string[], ctx: ListingContext): Promise<unknown> {
  if (ctx.route.listing !== "identifiers") notFound();
  const wanted = normalizeRepositoryUrl(String(ctx.route.options?.url ?? ""));
  const found = await Promise.all(
    packages.map(async (name) => {
      const index = parseStored(await ctx.readIndex(swiftIndexKey(name)));
      if (index === null) return null;
      const matches = visibleReleases(index, ctx.allowed).some(([, r]) =>
        (r.metadata.repositoryURLs ?? []).some((u) => normalizeRepositoryUrl(u) === wanted),
      );
      return matches ? index.id : null;
    }),
  );
  const identifiers = found.filter((id) => id !== null).sort();
  if (identifiers.length === 0) notFound();
  return { identifiers };
}

/**
 * Every response carries `Content-Version: 1`; JSON is `application/json` and errors become
 * problem details (docs/api.md 10.1).
 */
async function finalizeResponse(response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("content-version", CONTENT_VERSION);
  const json = /^application\/json\b/i.test(headers.get("content-type") ?? "");
  if (response.status >= 400 && json) {
    let detail = "";
    try {
      const body: unknown = await response.json();
      if (isRecord(body) && typeof body.message === "string") detail = body.message;
    } catch {
      // An unreadable error body keeps the standard title only.
    }
    headers.set("content-type", PROBLEM_TYPE);
    headers.delete("etag");
    return new Response(JSON.stringify(problem(response.status, detail)), {
      status: response.status,
      headers,
    });
  }
  if (json) headers.set("content-type", JSON_TYPE);
  return new Response(response.body, { status: response.status, headers });
}

// ---------------------------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------------------------

function clientConfig(baseUrl: string, token: string, packages: string[]): Snippet[] {
  const registry = `${baseUrl.replace(/\/+$/, "")}/swift`;
  const colon = token.indexOf(":");
  const login = colon === -1 ? token : token.slice(0, colon);
  const password = colon === -1 ? "" : token.slice(colon + 1);
  const id = [...packages].sort()[0] ?? "acme.networking";
  const parts = splitIdentity(id);
  const product = parts?.name ?? "Networking";
  const scope = parts?.scope ?? "acme";
  // One scope-to-registry mapping per scope the secret can read: a scope mapped here is never
  // resolved from another registry (dependency confusion).
  const scopes = [
    ...new Set(
      [...packages].sort().flatMap((p) => {
        const s = splitIdentity(p)?.scope;
        return s === undefined ? [] : [s];
      }),
    ),
  ];
  if (scopes.length === 0) scopes.push(scope);
  const setScopes = scopes
    .map((s) => `swift package-registry set ${registry} --scope ${s}\n`)
    .join("");
  return [
    {
      title: "Configure the registry",
      description:
        "Map the package's scope to the registry (scoped, so packages of that scope are never resolved from another registry) and store the credentials in your keychain (or .netrc).",
      group: "Set up the registry",
      variant: "Command",
      filename: "terminal",
      language: "shell",
      body:
        setScopes +
        `swift package-registry login ${registry} --username ${login} --password ${password}\n` +
        `# or send the token as a Bearer credential:\n` +
        `# swift package-registry login ${registry} --token ${token}\n`,
    },
    {
      title: "Configure the registry with the token from the environment",
      description:
        "The same with the token taken from the environment (e.g. a CI secret); the login accepts the whole token as the password.",
      group: "Set up the registry",
      variant: "Environment variables",
      filename: "terminal",
      language: "shell",
      body:
        setScopes +
        `swift package-registry login ${registry} --username ${login} --password "$REGISTRY_TOKEN"\n`,
    },
    {
      title: "Package.swift",
      description: "Depend on the package by its registry identity in Package.swift.",
      filename: "Package.swift",
      language: "swift",
      body:
        `dependencies: [\n` +
        `    .package(id: "${id}", from: "1.0.0"),\n` +
        `],\n` +
        `targets: [\n` +
        `    .target(\n` +
        `        name: "App",\n` +
        `        dependencies: [.product(name: "${product}", package: "${id}")]\n` +
        `    ),\n` +
        `],\n`,
    },
  ];
}

/** The dependency on exactly one version, for the panel's version page. */
function versionSnippets(_baseUrl: string, name: string, version: string): Snippet[] {
  return [
    {
      title: "Package.swift",
      description: "Depend on exactly this version in the dependencies of Package.swift.",
      filename: "Package.swift",
      language: "swift",
      body: `.package(id: "${name}", exact: "${version}"),\n`,
    },
  ];
}

/** The Swift adapter. */
export const swiftAdapter: Adapter = {
  eco: "swift",
  parseManifest,
  fileKey: (m, file) => fileKey("swift", m.name.toLowerCase(), m.version, file.name),
  storedName: (name) => name.toLowerCase(),
  displayName: idOf,
  buildIndex,
  route,
  buildListing,
  filterIndex,
  selectFile,
  finalizeResponse,
  fileUrl,
  versionUrl: (m, publicUrl) => `${releaseUrl(publicUrl, idOf(m), m.version)}.zip`,
  clientConfig,
  versionSnippets,
  satisfies: (version, constraint) => satisfies(version, constraint, "npm"),
  validateRange: (constraint) => isValidRange(constraint, "npm"),
  validateVersion: validateSwiftVersion,
  compareVersions: compareVersionStrings,
  dependencies,
};
