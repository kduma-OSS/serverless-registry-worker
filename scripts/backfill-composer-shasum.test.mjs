import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { URL } from "node:url";
const { Response } = globalThis;
import { describe, it } from "node:test";
import { run } from "./backfill-composer-shasum.mjs";

const env = { REGISTRY_URL: "https://registry.example", REGISTRY_TOKEN: "secret-token" };

function fixture() {
  const pkg = {
    eco: "composer",
    name: "acme/sdk",
    versions: [
      { version: "1.0.0", yanked: true, files: [{ name: "a.zip" }] },
      {
        version: "2.0.0",
        yanked: false,
        files: [{ name: "b.zip", digests: { sha1: "existing" } }],
      },
    ],
  };
  const calls = [];
  const logs = [];
  let failReindex = false;
  let failVersion = false;
  const fetcher = async (url, options) => {
    assert.equal(options.headers.authorization, `Bearer ${env.REGISTRY_TOKEN}`);
    assert.equal(options.redirect, "error");
    calls.push([options.method, new URL(url).pathname]);
    if (options.method === "GET")
      return Response.json(
        url.endsWith("/packages")
          ? { packages: [pkg, { eco: "npm", name: "@acme/other", versions: [] }] }
          : pkg,
      );
    if (url.endsWith("/reindex")) {
      if (failReindex) throw new Error("secret-token https://signed.example/?signature=secret");
      return Response.json({ manifests: 2 });
    }
    if (failVersion)
      return Response.json(
        { error: "artifact_mismatch", message: "secret-token" },
        { status: 409 },
      );
    pkg.versions[0].files[0].digests = { sha1: "computed" };
    return Response.json({ updated: true });
  };
  return {
    calls,
    logs,
    options: { env, fetcher, log: (line) => logs.push(line) },
    failReindex: (value) => {
      failReindex = value;
    },
    failVersion: (value) => {
      failVersion = value;
    },
  };
}

describe("Composer shasum backfill operator", () => {
  it("includes yanked versions, skips existing digests and filters other ecosystems", async () => {
    const f = fixture();
    assert.deepEqual(await run([], f.options), { updated: 1, skipped: 1, errors: 0 });
    assert.deepEqual(f.calls, [
      ["GET", "/api/v1/packages"],
      ["POST", "/api/v1/packages/composer/acme%2Fsdk/1.0.0/backfill-digests"],
      ["POST", "/api/v1/packages/composer/acme%2Fsdk/reindex"],
    ]);
  });

  it("reindexes on rerun after a failed index rebuild without rehashing completed versions", async () => {
    const f = fixture();
    f.failReindex(true);
    assert.deepEqual(await run([], f.options), { updated: 1, skipped: 1, errors: 1 });
    f.failReindex(false);
    f.calls.length = 0;
    assert.deepEqual(await run([], f.options), { updated: 0, skipped: 2, errors: 0 });
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls[1][1].endsWith("/reindex"));
    assert.ok(!f.logs.join("\n").includes("secret-token"));
    assert.ok(!f.logs.join("\n").includes("signed.example"));
  });

  it("supports one package and still reindexes when a version fails", async () => {
    const f = fixture();
    f.failVersion(true);
    assert.deepEqual(await run(["--package", "acme/sdk"], f.options), {
      updated: 0,
      skipped: 1,
      errors: 1,
    });
    assert.equal(f.calls[0][1], "/api/v1/packages/composer/acme%2Fsdk");
    assert.ok(f.calls.at(-1)[1].endsWith("/reindex"));
    assert.ok(!f.logs.join("\n").includes("secret-token"));
  });

  it("continues after a failed version", async () => {
    const f = fixture();
    let posts = 0;
    const fetcher = async (url, options) => {
      if (options.method === "GET")
        return Response.json({
          packages: [
            {
              eco: "composer",
              name: "acme/sdk",
              versions: ["1.0.0", "1.1.0"].map((version) => ({ version, files: [{}] })),
            },
          ],
        });
      if (url.endsWith("/backfill-digests") && ++posts === 1)
        return Response.json({}, { status: 409 });
      return Response.json({ updated: true });
    };
    assert.deepEqual(await run([], { ...f.options, fetcher }), {
      updated: 1,
      skipped: 0,
      errors: 1,
    });
    assert.equal(posts, 2);
  });

  it("rejects invalid arguments and exits nonzero without exposing credentials", async () => {
    await assert.rejects(run(["--unknown"], { env }), /Usage/);
    await assert.rejects(run([], { env: {} }), /required/);
    const result = spawnSync(process.execPath, ["scripts/backfill-composer-shasum.mjs"], {
      env: { ...process.env, REGISTRY_URL: "secret-invalid-url", REGISTRY_TOKEN: "secret-token" },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes("secret-invalid-url"));
    assert.ok(!result.stderr.includes("secret-token"));
  });
});
