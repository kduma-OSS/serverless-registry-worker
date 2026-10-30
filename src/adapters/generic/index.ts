/**
 * Generic adapter (see "generic" in docs/spec.md and the generic feed in docs/api.md section 8):
 * versions of arbitrary labelled files with a free-form `meta` object, served as a JSON feed
 * for auto-updaters and `sreg generic get`. One index file per package holds every version
 * (yanked included); grants, labels, `latest` and yanked versions are applied when serving.
 */

import { ValidationError } from "../../core/errors";
import { isPrerelease, isValidRange, parseVersion, satisfies } from "../../core/semver";
import { compareVersionStrings, encodePackageName, fileKey, indexKey } from "../../core/storage";
import type {
  Adapter,
  ArchiveRoute,
  FileSelection,
  IndexContext,
  IndexFile,
  IndexRoute,
  IndexSelector,
  ListingContext,
  Manifest,
  ManifestFile,
  NativeRoute,
  PublishInit,
  Snippet,
} from "../types";

type Json = Record<string, unknown>;

const SEGMENT = "[a-z0-9][a-z0-9._-]*";

/** Generic package names: one segment, optionally preceded by a single group segment. */
export const GENERIC_NAME_RE = new RegExp(`^${SEGMENT}(?:/${SEGMENT})?$`);

/** Label keys (docs/api.md 6.4). */
export const LABEL_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Limits of a generic upload (docs/api.md 1.2 and 6.4). */
export const MAX_FILES = 64;
export const MAX_LABELS = 32;
export const MAX_LABEL_VALUE_LENGTH = 256;
export const MAX_META_BYTES = 65536;

/** `MAJOR.MINOR.PATCH[-PRERELEASE]`: semver 2.0.0 without a leading `v` or build metadata. */
const STRICT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const JSON_TYPE = "application/json";

/**
 * Whether a name is a valid generic package name. `__` is refused because R2 keys encode `/`
 * as `__`, so `acme__x` would collide with `acme/x`.
 */
export function isGenericName(name: string): boolean {
  return GENERIC_NAME_RE.test(name) && !name.includes("__");
}

/** Whether a version is a valid generic version (strict semver, no build metadata). */
export function validateGenericVersion(version: string): boolean {
  return STRICT_SEMVER_RE.test(version) && parseVersion(version) !== null;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new ValidationError("invalid_request", message);
}

function notFound(): never {
  throw new ValidationError("not_found");
}

/** `<publicUrl>/generic/<name>` with the group separator sent as `%2F` (docs/api.md 8.1). */
export function packageUrl(publicUrl: string, name: string): string {
  return `${publicUrl}/generic/${encodeURIComponent(name)}`;
}

function versionUrl(publicUrl: string, name: string, version: string): string {
  return `${packageUrl(publicUrl, name)}/${encodeURIComponent(version)}`;
}

function fileUrl(publicUrl: string, name: string, version: string, file: string): string {
  return `${versionUrl(publicUrl, name, version)}/${encodeURIComponent(file)}`;
}

/** `generic/index/<encoded name>.json`: the feed document of one package. */
export function genericIndexKey(name: string): string {
  return indexKey("generic", `${encodePackageName(name)}.json`);
}

// ---------------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------------

function validateLabels(labels: Record<string, string> | undefined, file: string): void {
  if (labels === undefined) return;
  const entries = Object.entries(labels);
  if (entries.length > MAX_LABELS) invalid(`File ${file} has more than ${MAX_LABELS} labels.`);
  for (const [key, value] of entries) {
    if (!LABEL_KEY_RE.test(key)) {
      invalid(`Label key ${JSON.stringify(key)} must match [a-z0-9][a-z0-9._-]{0,63}.`);
    }
    if (typeof value !== "string" || [...value].length > MAX_LABEL_VALUE_LENGTH) {
      invalid(`Label ${key} must be a string of at most ${MAX_LABEL_VALUE_LENGTH} characters.`);
    }
  }
}

