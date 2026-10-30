/**
 * cargo adapter (see "cargo" in docs/spec.md): validates sparse-index lines sent by the CLI,
 * builds the sparse index file of a crate (one JSON line per version, yanked ones marked),
 * filters it by grants, serves `config.json`, `.crate` downloads and a minimal crate API, and
 * renders the cargo configuration snippets.
 */

import { ValidationError } from "../../core/errors";
import { compareVersions, isValidRange, parseVersion, satisfies } from "../../core/semver";
import { fileKey, indexKey } from "../../core/storage";
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
 * Crate names this registry accepts: the crates.io rules (ASCII letters, digits, `-` and `_`,
 * starting with a letter, at most 64 characters), restricted to lower case. Crate names are
 * unique case-insensitively and cargo requests index files by the lower-cased name, so a
 * lower-case name is the only one that maps back from an index path and cannot collide with
 * another package of the registry.
 */
export const CRATE_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/** Names of dependencies as they appear in index lines (other registries may use upper case). */
const DEPENDENCY_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `MAJOR.MINOR.PATCH[-PRERELEASE]`: semver 2.0.0 without a leading `v` or build metadata. */
const STRICT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const DEPENDENCY_KINDS = new Set(["normal", "dev", "build"]);

/** The registry name used in the configuration snippets. */
export const REGISTRY_NAME = "sreg";

/** {@link REGISTRY_NAME} as Cargo spells it in environment variables. */
const ENV_NAME = REGISTRY_NAME.toUpperCase().replaceAll("-", "_");

const TEXT_TYPE = "text/plain; charset=utf-8";

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** A feature map: feature name → list of enabled features or dependencies. */
function isFeatureMap(value: unknown): value is Record<string, string[]> {
  return isRecord(value) && Object.values(value).every(isStringArray);
}

function isOptionalString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

function invalid(message: string): never {
  throw new ValidationError("invalid_request", message);
}

/** Whether a version is valid for crates in this registry (docs/api.md 5.2). */
export function validateCargoVersion(version: string): boolean {
  return STRICT_SEMVER_RE.test(version) && parseVersion(version) !== null;
}

/**
 * The sparse index path of a crate, as cargo computes it from the lower-cased name: `1/<n>`,
 * `2/<n>`, `3/<first char>/<n>`, or `<chars 1-2>/<chars 3-4>/<n>`.
 */
export function indexPath(name: string): string {
  const n = name.toLowerCase();
  switch (n.length) {
    case 1:
      return `1/${n}`;
    case 2:
      return `2/${n}`;
    case 3:
      return `3/${n.slice(0, 1)}/${n}`;
    default:
      return `${n.slice(0, 2)}/${n.slice(2, 4)}/${n}`;
  }
}

function indexFileKey(name: string): string {
  return indexKey("cargo", indexPath(name));
}

function dlUrl(publicUrl: string, name: string, version: string): string {
  return `${publicUrl}/cargo/dl/${name}/${version}`;
}

/**
 * One dependency of an index line, checked against the index shape (docs/api.md 6.4) and
 * returned with its fields in the index order; `registry` and `package` are kept only when
 * given.
 */
function parseDependency(value: unknown, i: number): Json {
  const where = `manifest.deps[${i}]`;
  if (!isRecord(value)) invalid(`${where} must be an object.`);
  const d = value;
  if (typeof d.name !== "string" || !DEPENDENCY_NAME_RE.test(d.name)) {
    invalid(`${where}.name must be a crate name.`);
  }
  if (typeof d.req !== "string" || d.req.trim() === "") {
    invalid(`${where}.req must be a version requirement.`);
  }
  if (!isStringArray(d.features)) invalid(`${where}.features must be an array of strings.`);
  if (typeof d.optional !== "boolean") invalid(`${where}.optional must be a boolean.`);
  if (typeof d.default_features !== "boolean") {
    invalid(`${where}.default_features must be a boolean.`);
  }
  if (d.target !== null && typeof d.target !== "string") {
    invalid(`${where}.target must be a string or null.`);
  }
  if (typeof d.kind !== "string" || !DEPENDENCY_KINDS.has(d.kind)) {
    invalid(`${where}.kind must be normal, dev or build.`);
  }
  if (!isOptionalString(d.registry)) invalid(`${where}.registry must be a string or null.`);
  if (
    !isOptionalString(d.package) ||
    (typeof d.package === "string" && !DEPENDENCY_NAME_RE.test(d.package))
  ) {
    invalid(`${where}.package must be a crate name or null.`);
  }
  return {
    name: d.name,
    req: d.req,
    features: d.features,
    optional: d.optional,
    default_features: d.default_features,
    target: d.target,
    kind: d.kind,
    ...(d.registry === undefined ? {} : { registry: d.registry }),
    ...(d.package === undefined ? {} : { package: d.package }),
  };
}

