/**
 * Composer adapter (see "Composer" in docs/spec.md): validates `composer.json` manifests,
 * builds Composer 2 metadata (`p2/<vendor>/<package>.json`, minified) and the credential-aware
 * `packages.json`, filters metadata by grants and renders the client configuration snippets.
 */

import { ValidationError } from "../../core/errors";
import { isValidRange, satisfies } from "../../core/semver";
import { fileKey, indexKey } from "../../core/storage";
import {
  archiveFileOf,
  type Adapter,
  type Dependency,
  type IndexContext,
  type IndexFile,
  type Manifest,
  type ManifestFile,
  type NativeRoute,
  type PublishInit,
  type Snippet,
} from "../types";

type Json = Record<string, unknown>;

/** Composer package names (lower case), as Composer's own validation defines them. */
export const COMPOSER_NAME_RE = /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$/;

/**
 * Versions the registry accepts for Composer: `MAJOR.MINOR.PATCH`, optionally followed by a
 * prerelease `alpha`, `beta` or `rc` with an optional number, with or without a dot
 * (`1.0.0-beta.1`, `1.0.0-rc2`). Composer understands no other prerelease labels.
 */
const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)(?:\.?(0|[1-9]\d*))?)?$/;

/** The value Composer 2 minified metadata uses for a key removed since the previous entry. */
const UNSET = "__unset";

/** Fields of `composer.json` the Worker computes itself when building the index. */
const COMPUTED_FIELDS = new Set(["version", "version_normalized", "dist", "source"]);

const JSON_TYPE = "application/json";

interface ParsedVersion {
  parts: [number, number, number];
  label: "alpha" | "beta" | "rc" | null;
  /** The prerelease number; `null` when absent. */
  number: number | null;
}

function parseComposerVersion(version: string): ParsedVersion | null {
  const m = VERSION_RE.exec(version);
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].map(Number) as [number, number, number];
  const number = m[5] === undefined ? null : Number(m[5]);
  if (!parts.every(Number.isSafeInteger) || (number !== null && !Number.isSafeInteger(number))) {
    return null;
  }
  return { parts, label: (m[4] as ParsedVersion["label"]) ?? null, number };
}

/** Whether a version is valid for Composer packages in this registry. */
export function validateComposerVersion(version: string): boolean {
  return parseComposerVersion(version) !== null;
}

const LABEL_ORDER = { alpha: 0, beta: 1, rc: 2 } as const;

/**
 * Composer precedence of two valid versions: the numeric parts, then stable above `rc` above
 * `beta` above `alpha`, then the prerelease number (a label without a number sorts first).
 * `rc2` and `rc.2` are equal.
 */
export function compareComposerVersions(a: string, b: string): number {
  const x = parseComposerVersion(a);
  const y = parseComposerVersion(b);
  if (x === null || y === null) throw new TypeError("Invalid version.");
  for (let i = 0; i < 3; i++) {
    const d = Math.sign((x.parts[i] ?? 0) - (y.parts[i] ?? 0));
    if (d !== 0) return d;
  }
  if (x.label === null || y.label === null) {
    return x.label === y.label ? 0 : x.label === null ? 1 : -1;
  }
  const d = LABEL_ORDER[x.label] - LABEL_ORDER[y.label];
  if (d !== 0) return Math.sign(d);
  return Math.sign((x.number ?? -1) - (y.number ?? -1));
}

/**
 * Composer's `version_normalized`: four numeric parts and the stability suffix as Composer's
 * `VersionParser::normalize` writes it (`1.2.3` → `1.2.3.0`, `1.0.0-beta.2` →
 * `1.0.0.0-beta2`, `1.0.0-rc1` → `1.0.0.0-RC1`).
 */
