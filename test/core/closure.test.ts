import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { composerAdapter as adapter } from "../../src/adapters/composer/index";
import type { Manifest } from "../../src/adapters/types";
import type { Identity, Kind } from "../../src/core/auth";
import {
  CLOSURE_TTL_SECONDS,
  DependencyGraph,
  allowedFor,
  allowsVersion,
  closureCacheUrl,
  computeClosure,
  walkDependencies,
  type Closure,
  type ClosureCache,
} from "../../src/core/closure";
import type { Grant } from "../../src/core/grants";
import {
  depsGraphKey,
  rebuildDepsGraph,
  replacePackageDeps,
  setVersionDeps,
  writeManifest,
} from "../../src/core/storage";
import { identityOf } from "../records";

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}`;
}

function identity(project: string, grants: Grant[], kind: Kind = "read"): Identity {
  return identityOf(project, kind, grants);
}

/** An in-memory stand-in for `caches.default` that ignores `max-age` and can be cleared. */
class MemoryCache implements ClosureCache {
  readonly entries = new Map<string, { body: string; headers: Headers }>();
  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const entry = this.entries.get(String(request));
    return entry === undefined ? undefined : new Response(entry.body, { headers: entry.headers });
  }
  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(String(request), { body: await response.text(), headers: response.headers });
  }
}

type Spec = [version: string, require?: Record<string, string>, yanked?: boolean];

function manifest(name: string, [version, require = {}, yanked = false]: Spec): Manifest {
  return {
    eco: "composer",
    name,
    version,
    files: [{ name: "a.zip", size: 3, sha256: "a".repeat(64), role: "archive" }],
    published: "2026-10-01T00:00:00Z",
    publishedBy: "ci",
    yanked,
    native: { name, require },
  };
}

/** Records the versions in the composer dependency graph, as a commit does. */
async function seed(name: string, versions: Spec[]): Promise<void> {
  for (const spec of versions) {
    await setVersionDeps(
      env,
      "composer",
      name,
      spec[0],
      adapter.dependencies(manifest(name, spec)),
    );
  }
}

function plain(closure: Closure): Record<string, string[]> {
  return Object.fromEntries(
    [...closure.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, versions]) => [name, [...versions].sort()]),
  );
}

function grant(pkg: string, versions = "*", transitive?: boolean): Grant {
  return {
    eco: "composer",
    package: pkg,
    versions,
    ...(transitive === undefined ? {} : { transitive }),
  };
}

/** Computes a closure with a fresh in-memory cache. */
function closureOf(reader: Identity, cache: ClosureCache = new MemoryCache()) {
  return computeClosure(env, reader, "composer", adapter, { cache });
}

/** A vendor with `a` 1.0.0 → `b` ^1.1 (1.0.0, 1.1.0, 1.4.0, 2.0.0), `b` 1.4.0 → `c` (0.1.0). */
async function chain(): Promise<string> {
  const v = unique("chain");
  await seed(`${v}/a`, [["1.0.0", { php: "^8.1", [`${v}/b`]: "^1.1" }]]);
  await seed(`${v}/b`, [
    ["1.0.0"],
    ["1.1.0"],
    ["1.4.0", { [`${v}/c`]: "^0.1" }],
    ["2.0.0", { [`${v}/c`]: "*" }],
  ]);
  await seed(`${v}/c`, [["0.1.0"]]);
  return v;
}

describe("computeClosure", () => {
  it("follows dependency constraints transitively", async () => {
    const v = await chain();
    const reader = identity(unique("closure-"), [grant(`${v}/a`)]);
    expect(plain(await closureOf(reader))).toEqual({
      [`${v}/b`]: ["1.1.0", "1.4.0"],
      [`${v}/c`]: ["0.1.0"],
    });
  });

  it("starts only from the versions the grant covers", async () => {
    const v = unique("range");
    await seed(`${v}/a`, [
      ["1.0.0", { [`${v}/b`]: "^1.0" }],
      ["2.0.0", { [`${v}/b`]: "^2.0" }],
    ]);
    await seed(`${v}/b`, [["1.0.0"], ["2.0.0"]]);
    const reader = identity(unique("closure-"), [grant(`${v}/a`, "^2.0")]);
    expect(plain(await closureOf(reader))).toEqual({ [`${v}/b`]: ["2.0.0"] });
  });

  it("opens nothing for non-transitive grants and does not cache", async () => {
    const v = await chain();
    const project = unique("opaque-");
    const reader = identity(project, [grant(`${v}/a`, "*", false), grant(`${v}/c`, "*", false)]);
    const cache = new MemoryCache();
    expect((await closureOf(reader, cache)).size).toBe(0);
    expect(cache.entries.size).toBe(0);
  });

  it("lets yanked versions take part as sources and targets", async () => {
    const v = unique("yanked");
    const specs: [string, Spec][] = [
      [`${v}/a`, ["1.0.0", { [`${v}/b`]: "^1.0" }, true]],
      [`${v}/b`, ["1.0.0", { [`${v}/c`]: "^1.0" }, true]],
      [`${v}/c`, ["1.0.0"]],
    ];
    for (const [name, spec] of specs) await writeManifest(env, manifest(name, spec));
    // The graph built from the manifests keeps yanked versions like any other.
    const graph = await rebuildDepsGraph(env, "composer", (m) => adapter.dependencies(m));
    expect(graph[`${v}/a`]).toEqual({ "1.0.0": { [`${v}/b`]: "^1.0" } });
    const reader = identity(unique("closure-"), [grant(`${v}/a`)]);
    expect(plain(await closureOf(reader))).toEqual({
      [`${v}/b`]: ["1.0.0"],
      [`${v}/c`]: ["1.0.0"],
    });
  });

  it("handles cycles, case-insensitive names and unknown or unparsable dependencies", async () => {
    const v = unique("cycle");
    await seed(`${v}/a`, [
      [
        "1.0.0",
        {
          [`${v.toUpperCase()}/B`]: "^1.0",
          [`${v}/missing`]: "*",
          [`${v}/c`]: "dev-main as 1.0.0",
        },
      ],
    ]);
    await seed(`${v}/b`, [["1.0.0", { [`${v}/a`]: "^1.0" }]]);
    await seed(`${v}/c`, [["1.0.0"]]);
    const reader = identity(unique("closure-"), [grant(`${v}/a`)]);
    expect(plain(await closureOf(reader))).toEqual({
      [`${v}/a`]: ["1.0.0"],
      [`${v}/b`]: ["1.0.0"],
    });
  });

  it("admits the versions of every constraint of a dependency declared twice", async () => {
    const v = unique("twice");
    await setVersionDeps(env, "composer", `${v}/a`, "1.0.0", [
      { name: `${v}/b`, constraint: "^1.0" },
      { name: `${v}/b`, constraint: "^3.0" },
    ]);
    await seed(`${v}/b`, [["1.0.0"], ["2.0.0"], ["3.0.0"]]);
    const reader = identity(unique("closure-"), [grant(`${v}/a`)]);
    expect(plain(await closureOf(reader))).toEqual({ [`${v}/b`]: ["1.0.0", "3.0.0"] });
  });

  it("ignores packages that are not in the dependency graph", async () => {
    const v = await chain();
    await replacePackageDeps(env, "composer", `${v}/b`, new Map());
    const reader = identity(unique("closure-"), [grant(`${v}/a`)]);
    expect((await closureOf(reader)).size).toBe(0);
  });

  it("reads the dependency graph once and lists nothing", async () => {
    const v = await chain();
    const read: string[] = [];
    const bucket = env.R2_BUCKET;
    const counting = {
      list: () => {
        throw new Error("no listing expected");
      },
      get: (key: string) => {
        read.push(key);
        return bucket.get(key);
      },
    } as unknown as R2Bucket;
    const reader = identity(unique("closure-"), [grant(`${v}/a`), grant(`${v}/c`)]);
    const closure = await computeClosure({ R2_BUCKET: counting }, reader, "composer", adapter, {
      cache: new MemoryCache(),
    });
    expect(plain(closure)[`${v}/b`]).toEqual(["1.1.0", "1.4.0"]);
    expect(read).toEqual([depsGraphKey("composer")]);
  });
});

describe("walkDependencies", () => {
  it("records the distinct constraints that reach each package", () => {
    const graph = new DependencyGraph(adapter, {
      "acme/a": { "1.0.0": { "acme/b": "^1.0", "acme/c": "*" } },
      "acme/b": { "1.0.0": { "acme/c": ["^1.0", "*"] }, "2.0.0": {} },
      "acme/c": { "1.0.0": {} },
    });
    const reached = walkDependencies(graph, [{ name: "acme/a", version: "1.0.0" }]);
    expect(reached.get("acme/b")).toEqual({ constraints: ["^1.0"], versions: new Set(["1.0.0"]) });
    expect(reached.get("acme/c")).toEqual({
      constraints: ["*", "^1.0"],
      versions: new Set(["1.0.0"]),
    });
    expect(graph.resolve("ACME/B")).toBe("acme/b");
    expect(graph.resolve("acme/zzz")).toBeNull();
    expect(graph.versions("acme/zzz")).toEqual([]);
  });
});

describe("closure cache", () => {
  it("serves the cached closure until the entry expires", async () => {
    const v = await chain();
    const project = unique("cached-");
    const reader = identity(project, [grant(`${v}/a`)]);
    const cache = new MemoryCache();
    await closureOf(reader, cache);
    const url = closureCacheUrl("composer", project);
    expect([...cache.entries.keys()]).toEqual([url]);
    const entry = cache.entries.get(url);
    expect(entry?.headers.get("cache-control")).toBe(`max-age=${CLOSURE_TTL_SECONDS}`);
    expect(JSON.parse(entry?.body ?? "")).toEqual({
      packages: { [`${v}/b`]: ["1.1.0", "1.4.0"], [`${v}/c`]: ["0.1.0"] },
    });

    // A new version is not seen while the cached entry lives.
    await seed(`${v}/b`, [["1.5.0"]]);
    expect(plain(await closureOf(reader, cache))[`${v}/b`]).toEqual(["1.1.0", "1.4.0"]);

    // `fresh` skips the entry and caches the new closure.
    const fresh = await computeClosure(env, reader, "composer", adapter, { cache, fresh: true });
    expect(plain(fresh)[`${v}/b`]).toEqual(["1.1.0", "1.4.0", "1.5.0"]);
    expect(JSON.parse(cache.entries.get(url)?.body ?? "").packages[`${v}/b`]).toEqual([
      "1.1.0",
      "1.4.0",
      "1.5.0",
    ]);

    // Once the entry is gone (expired), the closure is computed again.
    await seed(`${v}/b`, [["1.6.0"]]);
    cache.entries.clear();
    expect(plain(await closureOf(reader, cache))[`${v}/b`]).toEqual([
      "1.1.0",
      "1.4.0",
      "1.5.0",
      "1.6.0",
    ]);
  });

  it("keys the cache by ecosystem and credential", () => {
    expect(closureCacheUrl("composer", "acme-shop")).toBe(
      "https://cache.internal/closure/composer/acme-shop",
    );
    expect(closureCacheUrl("npm", "src.team a")).toBe(
      "https://cache.internal/closure/npm/src.team%20a",
    );
  });

  it("recomputes when the cached value is malformed or the cache fails", async () => {
    const v = await chain();
    const project = unique("broken-");
    const cache = new MemoryCache();
    const url = closureCacheUrl("composer", project);
    cache.entries.set(url, { body: JSON.stringify({ packages: [] }), headers: new Headers() });
    const reader = identity(project, [grant(`${v}/a`)]);
    const expected = { [`${v}/b`]: ["1.1.0", "1.4.0"], [`${v}/c`]: ["0.1.0"] };
    expect(plain(await closureOf(reader, cache))).toEqual(expected);
    cache.entries.set(url, { body: "not json", headers: new Headers() });
    expect(plain(await closureOf(reader, cache))).toEqual(expected);

    const failing: ClosureCache = {
      match: () => Promise.reject(new Error("cache down")),
      put: () => Promise.reject(new Error("cache down")),
    };
    expect(plain(await closureOf(reader, failing))).toEqual(expected);
  });

  it("uses caches.default when no cache is given", async () => {
    const v = await chain();
    const project = unique("default-");
    const reader = identity(project, [grant(`${v}/a`)]);
    await computeClosure(env, reader, "composer", adapter);
    const cached = await caches.default.match(closureCacheUrl("composer", project));
    expect(await cached?.json()).toEqual({
      packages: { [`${v}/b`]: ["1.1.0", "1.4.0"], [`${v}/c`]: ["0.1.0"] },
    });
    await caches.default.delete(closureCacheUrl("composer", project));
  });
});

describe("allowedFor", () => {
  it("allows explicit grants first and the closure second", async () => {
    const v = await chain();
    const allowed = await allowedFor(
      env,
      identity(unique("allowed-"), [grant(`${v}/a`), grant(`${v}/b`, "^2.0", false)]),
      "composer",
      adapter,
      { cache: new MemoryCache() },
    );
    expect(allowed(`${v}/a`, "1.0.0")).toBe(true);
    expect(allowed(`${v}/b`, "2.0.0")).toBe(true);
    expect(allowed(`${v}/b`, "1.4.0")).toBe(true);
    expect(allowed(`${v}/b`, "1.0.0")).toBe(false);
    expect(allowed(`${v}/c`, "0.1.0")).toBe(true);
    expect(allowed(`${v}/c`, "0.2.0")).toBe(false);
  });

  it("allows everything for admin and only explicit grants for publish", async () => {
    const v = await chain();
    const cache = new MemoryCache();
    const admin = await allowedFor(env, identity("root", [], "admin"), "composer", adapter, {
      cache,
    });
    expect(admin(`${v}/c`, "9.9.9")).toBe(true);
    const publisher = await allowedFor(
      env,
      {
        ...identity(unique("publisher-"), [], "publish"),
        grants: { read: [grant(`${v}/a`)], publish: [], yank: [], delete: [] },
      },
      "composer",
      adapter,
      { cache },
    );
    expect(publisher(`${v}/a`, "1.0.0")).toBe(true);
    expect(publisher(`${v}/b`, "1.4.0")).toBe(false);
    expect(cache.entries.size).toBe(0);
  });
});

describe("allowsVersion", () => {
  it("answers from the explicit grants without computing a closure", async () => {
    const v = await chain();
    const cache = new MemoryCache();
    const options = { cache };
    const reader = identity(unique("download-"), [grant(`${v}/a`)]);
    const allows = (name: string, version: string, who = reader) =>
      allowsVersion(env, who, "composer", adapter, name, version, options);
    expect(await allows(`${v}/a`, "1.0.0")).toBe(true);
    expect(cache.entries.size).toBe(0);
    expect(await allows(`${v}/b`, "1.4.0")).toBe(true);
    expect(cache.entries.size).toBe(1);
    expect(await allows(`${v}/b`, "2.0.0")).toBe(false);
    expect(await allows(`${v}/b`, "2.0.0", identity("root", [], "admin"))).toBe(true);
  });
});
