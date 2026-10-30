import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256HexToBase64 } from "../../src/core/presign";
import { stagingKey } from "../../src/core/storage";
import { ORIGIN, call, credential, sha256Hex, type ErrorBody, type InitResult } from "./helpers";

interface Packument {
  _id: string;
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, VersionEntry>;
  time: Record<string, string>;
}

interface VersionEntry {
  name: string;
  version: string;
  _id: string;
  deprecated?: string;
  dependencies?: Record<string, string>;
  dist: { tarball: string; integrity: string };
}

let admin: string;
let ci: string;
let reader: string;

/**
 * Publishes an npm version the way the CLI does: init, the presigned PUT (simulated by writing
 * the declared bytes to the staging key, as R2 would), then commit. `manifest` is merged into
 * the generated `package.json`.
 */
async function publishNpm(
  token: string,
  name: string,
  version: string,
  options: { tag?: string; manifest?: Record<string, unknown> } = {},
): Promise<Response> {
  const bytes = new TextEncoder().encode(`${name}@${version}`);
  const sha = await sha256Hex(bytes);
  const file = `${name.slice(name.indexOf("/") + 1)}-${version}.tgz`;
  const init = await call("POST", "/api/v1/publish/init", {
    token,
    body: {
      eco: "npm",
      name,
      version,
      files: [{ name: file, size: bytes.length, sha256: sha }],
      manifest: { name, version, main: "index.js", ...options.manifest },
      ...(options.tag === undefined ? {} : { tag: options.tag }),
    },
  });
  if (init.status !== 200) return init;
  const { uploadId } = await init.json<InitResult>();
  await env.R2_BUCKET.put(stagingKey(uploadId, file), bytes, { sha256: sha });
  return call("POST", "/api/v1/publish/commit", { token, body: { uploadId } });
}

async function packument(name: string, token: string): Promise<Packument> {
  const res = await call("GET", `/npm/${name.replace("/", "%2f")}`, { token });
  expect(res.status).toBe(200);
  return res.json<Packument>();
}

async function tarball(name: string, version: string, token: string): Promise<number> {
  const file = `${name.slice(name.indexOf("/") + 1)}-${version}.tgz`;
  return (await call("GET", `/npm/${name}/-/${file}`, { token })).status;
}

beforeAll(async () => {
  admin = await credential("npm-admin", "admin");
  ci = await credential("npm-ci", "publish", [{ eco: "npm", package: "@acme/*", versions: "*" }]);
  reader = await credential("npm-reader", "read", [
    { eco: "npm", package: "@acme/sdk", versions: "^2.0" },
  ]);
  const versions: [string, string, Record<string, unknown>][] = [
    ["@acme/sdk", "1.0.0", {}],
    ["@acme/sdk", "2.0.0", { dependencies: { "@acme/http": "^1.1.0", lodash: "^4.17.21" } }],
    ["@acme/sdk", "2.1.0-beta.1", {}],
    ["@acme/http", "1.0.0", {}],
    ["@acme/http", "1.1.0", {}],
    ["@acme/http", "2.0.0", {}],
    ["@acme/internal", "1.0.0", {}],
  ];
  for (const [name, version, manifest] of versions) {
    const res = await publishNpm(ci, name, version, { manifest });
    expect(res.status).toBe(201);
  }
});