export function normalizeComposerVersion(version: string): string {
  const v = parseComposerVersion(version);
  if (v === null) throw new TypeError("Invalid version.");
  const base = `${v.parts.join(".")}.0`;
  if (v.label === null) return base;
  const label = v.label === "rc" ? "RC" : v.label;
  return `${base}-${label}${v.number ?? ""}`;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** PHP's `isset()`: present and not `null`. */
function isSet(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/** PHP's strict `!==` on decoded JSON: arrays and objects compare by keys, order and values. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Composer 2 metadata minification (`Composer\MetadataMinifier\MetadataMinifier::minify`):
 * the first entry is complete; every following entry lists only the keys whose value differs
 * from the previous entry, and `"__unset"` for keys the previous entry had and this one has
 * not. As in PHP, a `null` value counts as absent.
 */
export function minify(versions: readonly Json[]): Json[] {
  const out: Json[] = [];
  // The last known version data; a Map keeps PHP's insertion order on update and unset.
  let last: Map<string, unknown> | null = null;
  for (const version of versions) {
    if (last === null) {
      last = new Map(Object.entries(version));
      out.push(version);
      continue;
    }
    const entry: Json = {};
    for (const [key, value] of Object.entries(version)) {
      if (!isSet(last.get(key)) || !same(last.get(key), value)) {
        entry[key] = value;
        last.set(key, value);
      }
    }
    for (const key of [...last.keys()]) {
      if (!isSet(version[key])) {
        entry[key] = UNSET;
        last.delete(key);
      }
    }
    out.push(entry);
  }
  return out;
}

/** The inverse of {@link minify} (`MetadataMinifier::expand`). */
export function expand(versions: readonly unknown[]): Json[] {
  const out: Json[] = [];
  let current: Map<string, unknown> | null = null;
  for (const data of versions) {
    if (!isRecord(data)) continue;
    if (current === null) {
      current = new Map(Object.entries(data));
    } else {
      for (const [key, value] of Object.entries(data)) {
        if (value === UNSET) current.delete(key);
        else current.set(key, value);
      }
    }
    out.push(Object.fromEntries(current));
  }
  return out;
}

function splitName(name: string): [string, string] {
  const slash = name.indexOf("/");
  return [name.slice(0, slash), name.slice(slash + 1)];
}

function distUrl(publicUrl: string, name: string, version: string): string {
  const [vendor, pkg] = splitName(name);
  return `${publicUrl}/composer/dist/${vendor}/${pkg}/${version}.zip`;
}

function p2Key(name: string, dev: boolean): string {
  const [vendor, pkg] = splitName(name);
  return indexKey("composer", "p2", vendor, `${pkg}${dev ? "~dev" : ""}.json`);
}

/** One expanded metadata entry: `composer.json` plus the fields the registry computes. */
function indexEntry(m: Manifest, publicUrl: string): Json {
  const entry: Json = {};
  for (const [key, value] of Object.entries(m.native)) {
    if (!COMPUTED_FIELDS.has(key)) entry[key] = value;
  }
  entry.name = m.name;
  entry.version = m.version;
  entry.version_normalized = normalizeComposerVersion(m.version);
  const archive = archiveFileOf(m.files);
  entry.dist = {
    type: "zip",
    url: distUrl(publicUrl, m.name, m.version),
    ...(archive === null ? {} : { reference: archive.sha256 }),
  };
  return entry;
}

function invalid(message: string): never {
  throw new ValidationError("invalid_request", message);
}

function parseManifest(input: PublishInit): Manifest {
  const { name, version, manifest, files } = input;
  if (typeof name !== "string" || !COMPOSER_NAME_RE.test(name)) {
    invalid("`name` must be a lower-case Composer package name `vendor/package`.");
  }
  if (typeof version !== "string" || !validateComposerVersion(version)) {
    invalid(
      "`version` must be MAJOR.MINOR.PATCH with an optional -alpha, -beta or -rc prerelease.",
    );
  }
  if (input.tag !== undefined) invalid("`tag` is only accepted for npm.");
  if (!isRecord(manifest)) invalid("`manifest` must be the composer.json object.");
  if (manifest.name !== name) invalid("`manifest.name` must equal `name`.");
  if (manifest.version !== undefined && manifest.version !== version) {
    invalid("`manifest.version` must equal `version` when present.");
  }
  const archive = files.length === 1 ? archiveFileOf(files) : null;
  if (archive === null) invalid("A Composer version has exactly one file: its .zip archive.");
  if (!archive.name.endsWith(".zip")) invalid("The Composer archive must be a .zip file.");
  const file: ManifestFile = {
    name: archive.name,
    size: archive.size,
    sha256: archive.sha256,
    role: "archive",
  };
  return {
    eco: "composer",
    name,
    version,
    files: [file],
    published: "",
    publishedBy: "",
    yanked: false,
    native: manifest,
  };
}

function buildIndex(name: string, manifests: Manifest[], ctx: IndexContext): IndexFile[] {
  const entries = manifests
    .filter((m) => !m.yanked && m.name === name)
    .sort((a, b) => compareComposerVersions(b.version, a.version))
    .map((m) => indexEntry(m, ctx.publicUrl));
  return [
    {
      key: p2Key(name, false),
      body: JSON.stringify({ packages: { [name]: minify(entries) }, minified: "composer/2.0" }),
      contentType: JSON_TYPE,
    },
    {
      key: p2Key(name, true),
      body: JSON.stringify({ packages: {}, minified: "composer/2.0" }),
      contentType: JSON_TYPE,
    },
  ];
}

function filterIndex(body: unknown, allowed: (name: string, version: string) => boolean): unknown {
  if (!isRecord(body) || !isRecord(body.packages)) return body;
  const minified = body.minified === "composer/2.0";
  const packages: Json = {};
  for (const [name, versions] of Object.entries(body.packages)) {
    if (!Array.isArray(versions)) continue;
    const expanded = minified ? expand(versions) : versions.filter(isRecord);
    const kept = expanded.filter((v) => typeof v.version === "string" && allowed(name, v.version));
    packages[name] = minified ? minify(kept) : kept;
  }
  return { ...body, packages };
}

const P2_RE = /^\/composer\/p2\/([^/]+)\/([^/]+?)(~dev)?\.json$/;
const DIST_RE = /^\/composer\/dist\/([^/]+)\/([^/]+)\/([^/]+)\.zip$/;

function route(req: Request, url: URL): NativeRoute | null {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const path = url.pathname;
  if (path === "/composer/packages.json") return { kind: "listing" };
  const p2 = P2_RE.exec(path);
  if (p2) {
    const name = `${p2[1]}/${p2[2]}`;
    if (!COMPOSER_NAME_RE.test(name)) return null;
    return { kind: "index", key: p2Key(name, p2[3] !== undefined), name };
  }
  const dist = DIST_RE.exec(path);
  if (dist) {
    const name = `${dist[1]}/${dist[2]}`;
    const version = dist[3] ?? "";
    if (!COMPOSER_NAME_RE.test(name) || !validateComposerVersion(version)) return null;
    return { kind: "archive", name, version, file: null };
  }
  return null;
}

function buildListing(packages: string[]): unknown {
  return {
    "metadata-url": "/composer/p2/%package%.json",
    "available-packages": [...packages].sort(),
    packages: [],
  };
}

/** The `composer.json` sections whose entries count as dependencies (docs/api.md 5.3). */
const DEPENDENCY_SECTIONS = ["require", "require-dev"] as const;

/** A key that looks like `vendor/package`: anything else is a platform package or invalid. */
const DEPENDENCY_NAME_RE = /^[^/\s]+\/[^/\s]+$/;

/** Platform packages Composer resolves from the environment, never from a repository. */
function isPlatformPackage(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === "php" ||
    n.startsWith("php-") ||
    n.startsWith("ext-") ||
    n.startsWith("lib-") ||
    n === "composer-plugin-api" ||
    n === "composer-runtime-api"
  );
}

/**
 * The `require` and `require-dev` entries of a version's `composer.json` whose key looks like
 * `vendor/package`; platform packages (`php`, `ext-*`, `lib-*`, `composer-plugin-api`,
 * `composer-runtime-api`) and non-string constraints are skipped.
 */
function dependencies(m: Manifest): Dependency[] {
  const out: Dependency[] = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const entries = m.native[section];
    if (!isRecord(entries)) continue;
    for (const [name, constraint] of Object.entries(entries)) {
      if (typeof constraint !== "string" || isPlatformPackage(name)) continue;
      if (!DEPENDENCY_NAME_RE.test(name)) continue;
      out.push({ name, constraint });
    }
  }
  return out;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 4)}\n`;
}

function clientConfig(baseUrl: string, token: string, packages: string[]): Snippet[] {
  const base = baseUrl.replace(/\/+$/, "");
  const host = new URL(base).host;
  const colon = token.indexOf(":");
  const login = colon === -1 ? token : token.slice(0, colon);
  const password = colon === -1 ? "" : token.slice(colon + 1);
  const withToken = new URL(`${base}/composer`);
  withToken.username = login;
  withToken.password = password;
  // `canonical: true` (Composer's default, kept explicit) means a package found here is never
  // looked up on Packagist, which is what defeats dependency confusion.
  const repositoryEntry = (url: string) => ({ type: "composer", url, canonical: true });
  const repository = (url: string) => ({ repositories: [repositoryEntry(url)] });
  const group = "Set up the registry";
  const composerJson = (variant: string): Snippet => ({
    title: "composer.json",
    description:
      'Add the registry to the project\'s composer.json; "canonical": true keeps the packages found here from ever being looked up on Packagist (dependency confusion).',
    group,
    variant,
    filename: "composer.json",
    language: "json",
    body: json(repository(`${base}/composer`)),
  });
  const snippets: Snippet[] = [
    {
      title: "Configure with Composer",
      description:
        "Add the registry to the project's composer.json and the token to its auth.json (Composer always writes http-basic credentials to auth.json; add --global to both commands for every project); keep auth.json out of version control. The repository is canonical, so its packages are never looked up on Packagist.",
      group,
      variant: "Command",
      filename: "terminal",
      language: "shell",
      body:
        `composer config repositories.sreg --json '${JSON.stringify(repositoryEntry(`${base}/composer`))}'\n` +
        `composer config http-basic.${host} ${login} ${password}\n`,
    },
    composerJson("Bearer (auth.json)"),
    {
      title: "auth.json (bearer)",
      description:
        "Store the token in auth.json next to composer.json (or in Composer's global auth.json); keep it out of version control.",
      group,
      variant: "Bearer (auth.json)",
      filename: "auth.json",
      language: "json",
      body: json({ bearer: { [host]: token } }),
    },
    composerJson("HTTP basic (auth.json)"),
    {
      title: "auth.json (http-basic)",
      description:
        "Store the token split at its colon as http-basic login and password in auth.json next to composer.json; keep it out of version control.",
      group,
      variant: "HTTP basic (auth.json)",
      filename: "auth.json",
      language: "json",
      body: json({ "http-basic": { [host]: { username: login, password } } }),
    },
    {
      title: "composer.json with the token in the URL (no auth.json needed)",
      description:
        "Put the token into the repository URL in composer.json instead of using auth.json; only where composer.json is not shared.",
      group,
      variant: "Token in the URL",
      filename: "composer.json",
      language: "json",
      body: json(repository(withToken.toString())),
    },
    composerJson("Environment variables"),
    {
      title: "COMPOSER_AUTH",
      description:
        "Pass the credentials in the COMPOSER_AUTH environment variable instead of auth.json (e.g. from a CI secret); the repository entry above still goes into composer.json.",
      group,
      variant: "Environment variables",
      filename: "terminal",
      language: "shell",
      body: `export COMPOSER_AUTH='${JSON.stringify({ "http-basic": { [host]: { username: login, password } } })}'\n`,
    },
  ];
  if (packages.length > 0) {
    snippets.push({
      title: "Install",
      description: "Add the package to the project and install it.",
      filename: "terminal",
      language: "shell",
      body: `composer require ${[...packages].sort().join(" ")}\n`,
    });
  }
  return snippets;
}

/** The command that requires exactly one version, for the panel's version page. */
function versionSnippets(_baseUrl: string, name: string, version: string): Snippet[] {
  return [
    {
      title: "Require this version",
      description:
        "Require exactly this version; composer.json and composer.lock pin it (the registry must be set up as above).",
      filename: "terminal",
      language: "shell",
      body: `composer require ${name}:${version}\n`,
    },
  ];
}

/** The Composer adapter. */
export const composerAdapter: Adapter = {
  eco: "composer",
  parseManifest,
  fileKey: (m, file) => fileKey("composer", m.name, m.version, file.name),
  buildIndex,
  route,
  buildListing,
  filterIndex,
  fileUrl: (m, _file, publicUrl) => distUrl(publicUrl, m.name, m.version),
  versionUrl: (m, publicUrl) => distUrl(publicUrl, m.name, m.version),
  clientConfig,
  versionSnippets,
  satisfies: (version, constraint) => satisfies(version, constraint, "composer"),
  validateRange: (constraint) => isValidRange(constraint, "composer"),
  validateVersion: validateComposerVersion,
  compareVersions: compareComposerVersions,
  dependencies,
};