function parseManifest(input: PublishInit): Manifest {
  const { name, version, manifest, files } = input;
  if (typeof name !== "string" || !CRATE_NAME_RE.test(name)) {
    invalid("`name` must be a lower-case crate name of at most 64 characters.");
  }
  if (typeof version !== "string" || !validateCargoVersion(version)) {
    invalid("`version` must be a semver version without build metadata.");
  }
  if (input.tag !== undefined) invalid("`tag` is only accepted for npm.");
  if (!isRecord(manifest)) invalid("`manifest` must be the cargo index line object.");
  if (manifest.name !== name) invalid("`manifest.name` must equal `name`.");
  if (manifest.vers !== version) invalid("`manifest.vers` must equal `version`.");
  if (!Array.isArray(manifest.deps)) invalid("`manifest.deps` must be an array.");
  const deps = manifest.deps.map(parseDependency);
  if (!isFeatureMap(manifest.features)) {
    invalid("`manifest.features` must map feature names to arrays of strings.");
  }
  if (manifest.features2 !== undefined && !isFeatureMap(manifest.features2)) {
    invalid("`manifest.features2` must map feature names to arrays of strings.");
  }
  if (!isOptionalString(manifest.links)) invalid("`manifest.links` must be a string or null.");
  if (!isOptionalString(manifest.rust_version)) {
    invalid("`manifest.rust_version` must be a string or null.");
  }
  const expected = `${name}-${version}.crate`;
  const archive = files.length === 1 ? archiveFileOf(files) : null;
  if (archive === null || archive.name !== expected) {
    invalid(`A cargo version has exactly one file: its archive ${expected}.`);
  }
  const file: ManifestFile = {
    name: archive.name,
    size: archive.size,
    sha256: archive.sha256,
    role: "archive",
  };
  const native: Json = { name, vers: version, deps, features: manifest.features };
  if (manifest.features2 !== undefined) native.features2 = manifest.features2;
  if (manifest.links !== undefined) native.links = manifest.links;
  if (manifest.rust_version !== undefined) native.rust_version = manifest.rust_version;
  return {
    eco: "cargo",
    name,
    version,
    files: [file],
    published: "",
    publishedBy: "",
    yanked: false,
    native,
  };
}

/** The sparse index line of a version: the stored fields plus `cksum`, `yanked` and `v: 2`. */
function indexLine(m: Manifest): Json {
  const n = m.native;
  const line: Json = {
    name: m.name,
    vers: m.version,
    deps: Array.isArray(n.deps) ? n.deps : [],
    cksum: archiveFileOf(m.files)?.sha256 ?? "",
    features: isRecord(n.features) ? n.features : {},
  };
  if (n.features2 !== undefined) line.features2 = n.features2;
  line.yanked = m.yanked;
  if (n.links !== undefined) line.links = n.links;
  if (n.rust_version !== undefined) line.rust_version = n.rust_version;
  line.v = 2;
  return line;
}

