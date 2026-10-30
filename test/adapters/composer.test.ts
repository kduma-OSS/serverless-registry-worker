import { describe, expect, it } from "vitest";
import {
  COMPOSER_NAME_RE,
  compareComposerVersions,
  composerAdapter as adapter,
  expand,
  minify,
  normalizeComposerVersion,
  validateComposerVersion,
} from "../../src/adapters/composer/index";
import type { Manifest, PublishInit } from "../../src/adapters/types";
import { ValidationError } from "../../src/core/errors";
import fixture from "../fixtures/composer/composer.json";

const BASE = "https://packages.example.com";
const SHA = "a".repeat(64);

function init(overrides: Partial<PublishInit> = {}): PublishInit {
  return {
    eco: "composer",
    name: "acme/http-client",
    version: "2.1.0",
    files: [{ name: "http-client-2.1.0.zip", size: 18342, sha256: SHA }],
    manifest: structuredClone(fixture) as Record<string, unknown>,
    ...overrides,
  };
}

function manifest(version: string, native: Record<string, unknown>, yanked = false): Manifest {
  return {
    eco: "composer",
    name: "acme/x",
    version,
    files: [
      {
        name: `x-${version}.zip`,
        size: 10,
        sha256: version[0]?.repeat(64) ?? SHA,
        role: "archive",
      },
    ],
    published: "2026-10-28T10:00:00Z",
    publishedBy: "ci-acme",
    yanked,
    native,
  };
}

function rejects(fn: () => unknown, code = "invalid_request"): void {
  let error: unknown;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ValidationError);
  expect((error as ValidationError).code).toBe(code);
}

describe("composer versions", () => {
  it.each([
    "1.0.0",
    "0.0.1",
    "10.20.30",
    "1.0.0-alpha",
    "1.0.0-beta2",
    "1.0.0-beta.2",
    "2.0.0-rc1",
  ])("accepts %s", (v) => expect(adapter.validateVersion(v)).toBe(true));

  it.each([
    "1.0",
    "v1.0.0",
    "1.0.0-dev",
    "dev-main",
    "1.0.0-RC1",
    "1.0.0-beta.1.2",
    "1.0.0-preview",
    "1.0.0+build",
    "01.0.0",
    "1.0.0-beta01",
    "1.0.0.0",
  ])("rejects %s", (v) => expect(validateComposerVersion(v)).toBe(false));

  it.each([
    ["1.2.3", "1.2.3.0"],
    ["1.0.0-beta2", "1.0.0.0-beta2"],
    ["1.0.0-beta.2", "1.0.0.0-beta2"],
    ["1.0.0-alpha", "1.0.0.0-alpha"],
    ["1.0.0-rc1", "1.0.0.0-RC1"],
    ["1.0.0-rc", "1.0.0.0-RC"],
  ])("normalizes %s to %s", (v, expected) => expect(normalizeComposerVersion(v)).toBe(expected));

  it("orders versions the way Composer does", () => {
    const sorted = [
      "1.0.0",
      "1.0.0-rc10",
      "0.9.0",
      "1.0.0-alpha",
      "1.0.0-rc2",
      "1.0.0-beta",
      "1.0.0-beta.1",
      "1.10.0",
      "1.2.0",
    ].sort(compareComposerVersions);
    expect(sorted).toEqual([
      "0.9.0",
      "1.0.0-alpha",
      "1.0.0-beta",
      "1.0.0-beta.1",
      "1.0.0-rc2",
      "1.0.0-rc10",
      "1.0.0",
      "1.2.0",
      "1.10.0",
    ]);
    expect(adapter.compareVersions("1.0.0-rc2", "1.0.0-rc.2")).toBe(0);
  });

  it("evaluates Composer constraints", () => {
    expect(adapter.satisfies("2.1.0", "^2.0")).toBe(true);
    expect(adapter.satisfies("3.0.0", "^1.0 || ^2.0")).toBe(false);
    expect(adapter.satisfies("1.4.0", "~1.2")).toBe(true);
    expect(adapter.validateRange(">=1.0 <2.0")).toBe(true);
    expect(adapter.validateRange("dev-main")).toBe(false);
  });
});