function parseManifest(input: PublishInit): Manifest {
  const { name, version, files, manifest } = input;
  if (typeof name !== "string" || !isGenericName(name)) {
    invalid(
      "`name` must match [a-z0-9][a-z0-9._-]* with an optional group segment (`group/name`) " +
        "and must not contain `__`.",
    );
  }
  if (typeof version !== "string" || !validateGenericVersion(version)) {
    invalid("`version` must be a semver version without build metadata.");
  }
  if (input.tag !== undefined) invalid("`tag` is only accepted for npm.");
  if (!isRecord(manifest)) invalid("`manifest` must be the version's `meta` object.");
  if (new TextEncoder().encode(JSON.stringify(manifest)).length > MAX_META_BYTES) {
    invalid(`\`manifest\` (meta) must be at most ${MAX_META_BYTES} bytes as compact JSON.`);
  }
  if (files.length === 0 || files.length > MAX_FILES) {
    invalid(`A generic upload has 1 to ${MAX_FILES} files.`);
  }
  const stored: ManifestFile[] = files.map((f) => {
    validateLabels(f.labels, f.name);
    return { name: f.name, size: f.size, sha256: f.sha256, labels: { ...(f.labels ?? {}) } };
  });
  return {
    eco: "generic",
    name,
    version,
    files: stored,
    published: "",
    publishedBy: "",
    yanked: false,
    native: manifest,
  };
}

// ---------------------------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------------------------

/** A file entry of the feed. */
export interface FeedFile {
  name: string;
  size: number;
  sha256: string;
  labels: Record<string, string>;
  url: string;
}

/** A version entry of the feed (the stored index holds every version, yanked included). */
export interface FeedVersion {
  published: string;
  yanked: boolean;
  /** The deprecation warning, absent for a version that is not deprecated. */
  deprecated?: { message: string; at: string; by: string };
  meta: Json;
  files: FeedFile[];
}

/** The stored index: `{ name, versions }`, highest version first. */
export interface StoredFeed {
  name: string;
  versions: Record<string, FeedVersion>;
}

function feedVersion(m: Manifest, publicUrl: string): FeedVersion {
  return {
    published: m.published,
    yanked: m.yanked,
    ...(m.deprecated === undefined ? {} : { deprecated: m.deprecated }),
    meta: m.native,
    files: m.files.map((f) => ({
      name: f.name,
      size: f.size,
      sha256: f.sha256,
      labels: { ...(f.labels ?? {}) },
      url: fileUrl(publicUrl, m.name, m.version, f.name),
    })),
  };
}

function buildIndex(name: string, manifests: Manifest[], ctx: IndexContext): IndexFile[] {
  const sorted = manifests
    .filter((m) => m.name === name)
    .sort((a, b) => compareVersionStrings(b.version, a.version));
  const feed: StoredFeed = {
    name,
    versions: Object.fromEntries(sorted.map((m) => [m.version, feedVersion(m, ctx.publicUrl)])),
  };
  return [{ key: genericIndexKey(name), body: JSON.stringify(feed), contentType: JSON_TYPE }];
}

function isFeedFile(value: unknown): value is FeedFile {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.size === "number" &&
    typeof value.sha256 === "string" &&
    typeof value.url === "string" &&
    (value.labels === undefined || isRecord(value.labels))
  );
}

function isFeedVersion(value: unknown): value is FeedVersion {
  return (
    isRecord(value) &&
    typeof value.published === "string" &&
    typeof value.yanked === "boolean" &&
    Array.isArray(value.files) &&
    value.files.every(isFeedFile)
  );
}

/**
 * The versions of a stored feed the caller may see, highest first; `null` when the body is
 * not a stored feed.
 */
function visibleVersions(
  body: unknown,
  allowed: (name: string, version: string) => boolean,
): { name: string; versions: [string, FeedVersion][] } | null {
  if (!isRecord(body) || typeof body.name !== "string" || !isRecord(body.versions)) return null;
  const name = body.name;
  const versions = Object.entries(body.versions)
    .filter((entry): entry is [string, FeedVersion] => {
      const [version, value] = entry;
      return validateGenericVersion(version) && isFeedVersion(value) && allowed(name, version);
    })
    .sort(([a], [b]) => compareVersionStrings(b, a));
  return { name, versions };
}

/** `1.2.0` for `1.2.0-beta.1`: generic versions have no build metadata. */
function releaseOf(version: string): string {
  const dash = version.indexOf("-");
  return dash === -1 ? version : version.slice(0, dash);
}

