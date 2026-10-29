import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MIGRATE_LOCK_KEY,
  MIGRATIONS,
  SCHEMA_VERSION_KEY,
  ensureMigrated,
  readSchemaVersion,
  resetMigrationState,
  runMigrations,
  type Migration,
} from "../../src/core/migrate";
import {
  PACKAGES_META_KEY,
  addPackageToMeta,
  depsGraphKey,
  readDepsGraph,
  readPackagesMeta,
  writeManifest,
} from "../../src/core/storage";
import { putCredential } from "../../src/core/auth";
import { SCHEMA_VERSION } from "../../src/version";
import { legacy } from "../records";

beforeEach(async () => {
  resetMigrationState();
  await env.AUTH.delete(SCHEMA_VERSION_KEY);
  await env.AUTH.delete(MIGRATE_LOCK_KEY);
  await env.R2_BUCKET.delete(PACKAGES_META_KEY);
});

function recorder(): { migrations: Migration[]; log: number[] } {
  const log: number[] = [];
  const migrations = [3, 1, 2].map((to) => ({
    to,
    async run() {
      expect(await env.AUTH.get(MIGRATE_LOCK_KEY)).not.toBeNull();
      log.push(to);
    },
  }));
  return { migrations, log };
}

describe("readSchemaVersion", () => {
  it.each([
    [null, 0],
    ["1", 1],
    [" 7 ", 7],
    ["x", 0],
    ["-1", 0],
    ["1.5", 0],
  ])("reads %j as %j", async (stored, expected) => {
    if (stored !== null) await env.AUTH.put(SCHEMA_VERSION_KEY, stored);
    expect(await readSchemaVersion(env)).toBe(expected);
  });
});

describe("runMigrations", () => {
  it("runs the pending migrations in order and stores the version", async () => {
    await env.AUTH.put(SCHEMA_VERSION_KEY, "1");
    const { migrations, log } = recorder();

    const result = await runMigrations(env, { migrations, target: 3 });

    expect(result).toEqual({ status: "migrated", from: 1, to: 3, ran: [2, 3] });
    expect(log).toEqual([2, 3]);
    expect(await env.AUTH.get(SCHEMA_VERSION_KEY)).toBe("3");
    expect(await env.AUTH.get(MIGRATE_LOCK_KEY)).toBeNull();
  });

  it("does nothing when the data is current or newer", async () => {
    const { migrations, log } = recorder();
    await env.AUTH.put(SCHEMA_VERSION_KEY, "5");
    expect(await runMigrations(env, { migrations, target: 3 })).toEqual({
      status: "current",
      from: 5,
      to: 5,
      ran: [],
    });
    expect(log).toEqual([]);
    expect(await env.AUTH.get(SCHEMA_VERSION_KEY)).toBe("5");
  });

  it("stops at the target and records the target without a migration for it", async () => {
    const { migrations, log } = recorder();
    expect((await runMigrations(env, { migrations, target: 2 })).ran).toEqual([1, 2]);
    expect(log).toEqual([1, 2]);
    expect(await env.AUTH.get(SCHEMA_VERSION_KEY)).toBe("2");

    expect((await runMigrations(env, { migrations: [], target: 4 })).ran).toEqual([]);
    expect(await env.AUTH.get(SCHEMA_VERSION_KEY)).toBe("4");
  });

  it("skips while another run holds the lock", async () => {
    await env.AUTH.put(MIGRATE_LOCK_KEY, "someone-else", { expirationTtl: 300 });
    const { migrations, log } = recorder();
    expect((await runMigrations(env, { migrations, target: 3 })).status).toBe("locked");
    expect(log).toEqual([]);
    expect(await env.AUTH.get(MIGRATE_LOCK_KEY)).toBe("someone-else");
  });

  it("keeps the progress of a failing run and releases the lock", async () => {
    const migrations: Migration[] = [
      { to: 1, run: async () => undefined },
      {
        to: 2,
        run: async () => {
          throw new Error("boom");
        },
      },
    ];
    await expect(runMigrations(env, { migrations, target: 2 })).rejects.toThrow("boom");
    expect(await env.AUTH.get(SCHEMA_VERSION_KEY)).toBe("1");
    expect(await env.AUTH.get(MIGRATE_LOCK_KEY)).toBeNull();
  });
});

