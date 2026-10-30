/**
 * Maven adapter (see "Maven" in docs/spec.md and the Maven repository in docs/api.md section
 * 11): the Maven 2 repository layout for Maven and Gradle (Android included). A version is the
 * files a build deployed for it (`.pom`, the archive by packaging, sources, javadoc, Gradle
 * module metadata, other classifiers), each with a role derived from its name; `native` is the
 * effective POM and its dependencies as the CLI reads them.
 *
 * Coordinates are case-sensitive; the package name is `<groupId>:<artifactId>`, verbatim in R2
 * keys. The kernel computes `sha1`, `md5` and `sha512` of every file at `commit`
 * ({@link mavenAdapter.digests}); together with `sha256` they are served as the checksum files
 * Maven and Gradle verify.
 *
 * Index layout: one JSON document per artifact, `maven/index/<groupId>/<artifactId>/index.json`,
 * with every version (yanked ones included), its `published` time and the digests of its files.
 * `maven-metadata.xml` is not stored: it depends on the credential (the versions it may see and
 * their newest `published` as `<lastUpdated>`), so it is generated from this document for every
 * request, and its checksums are computed from the generated XML. The file checksums of
 * `…/<version>/<file>.sha1` come from the same document, so no request reads a manifest.
 */

import { ValidationError } from "../../core/errors";
import { fileKey, indexKey } from "../../core/storage";
import {
  RawIndexBody,
  type Adapter,
  type Dependency,
  type IndexFile,
  type IndexRoute,
  type Manifest,
  type ManifestFile,
  type NativeRoute,
  type PublishInit,
  type Snippet,
} from "../types";
import {
  compareMavenVersions,
  isMavenPrerelease,
  isValidMavenRange,
  isValidMavenVersion,
  satisfiesMavenRange,
} from "./version";

type Json = Record<string, unknown>;

/** `groupId`: dot-separated segments; `artifactId` (docs/api.md 6.4). */
const GROUP_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
export const MAVEN_GROUP_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
export const MAVEN_ARTIFACT_RE = /^[A-Za-z0-9_.-]+$/;

/** Packaging names as written in `<packaging>`. */
const PACKAGING_RE = /^[A-Za-z0-9_.-]+$/;

/** File names the Worker serves itself (docs/api.md 6.4 and 11.4). */
const CHECKSUM_FILE_RE = /\.(?:md5|sha1|sha256|sha512)$/i;
const FILE_NAME_RE = /^[A-Za-z0-9._+-]{1,255}$/;

/** Dependency scopes of a POM. */
const SCOPES: ReadonlySet<string> = new Set([
  "compile",
  "runtime",
  "provided",
  "test",
  "import",
  "system",
]);

/** The checksum algorithms of the repository layout and their Web Crypto names. */
const CHECKSUMS = { sha1: "SHA-1", md5: "MD5", sha256: "SHA-256", sha512: "SHA-512" } as const;
type Checksum = keyof typeof CHECKSUMS;

const METADATA_RE = /^maven-metadata\.xml(?:\.(sha1|md5|sha256|sha512))?$/;
const FILE_CHECKSUM_RE = /^(.+)\.(sha1|md5|sha256|sha512)$/;

const JSON_TYPE = "application/json";
const XML_TYPE = "application/xml";
const TEXT_TYPE = "text/plain";

const PREFIX = "/maven/";

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
  throw new ValidationError("internal_error", "A stored Maven index is malformed.");
}

/** `groupId` and `artifactId` of a name `<groupId>:<artifactId>`; `null` when it is not one. */
export function splitCoordinates(name: string): { groupId: string; artifactId: string } | null {
  const colon = name.indexOf(":");
  if (colon === -1) return null;
  const groupId = name.slice(0, colon);
  const artifactId = name.slice(colon + 1);
  return MAVEN_GROUP_RE.test(groupId) && MAVEN_ARTIFACT_RE.test(artifactId)
    ? { groupId, artifactId }
    : null;
}

/** `maven/index/<groupId>/<artifactId>/index.json`. */
export function mavenIndexKey(groupId: string, artifactId: string): string {
  return indexKey("maven", groupId, artifactId, "index.json");
}

/** `<publicUrl>/maven/<group/as/path>/<artifactId>`. */
function artifactUrl(publicUrl: string, groupId: string, artifactId: string): string {
  return `${publicUrl}/maven/${groupId.replaceAll(".", "/")}/${artifactId}`;
}

