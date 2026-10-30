import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { stagingKey } from "../../src/core/storage";
import { metadataFromNuspec, nuspecFor } from "../fixtures/nuget/nuspec";
import { ORIGIN, call, credential, sha256Hex, type ErrorBody, type InitResult } from "./helpers";

type Groups = { targetFramework: string | null; dependencies: { id: string; range: string }[] }[];

interface Leaf {
  "@id": string;
  packageContent: string;
  catalogEntry: {
    id: string;
    version: string;
    listed: boolean;
    dependencyGroups: { targetFramework?: string; dependencies: { id: string; range: string }[] }[];
  };
}

interface Registration {
  count: number;
  items: { "@id": string; count: number; lower: string; upper: string; items: Leaf[] }[];
}

interface Search {
  totalHits: number;
  data: { id: string; version: string; versions: { version: string }[] }[];
}

const SDK_GROUPS: Groups = [
  { targetFramework: "net8.0", dependencies: [{ id: "ACME.CORE", range: "[1.0.0, 2.0.0)" }] },
  { targetFramework: null, dependencies: [] },
];

let admin: string;
let ci: string;
let reader: string;
let searcher: string;

/** init with the archive (and symbols), the simulated presigned PUTs, and commit. */
async function publish(
  token: string,
  id: string,
  version: string,
  options: { groups?: Groups; symbols?: boolean; file?: string } = {},
): Promise<Response> {
  const base = `${id.toLowerCase()}.${version.toLowerCase()}`;
  const files = [
    { name: options.file ?? `${base}.nupkg`, role: "archive", content: `${id}@${version}` },
  ];
  if (options.symbols) files.push({ name: `${base}.snupkg`, role: "symbols", content: "pdb" });
  const declared = await Promise.all(
    files.map(async (f) => {
      const bytes = new TextEncoder().encode(f.content);
      return { ...f, bytes, sha256: await sha256Hex(bytes) };
    }),
  );
  const init = await call("POST", "/api/v1/publish/init", {
    token,
    body: {
      eco: "nuget",
      name: id,
      version,
      files: declared.map((f) => ({
        name: f.name,
        size: f.bytes.length,
        sha256: f.sha256,
        role: f.role,
      })),
      manifest: metadataFromNuspec(nuspecFor(id, version, options.groups ?? [])),
    },
  });
  if (init.status !== 200) return init;
  const { uploadId } = await init.json<InitResult>();
  for (const f of declared) {
    await env.R2_BUCKET.put(stagingKey(uploadId, f.name), f.bytes, { sha256: f.sha256 });
  }
  return call("POST", "/api/v1/publish/commit", { token, body: { uploadId } });
}

function basic(token: string): Record<string, string> {
  return { authorization: `Basic ${btoa(token)}` };
}

async function get<T>(path: string, token = reader, status = 200): Promise<T> {
  const res = await call("GET", path, { headers: basic(token) });
  expect(res.status).toBe(status);
  return res.json<T>();
}

async function statusOf(path: string, token = reader): Promise<number> {
  return (await call("GET", path, { headers: basic(token) })).status;
}

async function flat(id: string, token = reader): Promise<string[] | number> {
  const res = await call("GET", `/nuget/flat/${id}/index.json`, { headers: basic(token) });
  if (res.status !== 200) return res.status;
  return (await res.json<{ versions: string[] }>()).versions;
}