/**
 * Whether a version qualifies for `latest`. Without a range: stable versions, prereleases too
 * with `prerelease`. With a range: the versions satisfying it, a prerelease only when the range
 * pins one of the same `major.minor.patch` (the npm rule of `satisfies`); with `prerelease`,
 * also every prerelease whose release version satisfies it (`2.0.0-beta.1` for `^2`).
 */
function qualifies(
  version: string,
  selector: Pick<IndexSelector, "prerelease" | "range">,
): boolean {
  const { prerelease = false, range } = selector;
  if (range === undefined) return prerelease || !isPrerelease(version);
  if (satisfies(version, range, "npm")) return true;
  return prerelease && isPrerelease(version) && satisfies(releaseOf(version), range, "npm");
}

/**
 * The highest non-yanked version that {@link qualifies}: stable only unless `prerelease`,
 * within `range` when given; `null` when none.
 */
function latestOf(
  versions: readonly [string, FeedVersion][],
  selector: Pick<IndexSelector, "prerelease" | "range"> = {},
): string | null {
  const found = versions.find(([v, entry]) => !entry.yanked && qualifies(v, selector));
  return found?.[0] ?? null;
}

function withLabels(entry: FeedVersion, labels: readonly [string, string][]): FeedVersion {
  const meta = isRecord(entry.meta) ? entry.meta : {};
  const files = entry.files
    .map((f) => ({ ...f, labels: isRecord(f.labels) ? f.labels : {} }))
    .filter((f) => labels.every(([key, value]) => f.labels[key] === value));
  return {
    published: entry.published,
    yanked: entry.yanked,
    ...(entry.deprecated === undefined ? {} : { deprecated: entry.deprecated }),
    meta,
    files,
  };
}

