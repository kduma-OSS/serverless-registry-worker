import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { expand } from "../../src/adapters/composer/index";
import { readManifest, stagingKey, manifestKey } from "../../src/core/storage";
import {
  ORIGIN,
  call,
  credential,
  publishComposer,
  sha256Hex,
  type ErrorBody,
  type InitResult,
} from "./helpers";

interface P2 {
  packages: Record<string, Record<string, unknown>[]>;
  minified?: string;
}

let admin: string;
let ci: string;
let reader: string;

async function p2(name: string, token = reader): Promise<string[]> {
  const res = await call("GET", `/composer/p2/${name}.json`, { token });
  expect(res.status).toBe(200);
  const body = await res.json<P2>();
  return expand(body.packages[name] ?? []).map((v) => String(v.version));
}

beforeAll(async () => {
  admin = await credential("e2e-admin", "admin");
  ci = await credential("ci-acme", "publish", [
    { eco: "composer", package: "acme/*", versions: "*" },
  ]);
  reader = await credential("shop-frontend", "read", [
    { eco: "composer", package: "acme/sdk", versions: "^1.0" },
  ]);
  for (const [name, version] of [
    ["acme/sdk", "1.0.0"],
    ["acme/sdk", "1.1.0"],
    ["acme/sdk", "2.0.0"],
    ["acme/internal", "1.0.0"],
  ] as const) {
    const res = await publishComposer(ci, name, version);
    expect(res.status).toBe(201);
  }
});

