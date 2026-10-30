/**
 * Contracts shared by the kernel and the ecosystem adapters (see "Adapters and endpoints" in
 * docs/spec.md). Adapters implement {@link Adapter}; they never touch R2, KV or auth.
 */

/** Supported ecosystems. */
export type Eco = "composer" | "npm" | "cargo" | "generic" | "nuget" | "swift" | "maven";

/** All ecosystems, in a stable order. */
export const ECOS: readonly Eco[] = [
  "composer",
  "npm",
  "cargo",
  "generic",
  "nuget",
  "swift",
  "maven",
];

/** Narrows an arbitrary value to {@link Eco}. */
export function isEco(value: unknown): value is Eco {
  return typeof value === "string" && (ECOS as readonly string[]).includes(value);
}

/**
 * One file of a version. The kernel only requires a non-empty list with unique names; roles are
 * an adapter decision: composer, npm and cargo require exactly one file with role `archive` (a
 * single file without a role counts as the archive), generic ignores `role` and uses `labels`.
 */
export interface ManifestFile {
  /** File name, unique within the version. */
  name: string;
  /** Size in bytes. */
  size: number;
  /** SHA-256 of the file, 64 lower-case hex characters. */
  sha256: string;
  role?: string;
  labels?: Record<string, string>;
  /**
   * Extra digests besides `sha256` (lower-case hex by algorithm, e.g. `{ "sha1": "…" }`),
   * computed by the kernel at `commit` for the algorithms the adapter declares in
   * {@link Adapter.digests}. Never sent by clients.
   */
  digests?: Record<string, string>;
}

/** Extra digest algorithms an adapter may declare (docs/api.md 6.5). */
export type DigestAlgorithm = "sha1" | "md5" | "sha512";

/** Every {@link DigestAlgorithm}. */
export const DIGEST_ALGORITHMS: readonly DigestAlgorithm[] = ["sha1", "md5", "sha512"];

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

/** Narrows an arbitrary value to {@link ManifestFile} (shape only). */
export function isManifestFile(value: unknown): value is ManifestFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.name === "string" &&
    typeof f.size === "number" &&
    typeof f.sha256 === "string" &&
    (f.role === undefined || typeof f.role === "string") &&
    (f.labels === undefined || isStringRecord(f.labels)) &&
    (f.digests === undefined || isStringRecord(f.digests))
  );
}

/** Why a version is deprecated: the warning shown to clients, when and by whom it was set. */
export interface Deprecation {
  message: string;
  /** RFC 3339 timestamp. */
  at: string;
  /** `[<source>.]<project>` of the credential that deprecated the version. */
  by: string;
}

/**
 * Normalised version manifest stored at `<eco>/pkg/<name>/<version>/manifest.json`. It is the
 * only durable data contract: indexes are always rebuilt from manifests.
 */
export interface Manifest {
  eco: Eco;
  /** Decoded package name, e.g. `@acme/sdk`. */
  name: string;
  version: string;
  /** The files of the version: non-empty, unique names. */
  files: ManifestFile[];
  /** RFC 3339 timestamp of the commit. */
  published: string;
  /** `[<source>.]<project>` of the credential that published the version. */
  publishedBy: string;
  yanked: boolean;
  /**
   * Set by an admin: the version still works and stays selectable, but clients are warned where
   * the ecosystem supports it. Independent of `yanked`. Absent when not deprecated.
   */
  deprecated?: Deprecation;
  /** Whatever the adapter needs to reproduce the version's entry in the index. */
  native: Record<string, unknown>;
  /**
   * Publish options the adapter keeps next to `native` because they are not part of the
   * ecosystem's own metadata (npm: the requested dist-tag, `{ tag }`). Optional; absent for
   * most ecosystems.
   */
  meta?: Record<string, unknown>;
}

/** One generated index file written to R2. */
export interface IndexFile {
  /** R2 key, under `<eco>/index/`. */
  key: string;
  body: string;
  contentType: string;
}

