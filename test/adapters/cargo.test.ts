import { describe, expect, it } from "vitest";
import { CRATE_NAME_RE, cargoAdapter as adapter, indexPath } from "../../src/adapters/cargo/index";
import type { IndexRoute, Manifest, PublishInit } from "../../src/adapters/types";
import { ValidationError } from "../../src/core/errors";
import fixture from "../fixtures/cargo/serde-index-line.json";

const BASE = "https://packages.example.com";

type Json = Record<string, unknown>;

/** The fields the Worker computes itself, removed from the real line to form the manifest. */
const COMPUTED = new Set(["cksum", "yanked", "v", "pubtime"]);

function cliManifest(): Json {
  return Object.fromEntries(
    Object.entries(structuredClone(fixture) as Json).filter(([key]) => !COMPUTED.has(key)),
  );
}

function init(overrides: Partial<PublishInit> = {}): PublishInit {
  return {
    eco: "cargo",
    name: "serde",
    version: "1.0.229",
    files: [{ name: "serde-1.0.229.crate", size: 79134, sha256: fixture.cksum }],
    manifest: cliManifest(),
    ...overrides,
  };
}

function withManifest(changes: Json): PublishInit {
  return init({ manifest: { ...cliManifest(), ...changes } });
}

function dep(changes: Json = {}): Json {
  return {
    name: "acme-util",
    req: "^1.2",
    features: [],
    optional: false,
    default_features: true,
    target: null,
    kind: "normal",
    ...changes,
  };
}

