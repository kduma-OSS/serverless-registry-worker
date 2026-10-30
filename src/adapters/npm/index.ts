/**
 * npm adapter (see "npm" in docs/spec.md): validates scoped `package.json` manifests, builds
 * the packument (`npm/index/<name>.json`) with derived dist-tags, filters it by grants, serves
 * single versions, tarballs, `ping` and `whoami`, and renders the `.npmrc` snippets.
 */

import { ValidationError } from "../../core/errors";
import { sha256HexToBase64 } from "../../core/presign";
import {
  compareVersions,
  isPrerelease,
  isValidRange,
  parseVersion,
  satisfies,
} from "../../core/semver";
import { encodePackageName, fileKey, indexKey } from "../../core/storage";
import {
  archiveFileOf,
  type Adapter,
  type Dependency,
  type IndexContext,
  type IndexFile,
  type IndexRoute,
  type Manifest,
  type ManifestFile,
  type NativeRoute,
  type PublishInit,
  type Snippet,
} from "../types";

type Json = Record<string, unknown>;

/**
 * Scoped npm package names as `validate-npm-package-name` accepts them for new packages:
 * lower case, URL-safe characters, neither part starting with `.` or `_`.
 */
export const NPM_NAME_RE = /^@[a-z0-9~-][a-z0-9._~-]*\/[a-z0-9~-][a-z0-9._~-]*$/;

/** npm's limit on the length of a package name. */
const MAX_NAME_LENGTH = 214;

/** Dist-tags as docs/api.md 6.4 allows them (and not a valid semver range, checked apart). */
const TAG_RE = /^[a-z][a-z0-9._-]{0,63}$/;

/** `MAJOR.MINOR.PATCH[-PRERELEASE]`: semver 2.0.0 without a leading `v` or build metadata. */
const STRICT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const LATEST = "latest";
const NEXT = "next";

/**
 * Private field of the stored packument: the dist-tag each version asked for. `filterIndex`
 * needs it to recompute the dist-tags of the versions a credential may see, and removes it
 * from every response.
 */
const REQUESTED_TAGS = "_requestedTags";

const JSON_TYPE = "application/json";

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new ValidationError("invalid_request", message);
}

/** Whether a version is valid for npm packages in this registry (docs/api.md 5.2). */
export function validateNpmVersion(version: string): boolean {
  return STRICT_SEMVER_RE.test(version) && parseVersion(version) !== null;
}

/** Whether a string is a scoped npm package name this registry accepts. */
export function isNpmName(name: string): boolean {
  return name.length <= MAX_NAME_LENGTH && NPM_NAME_RE.test(name);
}

/** Whether a string may be used as a dist-tag (docs/api.md 6.4). */
export function isValidTag(tag: string): boolean {
  return TAG_RE.test(tag) && !isValidRange(tag, "npm");
}

/** The dist-tag a version gets when `init` names none: `next` for prereleases, else `latest`. */
export function defaultTag(version: string): string {
  return isPrerelease(version) ? NEXT : LATEST;
}

/** `@acme/sdk` → `["acme", "sdk"]`. */
function splitName(name: string): [string, string] {
  const slash = name.indexOf("/");
  return [name.slice(1, slash), name.slice(slash + 1)];
}

/** The canonical tarball name of a version, as the npm registry names it: `sdk-2.3.1.tgz`. */
export function tarballName(name: string, version: string): string {
  return `${splitName(name)[1]}-${version}.tgz`;
}

function tarballUrl(publicUrl: string, name: string, version: string): string {
  return `${publicUrl}/npm/${name}/-/${tarballName(name, version)}`;
}

/** `npm/index/<encoded name>.json`. */
function packumentKey(name: string): string {
  return indexKey("npm", `${encodePackageName(name)}.json`);
}