beforeAll(async () => {
  admin = await credential("nuget-admin", "admin");
  ci = await credential("nuget-ci", "publish", [
    { eco: "nuget", package: "acme.*", versions: "*" },
  ]);
  reader = await credential("nuget-app", "read", [
    { eco: "nuget", package: "Acme.Sdk", versions: "[1.0,2.0)" },
  ]);
  searcher = await credential("nuget-search", "read", [
    { eco: "nuget", package: "ACME.*", versions: "*", transitive: false },
  ]);
  const versions: [string, string, Groups][] = [
    ["Acme.Sdk", "1.0.0", SDK_GROUPS],
    ["Acme.Sdk", "1.3.0-beta.1", SDK_GROUPS],
    [
      "Acme.Sdk",
      "2.0.0",
      [{ targetFramework: "net8.0", dependencies: [{ id: "Acme.Core", range: "2.0.0" }] }],
    ],
    ["Acme.Core", "1.0.0", []],
    ["Acme.Core", "1.5.0", []],
    ["Acme.Core", "2.0.0", []],
    ["Acme.Internal", "1.0.0", []],
  ];
  for (const [id, version, groups] of versions) {
    const res = await publish(ci, id, version, { groups });
    expect(res.status).toBe(201);
  }
});

describe("nuget publishing", () => {
  it("normalises the version and answers commit with the flat URLs", async () => {
    // The version as written in the .nuspec; the file is named after it.
    const res = await publish(ci, "Acme.Sdk", "1.2", { groups: SDK_GROUPS, symbols: true });
    expect(res.status).toBe(201);
    const url = `${ORIGIN}/nuget/flat/acme.sdk/1.2.0/acme.sdk.1.2.0.nupkg`;
    expect(await res.json()).toEqual({
      eco: "nuget",
      name: "acme.sdk",
      version: "1.2.0",
      url,
      files: [
        { name: "acme.sdk.1.2.nupkg", url },
        { name: "acme.sdk.1.2.snupkg", url: null },
      ],
    });
  });

  it("treats 1.2 and 1.2.0 as the same version", async () => {
    const res = await publish(ci, "Acme.Sdk", "1.2.0");
    expect(res.status).toBe(409);
    expect((await res.json<ErrorBody>()).error).toBe("version_exists");
  });

  it("rejects a misnamed .nupkg and append", async () => {
    const res = await publish(ci, "Acme.Sdk", "3.0.0", { file: "Acme.Sdk.3.0.0.nupkg" });
    expect(res.status).toBe(400);
    const append = await call("POST", "/api/v1/publish/init", {
      token: ci,
      body: {
        eco: "nuget",
        name: "Acme.Sdk",
        version: "1.2.0",
        files: [
          { name: "acme.sdk.1.2.0.snupkg", size: 1, sha256: "a".repeat(64), role: "symbols" },
        ],
        manifest: metadataFromNuspec(nuspecFor("Acme.Sdk", "1.2.0")),
        append: true,
      },
    });
    expect(append.status).toBe(400);
  });
});