describe("composer publishing through the API", () => {
  it("computes shasum from uploaded bytes, ignoring client-supplied digests", async () => {
    const name = "acme/checksummed";
    const bytes = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");
    const init = await call("POST", "/api/v1/publish/init", {
      token: ci,
      body: {
        eco: "composer",
        name,
        version: "1.0.0",
        files: [
          {
            name: "a.zip",
            size: bytes.length,
            sha256: await sha256Hex(bytes),
            digests: { sha1: "forged" },
          },
        ],
        manifest: { name, dist: { shasum: "forged" } },
      },
    });
    const { uploadId } = await init.json<InitResult>();
    await env.R2_BUCKET.put(stagingKey(uploadId, "a.zip"), bytes);
    expect(
      (await call("POST", "/api/v1/publish/commit", { token: ci, body: { uploadId } })).status,
    ).toBe(201);
    const expected = "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12";
    expect((await readManifest(env, "composer", name, "1.0.0"))?.files[0]?.digests?.sha1).toBe(
      expected,
    );
    const p2 = await (await call("GET", `/composer/p2/${name}.json`, { token: admin })).json<P2>();
    expect(expand(p2.packages[name] ?? [])[0]?.dist).toMatchObject({ shasum: expected });
  });

  it("backfills old yanked versions for admins and exposes the sum after reindex", async () => {
    const name = "acme/legacy";
    expect((await publishComposer(ci, name, "1.0.0", "legacy bytes")).status).toBe(201);
    const m = await readManifest(env, "composer", name, "1.0.0");
    if (m === null) throw new Error("Missing test manifest");
    delete m.files[0]?.digests;
    m.yanked = true;
    await env.R2_BUCKET.put(manifestKey("composer", name, "1.0.0"), JSON.stringify(m));
    const base = `/api/v1/packages/composer/${encodeURIComponent(name)}`;
    const path = `${base}/1.0.0/backfill-digests`;
    expect((await call("POST", path)).status).toBe(401);
    for (const token of [ci, reader])
      expect((await call("POST", path, { token })).status).toBe(403);
    const first = await call("POST", path, { token: admin });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ eco: "composer", name, version: "1.0.0", updated: true });
    expect(await (await call("POST", path, { token: admin })).json()).toMatchObject({
      updated: false,
    });
    const enriched = await readManifest(env, "composer", name, "1.0.0");
    expect(enriched?.yanked).toBe(true);
    expect(enriched?.files[0]?.digests?.sha1).toMatch(/^[0-9a-f]{40}$/);
    // Unyank only in the fixture so the rebuilt p2 metadata can expose this archive.
    await env.R2_BUCKET.put(
      manifestKey("composer", name, "1.0.0"),
      JSON.stringify({ ...enriched, yanked: false }),
    );
    expect((await call("POST", `${base}/reindex`, { token: admin })).status).toBe(200);
    const body = await (
      await call("GET", `/composer/p2/${name}.json`, { token: admin })
    ).json<P2>();
    expect(expand(body.packages[name] ?? [])[0]?.dist).toMatchObject({
      shasum: enriched?.files[0]?.digests?.sha1,
    });
  });

  it("answers commit with the native download URLs", async () => {
    const res = await publishComposer(ci, "acme/fresh", "0.1.0-beta.1");
    expect(res.status).toBe(201);
    expect(res.headers.get("x-min-client-version")).toBe("0.1.0");
    const url = `${ORIGIN}/composer/dist/acme/fresh/0.1.0-beta.1.zip`;
    expect(await res.json()).toEqual({
      eco: "composer",
      name: "acme/fresh",
      version: "0.1.0-beta.1",
      url,
      files: [{ name: "acme-fresh-0.1.0-beta.1.zip", url }],
    });
  });

  it("returns presigned uploads from init", async () => {
    const bytes = new TextEncoder().encode("zip");
    const res = await call("POST", "/api/v1/publish/init", {
      token: ci,
      body: {
        eco: "composer",
        name: "acme/presign",
        version: "1.0.0",
        files: [{ name: "a.zip", size: bytes.length, sha256: await sha256Hex(bytes) }],
        manifest: { name: "acme/presign" },
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json<InitResult>();
    expect(body.uploads).toHaveLength(1);
    expect(body.uploads[0]?.putUrl).toContain(`/_staging/${body.uploadId}/a.zip?`);
    expect(body.uploads[0]?.putUrl).toContain("X-Amz-Signature=");
    expect(body.uploads[0]?.headers["content-length"]).toBe("3");
  });

  it("is idempotent on commit", async () => {
    const bytes = new TextEncoder().encode("idempotent");
    const sha = await sha256Hex(bytes);
    const init = await call("POST", "/api/v1/publish/init", {
      token: ci,
      body: {
        eco: "composer",
        name: "acme/retry",
        version: "1.0.0",
        files: [{ name: "a.zip", size: bytes.length, sha256: sha }],
        manifest: { name: "acme/retry" },
      },
    });
    const { uploadId } = await init.json<InitResult>();
    await env.R2_BUCKET.put(stagingKey(uploadId, "a.zip"), bytes, { sha256: sha });
    const first = await call("POST", "/api/v1/publish/commit", { token: ci, body: { uploadId } });
    const second = await call("POST", "/api/v1/publish/commit", { token: ci, body: { uploadId } });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
  });

  it("answers 409 version_exists for a published version", async () => {
    const res = await publishComposer(ci, "acme/sdk", "1.0.0", "different bytes");
    expect(res.status).toBe(409);
    expect(await res.json<ErrorBody>()).toMatchObject({ error: "version_exists" });
  });

  it("rejects append for composer", async () => {
    const res = await call("POST", "/api/v1/publish/init", {
      token: ci,
      body: {
        eco: "composer",
        name: "acme/sdk",
        version: "1.0.0",
        files: [{ name: "extra.zip", size: 1, sha256: "a".repeat(64) }],
        manifest: { name: "acme/sdk" },
        append: true,
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json<ErrorBody>()).error).toBe("invalid_request");
  });

  it("answers 403 for a package outside the publish grant", async () => {
    const res = await publishComposer(ci, "other/sdk", "1.0.0");
    expect(res.status).toBe(403);
  });
});

describe("composer native reads", () => {
  it("lists only the granted packages in packages.json", async () => {
    const res = await call("GET", "/composer/packages.json", { token: reader });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({
      "metadata-url": "/composer/p2/%package%.json",
      "available-packages": ["acme/sdk"],
      packages: [],
    });
  });

  it("lists every package for admin", async () => {
    const res = await call("GET", "/composer/packages.json", { token: admin });
    const body = await res.json<{ "available-packages": string[] }>();
    expect(body["available-packages"]).toEqual(
      expect.arrayContaining(["acme/internal", "acme/sdk"]),
    );
  });

  it("filters p2 metadata by the version constraint of the grant", async () => {
    const res = await call("GET", "/composer/p2/acme/sdk.json", { token: reader });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json<P2>();
    expect(body.minified).toBe("composer/2.0");
    const versions = expand(body.packages["acme/sdk"] ?? []);
    expect(versions.map((v) => v.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(versions[0]).toMatchObject({
      name: "acme/sdk",
      version_normalized: "1.1.0.0",
      require: { php: "^8.1" },
      dist: { type: "zip", url: `${ORIGIN}/composer/dist/acme/sdk/1.1.0.zip` },
    });
    expect(await p2("acme/sdk", admin)).toEqual(["2.0.0", "1.1.0", "1.0.0"]);
  });

  it("serves the empty dev metadata", async () => {
    const res = await call("GET", "/composer/p2/acme/sdk~dev.json", { token: reader });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ packages: {}, minified: "composer/2.0" });
  });

  it("answers 404 for packages outside the grants and unknown packages", async () => {
    expect((await call("GET", "/composer/p2/acme/internal.json", { token: reader })).status).toBe(
      404,
    );
    expect((await call("GET", "/composer/p2/acme/nothing.json", { token: admin })).status).toBe(
      404,
    );
    expect((await call("GET", "/composer/whatever", { token: reader })).status).toBe(404);
  });

  it("redirects dist downloads to a presigned URL", async () => {
    const res = await call("GET", "/composer/dist/acme/sdk/1.0.0.zip", { token: reader });
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("https://test-account.r2.cloudflarestorage.com");
    expect(location.pathname).toBe(
      "/serverless-registry/composer/pkg/acme__sdk/1.0.0/acme-sdk-1.0.0.zip",
    );
    expect(location.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(location.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("answers 404 for a dist outside the grant", async () => {
    const res = await call("GET", "/composer/dist/acme/sdk/2.0.0.zip", { token: reader });
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  it("accepts the http-basic form Composer sends", async () => {
    const res = await call("GET", "/composer/p2/acme/sdk.json", {
      headers: { authorization: `Basic ${btoa(reader)}` },
    });
    expect(res.status).toBe(200);
  });

  it("answers 401 without credentials and 403 for publish credentials", async () => {
    const anonymous = await call("GET", "/composer/packages.json");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe('Bearer realm="serverless-registry"');
    expect(anonymous.headers.get("cache-control")).toBe("private, no-store");
    expect(
      (await call("GET", "/composer/packages.json", { token: "shop-frontend:x" })).status,
    ).toBe(401);
    expect((await call("GET", "/composer/p2/acme/sdk.json", { token: ci })).status).toBe(403);
  });

  it("answers 404 for ecosystems without native routes yet", async () => {
    const res = await call("GET", "/npm/@acme%2fsdk", { token: reader });
    expect(res.status).toBe(404);
  });
});

describe("composer administration", () => {
  it("hides a yanked version from p2 but keeps its dist downloadable", async () => {
    await publishComposer(ci, "acme/yanked", "1.0.0");
    await publishComposer(ci, "acme/yanked", "1.1.0");
    const res = await call("POST", "/api/v1/packages/composer/acme%2Fyanked/1.1.0/yank", {
      token: admin,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      eco: "composer",
      name: "acme/yanked",
      version: "1.1.0",
      yanked: true,
    });
    expect(await p2("acme/yanked", admin)).toEqual(["1.0.0"]);
    const dist = await call("GET", "/composer/dist/acme/yanked/1.1.0.zip", { token: admin });
    expect(dist.status).toBe(302);

    const listed = await call("GET", "/api/v1/packages/composer/acme%2Fyanked", { token: admin });
    const body = await listed.json<{ versions: { version: string; yanked: boolean }[] }>();
    expect(body.versions.map((v) => [v.version, v.yanked])).toEqual([
      ["1.1.0", true],
      ["1.0.0", false],
    ]);
  });

  it("frees a deleted version for publishing again", async () => {
    await publishComposer(ci, "acme/deleted", "1.0.0", "first");
    const res = await call("DELETE", "/api/v1/packages/composer/acme%2Fdeleted/1.0.0", {
      token: admin,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      eco: "composer",
      name: "acme/deleted",
      version: "1.0.0",
      deleted: true,
    });
    expect((await call("GET", "/composer/p2/acme/deleted.json", { token: admin })).status).toBe(
      404,
    );
    expect((await publishComposer(ci, "acme/deleted", "1.0.0", "second")).status).toBe(201);
    expect(await p2("acme/deleted", admin)).toEqual(["1.0.0"]);
  });

  it("deletes and reindexes whole packages", async () => {
    await publishComposer(ci, "acme/whole", "1.0.0");
    await env.R2_BUCKET.delete("composer/index/p2/acme/whole.json");
    const reindexed = await call("POST", "/api/v1/packages/composer/acme%2Fwhole/reindex", {
      token: admin,
    });
    expect(await reindexed.json()).toEqual({ eco: "composer", name: "acme/whole", manifests: 1 });
    expect(await p2("acme/whole", admin)).toEqual(["1.0.0"]);

    const deleted = await call("DELETE", "/api/v1/packages/composer/acme%2Fwhole", {
      token: admin,
    });
    expect(await deleted.json()).toEqual({
      eco: "composer",
      name: "acme/whole",
      deletedVersions: ["1.0.0"],
    });
    const listing = await call("GET", "/composer/packages.json", { token: admin });
    const body = await listing.json<{ "available-packages": string[] }>();
    expect(body["available-packages"]).not.toContain("acme/whole");
  });

  it("lists packages through the API with grant filtering", async () => {
    const res = await call("GET", "/api/v1/packages", { token: reader });
    const body = await res.json<{
      packages: { name: string; versions: { version: string }[] }[];
    }>();
    expect(body.packages.map((p) => [p.name, p.versions.map((v) => v.version)])).toEqual([
      ["acme/sdk", ["1.1.0", "1.0.0"]],
    ]);
    expect(
      (await call("GET", "/api/v1/packages/composer/acme%2Finternal", { token: reader })).status,
    ).toBe(404);
  });
});
