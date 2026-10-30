import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { stagingKey } from "../../src/core/storage";
import { ORIGIN, call, credential, sha256Hex, type ErrorBody, type InitResult } from "./helpers";

type Json = Record<string, unknown>;

let admin: string;
let ci: string;
let reader: string;

const CRATES_IO = "https://github.com/rust-lang/crates.io-index";

function dep(name: string, req: string, registry: string | null = null): Json {
  return {
    name,
    req,
    features: [],
    optional: false,
    default_features: true,
    target: null,
    kind: "normal",
    registry,
    package: null,
  };
}

/** The bytes published for a version, so tests can compute the expected `cksum`. */
function crateBytes(name: string, version: string): Uint8Array {
  return new TextEncoder().encode(`${name}@${version}`);
}

/**
 * Publishes a crate version the way the CLI does: init with the index line, the presigned PUT
 * (simulated by writing the declared bytes to the staging key, as R2 would), then commit.
 * `line` is merged into the generated index line.
 */
async function publishCargo(
  token: string,
  name: string,
  version: string,
  line: Json = {},
): Promise<Response> {
  const bytes = crateBytes(name, version);
  const sha = await sha256Hex(bytes);
  const file = `${name}-${version}.crate`;
  const init = await call("POST", "/api/v1/publish/init", {
    token,
    body: {
      eco: "cargo",
      name,
      version,
      files: [{ name: file, size: bytes.length, sha256: sha }],
      manifest: { name, vers: version, deps: [], features: { default: [] }, ...line },
    },
  });
  if (init.status !== 200) return init;
  const { uploadId } = await init.json<InitResult>();
  await env.R2_BUCKET.put(stagingKey(uploadId, file), bytes, { sha256: sha });
  return call("POST", "/api/v1/publish/commit", { token, body: { uploadId } });
}

async function indexLines(path: string, token: string): Promise<Json[]> {
  const res = await call("GET", `/cargo/index/${path}`, { token });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  const text = await res.text();
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Json);
}

async function versions(path: string, token: string): Promise<[unknown, unknown][]> {
  return (await indexLines(path, token)).map((l) => [l.vers, l.yanked]);
}

async function download(name: string, version: string, token: string): Promise<number> {
  return (await call("GET", `/cargo/dl/${name}/${version}`, { token })).status;
}

beforeAll(async () => {
  admin = await credential("cargo-admin", "admin");
  ci = await credential("cargo-ci", "publish", [{ eco: "cargo", package: "*", versions: "*" }]);
  reader = await credential("cargo-reader", "read", [
    { eco: "cargo", package: "acme-core", versions: ">=1.4, <2" },
  ]);
  const published: [string, string, Json][] = [
    ["acme-core", "1.0.0", {}],
    ["acme-core", "1.4.0", {}],
    [
      "acme-core",
      "1.5.0",
      {
        deps: [dep("acme-util", "^0.2"), dep("serde", "^1.0", CRATES_IO)],
        features2: { json: ["dep:serde_json"] },
        rust_version: "1.75",
      },
    ],
    ["acme-core", "2.0.0", {}],
    ["acme-util", "0.1.0", {}],
    ["acme-util", "0.2.0", {}],
    ["acme-util", "0.2.5", {}],
    ["acme-util", "1.0.0", {}],
    ["a", "1.0.0", {}],
    ["ab", "1.0.0", {}],
    ["abc", "1.0.0", {}],
  ];
  for (const [name, version, line] of published) {
    const res = await publishCargo(ci, name, version, line);
    expect(res.status).toBe(201);
  }
});

describe("cargo publishing through the API", () => {
  it("answers commit with the dl URL", async () => {
    const res = await publishCargo(ci, "fresh", "0.1.0");
    expect(res.status).toBe(201);
    const url = `${ORIGIN}/cargo/dl/fresh/0.1.0`;
    expect(await res.json()).toEqual({
      eco: "cargo",
      name: "fresh",
      version: "0.1.0",
      url,
      files: [{ name: "fresh-0.1.0.crate", url }],
    });
  });

  it("rejects malformed index lines and upper-case names", async () => {
    const bad = await publishCargo(ci, "broken", "1.0.0", { deps: [{ name: "x" }] });
    expect(bad.status).toBe(400);
    expect((await bad.json<ErrorBody>()).error).toBe("invalid_request");
    expect((await publishCargo(ci, "Upper", "1.0.0")).status).toBe(400);
    expect((await publishCargo(ci, "broken", "1.0.0", { vers: "1.0.1" })).status).toBe(400);
  });

  it("answers 409 version_exists for a published version", async () => {
    expect((await publishCargo(ci, "acme-core", "1.0.0")).status).toBe(409);
  });
});

