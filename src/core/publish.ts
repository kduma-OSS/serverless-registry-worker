/**
 * Publishing (see "Publishing" in docs/spec.md and docs/api.md 6.4–6.5): `init` validates a
 * declaration and hands out presigned `PUT` URLs for its files, `commit` verifies the staged
 * objects, writes the version manifest, moves the files to their final keys and rebuilds the
 * package index, `_meta/packages.json` and the ecosystem's dependency graph.
 */

import { getAdapter } from "../adapters/index";
import type {
  Adapter,
  DigestAlgorithm,
  Eco,
  IndexContext,
  Manifest,
  ManifestFile,
  PublishInit,
} from "../adapters/types";
import { isEco } from "../adapters/types";
import type { Env } from "../env";
import { requireRole, type Identity } from "./auth";
import { appendWindowHours, maxUploadBytes, presignConfig } from "./config";
import { ValidationError } from "./errors";
import { foldCase, isAllowed } from "./grants";
import { presignPut, sha256HexToBase64 } from "./presign";
import { publicNameWarnings } from "./publicNames";
import {
  addPackageToMeta,
  packageMetaEntry,
  appendFilesToManifest,
  deleteVersion,
  headStaged,
  isManifest,
  listManifests,
  manifestExists,
  manifestKey,
  promoteStagedWithDigests,
  readManifest,
  readStagingMeta,
  readStagingResult,
  setVersionDeps,
  stagingKey,
  updateJson,
  writeIndexFiles,
  writeManifest,
  writeStagingMeta,
  writeStagingResult,
  type StagingMeta,
} from "./storage";
import { rfc3339 } from "./time";

export type PublishEnv = Pick<
  Env,
  | "R2_BUCKET"
  | "AUTH"
  | "ECOSYSTEMS"
  | "MAX_UPLOAD_BYTES"
  | "APPEND_WINDOW_HOURS"
  | "S3_ENDPOINT"
  | "S3_ACCESS_KEY_ID"
  | "S3_SECRET_ACCESS_KEY"
  | "R2_BUCKET_NAME"
>;

/** Lifetime of the presigned upload URLs: 10 minutes. */
export const UPLOAD_TTL_SECONDS = 600;

/** File names: `[A-Za-z0-9._+-]{1,255}`, not `.`/`..`, not a name the storage layout uses. */
const FILE_NAME_RE = /^[A-Za-z0-9._+-]{1,255}$/;
/** Swift manifest variants may also contain `@` (`Package@swift-5.9.swift`, docs/api.md 6.4). */
const SWIFT_FILE_NAME_RE = /^[A-Za-z0-9._+@-]{1,255}$/;
const RESERVED_FILE_NAMES = new Set([".", "..", "manifest.json", "meta.json", "result.json"]);

const SHA256_RE = /^[0-9a-f]{64}$/;

/** Upload ids: 26 characters of Crockford base32 (a ULID: 48-bit time, 80 random bits). */
export const UPLOAD_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** One presigned upload of the `init` response. */
export interface UploadTarget {
  name: string;
  putUrl: string;
  headers: { "content-length": string; "x-amz-checksum-sha256": string };
}

/** Response of `POST /api/v1/publish/init`. */
export interface InitResponse {
  uploadId: string;
  /** RFC 3339: when the presigned URLs stop working. */
  expires: string;
  uploads: UploadTarget[];
  /** Informational dependency-confusion hints; omitted when there are none. Never blocking. */
  warnings?: string[];
}

/** Response of `POST /api/v1/publish/commit`. */
export interface CommitResponse {
  eco: Eco;
  name: string;
  version: string;
  /** Native download URL of the version's archive. */
  url: string;
  /** The files committed by this upload with their native download URLs. */
  files: { name: string; url: string | null }[];
}

/** A new upload id: a ULID whose time part is `now`. */
export function newUploadId(now: Date): string {
  let time = Math.max(0, Math.floor(now.getTime()));
  let id = "";
  for (let i = 0; i < 10; i++) {
    id = CROCKFORD[time % 32] + id;
    time = Math.floor(time / 32);
  }
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) id += CROCKFORD[byte & 31];
  return id;
}