describe("parseManifest", () => {
  it("accepts a real composer.json", () => {
    const m = adapter.parseManifest(init());
    expect(m).toMatchObject({
      eco: "composer",
      name: "acme/http-client",
      version: "2.1.0",
      yanked: false,
      files: [{ name: "http-client-2.1.0.zip", size: 18342, sha256: SHA, role: "archive" }],
    });
    expect(m.native).toEqual(fixture);
  });

  it("accepts a matching manifest version and an explicit archive role", () => {
    const input = init({
      manifest: { ...fixture, version: "2.1.0" },
      files: [{ name: "a.zip", size: 1, sha256: SHA, role: "archive" }],
    });
    expect(adapter.parseManifest(input).files[0]?.name).toBe("a.zip");
  });

  it("checks the package name", () => {
    expect(COMPOSER_NAME_RE.test("acme/http--client")).toBe(true);
    expect(COMPOSER_NAME_RE.test("acme/http---client")).toBe(false);
    rejects(() => adapter.parseManifest(init({ name: "Acme/http-client" })));
    rejects(() => adapter.parseManifest(init({ name: "acme" })));
    rejects(() => adapter.parseManifest(init({ name: "acme/other" })));
  });

  it("checks the version", () => {
    rejects(() => adapter.parseManifest(init({ version: "2.1" })));
    rejects(() => adapter.parseManifest(init({ manifest: { ...fixture, version: "2.0.0" } })));
  });

  it("requires a composer.json object", () => {
    rejects(() =>
      adapter.parseManifest(init({ manifest: [] as unknown as Record<string, unknown> })),
    );
    rejects(() => adapter.parseManifest(init({ manifest: { description: "x" } })));
  });

  it("requires exactly one .zip archive", () => {
    const file = { name: "a.zip", size: 1, sha256: SHA };
    rejects(() => adapter.parseManifest(init({ files: [file, { ...file, name: "b.zip" }] })));
    rejects(() => adapter.parseManifest(init({ files: [{ ...file, name: "a.tar.gz" }] })));
    rejects(() => adapter.parseManifest(init({ files: [{ ...file, role: "signature" }] })));
  });

  it("rejects npm-only fields", () => {
    rejects(() => adapter.parseManifest(init({ tag: "latest" })));
  });
});

describe("fileKey and URLs", () => {
  it("stores files under the encoded package name", () => {
    const m = adapter.parseManifest(init());
    const file = m.files[0];
    if (file === undefined) throw new Error("no file");
    expect(adapter.fileKey(m, file)).toBe(
      "composer/pkg/acme__http-client/2.1.0/http-client-2.1.0.zip",
    );
    const url = `${BASE}/composer/dist/acme/http-client/2.1.0.zip`;
    expect(adapter.versionUrl(m, BASE)).toBe(url);
    expect(adapter.fileUrl(m, file, BASE)).toBe(url);
  });
});

describe("minify / expand", () => {
  const v2 = {
    name: "acme/x",
    description: "B",
    version: "2.0.0",
    require: { php: "^8.1" },
    dist: { type: "zip", url: "u2" },
  };
  const v1 = {
    name: "acme/x",
    description: "A",
    version: "1.0.0",
    require: { php: "^8.1" },
    dist: { type: "zip", url: "u1" },
    license: "MIT",
  };
  const v0 = {
    name: "acme/x",
    description: "A",
    version: "0.9.0",
    dist: { type: "zip", url: "u0" },
  };

  it("lists only the changes from the previous entry", () => {
    const expected = [
      v2,
      { description: "A", version: "1.0.0", dist: { type: "zip", url: "u1" }, license: "MIT" },
      {
        version: "0.9.0",
        dist: { type: "zip", url: "u0" },
        require: "__unset",
        license: "__unset",
      },
    ];
    const minified = minify([v2, v1, v0]);
    expect(JSON.stringify(minified)).toBe(JSON.stringify(expected));
    expect(expand(minified)).toEqual([v2, v1, v0]);
  });

  it("treats null like an absent key, as PHP's isset does", () => {
    const minified = minify([
      { a: 1, b: null },
      { a: 1, b: null },
    ]);
    expect(minified).toEqual([{ a: 1, b: null }, { b: "__unset" }]);
    expect(expand(minified)).toEqual([{ a: 1, b: null }, { a: 1 }]);
  });

  it("handles empty lists and single entries", () => {
    expect(minify([])).toEqual([]);
    expect(minify([v1])).toEqual([v1]);
    expect(expand([v1])).toEqual([v1]);
  });

  it("compares nested values by content and key order", () => {
    const a = { name: "x", extra: { a: 1, b: 2 } };
    const b = { name: "x", extra: { b: 2, a: 1 } };
    expect(minify([a, { ...a }])).toEqual([a, {}]);
    expect(minify([a, b])).toEqual([a, { extra: { b: 2, a: 1 } }]);
  });
});