describe("migration 1", () => {
  it("creates _meta/packages.json from the manifests when missing", async () => {
    await writeManifest(env, {
      eco: "cargo",
      name: "acme-core",
      version: "1.0.0",
      files: [{ name: "acme-core-1.0.0.crate", size: 1, sha256: "0".repeat(64) }],
      published: "2026-10-28T10:12:00Z",
      publishedBy: "ci-acme",
      yanked: false,
      native: {},
    });

    expect((await runMigrations(env, { target: 1 })).ran).toEqual([1]);

    expect(await env.R2_BUCKET.head(PACKAGES_META_KEY)).not.toBeNull();
    expect(Object.keys((await readPackagesMeta(env)).cargo)).toEqual(["acme-core"]);
    expect(await env.AUTH.get(SCHEMA_VERSION_KEY)).toBe("1");
  });

  it("leaves an existing _meta/packages.json alone", async () => {
    const entry = { versions: 3, updated: "2026-10-28T10:12:00Z" };
    await addPackageToMeta(env, "npm", "@acme/sdk", entry);
    await runMigrations(env);
    expect((await readPackagesMeta(env)).npm).toEqual({ "@acme/sdk": entry });
  });
});

describe("migration 2", () => {
  it("rebuilds the gh-repo index from every credential", async () => {
    const gh = (repository: string) => ({
      type: "gh" as const,
      repository,
      ref: null,
      workflow: null,
      created: "2026-10-28T09:00:00Z",
      expires: null,
    });
    await putCredential(
      env,
      legacy({
        project: "mig-ci",
        kind: "publish",
        auth: [gh("Acme/SDK"), gh("acme/*")],
        grants: [],
      }),
    );
    await putCredential(
      env,
      legacy({
        project: "mig-read",
        kind: "read",
        auth: [gh("acme/sdk")],
        grants: [],
      }),
    );
    await env.AUTH.put("gh-repo:old/repo", JSON.stringify(["gone"]));
    await env.AUTH.put(SCHEMA_VERSION_KEY, "1");

    expect((await runMigrations(env, { target: 2 })).ran).toEqual([2]);

    expect(await env.AUTH.get("gh-repo:acme/sdk", "json")).toEqual(["mig-ci", "mig-read"]);
    expect(await env.AUTH.get("gh-repo:acme/*", "json")).toEqual(["mig-ci"]);
    expect(await env.AUTH.get("gh-repo:old/repo")).toBeNull();
    expect(await env.AUTH.get(SCHEMA_VERSION_KEY)).toBe("2");
  });
});

describe("migration 3", () => {
  it("is the current schema version", () => {
    expect(SCHEMA_VERSION).toBe(4);
    expect(MIGRATIONS.map((m) => m.to)).toEqual([1, 2, 3, 4]);
  });

  it("builds the dependency graph of every ecosystem from the manifests", async () => {
    const manifest = (
      eco: "composer" | "npm",
      name: string,
      version: string,
      native: Record<string, unknown>,
      yanked = false,
    ) =>
      writeManifest(env, {
        eco,
        name,
        version,
        files: [{ name: "a.zip", size: 1, sha256: "0".repeat(64), role: "archive" }],
        published: "2026-10-28T10:12:00Z",
        publishedBy: "ci-acme",
        yanked,
        native,
      });
    await manifest("composer", "mig/app", "1.0.0", {
      name: "mig/app",
      require: { php: "^8.1", "mig/lib": "^1.0" },
      "require-dev": { "mig/lib": "^1.2" },
    });
    await manifest("composer", "mig/lib", "1.2.0", { name: "mig/lib" }, true);
    await manifest("npm", "@mig/sdk", "2.0.0", {
      name: "@mig/sdk",
      version: "2.0.0",
      dependencies: { "@mig/core": "^1.0" },
    });
    await env.R2_BUCKET.put(depsGraphKey("composer"), JSON.stringify({ "mig/gone": {} }));
    await env.AUTH.put(SCHEMA_VERSION_KEY, "2");

    expect((await runMigrations(env, { target: 3 })).ran).toEqual([3]);

    expect(await readDepsGraph(env, "composer")).toEqual({
      "mig/app": { "1.0.0": { "mig/lib": ["^1.0", "^1.2"] } },
      "mig/lib": { "1.2.0": {} },
    });
    expect(await readDepsGraph(env, "npm")).toEqual({
      "@mig/sdk": { "2.0.0": { "@mig/core": "^1.0" } },
    });
    expect(await env.R2_BUCKET.head(depsGraphKey("generic"))).not.toBeNull();
    expect(await readDepsGraph(env, "generic")).toEqual({});
    expect(await env.AUTH.get(SCHEMA_VERSION_KEY)).toBe("3");
  });
});