function invalid(message: string): never {
  throw new ValidationError("invalid_request", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "string");
}

/** Validates the `files` of an `init` body: shape, names, sizes and digests. */
export function validateFiles(value: unknown, maxBytes: number, eco?: Eco): ManifestFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalid("`files` must be a non-empty array.");
  }
  const nameRe = eco === "swift" ? SWIFT_FILE_NAME_RE : FILE_NAME_RE;
  const names = new Set<string>();
  return value.map((item: unknown, i) => {
    if (!isRecord(item)) invalid(`files[${i}] must be an object.`);
    const { name, size, sha256, role, labels } = item;
    if (typeof name !== "string" || !nameRe.test(name) || RESERVED_FILE_NAMES.has(name)) {
      invalid(`files[${i}].name must match [A-Za-z0-9._+-]{1,255} and not be a reserved name.`);
    }
    if (names.has(name)) invalid(`File name ${name} is declared twice.`);
    names.add(name);
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) {
      invalid(`files[${i}].size must be a positive integer.`);
    }
    if (size > maxBytes) {
      throw new ValidationError(
        "payload_too_large",
        `File ${name} is larger than the limit of ${maxBytes} bytes.`,
      );
    }
    if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) {
      invalid(`files[${i}].sha256 must be 64 lower-case hexadecimal characters.`);
    }
    if (role !== undefined && (typeof role !== "string" || role === "")) {
      invalid(`files[${i}].role must be a non-empty string.`);
    }
    if (labels !== undefined && !isStringRecord(labels)) {
      invalid(`files[${i}].labels must be an object of strings.`);
    }
    return {
      name,
      size,
      sha256,
      ...(role === undefined ? {} : { role }),
      ...(labels === undefined ? {} : { labels }),
    };
  });
}

/** Validates the kernel-level fields of an `init` body (docs/api.md 6.4). */
export function parseInitBody(body: Record<string, unknown>, maxBytes: number): PublishInit {
  const { eco, name, version, files, manifest, tag, append } = body;
  if (!isEco(eco)) invalid("`eco` must name a supported ecosystem.");
  if (typeof name !== "string" || name === "") invalid("`name` must be a non-empty string.");
  if (typeof version !== "string" || version === "") {
    invalid("`version` must be a non-empty string.");
  }
  if (version.includes("/")) invalid("`version` must not contain `/`.");
  const checkedFiles = validateFiles(files, maxBytes, eco);
  if (!isRecord(manifest)) invalid("`manifest` must be an object.");
  if (tag !== undefined && typeof tag !== "string") invalid("`tag` must be a string.");
  if (append !== undefined && typeof append !== "boolean") invalid("`append` must be a boolean.");
  return {
    eco,
    name,
    version,
    files: checkedFiles,
    manifest,
    ...(tag === undefined ? {} : { tag }),
    ...(append === true ? { append: true } : {}),
  };
}

function adapterFor(env: Pick<Env, "ECOSYSTEMS">, eco: Eco): Adapter {
  const adapter = getAdapter(env, eco);
  if (adapter === null) invalid(`The ${eco} ecosystem is not enabled in this registry.`);
  return adapter;
}

/** The adapter's validation of the declaration, plus the version rules of the kernel. */
function parseWithAdapter(adapter: Adapter, input: PublishInit): Manifest {
  if (input.append && !adapter.supportsAppend) {
    invalid(`Files cannot be appended to ${adapter.eco} versions.`);
  }
  if (!adapter.validateVersion(input.version)) invalid(`Invalid ${adapter.eco} version.`);
  return adapter.parseManifest(input);
}

