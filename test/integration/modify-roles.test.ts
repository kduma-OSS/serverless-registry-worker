import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createCredential } from "../../src/core/admin";
import type { Grant } from "../../src/core/grants";
import { ORIGIN, call, credential, publishComposer, type ErrorBody } from "./helpers";
import { callWithPublicUrl, githubJwt, installGithubKey } from "./oidc";

// The `yank` and `delete` roles (docs/api.md 2.4): a credential may yank or delete what its
// grants of that role cover, without being an admin. The tests of this file run in order.

const PASSWORD = "correct-horse-battery";
const ALL: Grant = { eco: "composer", package: "acme/*", versions: "*" };

let admin = "";
let ci = "";
let yanker = "";
let deleter = "";

async function create(body: Record<string, unknown>): Promise<Response> {
  return call("POST", "/api/v1/credentials", { token: admin, body });
}

const yankUrl = (name: string, version: string) =>
  `/api/v1/packages/composer/${encodeURIComponent(name)}/${version}/yank`;
const versionUrl = (name: string, version: string) =>
  `/api/v1/packages/composer/${encodeURIComponent(name)}/${version}`;
const packageUrl = (name: string) => `/api/v1/packages/composer/${encodeURIComponent(name)}`;

async function yanked(name: string): Promise<Record<string, boolean>> {
  const res = await call("GET", packageUrl(name), { token: admin });
  if (res.status !== 200) return {};
  const body = await res.json<{ versions: { version: string; yanked: boolean }[] }>();
  return Object.fromEntries(body.versions.map((v) => [v.version, v.yanked]));
}

beforeAll(async () => {
  admin = await credential("mod-admin", "admin");
  await installGithubKey();
  ci = await credential("mod-ci", "publish", [ALL]);
  for (const name of ["acme/one", "acme/two", "other/lib"]) {
    for (const version of ["1.0.0", "1.1.0"]) {
      expect(
        (
          await publishComposer(
            await credential(`mod-pub-${name.replace("/", "-")}`, "publish", [
              { eco: "composer", package: name, versions: "*" },
            ]),
            name,
            version,
          )
        ).status,
      ).toBe(201);
    }
  }
});

