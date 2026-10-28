import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { composerAdapter } from "../../src/adapters/composer/index";
import { nugetAdapter } from "../../src/adapters/nuget/index";
import { swiftAdapter } from "../../src/adapters/swift/index";
import type { Manifest } from "../../src/adapters/types";
import type { Identity, Kind } from "../../src/core/auth";
import { ValidationError } from "../../src/core/errors";
import type { Grant } from "../../src/core/grants";
import { deleteVersion, reindex, yank } from "../../src/core/admin";
import {
  allDependencies,
  getPackage,
  listPackages,
  listPackageSummaries,
} from "../../src/core/packages";
import { addPackageToMeta, setVersionDeps, writeManifest } from "../../src/core/storage";
import { identityOf } from "../records";

let counter = 0;
function vendor(): string {
  counter += 1;
  return `list${counter}`;
}

function identity(kind: Kind, grants: Grant[] = []): Identity {
  return identityOf("someone", kind, grants);
}

async function seed(
  name: string,
  versions: [string, boolean, Record<string, string>?][],
): Promise<void> {
  for (const [version, yanked, require = {}] of versions) {
    const m: Manifest = {
      eco: "composer",
      name,
      version,
      files: [{ name: "a.zip", size: 3, sha256: "a".repeat(64), role: "archive" }],
      published: "2026-10-01T00:00:00Z",
      publishedBy: "ci",
      yanked,
      native: { name, require },
    };
    await writeManifest(env, m);
    await setVersionDeps(env, "composer", name, version, composerAdapter.dependencies(m));
  }
  await addPackageToMeta(env, "composer", name, {
    versions: versions.length,
    updated: "2026-10-01T00:00:00Z",
  });
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ValidationError) return err.code;
    throw err;
  }
  return "ok";
}

describe("listPackages", () => {
  it("lists everything for admin, highest version first, yanked included", async () => {
    const v = vendor();
    await seed(`${v}/b`, [
      ["1.0.0", false],
      ["1.10.0", true],
      ["1.2.0", false],
    ]);
    await seed(`${v}/a`, [["0.1.0", false]]);
    const { packages } = await listPackages(env, identity("admin"));
    const mine = packages.filter((p) => p.name.startsWith(`${v}/`));
    expect(mine.map((p) => p.name)).toEqual([`${v}/a`, `${v}/b`]);
    expect(mine[1]?.versions.map((x) => [x.version, x.yanked])).toEqual([
      ["1.10.0", true],
      ["1.2.0", false],
      ["1.0.0", false],
    ]);
    expect(mine[0]?.versions[0]).toEqual({
      version: "0.1.0",
      published: "2026-10-01T00:00:00Z",
      yanked: false,
      files: [{ name: "a.zip", size: 3, sha256: "a".repeat(64), role: "archive" }],
    });
  });

  it("filters by the read grants and omits packages without visible versions", async () => {
    const v = vendor();
    await seed(`${v}/sdk`, [
      ["1.0.0", false],
      ["2.0.0", false],
    ]);
    await seed(`${v}/other`, [["3.0.0", false]]);
    await seed(`${v}/hidden`, [["1.0.0", false]]);
    const reader = identity("read", [
      { eco: "composer", package: `${v}/sdk`, versions: "^2.0" },
      { eco: "composer", package: `${v}/other`, versions: "^1.0" },
    ]);
    const { packages } = await listPackages(env, reader);
    expect(packages.map((p) => [p.name, p.versions.map((x) => x.version)])).toEqual([
      [`${v}/sdk`, ["2.0.0"]],
    ]);
  });

  it("skips disabled ecosystems and refuses publish credentials", async () => {
    const v = vendor();
    await seed(`${v}/a`, [["1.0.0", false]]);
    const { packages } = await listPackages({ ...env, ECOSYSTEMS: "npm" }, identity("admin"));
    expect(packages.some((p) => p.name === `${v}/a`)).toBe(false);
    expect(await code(listPackages(env, identity("publish")))).toBe("forbidden");
  });
});