function requireGrant(identity: Identity, adapter: Adapter, m: Manifest): void {
  if (!isAllowed(identity.grants.publish, adapter.eco, m.name, m.version, adapter.satisfies)) {
    throw new ValidationError(
      "forbidden",
      `This credential may not publish ${m.name} ${m.version}.`,
    );
  }
  // A login token approved for particular versions allows nothing else (docs/api.md 2.6).
  const allowed =
    identity.scopes === undefined ||
    identity.scopes.some(
      (s) =>
        s.eco === m.eco &&
        foldCase(m.eco, s.package) === foldCase(m.eco, m.name) &&
        s.version === m.version,
    );
  if (!allowed) {
    throw new ValidationError(
      "forbidden",
      `This login token was not approved for ${m.name} ${m.version}.`,
    );
  }
}

/**
 * Checks that files may still be added to a version (docs/api.md 6.4.1): it is not yanked and
 * was published within `APPEND_WINDOW_HOURS` (`409 version_closed`) and has none of the names
 * (`409 file_exists`). Returns the existing manifest, or `null` when the version does not
 * exist yet: an append to a new version is a normal publish.
 */
async function checkAppend(env: PublishEnv, m: Manifest, now: Date): Promise<Manifest | null> {
  const existing = await readManifest(env, m.eco, m.name, m.version);
  if (existing === null) return null;
  if (existing.yanked) {
    throw new ValidationError("version_closed", "Files cannot be added to a yanked version.");
  }
  const published = Date.parse(existing.published);
  const windowMs = appendWindowHours(env) * 60 * 60 * 1000;
  if (Number.isNaN(published) || published + windowMs < now.getTime()) {
    throw new ValidationError(
      "version_closed",
      `Files can only be added within ${appendWindowHours(env)} hours of publishing.`,
    );
  }
  const taken = new Set(existing.files.map((f) => f.name));
  const clash = m.files.find((f) => taken.has(f.name));
  if (clash !== undefined) {
    throw new ValidationError("file_exists", `File ${clash.name} already exists.`);
  }
  return existing;
}

/**
 * Rebuilds the index of one package from all its manifests and returns them (lowest version
 * first). Nothing is written when the package has no manifests.
 */
export async function rebuildIndex(
  env: Pick<Env, "R2_BUCKET">,
  adapter: Adapter,
  name: string,
  ctx: IndexContext,
): Promise<Manifest[]> {
  const manifests = await listManifests(env, adapter.eco, name, adapter.compareVersions);
  if (manifests.length > 0) await writeIndexFiles(env, adapter.buildIndex(name, manifests, ctx));
  return manifests;
}

/**
 * `POST /api/v1/publish/init`: validates the declaration, checks the `publish` grant and
 * immutability, stores the declaration in staging and presigns one `PUT` per file.
 */
