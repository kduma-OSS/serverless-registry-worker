import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addSecret, createCredential, updateGrants, updateSecret } from "../../src/core/admin";
import { approvalProblem, decideLoginSession, readDecision } from "../../src/core/login";
import {
  authEntryId,
  authenticate,
  createSession,
  effectiveRoles,
  getCredential,
  grantsFor,
  hashSecret,
  issueLoginToken,
  legacyGrants,
  listCredentials,
  primaryKind,
  putCredential,
  sessionIdentity,
  verifyLoginToken,
  type AuthRecordEntry,
  type CredentialRecord,
  type Kind,
} from "../../src/core/auth";
import { ValidationError } from "../../src/core/errors";
import type { Grant } from "../../src/core/grants";

const NOW = new Date("2026-10-28T10:12:00Z");
const GRANT: Grant = { eco: "npm", package: "@acme/*", versions: "*", transitive: true };
const SECRET = "k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e";

let counter = 0;
function unique(base: string): string {
  counter += 1;
  return `${base}${counter}`;
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

async function keyEntry(secret: string, scope?: Kind[]): Promise<AuthRecordEntry> {
  const entry: AuthRecordEntry = {
    type: "key",
    hash: await hashSecret(secret),
    created: "2026-01-01",
    expires: null,
  };
  return scope === undefined ? entry : { ...entry, scope };
}

const request = (token: string) =>
  new Request("https://registry.test/", { headers: { authorization: `Bearer ${token}` } });
const authEnv = { AUTH: env.AUTH, PUBLIC_URL: undefined, TOKEN_PREFIX: undefined };

describe("stored credential records", () => {
  it("reads a record written with kind and flat grants as roles and per-role grants", async () => {
    const stored = (kind: string) => ({ project: "p", kind, auth: [], grants: [GRANT] });
    await env.AUTH.put(
      "cred:legacy-read",
      JSON.stringify({ ...stored("read"), project: "legacy-read" }),
    );
    await env.AUTH.put(
      "cred:legacy-pub",
      JSON.stringify({ ...stored("publish"), project: "legacy-pub" }),
    );
    const reader = await getCredential(env, "legacy-read", { fresh: true });
    expect(reader).toEqual({
      project: "legacy-read",
      roles: ["read"],
      auth: [],
      grants: { read: [GRANT], publish: [], yank: [], delete: [] },
    });
    const publisher = await getCredential(env, "legacy-pub", { fresh: true });
    expect(publisher?.roles).toEqual(["publish"]);
    expect(publisher?.grants).toEqual({ read: [], publish: [GRANT], yank: [], delete: [] });
  });

  it("rejects role sets that are not allowed", async () => {
    for (const roles of [[], ["admin", "admin"], ["read", "read"], ["owner"]]) {
      const name = unique("badroles");
      const record = { project: name, roles, auth: [], grants: { read: [], publish: [] } };
      await env.AUTH.put(`cred:${name}`, JSON.stringify(record));
      expect(await getCredential(env, name, { fresh: true })).toBeNull();
    }
  });
});

describe("roles of a secret", () => {
  const dual: CredentialRecord = {
    project: "dual-roles",
    roles: ["read", "publish"],
    auth: [],
    grants: { read: [GRANT], publish: [], yank: [], delete: [] },
  };

  it("defaults to every role of the credential and stays within them", () => {
    expect(effectiveRoles(dual, {})).toEqual(["read", "publish"]);
    expect(effectiveRoles(dual, { scope: ["publish"] })).toEqual(["publish"]);
    expect(effectiveRoles({ roles: ["read"] }, { scope: ["read", "publish"] })).toEqual(["read"]);
    expect(effectiveRoles(dual, { scope: [] })).toEqual([]);
  });

  it("reports the legacy kind and grants as the read side first", () => {
    expect(primaryKind(["read", "publish"])).toBe("read");
    expect(primaryKind(["publish"])).toBe("publish");
    expect(primaryKind(["admin"])).toBe("admin");
    expect(primaryKind(["read", "admin"])).toBe("admin");
    expect(primaryKind(["publish", "admin"])).toBe("admin");
    expect(legacyGrants(["read", "publish"], dual.grants)).toEqual([GRANT]);
    expect(legacyGrants(["admin"], dual.grants)).toEqual([]);
    expect(legacyGrants(["read", "admin"], dual.grants)).toEqual([]);
    expect(grantsFor(["publish"], dual.grants, "read")).toEqual([]);
  });

  it("limits what authenticate lets a key use", async () => {
    const name = unique("scoped");
    const read = "R".repeat(32);
    const publish = "P".repeat(32);
    const all = "A".repeat(32);
    const none = "N".repeat(32);
    await putCredential(env, {
      ...dual,
      project: name,
      auth: [
        await keyEntry(read, ["read"]),
        await keyEntry(publish, ["publish"]),
        await keyEntry(all),
        await keyEntry(none, []),
      ],
    });
    const roles = async (secret: string) =>
      (await authenticate(request(`${name}:${secret}`), authEnv))?.identity.roles ?? null;
    expect(await roles(read)).toEqual(["read"]);
    expect(await roles(publish)).toEqual(["publish"]);
    expect(await roles(all)).toEqual(["read", "publish"]);
    expect(await roles(none)).toBeNull();
  });

  it("never gives a panel session the publish role", async () => {
    const name = unique("session");
    await putCredential(env, { ...dual, project: name, auth: [await keyEntry(SECRET)] });
    const sessionEnv = { AUTH: env.AUTH, SESSION_SECRET: "unit-test-session-secret" };
    const value = await createSession(sessionEnv, name);
    const cookie = new Request("https://registry.test/", {
      headers: { cookie: `sreg_session=${value}` },
    });
    const found = await sessionIdentity(cookie, sessionEnv);
    expect(found?.identity.roles).toEqual(["read"]);
  });
});

describe("secrets of a credential with both roles", () => {
  async function dualCredential(): Promise<string> {
    const project = unique("adm-dual-");
    await createCredential(
      env,
      {
        project,
        roles: ["read", "publish"],
        read_grants: [{ eco: "npm", package: "@acme/*", versions: "*" }],
        publish_grants: [{ eco: "npm", package: "@acme/sdk", versions: "*" }],
        secret: { type: "key", scope: ["read"] },
      },
      NOW,
    );
    return project;
  }

  it("takes a scope within the credential's roles", async () => {
    const project = await dualCredential();
    expect(await code(addSecret(env, project, { type: "key" }, NOW))).toBe("invalid_request");
    for (const scope of [[], ["admin"], ["read", "read"], "read"]) {
      expect(await code(addSecret(env, project, { type: "key", scope }, NOW))).toBe(
        "invalid_request",
      );
    }
    const added = await addSecret(env, project, { type: "key", scope: ["publish", "read"] }, NOW);
    expect(added.secret.scope).toEqual(["read", "publish"]);
  });

  it("allows identical gh claims only for different scopes", async () => {
    const project = await dualCredential();
    const gh = { type: "gh", repository: "acme/dual" };
    await addSecret(env, project, { ...gh, scope: ["read"] }, NOW);
    expect(await code(addSecret(env, project, { ...gh, scope: ["read"] }, NOW))).toBe(
      "invalid_request",
    );
    expect(await code(addSecret(env, project, { ...gh, scope: ["publish"] }, NOW))).toBe("ok");
  });

  it("takes grants only for roles the credential holds", async () => {
    const project = unique("one-role-");
    const body = { project, roles: ["read"], publish_grants: [GRANT] };
    expect(await code(createCredential(env, body, NOW))).toBe("invalid_request");
    const both = { project, roles: ["read", "publish"], grants: [GRANT] };
    expect(await code(createCredential(env, both, NOW))).toBe("invalid_request");
    expect(await code(createCredential(env, { project, kind: "read", roles: ["read"] }, NOW))).toBe(
      "invalid_request",
    );
  });

  it("takes no scope on an admin credential", async () => {
    const project = unique("adm-");
    const secret = { type: "key", scope: ["read"] };
    expect(await code(createCredential(env, { project, kind: "admin", secret }, NOW))).toBe(
      "invalid_request",
    );
  });
});

describe("changing the roles of a credential", () => {
  it("pins existing secrets to the roles they had when a role is added", async () => {
    const project = unique("grow-");
    await createCredential(env, { project, kind: "read" }, NOW);
    const patched = await updateGrants(
      env,
      project,
      { roles: ["read", "publish"], publish_grants: [GRANT] },
      NOW,
    );
    expect(patched.roles).toEqual(["read", "publish"]);
    expect(patched.auth.map((e) => e.scope)).toEqual([["read"]]);
    const stored = await getCredential(env, project, { fresh: true });
    expect(stored?.auth[0]?.scope).toEqual(["read"]);
  });

  it("drops the grants of a removed role and refuses to strand an active secret", async () => {
    const project = unique("shrink-");
    await createCredential(
      env,
      {
        project,
        roles: ["read", "publish"],
        read_grants: [GRANT],
        publish_grants: [GRANT],
        secret: { type: "key", scope: ["read", "publish"] },
      },
      NOW,
    );
    await addSecret(env, project, { type: "key", scope: ["publish"] }, NOW);
    expect(await code(updateGrants(env, project, { roles: ["read"] }, NOW))).toBe(
      "invalid_request",
    );
    const record = await getCredential(env, project, { fresh: true });
    expect(record?.roles).toEqual(["read", "publish"]);
  });
});

describe("login secrets of a credential with both roles", () => {
  const sessionEnv = { SESSION_SECRET: "unit-test-session-secret" };
  const loginEnv = { ...env, ...sessionEnv, PUBLIC_URL: "https://registry.test" };
  const scopes = [{ eco: "composer" as const, package: "acme/lib", version: "1.0.0" }];
  const exp = NOW.getTime() + 3_600_000;

  async function dualWithLogins() {
    const project = unique("dual-login-");
    await createCredential(
      env,
      {
        project,
        roles: ["read", "publish"],
        read_grants: [{ eco: "composer", package: "acme/*", versions: "*" }],
        publish_grants: [{ eco: "composer", package: "acme/*", versions: "*" }],
        secret: null,
      },
      NOW,
    );
    const add = async (scope: Kind[]) =>
      (await addSecret(env, project, { type: "login", password: "long-enough-pass", scope }, NOW))
        .secret.id;
    const reader = await add(["read"]);
    const publisher = await add(["publish"]);
    const both = await add(["read", "publish"]);
    const record = await getCredential(env, project, { fresh: true });
    if (record === null) throw new Error("missing credential");
    return { record, reader, publisher, both };
  }

  const secretOf = async (project: string, id: string, scopeList?: typeof scopes) =>
    (await issueLoginToken(loginEnv, project, id, exp, scopeList)).slice(project.length + 4);

  it("issues a token only for a role the login's scope includes", async () => {
    const { record, reader, publisher, both } = await dualWithLogins();
    const now = NOW.getTime();
    const check = async (id: string, list?: typeof scopes) =>
      verifyLoginToken(sessionEnv, record, await secretOf(record.project, id, list), now);
    expect((await check(reader))?.roles).toEqual(["read"]);
    expect(await check(reader, scopes)).toBeNull();
    expect((await check(publisher, scopes))?.roles).toEqual(["publish"]);
    expect(await check(publisher)).toBeNull();
    expect((await check(both))?.roles).toEqual(["read"]);
    expect((await check(both, scopes))?.roles).toEqual(["publish"]);
  });

  it("approves a login request only for a login whose scope covers its purpose", async () => {
    const { record, reader, publisher, both } = await dualWithLogins();
    const entryOf = async (id: string) => {
      for (const e of record.auth) if ((await authEntryId(e)) === id) return e;
      throw new Error("no such entry");
    };
    const pull = { purpose: "pull" as const, eco: "composer" as const, nonce: "n", exp: 0 };
    const publish = { purpose: "publish" as const, scopes, nonce: "n", exp: 0 };
    const problem = async (session: typeof pull | typeof publish, id: string) =>
      approvalProblem(env, session, record, await entryOf(id));
    expect(await problem(pull, reader)).toBeNull();
    expect(await problem(pull, both)).toBeNull();
    expect(await problem(pull, publisher)).toContain("scope does not include the read role");
    expect(await problem(publish, publisher)).toBeNull();
    expect(await problem(publish, both)).toBeNull();
    expect(await problem(publish, reader)).toContain("scope does not include the publish role");
  });

  it("stores no decision and issues no token when the login's scope lacks the role", async () => {
    const { record, reader } = await dualWithLogins();
    const refused = await decideLoginSession(
      loginEnv,
      {
        purpose: "publish",
        scopes,
        nonce: "scope-test",
        exp: Math.floor(NOW.getTime() / 1000) + 600,
      },
      record,
      reader,
      true,
      NOW,
    );
    expect(refused).toBe(false);
    expect(await readDecision(loginEnv, "scope-test")).toBeNull();
  });
});

describe("editing the scope of a secret", () => {
  async function dualKey(scope: Kind[] = ["read"]) {
    const project = unique("edit-scope-");
    await createCredential(
      env,
      {
        project,
        roles: ["read", "publish"],
        read_grants: [GRANT],
        publish_grants: [GRANT],
        secret: { type: "key", scope },
      },
      NOW,
    );
    const record = await getCredential(env, project, { fresh: true });
    const entry = record?.auth[0];
    if (record === null || entry === undefined) throw new Error("missing credential");
    return { project, record, id: await authEntryId(entry) };
  }

  it("changes the roles of the secret and nothing else", async () => {
    const { project, id } = await dualKey();
    const before = (await getCredential(env, project, { fresh: true }))?.auth[0];
    const { secret } = await updateSecret(env, project, id, { scope: ["publish", "read"] }, NOW);
    expect(secret).toMatchObject({ id, scope: ["read", "publish"] });
    const after = (await getCredential(env, project, { fresh: true }))?.auth[0];
    expect(after).toEqual({ ...before, scope: ["read", "publish"] });
    const narrowed = await updateSecret(env, project, id.slice(0, 8), { scope: ["publish"] }, NOW);
    expect(narrowed.secret.scope).toEqual(["publish"]);
  });

  it("is what the secret may do from the next request on", async () => {
    const project = unique("edit-live-");
    const created = await createCredential(
      env,
      {
        project,
        roles: ["read", "publish"],
        read_grants: [GRANT],
        publish_grants: [GRANT],
        secret: { type: "key", scope: ["read"] },
      },
      NOW,
    );
    const token = created.token ?? "";
    const roles = async () => (await authenticate(request(token), authEnv))?.identity.roles;
    expect(await roles()).toEqual(["read"]);
    const id = created.credential.auth[0]?.id ?? "";
    await updateSecret(env, project, id, { scope: ["read", "publish"] }, NOW);
    expect(await roles()).toEqual(["read", "publish"]);
    await updateSecret(env, project, id, { scope: ["publish"] }, NOW);
    expect(await roles()).toEqual(["publish"]);
  });

  it("takes a non-empty list within the credential's roles", async () => {
    const { project, id } = await dualKey();
    for (const scope of [[], ["admin"], ["read", "read"], "read", null]) {
      expect(await code(updateSecret(env, project, id, { scope }, NOW))).toBe("invalid_request");
    }
    const solo = unique("edit-solo-");
    const made = await createCredential(env, { project: solo, kind: "read" }, NOW);
    const soloId = made.credential.auth[0]?.id ?? "";
    expect(await code(updateSecret(env, solo, soloId, { scope: ["publish"] }, NOW))).toBe(
      "invalid_request",
    );
    expect(await code(updateSecret(env, solo, soloId, { scope: ["read"] }, NOW))).toBe("ok");
    const admin = unique("edit-admin-");
    const adm = await createCredential(env, { project: admin, kind: "admin" }, NOW);
    const admId = adm.credential.auth[0]?.id ?? "";
    expect(await code(updateSecret(env, admin, admId, { scope: ["read"] }, NOW))).toBe(
      "invalid_request",
    );
  });

  it("keeps the description when only the scope is sent, and the scope when only the description", async () => {
    const { project, id } = await dualKey();
    await updateSecret(env, project, id, { description: "CI" }, NOW);
    await updateSecret(env, project, id, { scope: ["publish"] }, NOW);
    const entry = (await getCredential(env, project, { fresh: true }))?.auth[0];
    expect(entry).toMatchObject({ description: "CI", scope: ["publish"] });
    await updateSecret(env, project, id, { description: null }, NOW);
    expect((await getCredential(env, project, { fresh: true }))?.auth[0]?.scope).toEqual([
      "publish",
    ]);
  });

  it("refuses a scope that would duplicate another active gh entry", async () => {
    const { project } = await dualKey();
    const gh = { type: "gh", repository: "acme/edit" };
    const read = await addSecret(env, project, { ...gh, scope: ["read"] }, NOW);
    const publish = await addSecret(env, project, { ...gh, scope: ["publish"] }, NOW);
    // The same claims in the same second still get ids of their own.
    expect(publish.secret.id).not.toBe(read.secret.id);
    expect(
      await code(updateSecret(env, project, publish.secret.id, { scope: ["read"] }, NOW)),
    ).toBe("invalid_request");
    expect(
      await code(
        updateSecret(env, project, publish.secret.id, { scope: ["read", "publish"] }, NOW),
      ),
    ).toBe("ok");
    expect(
      await code(updateSecret(env, project, read.secret.id, { scope: ["publish"] }, NOW)),
    ).toBe("ok");
  });
});

describe("a panel session started with a login", () => {
  it("has the roles of that login's current scope", async () => {
    const project = unique("sess-login-");
    await createCredential(
      env,
      {
        project,
        roles: ["read", "publish"],
        read_grants: [GRANT],
        publish_grants: [GRANT],
        secret: null,
      },
      NOW,
    );
    const added = await addSecret(
      env,
      project,
      { type: "login", password: "long-enough-pass", scope: ["read", "publish"] },
      NOW,
    );
    const sessionEnv = { AUTH: env.AUTH, SESSION_SECRET: "unit-test-session-secret" };
    const value = await createSession(
      sessionEnv,
      project,
      { now: () => NOW.getTime() },
      {
        entry: added.secret.id,
      },
    );
    const cookie = new Request("https://registry.test/", {
      headers: { cookie: `sreg_session=${value}` },
    });
    const roles = async () =>
      (await sessionIdentity(cookie, sessionEnv, { now: () => NOW.getTime() }))?.identity.roles;
    expect(await roles()).toEqual(["read"]);
    await updateSecret(env, project, added.secret.id, { scope: ["publish"] }, NOW);
    expect(await roles()).toEqual([]);
  });
});

describe("admin combined with read and publish", () => {
  const sessionEnv = { SESSION_SECRET: "unit-test-session-secret" };
  const loginEnv = { ...env, ...sessionEnv, PUBLIC_URL: "https://registry.test" };

  async function adminReader(): Promise<string> {
    const project = unique("adm-read-");
    await createCredential(
      env,
      {
        project,
        roles: ["read", "admin"],
        read_grants: [GRANT],
        secret: { type: "key", scope: ["admin"] },
      },
      NOW,
    );
    return project;
  }

  it("keeps the grants of the data roles and none for admin alone", async () => {
    const project = await adminReader();
    const record = await getCredential(env, project, { fresh: true });
    expect(record?.roles).toEqual(["read", "admin"]);
    expect(record?.grants).toEqual({ read: [GRANT], publish: [], yank: [], delete: [] });
    const alone = unique("adm-alone-");
    const body = {
      project: alone,
      roles: ["admin"],
      read_grants: [GRANT],
      secret: { type: "key" },
    };
    expect(await code(createCredential(env, body, NOW))).toBe("invalid_request");
  });

  it("asks for a scope with several roles and takes admin only when it is held", async () => {
    const project = await adminReader();
    expect(await code(addSecret(env, project, { type: "key" }, NOW))).toBe("invalid_request");
    expect(await code(addSecret(env, project, { type: "key", scope: ["admin"] }, NOW))).toBe("ok");
    expect(
      await code(addSecret(env, project, { type: "key", scope: ["read", "admin"] }, NOW)),
    ).toBe("ok");
    expect(await code(addSecret(env, project, { type: "key", scope: ["publish"] }, NOW))).toBe(
      "invalid_request",
    );
    const reader = unique("only-read-");
    await createCredential(env, { project: reader, kind: "read", secret: null }, NOW);
    expect(await code(addSecret(env, reader, { type: "key", scope: ["admin"] }, NOW))).toBe(
      "invalid_request",
    );
  });

  it("gives each key the roles of its scope", async () => {
    const name = unique("adm-keys-");
    const read = "R".repeat(32);
    const admin = "D".repeat(32);
    await putCredential(env, {
      project: name,
      roles: ["read", "admin"],
      grants: { read: [GRANT], publish: [], yank: [], delete: [] },
      auth: [await keyEntry(read, ["read"]), await keyEntry(admin, ["admin"])],
    });
    const roles = async (secret: string) =>
      (await authenticate(request(`${name}:${secret}`), authEnv))?.identity.roles ?? null;
    expect(await roles(read)).toEqual(["read"]);
    expect(await roles(admin)).toEqual(["admin"]);
  });

  it("pins the secrets of an admin to admin when read is added", async () => {
    const project = unique("adm-grow-");
    await createCredential(env, { project, kind: "admin" }, NOW);
    const patched = await updateGrants(
      env,
      project,
      { roles: ["admin", "read"], read_grants: [GRANT] },
      NOW,
    );
    expect(patched.roles).toEqual(["admin", "read"]);
    expect(patched.auth.map((e) => e.scope)).toEqual([["admin"]]);
    expect(patched.read_grants).toEqual([GRANT]);
    expect(patched.kind).toBe("admin");
  });

  it("lets a credential become an admin, but the last admin keeps the role", async () => {
    const project = unique("adm-become-");
    await createCredential(env, { project, kind: "read" }, NOW);
    const patched = await updateGrants(env, project, { roles: ["read", "admin"] }, NOW);
    expect(patched.auth.map((e) => e.scope)).toEqual([["read"]]);
    // Earlier tests of this file left admins behind: make this one the only admin.
    for (const { project: name, roles } of await listCredentials(env)) {
      if (name !== project && roles.includes("admin")) await env.AUTH.delete(`cred:${name}`);
    }
    expect(await code(updateGrants(env, project, { roles: ["read"] }, NOW))).toBe("forbidden");
    const other = unique("adm-other-");
    await createCredential(env, { project: other, kind: "admin" }, NOW);
    expect(await code(updateGrants(env, project, { roles: ["read"] }, NOW))).toBe("ok");
    expect(await code(updateGrants(env, other, { roles: ["read"] }, NOW))).toBe("forbidden");
  });

  it("issues a login token for the data role of an admin credential's login", async () => {
    const project = await adminReader();
    const added = await addSecret(
      env,
      project,
      { type: "login", password: "long-enough-pass", scope: ["read"] },
      NOW,
    );
    const adminLogin = await addSecret(
      env,
      project,
      { type: "login", password: "long-enough-pass", scope: ["admin"] },
      NOW,
    );
    const record = await getCredential(env, project, { fresh: true });
    if (record === null) throw new Error("missing credential");
    const exp = NOW.getTime() + 3_600_000;
    const check = async (id: string) =>
      verifyLoginToken(
        sessionEnv,
        record,
        (await issueLoginToken(loginEnv, project, id, exp)).slice(project.length + 4),
        NOW.getTime(),
      );
    expect((await check(added.secret.id))?.roles).toEqual(["read"]);
    expect(await check(adminLogin.secret.id)).toBeNull();
  });
});
