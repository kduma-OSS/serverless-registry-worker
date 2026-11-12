#!/usr/bin/env node
/** Explicitly enrich old Composer manifests, then rebuild their package indexes. */
import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import console from "node:console";

export async function run(
  args,
  { env = process.env, fetcher = globalThis.fetch, log = console.log } = {},
) {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--package" || !args[1])) {
    throw new Error("Usage: node scripts/backfill-composer-shasum.mjs [--package vendor/name]");
  }
  const selected = args[1];
  if (selected !== undefined && !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(selected)) {
    throw new Error("--package must be a Composer vendor/name.");
  }
  if (!env.REGISTRY_URL || !env.REGISTRY_TOKEN) {
    throw new Error("REGISTRY_URL and REGISTRY_TOKEN are required.");
  }
  let base;
  try {
    base = new URL(env.REGISTRY_URL);
  } catch {
    throw new Error("REGISTRY_URL must be an absolute HTTP(S) URL.");
  }
  if (
    !["https:", "http:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error("REGISTRY_URL must be an HTTP(S) URL without credentials, query or fragment.");
  }
  const root = base.href.replace(/\/+$/, "");
  async function request(method, path) {
    let response;
    try {
      response = await fetcher(`${root}/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${env.REGISTRY_TOKEN}` },
        redirect: "error",
      });
    } catch {
      throw new Error("Registry request failed.");
    }
    // Never echo server bodies or transport errors: they may contain secrets or signed URLs.
    if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}.`);
    try {
      return await response.json();
    } catch {
      throw new Error("Registry returned invalid JSON.");
    }
  }
  const result = { updated: 0, skipped: 0, errors: 0 };
  const packages = selected
    ? [await request("GET", `/packages/composer/${encodeURIComponent(selected)}`)]
    : (await request("GET", "/packages")).packages.filter((p) => p.eco === "composer");
  for (const pkg of packages) {
    const path = `/packages/composer/${encodeURIComponent(pkg.name)}`;
    for (const version of pkg.versions) {
      if (version.files.every((f) => f.digests?.sha1 !== undefined)) {
        result.skipped++;
        continue;
      }
      try {
        const response = await request(
          "POST",
          `${path}/${encodeURIComponent(version.version)}/backfill-digests`,
        );
        if (response.updated) result.updated++;
        else result.skipped++;
      } catch (error) {
        result.errors++;
        log(`Failed ${pkg.name}@${version.version}: ${error.message}`);
      }
    }
    try {
      await request("POST", `${path}/reindex`);
      log(`Reindexed ${pkg.name}.`);
    } catch (error) {
      result.errors++;
      log(`Failed to reindex ${pkg.name}: ${error.message}`);
    }
  }
  log(`Updated: ${result.updated}; skipped: ${result.skipped}; errors: ${result.errors}.`);
  return result;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await run(process.argv.slice(2));
    process.exitCode = result.errors > 0 ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