describe("cargo native reads", () => {
  it("serves config.json with the public URL to authenticated callers only", async () => {
    const res = await call("GET", "/cargo/index/config.json", { token: reader });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({
      dl: `${ORIGIN}/cargo/dl/{crate}/{version}`,
      api: `${ORIGIN}/cargo`,
      "auth-required": true,
    });
    const anonymous = await call("GET", "/cargo/index/config.json");
    expect(anonymous.status).toBe(401);
  });

  it("accepts the raw token cargo sends", async () => {
    const res = await call("GET", "/cargo/index/config.json", {
      headers: { authorization: reader },
    });
    expect(res.status).toBe(200);
  });

  it("serves index files at the paths for 1, 2, 3 and 4+ character names", async () => {
    expect(await versions("1/a", admin)).toEqual([["1.0.0", false]]);
    expect(await versions("2/ab", admin)).toEqual([["1.0.0", false]]);
    expect(await versions("3/a/abc", admin)).toEqual([["1.0.0", false]]);
    expect(await versions("ac/me/acme-core", admin)).toEqual([
      ["1.0.0", false],
      ["1.4.0", false],
      ["1.5.0", false],
      ["2.0.0", false],
    ]);
    expect((await call("GET", "/cargo/index/3/b/abc", { token: admin })).status).toBe(404);
  });

  it("serves complete index lines with the computed fields", async () => {
    const lines = await indexLines("ac/me/acme-core", admin);
    const sha = await sha256Hex(crateBytes("acme-core", "1.5.0"));
    expect(lines[2]).toEqual({
      pubtime: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
      name: "acme-core",
      vers: "1.5.0",
      deps: [dep("acme-util", "^0.2"), dep("serde", "^1.0", CRATES_IO)],
      cksum: sha,
      features: { default: [] },
      features2: { json: ["dep:serde_json"] },
      yanked: false,
      rust_version: "1.75",
      v: 2,
    });
  });

  it("filters index files by the version requirement of the grant", async () => {
    expect(await versions("ac/me/acme-core", reader)).toEqual([
      ["1.4.0", false],
      ["1.5.0", false],
    ]);
  });

  it("answers 404 for crates outside the grants and unknown crates", async () => {
    expect((await call("GET", "/cargo/index/1/a", { token: reader })).status).toBe(404);
    expect((await call("GET", "/cargo/index/no/ne/none", { token: admin })).status).toBe(404);
    expect((await call("GET", "/cargo/whatever", { token: admin })).status).toBe(404);
  });

  it("redirects downloads to a presigned URL within the grant", async () => {
    const res = await call("GET", "/cargo/dl/acme-core/1.4.0", { token: reader });
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("https://test-account.r2.cloudflarestorage.com");
    expect(location.pathname).toBe(
      "/serverless-registry/cargo/pkg/acme-core/1.4.0/acme-core-1.4.0.crate",
    );
    expect(await download("acme-core", "1.0.0", reader)).toBe(404);
    expect(await download("acme-core", "2.0.0", reader)).toBe(404);
  });

  it("serves the minimal crate API", async () => {
    const res = await call("GET", "/cargo/api/v1/crates/acme-core", { token: reader });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({
      crate: {
        name: "acme-core",
        max_version: "1.5.0",
        versions: [
          { num: "1.5.0", yanked: false },
          { num: "1.4.0", yanked: false },
        ],
      },
    });
    expect((await call("GET", "/cargo/api/v1/crates/a", { token: reader })).status).toBe(404);
  });

  it("answers 403 for publish credentials", async () => {
    expect((await call("GET", "/cargo/index/config.json", { token: ci })).status).toBe(403);
    expect((await call("GET", "/cargo/index/1/a", { token: ci })).status).toBe(403);
  });
});

describe("cargo administration", () => {
  it("marks a yanked version but keeps its line and its download", async () => {
    await publishCargo(ci, "acme-yanked", "1.0.0");
    await publishCargo(ci, "acme-yanked", "1.1.0");
    const res = await call("POST", "/api/v1/packages/cargo/acme-yanked/1.1.0/yank", {
      token: admin,
    });
    expect(res.status).toBe(200);
    expect(await versions("ac/me/acme-yanked", admin)).toEqual([
      ["1.0.0", false],
      ["1.1.0", true],
    ]);
    expect(await download("acme-yanked", "1.1.0", admin)).toBe(302);
    const api = await call("GET", "/cargo/api/v1/crates/acme-yanked", { token: admin });
    expect(await api.json()).toMatchObject({ crate: { max_version: "1.0.0" } });
  });

  it("removes the index file when the last version is deleted", async () => {
    await publishCargo(ci, "gone", "1.0.0");
    expect(await versions("go/ne/gone", admin)).toEqual([["1.0.0", false]]);
    const res = await call("DELETE", "/api/v1/packages/cargo/gone/1.0.0", { token: admin });
    expect(res.status).toBe(200);
    expect((await call("GET", "/cargo/index/go/ne/gone", { token: admin })).status).toBe(404);
  });
});

describe("cargo transitive access", () => {
  it("opens the dependency versions the requirement admits", async () => {
    expect(await versions("ac/me/acme-util", reader)).toEqual([
      ["0.2.0", false],
      ["0.2.5", false],
    ]);
    expect(await download("acme-util", "0.2.5", reader)).toBe(302);
    expect(await download("acme-util", "0.1.0", reader)).toBe(404);
    expect(await download("acme-util", "1.0.0", reader)).toBe(404);
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
        "acme-core",
        ["1.5.0", "1.4.0"],
        [{ name: "acme-util", constraints: ["^0.2"], versions: ["0.2.5", "0.2.0"] }],
      ],
    ]);
  });
});