describe("listPackageSummaries", () => {
  it("lists every package for admin with the top version's yanked flag, reading one manifest each", async () => {
    const v = vendor();
    await seed(`${v}/b`, [
      ["1.0.0", false],
      ["1.10.0", true],
      ["1.2.0", false],
    ]);
    await seed(`${v}/a`, [["0.1.0", false]]);
    const mine = (await listPackageSummaries(env, identity("admin"))).filter((p) =>
      p.name.startsWith(`${v}/`),
    );
    expect(mine.map((p) => p.name)).toEqual([`${v}/a`, `${v}/b`]);
    expect(mine[1]?.versions).toEqual([
      { version: "1.10.0", yanked: true },
      { version: "1.2.0" },
      { version: "1.0.0" },
    ]);
  });

  it("shows a reader only the packages and versions its grants cover", async () => {
    const v = vendor();
    await seed(`${v}/sdk`, [
      ["1.0.0", false],
      ["2.0.0", true],
      ["2.1.0", false],
    ]);
    await seed(`${v}/hidden`, [["1.0.0", false]]);
    const reader = identity("read", [{ eco: "composer", package: `${v}/sdk`, versions: "^2.0" }]);
    expect(await listPackageSummaries(env, reader)).toEqual([
      {
        eco: "composer",
        name: `${v}/sdk`,
        versions: [{ version: "2.1.0", yanked: false }, { version: "2.0.0" }],
      },
    ]);
  });

  it("refuses publish credentials", async () => {
    expect(await code(listPackageSummaries(env, identity("publish")))).toBe("forbidden");
  });
});

describe("getPackage", () => {
  it("returns one package with the visible versions", async () => {
    const v = vendor();
    await seed(`${v}/sdk`, [
      ["1.0.0", false],
      ["2.0.0", true],
    ]);
    const reader = identity("read", [{ eco: "composer", package: `${v}/*`, versions: "*" }]);
    const view = await getPackage(env, reader, "composer", `${v}/sdk`);
    expect(view.eco).toBe("composer");
    expect(view.versions.map((x) => x.version)).toEqual(["2.0.0", "1.0.0"]);
  });

  it("answers 404 instead of revealing packages outside the grants", async () => {
    const v = vendor();
    await seed(`${v}/sdk`, [["1.0.0", false]]);
    const none = identity("read", [{ eco: "composer", package: "other/*", versions: "*" }]);
    const range = identity("read", [{ eco: "composer", package: `${v}/sdk`, versions: "^2.0" }]);
    expect(await code(getPackage(env, none, "composer", `${v}/sdk`))).toBe("not_found");
    expect(await code(getPackage(env, range, "composer", `${v}/sdk`))).toBe("not_found");
    expect(await code(getPackage(env, identity("admin"), "composer", `${v}/missing`))).toBe(
      "not_found",
    );
    expect(await code(getPackage(env, identity("admin"), "pypi", `${v}/sdk`))).toBe("not_found");
    expect(await code(getPackage(env, identity("publish"), "composer", `${v}/sdk`))).toBe(
      "forbidden",
    );
  });
});