export async function init(
  env: PublishEnv,
  identity: Identity,
  body: Record<string, unknown>,
  now: Date,
): Promise<InitResponse> {
  requireRole(identity, "publish");
  const input = parseInitBody(body, maxUploadBytes(env));
  const adapter = adapterFor(env, input.eco);
  const parsed = parseWithAdapter(adapter, input);
  requireGrant(identity, adapter, parsed);
  if (input.append) await checkAppend(env, parsed, now);
  else if (await manifestExists(env, parsed.eco, parsed.name, parsed.version)) {
    throw new ValidationError("version_exists");
  }

  const config = presignConfig(env);
  const uploadId = newUploadId(now);
  const uploads = await Promise.all(
    parsed.files.map(async (file): Promise<UploadTarget> => {
      const signed = await presignPut({
        ...config,
        key: stagingKey(uploadId, file.name),
        contentLength: file.size,
        sha256Base64: sha256HexToBase64(file.sha256),
        expiresSeconds: UPLOAD_TTL_SECONDS,
        now,
      });
      return { name: file.name, putUrl: signed.url, headers: signed.headers };
    }),
  );
  const expires = new Date(now.getTime() + UPLOAD_TTL_SECONDS * 1000);
  // The declaration as sent: `commit` validates it again with the adapter, which may normalise
  // the name and version (NuGet) and checks them against `manifest`.
  const meta: StagingMeta = {
    eco: parsed.eco,
    name: input.name,
    version: input.version,
    files: parsed.files,
    manifest: input.manifest,
    ...(input.tag === undefined ? {} : { tag: input.tag }),
    ...(input.append ? { append: true } : {}),
    ...(adapter.digests !== undefined && adapter.digests.length > 0
      ? { digests: [...adapter.digests] }
      : {}),
    publishedBy: identity.project,
    createdAt: rfc3339(now),
    expires: rfc3339(expires),
  };
  await writeStagingMeta(env, uploadId, meta);
  const warnings = publicNameWarnings(parsed.eco, parsed.name);
  return {
    uploadId,
    expires: rfc3339(expires),
    uploads,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `head()` of every staged file against the declaration. */
async function verifyStaged(
  env: PublishEnv,
  uploadId: string,
  files: readonly ManifestFile[],
): Promise<void> {
  const heads = await Promise.all(files.map((f) => headStaged(env, uploadId, f.name)));
  files.forEach((file, i) => {
    const head = heads[i];
    if (head === null || head === undefined) {
      throw new ValidationError("upload_incomplete", `File ${file.name} has not been uploaded.`);
    }
    const sha = head.checksums.sha256;
    if (head.size !== file.size || (sha !== undefined && toHex(sha) !== file.sha256)) {
      throw new ValidationError(
        "upload_mismatch",
        `The uploaded ${file.name} does not match its declared size or SHA-256.`,
      );
    }
  });
}

/**
 * Moves the staged files to their final keys; R2 verifies the declared SHA-256. Computes the
 * extra `digests` on the way and returns them by file name (only for files that got any).
 */
async function promoteFiles(
  env: PublishEnv,
  adapter: Adapter,
  uploadId: string,
  m: Manifest,
  files: readonly ManifestFile[],
  digests: readonly DigestAlgorithm[],
): Promise<Map<string, Record<string, string>>> {
  const computed = new Map<string, Record<string, string>>();
  for (const file of files) {
    let promoted: Awaited<ReturnType<typeof promoteStagedWithDigests>>;
    try {
      promoted = await promoteStagedWithDigests(
        env,
        uploadId,
        file.name,
        adapter.fileKey(m, file),
        { sha256: file.sha256, digests },
      );
    } catch {
      throw new ValidationError(
        "upload_mismatch",
        `The uploaded ${file.name} does not match its declared SHA-256.`,
      );
    }
    if (promoted === null) {
      throw new ValidationError("upload_incomplete", `File ${file.name} has not been uploaded.`);
    }
    if (Object.keys(promoted.digests).length > 0) computed.set(file.name, promoted.digests);
  }
  return computed;
}

/** Stores the digests computed while promoting in the version manifest; returns it. */
async function recordDigests(
  env: PublishEnv,
  m: Manifest,
  computed: ReadonlyMap<string, Record<string, string>>,
): Promise<Manifest> {
  if (computed.size === 0) return m;
  return updateJson<Manifest>(
    env,
    manifestKey(m.eco, m.name, m.version),
    (current) => {
      if (current === null) throw new ValidationError("not_found");
      const files = current.files.map((f) => {
        const digests = computed.get(f.name);
        return digests === undefined ? f : { ...f, digests };
      });
      return { ...current, files };
    },
    { isValid: isManifest },
  );
}

/** Removes appended file names again after a failed append (best effort). */
async function revertAppend(env: PublishEnv, m: Manifest, files: readonly ManifestFile[]) {
  const names = new Set(files.map((f) => f.name));
  await updateJson<Manifest>(
    env,
    manifestKey(m.eco, m.name, m.version),
    (current) => {
      if (current === null) throw new ValidationError("not_found");
      return { ...current, files: current.files.filter((f) => !names.has(f.name)) };
    },
    { isValid: isManifest },
  );
}

/**
 * `POST /api/v1/publish/commit`: verifies the staged files against the `init` declaration,
 * writes the manifest (or appends the files to it), moves the files, rebuilds the index and
 * `_meta/packages.json`, and records the response so a retry returns it again.
 */
export async function commit(
  env: PublishEnv,
  identity: Identity,
  body: Record<string, unknown>,
  now: Date,
  publicUrl: string,
): Promise<CommitResponse> {
  requireRole(identity, "publish");
  const { uploadId } = body;
  if (typeof uploadId !== "string" || uploadId === "") invalid("`uploadId` must be a string.");
  const unknown = () => new ValidationError("not_found", "Unknown upload.");
  if (!UPLOAD_ID_RE.test(uploadId)) throw unknown();

  const done = await readStagingResult(env, uploadId);
  if (done !== null) {
    if (done.publishedBy !== identity.project) throw unknown();
    return done.response as unknown as CommitResponse;
  }
  const meta = await readStagingMeta(env, uploadId);
  if (meta === null || meta.publishedBy !== identity.project) throw unknown();
  const adapter = getAdapter(env, meta.eco);
  if (adapter === null) throw unknown();

  const parsed = parseWithAdapter(adapter, {
    eco: meta.eco,
    name: meta.name,
    version: meta.version,
    files: meta.files,
    manifest: meta.manifest,
    ...(meta.tag === undefined ? {} : { tag: meta.tag }),
    ...(meta.append ? { append: true } : {}),
  });
  requireGrant(identity, adapter, parsed);
  const existing = meta.append ? await checkAppend(env, parsed, now) : null;
  if (!meta.append && (await manifestExists(env, parsed.eco, parsed.name, parsed.version))) {
    throw new ValidationError("version_exists");
  }
  await verifyStaged(env, uploadId, parsed.files);

  const digests = meta.digests ?? [];
  let manifest: Manifest | null = null;
  let computed = new Map<string, Record<string, string>>();
  if (existing === null) {
    const fresh = {
      ...parsed,
      published: rfc3339(now),
      publishedBy: identity.project,
      yanked: false,
    };
    try {
      await writeManifest(env, fresh);
      manifest = fresh;
    } catch (err) {
      // A parallel append (another job of the same CI matrix) published the version first.
      const raced = err instanceof ValidationError && err.code === "version_exists";
      if (!meta.append || !raced) throw err;
      if ((await checkAppend(env, parsed, now)) === null) throw err;
    }
    if (manifest !== null) {
      try {
        computed = await promoteFiles(env, adapter, uploadId, manifest, parsed.files, digests);
      } catch (err) {
        await deleteVersion(env, manifest.eco, manifest.name, manifest.version);
        throw err;
      }
    }
  }
  if (manifest === null) {
    manifest = await appendFilesToManifest(
      env,
      parsed.eco,
      parsed.name,
      parsed.version,
      parsed.files,
    );
    try {
      computed = await promoteFiles(env, adapter, uploadId, manifest, parsed.files, digests);
    } catch (err) {
      await revertAppend(env, manifest, parsed.files);
      throw err;
    }
  }
  manifest = await recordDigests(env, manifest, computed);

  const manifests = await rebuildIndex(env, adapter, manifest.name, { publicUrl });
  await addPackageToMeta(
    env,
    manifest.eco,
    manifest.name,
    packageMetaEntry(adapter, manifests, rfc3339(now)),
  );
  await setVersionDeps(
    env,
    manifest.eco,
    manifest.name,
    manifest.version,
    adapter.dependencies(manifest),
  );

  const response: CommitResponse = {
    eco: manifest.eco,
    name: manifest.name,
    version: manifest.version,
    url: adapter.versionUrl(manifest, publicUrl),
    files: parsed.files.map((f) => ({
      name: f.name,
      url: adapter.fileUrl(manifest, f, publicUrl),
    })),
  };
  await writeStagingResult(env, uploadId, {
    publishedBy: identity.project,
    committedAt: rfc3339(now),
    response: { ...response },
  });
  return response;
}
