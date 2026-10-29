import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  GITHUB_ISSUER,
  GITHUB_JWKS_URL,
  JWKS_CACHE_URL,
  JWKS_FETCHED_AT_HEADER,
  authEntryId,
  authenticate,
  clearSessionCookie,
  createSession,
  deleteCredential,
  formatToken,
  generateSecret,
  getCredential,
  hashSecret,
  isActive,
  isSlug,
  listCredentials,
  parseAuthorization,
  parseToken,
  putCredential,
  randomBase62,
  readSession,
  requireRole,
  sessionCookie,
  sessionIdentity,
  sessionValueFrom,
  sha256Hex,
  timingSafeEqual,
  toCredential,
  matchesGhEntry,
  matchesGlob,
  matchesRepository,
  verifyGithubJwt,
  workflowPath,
  type AuthDeps,
  type AuthEnv,
  type CredentialRecord,
  type GhAuthRecord,
  type GithubClaims,
  type JwksCache,
  type Kind,
} from "../../src/core/auth";
import { syncGhRepoIndex } from "../../src/core/ghindex";
import { ValidationError } from "../../src/core/errors";
import { legacy, recordOf } from "../records";

const KEY = "k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e";
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.SflKxw-_Rj";

function basic(value: string): string {
  return `Basic ${btoa(value)}`;
}

describe("isSlug", () => {
  it.each(["ab", "shop-frontend", "a1", "0-0", "a".repeat(63)])("accepts %j", (s) => {
    expect(isSlug(s)).toBe(true);
  });

  it.each(["", "a", "-ab", "Shop", "shop_frontend", "shop.frontend", "a".repeat(64)])(
    "rejects %j",
    (s) => {
      expect(isSlug(s)).toBe(false);
    },
  );
});

describe("parseToken", () => {
  it.each([
    [
      `shop-frontend:${KEY}`,
      "",
      { source: null, project: "shop-frontend", type: "key", secret: KEY, login: "shop-frontend" },
    ],
    [
      `ci-acme-sdk:gh.${JWT}`,
      "",
      { source: null, project: "ci-acme-sdk", type: "gh", secret: JWT, login: "ci-acme-sdk" },
    ],
    [
      `shop-frontend:key.${KEY}`,
      "",
      { source: null, project: "shop-frontend", type: "key", secret: KEY, login: "shop-frontend" },
    ],
    [
      `okta.shop-frontend:${KEY}`,
      "",
      {
        source: "okta",
        project: "shop-frontend",
        type: "key",
        secret: KEY,
        login: "okta.shop-frontend",
      },
    ],
    [
      `okta.ci-acme-sdk:gh.${JWT}`,
      "",
      {
        source: "okta",
        project: "ci-acme-sdk",
        type: "gh",
        secret: JWT,
        login: "okta.ci-acme-sdk",
      },
    ],
    [
      `srg_shop-frontend:${KEY}`,
      "srg_",
      { source: null, project: "shop-frontend", type: "key", secret: KEY, login: "shop-frontend" },
    ],
    [`_:gh.${JWT}`, "", { source: null, project: "_", type: "gh", secret: JWT, login: "_" }],
    // A password part whose first segment is not a secret type is a whole `key` secret.
    [
      "admin:my.pass.word",
      "",
      { source: null, project: "admin", type: "key", secret: "my.pass.word", login: "admin" },
    ],
    [
      "admin:key.my.pass.word",
      "",
      { source: null, project: "admin", type: "key", secret: "my.pass.word", login: "admin" },
    ],
    [
      `shop-frontend:pw.${KEY}`,
      "",
      {
        source: null,
        project: "shop-frontend",
        type: "key",
        secret: `pw.${KEY}`,
        login: "shop-frontend",
      },
    ],
    [
      "shop-frontend:short",
      "",
      {
        source: null,
        project: "shop-frontend",
        type: "key",
        secret: "short",
        login: "shop-frontend",
      },
    ],
    [
      `shop-frontend:${KEY}`,
      "srg_",
      { source: null, project: "shop-frontend", type: "key", secret: KEY, login: "shop-frontend" },
    ],
  ])("parses %s (prefix %j)", (token, prefix, expected) => {
    expect(parseToken(token, prefix)).toEqual(expected);
  });

  it.each([
    ["", ""],
    [KEY, ""],
    ["shop-frontend", ""],
    [`:${KEY}`, ""],
    [`a.b.c:${KEY}`, ""],
    [`.shop:${KEY}`, ""],
    [`Shop:${KEY}`, ""],
    [`x:${KEY}`, ""],
    ["shop-frontend:", ""],
    [`shop-frontend:${"x".repeat(513)}`, ""],
    ["shop-frontend:key.", ""],
    [`shop-frontend:gh.${KEY}`, ""],
    ["shop-frontend:gh.not-a-jwt", ""],
    [`srg_shop-frontend:${KEY}`, ""],
    [`Okta.shop:${KEY}`, ""],
    [`_:${KEY}`, ""],
    [`_:key.${KEY}`, ""],
    [`okta._:gh.${JWT}`, ""],
    [`_.shop:gh.${JWT}`, ""],
    [`__:gh.${JWT}`, ""],
  ])("rejects %j (prefix %j)", (token, prefix) => {
    expect(parseToken(token, prefix)).toBeNull();
  });
});

describe("parseAuthorization", () => {
  const expected = {
    source: null,
    project: "shop-frontend",
    type: "key",
    secret: KEY,
    login: "shop-frontend",
  };
  const token = `shop-frontend:${KEY}`;

  it.each([
    ["Bearer", `Bearer ${token}`],
    ["lower-case bearer", `bearer ${token}`],
    ["Basic token", basic(token)],
    ["lower-case basic", `basic ${btoa(token)}`],
    ["Basic pasted", basic(`shop-frontend:${token}`)],
    ["raw", token],
    ["raw with whitespace", `  ${token} `],
  ])("accepts %s", (_, header) => {
    expect(parseAuthorization(header)).toEqual(expected);
  });

  it("accepts a gh token in every form", () => {
    const gh = `ci-acme-sdk:gh.${JWT}`;
    for (const header of [`Bearer ${gh}`, basic(gh), basic(`ci-acme-sdk:${gh}`), gh]) {
      expect(parseAuthorization(header)?.type).toBe("gh");
    }
  });

  it("handles TOKEN_PREFIX with and without the prefix", () => {
    const prefixed = `srg_${token}`;
    for (const header of [
      `Bearer ${prefixed}`,
      `Bearer ${token}`,
      basic(prefixed),
      basic(`shop-frontend:${prefixed}`),
      basic(`srg_shop-frontend:${prefixed}`),
      basic(`srg_shop-frontend:${token}`),
      prefixed,
    ]) {
      expect(parseAuthorization(header, "srg_"), header).toEqual(expected);
    }
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["Bearer without token", "Bearer"],
    ["Bearer with garbage", "Bearer nope"],
    ["Basic with bad base64", "Basic !!!"],
    ["Basic with invalid UTF-8", `Basic ${btoa("\xff\xfe:\xff")}`],
    ["Basic login mismatch", basic(`someone-else:${token}`)],
    ["Basic with only a login", basic("shop-frontend")],
    ["Basic with an empty secret", basic("shop-frontend:")],
    ["Digest scheme", `Digest ${token}`],
  ])("rejects %s", (_, header) => {
    expect(parseAuthorization(header)).toBeNull();
  });
});