describe("dependencies of read entries", () => {
  /** `a` 1.0.0 and 2.0.0 depend on `b` and `c`; `b` 1.4.0 depends on `c`. */
  async function graph(): Promise<string> {
    const v = vendor();
    await seed(`${v}/a`, [
      ["1.0.0", false, { php: "^8.1", [`${v}/b`]: "^1.1", [`${v}/c`]: "~0.1" }],
      ["2.0.0", false, { [`${v}/b`]: "^1.4", "other/lib": "^1.0" }],
    ]);
    await seed(`${v}/b`, [
      ["1.0.0", false],
      ["1.1.0", false],
      ["1.4.0", true, { [`${v}/c`]: "^0.1.2" }],
      ["2.0.0", false],
    ]);
    await seed(`${v}/c`, [
      ["0.1.0", false],
      ["0.1.5", false],
    ]);
    return v;
  }

  it("lists what each grant opens, flattened, sorted, highest version first", async () => {
    const v = await graph();
    const reader = identity("read", [{ eco: "composer", package: `${v}/a`, versions: "*" }]);
    const { packages } = await listPackages(env, reader);
    const mine = packages.filter((p) => p.name.startsWith(`${v}/`));
    expect(mine.map((p) => p.name)).toEqual([`${v}/a`]);
    expect(mine[0]?.dependencies).toEqual([
      { name: `${v}/b`, constraints: ["^1.4", "^1.1"], versions: ["1.4.0", "1.1.0"] },
      { name: `${v}/c`, constraints: ["^0.1.2", "~0.1"], versions: ["0.1.5", "0.1.0"] },
    ]);
    expect((await getPackage(env, reader, "composer", `${v}/a`)).dependencies).toEqual(
      mine[0]?.dependencies,
    );
    expect(await code(getPackage(env, reader, "composer", `${v}/b`))).toBe("not_found");
  });

  it("follows only the versions the transitive grant covers", async () => {
    const v = await graph();
    const reader = identity("read", [{ eco: "composer", package: `${v}/a`, versions: "^2.0" }]);
    const view = await getPackage(env, reader, "composer", `${v}/a`);
    expect(view.dependencies).toEqual([
      { name: `${v}/b`, constraints: ["^1.4"], versions: ["1.4.0"] },
      { name: `${v}/c`, constraints: ["^0.1.2"], versions: ["0.1.5"] },
    ]);
  });

  it("keeps explicitly granted packages in other entries' dependencies", async () => {
    const v = await graph();
    const reader = identity("read", [
      { eco: "composer", package: `${v}/a`, versions: "^2.0" },
      { eco: "composer", package: `${v}/b`, versions: "^2.0" },
    ]);
    const { packages } = await listPackages(env, reader);
    const mine = packages.filter((p) => p.name.startsWith(`${v}/`));
    expect(mine.map((p) => [p.name, p.versions.map((x) => x.version), p.dependencies])).toEqual([
      [
        `${v}/a`,
        ["2.0.0"],
        [
          { name: `${v}/b`, constraints: ["^1.4"], versions: ["1.4.0"] },
          { name: `${v}/c`, constraints: ["^0.1.2"], versions: ["0.1.5"] },
        ],
      ],
      [`${v}/b`, ["2.0.0"], []],
    ]);
  });

  it("lists no dependencies for a grant with transitive false", async () => {
    const v = await graph();
    const reader = identity("read", [
      { eco: "composer", package: `${v}/a`, versions: "*", transitive: false },
      { eco: "composer", package: `${v}/b`, versions: "*" },
    ]);
    const { packages } = await listPackages(env, reader);
    const mine = packages.filter((p) => p.name.startsWith(`${v}/`));
    expect(mine.map((p) => [p.name, p.dependencies])).toEqual([
      [`${v}/a`, []],
      [`${v}/b`, [{ name: `${v}/c`, constraints: ["^0.1.2"], versions: ["0.1.5"] }]],
    ]);
  });

  it("has no dependencies field for admin", async () => {
    const v = await graph();
    const view = await getPackage(env, identity("admin"), "composer", `${v}/a`);
    expect(view).not.toHaveProperty("dependencies");
    const { packages } = await listPackages(env, identity("admin"));
    expect(packages.some((p) => "dependencies" in p)).toBe(false);
  });

  it("lists what any version depends on for the admin's package page", async () => {
    const v = await graph();
    expect(await allDependencies(env, composerAdapter, `${v}/a`)).toEqual([
      { name: `${v}/b`, constraints: ["^1.4", "^1.1"], versions: ["1.4.0", "1.1.0"] },
      { name: `${v}/c`, constraints: ["^0.1.2", "~0.1"], versions: ["0.1.5", "0.1.0"] },
    ]);
    expect(await allDependencies(env, composerAdapter, `${v}/c`)).toEqual([]);
    expect(await allDependencies(env, composerAdapter, `${v}/missing`)).toEqual([]);
  });
});