function parseManifest(input: PublishInit): Manifest {
  const { name, version, manifest, files } = input;
  if (typeof name !== "string" || !isNpmName(name)) {
    invalid("`name` must be a lower-case scoped npm package name `@scope/name`.");
  }
  if (typeof version !== "string" || !validateNpmVersion(version)) {
    invalid("`version` must be a semver version without build metadata.");
  }
  if (input.tag !== undefined && (typeof input.tag !== "string" || !isValidTag(input.tag))) {
    invalid("`tag` must match ^[a-z][a-z0-9._-]{0,63}$ and must not be a semver range.");
  }
  if (!isRecord(manifest)) invalid("`manifest` must be the package.json object.");
  if (manifest.name !== name) invalid("`manifest.name` must equal `name`.");
  if (manifest.version !== version) invalid("`manifest.version` must equal `version`.");
  const archive = files.length === 1 ? archiveFileOf(files) : null;
  if (archive === null) invalid("An npm version has exactly one file: its .tgz archive.");
  if (!archive.name.endsWith(".tgz")) invalid("The npm archive must be a .tgz file.");
  const native: Json = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (!key.startsWith("_")) native[key] = value;
  }
  const file: ManifestFile = {
    name: archive.name,
    size: archive.size,
    sha256: archive.sha256,
    role: "archive",
  };
  return {
    eco: "npm",
    name,
    version,
    files: [file],
    published: "",
    publishedBy: "",
    yanked: false,
    native,
    meta: { tag: input.tag ?? defaultTag(version) },
  };
}

/** One version of a packument, with what the dist-tags and `time` are derived from. */
interface Entry {
  version: string;
  /** The dist-tag the version asked for when it was published. */
  tag: string;
  /** RFC 3339; `""` when unknown. */
  published: string;
  /** The `versions[<v>]` object of the packument. */
  data: Json;
}

/**
 * The dist-tags of a set of visible versions. Each tag points at the highest version that asked
 * for it. `latest`, when no visible version asked for it, falls back to the highest stable
 * version, and `next` to the highest prerelease; any other tag whose versions are all hidden
 * (yanked or outside the grants) disappears. Tags are sorted by name.
 */