/** Body of `POST /api/v1/publish/init` (docs/api.md 6.4). */
export interface PublishInit {
  eco: Eco;
  name: string;
  version: string;
  /** The files to upload: non-empty, unique names. */
  files: ManifestFile[];
  /** Ecosystem-native metadata (`composer.json`, `package.json`, cargo index line). */
  manifest: Record<string, unknown>;
  /** npm only: dist-tag to point at this version. */
  tag?: string;
  /** Add files to an existing version instead of publishing a new one (adapters with
   * `supportsAppend` only). */
  append?: boolean;
}

/**
 * A view of an index file that the adapter's route asks for and gets back in
 * {@link Adapter.filterIndex}: one version, the latest one, query filters. The kernel does not
 * interpret it.
 */
export interface IndexSelector {
  /** Only the highest qualifying version (e.g. generic `latest`). */
  latest?: boolean;
  /** Only this exact version. */
  version?: string;
  /** Also return yanked versions. */
  includeYanked?: boolean;
  /** Also consider prerelease versions. */
  prerelease?: boolean;
  /** `[key, value]` pairs every returned file must carry. */
  labels?: [string, string][];
  /**
   * Only versions satisfying this constraint in the ecosystem's syntax (generic
   * `?version=<range>`); already validated by the route.
   */
  range?: string;
  /** Only this file of the selected version (e.g. a Maven checksum of one file). */
  file?: string;
}

/** A read of an index file, which the kernel filters by the caller's grants. */
export interface IndexRoute {
  kind: "index";
  /** R2 key of the index file. */
  key: string;
  /** Decoded package name the index belongs to. */
  name: string;
  /**
   * Selects one entry of the index instead of the whole file (npm: a version or a dist-tag,
   * `GET /npm/<name>/<version>`). Passed to {@link Adapter.filterIndex} with the route.
   */
  version?: string;
  /**
   * An alternative rendering of the same index file (cargo: `api` for
   * `GET /cargo/api/v1/crates/<name>`). Passed to {@link Adapter.filterIndex} with the route.
   */
  view?: string;
  /**
   * What the request selects within the index (generic, NuGet: one version, the latest one,
   * query filters). Passed to {@link Adapter.filterIndex} with the route.
   */
  selector?: IndexSelector;
}

/**
 * A filtered index served verbatim with its own content type instead of as JSON (e.g. the
 * NuGet `.nuspec` taken out of a JSON index file), optionally with another status than `200`
 * and extra headers (e.g. a Swift `410` for a yanked release, `Link` headers).
 */