describe("buildIndex", () => {
  const native = (description: string, extra: Record<string, unknown> = {}) => ({
    name: "acme/x",
    description,
    type: "library",
    ...extra,
  });
  const manifests = [
    manifest("1.0.0", native("first", { license: "MIT" })),
    manifest(
      "1.1.0",
      native("second", { license: "MIT", version: "1.1.0", source: { type: "git" } }),
    ),
    manifest("1.2.0-beta1", native("third"), true),
    manifest("2.0.0", native("third")),
  ];

  it("writes minified Composer 2 metadata, newest first, without yanked versions", () => {
    const files = adapter.buildIndex("acme/x", manifests, { publicUrl: BASE });
    expect(files.map((f) => f.key)).toEqual([
      "composer/index/p2/acme/x.json",
      "composer/index/p2/acme/x~dev.json",
    ]);
    expect(files.every((f) => f.contentType === "application/json")).toBe(true);
    const dist = (v: string, c: string) => ({
      type: "zip",
      url: `${BASE}/composer/dist/acme/x/${v}.zip`,
      reference: c.repeat(64),
    });
    const expected = {
      packages: {
        "acme/x": [
          {
            name: "acme/x",
            description: "third",
            type: "library",
            version: "2.0.0",
            version_normalized: "2.0.0.0",
            dist: dist("2.0.0", "2"),
            time: "2026-10-28T10:00:00Z",
            "published-time": "2026-10-28T10:00:00Z",
          },
          {
            description: "second",
            version: "1.1.0",
            version_normalized: "1.1.0.0",
            dist: dist("1.1.0", "1"),
            license: "MIT",
          },
          {
            description: "first",
            version: "1.0.0",
            version_normalized: "1.0.0.0",
            dist: dist("1.0.0", "1"),
          },
        ],
      },
      minified: "composer/2.0",
    };
    expect(JSON.parse(files[0]?.body ?? "")).toEqual(expected);
    expect(JSON.parse(files[1]?.body ?? "")).toEqual({ packages: {}, minified: "composer/2.0" });
  });

  it("expands to the full composer.json of each version", () => {
    const [p2] = adapter.buildIndex("acme/x", [manifest("1.0.0", fixture)], { publicUrl: BASE });
    const body = JSON.parse(p2?.body ?? "") as { packages: Record<string, unknown[]> };
    const [entry] = expand(body.packages["acme/x"] ?? []);
    expect(entry).toEqual({
      ...fixture,
      name: "acme/x",
      version: "1.0.0",
      version_normalized: "1.0.0.0",
      dist: {
        type: "zip",
        url: `${BASE}/composer/dist/acme/x/1.0.0.zip`,
        reference: "1".repeat(64),
      },
      time: "2026-10-28T10:00:00Z",
      "published-time": "2026-10-28T10:00:00Z",
    });
    expect(entry).not.toHaveProperty("source");
    expect(entry).not.toHaveProperty("dist.shasum");
  });

  it("takes time and published-time from the registry, not from composer.json", () => {
    const m = manifest("1.0.0", { ...native("a"), time: "1999-01-01 00:00:00" });
    const [p2] = adapter.buildIndex("acme/x", [m], { publicUrl: BASE });
    const body = JSON.parse(p2?.body ?? "") as { packages: Record<string, unknown[]> };
    const [entry] = expand(body.packages["acme/x"] ?? []);
    expect(entry).toMatchObject({ time: m.published, "published-time": m.published });
  });

  it("writes an empty list when every version is yanked", () => {
    const [p2] = adapter.buildIndex("acme/x", [manifest("1.0.0", native("a"), true)], {
      publicUrl: BASE,
    });
    expect(JSON.parse(p2?.body ?? "")).toEqual({
      packages: { "acme/x": [] },
      minified: "composer/2.0",
    });
  });
});