describe("case-insensitive names (nuget, swift)", () => {
  const sha = "a".repeat(64);

  /** Publishes NuGet versions of one id, each with the casing it was published with. */
  async function seedNuGet(versions: [id: string, version: string][]): Promise<void> {
    for (const [id, version] of versions) {
      const file = `${id.toLowerCase()}.${version.toLowerCase()}.nupkg`;
      const parsed = nugetAdapter.parseManifest({
        eco: "nuget",
        name: id,
        version,
        files: [{ name: file, size: 3, sha256: sha, role: "archive" }],
        manifest: { id, version, nuspec: "<package/>", dependencyGroups: [] },
      });
      const m = { ...parsed, published: "2026-10-01T00:00:00Z", publishedBy: "ci" };
      await writeManifest(env, m);
      await addPackageToMeta(env, "nuget", m.name, {
        versions: versions.length,
        updated: m.published,
      });
    }
  }

  it("lists nuget and swift packages with the casing of the highest version", async () => {
    const v = vendor();
    await seedNuGet([
      [`Acme.${v}`, "1.0.0"],
      [`ACME.${v.toUpperCase()}`, "2.0.0"],
    ]);
    const parsed = swiftAdapter.parseManifest({
      eco: "swift",
      name: `acme.Net${v}`,
      version: "1.0.0",
      files: [
        { name: `Net${v}-1.0.0.zip`, size: 3, sha256: sha, role: "archive" },
        { name: "Package.swift", size: 3, sha256: sha, role: "manifest" },
      ],
      manifest: { toolsVersion: "5.9", dumpPackage: { name: `Net${v}`, dependencies: [] } },
    });
    await writeManifest(env, { ...parsed, published: "2026-10-01T00:00:00Z", publishedBy: "ci" });
    await addPackageToMeta(env, "swift", parsed.name, {
      versions: 1,
      updated: "2026-10-01T00:00:00Z",
    });

    const { packages } = await listPackages(env, identity("admin"));
    const names = packages
      .filter((p) => p.name.toLowerCase().includes(v))
      .map((p) => [p.eco, p.name]);
    expect(names).toEqual([
      ["nuget", `ACME.${v.toUpperCase()}`],
      ["swift", `acme.Net${v}`],
    ]);
    const swift = await getPackage(env, identity("admin"), "swift", `ACME.net${v.toUpperCase()}`);
    expect(swift.name).toBe(`acme.Net${v}`);
    // The highest version the caller may see decides.
    const older = identity("read", [{ eco: "nuget", package: "acme.*", versions: "[1.0,2.0)" }]);
    expect((await getPackage(env, older, "nuget", `acme.${v}`)).name).toBe(`Acme.${v}`);
  });

  it("matches nuget and swift names in paths case-insensitively", async () => {
    const v = vendor();
    await seedNuGet([[`Acme.${v}`, "1.2.0"]]);
    const admin = identity("admin");
    const view = await getPackage(env, admin, "nuget", `ACME.${v.toUpperCase()}`);
    expect(view.name).toBe(`Acme.${v}`);
    expect(view.versions.map((x) => x.version)).toEqual(["1.2.0"]);
    const reader = identity("read", [{ eco: "nuget", package: "Acme.*", versions: "*" }]);
    expect((await getPackage(env, reader, "nuget", `Acme.${v}`)).name).toBe(`Acme.${v}`);
  });

  it("normalises nuget names and versions in the administration endpoints", async () => {
    const v = vendor();
    await seedNuGet([
      [`Acme.${v}`, "1.2.0"],
      [`Acme.${v}`, "1.3.0"],
    ]);
    const url = "https://packages.example.com";
    const now = new Date("2026-10-02T00:00:00Z");
    const yanked = await yank(env, "nuget", `ACME.${v}`, "01.2", now, url);
    expect([yanked.name, yanked.version, yanked.yanked]).toEqual([`acme.${v}`, "1.2.0", true]);
    expect((await reindex(env, "nuget", `Acme.${v}`, now, url)).manifests).toBe(2);
    const deleted = await deleteVersion(env, "nuget", `Acme.${v}`, "1.3.0.0", now, url);
    expect([deleted.name, deleted.version]).toEqual([`acme.${v}`, "1.3.0"]);
  });
});