describe("nuget feed", () => {
  it("serves the service index", async () => {
    const res = await call("GET", "/nuget/index.json", { headers: basic(reader) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(await res.json()).toEqual({
      version: "3.0.0",
      resources: [
        { "@id": `${ORIGIN}/nuget/flat/`, "@type": "PackageBaseAddress/3.0.0" },
        { "@id": `${ORIGIN}/nuget/registration/`, "@type": "RegistrationsBaseUrl/3.6.0" },
        { "@id": `${ORIGIN}/nuget/search`, "@type": "SearchQueryService/3.5.0" },
      ],
    });
  });

  it("lists the granted versions in the flat container, case-insensitively", async () => {
    expect(await flat("acme.sdk")).toEqual(["1.0.0", "1.2.0", "1.3.0-beta.1"]);
    expect(await flat("ACME.Sdk")).toEqual(["1.0.0", "1.2.0", "1.3.0-beta.1"]);
    expect(await flat("acme.sdk", admin)).toEqual(["1.0.0", "1.2.0", "1.3.0-beta.1", "2.0.0"]);
    expect(await flat("acme.internal")).toBe(404);
    expect(await flat("acme.nothing", admin)).toBe(404);
  });

  it("serves the .nuspec verbatim", async () => {
    const res = await call("GET", "/nuget/flat/acme.sdk/1.2.0/acme.sdk.nuspec", {
      headers: basic(reader),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toBe(nuspecFor("Acme.Sdk", "1.2", SDK_GROUPS));
    expect(await statusOf("/nuget/flat/acme.sdk/2.0.0/acme.sdk.nuspec")).toBe(404);
    expect(await statusOf("/nuget/flat/acme.sdk/2.0.0/acme.sdk.nuspec", admin)).toBe(200);
  });

  it("redirects .nupkg downloads within the grant", async () => {
    const res = await call("GET", "/nuget/flat/acme.sdk/1.2.0/acme.sdk.1.2.0.nupkg", {
      headers: basic(reader),
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("https://test-account.r2.cloudflarestorage.com");
    expect(location.pathname).toBe(
      "/serverless-registry/nuget/pkg/acme.sdk/1.2.0/acme.sdk.1.2.nupkg",
    );
    expect(location.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(await statusOf("/nuget/flat/acme.sdk/1.2/acme.sdk.1.2.nupkg")).toBe(302);
    expect(await statusOf("/nuget/flat/acme.sdk/2.0.0/acme.sdk.2.0.0.nupkg")).toBe(404);
    expect(await statusOf("/nuget/flat/acme.sdk/9.0.0/acme.sdk.9.0.0.nupkg", admin)).toBe(404);
  });

  it("serves the registration with dependency groups, filtered by the grant", async () => {
    const reg = await get<Registration>("/nuget/registration/Acme.Sdk/index.json");
    const base = `${ORIGIN}/nuget/registration/acme.sdk/index.json`;
    expect(reg.count).toBe(1);
    expect(reg.items[0]).toMatchObject({
      "@id": `${base}#page/1.0.0/1.3.0-beta.1`,
      count: 3,
      lower: "1.0.0",
      upper: "1.3.0-beta.1",
    });
    const leaf = reg.items[0]?.items.find((l) => l.catalogEntry.version === "1.2.0");
    expect(leaf).toMatchObject({
      "@id": `${base}#1.2.0`,
      packageContent: `${ORIGIN}/nuget/flat/acme.sdk/1.2.0/acme.sdk.1.2.0.nupkg`,
      catalogEntry: {
        id: "Acme.Sdk",
        version: "1.2.0",
        listed: true,
        description: "Acme SDK for .NET",
        authors: "Acme",
        tags: ["acme", "sdk"],
        dependencyGroups: [
          {
            targetFramework: "net8.0",
            dependencies: [{ id: "ACME.CORE", range: "[1.0.0, 2.0.0)" }],
          },
          { dependencies: [] },
        ],
      },
    });
    expect(await statusOf("/nuget/registration/acme.internal/index.json")).toBe(404);
  });

  it("opens dependencies transitively through NuGet ranges", async () => {
    // Acme.Sdk [1.0,2.0) depends on Acme.Core [1.0.0, 2.0.0); Acme.Sdk 2.0.0 is not granted.
    expect(await flat("acme.core")).toEqual(["1.0.0", "1.5.0"]);
    expect(await statusOf("/nuget/flat/acme.core/1.5.0/acme.core.1.5.0.nupkg")).toBe(302);
    expect(await statusOf("/nuget/flat/acme.core/2.0.0/acme.core.2.0.0.nupkg")).toBe(404);
    const listed = await call("GET", "/api/v1/packages", { token: reader });
    const body = await listed.json<{
      packages: { name: string; dependencies?: { name: string; versions: string[] }[] }[];
    }>();
    expect(body.packages.find((p) => p.name === "Acme.Sdk")?.dependencies).toEqual([
      { name: "acme.core", constraints: ["[1.0.0, 2.0.0)"], versions: ["1.5.0", "1.0.0"] },
    ]);
  });

  it("searches listed versions by id", async () => {
    const stable = await get<Search>("/nuget/search?q=SDK&semVerLevel=2.0.0", searcher);
    expect(stable.totalHits).toBe(1);
    expect(stable.data[0]).toMatchObject({ id: "Acme.Sdk", version: "2.0.0" });
    expect(stable.data[0]?.versions.map((v) => v.version)).toEqual(["1.0.0", "1.2.0", "2.0.0"]);
    const pre = await get<Search>("/nuget/search?q=sdk&prerelease=true", reader);
    expect(pre.data.map((d) => [d.id, d.version])).toEqual([["Acme.Sdk", "1.3.0-beta.1"]]);
    const everything = await get<Search>("/nuget/search?take=2", searcher);
    expect(everything.totalHits).toBe(3);
    expect(everything.data.map((d) => d.id)).toEqual(["Acme.Core", "Acme.Internal"]);
    const second = await get<Search>("/nuget/search?skip=2&take=2", searcher);
    expect(second.data.map((d) => d.id)).toEqual(["Acme.Sdk"]);
    expect(await statusOf("/nuget/search?take=many")).toBe(400);
    expect(await statusOf("/nuget/search?prerelease=maybe")).toBe(400);
  });

  it("marks yanked versions unlisted but keeps them in the flat container", async () => {
    const yank = await call("POST", "/api/v1/packages/nuget/acme.sdk/1.0.0/yank", { token: admin });
    expect(yank.status).toBe(200);
    expect(await flat("acme.sdk")).toEqual(["1.0.0", "1.2.0", "1.3.0-beta.1"]);
    const reg = await get<Registration>("/nuget/registration/acme.sdk/index.json");
    expect(reg.items[0]?.items.map((l) => [l.catalogEntry.version, l.catalogEntry.listed])).toEqual(
      [
        ["1.0.0", false],
        ["1.2.0", true],
        ["1.3.0-beta.1", true],
      ],
    );
    const search = await get<Search>("/nuget/search?q=acme.sdk", searcher);
    expect(search.data[0]?.versions.map((v) => v.version)).toEqual(["1.2.0", "2.0.0"]);
    expect(await statusOf("/nuget/flat/acme.sdk/1.0.0/acme.sdk.1.0.0.nupkg")).toBe(302);
    expect(await statusOf("/nuget/flat/acme.sdk/1.0.0/acme.sdk.nuspec")).toBe(200);
  });

  it("reports a deprecated version in the registration and keeps it listed", async () => {
    const url = "/api/v1/packages/nuget/acme.sdk/1.2.0/deprecate";
    const set = await call("POST", url, { token: admin, body: { message: "Moved to Acme.Core" } });
    expect(set.status).toBe(200);
    const reg = await get<Registration>("/nuget/registration/acme.sdk/index.json");
    const entry = reg.items[0]?.items.find((l) => l.catalogEntry.version === "1.2.0")?.catalogEntry;
    expect(entry).toMatchObject({
      listed: true,
      deprecation: { message: "Moved to Acme.Core" },
    });
    expect((await call("DELETE", url, { token: admin })).status).toBe(200);
    const after = await get<Registration>("/nuget/registration/acme.sdk/index.json");
    const cleared = after.items[0]?.items.find((l) => l.catalogEntry.version === "1.2.0");
    expect(cleared?.catalogEntry).not.toHaveProperty("deprecation");
  });

  it("accepts Bearer and Basic credentials and challenges with both", async () => {
    expect((await call("GET", "/nuget/index.json", { token: reader })).status).toBe(200);
    const anonymous = await call("GET", "/nuget/index.json");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe(
      'Basic realm="serverless-registry", Bearer realm="serverless-registry"',
    );
    expect(anonymous.headers.get("cache-control")).toBe("private, no-store");
    const wrong = await call("GET", "/nuget/flat/acme.sdk/index.json", {
      headers: basic("nuget-app:wrong"),
    });
    expect(wrong.status).toBe(401);
    expect(await statusOf("/nuget/index.json", ci)).toBe(403);
    expect((await call("POST", "/nuget/index.json", { token: reader })).status).toBe(404);
  });
});
