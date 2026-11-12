import { describe, expect, it } from "vitest";
import { nugetAdapter as adapter, nugetIndexKey } from "../../src/adapters/nuget/index";
import {
  RawIndexBody,
  type IndexRoute,
  type ListingContext,
  type ListingRoute,
  type Manifest,
  type NativeRoute,
  type PublishInit,
} from "../../src/adapters/types";
import { ValidationError } from "../../src/core/errors";
import { SAMPLE_NUSPEC, metadataFromNuspec, nuspecFor } from "../fixtures/nuget/nuspec";

const BASE = "https://packages.example.com";
const SHA = "a".repeat(64);
const REG = `${BASE}/nuget/registration/acme.sdk/index.json`;

function init(overrides: Partial<PublishInit> = {}): PublishInit {
  return {
    eco: "nuget",
    name: "Acme.Sdk",
    version: "1.2.0",
    files: [
      { name: "acme.sdk.1.2.0.nupkg", size: 2048, sha256: SHA, role: "archive" },
      { name: "acme.sdk.1.2.0.snupkg", size: 512, sha256: SHA, role: "symbols" },
    ],
    manifest: metadataFromNuspec(SAMPLE_NUSPEC),
    ...overrides,
  };
}

/** A stored manifest as `commit` writes it. */
function stored(version: string, options: { yanked?: boolean; id?: string } = {}): Manifest {
  const id = options.id ?? "Acme.Sdk";
  const m = adapter.parseManifest(
    init({
      name: id,
      version,
      files: [{ name: `${id.toLowerCase()}.${version}.nupkg`, size: 1, sha256: SHA }],
      manifest: metadataFromNuspec(nuspecFor(id, version)),
    }),
  );
  return {
    ...m,
    published: "2026-10-28T10:12:00Z",
    publishedBy: "ci",
    yanked: options.yanked ?? false,
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

function get(path: string, method = "GET"): NativeRoute | null {
  const url = new URL(`${BASE}${path}`);
  return adapter.route(new Request(url, { method }), url);
}

function indexes(manifests: Manifest[]): Record<string, unknown> {
  const files = adapter.buildIndex("acme.sdk", manifests, { publicUrl: BASE });
  return Object.fromEntries(files.map((f) => [f.key, JSON.parse(f.body) as unknown]));
}

type Allowed = (name: string, version: string) => boolean;

const all: Allowed = () => true;

describe("parseManifest", () => {
  it("accepts the metadata of a real .nuspec", () => {
    const m = adapter.parseManifest(init());
    expect(m).toEqual({
      eco: "nuget",
      name: "acme.sdk",
      version: "1.2.0",
      files: [
        { name: "acme.sdk.1.2.0.nupkg", size: 2048, sha256: SHA, role: "archive" },
        { name: "acme.sdk.1.2.0.snupkg", size: 512, sha256: SHA, role: "symbols" },
      ],
      published: "",
      publishedBy: "",
      yanked: false,
      native: {
        id: "Acme.Sdk",
        version: "1.2.0",
        nuspec: SAMPLE_NUSPEC,
        description: "Acme SDK for .NET",
        authors: "Acme",
        projectUrl: "https://github.com/acme/sdk-dotnet",
        licenseExpression: "MIT",
        tags: ["acme", "sdk"],
        dependencyGroups: [
          {
            targetFramework: "net8.0",
            dependencies: [
              { id: "Acme.Core", range: "[1.0.0, 2.0.0)" },
              { id: "Newtonsoft.Json", range: "13.0.1" },
            ],
          },
          {
            targetFramework: ".NETStandard2.0",
            dependencies: [
              { id: "Acme.Core", range: "1.4.0" },
              { id: "System.Text.Json", range: "8.0.5" },
            ],
          },
          { targetFramework: null, dependencies: [] },
        ],
      },
    });
  });

  it("normalises the version and accepts the file named as sent or normalised", () => {
    const manifest = { ...metadataFromNuspec(SAMPLE_NUSPEC), version: "01.2.0.0-Beta+abc" };
    const asSent = adapter.parseManifest(
      init({
        version: "01.2.0.0-Beta+abc",
        manifest,
        files: [{ name: "acme.sdk.01.2.0.0-beta.nupkg", size: 1, sha256: SHA }],
      }),
    );
    expect(asSent.version).toBe("1.2.0-beta");
    expect(asSent.files).toEqual([
      { name: "acme.sdk.01.2.0.0-beta.nupkg", size: 1, sha256: SHA, role: "archive" },
    ]);
    const normalised = adapter.parseManifest(
      init({
        version: "01.2.0.0-Beta+abc",
        manifest,
        files: [{ name: "acme.sdk.1.2.0-beta.nupkg", size: 1, sha256: SHA, role: "archive" }],
      }),
    );
    expect(normalised.version).toBe("1.2.0-beta");
  });

  it("checks the id and version against the metadata", () => {
    rejects(() => adapter.parseManifest(init({ name: "Acme Sdk" })));
    rejects(() => adapter.parseManifest(init({ name: "x".repeat(101) })));
    rejects(() => adapter.parseManifest(init({ name: "acme.sdk" })));
    rejects(() => adapter.parseManifest(init({ version: "1.2" })));
    rejects(() => adapter.parseManifest(init({ version: "1.2.0.0.0" })));
    rejects(() => adapter.parseManifest(init({ tag: "latest" })));
  });

  it("requires the .nuspec and the dependency groups", () => {
    const meta = metadataFromNuspec(SAMPLE_NUSPEC);
    rejects(() => adapter.parseManifest(init({ manifest: { ...meta, nuspec: "" } })));
    rejects(() => adapter.parseManifest(init({ manifest: { ...meta, dependencyGroups: {} } })));
    rejects(() =>
      adapter.parseManifest(
        init({ manifest: { ...meta, dependencyGroups: [{ dependencies: [{ id: "A" }] }] } }),
      ),
    );
    rejects(() =>
      adapter.parseManifest(
        init({
          manifest: { ...meta, dependencyGroups: [{ targetFramework: 8, dependencies: [] }] },
        }),
      ),
    );
    rejects(() => adapter.parseManifest(init({ manifest: { ...meta, tags: "acme sdk" } })));
    rejects(() => adapter.parseManifest(init({ manifest: { ...meta, authors: ["Acme"] } })));
  });

  it("accepts minimal metadata", () => {
    const m = adapter.parseManifest(
      init({
        manifest: { id: "Acme.Sdk", version: "1.2.0", nuspec: "<package/>", dependencyGroups: [] },
      }),
    );
    expect(m.native).toEqual({
      id: "Acme.Sdk",
      version: "1.2.0",
      nuspec: "<package/>",
      dependencyGroups: [],
    });
  });

  it("requires one lower-case .nupkg and at most one matching .snupkg", () => {
    const nupkg = { name: "acme.sdk.1.2.0.nupkg", size: 1, sha256: SHA };
    const snupkg = { name: "acme.sdk.1.2.0.snupkg", size: 1, sha256: SHA, role: "symbols" };
    rejects(() =>
      adapter.parseManifest(init({ files: [{ ...nupkg, name: "Acme.Sdk.1.2.0.nupkg" }] })),
    );
    rejects(() =>
      adapter.parseManifest(init({ files: [{ ...nupkg, name: "acme.sdk.1.3.0.nupkg" }] })),
    );
    rejects(() =>
      adapter.parseManifest(init({ files: [{ ...nupkg, name: "acme.sdk.1.2.0.zip" }] })),
    );
    rejects(() => adapter.parseManifest(init({ files: [nupkg, snupkg] })));
    rejects(() =>
      adapter.parseManifest(
        init({
          files: [
            { ...nupkg, role: "archive" },
            { ...snupkg, name: "other.snupkg" },
          ],
        }),
      ),
    );
    rejects(() =>
      adapter.parseManifest(
        init({
          files: [
            { ...nupkg, role: "archive" },
            { ...snupkg, role: "archive" },
          ],
        }),
      ),
    );
    rejects(() => adapter.parseManifest(init({ files: [{ ...snupkg }] })));
  });
});

describe("versions, ranges and dependencies", () => {
  it("uses NuGet versions and ranges", () => {
    expect(adapter.validateVersion("1.2.3.4")).toBe(true);
    expect(adapter.validateVersion("1.2.3-beta+abc")).toBe(true);
    expect(adapter.compareVersions("1.2", "1.2.0")).toBe(0);
    expect(adapter.satisfies("1.5.0", "[1.0,2.0)")).toBe(true);
    expect(adapter.satisfies("2.0.0", "[1.0,2.0)")).toBe(false);
    expect(adapter.validateRange("1.*")).toBe(true);
    expect(adapter.validateRange("^1.0")).toBe(false);
  });

  it("lists every dependency of every group", () => {
    expect(adapter.dependencies(adapter.parseManifest(init()))).toEqual([
      { name: "Acme.Core", constraint: "[1.0.0, 2.0.0)" },
      { name: "Newtonsoft.Json", constraint: "13.0.1" },
      { name: "Acme.Core", constraint: "1.4.0" },
      { name: "System.Text.Json", constraint: "8.0.5" },
    ]);
  });
});

describe("keys and URLs", () => {
  it("stores files under the lower-case id and the normalised version", () => {
    const m = adapter.parseManifest(init());
    const [nupkg, snupkg] = m.files;
    if (nupkg === undefined || snupkg === undefined) throw new Error("files missing");
    expect(adapter.fileKey(m, nupkg)).toBe("nuget/pkg/acme.sdk/1.2.0/acme.sdk.1.2.0.nupkg");
    const url = `${BASE}/nuget/flat/acme.sdk/1.2.0/acme.sdk.1.2.0.nupkg`;
    expect(adapter.fileUrl(m, nupkg, BASE)).toBe(url);
    expect(adapter.fileUrl(m, snupkg, BASE)).toBeNull();
    expect(adapter.versionUrl(m, BASE)).toBe(url);
    expect(nugetIndexKey("Acme.Sdk", "flat.json")).toBe("nuget/index/acme.sdk/flat.json");
  });
});

describe("buildIndex", () => {
  const manifests = [stored("2.0.0"), stored("1.0.0", { yanked: true }), stored("1.2.0-beta.1")];

  it("writes the flat index, the registration and the .nuspec files", () => {
    const files = adapter.buildIndex("acme.sdk", manifests, { publicUrl: BASE });
    expect(files.map((f) => [f.key, f.contentType])).toEqual([
      ["nuget/index/acme.sdk/flat.json", "application/json"],
      ["nuget/index/acme.sdk/registration.json", "application/json"],
      ["nuget/index/acme.sdk/nuspec.json", "application/json"],
    ]);
    const built = indexes(manifests);
    expect(built["nuget/index/acme.sdk/flat.json"]).toEqual({
      name: "acme.sdk",
      versions: ["1.0.0", "1.2.0-beta.1", "2.0.0"],
    });
    expect(built["nuget/index/acme.sdk/nuspec.json"]).toEqual({
      name: "acme.sdk",
      nuspecs: {
        "1.0.0": nuspecFor("Acme.Sdk", "1.0.0"),
        "1.2.0-beta.1": nuspecFor("Acme.Sdk", "1.2.0-beta.1"),
        "2.0.0": nuspecFor("Acme.Sdk", "2.0.0"),
      },
    });
  });

  it("builds one inlined registration page with catalog entries", () => {
    const registration = indexes(manifests)["nuget/index/acme.sdk/registration.json"] as {
      count: number;
      items: { "@id": string; lower: string; upper: string; count: number; items: unknown[] }[];
    };
    expect(registration.count).toBe(1);
    expect(registration.items[0]).toMatchObject({
      "@id": `${REG}#page/1.0.0/2.0.0`,
      count: 3,
      lower: "1.0.0",
      upper: "2.0.0",
    });
    expect(registration.items[0]?.items[0]).toEqual({
      "@id": `${REG}#1.0.0`,
      packageContent: `${BASE}/nuget/flat/acme.sdk/1.0.0/acme.sdk.1.0.0.nupkg`,
      catalogEntry: {
        "@id": `${REG}#1.0.0`,
        id: "Acme.Sdk",
        version: "1.0.0",
        listed: false,
        published: "2026-10-28T10:12:00Z",
        packageContent: `${BASE}/nuget/flat/acme.sdk/1.0.0/acme.sdk.1.0.0.nupkg`,
        dependencyGroups: [
          {
            targetFramework: "net8.0",
            dependencies: [
              { id: "Acme.Core", range: "[1.0.0, 2.0.0)" },
              { id: "Newtonsoft.Json", range: "13.0.1" },
            ],
          },
          {
            targetFramework: ".NETStandard2.0",
            dependencies: [
              { id: "Acme.Core", range: "1.4.0" },
              { id: "System.Text.Json", range: "8.0.5" },
            ],
          },
          { dependencies: [] },
        ],
        description: "Acme SDK for .NET",
        authors: "Acme",
        tags: ["acme", "sdk"],
      },
    });
  });
});

describe("filterIndex", () => {
  const built = indexes([stored("1.0.0"), stored("1.2.0-beta.1"), stored("2.0.0")]);
  const flat = built["nuget/index/acme.sdk/flat.json"];
  const registration = built["nuget/index/acme.sdk/registration.json"];
  const nuspecs = built["nuget/index/acme.sdk/nuspec.json"];
  const below2 = (name: string, version: string) => name === "acme.sdk" && version < "2";

  it("filters the flat index", () => {
    expect(adapter.filterIndex(flat, all)).toEqual({
      versions: ["1.0.0", "1.2.0-beta.1", "2.0.0"],
    });
    expect(adapter.filterIndex(flat, below2)).toEqual({ versions: ["1.0.0", "1.2.0-beta.1"] });
    rejects(() => adapter.filterIndex(flat, () => false), "not_found");
  });

  it("filters the registration and recomputes the page", () => {
    const filtered = adapter.filterIndex(registration, below2) as {
      count: number;
      items: { "@id": string; count: number; lower: string; upper: string; items: unknown[] }[];
    };
    expect(filtered.count).toBe(1);
    expect(filtered.items[0]).toMatchObject({
      "@id": `${REG}#page/1.0.0/1.2.0-beta.1`,
      count: 2,
      lower: "1.0.0",
      upper: "1.2.0-beta.1",
    });
    expect(filtered.items[0]?.items).toHaveLength(2);
    rejects(() => adapter.filterIndex(registration, () => false), "not_found");
  });

  it("serves one .nuspec verbatim", () => {
    const nuspecOf = (version: string): IndexRoute => ({
      kind: "index",
      key: "nuget/index/acme.sdk/nuspec.json",
      name: "acme.sdk",
      selector: { version },
    });
    const body = adapter.filterIndex(nuspecs, all, nuspecOf("1.0.0"));
    expect(body).toBeInstanceOf(RawIndexBody);
    expect((body as RawIndexBody).body).toBe(nuspecFor("Acme.Sdk", "1.0.0"));
    expect((body as RawIndexBody).contentType).toBe("application/xml; charset=utf-8");
    rejects(() => adapter.filterIndex(nuspecs, below2, nuspecOf("2.0.0")), "not_found");
    rejects(() => adapter.filterIndex(nuspecs, all, nuspecOf("9.0.0")), "not_found");
    rejects(() => adapter.filterIndex(nuspecs, all), "not_found");
  });

  it("refuses malformed bodies", () => {
    rejects(() => adapter.filterIndex("x", all), "internal_error");
    rejects(() => adapter.filterIndex({ name: "x" }, all), "internal_error");
  });
});

describe("route", () => {
  it("routes the service index and the search", () => {
    expect(get("/nuget/index.json")).toEqual({ kind: "listing", listing: "service" });
    expect(get("/nuget/search?q=Acme&skip=1&take=5&prerelease=true&semVerLevel=2.0.0")).toEqual({
      kind: "listing",
      listing: "search",
      options: { q: "Acme", skip: 1, take: 5, prerelease: true },
    });
    expect(get("/nuget/search")).toEqual({
      kind: "listing",
      listing: "search",
      options: { q: "", skip: 0, take: 20, prerelease: false },
    });
  });

  it("rejects invalid search parameters", () => {
    rejects(() => get("/nuget/search?take=x"));
    rejects(() => get("/nuget/search?skip=-1"));
    rejects(() => get("/nuget/search?prerelease=yes"));
  });

  it("routes the flat container and the registration case-insensitively", () => {
    expect(get("/nuget/flat/Acme.Sdk/index.json")).toEqual({
      kind: "index",
      key: "nuget/index/acme.sdk/flat.json",
      name: "acme.sdk",
    });
    expect(get("/nuget/registration/ACME.SDK/index.json")).toEqual({
      kind: "index",
      key: "nuget/index/acme.sdk/registration.json",
      name: "acme.sdk",
    });
    expect(get("/nuget/flat/acme.sdk/1.2.0/acme.sdk.1.2.0.nupkg")).toEqual({
      kind: "archive",
      name: "acme.sdk",
      version: "1.2.0",
      file: null,
    });
    expect(get("/nuget/flat/acme.sdk/1.2.0.0-Beta/Acme.Sdk.1.2.0.0-Beta.nupkg")).toMatchObject({
      kind: "archive",
      version: "1.2.0-beta",
    });
    expect(get("/nuget/flat/acme.sdk/1.2.0/acme.sdk.nuspec")).toEqual({
      kind: "index",
      key: "nuget/index/acme.sdk/nuspec.json",
      name: "acme.sdk",
      selector: { version: "1.2.0" },
    });
  });

  it("does not route other paths or methods", () => {
    for (const path of [
      "/nuget",
      "/nuget/",
      "/nuget/flat/acme.sdk",
      "/nuget/flat/acme.sdk/1.2.0/acme.sdk.1.3.0.nupkg",
      "/nuget/flat/acme.sdk/1.2.0/other.1.2.0.nupkg",
      "/nuget/flat/acme.sdk/x/acme.sdk.x.nupkg",
      "/nuget/flat/acme%20sdk/index.json",
      "/nuget/registration/acme.sdk/page.json",
      "/nuget/flat/acme.sdk/1.2.0/acme.sdk.1.2.0.snupkg",
    ]) {
      expect(get(path)).toBeNull();
    }
    expect(get("/nuget/index.json", "POST")).toBeNull();
    expect(get("/nuget/index.json", "HEAD")).toBeNull();
  });
});

describe("buildListing", () => {
  const built: Record<string, unknown> = {
    ...indexes([stored("1.0.0", { yanked: true }), stored("1.2.0"), stored("1.3.0-beta.1")]),
    ...Object.fromEntries(
      adapter
        .buildIndex("acme.core", [stored("0.1.0-alpha", { id: "Acme.Core" })], { publicUrl: BASE })
        .map((f) => [f.key, JSON.parse(f.body) as unknown]),
    ),
  };

  function ctx(route: ListingRoute, allowed = all): ListingContext {
    return {
      publicUrl: BASE,
      route,
      allowed,
      readIndex: (key) => Promise.resolve(built[key] ?? null),
    };
  }

  const search = (options: ListingRoute["options"], allowed = all) =>
    adapter.buildListing?.(
      ["acme.core", "acme.sdk", "acme.missing"],
      ctx({ kind: "listing", listing: "search", options }, allowed),
    );

  it("answers the service index", () => {
    expect(adapter.buildListing?.([], ctx({ kind: "listing", listing: "service" }))).toEqual({
      version: "3.0.0",
      resources: [
        { "@id": `${BASE}/nuget/flat/`, "@type": "PackageBaseAddress/3.0.0" },
        { "@id": `${BASE}/nuget/registration/`, "@type": "RegistrationsBaseUrl/3.6.0" },
        { "@id": `${BASE}/nuget/search`, "@type": "SearchQueryService/3.5.0" },
      ],
    });
  });

  it("searches listed stable versions by default", async () => {
    expect(await search({ q: "SDK", skip: 0, take: 20, prerelease: false })).toEqual({
      totalHits: 1,
      data: [
        {
          "@id": REG,
          id: "Acme.Sdk",
          version: "1.2.0",
          description: "Acme SDK for .NET",
          authors: "Acme",
          tags: ["acme", "sdk"],
          registration: REG,
          totalDownloads: 0,
          versions: [{ version: "1.2.0", downloads: 0, "@id": `${REG}#1.2.0` }],
        },
      ],
    });
  });

  it("considers prereleases on request and pages the results", async () => {
    const body = (await search({ q: "", skip: 0, take: 20, prerelease: true })) as {
      totalHits: number;
      data: { id: string; version: string; versions: { version: string }[] }[];
    };
    expect(body.totalHits).toBe(2);
    expect(body.data.map((d) => [d.id, d.version])).toEqual([
      ["Acme.Core", "0.1.0-alpha"],
      ["Acme.Sdk", "1.3.0-beta.1"],
    ]);
    expect(body.data[1]?.versions.map((v) => v.version)).toEqual(["1.2.0", "1.3.0-beta.1"]);
    const page = (await search({ q: "", skip: 1, take: 1, prerelease: true })) as {
      totalHits: number;
      data: { id: string }[];
    };
    expect(page.totalHits).toBe(2);
    expect(page.data.map((d) => d.id)).toEqual(["Acme.Sdk"]);
  });

  it("leaves out versions the caller may not see", async () => {
    const body = await search(
      { q: "", skip: 0, take: 20, prerelease: true },
      (name, version) => name === "acme.sdk" && version === "1.0.0",
    );
    expect(body).toEqual({ totalHits: 0, data: [] });
  });
});

describe("clientConfig", () => {
  it("shows the dotnet command and nuget.config with the token's two halves", () => {
    const snippets = adapter.clientConfig(`${BASE}/`, "shop-app:s3cr&t", ["acme.sdk"]);
    expect(snippets.map((s) => s.filename)).toEqual([
      "terminal",
      "nuget.config",
      "nuget.config",
      "terminal",
      "terminal",
    ]);
    expect(snippets[2]?.body).toContain('<add key="ClearTextPassword" value="%REGISTRY_TOKEN%" />');
    expect(snippets[3]?.body).toContain('-u shop-app -p "$REGISTRY_TOKEN"');
    expect(snippets[0]?.body).toBe(
      `dotnet nuget add source ${BASE}/nuget/index.json -n sreg -u shop-app -p s3cr&t ` +
        "--store-password-in-clear-text\n",
    );
    expect(snippets[1]?.body).toContain(`<add key="sreg" value="${BASE}/nuget/index.json"`);
    expect(snippets[1]?.body).toContain('<add key="Username" value="shop-app" />');
    expect(snippets[1]?.body).toContain('<add key="ClearTextPassword" value="s3cr&amp;t" />');
    expect(snippets[4]?.body).toBe("dotnet add package acme.sdk\n");
    expect(adapter.clientConfig(BASE, "p:x", [])).toHaveLength(4);
  });
});

describe("archive SHA-512", () => {
  const path = "/nuget/flat/Acme.Sdk/1.2.0.0-Beta/Acme.Sdk.1.2.0.0-Beta.nupkg.sha512";

  it("routes checksums with the same id and version normalization as downloads", () => {
    expect(get(path)).toEqual({
      kind: "index",
      key: nugetIndexKey("acme.sdk", "flat.json"),
      name: "acme.sdk",
      view: "sha512",
      selector: { version: "1.2.0-beta" },
    });
    expect(get(path, "POST")).toBeNull();
    expect(get(path.replace("Acme.Sdk.1.2.0.0-Beta.nupkg", "other.nupkg"))).toBeNull();
    expect(get(path.replace("nupkg.sha512", "snupkg.sha512"))).toBeNull();
  });

  it("serves the archive hash as base64, including yanked versions, without leaking hashes in lists", () => {
    expect(adapter.digests).toEqual(["sha512"]);
    const m = stored("1.2.0-beta", { yanked: true });
    const archive = m.files[0];
    if (archive === undefined) throw new Error("Archive missing");
    archive.digests = { sha512: "ab".repeat(64) };
    const flat = indexes([m])[nugetIndexKey("acme.sdk", "flat.json")];
    const route = get(path) as IndexRoute;
    const response = adapter.filterIndex(flat, all, route) as RawIndexBody;
    expect(response.body).toBe(btoa("\xab".repeat(64)));
    expect(response.contentType).toBe("text/plain; charset=utf-8");
    expect(adapter.filterIndex(flat, all)).toEqual({ versions: ["1.2.0-beta"] });
    rejects(() => adapter.filterIndex(flat, () => false, route), "not_found");
    rejects(
      () => adapter.filterIndex(flat, all, { ...route, selector: { version: "9.0.0" } }),
      "not_found",
    );
  });

  it("returns not found for old indexes or missing and malformed digests", () => {
    const route = get(path) as IndexRoute;
    const flat = { name: "acme.sdk", versions: ["1.2.0-beta"] };
    rejects(() => adapter.filterIndex(flat, all, route), "not_found");
    for (const hash of [null, "", "a".repeat(64), "z".repeat(128)]) {
      rejects(
        () => adapter.filterIndex({ ...flat, sha512: { "1.2.0-beta": hash } }, all, route),
        "not_found",
      );
    }
  });
});