describe("filterIndex", () => {
  const manifests = ["1.0.0", "1.1.0", "2.0.0"].map((v) =>
    manifest(v, { name: "acme/x", description: v === "2.0.0" ? "new" : "old" }),
  );
  const ctx = { publicUrl: BASE };
  const full = JSON.parse(adapter.buildIndex("acme/x", manifests, ctx)[0]?.body ?? "") as unknown;

  it("keeps the allowed versions and minifies them again", () => {
    const filtered = adapter.filterIndex(full, (_name, version) => version !== "1.1.0");
    const subset = [manifests[0], manifests[2]].filter((m) => m !== undefined);
    const expected = JSON.parse(
      adapter.buildIndex("acme/x", subset, ctx)[0]?.body ?? "",
    ) as unknown;
    expect(filtered).toEqual(expected);
  });

  it("keeps time and published-time on every allowed version", () => {
    const filtered = adapter.filterIndex(full, (_name, version) => version !== "1.1.0") as {
      packages: Record<string, unknown[]>;
    };
    const entries = expand(filtered.packages["acme/x"] ?? []);
    expect(entries.map((e) => e.version)).toEqual(["2.0.0", "1.0.0"]);
    for (const e of entries) {
      expect(e["published-time"]).toBe("2026-10-28T10:00:00Z");
      expect(e.time).toBe("2026-10-28T10:00:00Z");
    }
  });

  it("passes the package name and version to the predicate", () => {
    const seen: string[] = [];
    adapter.filterIndex(full, (name, version) => {
      seen.push(`${name}@${version}`);
      return true;
    });
    expect(seen).toEqual(["acme/x@2.0.0", "acme/x@1.1.0", "acme/x@1.0.0"]);
  });

  it("returns an empty list when nothing is allowed", () => {
    expect(adapter.filterIndex(full, () => false)).toEqual({
      packages: { "acme/x": [] },
      minified: "composer/2.0",
    });
  });

  it("leaves other bodies alone", () => {
    expect(adapter.filterIndex({ packages: {}, minified: "composer/2.0" }, () => false)).toEqual({
      packages: {},
      minified: "composer/2.0",
    });
    expect(adapter.filterIndex("text", () => false)).toBe("text");
  });
});

describe("route", () => {
  const route = (path: string, method = "GET") => {
    const url = new URL(`${BASE}${path}`);
    return adapter.route(new Request(url, { method }), url);
  };

  it("routes the native Composer paths", () => {
    expect(route("/composer/packages.json")).toEqual({ kind: "listing" });
    expect(route("/composer/p2/acme/http-client.json")).toEqual({
      kind: "index",
      key: "composer/index/p2/acme/http-client.json",
      name: "acme/http-client",
    });
    expect(route("/composer/p2/acme/http-client~dev.json")).toEqual({
      kind: "index",
      key: "composer/index/p2/acme/http-client~dev.json",
      name: "acme/http-client",
    });
    expect(route("/composer/dist/acme/http-client/1.0.0-rc1.zip")).toEqual({
      kind: "archive",
      name: "acme/http-client",
      version: "1.0.0-rc1",
      file: null,
    });
    expect(route("/composer/packages.json", "HEAD")).toEqual({ kind: "listing" });
  });

  it.each([
    "/composer",
    "/composer/",
    "/composer/p2/Acme/x.json",
    "/composer/p2/acme.json",
    "/composer/p2/acme/x/y.json",
    "/composer/dist/acme/x/dev-main.zip",
    "/composer/dist/acme/x/1.0.0.tar",
    "/composer/packages.json/x",
  ])("does not route %s", (path) => expect(route(path)).toBeNull());

  it("routes reads only", () => {
    expect(route("/composer/packages.json", "POST")).toBeNull();
  });
});

describe("buildListing", () => {
  it("lists the visible packages with the metadata URL", () => {
    const ctx = {
      publicUrl: BASE,
      route: { kind: "listing" as const },
      allowed: () => true,
      readIndex: () => Promise.resolve(null),
    };
    expect(adapter.buildListing?.(["acme/b", "acme/a"], ctx)).toEqual({
      "metadata-url": "/composer/p2/%package%.json",
      "available-packages": ["acme/a", "acme/b"],
      packages: [],
    });
  });
});

