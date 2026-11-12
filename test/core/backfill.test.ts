import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Manifest } from "../../src/adapters/types";
import { backfillDigests } from "../../src/core/backfill";
import { fileKey, manifestKey, readManifest, writeManifest } from "../../src/core/storage";

const NAME = "acme/backfill";
const KEY = manifestKey("composer", NAME, "1.0.0");
const bytes = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");
const SHA256 = "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592";
const SHA1 = "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12";
const run = () => backfillDigests(env, "composer", NAME, "1.0.0");
const read = () => readManifest(env, "composer", NAME, "1.0.0");
function archive(m: Manifest) {
  const file = m.files[0];
  if (file === undefined) throw new Error("Missing test archive");
  return file;
}

async function seed() {
  const m: Manifest = {
    eco: "composer",
    name: NAME,
    version: "1.0.0",
    published: "2026-10-28T10:00:00Z",
    publishedBy: "ci",
    yanked: false,
    native: { name: NAME },
    files: [{ name: "a.zip", size: bytes.length, sha256: SHA256, digests: { md5: "existing" } }],
  };
  await writeManifest(env, m);
  await env.R2_BUCKET.put(fileKey("composer", NAME, "1.0.0", "a.zip"), bytes);
  return m;
}

afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await env.R2_BUCKET.delete([KEY, fileKey("composer", NAME, "1.0.0", "a.zip")]);
});

describe("backfillDigests", () => {
  it("verifies actual bytes, preserves metadata and does not rewrite artifacts or indexes", async () => {
    const original = await seed();
    original.yanked = true;
    await writeManifest(env, original, { overwrite: true });
    const put = vi.spyOn(env.R2_BUCKET, "put");
    expect(await run()).toMatchObject({ updated: true });
    expect(await read()).toEqual({
      ...original,
      files: [{ ...original.files[0], digests: { md5: "existing", sha1: SHA1 } }],
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0]).toBe(KEY);
    put.mockClear();
    const get = vi.spyOn(env.R2_BUCKET, "get");
    expect(await run()).toMatchObject({ updated: false });
    expect(put).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "size", "sha256"])(
    "rejects a %s artifact without changing the manifest",
    async (problem) => {
      const original = await seed();
      const key = fileKey("composer", NAME, "1.0.0", "a.zip");
      if (problem === "missing") await env.R2_BUCKET.delete(key);
      else
        await env.R2_BUCKET.put(key, problem === "size" ? "short" : new Uint8Array(bytes.length));
      await expect(run()).rejects.toMatchObject({
        code: problem === "missing" ? "not_found" : "artifact_mismatch",
      });
      expect(await read()).toEqual(original);
    },
  );

  it("answers not_found for a missing version", async () => {
    await expect(run()).rejects.toMatchObject({ code: "not_found" });
  });

  it("does not persist partial digests when a later file fails", async () => {
    const original = await seed();
    const m: Manifest = {
      ...original,
      eco: "maven",
      name: "com.acme:backfill",
      files: [
        { ...archive(original), digests: undefined },
        { ...archive(original), name: "b.jar", digests: undefined },
      ],
    };
    const key = manifestKey(m.eco, m.name, m.version);
    await env.R2_BUCKET.put(key, JSON.stringify(m));
    const before = await (await env.R2_BUCKET.get(key))?.text();
    await env.R2_BUCKET.put(fileKey(m.eco, m.name, m.version, "a.zip"), bytes);
    await expect(backfillDigests(env, m.eco, m.name, m.version)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await (await env.R2_BUCKET.get(key))?.text()).toBe(before);
  });

  it("retries a conditional write while preserving a concurrent yank", async () => {
    const m = await seed();
    const put = env.R2_BUCKET.put.bind(env.R2_BUCKET);
    let raced = false;
    vi.spyOn(env.R2_BUCKET, "put").mockImplementation(async (...args) => {
      if (args[0] === KEY && !raced) {
        raced = true;
        await put(KEY, JSON.stringify({ ...m, yanked: true }));
      }
      return put(...args);
    });
    expect(await run()).toMatchObject({ updated: true });
    expect(raced).toBe(true);
    expect((await read())?.yanked).toBe(true);
    expect((await read())?.files[0]?.digests?.sha1).toBe(SHA1);
  });

  it("streams a multi-chunk artifact", async () => {
    const m = await seed();
    const big = new Uint8Array(3 * 1024 * 1024 + 17).map((_, i) => i % 251);
    const hex = (b: ArrayBuffer) =>
      [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
    archive(m).sha256 = hex(await crypto.subtle.digest("SHA-256", big));
    archive(m).size = big.length;
    await writeManifest(env, m, { overwrite: true });
    await env.R2_BUCKET.put(fileKey("composer", NAME, "1.0.0", "a.zip"), big);
    await run();
    expect((await read())?.files[0]?.digests?.sha1).toBe(
      hex(await crypto.subtle.digest("SHA-1", big)),
    );
  });

  it.each(["yank", "delete", "change", "other-backfill"])(
    "handles a concurrent %s",
    async (action) => {
      const m = await seed();
      const get = env.R2_BUCKET.get.bind(env.R2_BUCKET);
      let manifestReads = 0;
      vi.spyOn(env.R2_BUCKET, "get").mockImplementation(async (...args) => {
        if (args[0] === KEY && ++manifestReads === 2) {
          if (action === "delete") await env.R2_BUCKET.delete(KEY);
          else {
            if (action === "yank") m.yanked = true;
            if (action === "change") archive(m).sha256 = "a".repeat(64);
            if (action === "other-backfill") archive(m).digests = { sha1: SHA1, md5: "existing" };
            await env.R2_BUCKET.put(KEY, JSON.stringify(m));
          }
        }
        return get(...args);
      });
      if (action === "delete" || action === "change") {
        await expect(run()).rejects.toMatchObject({
          code: action === "delete" ? "not_found" : "version_changed",
        });
        expect(await read()).toEqual(action === "delete" ? null : m);
      } else {
        expect(await run()).toMatchObject({ updated: action !== "other-backfill" });
        expect((await read())?.yanked).toBe(action === "yank");
        expect((await read())?.files[0]?.digests?.sha1).toBe(SHA1);
      }
    },
  );
});
