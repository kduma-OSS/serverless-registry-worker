import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../../src/adapters/index";
import type { Eco, Snippet } from "../../src/adapters/types";
import { publicNameWarnings } from "../../src/core/publicNames";

const BASE = "https://packages.example.com";
const TOKEN = "shop:secret";

function config(eco: Eco, packages: string[]): Snippet[] {
  return ADAPTERS[eco].clientConfig(BASE, TOKEN, packages);
}

function bodies(snippets: Snippet[], filename: string): string[] {
  return snippets.filter((s) => s.filename === filename).map((s) => s.body);
}

describe("client configuration pins private names to the registry", () => {
  it("composer: every repository entry is canonical", () => {
    const snippets = config("composer", ["acme/sdk"]);
    const jsons = bodies(snippets, "composer.json");
    expect(jsons).toHaveLength(4);
    for (const body of jsons) {
      const [repo] = (JSON.parse(body) as { repositories: Record<string, unknown>[] }).repositories;
      expect(repo?.canonical).toBe(true);
    }
    expect(snippets[0]?.body).toContain('"canonical":true');
  });

  it("npm: only scoped registries are set, never the unscoped one", () => {
    for (const s of config("npm", ["@acme/sdk", "@other/x"])) {
      expect(s.body).not.toMatch(/(^|\s)registry[= ]/m);
    }
    expect(bodies(config("npm", ["@acme/sdk"]), ".npmrc")[0]).toContain("@acme:registry=");
  });

  it("cargo: dependencies name the registry", () => {
    const toml = bodies(config("cargo", ["acme-core"]), "Cargo.toml")[0];
    expect(toml).toContain('registry = "sreg"');
  });

  it("nuget: packageSourceMapping pins the granted IDs and keeps nuget.org for the rest", () => {
    for (const body of bodies(config("nuget", ["Acme.Sdk"]), "nuget.config")) {
      expect(body).toContain('<packageSource key="sreg">');
      expect(body).toContain('<package pattern="Acme.Sdk" />');
      expect(body).toContain('<packageSource key="nuget.org">');
      expect(body).toContain('<package pattern="*" />');
    }
  });

  it("gradle: the repository is exclusive for the granted groups", () => {
    const snippets = config("maven", ["com.acme:sdk", "org.example:lib"]);
    for (const body of bodies(snippets, "build.gradle.kts")) {
      expect(body).toContain("exclusiveContent");
      expect(body).toContain('includeGroup("com.acme")');
      expect(body).toContain('includeGroup("org.example")');
    }
  });

  it("swift: every granted scope is mapped to the registry", () => {
    const snippets = config("swift", ["acme.networking", "other.tools"]);
    const body = snippets[0]?.body ?? "";
    expect(body).toContain(`set ${BASE}/swift --scope acme`);
    expect(body).toContain(`set ${BASE}/swift --scope other`);
  });
});

describe("publicNameWarnings", () => {
  it("warns about unscoped npm names and always about cargo crates", () => {
    expect(publicNameWarnings("npm", "left-pad")).toHaveLength(1);
    expect(publicNameWarnings("npm", "@acme/sdk")).toEqual([]);
    expect(publicNameWarnings("cargo", "acme-core")).toHaveLength(1);
  });

  it("warns about well-known public vendors, groups and ID prefixes", () => {
    expect(publicNameWarnings("composer", "symfony/console")).toHaveLength(1);
    expect(publicNameWarnings("composer", "acme/sdk")).toEqual([]);
    expect(publicNameWarnings("maven", "org.apache.commons")).toHaveLength(1);
    expect(publicNameWarnings("maven", "com.acme")).toEqual([]);
    expect(publicNameWarnings("nuget", "Microsoft.Extensions.Foo")).toHaveLength(1);
    expect(publicNameWarnings("nuget", "Acme.Sdk")).toEqual([]);
    expect(publicNameWarnings("generic", "tools/cli")).toEqual([]);
  });
});