export class RawIndexBody {
  constructor(
    readonly body: string,
    readonly contentType: string,
    readonly status = 200,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {}
}

/**
 * A download of a file of a version, answered with a redirect to a presigned `GET`. The kernel
 * reads the version's manifest to find the file and asks {@link Adapter.fileKey} for its key.
 */
export interface ArchiveRoute {
  kind: "archive";
  name: string;
  version: string;
  /**
   * File name within the version, or `null` for the version's archive: the file with role
   * `archive`, or the only file when it has no role. An adapter with
   * {@link Adapter.selectFile} interprets it itself.
   */
  file: string | null;
  /**
   * Serve the file's content in the response (with {@link ArchiveRoute.contentType}) instead
   * of redirecting to a presigned `GET`, for small text files that clients read inline (Swift
   * `Package.swift`).
   */
  inline?: true;
  /** Content type of an {@link ArchiveRoute.inline} response. */
  contentType?: string;
  /**
   * The request's query as parsed by the adapter's route (e.g. generic labels), for
   * {@link Adapter.selectFile}. The kernel does not interpret it.
   */
  selector?: IndexSelector;
  /**
   * The version is not known from the path (generic `latest`): the kernel first filters this
   * index route with {@link Adapter.filterIndex} and the caller's grants, exactly as when
   * serving it, and downloads from the version named by the `version` field of the result
   * instead of {@link ArchiveRoute.version}. The grant check of that version still applies.
   */
  resolve?: IndexRoute;
}

/** The file an {@link ArchiveRoute} serves, with extra response headers. */
export interface FileSelection {
  file: ManifestFile;
  /** Added to the response (e.g. Swift `Digest`, `Link`). */
  headers?: Record<string, string>;
}

/**
 * The list of packages of the ecosystem (e.g. Composer's `packages.json`). It depends on the
 * credential, so the kernel computes the visible package names and asks
 * {@link Adapter.buildListing} for the body.
 */
export interface ListingRoute {
  kind: "listing";
  /** Which listing of the adapter, when it has several (e.g. NuGet `service`, `search`). */
  listing?: string;
  /** The request's options as parsed by the adapter's route (e.g. a search query). */
  options?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * A fixed body answered to any authenticated caller (e.g. `npm ping`): JSON with `200` by
 * default; with `contentType`, the `body` string is sent verbatim.
 */
export interface StaticRoute {
  kind: "static";
  body: unknown;
  /** Status of the response; default `200`. */
  status?: number;
  /** Content type of a verbatim string `body` (e.g. Swift problem details). */
  contentType?: string;
}

/**
 * The caller's identity in the ecosystem's format (`npm whoami`): the kernel answers
 * `{ "username": "<project>" }` to any authenticated caller.
 */
export interface WhoamiRoute {
  kind: "whoami";
}

/**
 * A configuration document that depends on `PUBLIC_URL` (cargo's `config.json`). The kernel
 * asks {@link Adapter.buildConfig} for the JSON body.
 */
export interface ConfigRoute {
  kind: "config";
}

/** Any route of a native read protocol. */
export type NativeRoute =
  IndexRoute | ArchiveRoute | ListingRoute | StaticRoute | WhoamiRoute | ConfigRoute;

/** A ready-to-paste client configuration snippet for the home page. */
export interface Snippet {
  title: string;
  filename: string;
  /** Language hint for display, e.g. `json`, `ini`, `toml`. */
  language: string;
  body: string;
  /** One sentence on what the snippet does and where it goes. */
  description?: string;
  /**
   * Snippets that share a group are alternative ways to do the same thing: the panel shows
   * them in one chooser labelled with the group name, one {@link variant} at a time.
   */
  group?: string;
  /** The label of the snippet's alternative in its group; snippets with the same one go together. */
  variant?: string;
}

/** Context passed to {@link Adapter.buildIndex}. */
export interface IndexContext {
  /** `PUBLIC_URL` without a trailing slash. */
  publicUrl: string;
  /** Ecosystem-specific package metadata kept outside the manifests (e.g. npm dist-tags). */
  meta?: Record<string, unknown>;
}

/** Context passed to {@link Adapter.buildListing}. */
export interface ListingContext extends IndexContext {
  /** The route that asked for the listing. */
  route: ListingRoute;
  /** Whether the caller may see a version (grants and transitive access). */
  allowed(name: string, version: string): boolean;
  /**
   * Reads one of the adapter's index files (unfiltered, JSON-decoded); `null` when it is
   * missing or not JSON. For listings that need more than the package names.
   */
  readIndex(key: string): Promise<unknown>;
}

/**
 * A dependency declared by a version manifest (docs/api.md 5.3): the package name as written
 * and its version constraint in the ecosystem's syntax, as written.
 */
export interface Dependency {
  name: string;
  constraint: string;
}

/** One ecosystem module (`src/adapters/<eco>/index.ts`). */
export interface Adapter {
  eco: Eco;
  /** Validates and normalises what the CLI sent in `init`; throws `ValidationError`. */
  parseManifest(input: PublishInit): Manifest;
  /** R2 key of one file of a version. */
  fileKey(m: Manifest, file: ManifestFile): string;
  /**
   * The stored form of a package name taken from an `/api/v1` path (NuGet and Swift: lower
   * case, because their names are matched case-insensitively). The name as given when absent.
   */
  storedName?(name: string): string;
  /**
   * The stored form of a valid version taken from an `/api/v1` path (NuGet: normalised). The
   * version as given when absent.
   */
  storedVersion?(version: string): string;
  /**
   * The name of a package as listings show it, from the manifest of its highest version
   * (NuGet and Swift: the casing it was published with). `m.name` when absent.
   */
  displayName?(m: Manifest): string;
  /** Whether `init` may add files to an existing version (`append`); only generic. */
  supportsAppend?: boolean;
  /**
   * Extra digests of every file that the ecosystem's clients verify (Maven: `sha1`, `md5`,
   * `sha512`). The kernel computes them at `commit` and stores them as `files[].digests`.
   */
  digests?: readonly DigestAlgorithm[];
  /** Rebuilds the index of one package from all its manifests (including yanked ones). */
  buildIndex(name: string, manifests: Manifest[], ctx: IndexContext): IndexFile[];
  /** Read routing of the native protocol; `null` when the path is not handled. */
  route(req: Request, url: URL): NativeRoute | null;
  /**
   * Body of a {@link ListingRoute} for the packages the caller may see (sorted names). Only
   * adapters that answer listing routes implement it. May throw `ValidationError` (e.g.
   * `not_found`).
   */
  buildListing?(packages: string[], ctx: ListingContext): unknown;
  /** Body of a {@link ConfigRoute}. Only adapters that answer config routes implement it. */
  buildConfig?(ctx: IndexContext): unknown;
  /**
   * The file an {@link ArchiveRoute} serves from the version's manifest, with extra headers;
   * `null` answers `404`. Without it the kernel takes the file named by `route.file`, or the
   * archive when it is `null`.
   */
  selectFile?(m: Manifest, route: ArchiveRoute, publicUrl: string): FileSelection | null;
  /**
   * Adjusts every native response of the ecosystem, errors included, before it is sent (e.g.
   * Swift's `Content-Version` header and problem details instead of the error body).
   */
  finalizeResponse?(response: Response): Response | Promise<Response>;
  /**
   * Native download URL of one file of a version (e.g. in the `commit` response); `null` for a
   * file without a download endpoint (NuGet symbols).
   */
  fileUrl(m: Manifest, file: ManifestFile, publicUrl: string): string | null;
  /** Native download URL of the version's archive, the `url` of the `commit` response. */
  versionUrl(m: Manifest, publicUrl: string): string;
  /**
   * Removes from an index body every version the credential may not see. The body is the
   * parsed JSON of a JSON index file, otherwise its text. `route` is the {@link IndexRoute}
   * being served, for adapters that select an entry (`version`, `selector`) or render a
   * `view`. The result is served as JSON with an `ETag`, verbatim with its own content type
   * when it is a {@link RawIndexBody}, or with the stored content type when it is a string;
   * `null` answers `404`. It may be returned as a promise (e.g. when it hashes the body). May
   * also throw `ValidationError` (e.g. `not_found` when nothing qualifies).
   */
  filterIndex(
    body: unknown,
    allowed: (name: string, version: string) => boolean,
    route?: IndexRoute,
  ): unknown;
  /** Configuration snippets for the home page. */
  clientConfig(baseUrl: string, token: string, packages: string[]): Snippet[];
  /**
   * Snippets that get exactly one version of a package (`name` as published), for the panel's
   * version page: an install command or a pinned dependency. They need no token. Optional.
   */
  versionSnippets?(baseUrl: string, name: string, version: string): Snippet[];
  /** Whether a version satisfies a constraint in the ecosystem's syntax. */
  satisfies(version: string, constraint: string): boolean;
  /**
   * Whether a grant's version constraint parses in the ecosystem's syntax (`*` is always
   * valid; the kernel checks it before asking the adapter).
   */
  validateRange(constraint: string): boolean;
  /**
   * Whether a version string is valid in the ecosystem. The kernel never assumes semver: NuGet,
   * for example, allows four-part versions.
   */
  validateVersion(version: string): boolean;
  /** Precedence of two valid versions: negative when `a < b`, `0` when equal, else positive. */
  compareVersions(a: string, b: string): number;
  /**
   * The dependencies a version declares in its manifest (`native`), every kind (optional,
   * dev, peer) included, for transitive access (docs/api.md 5.3). The kernel keeps only the
   * names that exist in this registry; `[]` when the ecosystem has no dependencies.
   */
  dependencies(m: Manifest): Dependency[];
}

/**
 * The archive of a version: the file with role `archive`, or the only file when it has no
 * role; `null` when there is none (or more than one with role `archive`).
 */
export function archiveFileOf(files: readonly ManifestFile[]): ManifestFile | null {
  const archives = files.filter((f) => f.role === "archive");
  if (archives.length === 1) return archives[0] ?? null;
  if (archives.length === 0 && files.length === 1 && files[0]?.role === undefined) {
    return files[0] ?? null;
  }
  return null;
}