function filterIndex(
  body: unknown,
  allowed: (name: string, version: string) => boolean,
  route?: IndexRoute,
): unknown {
  const selector: IndexSelector = route?.selector ?? {};
  const visible = visibleVersions(body, allowed);
  if (visible === null) {
    throw new ValidationError("internal_error", "A stored generic index is malformed.");
  }
  const { name, versions } = visible;
  if (versions.length === 0) notFound();
  const labels = selector.labels ?? [];
  const single = (version: string, entry: FeedVersion) => ({
    name,
    version,
    ...withLabels(entry, labels),
  });
  if (selector.version !== undefined) {
    const found = versions.find(([v]) => v === selector.version);
    if (found === undefined || (found[1].yanked && !selector.includeYanked)) notFound();
    return single(...found);
  }
  if (selector.latest) {
    const latest = latestOf(versions, selector);
    const found = versions.find(([v]) => v === latest);
    if (found === undefined) notFound();
    return single(...found);
  }
  const { range } = selector;
  return {
    name,
    latest: latestOf(versions, { range }),
    versions: Object.fromEntries(
      versions
        .filter(([, entry]) => selector.includeYanked || !entry.yanked)
        .filter(([v]) => range === undefined || satisfies(v, range, "npm"))
        .map(([v, entry]) => [v, withLabels(entry, labels)]),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Routing and listing
// ---------------------------------------------------------------------------------------------

/** Parses the query parameters of 8.1; throws `400 invalid_request`. */
function parseQuery(url: URL): IndexSelector {
  const params = url.searchParams;
  const selector: IndexSelector = {};
  for (const include of params.getAll("include")) {
    if (include !== "yanked") invalid("`include` must be `yanked`.");
    selector.includeYanked = true;
  }
  for (const channel of params.getAll("channel")) {
    if (channel !== "prerelease") invalid("`channel` must be `prerelease`.");
    selector.prerelease = true;
  }
  const labels: [string, string][] = [];
  for (const label of params.getAll("label")) {
    const colon = label.indexOf(":");
    const key = colon === -1 ? label : label.slice(0, colon);
    if (colon === -1 || !LABEL_KEY_RE.test(key)) {
      invalid("`label` must be `<key>:<value>` with a valid label key.");
    }
    labels.push([key, label.slice(colon + 1)]);
  }
  if (labels.length > 0) selector.labels = labels;
  const ranges = params.getAll("version");
  if (ranges.length > 0) {
    const range = ranges[0] ?? "";
    if (ranges.length > 1 || range.trim() === "" || !isValidRange(range, "npm")) {
      invalid("`version` must be a single npm version range (e.g. `^1.2`).");
    }
    selector.range = range;
  }
  return selector;
}

function decodeSegment(segment: string): string | null {
  if (segment === "") return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

const PREFIX = "/generic/";

/**
 * `GET /generic/<name>/<version|latest>/-/download`: the one file of the version that the
 * labels select (docs/api.md 8.7). `latest` is resolved by the kernel through `resolve`.
 */
function downloadRoute(url: URL, name: string, version: string): ArchiveRoute | null {
  if (version === "latest") {
    const { prerelease, labels, range } = parseQuery(url);
    return {
      kind: "archive",
      name,
      version,
      file: null,
      selector: { latest: true, prerelease, labels, range },
      resolve: {
        kind: "index",
        key: genericIndexKey(name),
        name,
        selector: { latest: true, prerelease, range },
      },
    };
  }
  if (!validateGenericVersion(version)) return null;
  const { includeYanked, labels } = parseQuery(url);
  return {
    kind: "archive",
    name,
    version,
    file: null,
    selector: { version, includeYanked, labels },
  };
}

function route(req: Request, url: URL): NativeRoute | null {
  if (req.method !== "GET") return null;
  const path = url.pathname;
  if (path === "/generic" || path === PREFIX) return { kind: "listing" };
  if (!path.startsWith(PREFIX)) return null;
  const segments = path.slice(PREFIX.length).split("/").map(decodeSegment);
  if (segments.length > 4 || segments.some((s) => s === null)) return null;
  const [name, version, file, action] = segments as string[];
  if (name === undefined || !isGenericName(name)) return null;
  if (action !== undefined) {
    if (version === undefined || file !== "-" || action !== "download") return null;
    return downloadRoute(url, name, version);
  }
  if (file !== undefined) {
    if (version === undefined || !validateGenericVersion(version)) return null;
    return { kind: "archive", name, version, file };
  }
  const key = genericIndexKey(name);
  if (version === undefined) {
    const { includeYanked, labels, range } = parseQuery(url);
    return { kind: "index", key, name, selector: { includeYanked, labels, range } };
  }
  if (version === "latest") {
    const { prerelease, labels, range } = parseQuery(url);
    return { kind: "index", key, name, selector: { latest: true, prerelease, labels, range } };
  }
  if (!validateGenericVersion(version)) return null;
  const { includeYanked, labels } = parseQuery(url);
  return { kind: "index", key, name, selector: { version, includeYanked, labels } };
}

/**
 * The file of an archive route: the named file (`/<version>/<file>`, yanked versions
 * included), or for a download route (`file: null`) the only file of the version carrying
 * every requested label, with `X-Resolved-Version` and `X-Resolved-File`. A yanked version is
 * served there only with `include=yanked`; several matching files are `409 ambiguous`.
 */
function selectFile(m: Manifest, route: ArchiveRoute): FileSelection | null {
  if (route.file !== null) {
    const file = m.files.find((f) => f.name === route.file);
    return file === undefined ? null : { file };
  }
  const selector = route.selector ?? {};
  if (m.yanked && !selector.includeYanked) return null;
  const labels = selector.labels ?? [];
  const matching = m.files.filter((f) => labels.every(([key, value]) => f.labels?.[key] === value));
  const [file, ...others] = matching;
  if (file === undefined) return null;
  if (others.length > 0) {
    const files = matching.map((f) => f.name).sort();
    throw new ValidationError(
      "ambiguous",
      `${files.length} files of ${m.name} ${m.version} match; add labels to select one.`,
      { version: m.version, files },
    );
  }
  return {
    file,
    headers: { "x-resolved-version": m.version, "x-resolved-file": file.name },
  };
}

/**
 * `GET /generic/`: the packages with at least one version the caller may see (yanked
 * included), with their `latest`; reads each candidate package's index.
 */
async function buildListing(packages: string[], ctx: ListingContext): Promise<unknown> {
  const entries = await Promise.all(
    [...packages].sort().map(async (name) => {
      const visible = visibleVersions(await ctx.readIndex(genericIndexKey(name)), ctx.allowed);
      if (visible === null || visible.versions.length === 0) return null;
      return { name, latest: latestOf(visible.versions) };
    }),
  );
  return { packages: entries.filter((e) => e !== null) };
}

// ---------------------------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------------------------

function clientConfig(baseUrl: string, token: string, packages: string[]): Snippet[] {
  const base = baseUrl.replace(/\/+$/, "");
  const name = [...packages].sort()[0] ?? "acme/plugin-foo";
  const feed = packageUrl(base, name);
  const auth = `-H "Authorization: Bearer ${token}"`;
  return [
    {
      title: "Package feed (curl)",
      description: "Read the package's versions and files as JSON, e.g. from an auto-updater.",
      filename: "terminal",
      language: "shell",
      body:
        `# Every version with its files; add ?label=<key>:<value> to filter the files\n` +
        `curl -fsS ${auth} \\\n  "${feed}"\n\n` +
        `# The latest stable version (add ?channel=prerelease to include prereleases)\n` +
        `curl -fsS ${auth} \\\n  "${feed}/latest"\n`,
    },
    {
      title: "Download a file (curl)",
      description: "Download one file of a version with curl.",
      group: "Download",
      variant: "curl",
      filename: "terminal",
      language: "shell",
      body:
        `# The file URL answers 302 with a presigned storage URL; -L follows it. curl 7.58 and\n` +
        `# later do not forward the Authorization header to another host, so the token never\n` +
        `# reaches the storage host (older versions must follow the redirect by hand).\n` +
        `curl -fsSL ${auth} -o <file> \\\n  "${feed}/<version>/<file>"\n`,
    },
    {
      title: "Download with sreg",
      description: "Download the files of a version with the sreg CLI, filtered by label.",
      group: "Download",
      variant: "sreg",
      filename: "terminal",
      language: "shell",
      body:
        `export REGISTRY_URL=${base}\n` +
        `export REGISTRY_TOKEN=${token}\n` +
        `# Every file of the latest stable version, or of one version with a label\n` +
        `sreg generic get ${name} latest --out ./downloads\n` +
        `sreg generic get ${name} <version> --label <key>=<value> --out ./downloads\n`,
    },
    {
      title: "Download with the token from the environment",
      description:
        "Take the token from the environment (e.g. a CI secret) for curl and sreg alike.",
      group: "Download",
      variant: "Environment variables",
      filename: "terminal",
      language: "shell",
      body:
        `export REGISTRY_TOKEN=${token}\n` +
        `curl -fsSL -H "Authorization: Bearer $REGISTRY_TOKEN" -o <file> \\\n  "${feed}/<version>/<file>"\n` +
        `REGISTRY_URL=${base} sreg generic get ${name} latest --out ./downloads\n`,
    },
  ];
}

/** The commands that download exactly one version, for the panel's version page. */
function versionSnippets(baseUrl: string, name: string, version: string): Snippet[] {
  const base = baseUrl.replace(/\/+$/, "");
  return [
    {
      title: "Download this version",
      description:
        "Download every file of this version with sreg, or one file with curl; both read the token from REGISTRY_TOKEN.",
      filename: "terminal",
      language: "shell",
      body:
        `REGISTRY_URL=${base} sreg generic get ${name} ${version} --out .\n` +
        `curl -fsSL -H "Authorization: Bearer $REGISTRY_TOKEN" -o <file> \\\n` +
        `  "${versionUrl(base, name, version)}/<file>"\n`,
    },
  ];
}

/** The generic adapter. */
export const genericAdapter: Adapter = {
  eco: "generic",
  parseManifest,
  fileKey: (m, file) => fileKey("generic", m.name, m.version, file.name),
  supportsAppend: true,
  buildIndex,
  route,
  buildListing,
  filterIndex,
  selectFile,
  fileUrl: (m, file, publicUrl) => fileUrl(publicUrl, m.name, m.version, file.name),
  versionUrl: (m, publicUrl) => versionUrl(publicUrl, m.name, m.version),
  clientConfig,
  versionSnippets,
  satisfies: (version, constraint) => satisfies(version, constraint, "npm"),
  validateRange: (constraint) => isValidRange(constraint, "npm"),
  validateVersion: validateGenericVersion,
  compareVersions: compareVersionStrings,
  dependencies: () => [],
};