describe("ensureMigrated", () => {
  it("migrates once per isolate and shares a concurrent run", async () => {
    await Promise.all([ensureMigrated(env), ensureMigrated(env)]);
    expect(await env.AUTH.get(SCHEMA_VERSION_KEY)).toBe(String(SCHEMA_VERSION));

    // Once migrated, the isolate no longer looks at KV.
    await env.AUTH.put(SCHEMA_VERSION_KEY, "0");
    await ensureMigrated(env);
    expect(await env.AUTH.get(SCHEMA_VERSION_KEY)).toBe("0");
  });

  it("tries again on the next call while another isolate holds the lock", async () => {
    await env.AUTH.put(MIGRATE_LOCK_KEY, "someone-else", { expirationTtl: 300 });
    await ensureMigrated(env);
    expect(await env.AUTH.get(SCHEMA_VERSION_KEY)).toBeNull();

    await env.AUTH.delete(MIGRATE_LOCK_KEY);
    await ensureMigrated(env);
    expect(await env.AUTH.get(SCHEMA_VERSION_KEY)).toBe(String(SCHEMA_VERSION));
  });
});

describe("migration 4", () => {
  async function stored(project: string): Promise<unknown> {
    return env.AUTH.get(`cred:${project}`, "json");
  }

  it("rewrites kind and flat grants into roles and per-role grants", async () => {
    const key = { type: "key", hash: "sha256:00", created: "2026-01-01", expires: null };
    const grants = [{ eco: "npm", package: "@acme/*", versions: "*", transitive: true }];
    await env.AUTH.put(
      "cred:m4-read",
      JSON.stringify({ project: "m4-read", kind: "read", auth: [key], grants }),
    );
    await env.AUTH.put(
      "cred:m4-pub",
      JSON.stringify({
        project: "m4-pub",
        kind: "publish",
        auth: [key],
        grants: [{ eco: "npm", package: "@acme/sdk", versions: "*" }],
      }),
    );
    await env.AUTH.put(
      "cred:m4-admin",
      JSON.stringify({ project: "m4-admin", kind: "admin", auth: [key], grants: [] }),
    );
    await env.AUTH.put(SCHEMA_VERSION_KEY, "3");

    expect((await runMigrations(env)).ran).toEqual([4]);

    expect(await stored("m4-read")).toEqual({
      project: "m4-read",
      roles: ["read"],
      auth: [key],
      grants: { read: grants, publish: [], yank: [], delete: [] },
    });
    expect(await stored("m4-pub")).toMatchObject({
      roles: ["publish"],
      grants: {
        read: [],
        publish: [{ eco: "npm", package: "@acme/sdk", versions: "*", transitive: true }],
      },
    });
    expect(await stored("m4-admin")).toMatchObject({
      roles: ["admin"],
      grants: { read: [], publish: [] },
    });
    expect(await env.AUTH.get(SCHEMA_VERSION_KEY)).toBe("4");
  });

  it("is idempotent and leaves current records alone", async () => {
    await putCredential(env, legacy({ project: "m4-twice", kind: "read", auth: [], grants: [] }));
    const before = await env.AUTH.get("cred:m4-twice");
    await env.AUTH.put(SCHEMA_VERSION_KEY, "3");
    await runMigrations(env);
    await env.AUTH.put(SCHEMA_VERSION_KEY, "3");
    await runMigrations(env);
    expect(await env.AUTH.get("cred:m4-twice")).toBe(before);
  });
});