describe("dependencies", () => {
  it("takes require and require-dev entries of the real composer.json", () => {
    const m = manifest("2.1.0", structuredClone(fixture) as Record<string, unknown>);
    expect(adapter.dependencies(m)).toEqual([
      { name: "psr/http-client", constraint: "^1.0" },
      { name: "psr/http-factory", constraint: "^1.0" },
      { name: "psr/http-message", constraint: "^1.1 || ^2.0" },
      { name: "psr/log", constraint: "^2.0 || ^3.0" },
      { name: "phpunit/phpunit", constraint: "^10.5" },
      { name: "phpstan/phpstan", constraint: "^1.10" },
      { name: "nyholm/psr7", constraint: "^1.8" },
    ]);
  });

  it("skips platform packages, malformed keys and non-string constraints", () => {
    const m = manifest("1.0.0", {
      name: "acme/x",
      require: {
        php: "^8.1",
        "php-64bit": "*",
        "ext-json": "*",
        "lib-curl": ">=7",
        "composer-plugin-api": "^2.0",
        "composer-runtime-api": "^2.2",
        "acme/core": "dev-main as 1.0.0",
        "not-a-package": "1.0",
        "a/b/c": "1.0",
        "acme/odd": 1,
      },
      "require-dev": { "Acme/Tools": "~1.2" },
      replace: { "acme/old": "*" },
      provide: { "psr/log-implementation": "1.0" },
      conflict: { "acme/bad": "<1" },
    });
    expect(adapter.dependencies(m)).toEqual([
      { name: "acme/core", constraint: "dev-main as 1.0.0" },
      { name: "Acme/Tools", constraint: "~1.2" },
    ]);
  });

  it("returns nothing when the sections are missing or malformed", () => {
    expect(adapter.dependencies(manifest("1.0.0", { name: "acme/x" }))).toEqual([]);
    expect(adapter.dependencies(manifest("1.0.0", { require: ["acme/core"] }))).toEqual([]);
  });
});

describe("clientConfig", () => {
  const token = "shop-frontend:k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e";
  const snippets = adapter.clientConfig(`${BASE}/`, token, ["acme/sdk", "acme/http-client"]);
  const body = (i: number) => JSON.parse(snippets[i]?.body ?? "") as unknown;

  it("renders the config commands, the repository and both auth.json variants", () => {
    expect(snippets.map((s) => s.filename)).toEqual([
      "terminal",
      "composer.json",
      "auth.json",
      "composer.json",
      "auth.json",
      "composer.json",
      "composer.json",
      "terminal",
      "terminal",
    ]);
    expect(snippets[7]?.body).toBe(
      `export COMPOSER_AUTH='{"http-basic":{"packages.example.com":{"username":"shop-frontend","password":"k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e"}}}'\n`,
    );
    expect(snippets[0]?.body).toBe(
      `composer config repositories.sreg composer ${BASE}/composer\n` +
        "composer config http-basic.packages.example.com shop-frontend k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e\n",
    );
    for (const i of [1, 3]) {
      expect(body(i)).toEqual({
        repositories: [{ type: "composer", url: `${BASE}/composer` }],
      });
    }
    expect(body(2)).toEqual({ bearer: { "packages.example.com": token } });
    expect(body(4)).toEqual({
      "http-basic": {
        "packages.example.com": {
          username: "shop-frontend",
          password: "k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e",
        },
      },
    });
  });

  it("renders the token-in-URL variant that needs no auth.json", () => {
    expect(snippets[5]?.title).toContain("no auth.json");
    expect(body(5)).toEqual({
      repositories: [
        {
          type: "composer",
          url: "https://shop-frontend:k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e@packages.example.com/composer",
        },
      ],
    });
  });

  it("renders the require command for the packages", () => {
    expect(snippets[8]?.body).toBe("composer require acme/http-client acme/sdk\n");
    expect(adapter.clientConfig(BASE, token, [])).toHaveLength(8);
  });

  it("keeps the port in the host and the token prefix in the login", () => {
    const [, , bearer, , basic] = adapter.clientConfig("http://localhost:8787", `srg_${token}`, []);
    expect(JSON.parse(bearer?.body ?? "")).toEqual({
      bearer: { "localhost:8787": `srg_${token}` },
    });
    expect(JSON.parse(basic?.body ?? "")).toMatchObject({
      "http-basic": { "localhost:8787": { username: "srg_shop-frontend" } },
    });
  });
});