// Fixed clock: 2026-10-28T10:00:00Z.
const NOW = Date.parse("2026-10-28T10:00:00Z");
const NOW_SEC = NOW / 1000;
const PUBLIC_URL = "https://registry.test";

function authEnv(overrides: Partial<AuthEnv> = {}): AuthEnv {
  return { AUTH: env.AUTH, PUBLIC_URL, TOKEN_PREFIX: "", ...overrides };
}

function request(authorization?: string): Request {
  const headers: Record<string, string> = authorization ? { authorization } : {};
  return new Request("https://registry.test/api/v1/whoami", { headers });
}

let projectCounter = 0;
function uniqueProject(base: string): string {
  projectCounter += 1;
  return `${base}-${projectCounter}`;
}

describe("secrets", () => {
  it("hashes with SHA-256", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await hashSecret("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("generates 32 base62 characters", () => {
    const secrets = new Set(Array.from({ length: 50 }, generateSecret));
    expect(secrets.size).toBe(50);
    for (const secret of secrets) expect(secret).toMatch(/^[A-Za-z0-9]{32}$/);
  });

  it("uses the whole base62 alphabet", () => {
    const seen = new Set(randomBase62(20000));
    expect(seen.size).toBe(62);
  });

  it("formats tokens that parse back", () => {
    const secret = generateSecret();
    expect(formatToken("shop", secret)).toBe(`shop:${secret}`);
    expect(formatToken("shop", secret, "srg_")).toBe(`srg_shop:${secret}`);
    expect(parseToken(formatToken("shop", secret, "srg_"), "srg_")?.secret).toBe(secret);
  });

  it("compares strings in constant time", () => {
    expect(timingSafeEqual("sha256:abc", "sha256:abc")).toBe(true);
    expect(timingSafeEqual("sha256:abc", "sha256:abd")).toBe(false);
    expect(timingSafeEqual("sha256:abc", "sha256:ab")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("auth entries", () => {
  const key = {
    type: "key",
    hash: "sha256:3f9a1c0b7d2e11112222333344445555666677778888999900001111aaaabbbb",
    created: "2026-10-28T09:00:00Z",
    expires: null,
  } as const;
  const gh: GhAuthRecord = {
    type: "gh",
    repository: "acme/shop-frontend",
    ref: "refs/heads/main",
    workflow: null,
    created: "2026-10-28T09:05:00Z",
    expires: null,
  };

  it("derives the key id from the stored digest", async () => {
    expect(await authEntryId(key)).toBe("3f9a1c0b7d2e");
  });

  it("derives a stable gh id from its claims and creation time", async () => {
    const id = await authEntryId(gh);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(await authEntryId({ ...gh })).toBe(id);
    expect(await authEntryId({ ...gh, expires: "2027-01-01" })).toBe(id);
    expect(await authEntryId({ ...gh, ref: null })).not.toBe(id);
    expect(await authEntryId({ ...gh, workflow: "CI" })).not.toBe(id);
    expect(await authEntryId({ ...gh, created: "2026-10-29T00:00:00Z" })).not.toBe(id);
    expect(id).toBe(
      (await sha256Hex(JSON.stringify([gh.repository, gh.ref, gh.workflow, gh.created]))).slice(
        0,
        12,
      ),
    );
  });

  it.each([
    [null, true],
    ["2026-10-28T10:00:01Z", true],
    ["2026-10-28T10:00:00Z", false],
    ["2026-10-29", true],
    ["2026-10-28", false],
    ["not a date", false],
  ])("isActive with expires %j → %s", (expires, expected) => {
    expect(isActive({ ...key, expires }, NOW)).toBe(expected);
  });

  it("exposes ids instead of hashes", async () => {
    const credential = await toCredential(
      legacy({
        project: "shop",
        kind: "read",
        auth: [key, gh],
        grants: [{ eco: "npm", package: "@acme/sdk", versions: "^2.0" }],
      }),
    );
    expect(credential.auth[0]).toEqual({
      id: "3f9a1c0b7d2e",
      type: "key",
      scope: ["read"],
      created: key.created,
      expires: null,
      description: null,
    });
    expect(credential.auth[1]).toMatchObject({ type: "gh", repository: "acme/shop-frontend" });
    expect(JSON.stringify(credential)).not.toContain(key.hash);
  });

  it("hides grants of admin credentials", async () => {
    const credential = await toCredential({
      ...recordOf("root", "admin"),
      grants: {
        read: [{ eco: "npm", package: "*", versions: "*" }],
        publish: [],
        yank: [],
        delete: [],
      },
    });
    expect(credential.grants).toEqual([]);
  });
});

describe("credential storage", () => {
  it("writes, reads, lists and deletes records", async () => {
    const records: CredentialRecord[] = ["store-b", "store-a", "store-c"].map((project) =>
      recordOf(project, "read"),
    );
    for (const record of records) await putCredential(env, record);
    await env.AUTH.put("unrelated:key", "{}");

    expect(await getCredential(env, "store-a")).toEqual(records[1]);
    expect(await env.AUTH.get("cred:store-a", "json")).toEqual(records[1]);
    const listed = (await listCredentials(env)).map((r) => r.project);
    expect(listed.filter((p) => p.startsWith("store-"))).toEqual(["store-a", "store-b", "store-c"]);

    await deleteCredential(env, "store-b");
    expect(await getCredential(env, "store-b")).toBeNull();
  });

  it("reads grants stored without `transitive` as transitive", async () => {
    await env.AUTH.put(
      "cred:legacy-grants",
      JSON.stringify({
        project: "legacy-grants",
        kind: "read",
        auth: [],
        grants: [
          { eco: "npm", package: "@acme/*", versions: "*" },
          { eco: "npm", package: "@acme/sdk", versions: "^2.0", transitive: false },
        ],
      }),
    );
    expect((await getCredential(env, "legacy-grants"))?.grants.read).toEqual([
      { eco: "npm", package: "@acme/*", versions: "*", transitive: true },
      { eco: "npm", package: "@acme/sdk", versions: "^2.0", transitive: false },
    ]);
    await deleteCredential(env, "legacy-grants");
  });

  it("ignores malformed records", async () => {
    await env.AUTH.put("cred:broken", JSON.stringify({ project: "broken", kind: "root" }));
    await env.AUTH.put(
      "cred:mismatch",
      JSON.stringify({ project: "other", kind: "read", auth: [], grants: [] }),
    );
    await env.AUTH.put("cred:garbage", "not json at all");
    expect(await getCredential(env, "broken")).toBeNull();
    expect(await getCredential(env, "mismatch")).toBeNull();
    expect(await getCredential(env, "garbage")).toBeNull();
    await env.AUTH.delete("cred:garbage");
  });
});

describe("authenticate with key secrets", () => {
  const secret = "k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e";
  const oldSecret = "Q2w9Er7Ty5Ui3Op1As8Df6Gh4Jk2Lz0X";
  let project: string;
  let record: CredentialRecord;

  beforeEach(async () => {
    project = uniqueProject("shop");
    record = legacy({
      project,
      kind: "read",
      auth: [
        { type: "key", hash: await hashSecret(secret), created: "2026-10-28", expires: null },
        {
          type: "key",
          hash: await hashSecret(oldSecret),
          created: "2026-06-01",
          expires: "2026-10-01T00:00:00Z",
        },
      ],
      grants: [{ eco: "npm", package: "@acme/sdk", versions: "^2.0", transitive: true }],
    });
    await putCredential(env, record);
  });

  const deps: AuthDeps = { now: () => NOW };

  it("accepts a valid secret in every header form", async () => {
    const token = `${project}:${secret}`;
    for (const header of [
      `Bearer ${token}`,
      `Basic ${btoa(token)}`,
      `Basic ${btoa(`${project}:${token}`)}`,
      token,
    ]) {
      const result = await authenticate(request(header), authEnv(), deps);
      expect(result?.via).toBe("key");
      expect(result?.identity).toEqual({
        project,
        roles: ["read"],
        grants: record.grants,
        record,
        entryId: (await hashSecret(secret)).slice(7, 19),
      });
    }
  });

  it("accepts the prefixed and unprefixed token when TOKEN_PREFIX is set", async () => {
    const e = authEnv({ TOKEN_PREFIX: "srg_" });
    expect(await authenticate(request(`Bearer srg_${project}:${secret}`), e, deps)).not.toBeNull();
    expect(await authenticate(request(`Bearer ${project}:${secret}`), e, deps)).not.toBeNull();
  });

  it("rejects a wrong secret", async () => {
    const wrong = `${project}:${"A".repeat(32)}`;
    expect(await authenticate(request(`Bearer ${wrong}`), authEnv(), deps)).toBeNull();
  });

  it("rejects an expired entry and accepts it before expiry", async () => {
    const token = `Bearer ${project}:${oldSecret}`;
    expect(await authenticate(request(token), authEnv(), deps)).toBeNull();
    const before = { now: () => Date.parse("2026-09-30T00:00:00Z") };
    expect(await authenticate(request(token), authEnv(), before)).not.toBeNull();
  });

  it("rejects an unknown project, a missing header and a source", async () => {
    expect(await authenticate(request(`Bearer nobody-here:${secret}`), authEnv(), deps)).toBeNull();
    expect(await authenticate(request(), authEnv(), deps)).toBeNull();
    expect(
      await authenticate(request(`Bearer okta.${project}:${secret}`), authEnv(), deps),
    ).toBeNull();
  });

  it("rejects a key secret sent as gh and vice versa", async () => {
    expect(
      await authenticate(request(`Bearer ${project}:gh.${secret}`), authEnv(), deps),
    ).toBeNull();
  });

  it("returns no grants for admin", async () => {
    await putCredential(env, recordOf(project, "admin", record.auth));
    const result = await authenticate(request(`Bearer ${project}:${secret}`), authEnv(), deps);
    expect(result?.identity.roles).toEqual(["admin"]);
    expect(result?.identity.grants).toEqual({ read: [], publish: [], yank: [], delete: [] });
  });
});

describe("requireRole", () => {
  it("passes a listed kind", () => {
    expect(() => requireRole({ roles: ["publish"] }, "publish")).not.toThrow();
    expect(() => requireRole({ roles: ["admin"] }, "read", "admin")).not.toThrow();
  });

  it("throws forbidden otherwise", () => {
    let error: unknown;
    try {
      requireRole({ roles: ["read"] }, "publish", "admin");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe("forbidden");
    expect((error as ValidationError).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------
// GitHub OIDC
// ---------------------------------------------------------------------------------------------

const KID = "test-key-1";
const ALGORITHM = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: { keys: JsonWebKey[] };

function base64Url(bytes: Uint8Array | ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function signJwt(
  claims: Record<string, unknown>,
  options: { key?: CryptoKey; header?: Record<string, unknown> } = {},
): Promise<string> {
  const header = options.header ?? { alg: "RS256", typ: "JWT", kid: KID };
  const input = `${encodeJson(header)}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    options.key ?? signingKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64Url(signature)}`;
}

let jwtCounter = 0;
function githubClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  jwtCounter += 1;
  return {
    // Every token is distinct, so a verification cached by one test never serves another.
    jti: `test-${jwtCounter}`,
    iss: GITHUB_ISSUER,
    aud: PUBLIC_URL,
    sub: "repo:acme/shop-frontend:ref:refs/heads/main",
    repository: "acme/shop-frontend",
    ref: "refs/heads/main",
    workflow: "Release",
    workflow_ref: "acme/shop-frontend/.github/workflows/release.yml@refs/heads/main",
    repository_id: "123456789",
    repository_owner_id: "98765",
    iat: NOW_SEC - 30,
    nbf: NOW_SEC - 30,
    exp: NOW_SEC + 300,
    ...overrides,
  };
}

interface FakeFetch {
  fetch: typeof fetch;
  calls: string[];
}

function fakeFetch(body: () => unknown = () => jwks, status = 200): FakeFetch {
  const calls: string[] = [];
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    if (url !== GITHUB_JWKS_URL) return new Response("not found", { status: 404 });
    return Response.json(body(), { status });
  };
  return { fetch: impl as typeof fetch, calls };
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(ALGORITHM, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const other = (await crypto.subtle.generateKey(ALGORITHM, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  signingKey = pair.privateKey;
  otherKey = other.privateKey;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  jwks = {
    keys: [
      {
        kty: "RSA",
        n: publicJwk.n,
        e: publicJwk.e,
        alg: "RS256",
        use: "sig",
        kid: KID,
      } as JsonWebKey,
    ],
  };
});

/** An in-memory stand-in for `caches.default`, fresh for every test. */
function memoryCache(): JwksCache & { entries: Map<string, Response> } {
  const entries = new Map<string, Response>();
  const key = (request: RequestInfo | URL) =>
    request instanceof Request ? request.url : String(request);
  return {
    entries,
    async match(request: RequestInfo | URL) {
      return entries.get(key(request))?.clone();
    },
    async put(request: RequestInfo | URL, response: Response) {
      entries.set(key(request), response.clone());
    },
  } as JwksCache & { entries: Map<string, Response> };
}

let jwksCache = memoryCache();

async function seedJwks(keys: JsonWebKey[], fetchedAt: number): Promise<void> {
  await jwksCache.put(
    JWKS_CACHE_URL,
    new Response(JSON.stringify({ keys }), {
      headers: { [JWKS_FETCHED_AT_HEADER]: String(fetchedAt) },
    }),
  );
}

describe("verifyGithubJwt", () => {
  beforeEach(async () => {
    jwksCache = memoryCache();
  });

  it("verifies a valid token and caches the JWKS", async () => {
    const f = fakeFetch();
    const deps = { fetch: f.fetch, now: () => NOW, cache: jwksCache };
    const claims = await verifyGithubJwt(authEnv(), await signJwt(githubClaims()), deps);
    expect(claims?.repository).toBe("acme/shop-frontend");
    expect(f.calls).toEqual([GITHUB_JWKS_URL]);

    const cached = await jwksCache.match(JWKS_CACHE_URL);
    expect(await cached?.json()).toMatchObject({ keys: jwks.keys });
    expect(cached?.headers.get("cache-control")).toBe("max-age=86400");
    expect(cached?.headers.get(JWKS_FETCHED_AT_HEADER)).toBe(String(NOW));
    const again = await signJwt(githubClaims({ workflow: "Other" }));
    expect(await verifyGithubJwt(authEnv(), again, deps)).not.toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it("caches the JWKS in caches.default when no cache is injected", async () => {
    await caches.default.delete(JWKS_CACHE_URL);
    const f = fakeFetch();
    const jwt = await signJwt(githubClaims());
    expect(
      await verifyGithubJwt(authEnv(), jwt, { fetch: f.fetch, now: () => NOW }),
    ).not.toBeNull();
    const cached = await caches.default.match(JWKS_CACHE_URL);
    expect(cached?.headers.get(JWKS_FETCHED_AT_HEADER)).toBe(String(NOW));
    expect(
      await verifyGithubJwt(authEnv(), jwt, { fetch: f.fetch, now: () => NOW }),
    ).not.toBeNull();
    expect(f.calls).toHaveLength(1);
    await caches.default.delete(JWKS_CACHE_URL);
  });

  it("refetches a JWKS older than its lifetime", async () => {
    await seedJwks(jwks.keys, NOW - 25 * 60 * 60 * 1000);
    const f = fakeFetch();
    const deps = { fetch: f.fetch, now: () => NOW, cache: jwksCache };
    expect(await verifyGithubJwt(authEnv(), await signJwt(githubClaims()), deps)).not.toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it("accepts an audience list and a PUBLIC_URL with a trailing slash", async () => {
    const deps = { fetch: fakeFetch().fetch, now: () => NOW, cache: jwksCache };
    const jwt = await signJwt(githubClaims({ aud: ["other", PUBLIC_URL] }));
    expect(
      await verifyGithubJwt(authEnv({ PUBLIC_URL: `${PUBLIC_URL}/` }), jwt, deps),
    ).not.toBeNull();
  });

  it.each([
    ["wrong audience", githubClaims({ aud: "https://elsewhere.test" })],
    ["wrong issuer", githubClaims({ iss: "https://evil.test" })],
    ["expired", githubClaims({ exp: NOW_SEC - 1 })],
    ["expiring now", githubClaims({ exp: NOW_SEC })],
    ["not yet valid", githubClaims({ nbf: NOW_SEC + 120 })],
    ["missing exp", githubClaims({ exp: undefined })],
    ["missing repository", githubClaims({ repository: undefined })],
  ])("rejects a token with %s", async (_, claims) => {
    const deps = { fetch: fakeFetch().fetch, now: () => NOW, cache: jwksCache };
    expect(await verifyGithubJwt(authEnv(), await signJwt(claims), deps)).toBeNull();
  });

  it("normalises numeric ids to strings and rejects mistyped claims", async () => {
    const deps = { fetch: fakeFetch().fetch, now: () => NOW, cache: jwksCache };
    const numeric = await signJwt(githubClaims({ repository_id: 42, repository_owner_id: 7 }));
    expect(await verifyGithubJwt(authEnv(), numeric, deps)).toMatchObject({
      repository_id: "42",
      repository_owner_id: "7",
    });
    for (const bad of [{ environment: 1 }, { ref: true }, { workflow_ref: {} }]) {
      expect(await verifyGithubJwt(authEnv(), await signJwt(githubClaims(bad)), deps)).toBeNull();
    }
  });

  it("tolerates small clock skew on nbf", async () => {
    const deps = { fetch: fakeFetch().fetch, now: () => NOW, cache: jwksCache };
    const jwt = await signJwt(githubClaims({ nbf: NOW_SEC + 30 }));
    expect(await verifyGithubJwt(authEnv(), jwt, deps)).not.toBeNull();
  });

  it("rejects a bad signature", async () => {
    const deps = { fetch: fakeFetch().fetch, now: () => NOW, cache: jwksCache };
    expect(
      await verifyGithubJwt(authEnv(), await signJwt(githubClaims(), { key: otherKey }), deps),
    ).toBeNull();

    const [h, , sig] = (await signJwt(githubClaims())).split(".");
    const forged = `${h}.${encodeJson(githubClaims({ repository: "evil/repo" }))}.${sig}`;
    expect(await verifyGithubJwt(authEnv(), forged, deps)).toBeNull();
  });

  it.each([
    ["alg none", { alg: "none", kid: KID }],
    ["alg HS256", { alg: "HS256", kid: KID }],
    ["no kid", { alg: "RS256" }],
    ["unknown kid", { alg: "RS256", kid: "other" }],
  ])("rejects %s", async (_, header) => {
    const deps = { fetch: fakeFetch().fetch, now: () => NOW, cache: jwksCache };
    expect(
      await verifyGithubJwt(authEnv(), await signJwt(githubClaims(), { header }), deps),
    ).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    const deps = { fetch: fakeFetch().fetch, now: () => NOW, cache: jwksCache };
    for (const jwt of ["", "a.b", "a.b.c", "!!.??.**", `${encodeJson({ alg: "RS256" })}.x.y`]) {
      expect(await verifyGithubJwt(authEnv(), jwt, deps)).toBeNull();
    }
  });

  it("refuses to verify without PUBLIC_URL", async () => {
    const f = fakeFetch();
    const jwt = await signJwt(githubClaims());
    expect(
      await verifyGithubJwt(authEnv({ PUBLIC_URL: undefined }), jwt, {
        fetch: f.fetch,
        now: () => NOW,
        cache: jwksCache,
      }),
    ).toBeNull();
    expect(f.calls).toEqual([]);
  });

  it("fails closed when the JWKS cannot be fetched", async () => {
    const jwt = await signJwt(githubClaims());
    const down = fakeFetch(() => ({ error: "down" }), 503);
    expect(
      await verifyGithubJwt(authEnv(), jwt, {
        fetch: down.fetch,
        now: () => NOW,
        cache: jwksCache,
      }),
    ).toBeNull();
    const throwing = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(
      await verifyGithubJwt(authEnv(), jwt, { fetch: throwing, now: () => NOW, cache: jwksCache }),
    ).toBeNull();
    expect(jwksCache.entries.size).toBe(0);
  });

  it("refetches the JWKS for an unknown kid after the refresh interval", async () => {
    // A stale cache that does not contain the signing key yet (GitHub rotated keys).
    await seedJwks([], NOW - 10 * 60_000);
    const f = fakeFetch();
    const jwt = await signJwt(githubClaims());
    expect(
      await verifyGithubJwt(authEnv(), jwt, { fetch: f.fetch, now: () => NOW, cache: jwksCache }),
    ).not.toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it("does not refetch the JWKS for an unknown kid right after a fetch", async () => {
    await seedJwks([], NOW - 60_000);
    const f = fakeFetch();
    const jwt = await signJwt(githubClaims());
    expect(
      await verifyGithubJwt(authEnv(), jwt, { fetch: f.fetch, now: () => NOW, cache: jwksCache }),
    ).toBeNull();
    expect(f.calls).toEqual([]);
  });
});

describe("gh entry matching", () => {
  const claims = (overrides: Partial<GithubClaims> = {}): GithubClaims => ({
    iss: GITHUB_ISSUER,
    aud: PUBLIC_URL,
    exp: NOW_SEC + 300,
    repository: "Acme/SDK",
    repository_id: "123",
    repository_owner_id: "45",
    ref: "refs/tags/v1.2.0",
    workflow: "Release",
    workflow_ref: "Acme/SDK/.github/workflows/release.yml@refs/tags/v1.2.0",
    environment: "production",
    ...overrides,
  });
  const gh = (overrides: Partial<GhAuthRecord> = {}): GhAuthRecord => ({
    type: "gh",
    repository: "acme/sdk",
    ref: null,
    workflow: null,
    created: "2026-10-28T09:05:00Z",
    expires: null,
    ...overrides,
  });

  it("matches the repository case-insensitively or by an owner glob", () => {
    expect(matchesRepository("acme/sdk", "Acme/SDK")).toBe(true);
    expect(matchesRepository("acme/*", "Acme/SDK")).toBe(true);
    expect(matchesRepository("ACME/*", "acme/other")).toBe(true);
    expect(matchesRepository("acme/*", "acme-labs/sdk")).toBe(false);
    expect(matchesRepository("acme/sdk", "acme/sdk-extra")).toBe(false);
    expect(matchesRepository("acme/*", "acme/")).toBe(false);
  });

  it("globs refs with * matching any characters, slashes included", () => {
    expect(matchesGlob("refs/tags/v*", "refs/tags/v1.2.0")).toBe(true);
    expect(matchesGlob("refs/heads/*", "refs/heads/feature/x")).toBe(true);
    expect(matchesGlob("refs/*/main", "refs/heads/main")).toBe(true);
    expect(matchesGlob("refs/heads/main", "refs/heads/main")).toBe(true);
    expect(matchesGlob("refs/heads/main", "refs/heads/mainline")).toBe(false);
    expect(matchesGlob("refs/tags/v1.*", "refs/tags/v1x2")).toBe(false);
    expect(matchesGlob("refs/tags/v*", "refs/heads/v1")).toBe(false);
    expect(matchesGlob("refs/heads/(main)", "refs/heads/(main)")).toBe(true);
  });

  it("strips owner/repo and the ref from workflow_ref", () => {
    expect(workflowPath(claims())).toBe(".github/workflows/release.yml");
    expect(
      workflowPath(
        claims({
          ref: "refs/heads/a@b",
          workflow_ref: "Acme/SDK/.github/workflows/ci@v2.yml@refs/heads/a@b",
        }),
      ),
    ).toBe(".github/workflows/ci@v2.yml");
    expect(
      workflowPath(
        claims({ ref: undefined, workflow_ref: "acme/sdk/.github/workflows/x.yml@refs/pull/1" }),
      ),
    ).toBe(".github/workflows/x.yml");
    expect(workflowPath(claims({ workflow_ref: undefined }))).toBeNull();
  });

  it("treats every absent or null optional field as any", () => {
    expect(matchesGhEntry(gh(), claims())).toBe(true);
    expect(
      matchesGhEntry(gh(), {
        iss: GITHUB_ISSUER,
        aud: PUBLIC_URL,
        exp: NOW_SEC + 300,
        repository: "acme/sdk",
      }),
    ).toBe(true);
  });

  it.each<[string, Partial<GhAuthRecord>, boolean]>([
    ["repository_id equal", { repository_id: "123" }, true],
    ["repository_id different", { repository_id: "124" }, false],
    ["repository_owner_id equal", { repository_owner_id: "45" }, true],
    ["repository_owner_id different", { repository_owner_id: "46" }, false],
    ["ref glob", { ref: "refs/tags/v*" }, true],
    ["ref exact", { ref: "refs/tags/v1.2.0" }, true],
    ["ref other", { ref: "refs/heads/main" }, false],
    ["workflow path", { workflow: ".github/workflows/release.yml" }, true],
    ["workflow display name", { workflow: "Release" }, false],
    ["workflow other", { workflow: ".github/workflows/ci.yml" }, false],
    ["environment equal", { environment: "production" }, true],
    ["environment different", { environment: "Production" }, false],
    ["owner glob", { repository: "acme/*" }, true],
    ["other repository", { repository: "acme/other" }, false],
  ])("%s", (_, overrides, expected) => {
    expect(matchesGhEntry(gh(overrides), claims())).toBe(expected);
  });

  it("does not match set fields against missing claims", () => {
    const bare = claims({
      repository_id: undefined,
      ref: undefined,
      workflow_ref: undefined,
      environment: undefined,
    });
    expect(matchesGhEntry(gh({ repository_id: "123" }), bare)).toBe(false);
    expect(matchesGhEntry(gh({ ref: "*" }), bare)).toBe(false);
    expect(matchesGhEntry(gh({ workflow: ".github/workflows/release.yml" }), bare)).toBe(false);
    expect(matchesGhEntry(gh({ environment: "production" }), bare)).toBe(false);
  });
});

describe("authenticate with gh secrets", () => {
  let project: string;
  let record: CredentialRecord;
  let f: FakeFetch;
  let deps: AuthDeps;

  const entry = (overrides: Partial<GhAuthRecord> = {}): GhAuthRecord => ({
    type: "gh",
    repository: "acme/shop-frontend",
    ref: "refs/heads/main",
    workflow: null,
    created: "2026-10-28T09:05:00Z",
    expires: null,
    ...overrides,
  });

  beforeEach(async () => {
    jwksCache = memoryCache();
    project = uniqueProject("ci");
    record = recordOf(project, "publish", [entry()]);
    await putCredential(env, record);
    f = fakeFetch();
    deps = { fetch: f.fetch, now: () => NOW, cache: jwksCache };
  });

  const bearer = (jwt: string) => request(`Bearer ${project}:gh.${jwt}`);

  it("authenticates a matching token and stores nothing about it", async () => {
    const jwt = await signJwt(githubClaims());
    const result = await authenticate(bearer(jwt), authEnv(), deps);
    expect(result?.via).toBe("gh");
    expect(result?.identity.project).toBe(project);
    expect(result?.identity.roles).toEqual(["publish"]);
    expect(result?.identity.entryId).toBe(await authEntryId(entry()));
    expect(await env.AUTH.get(`ghok:${await sha256Hex(jwt)}`)).toBeNull();
  });

  it("verifies the signature on every request, reusing only the cached JWKS", async () => {
    const jwt = await signJwt(githubClaims());
    expect(await authenticate(bearer(jwt), authEnv(), deps)).not.toBeNull();
    const failing = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    const again = { fetch: failing, now: () => NOW, cache: jwksCache };
    expect((await authenticate(bearer(jwt), authEnv(), again))?.via).toBe("gh");
    expect(f.calls).toHaveLength(1);

    // Without the JWKS the token cannot be verified, even though it was accepted before.
    jwksCache = memoryCache();
    const cold = { fetch: failing, now: () => NOW, cache: jwksCache };
    expect(await authenticate(bearer(jwt), authEnv(), cold)).toBeNull();
  });

  it("refuses an accepted token once the entry or the token expired", async () => {
    const jwt = await signJwt(githubClaims());
    expect(await authenticate(bearer(jwt), authEnv(), deps)).not.toBeNull();

    await putCredential(env, { ...record, auth: [entry({ expires: "2026-10-28T09:59:00Z" })] });
    expect(await authenticate(bearer(jwt), authEnv(), deps)).toBeNull();

    await putCredential(env, record);
    const later = { fetch: f.fetch, now: () => NOW + 301_000, cache: jwksCache };
    expect(await authenticate(bearer(jwt), authEnv(), later)).toBeNull();
  });

  it("does not accept a token for another project's repository", async () => {
    const jwt = await signJwt(githubClaims());
    expect(await authenticate(bearer(jwt), authEnv(), deps)).not.toBeNull();
    const other = uniqueProject("ci-other");
    await putCredential(
      env,
      legacy({
        project: other,
        kind: "read",
        auth: [entry({ repository: "acme/other" })],
        grants: [],
      }),
    );
    expect(await authenticate(request(`Bearer ${other}:gh.${jwt}`), authEnv(), deps)).toBeNull();
  });

  describe("pinning ids on first use", () => {
    const stored = async () => (await getCredential(env, project, { fresh: true }))?.auth[0];

    it("pins repository_id and repository_owner_id on the first match", async () => {
      const jwt = await signJwt(githubClaims());
      const result = await authenticate(bearer(jwt), authEnv(), deps);
      expect(result?.identity.entryId).toBe(await authEntryId(entry()));
      expect(await stored()).toMatchObject({
        repository_id: "123456789",
        repository_owner_id: "98765",
      });
      expect(result?.identity.record.auth[0]).toMatchObject({ repository_id: "123456789" });
      expect(await getCredential(env, project)).toMatchObject({
        auth: [{ repository_id: "123456789" }],
      });

      // The same repository name, re-created with another id, no longer matches.
      const recreated = await signJwt(githubClaims({ repository_id: "555" }));
      expect(await authenticate(bearer(recreated), authEnv(), deps)).toBeNull();
      expect(
        await authenticate(bearer(await signJwt(githubClaims())), authEnv(), deps),
      ).not.toBeNull();
    });

    it("never pins with pin_on_first_use false", async () => {
      await putCredential(env, { ...record, auth: [entry({ pin_on_first_use: false })] });
      expect(
        await authenticate(bearer(await signJwt(githubClaims())), authEnv(), deps),
      ).not.toBeNull();
      const after = await stored();
      expect(after).not.toHaveProperty("repository_id");
      expect(after).not.toHaveProperty("repository_owner_id");
      const other = await signJwt(githubClaims({ repository_id: "555" }));
      expect(await authenticate(bearer(other), authEnv(), deps)).not.toBeNull();
    });

    it("pins only the owner id of an owner glob", async () => {
      await putCredential(env, { ...record, auth: [entry({ repository: "acme/*" })] });
      expect(
        await authenticate(bearer(await signJwt(githubClaims())), authEnv(), deps),
      ).not.toBeNull();
      const after = await stored();
      expect(after).toMatchObject({ repository_owner_id: "98765" });
      expect(after).not.toHaveProperty("repository_id");
      const otherOwner = await signJwt(
        githubClaims({ repository: "acme/other", repository_owner_id: "1" }),
      );
      expect(await authenticate(bearer(otherOwner), authEnv(), deps)).toBeNull();
      const sibling = await signJwt(
        githubClaims({ repository: "acme/other", repository_id: "42" }),
      );
      expect(await authenticate(bearer(sibling), authEnv(), deps)).not.toBeNull();
    });

    it("leaves explicit ids alone and pins only what is unset", async () => {
      await putCredential(env, { ...record, auth: [entry({ repository_id: "123456789" })] });
      expect(
        await authenticate(bearer(await signJwt(githubClaims())), authEnv(), deps),
      ).not.toBeNull();
      expect(await stored()).toMatchObject({
        repository_id: "123456789",
        repository_owner_id: "98765",
      });
    });

    it("does not pin from a token without the id claims", async () => {
      const bare = githubClaims({ repository_id: undefined, repository_owner_id: undefined });
      expect(await authenticate(bearer(await signJwt(bare)), authEnv(), deps)).not.toBeNull();
      expect(await stored()).not.toHaveProperty("repository_id");
    });

    it("keeps the record intact under concurrent first requests", async () => {
      const second = entry({ repository: "acme/other", created: "2026-10-28T09:06:00Z" });
      const key = {
        type: "key" as const,
        hash: await hashSecret(KEY),
        created: "2026-01-01",
        expires: null,
      };
      await putCredential(env, { ...record, auth: [entry(), second, key] });
      const tokens = await Promise.all(Array.from({ length: 6 }, () => signJwt(githubClaims())));
      const results = await Promise.all(
        tokens.map((jwt) => authenticate(bearer(jwt), authEnv(), deps)),
      );
      expect(results.every((r) => r !== null)).toBe(true);
      const after = await getCredential(env, project, { fresh: true });
      expect(after?.auth).toEqual([
        { ...entry(), repository_id: "123456789", repository_owner_id: "98765" },
        second,
        key,
      ]);
      expect(after?.grants).toEqual(record.grants);
    });

    it("pins through the _ login and keeps the gh-repo index", async () => {
      const repository = `${project}/sdk`;
      const own = { ...record, auth: [entry({ repository })] };
      await putCredential(env, own);
      await syncGhRepoIndex(env, null, own);
      const jwt = await signJwt(githubClaims({ repository }));
      const result = await authenticate(request(`Bearer _:gh.${jwt}`), authEnv(), {
        ...deps,
        kindHint: "publish",
      });
      expect(result?.identity.project).toBe(project);
      expect(await stored()).toMatchObject({ repository_id: "123456789" });
      expect(await env.AUTH.get(`gh-repo:${repository}`, "json")).toEqual([project]);
    });
  });

  it("rejects a wrong repository", async () => {
    const jwt = await signJwt(githubClaims({ repository: "acme/other" }));
    expect(await authenticate(bearer(jwt), authEnv(), deps)).toBeNull();
  });

  it("rejects a wrong audience", async () => {
    const jwt = await signJwt(githubClaims({ aud: "https://elsewhere.test" }));
    expect(await authenticate(bearer(jwt), authEnv(), deps)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const jwt = await signJwt(githubClaims({ exp: NOW_SEC - 10 }));
    expect(await authenticate(bearer(jwt), authEnv(), deps)).toBeNull();
  });

  it("rejects a bad signature", async () => {
    const jwt = await signJwt(githubClaims(), { key: otherKey });
    expect(await authenticate(bearer(jwt), authEnv(), deps)).toBeNull();
  });

  it("matches ref exactly when set and any ref when null", async () => {
    const tag = await signJwt(githubClaims({ ref: "refs/tags/v1.0.0" }));
    expect(await authenticate(bearer(tag), authEnv(), deps)).toBeNull();

    await putCredential(env, { ...record, auth: [entry({ ref: null })] });
    expect(await authenticate(bearer(tag), authEnv(), deps)).not.toBeNull();
  });

  it("matches workflow against the workflow_ref path when set", async () => {
    const release = ".github/workflows/release.yml";
    await putCredential(env, { ...record, auth: [entry({ workflow: release })] });
    expect(
      await authenticate(bearer(await signJwt(githubClaims())), authEnv(), deps),
    ).not.toBeNull();
    const other = await signJwt(
      githubClaims({
        workflow: "Release",
        workflow_ref: "acme/shop-frontend/.github/workflows/nightly.yml@refs/heads/main",
      }),
    );
    expect(await authenticate(bearer(other), authEnv(), deps)).toBeNull();
  });

  it("matches repository_id, repository_owner_id and environment when set", async () => {
    await putCredential(env, {
      ...record,
      auth: [entry({ repository_id: "123456789", environment: "production" })],
    });
    const prod = await signJwt(githubClaims({ environment: "production" }));
    expect(await authenticate(bearer(prod), authEnv(), deps)).not.toBeNull();
    const staging = await signJwt(githubClaims({ environment: "staging" }));
    expect(await authenticate(bearer(staging), authEnv(), deps)).toBeNull();
    const reused = await signJwt(githubClaims({ environment: "production", repository_id: "555" }));
    expect(await authenticate(bearer(reused), authEnv(), deps)).toBeNull();
  });

  it("ignores expired gh entries and picks an active match", async () => {
    const expired = entry({ expires: "2026-10-01" });
    const active = entry({ ref: null, created: "2026-10-27T00:00:00Z" });
    await putCredential(env, { ...record, auth: [expired, active] });
    const result = await authenticate(bearer(await signJwt(githubClaims())), authEnv(), deps);
    expect(result?.identity.entryId).toBe(await authEntryId(active));
  });

  it("does not accept a JWT against key entries", async () => {
    await putCredential(env, {
      ...record,
      auth: [{ type: "key", hash: await hashSecret("x"), created: "2026-10-28", expires: null }],
    });
    expect(await authenticate(bearer(await signJwt(githubClaims())), authEnv(), deps)).toBeNull();
  });
});

describe("authenticate with the _ login", () => {
  let f: FakeFetch;
  let deps: AuthDeps;
  let repo: string;

  const gh = (overrides: Partial<GhAuthRecord> = {}): GhAuthRecord => ({
    type: "gh",
    repository: repo,
    ref: null,
    workflow: null,
    created: "2026-10-28T09:05:00Z",
    expires: null,
    ...overrides,
  });

  async function store(project: string, kind: Kind, ...auth: GhAuthRecord[]) {
    const record: CredentialRecord = recordOf(project, kind, auth);
    await putCredential(env, record);
    await syncGhRepoIndex(env, null, record);
    return record;
  }

  const resolve = async (jwt: string, kindHint?: "read" | "publish", d = deps) =>
    authenticate(request(`Bearer _:gh.${jwt}`), authEnv(), { ...d, kindHint });

  beforeEach(async () => {
    jwksCache = memoryCache();
    f = fakeFetch();
    deps = { fetch: f.fetch, now: () => NOW, cache: jwksCache };
    repo = `${uniqueProject("owner")}/sdk`;
  });

  it("resolves the read credential by default and the publish one when asked", async () => {
    const reader = uniqueProject("reader");
    const publisher = uniqueProject("publisher");
    await store(reader, "read", gh());
    await store(publisher, "publish", gh({ ref: "refs/heads/*" }));
    const jwt = await signJwt(githubClaims({ repository: repo }));

    const read = await resolve(jwt);
    expect(read?.identity.project).toBe(reader);
    expect(read?.identity.roles).toEqual(["read"]);
    expect(read?.via).toBe("gh");
    const publish = await resolve(jwt, "publish");
    expect(publish?.identity.project).toBe(publisher);
    expect(publish?.identity.entryId).toBe(await authEntryId(gh({ ref: "refs/heads/*" })));
  });

  it("finds owner globs and matches the repository case-insensitively", async () => {
    const owner = repo.split("/")[0] ?? "";
    const project = uniqueProject("glob");
    await store(project, "read", gh({ repository: `${owner.toUpperCase()}/*` }));
    const jwt = await signJwt(githubClaims({ repository: repo.toUpperCase() }));
    expect((await resolve(jwt))?.identity.project).toBe(project);
  });

  it("answers null when nothing of the kind matches", async () => {
    await store(uniqueProject("other-ref"), "read", gh({ ref: "refs/tags/v*" }));
    await store(uniqueProject("publisher"), "publish", gh());
    await store(uniqueProject("admin"), "admin", gh());
    const jwt = await signJwt(githubClaims({ repository: repo }));
    expect(await resolve(jwt)).toBeNull();
    expect(await resolve(await signJwt(githubClaims({ repository: "nobody/here" })))).toBeNull();
  });

  it("ignores expired entries and stale index entries", async () => {
    await store(uniqueProject("expired"), "read", gh({ expires: "2026-10-01" }));
    await env.AUTH.put(`gh-repo:${repo}`, JSON.stringify(["missing-project"]));
    expect(await resolve(await signJwt(githubClaims({ repository: repo })))).toBeNull();
  });

  it("refuses several matches with a message naming the fix", async () => {
    await store(uniqueProject("one"), "read", gh());
    await store(uniqueProject("two"), "read", gh({ ref: "refs/heads/main" }));
    const jwt = await signJwt(githubClaims({ repository: repo }));
    const err = await resolve(jwt).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({
      code: "unauthorized",
      message: "more than one project matches this token; use <project>:gh.<jwt>",
    });
    expect(String((err as Error).message)).not.toContain(jwt);
  });

  it("separates read and publish credentials whose entries are both empty", async () => {
    const reader = uniqueProject("reader");
    const publisher = uniqueProject("publisher");
    await store(reader, "read", gh());
    await store(publisher, "publish", gh());
    const jwt = await signJwt(githubClaims({ repository: repo }));
    expect((await resolve(jwt))?.identity.project).toBe(reader);
    expect((await resolve(jwt, "read"))?.identity.project).toBe(reader);
    expect((await resolve(jwt, "publish"))?.identity.project).toBe(publisher);
  });

  it("refuses two publish credentials for the same repository", async () => {
    const reader = uniqueProject("reader");
    await store(reader, "read", gh());
    await store(uniqueProject("one"), "publish", gh());
    await store(uniqueProject("two"), "publish", gh());
    const jwt = await signJwt(githubClaims({ repository: repo }));
    const err = await resolve(jwt, "publish").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({
      code: "unauthorized",
      message: "more than one project matches this token; use <project>:gh.<jwt>",
    });
    expect((await resolve(jwt))?.identity.project).toBe(reader);
  });

  it("tells credentials of one repository apart by workflow", async () => {
    const release = uniqueProject("release");
    const docs = uniqueProject("docs");
    await store(release, "publish", gh({ workflow: ".github/workflows/release.yml" }));
    await store(docs, "publish", gh({ workflow: ".github/workflows/docs.yml" }));
    const from = (file: string) =>
      signJwt(
        githubClaims({
          repository: repo,
          workflow_ref: `${repo}/.github/workflows/${file}@refs/heads/main`,
        }),
      );
    expect((await resolve(await from("release.yml"), "publish"))?.identity.project).toBe(release);
    expect((await resolve(await from("docs.yml"), "publish"))?.identity.project).toBe(docs);
    expect(await resolve(await from("nightly.yml"), "publish")).toBeNull();
  });

  it("treats an any-workflow entry as overlapping a specific one", async () => {
    const anyWorkflow = uniqueProject("any");
    await store(anyWorkflow, "publish", gh());
    await store(
      uniqueProject("release"),
      "publish",
      gh({ workflow: ".github/workflows/release.yml" }),
    );
    const from = (file: string) =>
      signJwt(
        githubClaims({
          repository: repo,
          workflow_ref: `${repo}/.github/workflows/${file}@refs/heads/main`,
        }),
      );
    const err = await resolve(await from("release.yml"), "publish").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unauthorized" });
    expect((await resolve(await from("other.yml"), "publish"))?.identity.project).toBe(anyWorkflow);
  });

  it("rejects an invalid token before looking at the index", async () => {
    await store(uniqueProject("reader"), "read", gh());
    const jwt = await signJwt(githubClaims({ repository: repo }), { key: otherKey });
    expect(await resolve(jwt)).toBeNull();
  });

  it("accepts the same token again and in its explicit form", async () => {
    const project = uniqueProject("again");
    await store(project, "read", gh());
    const jwt = await signJwt(githubClaims({ repository: repo }));
    expect((await resolve(jwt))?.identity.project).toBe(project);
    expect((await resolve(jwt))?.identity.project).toBe(project);
    const named = await authenticate(request(`Bearer ${project}:gh.${jwt}`), authEnv(), deps);
    expect(named?.identity.project).toBe(project);
    expect(f.calls).toHaveLength(1);
  });
});

describe("panel sessions", () => {
  const SESSION_SECRET = "unit-test-session-secret";
  const sessionEnv = { SESSION_SECRET };
  const withCookie = (cookie: string) =>
    new Request("https://registry.test/", { headers: { cookie } });

  function decodePayload(value: string): unknown {
    const payload = value.split(".")[0] ?? "";
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)));
  }

  it("signs { typ, project, exp } and reads it back until it expires", async () => {
    const value = await createSession(sessionEnv, "shop-frontend", { now: () => NOW });
    expect(value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(decodePayload(value)).toEqual({
      typ: "sess",
      project: "shop-frontend",
      exp: NOW_SEC + 43200,
    });

    const cookie = withCookie(`theme=dark; sreg_session=${value}; x=1`);
    expect(await readSession(cookie, sessionEnv, { now: () => NOW })).toEqual({
      project: "shop-frontend",
      exp: NOW_SEC + 43200,
    });
    const almost = { now: () => NOW + 43_199_000 };
    expect(await readSession(cookie, sessionEnv, almost)).not.toBeNull();
    const expired = { now: () => NOW + 43_200_000 };
    expect(await readSession(cookie, sessionEnv, expired)).toBeNull();
    expect((await env.AUTH.list({ prefix: "session:" })).keys).toEqual([]);
  });

  it("refuses another secret, a changed payload and a changed signature", async () => {
    const value = await createSession(sessionEnv, "shop", { now: () => NOW });
    const deps = { now: () => NOW };
    const [payload = "", signature = ""] = value.split(".");
    const other = await createSession({ SESSION_SECRET: "other" }, "admin", deps);
    const otherPayload = other.split(".")[0] ?? "";
    for (const forged of [
      `${otherPayload}.${signature}`,
      `${payload}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`,
      other,
    ]) {
      expect(await readSession(withCookie(`sreg_session=${forged}`), sessionEnv, deps)).toBeNull();
    }
  });

  it("needs SESSION_SECRET", async () => {
    const value = await createSession(sessionEnv, "shop", { now: () => NOW });
    const err = await createSession({}, "shop").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "internal_error" });
    expect((err as Error).message).toContain("SESSION_SECRET");
    expect(await createSession({ SESSION_SECRET: "  " }, "shop").catch(() => null)).toBeNull();
    expect(await readSession(withCookie(`sreg_session=${value}`), {})).toBeNull();
  });

  it("ignores missing and malformed session cookies", async () => {
    expect(await readSession(new Request("https://registry.test/"), sessionEnv)).toBeNull();
    expect(await readSession(withCookie("other=1"), sessionEnv)).toBeNull();
    expect(await readSession(withCookie("sreg_session=short"), sessionEnv)).toBeNull();
    expect(await readSession(withCookie(`sreg_session=${"A".repeat(32)}`), sessionEnv)).toBeNull();
    const notJson = `${btoa("nope")}.${"A".repeat(43)}`;
    expect(await readSession(withCookie(`sreg_session=${notJson}`), sessionEnv)).toBeNull();
  });

  it("extracts the cookie value", () => {
    const value = `abc.${"C".repeat(43)}`;
    expect(sessionValueFrom(withCookie(`sreg_session=${value}`))).toBe(value);
    expect(sessionValueFrom(withCookie(` a=b ;  sreg_session = ${value} `))).toBe(value);
    expect(sessionValueFrom(withCookie(`xsreg_session=${value}`))).toBeNull();
    expect(sessionValueFrom(withCookie("sreg_session=abc"))).toBeNull();
  });

  it("resolves a session to the identity of its credential", async () => {
    const now = Date.parse("2026-10-28T12:00:00Z");
    const deps = { now: () => now };
    const both = { AUTH: env.AUTH, SESSION_SECRET };
    await putCredential(
      env,
      legacy({
        project: "session-reader",
        kind: "read",
        auth: [{ type: "key", hash: await hashSecret(KEY), created: "2026-01-01", expires: null }],
        grants: [{ eco: "composer", package: "acme/*", versions: "*", transitive: true }],
      }),
    );
    const value = await createSession(sessionEnv, "session-reader", deps);
    const cookie = withCookie(`sreg_session=${value}`);
    const found = await sessionIdentity(cookie, both, deps);
    expect(found?.session.project).toBe("session-reader");
    expect(found?.identity).toMatchObject({ project: "session-reader", roles: ["read"] });
    expect(found?.identity.grants.read).toHaveLength(1);

    await putCredential(
      env,
      legacy({
        project: "session-reader",
        kind: "read",
        auth: [
          {
            type: "key",
            hash: await hashSecret(KEY),
            created: "2026-01-01",
            expires: "2026-10-01",
          },
        ],
        grants: [],
      }),
    );
    expect(await sessionIdentity(cookie, both, deps)).toBeNull();

    await deleteCredential(env, "session-reader");
    expect(await sessionIdentity(cookie, both, deps)).toBeNull();
    expect(await sessionIdentity(new Request("https://registry.test/"), both, deps)).toBeNull();
  });

  it("builds secure cookies", () => {
    expect(sessionCookie("abc")).toBe(
      "sreg_session=abc; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200",
    );
    expect(clearSessionCookie()).toBe(
      "sreg_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
    );
  });
});