function manifest(version: string, yanked = false, native: Json = {}): Manifest {
  return {
    eco: "cargo",
    name: "acme-core",
    version,
    files: [
      {
        name: `acme-core-${version}.crate`,
        size: 10,
        sha256: (version[0] ?? "0").repeat(64),
        role: "archive",
      },
    ],
    published: "2026-10-28T10:00:00Z",
    publishedBy: "ci-acme",
    yanked,
    native: { name: "acme-core", vers: version, deps: [], features: {}, ...native },
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

function lines(text: unknown): Json[] {
  expect(typeof text).toBe("string");
  const body = text as string;
  expect(body.endsWith("\n")).toBe(true);
  return body
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Json);
}

describe("cargo versions and requirements", () => {
  it.each(["1.0.0", "0.0.1", "1.0.229", "2.0.0-alpha.1"])("accepts %s", (v) =>
    expect(adapter.validateVersion(v)).toBe(true),
  );

  it.each(["1.0", "v1.0.0", "01.0.0", "1.0.0+build", "1"])("rejects %s", (v) =>
    expect(adapter.validateVersion(v)).toBe(false),
  );

  it("evaluates cargo requirements", () => {
    expect(adapter.satisfies("1.4.2", ">=1.4, <2")).toBe(true);
    expect(adapter.satisfies("2.0.0", ">=1.4, <2")).toBe(false);
    expect(adapter.satisfies("1.9.0", "1.2")).toBe(true);
    expect(adapter.satisfies("0.3.0", "0.2")).toBe(false);
    expect(adapter.satisfies("1.0.229", "=1.0.229")).toBe(true);
    expect(adapter.validateRange(">=1.4, <2")).toBe(true);
    expect(adapter.validateRange("^1 || ^2")).toBe(false);
  });

  it("orders versions by semver precedence", () => {
    expect(["1.0.10", "1.0.2", "1.0.2-rc.1", "0.9.0"].sort(adapter.compareVersions)).toEqual([
      "0.9.0",
      "1.0.2-rc.1",
      "1.0.2",
      "1.0.10",
    ]);
  });
});

describe("indexPath", () => {
  it.each([
    ["a", "1/a"],
    ["ab", "2/ab"],
    ["abc", "3/a/abc"],
    ["serde", "se/rd/serde"],
    ["acme-core", "ac/me/acme-core"],
    ["Inflector", "in/fl/inflector"],
  ])("puts %s at %s", (name, path) => expect(indexPath(name)).toBe(path));
});

describe("parseManifest", () => {
  it("accepts a real index line without the computed fields", () => {
    const m = adapter.parseManifest(init());
    expect(m).toMatchObject({
      eco: "cargo",
      name: "serde",
      version: "1.0.229",
      yanked: false,
      files: [{ name: "serde-1.0.229.crate", size: 79134, sha256: fixture.cksum, role: "archive" }],
    });
    expect(m.native).toEqual(cliManifest());
    expect(m.meta).toBeUndefined();
  });

  it("keeps the optional fields and drops unknown ones", () => {
    const m = adapter.parseManifest(
      withManifest({
        features2: { json: ["dep:serde_json"] },
        links: null,
        rust_version: null,
        cksum: "f".repeat(64),
        extra: true,
        deps: [dep({ registry: null, package: "acme_util" })],
      }),
    );
    expect(m.native).toEqual({
      name: "serde",
      vers: "1.0.229",
      deps: [dep({ registry: null, package: "acme_util" })],
      features: fixture.features,
      features2: { json: ["dep:serde_json"] },
      links: null,
      rust_version: null,
    });
  });

  it("checks the crate name", () => {
    expect(CRATE_NAME_RE.test("a")).toBe(true);
    expect(CRATE_NAME_RE.test(`a${"b".repeat(63)}`)).toBe(true);
    for (const name of [
      "Serde",
      "1serde",
      "_serde",
      "-serde",
      "ser.de",
      "",
      `a${"b".repeat(64)}`,
    ]) {
      rejects(() =>
        adapter.parseManifest(
          init({
            name,
            manifest: { ...cliManifest(), name },
            files: [{ name: `${name}-1.0.229.crate`, size: 1, sha256: fixture.cksum }],
          }),
        ),
      );
    }
  });

  it("requires name and vers to match the request", () => {
    rejects(() => adapter.parseManifest(withManifest({ name: "serde_core" })));
    rejects(() => adapter.parseManifest(withManifest({ vers: "1.0.228" })));
    rejects(() => adapter.parseManifest(init({ version: "1.0.229+build" })));
  });

  it("validates the structure of the index line", () => {
    for (const changes of [
      { deps: undefined },
      { deps: {} },
      { deps: ["serde_core"] },
      { features: undefined },
      { features: { std: "serde_core/std" } },
      { features2: [] },
      { features2: { json: [1] } },
      { links: 1 },
      { rust_version: 1.56 },
    ]) {
      rejects(() => adapter.parseManifest(withManifest(changes)));
    }
  });

  it("validates every dependency", () => {
    for (const changes of [
      { name: "" },
      { name: "a/b" },
      { req: "" },
      { req: 1 },
      { features: "derive" },
      { optional: "no" },
      { default_features: undefined },
      { target: undefined },
      { kind: "peer" },
      { registry: 1 },
      { package: "a b" },
    ]) {
      rejects(() => adapter.parseManifest(withManifest({ deps: [dep(changes)] })));
    }
    expect(
      adapter.parseManifest(
        withManifest({ deps: [dep({ kind: "build", target: "cfg(unix)", name: "Inflector" })] }),
      ).native.deps,
    ).toEqual([dep({ kind: "build", target: "cfg(unix)", name: "Inflector" })]);
  });

  it("requires exactly one archive named <name>-<version>.crate", () => {
    const file = { name: "serde-1.0.229.crate", size: 1, sha256: fixture.cksum };
    expect(adapter.parseManifest(init({ files: [{ ...file, role: "archive" }] })).files).toEqual([
      { ...file, role: "archive" },
    ]);
    rejects(() => adapter.parseManifest(init({ files: [{ ...file, name: "serde.crate" }] })));
    rejects(() =>
      adapter.parseManifest(init({ files: [{ ...file, name: "serde-1.0.229.tar.gz" }] })),
    );
    rejects(() => adapter.parseManifest(init({ files: [file, { ...file, name: "x.crate" }] })));
    rejects(() => adapter.parseManifest(init({ files: [{ ...file, role: "symbols" }] })));
  });

  it("rejects npm-only fields", () => {
    rejects(() => adapter.parseManifest(init({ tag: "latest" })));
  });
});

describe("fileKey and URLs", () => {
  it("stores files under the crate name and serves them at the dl URL", () => {
    const m = adapter.parseManifest(init());
    const file = m.files[0];
    if (file === undefined) throw new Error("no file");
    expect(adapter.fileKey(m, file)).toBe("cargo/pkg/serde/1.0.229/serde-1.0.229.crate");
    const url = `${BASE}/cargo/dl/serde/1.0.229`;
    expect(adapter.versionUrl(m, BASE)).toBe(url);
    expect(adapter.fileUrl(m, file, BASE)).toBe(url);
  });
});

describe("buildIndex", () => {
  it("reproduces the real index line with v: 2", () => {
    const m = { ...adapter.parseManifest(init()), published: "2026-07-18T23:05:13Z" };
    const files = adapter.buildIndex("serde", [m], { publicUrl: BASE });
    expect(files.map((f) => [f.key, f.contentType])).toEqual([
      ["cargo/index/se/rd/serde", "text/plain; charset=utf-8"],
    ]);
    const [line] = lines(files[0]?.body);
    expect(line).toEqual({ ...(fixture as Json), v: 2 });
    expect(Object.keys(line ?? {})).toEqual([
      "name",
      "vers",
      "deps",
      "cksum",
      "features",
      "yanked",
      "rust_version",
      "v",
      "pubtime",
    ]);
  });

  it("writes one line per version in version order, yanked ones marked", () => {
    const files = adapter.buildIndex(
      "acme-core",
      [
        manifest("1.10.0"),
        manifest("1.2.0", true),
        manifest("2.0.0-rc.1", false, {
          features2: { json: ["dep:serde_json"] },
          links: "acme",
        }),
      ],
      { publicUrl: BASE },
    );
    expect(files[0]?.key).toBe("cargo/index/ac/me/acme-core");
    const body = lines(files[0]?.body);
    expect(body.map((l) => [l.vers, l.yanked])).toEqual([
      ["1.2.0", true],
      ["1.10.0", false],
      ["2.0.0-rc.1", false],
    ]);
    expect(body[0]).toEqual({
      name: "acme-core",
      vers: "1.2.0",
      deps: [],
      cksum: "1".repeat(64),
      features: {},
      yanked: true,
      v: 2,
      pubtime: "2026-10-28T10:00:00Z",
    });
    expect(Object.keys(body[2] ?? {})).toEqual([
      "name",
      "vers",
      "deps",
      "cksum",
      "features",
      "features2",
      "yanked",
      "links",
      "v",
      "pubtime",
    ]);
  });

  it.each([
    ["a", "cargo/index/1/a"],
    ["ab", "cargo/index/2/ab"],
    ["abc", "cargo/index/3/a/abc"],
    ["abcd", "cargo/index/ab/cd/abcd"],
  ])("writes %s at %s", (name, key) => {
    const m = { ...manifest("1.0.0"), name };
    expect(adapter.buildIndex(name, [m], { publicUrl: BASE })[0]?.key).toBe(key);
  });
});

describe("filterIndex", () => {
  const body = adapter.buildIndex(
    "acme-core",
    ["1.0.0", "1.4.0", "1.5.0", "2.0.0"].map((v) => manifest(v, v === "1.5.0")),
    { publicUrl: BASE },
  )[0]?.body;
  const range = (_name: string, version: string) => adapter.satisfies(version, ">=1.4, <2");

  it("keeps the lines of the allowed versions", () => {
    const kept = lines(adapter.filterIndex(body, range));
    expect(kept.map((l) => [l.vers, l.yanked])).toEqual([
      ["1.4.0", false],
      ["1.5.0", true],
    ]);
  });

  it("passes the crate name and version to the predicate", () => {
    const seen: string[] = [];
    adapter.filterIndex(body, (name, version) => {
      seen.push(`${name}@${version}`);
      return true;
    });
    expect(seen).toEqual([
      "acme-core@1.0.0",
      "acme-core@1.4.0",
      "acme-core@1.5.0",
      "acme-core@2.0.0",
    ]);
  });

  it("returns null when nothing is allowed", () => {
    expect(adapter.filterIndex(body, () => false)).toBeNull();
    expect(adapter.filterIndex("", () => true)).toBeNull();
  });

  it("skips malformed lines and leaves other bodies alone", () => {
    const text = `not json\n{"name":"x"}\n${JSON.stringify({ name: "x", vers: "1.0.0" })}\n`;
    expect(lines(adapter.filterIndex(text, () => true))).toEqual([{ name: "x", vers: "1.0.0" }]);
    expect(adapter.filterIndex({ a: 1 }, () => false)).toEqual({ a: 1 });
  });

  it("renders the api view of the allowed versions", () => {
    const route: IndexRoute = {
      kind: "index",
      key: "cargo/index/ac/me/acme-core",
      name: "acme-core",
      view: "api",
    };
    expect(adapter.filterIndex(body, range, route)).toEqual({
      crate: {
        name: "acme-core",
        max_version: "1.4.0",
        versions: [
          { num: "1.5.0", yanked: true },
          { num: "1.4.0", yanked: false },
        ],
      },
    });
    expect(adapter.filterIndex(body, (_n, v) => v === "1.5.0", route)).toEqual({
      crate: {
        name: "acme-core",
        max_version: "1.5.0",
        versions: [{ num: "1.5.0", yanked: true }],
      },
    });
    expect(adapter.filterIndex(body, () => false, route)).toBeNull();
  });
});

describe("route", () => {
  const route = (path: string, method = "GET") => {
    const url = new URL(`${BASE}${path}`);
    return adapter.route(new Request(url, { method }), url);
  };

  it("routes config.json", () => {
    expect(route("/cargo/index/config.json")).toEqual({ kind: "config" });
    expect(route("/cargo/index/config.json", "HEAD")).toEqual({ kind: "config" });
  });

  it.each([
    ["/cargo/index/1/a", "a"],
    ["/cargo/index/2/ab", "ab"],
    ["/cargo/index/3/a/abc", "abc"],
    ["/cargo/index/se/rd/serde", "serde"],
    ["/cargo/index/ac/me/acme-core", "acme-core"],
  ])("routes the index file %s", (path, name) => {
    expect(route(path)).toEqual({ kind: "index", key: path.slice(1), name });
  });

  it("routes downloads and the crate API", () => {
    expect(route("/cargo/dl/acme-core/1.4.2")).toEqual({
      kind: "archive",
      name: "acme-core",
      version: "1.4.2",
      file: null,
    });
    expect(route("/cargo/api/v1/crates/acme-core")).toEqual({
      kind: "index",
      key: "cargo/index/ac/me/acme-core",
      name: "acme-core",
      view: "api",
    });
  });

  it.each([
    "/cargo",
    "/cargo/index/",
    "/cargo/index/1/ab",
    "/cargo/index/2/a",
    "/cargo/index/3/b/abc",
    "/cargo/index/3/abc",
    "/cargo/index/se/rv/serde",
    "/cargo/index/serde",
    "/cargo/index/Se/rd/Serde",
    "/cargo/index/se/rd/serde/x",
    "/cargo/dl/acme-core",
    "/cargo/dl/acme-core/1.4",
    "/cargo/dl/Acme/1.0.0",
    "/cargo/dl/acme-core/1.4.2/download",
    "/cargo/api/v1/crates",
    "/cargo/api/v1/crates/Acme",
  ])("does not route %s", (path) => expect(route(path)).toBeNull());

  it("routes reads only", () => {
    expect(route("/cargo/index/config.json", "POST")).toBeNull();
    expect(route("/cargo/api/v1/crates/new", "PUT")).toBeNull();
  });
});

describe("buildConfig", () => {
  it("points cargo at the download and API URLs and requires authentication", () => {
    expect(adapter.buildConfig?.({ publicUrl: BASE })).toEqual({
      dl: `${BASE}/cargo/dl/{crate}/{version}`,
      api: `${BASE}/cargo`,
      "auth-required": true,
    });
  });
});

describe("dependencies", () => {
  it("takes the deps of the real index line from this registry", () => {
    expect(adapter.dependencies(adapter.parseManifest(init()))).toEqual([
      { name: "serde_core", constraint: "=1.0.229" },
      { name: "serde_derive", constraint: "^1" },
    ]);
  });

  it("skips other registries and resolves renamed dependencies", () => {
    const m = manifest("1.0.0", false, {
      deps: [
        dep({ registry: null }),
        dep({ name: "util2", package: "acme-util", req: "^2", kind: "dev", registry: null }),
        dep({ name: "serde", registry: "https://github.com/rust-lang/crates.io-index" }),
        dep({ name: "build-helper", req: ">=0.3, <0.5", kind: "build" }),
        "garbage",
      ],
    });
    expect(adapter.dependencies(m)).toEqual([
      { name: "acme-util", constraint: "^1.2" },
      { name: "acme-util", constraint: "^2" },
      { name: "build-helper", constraint: ">=0.3, <0.5" },
    ]);
    expect(adapter.dependencies(manifest("1.0.0", false, { deps: "x" }))).toEqual([]);
  });
});

describe("clientConfig", () => {
  const token = "shop-backend:k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e";

  it("renders config.toml, credentials.toml, Cargo.toml and cargo add", () => {
    const snippets = adapter.clientConfig(`${BASE}/`, token, ["acme-core", "acme-cli"]);
    expect(snippets.map((s) => [s.filename, s.language])).toEqual([
      ["config.toml", "toml"],
      ["credentials.toml", "toml"],
      ["terminal", "shell"],
      ["Cargo.toml", "toml"],
      ["terminal", "shell"],
    ]);
    expect(snippets[0]?.body).toBe(`[registries.sreg]\nindex = "sparse+${BASE}/cargo/index/"\n`);
    expect(snippets[1]?.body).toBe(`[registries.sreg]\ntoken = "${token}"\n`);
    expect(snippets[2]?.body).toBe(
      [
        `export CARGO_REGISTRIES_SREG_INDEX=sparse+${BASE}/cargo/index/`,
        `export CARGO_REGISTRIES_SREG_TOKEN=${token}`,
        "",
      ].join("\n"),
    );
    expect(snippets[3]?.body).toBe(
      [
        "[dependencies]",
        'acme-cli = { version = "*", registry = "sreg" }',
        'acme-core = { version = "*", registry = "sreg" }',
        "",
      ].join("\n"),
    );
    expect(snippets[4]?.body).toBe("cargo add --registry sreg acme-cli acme-core\n");
  });

  it("uses a placeholder crate without packages", () => {
    const snippets = adapter.clientConfig("http://localhost:8787", token, []);
    expect(snippets).toHaveLength(4);
    expect(snippets[0]?.body).toContain('index = "sparse+http://localhost:8787/cargo/index/"');
    expect(snippets[3]?.body).toContain('my-crate = { version = "*", registry = "sreg" }');
  });
});