describe("creating credentials with yank and delete roles", () => {
  it("takes yank_grants and delete_grants and reports them", async () => {
    const res = await create({
      project: "cleaner",
      roles: ["yank", "delete"],
      yank_grants: [{ eco: "composer", package: "acme/*", versions: "*" }],
      delete_grants: [{ eco: "composer", package: "acme/one", versions: "*" }],
      secret: { type: "key", scope: ["yank"] },
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ token: string; credential: Record<string, unknown> }>();
    yanker = body.token;
    expect(body.credential).toMatchObject({
      roles: ["yank", "delete"],
      kind: "yank",
      yank_grants: [{ ...ALL, transitive: true }],
      delete_grants: [{ eco: "composer", package: "acme/one", versions: "*" }],
      read_grants: [],
      publish_grants: [],
    });
    const second = await call("POST", "/api/v1/credentials/cleaner/secrets", {
      token: admin,
      body: { type: "key", scope: ["delete"] },
    });
    expect(second.status).toBe(201);
    deleter = (await second.json<{ token: string }>()).token;
  });

  it("refuses grants for a role the credential does not hold", async () => {
    const res = await create({
      project: "no-delete",
      roles: ["yank"],
      yank_grants: [ALL],
      delete_grants: [ALL],
      secret: null,
    });
    expect(res.status).toBe(400);
    expect((await res.json<ErrorBody>()).message).toContain("delete_grants");
  });

  it("reports the role and its grants from whoami", async () => {
    const res = await call("GET", "/api/v1/whoami", { token: yanker });
    expect(await res.json()).toMatchObject({
      kind: "yank",
      roles: ["yank"],
      access: { yank: [{ eco: "composer", package: "acme/*", versions: "*" }] },
    });
  });
});

describe("yank with the yank role", () => {
  it("yanks a version its grants cover", async () => {
    const res = await call("POST", yankUrl("acme/two", "1.1.0"), { token: yanker });
    expect(res.status).toBe(200);
    expect(await yanked("acme/two")).toEqual({ "1.0.0": false, "1.1.0": true });
  });

  it("answers 403 outside its grants", async () => {
    const res = await call("POST", yankUrl("other/lib", "1.0.0"), { token: yanker });
    expect(res.status).toBe(403);
    expect((await res.json<ErrorBody>()).message).toContain("yank grants");
    expect(await yanked("other/lib")).toEqual({ "1.0.0": false, "1.1.0": false });
  });

  it("answers 403 to everything else a yank credential is not allowed to do", async () => {
    const denied: [string, string, unknown?][] = [
      ["DELETE", versionUrl("acme/one", "1.0.0")],
      ["DELETE", packageUrl("acme/one")],
      ["POST", `${packageUrl("acme/one")}/reindex`, {}],
      ["GET", "/api/v1/credentials"],
      ["POST", "/api/v1/credentials", { project: "x", kind: "read" }],
      ["POST", "/api/v1/publish/init", {}],
    ];
    for (const [method, path, body] of denied) {
      const res = await call(method, path, { token: yanker, body });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect((await call("GET", "/composer/packages.json", { token: yanker })).status).toBe(403);
  });

  it("does not let a delete-scoped secret yank", async () => {
    expect((await call("POST", yankUrl("acme/one", "1.0.0"), { token: deleter })).status).toBe(403);
  });

  it("lets an admin yank anywhere", async () => {
    expect((await call("POST", yankUrl("other/lib", "1.0.0"), { token: admin })).status).toBe(200);
  });
});

describe("delete with the delete role", () => {
  it("deletes a version its grants cover", async () => {
    const res = await call("DELETE", versionUrl("acme/one", "1.0.0"), { token: deleter });
    expect(res.status).toBe(200);
    expect(await yanked("acme/one")).toEqual({ "1.1.0": false });
  });

  it("answers 403 outside its grants", async () => {
    const res = await call("DELETE", versionUrl("acme/two", "1.0.0"), { token: deleter });
    expect(res.status).toBe(403);
    expect((await res.json<ErrorBody>()).message).toContain("delete grants");
  });

  it("deletes a whole package only with a grant for all of its versions", async () => {
    const narrow = await create({
      project: "narrow-deleter",
      roles: ["delete"],
      delete_grants: [{ eco: "composer", package: "acme/two", versions: "^1.0" }],
      secret: { type: "key" },
    });
    const token = (await narrow.json<{ token: string }>()).token;
    // The constraint covers a version, but not the package as a whole.
    expect((await call("DELETE", versionUrl("acme/two", "1.0.0"), { token })).status).toBe(200);
    expect((await call("DELETE", packageUrl("acme/two"), { token })).status).toBe(403);

    expect((await call("DELETE", packageUrl("acme/one"), { token: deleter })).status).toBe(200);
    expect(await yanked("acme/one")).toEqual({});
  });

  it("does not let a yank-scoped secret delete", async () => {
    expect((await call("DELETE", versionUrl("acme/two", "1.1.0"), { token: yanker })).status).toBe(
      403,
    );
  });
});

describe("listing for yank and delete credentials", () => {
  it("shows only the versions their grants cover and no dependencies", async () => {
    const list = await call("GET", "/api/v1/packages", { token: yanker });
    expect(list.status).toBe(200);
    const { packages } = await list.json<{
      packages: { name: string; dependencies?: unknown }[];
    }>();
    expect(packages.map((p) => p.name)).toEqual(["acme/two"]);
    expect(packages[0]?.dependencies).toBeUndefined();
    expect((await call("GET", packageUrl("acme/two"), { token: yanker })).status).toBe(200);
    expect((await call("GET", packageUrl("other/lib"), { token: yanker })).status).toBe(404);
  });

  it("does not use the read grants of a credential for a secret scoped to yank", async () => {
    const res = await create({
      project: "reader-yanker",
      roles: ["read", "yank"],
      read_grants: [{ eco: "composer", package: "other/*", versions: "*" }],
      yank_grants: [{ eco: "composer", package: "acme/two", versions: "*" }],
      secret: { type: "key", scope: ["yank"] },
    });
    const token = (await res.json<{ token: string }>()).token;
    const list = await call("GET", "/api/v1/packages", { token });
    const { packages } = await list.json<{ packages: { name: string }[] }>();
    expect(packages.map((p) => p.name)).toEqual(["acme/two"]);
  });
});

describe("editing the roles of a credential", () => {
  it("replaces the grants of one role without touching the others", async () => {
    const res = await call("PATCH", "/api/v1/credentials/cleaner", {
      token: admin,
      body: { yank_grants: [{ eco: "composer", package: "other/*", versions: "*" }] },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      yank_grants: [{ eco: "composer", package: "other/*" }],
      delete_grants: [{ eco: "composer", package: "acme/one" }],
    });
  });

  it("drops the grants of a role that is removed", async () => {
    const created = await create({
      project: "to-trim",
      roles: ["read", "yank"],
      yank_grants: [ALL],
      secret: null,
    });
    expect(created.status).toBe(201);
    const res = await call("PATCH", "/api/v1/credentials/to-trim", {
      token: admin,
      body: { roles: ["read"] },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ roles: ["read"], yank_grants: [] });
  });
});

describe("browser login with the yank role", () => {
  async function operator(roles: string[], grants: Record<string, unknown>) {
    const project = `ops-${roles.join("-")}-${Math.random().toString(36).slice(2, 8)}`;
    await createCredential(
      env,
      { project, roles, ...grants, secret: { type: "login", password: PASSWORD } },
      new Date(),
    );
    return project;
  }

  interface Created {
    session: string;
    url: string;
    poll_token: string;
  }

  async function session(purpose: string, scopes: unknown[]): Promise<Created> {
    const res = await call("POST", "/api/v1/auth/sessions", { body: { purpose, scopes } });
    expect(res.status).toBe(201);
    return res.json<Created>();
  }

  const authorize = (
    created: Created,
    action: string,
    form?: Record<string, string>,
    cookie = "",
  ) =>
    exports.default.fetch(
      new Request(`${ORIGIN}${new URL(created.url).pathname}${action === "" ? "" : `/${action}`}`, {
        method: form === undefined ? "GET" : "POST",
        headers: {
          ...(cookie === "" ? {} : { cookie }),
          ...(form === undefined
            ? {}
            : { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN }),
        },
        body: form === undefined ? undefined : new URLSearchParams(form).toString(),
        redirect: "manual",
      }),
    );

  const cookieOf = (res: Response) =>
    (res.headers.getSetCookie().find((c) => c.startsWith("sreg_session=")) ?? "").split(";")[0] ??
    "";

  it("approves a yank within the grants and issues a token for that version only", async () => {
    for (const version of ["1.0.0", "1.1.0"]) {
      expect((await publishComposer(ci, "acme/login", version)).status).toBe(201);
    }
    const project = await operator(["yank"], { yank_grants: [ALL] });
    const created = await session("yank", [
      { eco: "composer", package: "acme/login", version: "1.0.0" },
    ]);
    const signedIn = await authorize(created, "login", { project, password: PASSWORD });
    expect(signedIn.status).toBe(303);
    const cookie = cookieOf(signedIn);
    expect(cookie).not.toBe("");
    expect((await authorize(created, "approve", {}, cookie)).status).toBe(200);

    const polled = await call("POST", "/api/v1/auth/sessions/poll", {
      body: { session: created.session, poll_token: created.poll_token },
    });
    expect(polled.status).toBe(200);
    const issued = await polled.json<{ token: string; kind: string }>();
    expect(issued.kind).toBe("yank");

    const who = await call("GET", "/api/v1/whoami", { token: issued.token });
    expect(await who.json()).toMatchObject({
      roles: ["yank"],
      ops: [{ op: "yank", eco: "composer", package: "acme/login", version: "1.0.0" }],
    });
    expect(
      (await call("POST", yankUrl("acme/login", "1.1.0"), { token: issued.token })).status,
    ).toBe(403);
    expect(
      (await call("POST", yankUrl("acme/login", "1.0.0"), { token: issued.token })).status,
    ).toBe(200);
  });

  it("offers no approval for a version outside the grants", async () => {
    const project = await operator(["yank"], {
      yank_grants: [{ eco: "composer", package: "acme/two", versions: "*" }],
    });
    const created = await session("yank", [
      { eco: "composer", package: "other/lib", version: "1.1.0" },
    ]);
    const cookie = cookieOf(await authorize(created, "login", { project, password: PASSWORD }));
    const page = await authorize(created, "", undefined, cookie);
    expect(await page.text()).toContain("grants do not allow every operation");
    // The approval request checks again.
    const approve = await authorize(created, "approve", {}, cookie);
    expect(approve.status).not.toBe(200);
    const polled = await call("POST", "/api/v1/auth/sessions/poll", {
      body: { session: created.session, poll_token: created.poll_token },
    });
    expect(polled.status).toBe(202);
  });

  it("does not approve a delete with only the yank role", async () => {
    const project = await operator(["yank"], { yank_grants: [ALL] });
    const created = await session("delete", [
      { eco: "composer", package: "acme/two", version: "1.0.0" },
    ]);
    const cookie = cookieOf(await authorize(created, "login", { project, password: PASSWORD }));
    expect(await (await authorize(created, "", undefined, cookie)).text()).toContain(
      "neither the admin nor the delete role",
    );
  });

  it("does not sign in a yank-only login for a pull or to the panel", async () => {
    const project = await operator(["yank"], { yank_grants: [ALL] });
    const pull = await call("POST", "/api/v1/auth/sessions", { body: { purpose: "pull" } });
    const created = await pull.json<Created>();
    const refused = await authorize(created, "login", { project, password: PASSWORD });
    expect(cookieOf(refused)).toBe("");

    const panel = await exports.default.fetch(
      new Request(`${ORIGIN}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
        body: new URLSearchParams({ login: project, password: PASSWORD }).toString(),
        redirect: "manual",
      }),
    );
    expect(cookieOf(panel)).toBe("");
  });
});

describe("the _ login with a yank gh secret", () => {
  it("yanks within the grants from a GitHub Actions job", async () => {
    expect((await publishComposer(ci, "acme/gh-yank", "1.0.0")).status).toBe(201);
    const res = await create({
      project: "gh-yanker",
      roles: ["yank"],
      yank_grants: [{ eco: "composer", package: "acme/gh-yank", versions: "*" }],
      secret: { type: "gh", repository: "acme/ghyank" },
    });
    expect(res.status).toBe(201);
    const jwt = await githubJwt("acme/ghyank");
    const callGh = (method: string, path: string) =>
      callWithPublicUrl(
        new Request(`${ORIGIN}${path}`, {
          method,
          headers: { authorization: `Bearer _:gh.${jwt}`, "content-type": "application/json" },
          body: method === "GET" ? undefined : "{}",
        }),
      );
    expect((await callGh("POST", yankUrl("acme/gh-yank", "1.0.0"))).status).toBe(200);
    // No credential of this repository holds `delete`, so the `_` login resolves to nothing.
    expect((await callGh("DELETE", versionUrl("acme/gh-yank", "1.0.0"))).status).toBe(401);
    expect((await callGh("POST", yankUrl("acme/other", "1.1.0"))).status).toBe(403);
    expect(await yanked("acme/gh-yank")).toEqual({ "1.0.0": true });
  });
});
