/** Explicit, resumable enrichment of old manifests with adapter-declared digests. */
import { getAdapter } from "../adapters/index";
import type { Manifest } from "../adapters/types";
import type { Env } from "../env";
import { ValidationError } from "./errors";
import { computeStoredDigests, isManifest, manifestKey, readManifest, updateJson } from "./storage";

/** Fields that must still describe the same publication when the hashes are ready. */
function declaration(m: Manifest): string {
  return JSON.stringify({
    eco: m.eco,
    name: m.name,
    version: m.version,
    published: m.published,
    publishedBy: m.publishedBy,
    native: m.native,
    files: m.files.map((file) => {
      const declared = { ...file };
      delete declared.digests;
      return declared;
    }),
  });
}

/** The caller enforces admin access. Does not rebuild indexes or change archive bytes. */
export async function backfillDigests(
  env: Pick<Env, "R2_BUCKET" | "ECOSYSTEMS">,
  eco: string,
  rawName: string,
  rawVersion: string,
): Promise<{ eco: string; name: string; version: string; updated: boolean }> {
  const adapter = getAdapter(env, eco);
  if (adapter === null || !adapter.validateVersion(rawVersion)) {
    throw new ValidationError("not_found");
  }
  const name = adapter.storedName?.(rawName) ?? rawName;
  const version = adapter.storedVersion?.(rawVersion) ?? rawVersion;
  const original = await readManifest(env, adapter.eco, name, version);
  if (original === null) throw new ValidationError("not_found");
  const computed = new Map<string, Record<string, string>>();
  for (const file of original.files) {
    const missing = (adapter.digests ?? []).filter((a) => file.digests?.[a] === undefined);
    if (missing.length === 0) continue;
    computed.set(
      file.name,
      await computeStoredDigests(env, adapter.fileKey(original, file), file, missing),
    );
  }
  let updated = false;
  if (computed.size > 0) {
    await updateJson<Manifest>(
      env,
      manifestKey(adapter.eco, name, version),
      (current) => {
        if (current === null) throw new ValidationError("not_found");
        if (declaration(current) !== declaration(original)) {
          throw new ValidationError("version_changed");
        }
        updated = false;
        const files = current.files.map((file) => {
          const missing = Object.entries(computed.get(file.name) ?? {}).filter(
            ([a]) => file.digests?.[a] === undefined,
          );
          if (missing.length === 0) return file;
          updated = true;
          return { ...file, digests: { ...file.digests, ...Object.fromEntries(missing) } };
        });
        return { ...current, files };
      },
      { isValid: isManifest },
    );
  }
  return { eco: adapter.eco, name, version, updated };
}