function toText(lines: readonly Json[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

/** One index file per crate, every version (yanked ones with `yanked: true`), lowest first. */
function buildIndex(name: string, manifests: Manifest[]): IndexFile[] {
  const lines = manifests
    .filter((m) => m.name === name)
    .sort((a, b) => compareVersions(a.version, b.version))
    .map(indexLine);
  return [{ key: indexFileKey(name), body: toText(lines), contentType: TEXT_TYPE }];
}

interface Line {
  name: string;
  vers: string;
  yanked: boolean;
  data: Json;
}

function parseLines(body: string): Line[] {
  const lines: Line[] = [];
  for (const text of body.split("\n")) {
    if (text.trim() === "") continue;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isRecord(data) || typeof data.name !== "string" || typeof data.vers !== "string") {
      continue;
    }
    if (!validateCargoVersion(data.vers)) continue;
    lines.push({ name: data.name, vers: data.vers, yanked: data.yanked === true, data });
  }
  return lines;
}

/** The minimal crate metadata of `GET /cargo/api/v1/crates/<name>`, highest version first. */
function crateInfo(lines: readonly Line[]): Json {
  const sorted = [...lines].sort((a, b) => compareVersions(b.vers, a.vers));
  const max = sorted.find((l) => !l.yanked) ?? sorted[0];
  return {
    crate: {
      name: max?.name ?? "",
      max_version: max?.vers ?? "",
      versions: sorted.map((l) => ({ num: l.vers, yanked: l.yanked })),
    },
  };
}

/**
 * Keeps the lines of the versions the credential may see; `null` (`404`) when none is left,
 * so cargo reports an unknown crate rather than an empty index file. With the `api` view the
 * kept versions are rendered as {@link crateInfo}.
 */
function filterIndex(
  body: unknown,
  allowed: (name: string, version: string) => boolean,
  route?: IndexRoute,
): unknown {
  if (typeof body !== "string") return body;
  const kept = parseLines(body).filter((l) => allowed(l.name, l.vers));
  if (kept.length === 0) return null;
  if (route?.view === "api") return crateInfo(kept);
  return toText(kept.map((l) => l.data));
}

const DL_RE = /^\/cargo\/dl\/([^/]+)\/([^/]+)$/;
const API_RE = /^\/cargo\/api\/v1\/crates\/([^/]+)$/;
const INDEX_PREFIX = "/cargo/index/";

/**
 * `/cargo/index/config.json`, the sparse index files (`/cargo/index/<path>`, only at the path
 * cargo computes for the name), `/cargo/dl/<crate>/<version>` and
 * `/cargo/api/v1/crates/<name>`.
 */
function route(req: Request, url: URL): NativeRoute | null {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const path = url.pathname;
  if (path === `${INDEX_PREFIX}config.json`) return { kind: "config" };
  if (path.startsWith(INDEX_PREFIX)) {
    const rest = path.slice(INDEX_PREFIX.length);
    const name = rest.slice(rest.lastIndexOf("/") + 1);
    if (!CRATE_NAME_RE.test(name) || rest !== indexPath(name)) return null;
    return { kind: "index", key: indexFileKey(name), name };
  }
  const dl = DL_RE.exec(path);
  if (dl) {
    const name = dl[1] ?? "";
    const version = dl[2] ?? "";
    if (!CRATE_NAME_RE.test(name) || !validateCargoVersion(version)) return null;
    return { kind: "archive", name, version, file: null };
  }
  const api = API_RE.exec(path);
  if (api) {
    const name = api[1] ?? "";
    if (!CRATE_NAME_RE.test(name)) return null;
    return { kind: "index", key: indexFileKey(name), name, view: "api" };
  }
  return null;
}

/** cargo's `config.json` of the sparse registry. */
function buildConfig(ctx: IndexContext): unknown {
  return {
    dl: `${ctx.publicUrl}/cargo/dl/{crate}/{version}`,
    api: `${ctx.publicUrl}/cargo`,
    "auth-required": true,
  };
}

/**
 * The `deps[]` entries from this registry (`registry` absent or `null`), named by the real
 * crate name (`package` when the dependency is renamed), every kind included.
 */
function dependencies(m: Manifest): Dependency[] {
  const deps = m.native.deps;
  if (!Array.isArray(deps)) return [];
  const out: Dependency[] = [];
  for (const dep of deps) {
    if (!isRecord(dep) || (dep.registry !== undefined && dep.registry !== null)) continue;
    const name = typeof dep.package === "string" ? dep.package : dep.name;
    if (typeof name !== "string" || typeof dep.req !== "string") continue;
    out.push({ name, constraint: dep.req });
  }
  return out;
}

function clientConfig(baseUrl: string, token: string, packages: string[]): Snippet[] {
  const base = baseUrl.replace(/\/+$/, "");
  const crates = [...packages].sort();
  const dependencyLines = (crates.length > 0 ? crates : ["my-crate"])
    .map((name) => `${name} = { version = "*", registry = "${REGISTRY_NAME}" }\n`)
    .join("");
  const snippets: Snippet[] = [
    {
      title: ".cargo/config.toml",
      description:
        "Declare the registry in the project's .cargo/config.toml (or in ~/.cargo/config.toml).",
      group: "Set up the registry",
      variant: "Files",
      filename: "config.toml",
      language: "toml",
      body: `[registries.${REGISTRY_NAME}]\nindex = "sparse+${base}/cargo/index/"\n`,
    },
    {
      title: "~/.cargo/credentials.toml",
      description: "Store the token in your home directory's Cargo credentials; never commit it.",
      group: "Set up the registry",
      variant: "Files",
      filename: "credentials.toml",
      language: "toml",
      body: `[registries.${REGISTRY_NAME}]\ntoken = "${token}"\n`,
    },
    {
      title: "Environment variables",
      description:
        "Or, without any file (e.g. in CI), declare the registry and its token in the environment; Cargo has no command that adds a registry.",
      group: "Set up the registry",
      variant: "Environment variables",
      filename: "terminal",
      language: "shell",
      body:
        `export CARGO_REGISTRIES_${ENV_NAME}_INDEX=sparse+${base}/cargo/index/\n` +
        `export CARGO_REGISTRIES_${ENV_NAME}_TOKEN=${token}\n`,
    },
    {
      title: "Cargo.toml",
      description:
        "Depend on the crates from this registry in the project's Cargo.toml. Keep registry on every dependency on a private crate: without it Cargo resolves the name against crates.io, where anyone can publish a crate of the same name (dependency confusion).",
      filename: "Cargo.toml",
      language: "toml",
      body: `[dependencies]\n${dependencyLines}`,
    },
  ];
  if (crates.length > 0) {
    snippets.push({
      title: "Install",
      description: "Or add the dependency from the command line.",
      filename: "terminal",
      language: "shell",
      body: `cargo add --registry ${REGISTRY_NAME} ${crates.join(" ")}\n`,
    });
  }
  return snippets;
}

/** The command that adds exactly one version, for the panel's version page. */
function versionSnippets(_baseUrl: string, name: string, version: string): Snippet[] {
  return [
    {
      title: "Add this version",
      description:
        "Depend on exactly this version (= pins it; without it Cargo may pick a newer compatible one).",
      filename: "terminal",
      language: "shell",
      body: `cargo add ${name}@=${version} --registry ${REGISTRY_NAME}\n`,
    },
  ];
}

/** The cargo adapter. */
export const cargoAdapter: Adapter = {
  eco: "cargo",
  parseManifest,
  fileKey: (m, file) => fileKey("cargo", m.name, m.version, file.name),
  buildIndex,
  route,
  buildConfig,
  filterIndex,
  fileUrl: (m, _file, publicUrl) => dlUrl(publicUrl, m.name, m.version),
  versionUrl: (m, publicUrl) => dlUrl(publicUrl, m.name, m.version),
  clientConfig,
  versionSnippets,
  satisfies: (version, constraint) => satisfies(version, constraint, "cargo"),
  validateRange: (constraint) => isValidRange(constraint, "cargo"),
  validateVersion: validateCargoVersion,
  compareVersions: (a, b) => compareVersions(a, b),
  dependencies,
};