/** The extension of the main artifact of a packaging; `null` for `pom` (as the CLI does). */
export function archiveExtension(packaging: string): string | null {
  switch (packaging) {
    case "pom":
    case "module":
      return null;
    case "jar":
    case "maven-plugin":
    case "ejb":
    case "bundle":
      return "jar";
    default:
      return packaging;
  }
}

/**
 * Precedence of two versions for listings: `ComparableVersion` order, and byte order between
 * versions it considers equal (`1.0` and `1.0.0`), so that the order is total.
 */
export function compareVersions(a: string, b: string): number {
  return compareMavenVersions(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------------

/** One `<dependency>` of the POM (docs/api.md 6.4). */
export interface MavenDependency {
  groupId: string;
  artifactId: string;
  /** A version or a range as written; `null` when an imported BOM manages it. */
  version: string | null;
  scope: string;
  optional: boolean;
}

/** `native` of a Maven manifest: the init `manifest` as normalised by the adapter. */
export interface MavenNative {
  groupId: string;
  artifactId: string;
  version: string;
  packaging: string;
  pom: string;
  dependencies: MavenDependency[];
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function parseDependencies(value: unknown): MavenDependency[] {
  if (!Array.isArray(value)) invalid("`manifest.dependencies` must be an array.");
  return value.map((dep: unknown, i): MavenDependency => {
    const where = `manifest.dependencies[${i}]`;
    if (!isRecord(dep)) invalid(`\`${where}\` must be an object.`);
    const { groupId, artifactId, version = null, scope, optional } = dep;
    if (!nonEmpty(groupId) || !nonEmpty(artifactId)) {
      invalid(`\`${where}\` must have a groupId and an artifactId.`);
    }
    if (version !== null && !nonEmpty(version)) {
      invalid(`\`${where}.version\` must be a version, a range or null.`);
    }
    if (typeof scope !== "string" || !SCOPES.has(scope)) {
      invalid(`\`${where}.scope\` must be compile, runtime, provided, test, import or system.`);
    }
    if (typeof optional !== "boolean") invalid(`\`${where}.optional\` must be a boolean.`);
    return { groupId, artifactId, version, scope, optional };
  });
}

function parseNative(input: PublishInit, groupId: string, artifactId: string): MavenNative {
  const m = input.manifest;
  if (m.groupId !== groupId || m.artifactId !== artifactId) {
    invalid("`manifest.groupId` and `manifest.artifactId` must equal `name`.");
  }
  if (m.version !== input.version) invalid("`manifest.version` must equal `version`.");
  if (typeof m.packaging !== "string" || !PACKAGING_RE.test(m.packaging)) {
    invalid("`manifest.packaging` must be the POM's <packaging> (`jar` when it has none).");
  }
  if (!nonEmpty(m.pom)) invalid("`manifest.pom` must be the effective POM as XML.");
  return {
    groupId,
    artifactId,
    version: input.version,
    packaging: m.packaging,
    pom: m.pom,
    dependencies: parseDependencies(m.dependencies),
  };
}

/** The role of a file of `<artifactId>-<version>`, derived from its name (docs/api.md 6.4). */
export function roleOf(file: string, base: string, packaging: string): string | null {
  if (!file.startsWith(base) || !/^(?:-[^.]+)?\..+$/.test(file.slice(base.length))) return null;
  const extension = archiveExtension(packaging);
  if (file === `${base}.pom`) return "pom";
  if (extension !== null && file === `${base}.${extension}`) return "archive";
  if (file === `${base}-sources.jar`) return "sources";
  if (file === `${base}-javadoc.jar`) return "javadoc";
  if (file === `${base}.module`) return "module";
  return "extra";
}

function parseFiles(input: PublishInit, native: MavenNative): ManifestFile[] {
  const base = `${native.artifactId}-${native.version}`;
  const files = input.files.map((f): ManifestFile => {
    if (CHECKSUM_FILE_RE.test(f.name)) {
      invalid(`${f.name}: checksum files are not uploaded; the registry serves them itself.`);
    }
    const role = roleOf(f.name, base, native.packaging);
    if (role === null) invalid(`${f.name}: Maven files are named ${base}[-<classifier>].<ext>.`);
    if (f.role !== undefined && f.role !== role) invalid(`${f.name} has the role ${role}.`);
    return { name: f.name, size: f.size, sha256: f.sha256, role };
  });
  if (!files.some((f) => f.role === "pom")) invalid(`The POM ${base}.pom is missing.`);
  return files;
}

function parseManifest(input: PublishInit): Manifest {
  const { name, version } = input;
  const coords = typeof name === "string" ? splitCoordinates(name) : null;
  if (coords === null) invalid("`name` must be <groupId>:<artifactId>.");
  if (typeof version !== "string" || !isValidMavenVersion(version)) {
    invalid("`version` must match [A-Za-z0-9._+-]{1,128} and must not be a -SNAPSHOT.");
  }
  if (input.tag !== undefined) invalid("`tag` is only accepted for npm.");
  if (!isRecord(input.manifest)) invalid("`manifest` must be an object.");
  const native = parseNative(input, coords.groupId, coords.artifactId);
  return {
    eco: "maven",
    name,
    version,
    files: parseFiles(input, native),
    published: "",
    publishedBy: "",
    yanked: false,
    native: { ...native },
  };
}

/** The coordinates and dependencies of a stored manifest (tolerant of hand-edited ones). */
function nativeOf(m: Manifest): MavenNative {
  const n = m.native;
  const coords = splitCoordinates(m.name);
  const deps = Array.isArray(n.dependencies) ? n.dependencies : [];
  return {
    groupId: typeof n.groupId === "string" ? n.groupId : (coords?.groupId ?? ""),
    artifactId: typeof n.artifactId === "string" ? n.artifactId : (coords?.artifactId ?? ""),
    version: m.version,
    packaging: typeof n.packaging === "string" ? n.packaging : "jar",
    pom: typeof n.pom === "string" ? n.pom : "",
    dependencies: deps
      .filter(isRecord)
      .filter((d) => typeof d.groupId === "string" && typeof d.artifactId === "string")
      .map((d) => ({
        groupId: String(d.groupId),
        artifactId: String(d.artifactId),
        version: typeof d.version === "string" ? d.version : null,
        scope: typeof d.scope === "string" ? d.scope : "compile",
        optional: d.optional === true,
      })),
  };
}

/**
 * `compile` and `runtime` dependencies that are not optional and have a version
 * (docs/api.md 5.3). A range is used as written; a plain version is exact, so it becomes the
 * range `[<version>]` (a plain version as a grant would be a minimum).
 */
function dependencies(m: Manifest): Dependency[] {
  return nativeOf(m)
    .dependencies.filter(
      (d) => (d.scope === "compile" || d.scope === "runtime") && !d.optional && d.version !== null,
    )
    .map((d) => {
      const version = (d.version ?? "").trim();
      return {
        name: `${d.groupId}:${d.artifactId}`,
        constraint: /^[[(]/.test(version) ? version : `[${version}]`,
      };
    });
}

// ---------------------------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------------------------

/** One version of the stored index. */
interface StoredVersion {
  version: string;
  published: string;
  yanked: boolean;
  /** The checksums of every file by name: `sha256` and the digests computed at `commit`. */
  files: Record<string, Record<string, string>>;
}

/** `maven/index/<groupId>/<artifactId>/index.json`: every version, ascending. */
interface StoredArtifact {
  name: string;
  groupId: string;
  artifactId: string;
  versions: StoredVersion[];
}

function storedVersion(m: Manifest): StoredVersion {
  return {
    version: m.version,
    published: m.published,
    yanked: m.yanked,
    files: Object.fromEntries(
      m.files.map((f) => [f.name, { sha256: f.sha256, ...(f.digests ?? {}) }]),
    ),
  };
}

function buildIndex(name: string, manifests: Manifest[]): IndexFile[] {
  const coords = splitCoordinates(name);
  if (coords === null) return [];
  const index: StoredArtifact = {
    name,
    ...coords,
    versions: manifests
      .filter((m) => m.name === name)
      .sort((a, b) => compareVersions(a.version, b.version))
      .map(storedVersion),
  };
  return [
    {
      key: mavenIndexKey(coords.groupId, coords.artifactId),
      body: JSON.stringify(index),
      contentType: JSON_TYPE,
    },
  ];
}

function isStoredVersion(value: unknown): value is StoredVersion {
  return (
    isRecord(value) &&
    typeof value.version === "string" &&
    typeof value.published === "string" &&
    typeof value.yanked === "boolean" &&
    isRecord(value.files)
  );
}

function parseStored(body: unknown): StoredArtifact | null {
  if (
    !isRecord(body) ||
    typeof body.name !== "string" ||
    typeof body.groupId !== "string" ||
    typeof body.artifactId !== "string" ||
    !Array.isArray(body.versions)
  ) {
    return null;
  }
  return {
    ...(body as unknown as StoredArtifact),
    versions: body.versions.filter(isStoredVersion),
  };
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** `yyyyMMddHHmmss` in UTC of the newest timestamp. */
function lastUpdated(published: readonly string[]): string {
  const times = published.map((p) => Date.parse(p)).filter((t) => !Number.isNaN(t));
  const d = new Date(times.length === 0 ? 0 : Math.max(...times));
  return (
    pad(d.getUTCFullYear(), 4) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

/** `maven-metadata.xml` of the listed versions (non-empty, ascending; docs/api.md 11.2). */
export function metadataXml(
  groupId: string,
  artifactId: string,
  versions: readonly StoredVersion[],
): string {
  const latest = versions[versions.length - 1]?.version ?? "";
  const release = versions.filter((v) => !isMavenPrerelease(v.version)).pop()?.version;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<metadata>\n` +
    `  <groupId>${groupId}</groupId>\n` +
    `  <artifactId>${artifactId}</artifactId>\n` +
    `  <versioning>\n` +
    `    <latest>${latest}</latest>\n` +
    (release === undefined ? "" : `    <release>${release}</release>\n`) +
    `    <versions>\n` +
    versions.map((v) => `      <version>${v.version}</version>\n`).join("") +
    `    </versions>\n` +
    `    <lastUpdated>${lastUpdated(versions.map((v) => v.published))}</lastUpdated>\n` +
    `  </versioning>\n` +
    `</metadata>\n`
  );
}

/** Lower-case hex digest of a text's UTF-8 bytes. */
async function hexDigest(algorithm: Checksum, text: string): Promise<string> {
  const digest = await crypto.subtle.digest(CHECKSUMS[algorithm], new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isChecksum(value: string): value is Checksum {
  return Object.hasOwn(CHECKSUMS, value);
}

/**
 * Views of the stored index: `metadata` (the XML) and `metadata.<algorithm>` (its checksum)
 * over the visible, non-yanked versions; `file.<algorithm>` the checksum of
 * `selector.file` of `selector.version`, yanked versions included.
 */
function filterIndex(
  body: unknown,
  allowed: (name: string, version: string) => boolean,
  route?: IndexRoute,
): unknown {
  const index = parseStored(body);
  if (index === null) malformed();
  const visible = index.versions
    .filter((v) => allowed(index.name, v.version))
    .sort((a, b) => compareVersions(a.version, b.version));
  const [view = "metadata", algorithm = ""] = (route?.view ?? "metadata").split(".");
  if (view === "file") {
    const entry = visible.find((v) => v.version === route?.selector?.version);
    const file = route?.selector?.file;
    const digest = file === undefined ? undefined : entry?.files[file]?.[algorithm];
    if (typeof digest !== "string") notFound();
    return new RawIndexBody(digest, TEXT_TYPE);
  }
  const listed = visible.filter((v) => !v.yanked);
  if (listed.length === 0) notFound();
  const xml = metadataXml(index.groupId, index.artifactId, listed);
  if (algorithm === "") return new RawIndexBody(xml, XML_TYPE);
  if (!isChecksum(algorithm)) notFound();
  return hexDigest(algorithm, xml).then((hex) => new RawIndexBody(hex, TEXT_TYPE));
}

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

function decodeSegment(segment: string): string | null {
  if (segment === "") return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** `<groupId>:<artifactId>` of path segments, or `null`. */
function coordinatesOf(group: readonly string[], artifactId: string | undefined) {
  if (group.length === 0 || !group.every((s) => GROUP_SEGMENT_RE.test(s))) return null;
  if (artifactId === undefined || !MAVEN_ARTIFACT_RE.test(artifactId)) return null;
  const groupId = group.join(".");
  return { groupId, artifactId, name: `${groupId}:${artifactId}` };
}

/**
 * Paths are parsed from their end (docs/api.md 11.1): `maven-metadata.xml` and its checksums
 * belong to `<group/as/path>/<artifactId>/`; any other file to
 * `<group/as/path>/<artifactId>/<version>/`. A version-level `maven-metadata.xml` names an
 * artifact that does not exist and answers `404`.
 */
function route(req: Request, url: URL): NativeRoute | null {
  if (req.method !== "GET" || !url.pathname.startsWith(PREFIX)) return null;
  const segments = url.pathname.slice(PREFIX.length).split("/").map(decodeSegment);
  if (segments.length < 3 || segments.some((s) => s === null)) return null;
  const parts = segments as string[];
  const file = parts[parts.length - 1] ?? "";
  const metadata = METADATA_RE.exec(file);
  if (metadata !== null) {
    const coords = coordinatesOf(parts.slice(0, -2), parts[parts.length - 2]);
    if (coords === null) return null;
    return {
      kind: "index",
      key: mavenIndexKey(coords.groupId, coords.artifactId),
      name: coords.name,
      view: metadata[1] === undefined ? "metadata" : `metadata.${metadata[1]}`,
    };
  }
  const version = parts[parts.length - 2] ?? "";
  const coords = coordinatesOf(parts.slice(0, -3), parts[parts.length - 3]);
  if (coords === null || !isValidMavenVersion(version) || !FILE_NAME_RE.test(file)) return null;
  const checksum = FILE_CHECKSUM_RE.exec(file);
  if (checksum !== null) {
    return {
      kind: "index",
      key: mavenIndexKey(coords.groupId, coords.artifactId),
      name: coords.name,
      view: `file.${checksum[2] ?? ""}`,
      selector: { version, file: checksum[1] ?? "" },
    };
  }
  return { kind: "archive", name: coords.name, version, file };
}

// ---------------------------------------------------------------------------------------------
// URLs and client configuration
// ---------------------------------------------------------------------------------------------

function fileUrl(m: Manifest, file: ManifestFile, publicUrl: string): string {
  const { groupId, artifactId } = nativeOf(m);
  return `${artifactUrl(publicUrl, groupId, artifactId)}/${m.version}/${file.name}`;
}

function versionUrl(m: Manifest, publicUrl: string): string {
  const file =
    m.files.find((f) => f.role === "archive") ??
    m.files.find((f) => f.role === "pom") ??
    m.files[0];
  return file === undefined ? "" : fileUrl(m, file, publicUrl);
}

function xmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** A `settings.xml` with the credentials of the server `sreg` (texts already escaped). */
function settingsXml(username: string, password: string): string {
  return (
    `<settings>\n` +
    `  <servers>\n` +
    `    <server>\n` +
    `      <id>sreg</id>\n` +
    `      <username>${username}</username>\n` +
    `      <password>${password}</password>\n` +
    `    </server>\n` +
    `  </servers>\n` +
    `</settings>\n`
  );
}

function clientConfig(baseUrl: string, token: string, packages: string[]): Snippet[] {
  const repository = `${baseUrl.replace(/\/+$/, "")}/maven`;
  const colon = token.indexOf(":");
  const login = colon === -1 ? token : token.slice(0, colon);
  const password = colon === -1 ? "" : token.slice(colon + 1);
  const coords = splitCoordinates([...packages].sort()[0] ?? "") ?? {
    groupId: "com.acme",
    artifactId: "sdk",
  };
  // The groups the secret can read; Gradle only looks them up here (dependency confusion).
  const groups = [
    ...new Set(
      packages.flatMap((name) => {
        const c = splitCoordinates(name);
        return c === null ? [] : [c.groupId];
      }),
    ),
  ].sort();
  if (groups.length === 0) groups.push(coords.groupId);
  const gradleRepository = (credentials: string) =>
    `repositories {\n` +
    `    exclusiveContent {\n` +
    `        forRepository {\n` +
    `            maven {\n` +
    `                url = uri("${repository}")\n` +
    `                credentials {\n` +
    credentials +
    `                }\n` +
    `            }\n` +
    `        }\n` +
    `        filter {\n` +
    groups.map((g) => `            includeGroup("${g}")\n`).join("") +
    `        }\n` +
    `    }\n` +
    `}\n`;
  return [
    {
      title: "Maven credentials",
      description:
        "Store the token as the credentials of the server sreg in ~/.m2/settings.xml (or in a settings.xml passed with mvn -s settings.xml, e.g. in CI); Maven has no command for it.",
      group: "Build tool",
      variant: "Maven",
      filename: "~/.m2/settings.xml",
      language: "xml",
      body: settingsXml(xmlText(login), xmlText(password)),
    },
    {
      title: "Maven repository",
      description:
        "Add the repository and the dependency to the project's pom.xml. Maven has no per-repository content filter: to keep a public artifact of the same coordinates from being picked, declare these groups only here, consider a mirror with <mirrorOf> that routes everything else to a trusted proxy, or enforce it with the maven-enforcer-plugin.",
      group: "Build tool",
      variant: "Maven",
      filename: "pom.xml",
      language: "xml",
      body:
        `<repositories>\n` +
        `  <repository>\n` +
        `    <id>sreg</id>\n` +
        `    <url>${xmlText(repository)}</url>\n` +
        `  </repository>\n` +
        `</repositories>\n\n` +
        `<dependencies>\n` +
        `  <dependency>\n` +
        `    <groupId>${coords.groupId}</groupId>\n` +
        `    <artifactId>${coords.artifactId}</artifactId>\n` +
        `    <version>1.0.0</version>\n` +
        `  </dependency>\n` +
        `</dependencies>\n`,
    },
    {
      title: "Gradle (Kotlin DSL)",
      description:
        "With Gradle, add the repository with its credentials and the dependency to build.gradle.kts. exclusiveContent makes the listed groups resolve only from this repository and never from any other (dependency confusion).",
      group: "Build tool",
      variant: "Gradle",
      filename: "build.gradle.kts",
      language: "kotlin",
      body:
        gradleRepository(
          `                    username = "${login}"\n` +
            `                    password = "${password}"\n`,
        ) +
        `\n` +
        `dependencies {\n` +
        `    implementation("${coords.groupId}:${coords.artifactId}:1.0.0")\n` +
        `}\n`,
    },
    {
      title: "Maven credentials from the environment",
      description:
        "With Maven, read the token from the environment in settings.xml (Maven expands env. properties), together with the pom.xml entries of the Maven variant.",
      group: "Build tool",
      variant: "Environment variables",
      filename: "settings.xml",
      language: "xml",
      body: settingsXml(xmlText(login), "${env.REGISTRY_TOKEN}"),
    },
    {
      title: "Gradle credentials from the environment",
      description:
        "With Gradle, read the login and the token from the environment in build.gradle.kts.",
      group: "Build tool",
      variant: "Environment variables",
      filename: "build.gradle.kts",
      language: "kotlin",
      body: gradleRepository(
        `                    username = System.getenv("REGISTRY_LOGIN")\n` +
          `                    password = System.getenv("REGISTRY_TOKEN")\n`,
      ),
    },
  ];
}

/** The dependency on exactly one version (Maven and Gradle), for the panel's version page. */
function versionSnippets(_baseUrl: string, name: string, version: string): Snippet[] {
  const coords = splitCoordinates(name) ?? { groupId: name, artifactId: name };
  return [
    {
      title: "pom.xml",
      description: "Depend on exactly this version in the dependencies of pom.xml.",
      group: "Build tool",
      variant: "Maven",
      filename: "pom.xml",
      language: "xml",
      body:
        `<dependency>\n` +
        `  <groupId>${xmlText(coords.groupId)}</groupId>\n` +
        `  <artifactId>${xmlText(coords.artifactId)}</artifactId>\n` +
        `  <version>${xmlText(version)}</version>\n` +
        `</dependency>\n`,
    },
    {
      title: "build.gradle.kts",
      description: "Depend on exactly this version in the dependencies of build.gradle.kts.",
      group: "Build tool",
      variant: "Gradle",
      filename: "build.gradle.kts",
      language: "kotlin",
      body: `implementation("${coords.groupId}:${coords.artifactId}:${version}")\n`,
    },
  ];
}

/** The Maven adapter. */
export const mavenAdapter: Adapter = {
  eco: "maven",
  parseManifest,
  fileKey: (m, file) => fileKey("maven", m.name, m.version, file.name),
  digests: ["sha1", "md5", "sha512"],
  buildIndex,
  route,
  filterIndex,
  fileUrl,
  versionUrl,
  clientConfig,
  versionSnippets,
  satisfies: satisfiesMavenRange,
  validateRange: isValidMavenRange,
  validateVersion: isValidMavenVersion,
  compareVersions,
  dependencies,
};