export function distTags(entries: readonly { version: string; tag: string }[]): Json {
  const sorted = [...entries].sort((a, b) => compareVersions(a.version, b.version));
  const tags: Record<string, string> = {};
  for (const e of sorted) tags[e.tag] = e.version;
  const highest = (prerelease: boolean) =>
    sorted.filter((e) => isPrerelease(e.version) === prerelease).at(-1)?.version;
  const latest = highest(false);
  if (tags[LATEST] === undefined && latest !== undefined) tags[LATEST] = latest;
  const next = highest(true);
  if (tags[NEXT] === undefined && next !== undefined) tags[NEXT] = next;
  return Object.fromEntries(Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The packument served to clients, for the given visible versions. */
function packument(name: string, entries: readonly Entry[]): Json {
  const sorted = [...entries].sort((a, b) => compareVersions(a.version, b.version));
  const versions: Json = {};
  for (const e of sorted) versions[e.version] = e.data;
  const published = sorted
    .map((e) => e.published)
    .filter((p) => p !== "")
    .sort();
  const time: Json = {};
  if (published.length > 0) {
    time.created = published[0];
    time.modified = published.at(-1);
  }
  for (const e of sorted) if (e.published !== "") time[e.version] = e.published;
  return { _id: name, name, "dist-tags": distTags(sorted), versions, time };
}

function versionEntry(m: Manifest, publicUrl: string): Json {
  const archive = archiveFileOf(m.files);
  return {
    ...m.native,
    name: m.name,
    version: m.version,
    _id: `${m.name}@${m.version}`,
    dist: {
      tarball: tarballUrl(publicUrl, m.name, m.version),
      ...(archive === null ? {} : { integrity: `sha256-${sha256HexToBase64(archive.sha256)}` }),
    },
  };
}

function requestedTag(m: Manifest): string {
  const tag = m.meta?.tag;
  return typeof tag === "string" && isValidTag(tag) ? tag : defaultTag(m.version);
}

/**
 * The stored packument holds every non-yanked version. The spec mentions keeping the tags in a
 * `_meta` file of the package; instead they are derived from the manifests (each records the
 * tag it was published with in `meta.tag`) every time the index is built, so the index stays a
 * pure function of the manifests and a `reindex` reproduces it exactly. `ctx.meta` is unused.
 */
function buildIndex(name: string, manifests: Manifest[], ctx: IndexContext): IndexFile[] {
  const entries: Entry[] = manifests
    .filter((m) => !m.yanked && m.name === name)
    .map((m) => ({
      version: m.version,
      tag: requestedTag(m),
      published: m.published,
      data: versionEntry(m, ctx.publicUrl),
    }));
  const body = {
    ...packument(name, entries),
    [REQUESTED_TAGS]: Object.fromEntries(entries.map((e) => [e.version, e.tag])),
  };
  return [{ key: packumentKey(name), body: JSON.stringify(body), contentType: JSON_TYPE }];
}

/**
 * Keeps the versions the credential may see and recomputes `dist-tags` and `time` from them.
 * With a `version` selector (a version or a dist-tag) it returns that version's entry, or
 * `null` when it is not visible.
 */
function filterIndex(
  body: unknown,
  allowed: (name: string, version: string) => boolean,
  route?: IndexRoute,
): unknown {
  if (!isRecord(body) || !isRecord(body.versions) || typeof body.name !== "string") return body;
  const name = body.name;
  const requested = isRecord(body[REQUESTED_TAGS]) ? body[REQUESTED_TAGS] : {};
  const time = isRecord(body.time) ? body.time : {};
  const entries: Entry[] = [];
  for (const [version, data] of Object.entries(body.versions)) {
    if (!isRecord(data) || !validateNpmVersion(version) || !allowed(name, version)) continue;
    const tag = requested[version];
    const published = time[version];
    entries.push({
      version,
      tag: typeof tag === "string" ? tag : defaultTag(version),
      published: typeof published === "string" ? published : "",
      data,
    });
  }
  const result = packument(name, entries);
  if (route?.version === undefined) return result;
  const versions = result.versions as Json;
  const tags = result["dist-tags"] as Json;
  const selected = Object.hasOwn(versions, route.version) ? route.version : tags[route.version];
  return typeof selected === "string" && Object.hasOwn(versions, selected)
    ? versions[selected]
    : null;
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * The version a tarball name refers to: `<name>-<version>.tgz`, as the npm registry names
 * tarballs, or `<scope>-<name>-<version>.tgz`, as `npm pack` names them.
 */
function tarballVersion(name: string, file: string): string | null {
  if (!file.endsWith(".tgz")) return null;
  const base = file.slice(0, -".tgz".length);
  const [scope, pkg] = splitName(name);
  for (const prefix of [`${pkg}-`, `${scope}-${pkg}-`]) {
    if (!base.startsWith(prefix)) continue;
    const version = base.slice(prefix.length);
    if (validateNpmVersion(version)) return version;
  }
  return null;
}

/**
 * `/npm/-/ping`, `/npm/-/whoami`, and for a scoped name written as `@scope/name`,
 * `@scope%2fname` or `%40scope%2Fname`: `/npm/<name>` (packument), `/npm/<name>/<version>`
 * (one version, or the version a dist-tag points at) and `/npm/<name>/-/<file>.tgz`.
 */
function route(req: Request, url: URL): NativeRoute | null {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  if (!url.pathname.startsWith("/npm/")) return null;
  const segments: string[] = [];
  for (const raw of url.pathname.slice("/npm/".length).split("/")) {
    const segment = decodeSegment(raw);
    if (segment === null) return null;
    segments.push(segment);
  }
  if (segments.length === 2 && segments[0] === "-") {
    if (segments[1] === "ping") return { kind: "static", body: {} };
    if (segments[1] === "whoami") return { kind: "whoami" };
    return null;
  }
  const first = segments[0] ?? "";
  let name: string;
  let rest: string[];
  if (first.includes("/")) {
    name = first;
    rest = segments.slice(1);
  } else if (first.startsWith("@") && segments.length >= 2) {
    name = `${first}/${segments[1] ?? ""}`;
    rest = segments.slice(2);
  } else {
    return null;
  }
  if (!isNpmName(name)) return null;
  const key = packumentKey(name);
  if (rest.length === 0) return { kind: "index", key, name };
  const [selector = "", file = ""] = rest;
  if (rest.length === 1) {
    if (!validateNpmVersion(selector) && !isValidTag(selector)) return null;
    return { kind: "index", key, name, version: selector };
  }
  if (rest.length === 2 && selector === "-") {
    const version = tarballVersion(name, file);
    if (version === null) return null;
    return { kind: "archive", name, version, file: null };
  }
  return null;
}

/** The `package.json` sections whose entries count as dependencies (docs/api.md 5.3). */
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/**
 * Every entry of the dependency sections whose specifier is a semver range. Specifiers that
 * are not ranges (`file:`, `git+…`, `workspace:`, `npm:` aliases, URLs, dist-tags) could
 * never open a version, so they are skipped, as are non-string values.
 */
function dependencies(m: Manifest): Dependency[] {
  const out: Dependency[] = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const entries = m.native[section];
    if (!isRecord(entries)) continue;
    for (const [name, constraint] of Object.entries(entries)) {
      if (typeof constraint !== "string" || !isValidRange(constraint, "npm")) continue;
      out.push({ name, constraint });
    }
  }
  return out;
}

function clientConfig(baseUrl: string, token: string, packages: string[]): Snippet[] {
  const base = baseUrl.replace(/\/+$/, "");
  const registry = `${base}/npm/`;
  // npm matches credentials by the registry URL without its protocol ("nerf dart").
  const nerfDart = registry.replace(/^[a-z]+:/i, "");
  const scopes = [...new Set(packages.filter(isNpmName).map((p) => splitName(p)[0]))].sort();
  const shownScopes = scopes.length > 0 ? scopes : ["your-scope"];
  const scopeLines = shownScopes.map((scope) => `@${scope}:registry=${registry}\n`).join("");
  const group = "Set up the registry";
  const snippets: Snippet[] = [
    {
      title: "Configure with npm",
      description:
        "Write the scope's registry and the token into your user ~/.npmrc (add --location=project for the project's .npmrc, and keep that out of version control). Only the scope is routed here: never point the unscoped registry at this server (it does not mirror npmjs), and do not use unscoped names for private packages, as anyone can publish them on npmjs.",
      group,
      variant: "Command",
      filename: "terminal",
      language: "shell",
      body:
        shownScopes.map((scope) => `npm config set @${scope}:registry ${registry}\n`).join("") +
        `npm config set ${nerfDart}:_authToken ${token}\n`,
    },
    {
      title: ".npmrc",
      description:
        "Route the scope to the registry and send the token as a Bearer token, in the project's .npmrc (or ~/.npmrc); keep it out of version control.",
      group,
      variant: "_authToken (Bearer)",
      filename: ".npmrc",
      language: "ini",
      body: `${scopeLines}${nerfDart}:_authToken=${token}\n`,
    },
    {
      title: ".npmrc (Basic authentication)",
      description:
        "Send the token with Basic authentication instead (_auth is its base64 encoding), for clients and proxies that need it; keep it out of version control.",
      group,
      variant: "_auth (Basic)",
      filename: ".npmrc",
      language: "ini",
      body: `${scopeLines}${nerfDart}:_auth=${btoa(token)}\n`,
    },
    {
      title: ".npmrc with the token from the environment",
      description:
        "Let npm replace ${REGISTRY_TOKEN} in .npmrc with the environment variable, so the file holds no secret and can be committed.",
      group,
      variant: "Environment variables",
      filename: ".npmrc",
      language: "ini",
      body: `${scopeLines}${nerfDart}:_authToken=\${REGISTRY_TOKEN}\n`,
    },
    {
      title: "Set the variable",
      description: "Set the token in the environment, e.g. in the shell or as a CI secret.",
      group,
      variant: "Environment variables",
      filename: "terminal",
      language: "shell",
      body: `export REGISTRY_TOKEN=${token}\n`,
    },
  ];
  if (packages.length > 0) {
    snippets.push({
      title: "Install",
      description: "Add the package to the project and install it.",
      filename: "terminal",
      language: "shell",
      body: `npm install ${[...packages].sort().join(" ")}\n`,
    });
  }
  return snippets;
}

/** The command that installs exactly one version, for the panel's version page. */
function versionSnippets(_baseUrl: string, name: string, version: string): Snippet[] {
  return [
    {
      title: "Install this version",
      description:
        "Install exactly this version and save it without a range, so package.json keeps it too.",
      filename: "terminal",
      language: "shell",
      body: `npm install --save-exact ${name}@${version}\n`,
    },
  ];
}

/** The npm adapter. */
export const npmAdapter: Adapter = {
  eco: "npm",
  parseManifest,
  fileKey: (m, file) => fileKey("npm", m.name, m.version, file.name),
  buildIndex,
  route,
  filterIndex,
  fileUrl: (m, _file, publicUrl) => tarballUrl(publicUrl, m.name, m.version),
  versionUrl: (m, publicUrl) => tarballUrl(publicUrl, m.name, m.version),
  clientConfig,
  versionSnippets,
  satisfies: (version, constraint) => satisfies(version, constraint, "npm"),
  validateRange: (constraint) => isValidRange(constraint, "npm"),
  validateVersion: validateNpmVersion,
  compareVersions: (a, b) => compareVersions(a, b),
  dependencies,
};