describe("npm publishing through the API", () => {
  it("answers commit with the registry tarball URL", async () => {
    const res = await publishNpm(ci, "@acme/fresh", "0.1.0");
    expect(res.status).toBe(201);
    const url = `${ORIGIN}/npm/@acme/fresh/-/fresh-0.1.0.tgz`;
    expect(await res.json()).toEqual({
      eco: "npm",
      name: "@acme/fresh",
      version: "0.1.0",
      url,
      files: [{ name: "fresh-0.1.0.tgz", url }],
    });
  });

  it("rejects unscoped names, mismatching manifests and invalid tags", async () => {
    const status = async (name: string, version: string, tag?: string, manifest = {}) => {
      const res = await publishNpm(ci, name, version, { manifest, ...(tag ? { tag } : {}) });
      expect((await res.json<ErrorBody>()).error).toBe(
        res.status === 403 ? "forbidden" : "invalid_request",
      );
      return res.status;
    };
    expect(await status("@acme/x", "1.0.0", "v1")).toBe(400);
    expect(await status("@acme/x", "1.0.0", undefined, { version: "1.0.1" })).toBe(400);
    expect(await status("@acme/x", "1.0.0+build")).toBe(400);
    expect(await status("@other/x", "1.0.0")).toBe(403);
  });

  it("answers 409 version_exists for a published version", async () => {
    const res = await publishNpm(ci, "@acme/sdk", "1.0.0");
    expect(res.status).toBe(409);
  });
});

