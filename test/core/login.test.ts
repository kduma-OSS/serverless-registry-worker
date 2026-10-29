import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addSecret, createCredential } from "../../src/core/admin";
import {
  PENDING_TTL,
  authenticate,
  clearPendingCookie,
  createPending,
  createSession,
  getCredential,
  issueLoginToken,
  parseToken,
  pendingCookie,
  readPending,
  readSession,
  verifyLoginToken,
  type CredentialRecord,
} from "../../src/core/auth";
import { ValidationError } from "../../src/core/errors";
import {
  approvalProblem,
  checkScopes,
  createLoginSession,
  decideLoginSession,
  findLogin,
  needsFreshTotp,
  opsAllow,
  pollLoginSession,
  readLoginSession,
  checkPassword,
  verifyEntryTotp,
  TOTP_FRESH_SECONDS,
  type LoginSession,
} from "../../src/core/login";
import { totpCode, totpStep } from "../../src/core/totp";

const NOW = new Date("2026-10-28T10:00:00Z");
const PASSWORD = "correct-horse-battery";
const URL_BASE = "https://registry.test";

let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}`;

interface Made {
  record: CredentialRecord;
  entryId: string;
  totpSecret?: string;
}

async function make(
  kind: "read" | "publish",
  options: { totp?: boolean; project?: string } = {},
): Promise<Made> {
  const project = options.project ?? unique(kind === "read" ? "reader" : "writer");
  const created = await createCredential(
    env,
    {
      project,
      kind,
      grants: [{ eco: "composer", package: "acme/*", versions: "*" }],
      secret: { type: "login", password: PASSWORD, totp: options.totp === true },
    },
    NOW,
  );
  const record = await getCredential(env, project, { fresh: true });
  if (record === null) throw new Error("missing credential");
  const entry = record.auth[0];
  if (entry === undefined || entry.type !== "login") throw new Error("missing login");
  const entryId = created.credential.auth[0]?.id ?? "";
  return { record, entryId, totpSecret: created.login?.totp?.secret };
}

async function code(secret: string | undefined, now: Date, offset = 0): Promise<string> {
  return (await totpCode(secret ?? "", totpStep(now.getTime()) + offset)) ?? "";
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ValidationError) return err.code;
    throw err;
  }
  return "ok";
}

describe("creating login secrets", () => {
  it("returns the password and the one-time code enrolment once, and stores neither", async () => {
    const project = unique("enrol");
    const created = await createCredential(
      env,
      { project, kind: "read", secret: { type: "login", password: PASSWORD, totp: true } },
      NOW,
    );
    expect(created.token).toBeUndefined();
    expect(created.login?.password).toBe(PASSWORD);
    expect(created.login?.totp?.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(created.login?.totp?.otpauth_uri).toContain(`${project}?secret=`);
    expect(created.credential.auth[0]).toMatchObject({ type: "login", totp: true, expires: null });
    const stored = JSON.stringify(await getCredential(env, project, { fresh: true }));
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(created.login?.totp?.secret ?? "?");
  });

  it("generates a password and no TOTP when asked for neither", async () => {
    const project = unique("plain");
    const created = await createCredential(
      env,
      { project, kind: "publish", secret: { type: "login" } },
      NOW,
    );
    expect(created.login?.password).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(created.login?.totp).toBeUndefined();
    expect(created.credential.auth[0]).toMatchObject({ type: "login", totp: false });
  });

  it("adds a login to an existing credential", async () => {
    const { record } = await make("read");
    const added = await addSecret(env, record.project, { type: "login", totp: true }, NOW);
    expect(added.login?.totp).toBeDefined();
    expect(added.secret).toMatchObject({ type: "login", totp: true });
    expect(added.token).toBeUndefined();
  });

  it("lets an admin credential have a login", async () => {
    const project = unique("adminlogin");
    const created = await createCredential(
      env,
      { project, kind: "admin", secret: { type: "login", totp: true } },
      NOW,
    );
    expect(created.credential.kind).toBe("admin");
    expect(created.login?.totp).toBeDefined();
  });

  it("refuses short passwords and misplaced fields", async () => {
    const attempt = (kind: string, secret: unknown) =>
      errorCode(createCredential(env, { project: unique("bad"), kind, secret }, NOW));
    expect(await attempt("read", { type: "login", password: "short" })).toBe("invalid_request");
    expect(await attempt("read", { type: "login", totp: "yes" })).toBe("invalid_request");
    expect(await attempt("read", { type: "key", totp: true })).toBe("invalid_request");
    expect(await attempt("read", { type: "login", repository: "a/b" })).toBe("invalid_request");
  });
});

describe("login tokens", () => {
  const secretOf = (token: string) => token.slice(token.indexOf(":") + 1);
  const scopes = [{ eco: "composer" as const, package: "acme/lib", version: "1.0.0" }];

  it("parses the st type and refuses a malformed secret", () => {
    const sig = "A".repeat(43);
    expect(parseToken(`shop:st.abc.${sig}`)).toMatchObject({ type: "st", secret: `abc.${sig}` });
    expect(parseToken("shop:st.nodot")).toBeNull();
    expect(parseToken(`shop:st.abc.${"A".repeat(42)}`)).toBeNull();
    expect(parseToken(`shop:st.a b.${sig}`)).toBeNull();
    expect(parseToken(`_:st.abc.${sig}`)).toBeNull();
  });

  it("verifies a pull token against its credential until it expires", async () => {
    const { record, entryId } = await make("read");
    const token = await issueLoginToken(env, record.project, entryId, NOW.getTime() + 3_600_000);
    expect(token.startsWith(`${record.project}:st.`)).toBe(true);
    const secret = secretOf(token).slice(3);
    expect(await verifyLoginToken(env, record, secret, NOW.getTime())).toEqual({
      entryId,
      roles: ["read"],
    });
    const late = NOW.getTime() + 3_600_000;
    expect(await verifyLoginToken(env, record, secret, late)).toBeNull();
  });

  it("authenticates a request with it", async () => {
    const { record, entryId } = await make("read");
    const token = await issueLoginToken(env, record.project, entryId, Date.now() + 60_000);
    const request = new Request(`${URL_BASE}/api/v1/whoami`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const auth = await authenticate(request, env);
    expect(auth?.via).toBe("st");
    expect(auth?.identity).toMatchObject({
      project: record.project,
      roles: ["read"],
      entryId,
    });
    expect(auth?.identity.scopes).toBeUndefined();
  });

  it("verifies a publish token that names more scopes than the default maximum", async () => {
    // MAX_PUBLISH_SCOPES is checked when the login is created; the signature carries it on, so
    // lowering the setting does not end a token that is already out.
    const { record, entryId } = await make("publish");
    const many = Array.from({ length: 30 }, (_, i) => ({
      eco: "composer" as const,
      package: "acme/lib",
      version: `1.0.${i}`,
    }));
    const token = (
      await issueLoginToken(env, record.project, entryId, NOW.getTime() + 900_000, many)
    ).slice(record.project.length + 4);
    expect(await verifyLoginToken(env, record, token, NOW.getTime())).toEqual({
      entryId,
      roles: ["publish"],
      scopes: many,
    });
  });

  it("carries the scopes of a publish token and requires them", async () => {
    const { record, entryId } = await make("publish");
    const exp = NOW.getTime() + 900_000;
    const withScopes = (await issueLoginToken(env, record.project, entryId, exp, scopes)).slice(
      record.project.length + 4,
    );
    expect(await verifyLoginToken(env, record, withScopes, NOW.getTime())).toEqual({
      entryId,
      roles: ["publish"],
      scopes,
    });
    const without = (await issueLoginToken(env, record.project, entryId, exp)).slice(
      record.project.length + 4,
    );
    expect(await verifyLoginToken(env, record, without, NOW.getTime())).toBeNull();

    const reader = await make("read");
    const stray = (
      await issueLoginToken(env, reader.record.project, reader.entryId, exp, scopes)
    ).slice(reader.record.project.length + 4);
    expect(await verifyLoginToken(env, reader.record, stray, NOW.getTime())).toBeNull();
  });

  it("is bound to its project and to a login that is still active", async () => {
    const a = await make("read");
    const b = await make("read");
    const exp = NOW.getTime() + 3_600_000;
    const forA = (await issueLoginToken(env, a.record.project, a.entryId, exp)).slice(
      a.record.project.length + 4,
    );
    expect(await verifyLoginToken(env, b.record, forA, NOW.getTime())).toBeNull();

    const ended: CredentialRecord = {
      ...a.record,
      auth: a.record.auth.map((e) => ({ ...e, expires: "2026-10-28T09:00:00Z" })),
    };
    expect(await verifyLoginToken(env, ended, forA, NOW.getTime())).toBeNull();
    const other: CredentialRecord = { ...a.record, auth: [] };
    expect(await verifyLoginToken(env, other, forA, NOW.getTime())).toBeNull();
  });

  it("never verifies for an admin credential", async () => {
    const { record, entryId } = await make("read");
    const exp = NOW.getTime() + 3_600_000;
    const secret = (await issueLoginToken(env, record.project, entryId, exp)).slice(
      record.project.length + 4,
    );
    expect(
      await verifyLoginToken(env, { ...record, roles: ["admin"] }, secret, NOW.getTime()),
    ).toBeNull();
  });

  it("is not interchangeable with a panel session cookie", async () => {
    const { record, entryId } = await make("read");
    const exp = Date.now() + 3_600_000;
    const secret = (await issueLoginToken(env, record.project, entryId, exp)).slice(
      record.project.length + 4,
    );
    const cookie = new Request(`${URL_BASE}/`, { headers: { cookie: `sreg_session=${secret}` } });
    expect(await readSession(cookie, env)).toBeNull();

    const session = await createSession(env, record.project);
    expect(await verifyLoginToken(env, record, session, Date.now())).toBeNull();
    const asToken = new Request(`${URL_BASE}/api/v1/whoami`, {
      headers: { authorization: `Bearer ${record.project}:st.${session}` },
    });
    expect(await authenticate(asToken, env)).toBeNull();
  });

  it("fails without SESSION_SECRET", async () => {
    const { record, entryId } = await make("read");
    await expect(
      issueLoginToken({ TOKEN_PREFIX: "" }, record.project, entryId, 1),
    ).rejects.toMatchObject({ code: "internal_error" });
  });
});

describe("login sessions", () => {
  const base = { purpose: "pull" };
  const scope = { eco: "composer", package: "acme/lib", version: "1.0.0" };

  it("creates a signed session and writes nothing", async () => {
    const before = await env.AUTH.list({ prefix: "login-session:" });
    const created = await createLoginSession(env, base, URL_BASE, NOW);
    expect(created.url).toBe(`${URL_BASE}/authorize/${created.session}`);
    expect(created.interval).toBeGreaterThan(0);
    expect(created.expires_at).toBe("2026-10-28T10:10:00.000Z");
    expect(created.poll_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await env.AUTH.list({ prefix: "login-session:" })).keys).toEqual(before.keys);
    const session = await readLoginSession(env, created.session, NOW);
    expect(session).toMatchObject({ purpose: "pull" });
    expect(
      await readLoginSession(env, created.session, new Date(NOW.getTime() + 600_000)),
    ).toBeNull();
    expect(await readLoginSession(env, `${created.session}x`, NOW)).toBeNull();
  });

  it("validates a pull and a publish request", async () => {
    const attempt = (body: Record<string, unknown>) =>
      errorCode(createLoginSession(env, body, URL_BASE, NOW));
    expect(await attempt({})).toBe("invalid_request");
    expect(await attempt({ purpose: "both" })).toBe("invalid_request");
    expect(await attempt({ purpose: "pull", eco: "rpm" })).toBe("invalid_request");
    expect(await attempt({ purpose: "pull", scopes: [scope] })).toBe("invalid_request");
    expect(await attempt({ purpose: "publish" })).toBe("invalid_request");
    expect(await attempt({ purpose: "publish", scopes: [] })).toBe("invalid_request");
    expect(await attempt({ purpose: "publish", eco: "npm", scopes: [scope] })).toBe(
      "invalid_request",
    );
    expect(await attempt({ purpose: "publish", scopes: [{ ...scope, eco: "rpm" }] })).toBe(
      "invalid_request",
    );
    expect(await attempt({ purpose: "publish", scopes: [{ ...scope, version: "nope" }] })).toBe(
      "invalid_request",
    );
    expect(await attempt({ purpose: "publish", scopes: [{ ...scope, package: "a b" }] })).toBe(
      "invalid_request",
    );
    expect(await attempt({ purpose: "publish", scopes: [scope] })).toBe("ok");
    const many = Array.from({ length: 21 }, (_, i) => ({ ...scope, version: `1.0.${i}` }));
    expect(await attempt({ purpose: "publish", scopes: many })).toBe("invalid_request");
  });

  it("takes the most scopes of a publish login from MAX_PUBLISH_SCOPES", async () => {
    const scopes = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ ...scope, version: `1.0.${i}` }));
    const attempt = (max: string, count: number) =>
      errorCode(
        createLoginSession(
          { ...env, MAX_PUBLISH_SCOPES: max },
          { purpose: "publish", scopes: scopes(count) },
          URL_BASE,
          NOW,
        ),
      );
    expect(await attempt("50", 21)).toBe("ok");
    expect(await attempt("50", 50)).toBe("ok");
    expect(await attempt("50", 51)).toBe("invalid_request");
    expect(await attempt("2", 3)).toBe("invalid_request");
    // An invalid value means the default of 20.
    expect(await attempt("many", 20)).toBe("ok");
    expect(await attempt("many", 21)).toBe("invalid_request");
  });

  it("refuses a publish login whose approval link would be too long", async () => {
    const attempt = (count: number, name: string) =>
      errorCode(
        createLoginSession(
          { ...env, MAX_PUBLISH_SCOPES: "100" },
          {
            purpose: "publish",
            scopes: Array.from({ length: count }, (_, i) => ({
              ...scope,
              package: `${name}${i}`,
              version: "1.0.0",
            })),
          },
          URL_BASE,
          NOW,
        ),
      );
    expect(await attempt(100, "a/")).toBe("ok");
    expect(await attempt(100, `a/${"b".repeat(100)}`)).toBe("invalid_request");
  });

  it("normalises and de-duplicates the scopes", async () => {
    const created = await createLoginSession(
      env,
      {
        purpose: "publish",
        scopes: [
          { eco: "nuget", package: "Acme.Lib", version: "1.0" },
          { eco: "nuget", package: "acme.lib", version: "1.0.0" },
        ],
      },
      URL_BASE,
      NOW,
    );
    const session = await readLoginSession(env, created.session, NOW);
    expect(session?.scopes).toEqual([{ eco: "nuget", package: "acme.lib", version: "1.0.0" }]);
  });

  it("hands the token over once after an approval", async () => {
    const { record, entryId } = await make("read");
    const created = await createLoginSession(env, base, URL_BASE, NOW);
    const poll = { session: created.session, poll_token: created.poll_token };
    expect(await pollLoginSession(env, poll, NOW)).toEqual({ status: "pending" });

    const session = (await readLoginSession(env, created.session, NOW)) as LoginSession;
    expect(await decideLoginSession(env, session, record, entryId, true, NOW)).toBe(true);
    // Decided once: a second decision is refused.
    expect(await decideLoginSession(env, session, record, entryId, false, NOW)).toBe(false);

    const result = await pollLoginSession(env, poll, NOW);
    if (result.status !== "approved") throw new Error("not approved");
    expect(result.issued).toMatchObject({ project: record.project, kind: "read" });
    expect(result.issued.expires_at).toBe("2026-10-28T11:00:00.000Z");
    expect(result.issued.token.startsWith(`${record.project}:st.`)).toBe(true);
    // The decision is gone after it was collected.
    expect(await pollLoginSession(env, poll, NOW)).toEqual({ status: "pending" });
  });

  it("extends a pull token only when asked", async () => {
    const { record, entryId } = await make("read");
    const created = await createLoginSession(env, base, URL_BASE, NOW);
    const session = (await readLoginSession(env, created.session, NOW)) as LoginSession;
    await decideLoginSession(env, session, record, entryId, true, NOW, { extended: true });
    const result = await pollLoginSession(
      env,
      { session: created.session, poll_token: created.poll_token },
      NOW,
    );
    if (result.status !== "approved") throw new Error("not approved");
    expect(result.issued.expires_at).toBe("2026-10-29T10:00:00.000Z");
  });

  it("limits a publish token to 15 minutes and its scopes", async () => {
    const { record, entryId } = await make("publish");
    const created = await createLoginSession(
      env,
      { purpose: "publish", scopes: [scope] },
      URL_BASE,
      NOW,
    );
    const session = (await readLoginSession(env, created.session, NOW)) as LoginSession;
    expect(
      await decideLoginSession(env, session, record, entryId, true, NOW, { extended: true }),
    ).toBe(true);
    const result = await pollLoginSession(
      env,
      { session: created.session, poll_token: created.poll_token },
      NOW,
    );
    if (result.status !== "approved") throw new Error("not approved");
    expect(result.issued.expires_at).toBe("2026-10-28T10:15:00.000Z");
    const secret = result.issued.token.slice(record.project.length + 4);
    expect(await verifyLoginToken(env, record, secret, NOW.getTime())).toMatchObject({
      scopes: [scope],
    });
  });

  it("reports a refusal as forbidden", async () => {
    const { record, entryId } = await make("read");
    const created = await createLoginSession(env, base, URL_BASE, NOW);
    const session = (await readLoginSession(env, created.session, NOW)) as LoginSession;
    await decideLoginSession(env, session, record, entryId, false, NOW);
    const poll = { session: created.session, poll_token: created.poll_token };
    expect(await errorCode(pollLoginSession(env, poll, NOW))).toBe("forbidden");
  });

  it("needs the poll token and reports an expired session", async () => {
    const created = await createLoginSession(env, base, URL_BASE, NOW);
    const poll = { session: created.session, poll_token: created.poll_token };
    expect(await errorCode(pollLoginSession(env, { ...poll, poll_token: "x" }, NOW))).toBe(
      "unauthorized",
    );
    expect(await errorCode(pollLoginSession(env, { session: created.session }, NOW))).toBe(
      "invalid_request",
    );
    const late = new Date(NOW.getTime() + 601_000);
    expect(await errorCode(pollLoginSession(env, poll, late))).toBe("not_found");
  });

  it("does not approve for a credential of the wrong kind or without the grants", async () => {
    const reader = await make("read");
    const writer = await make("publish");
    const pull = (await readLoginSession(
      env,
      (await createLoginSession(env, base, URL_BASE, NOW)).session,
      NOW,
    )) as LoginSession;
    expect(approvalProblem(env, pull, reader.record)).toBeNull();
    expect(approvalProblem(env, pull, writer.record)).toContain("cannot download");

    const allowed = (await readLoginSession(
      env,
      (await createLoginSession(env, { purpose: "publish", scopes: [scope] }, URL_BASE, NOW))
        .session,
      NOW,
    )) as LoginSession;
    expect(approvalProblem(env, allowed, writer.record)).toBeNull();
    expect(approvalProblem(env, allowed, reader.record)).toContain("cannot publish");

    const outside = (await readLoginSession(
      env,
      (
        await createLoginSession(
          env,
          { purpose: "publish", scopes: [scope, { ...scope, package: "other/lib" }] },
          URL_BASE,
          NOW,
        )
      ).session,
      NOW,
    )) as LoginSession;
    expect(checkScopes(env, writer.record, outside.scopes ?? []).map((c) => c.allowed)).toEqual([
      true,
      false,
    ]);
    expect(approvalProblem(env, outside, writer.record)).toContain("grants");
    expect(await decideLoginSession(env, outside, writer.record, writer.entryId, true, NOW)).toBe(
      false,
    );
  });
});

describe("signing in", () => {
  const input = (project: string, password = PASSWORD) => ({ project, password });

  it("accepts the password of a login without a one-time code", async () => {
    const { record, entryId } = await make("read");
    const result = await checkPassword(env, input(record.project), NOW.getTime());
    expect(result).toMatchObject({ ok: true, entryId, needsCode: false });
  });

  it("does not tell a wrong project from a wrong password", async () => {
    const { record } = await make("read");
    const wrong = await checkPassword(
      env,
      input(record.project, "wrong-password-here"),
      NOW.getTime(),
    );
    const unknown = await checkPassword(env, input("no-such-project"), NOW.getTime());
    expect(wrong).toEqual({ ok: false });
    expect(unknown).toEqual({ ok: false });
  });

  it("lets an admin credential in only where the caller allows it", async () => {
    const project = unique("root");
    await createCredential(
      env,
      { project, kind: "admin", secret: { type: "login", password: PASSWORD } },
      NOW,
    );
    expect(await checkPassword(env, input(project), NOW.getTime())).toEqual({ ok: false });
    expect(
      await checkPassword(env, input(project), NOW.getTime(), { allowAdmin: true }),
    ).toMatchObject({
      ok: true,
    });
  });

  it("leaves the one-time code to a second step after the password was right", async () => {
    const { record, totpSecret } = await make("read", { totp: true });
    const now = Date.now();
    expect(await checkPassword(env, input(record.project, "wrong-password-here"), now)).toEqual({
      ok: false,
    });
    const result = await checkPassword(env, input(record.project), now);
    if (!result.ok) throw new Error("password refused");
    expect(result.needsCode).toBe(true);
    const verify = (code: string) => verifyEntryTotp(env, record, result.entry, code, now);
    expect(await verify("000000")).toBe(false);
    expect(await verify("")).toBe(false);
    expect(await verify(await code(totpSecret, new Date(now)))).toBe(true);
  });

  it("accepts a one-time code only once", async () => {
    const { record, totpSecret } = await make("read", { totp: true });
    const now = Date.now();
    const result = await checkPassword(env, input(record.project), now);
    if (!result.ok) throw new Error("password refused");
    const first = await code(totpSecret, new Date(now));
    expect(await verifyEntryTotp(env, record, result.entry, first, now)).toBe(true);
    expect(await verifyEntryTotp(env, record, result.entry, first, now)).toBe(false);
    const next = await code(totpSecret, new Date(now), 1);
    expect(await verifyEntryTotp(env, record, result.entry, next, now)).toBe(true);
  });

  it("does not sign in with an expired login", async () => {
    const { record } = await make("read");
    const stored = await getCredential(env, record.project, { fresh: true });
    expect(stored).not.toBeNull();
    const later = Date.parse("2027-01-01T00:00:00Z");
    await env.AUTH.put(
      `cred:${record.project}`,
      JSON.stringify({
        ...stored,
        auth: stored?.auth.map((e) => ({ ...e, expires: "2026-12-01T00:00:00Z" })),
      }),
    );
    expect(await checkPassword(env, input(record.project), later - 1)).toEqual({ ok: false });
  });

  it("finds a login entry by id while it is active", async () => {
    const { record, entryId } = await make("read");
    expect(await findLogin(record, entryId, NOW.getTime())).not.toBeNull();
    expect(await findLogin(record, "000000000000", NOW.getTime())).toBeNull();
    expect(await findLogin(record, entryId, Date.parse("2999-01-01T00:00:00Z"))).not.toBeNull();
  });
});

describe("pending sign-ins", () => {
  const pending = { project: "shop", entry: "0123456789ab", context: "panel" };
  const request = (value: string) =>
    new Request(`${URL_BASE}/login/code`, { headers: { cookie: `a=b; sreg_pending=${value}` } });

  it("carries the project, the entry and what it is for, and no password", async () => {
    const value = await createPending(env, pending, { now: () => NOW.getTime() });
    expect(await readPending(request(value), env, { now: () => NOW.getTime() })).toEqual(pending);
    const payload = JSON.parse(
      atob(value.split(".")[0]?.replace(/-/g, "+").replace(/_/g, "/") ?? ""),
    );
    expect(Object.keys(payload).sort()).toEqual(["ctx", "entry", "exp", "project", "typ"]);
  });

  it("lasts five minutes", async () => {
    const value = await createPending(env, pending, { now: () => NOW.getTime() });
    const at = (ms: number) => ({ now: () => NOW.getTime() + ms });
    expect(PENDING_TTL).toBe(300);
    expect(await readPending(request(value), env, at(299_000))).not.toBeNull();
    expect(await readPending(request(value), env, at(300_000))).toBeNull();
  });

  it("is not a session and a session is not a pending sign-in", async () => {
    const value = await createPending(env, pending);
    const asSession = new Request(`${URL_BASE}/`, { headers: { cookie: `sreg_session=${value}` } });
    expect(await readSession(asSession, env)).toBeNull();
    const session = await createSession(env, "shop");
    expect(await readPending(request(session), env)).toBeNull();
  });

  it("refuses a forged, changed or missing cookie", async () => {
    const value = await createPending(env, pending);
    const [payload = "", signature = ""] = value.split(".");
    const other = await createPending({ SESSION_SECRET: "other" }, { ...pending, project: "evil" });
    for (const bad of [
      // A character in the middle (the last one has padding bits, which decoding ignores).
      `${payload}.${signature.slice(0, 10)}${signature[10] === "A" ? "B" : "A"}${signature.slice(11)}`,
      `${other.split(".")[0]}.${signature}`,
      other,
      "short",
    ]) {
      expect(await readPending(request(bad), env)).toBeNull();
    }
    expect(await readPending(new Request(`${URL_BASE}/`), env)).toBeNull();
    expect(await readPending(request(value), {})).toBeNull();
  });

  it("needs SESSION_SECRET and builds cookies limited to a path", async () => {
    await expect(createPending({}, pending)).rejects.toMatchObject({ code: "internal_error" });
    expect(pendingCookie("abc", "/login")).toBe(
      "sreg_pending=abc; HttpOnly; Secure; SameSite=Lax; Path=/login; Max-Age=300",
    );
    expect(clearPendingCookie("/authorize/")).toBe(
      "sreg_pending=; HttpOnly; Secure; SameSite=Lax; Path=/authorize/; Max-Age=0",
    );
  });
});

describe("fresh one-time codes for publishing", () => {
  const entryWith = async (totp: boolean) => {
    const { record } = await make("publish", { totp });
    const entry = record.auth[0];
    if (entry === undefined || entry.type !== "login") throw new Error("missing login");
    return entry;
  };
  const publish = { purpose: "publish" as const, nonce: "n", exp: 0 };
  const pull = { purpose: "pull" as const, nonce: "n", exp: 0 };
  const now = 1_000_000_000_000;

  it("is needed for a publish when the code is older than fifteen minutes", async () => {
    const entry = await entryWith(true);
    const sec = now / 1000;
    expect(needsFreshTotp(publish, entry, sec - 60, now)).toBe(false);
    expect(needsFreshTotp(publish, entry, sec - TOTP_FRESH_SECONDS, now)).toBe(false);
    expect(needsFreshTotp(publish, entry, sec - TOTP_FRESH_SECONDS - 1, now)).toBe(true);
    expect(needsFreshTotp(publish, entry, undefined, now)).toBe(true);
  });

  it("is needed for a yank and a delete like for a publish", async () => {
    const entry = await entryWith(true);
    for (const purpose of ["yank", "delete"] as const) {
      const session = { purpose, nonce: "n", exp: 0 };
      expect(needsFreshTotp(session, entry, now / 1000 - 60, now)).toBe(false);
      expect(needsFreshTotp(session, entry, undefined, now)).toBe(true);
    }
  });

  it("is never needed for a pull or for a login without a one-time code", async () => {
    const withTotp = await entryWith(true);
    const without = await entryWith(false);
    expect(needsFreshTotp(pull, withTotp, undefined, now)).toBe(false);
    expect(needsFreshTotp(publish, without, undefined, now)).toBe(false);
  });
});

async function makeAdmin(): Promise<Made> {
  const project = unique("operator");
  const created = await createCredential(
    env,
    { project, kind: "admin", secret: { type: "login", password: PASSWORD } },
    NOW,
  );
  const record = await getCredential(env, project, { fresh: true });
  if (record === null) throw new Error("missing credential");
  return { record, entryId: created.credential.auth[0]?.id ?? "" };
}

describe("yank and delete logins", () => {
  const version = { eco: "composer", package: "acme/lib", version: "1.0.0" };
  const sessionOf = async (body: Record<string, unknown>) =>
    (await readLoginSession(
      env,
      (await createLoginSession(env, body, URL_BASE, NOW)).session,
      NOW,
    )) as LoginSession;

  it("keeps the operation of every scope, a delete may name a whole package", async () => {
    const yank = await sessionOf({ purpose: "yank", scopes: [version, version] });
    expect(yank.ops).toEqual([{ op: "yank", ...version }]);
    const del = await sessionOf({
      purpose: "delete",
      scopes: [{ eco: "composer", package: "acme/lib" }, { ...version, version: null }, version],
    });
    expect(del.ops).toEqual([
      { op: "delete", eco: "composer", package: "acme/lib" },
      { op: "delete", ...version },
    ]);
  });

  it("is approved only by a credential with the admin role", async () => {
    const admin = await makeAdmin();
    const reader = await make("read");
    const writer = await make("publish");
    for (const purpose of ["yank", "delete"] as const) {
      const session = await sessionOf({ purpose, scopes: [version] });
      expect(approvalProblem(env, session, admin.record)).toBeNull();
      expect(approvalProblem(env, session, reader.record)).toContain(`cannot ${purpose}`);
      expect(approvalProblem(env, session, writer.record)).toContain(
        `neither the admin nor the ${purpose} role`,
      );
      expect(await decideLoginSession(env, session, reader.record, reader.entryId, true, NOW)).toBe(
        false,
      );
    }
    // The admin login cannot approve a pull or a publish.
    const pull = await sessionOf({ purpose: "pull" });
    expect(approvalProblem(env, pull, admin.record)).toContain("cannot download");
  });

  it("issues an admin token with the operations that lasts fifteen minutes", async () => {
    const { record, entryId } = await makeAdmin();
    const created = await createLoginSession(
      env,
      { purpose: "delete", scopes: [version] },
      URL_BASE,
      NOW,
    );
    const session = (await readLoginSession(env, created.session, NOW)) as LoginSession;
    expect(await decideLoginSession(env, session, record, entryId, true, NOW)).toBe(true);
    const result = await pollLoginSession(
      env,
      { session: created.session, poll_token: created.poll_token },
      NOW,
    );
    if (result.status !== "approved") throw new Error("not approved");
    expect(result.issued).toMatchObject({ kind: "admin", project: record.project });
    expect(result.issued.expires_at).toBe("2026-10-28T10:15:00.000Z");
    const secret = result.issued.token.slice(record.project.length + 4);
    expect(await verifyLoginToken(env, record, secret, NOW.getTime())).toEqual({
      entryId,
      roles: ["admin"],
      ops: [{ op: "delete", ...version }],
    });
    expect(await verifyLoginToken(env, record, secret, NOW.getTime() + 901_000)).toBeNull();
  });

  it("matches operations exactly, by eco, package and version", () => {
    const ops = [
      { op: "yank" as const, eco: "composer" as const, package: "acme/lib", version: "1.0.0" },
      { op: "delete" as const, eco: "composer" as const, package: "acme/lib" },
    ];
    const allow = (op: "yank" | "delete", eco: string, name: string, version?: string) =>
      opsAllow(env, ops, op, eco, name, version);
    expect(allow("yank", "composer", "acme/lib", "1.0.0")).toBe(true);
    expect(allow("yank", "composer", "acme/lib", "1.0.1")).toBe(false);
    expect(allow("yank", "composer", "acme/other", "1.0.0")).toBe(false);
    expect(allow("yank", "npm", "acme/lib", "1.0.0")).toBe(false);
    expect(allow("yank", "rpm", "acme/lib", "1.0.0")).toBe(false);
    // A yank was not approved for the whole package, and a delete only for the whole package.
    expect(allow("yank", "composer", "acme/lib")).toBe(false);
    expect(allow("delete", "composer", "acme/lib")).toBe(true);
    expect(allow("delete", "composer", "acme/lib", "1.0.0")).toBe(false);
    expect(allow("yank", "composer", "acme/lib", "not/a/version")).toBe(false);
  });

  it("rejects a token that mixes scopes and operations, or has a yank without a version", async () => {
    const { record, entryId } = await makeAdmin();
    const secretOf = async (scopes?: unknown, ops?: unknown) => {
      const token = await issueLoginToken(
        env,
        record.project,
        entryId,
        NOW.getTime() + 60_000,
        scopes as never,
        ops as never,
      );
      return token.slice(record.project.length + 4);
    };
    const op = { op: "yank", eco: "composer", package: "acme/lib", version: "1.0.0" };
    expect(
      await verifyLoginToken(env, record, await secretOf(undefined, [op]), NOW.getTime()),
    ).not.toBeNull();
    expect(
      await verifyLoginToken(env, record, await secretOf([version], [op]), NOW.getTime()),
    ).toBeNull();
    const noVersion = { op: "yank", eco: "composer", package: "acme/lib" };
    expect(
      await verifyLoginToken(env, record, await secretOf(undefined, [noVersion]), NOW.getTime()),
    ).toBeNull();
    expect(
      await verifyLoginToken(env, record, await secretOf(undefined, []), NOW.getTime()),
    ).toBeNull();
  });
});