describe("npm native reads", () => {
  it("serves the whole packument with dist-tags to admin", async () => {
    const res = await call("GET", "/npm/@acme%2fsdk", { token: admin });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = await res.json<Packument>();
    expect(body._id).toBe("@acme/sdk");
    expect(body.name).toBe("@acme/sdk");
    expect(body["dist-tags"]).toEqual({ latest: "2.0.0", next: "2.1.0-beta.1" });
    expect(Object.keys(body.versions)).toEqual(["1.0.0", "2.0.0", "2.1.0-beta.1"]);
    const sha = await sha256Hex(new TextEncoder().encode("@acme/sdk@2.0.0"));
    const integrity = `sha256-${sha256HexToBase64(sha)}`;
    expect(body.versions["2.0.0"]).toEqual({
      name: "@acme/sdk",
      version: "2.0.0",
      main: "index.js",
      dependencies: { "@acme/http": "^1.1.0", lodash: "^4.17.21" },
      _id: "@acme/sdk@2.0.0",
      dist: { tarball: `${ORIGIN}/npm/@acme/sdk/-/sdk-2.0.0.tgz`, integrity },
    });
    expect(Object.keys(body.time)).toEqual([
      "created",
      "modified",
      "1.0.0",
      "2.0.0",
      "2.1.0-beta.1",
    ]);
    expect(body).not.toHaveProperty("_requestedTags");
  });

  it("accepts every encoding of the scoped name", async () => {
    for (const path of ["/npm/@acme%2Fsdk", "/npm/%40acme%2Fsdk", "/npm/@acme/sdk"]) {
      const res = await call("GET", path, { token: admin });
      expect(res.status).toBe(200);
      expect((await res.json<Packument>()).name).toBe("@acme/sdk");
    }
  });

  it("filters the packument by the version constraint of the grant", async () => {
    const body = await packument("@acme/sdk", reader);
    expect(Object.keys(body.versions)).toEqual(["2.0.0"]);
    expect(body["dist-tags"]).toEqual({ latest: "2.0.0" });
    expect(Object.keys(body.time)).toEqual(["created", "modified", "2.0.0"]);
  });

  it("serves single versions and dist-tags within the grant", async () => {
    const one = await call("GET", "/npm/@acme%2fsdk/2.0.0", { token: reader });
    expect(one.status).toBe(200);
    expect(one.headers.get("cache-control")).toBe("private, no-store");
    expect(await one.json()).toMatchObject({ _id: "@acme/sdk@2.0.0", version: "2.0.0" });
    const latest = await call("GET", "/npm/@acme/sdk/latest", { token: reader });
    expect(await latest.json()).toMatchObject({ version: "2.0.0" });
    const next = await call("GET", "/npm/@acme/sdk/next", { token: admin });
    expect(await next.json()).toMatchObject({ version: "2.1.0-beta.1" });
    expect((await call("GET", "/npm/@acme/sdk/1.0.0", { token: reader })).status).toBe(404);
    expect((await call("GET", "/npm/@acme/sdk/next", { token: reader })).status).toBe(404);
    expect((await call("GET", "/npm/@acme/sdk/9.9.9", { token: admin })).status).toBe(404);
  });

  it("redirects tarball downloads to a presigned URL", async () => {
    const res = await call("GET", "/npm/@acme/sdk/-/sdk-2.0.0.tgz", { token: reader });
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("https://test-account.r2.cloudflarestorage.com");
    expect(decodeURIComponent(location.pathname)).toBe(
      "/serverless-registry/npm/pkg/@acme__sdk/2.0.0/sdk-2.0.0.tgz",
    );
    expect(location.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    const encoded = await call("GET", "/npm/@acme%2fsdk/-/sdk-2.0.0.tgz", { token: reader });
    expect(encoded.status).toBe(302);
  });

  it("answers 404 for tarballs and packages outside the grants", async () => {
    expect(await tarball("@acme/sdk", "1.0.0", reader)).toBe(404);
    expect(await tarball("@acme/sdk", "2.1.0-beta.1", reader)).toBe(404);
    expect((await call("GET", "/npm/@acme%2finternal", { token: reader })).status).toBe(404);
    expect((await call("GET", "/npm/@acme%2fnothing", { token: admin })).status).toBe(404);
    expect((await call("GET", "/npm/sdk", { token: admin })).status).toBe(404);
  });

  it("answers ping and whoami for every kind of credential", async () => {
    for (const token of [reader, ci, admin]) {
      const ping = await call("GET", "/npm/-/ping", { token });
      expect(ping.status).toBe(200);
      expect(ping.headers.get("cache-control")).toBe("private, no-store");
      expect(await ping.json()).toEqual({});
    }
    const whoami = await call("GET", "/npm/-/whoami", { token: reader });
    expect(await whoami.json()).toEqual({ username: "npm-reader" });
    const publisher = await call("GET", "/npm/-/whoami", { token: ci });
    expect(await publisher.json()).toEqual({ username: "npm-ci" });
  });

  it("answers 401 without credentials and 403 for publish credentials", async () => {
    const anonymous = await call("GET", "/npm/-/whoami");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe('Bearer realm="serverless-registry"');
    expect((await call("GET", "/npm/-/ping")).status).toBe(401);
    expect((await call("GET", "/npm/@acme%2fsdk", { token: ci })).status).toBe(403);
  });

  it("accepts the _authToken and _auth forms npm sends", async () => {
    const bearer = await call("GET", "/npm/@acme%2fsdk", {
      headers: { authorization: `Bearer ${reader}` },
    });
    expect(bearer.status).toBe(200);
    const basic = await call("GET", "/npm/@acme%2fsdk", {
      headers: { authorization: `Basic ${btoa(reader)}` },
    });
    expect(basic.status).toBe(200);
  });
});

describe("npm dist-tags", () => {
  it("points a requested tag at its version and keeps latest on the stable line", async () => {
    expect((await publishNpm(ci, "@acme/tags", "1.0.0")).status).toBe(201);
    expect((await publishNpm(ci, "@acme/tags", "2.0.0", { tag: "canary" })).status).toBe(201);
    expect((await publishNpm(ci, "@acme/tags", "1.1.0", { tag: "latest" })).status).toBe(201);
    const body = await packument("@acme/tags", admin);
    expect(body["dist-tags"]).toEqual({ canary: "2.0.0", latest: "1.1.0" });
  });

  it("moves latest when its version is yanked and keeps the tarball downloadable", async () => {
    await publishNpm(ci, "@acme/yanked", "1.0.0");
    await publishNpm(ci, "@acme/yanked", "1.1.0");
    await publishNpm(ci, "@acme/yanked", "1.2.0-rc.1", { tag: "rc" });
    expect((await packument("@acme/yanked", admin))["dist-tags"]).toEqual({
      latest: "1.1.0",
      next: "1.2.0-rc.1",
      rc: "1.2.0-rc.1",
    });

    for (const version of ["1.1.0", "1.2.0-rc.1"]) {
      const res = await call("POST", `/api/v1/packages/npm/%40acme%2Fyanked/${version}/yank`, {
        token: admin,
      });
      expect(res.status).toBe(200);
    }
    const body = await packument("@acme/yanked", admin);
    expect(body["dist-tags"]).toEqual({ latest: "1.0.0" });
    expect(Object.keys(body.versions)).toEqual(["1.0.0"]);
    expect(Object.keys(body.time)).toEqual(["created", "modified", "1.0.0"]);
    expect(await tarball("@acme/yanked", "1.1.0", admin)).toBe(302);
    expect((await call("GET", "/npm/@acme/yanked/1.1.0", { token: admin })).status).toBe(404);
  });

  it("deprecates a version without hiding it, and clears the deprecation", async () => {
    await publishNpm(ci, "@acme/dep", "1.0.0");
    await publishNpm(ci, "@acme/dep", "1.1.0");
    const url = "/api/v1/packages/npm/%40acme%2Fdep/1.0.0/deprecate";
    expect((await call("POST", url, { token: ci, body: { message: "x" } })).status).toBe(403);
    expect((await call("POST", url, { token: admin, body: {} })).status).toBe(400);
    expect((await call("POST", url, { token: admin, body: { message: "  " } })).status).toBe(400);
    const set = await call("POST", url, { token: admin, body: { message: "Use 1.1.0" } });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({
      version: "1.0.0",
      yanked: false,
      deprecated: { message: "Use 1.1.0", by: expect.any(String), at: expect.any(String) },
    });
    let body = await packument("@acme/dep", admin);
    expect(body.versions["1.0.0"]?.deprecated).toBe("Use 1.1.0");
    expect(body.versions["1.1.0"]?.deprecated).toBeUndefined();
    expect(await tarball("@acme/dep", "1.0.0", admin)).toBe(302);

    expect((await call("DELETE", url, { token: admin })).status).toBe(200);
    expect((await call("DELETE", url, { token: admin })).status).toBe(200);
    body = await packument("@acme/dep", admin);
    expect(body.versions["1.0.0"]?.deprecated).toBeUndefined();
    const missing = "/api/v1/packages/npm/%40acme%2Fdep/9.9.9/deprecate";
    expect((await call("DELETE", missing, { token: admin })).status).toBe(404);
  });

  it("rebuilds the same packument on reindex", async () => {
    const before = await packument("@acme/tags", admin);
    await env.R2_BUCKET.delete("npm/index/@acme__tags.json");
    const res = await call("POST", "/api/v1/packages/npm/%40acme%2Ftags/reindex", {
      token: admin,
    });
    expect(res.status).toBe(200);
    expect(await packument("@acme/tags", admin)).toEqual(before);
  });
});

describe("npm transitive access", () => {
  it("opens the dependency versions the constraint admits", async () => {
    const body = await packument("@acme/http", reader);
    expect(Object.keys(body.versions)).toEqual(["1.1.0"]);
    expect(body["dist-tags"]).toEqual({ latest: "1.1.0" });
    expect(await tarball("@acme/http", "1.1.0", reader)).toBe(302);
    expect(await tarball("@acme/http", "1.0.0", reader)).toBe(404);
    expect(await tarball("@acme/http", "2.0.0", reader)).toBe(404);
  });

  it("lists the dependency under the grant in the package listing", async () => {
    const res = await call("GET", "/api/v1/packages", { token: reader });
    const body = await res.json<{
      packages: {
        name: string;
        versions: { version: string }[];
        dependencies?: { name: string; constraints: string[]; versions: string[] }[];
      }[];
    }>();
    expect(
      body.packages.map((p) => [p.name, p.versions.map((v) => v.version), p.dependencies]),
    ).toEqual([
      [
        "@acme/sdk",
        ["2.0.0"],
        [{ name: "@acme/http", constraints: ["^1.1.0"], versions: ["1.1.0"] }],
      ],
    ]);
  });
});
