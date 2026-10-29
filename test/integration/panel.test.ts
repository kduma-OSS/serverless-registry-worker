import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleApi } from "../../src/api";
import { handlePanel } from "../../src/panel";
import { addPackageToMeta } from "../../src/core/storage";
import { storeLatestRelease } from "../../src/core/updates";
import { call, credential, ORIGIN, publishComposer } from "./helpers";

// The tests of this file run in order: the first ones see an empty registry.

/** What a browser sends with a form post from one of the registry's own pages. */
const SAME_ORIGIN: Readonly<Record<string, string>> = {
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
};

function post(
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = SAME_ORIGIN,
) {
  return exports.default.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields),
      redirect: "manual",
    }),
  );
}

function get(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = cookie === undefined ? {} : { cookie };
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { headers, redirect: "manual" }));
}

/** `sreg_session=<id>` from a login response. */
function cookieOf(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function login(token: string): Promise<string> {
  const res = await post("/login", { mode: "token", token });
  expect(res.status).toBe(303);
  return cookieOf(res);
}

/** The password of the first admin; its API token is a key added through the panel's session. */
const ADMIN_PASSWORD = "first-admin-password";

let adminToken = "";
let ciToken = "";
let readerCookie = "";

describe("first run", () => {
  it("shows the create-admin form while no credential exists", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('<form method="post" action="/first-run">');
    expect(page).not.toContain('action="/login"');
  });

  it("refuses a short or mismatched password and creates nothing", async () => {
    const attempts: Record<string, string>[] = [
      { project: "root", password: "short", password_repeat: "short" },
      { project: "root", password: "correct-horse", password_repeat: "correct-horsf" },
    ];
    for (const fields of attempts) {
      const res = await post("/first-run", fields);
      expect(res.status).toBe(400);
      const page = await res.text();
      expect(page).toContain('<p class="error" role="alert">');
      expect(page).toContain('value="root"');
      expect(page).not.toContain("correct-horse");
    }
    expect(await env.AUTH.get("cred:root")).toBeNull();
  });

  it("rejects an invalid project name", async () => {
    const res = await post("/first-run", { project: "Not Valid" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('<p class="error" role="alert">');
  });

  it("creates the admin, shows its password once and never shows the form again", async () => {
    const res = await post("/first-run", {
      project: "root",
      password: ADMIN_PASSWORD,
      password_repeat: ADMIN_PASSWORD,
    });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain(`<pre><code>${ADMIN_PASSWORD}</code></pre>`);
    expect(page).not.toContain("otpauth://");
    // An API token for the rest of the tests: a key the admin adds in the panel.
    const signedIn = await post("/login", {
      mode: "password",
      login: "root",
      password: ADMIN_PASSWORD,
    });
    expect(signedIn.status).toBe(303);
    const key = await exports.default.fetch(
      new Request(`${ORIGIN}/api/v1/credentials/root/secrets`, {
        method: "POST",
        headers: {
          cookie: cookieOf(signedIn),
          "content-type": "application/json",
          "x-requested-with": "fetch",
        },
        body: JSON.stringify({ type: "key" }),
      }),
    );
    expect(key.status).toBe(201);
    adminToken = (await key.json<{ token: string }>()).token;
    expect(adminToken).toMatch(/^root:[A-Za-z0-9]{32}$/);
    expect((await call("GET", "/api/v1/whoami", { token: adminToken })).status).toBe(200);

    const home = await (await get("/")).text();
    expect(home).toContain('action="/login"');
    expect(home).not.toContain("/first-run");

    const again = await post("/first-run", { project: "other" });
    expect(again.status).toBe(403);
    expect(await env.AUTH.get("cred:other")).toBeNull();
  });
});

describe("login", () => {
  it("logs in with a token and sets a secure session cookie", async () => {
    const res = await post("/login", { mode: "token", token: adminToken });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^sreg_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}; /);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=43200"]) {
      expect(cookie.split("; ")).toContain(attribute);
    }
    // The session lives in the signed cookie only: nothing is written to KV.
    expect((await env.AUTH.list({ prefix: "session:" })).keys).toEqual([]);
    const home = await get("/", cookieOf(res));
    expect(await home.text()).not.toContain('action="/login"');
  });

  it("refuses a session cookie whose payload or signature was changed", async () => {
    const cookie = await login(adminToken);
    const [payload = "", signature = ""] = (cookie.split("=")[1] ?? "").split(".");
    const forgedPayload = btoa(JSON.stringify({ project: "root", exp: 4102444800 }))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    for (const value of [`${forgedPayload}.${signature}`, `${payload}.${"A".repeat(43)}`]) {
      const home = await get("/", `sreg_session=${value}`);
      expect(await home.text()).toContain('action="/login"');
    }
  });

  it("logs in with a login and password, but a token is not a password", async () => {
    const ok = await post("/login", { mode: "password", login: "root", password: ADMIN_PASSWORD });
    expect(ok.status).toBe(303);
    expect(cookieOf(ok)).toMatch(/^sreg_session=/);
    const [user, secret = ""] = adminToken.split(":");
    for (const password of [secret, adminToken]) {
      const res = await post("/login", { mode: "password", login: user ?? "", password });
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("answers 401 with the login page and an error for wrong credentials", async () => {
    const attempts: Record<string, string>[] = [
      { mode: "token", token: "root:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      { mode: "token", token: "" },
      { mode: "password", login: "root", password: "wrong" },
    ];
    for (const fields of attempts) {
      const res = await post("/login", fields);
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain('<p class="error" role="alert">');
    }
  });

  it("accepts form posts from its own pages", async () => {
    const fields = { mode: "token", token: adminToken };
    // A page served with a referrer policy that hides the origin: Chromium sends `Origin: null`.
    const hidden = await post("/login", fields, {
      origin: "null",
      "sec-fetch-site": "same-origin",
    });
    expect(hidden.status).toBe(303);
    expect((await post("/login", fields, { origin: ORIGIN })).status).toBe(303);
    expect((await post("/login", fields, { "sec-fetch-site": "none" })).status).toBe(303);
  });

  it("refuses cross-site form posts", async () => {
    const fields = { mode: "token", token: adminToken };
    const refused: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: "null", "sec-fetch-site": "cross-site" },
      { origin: "null", "sec-fetch-site": "same-site" },
      { origin: "null" },
      {},
    ];
    for (const headers of refused) {
      const res = await post("/login", fields, headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.text()).toContain("Cross-site form posts are refused.");
    }
    for (const path of ["/first-run", "/logout"]) {
      const res = await post(path, {}, { origin: "null", "sec-fetch-site": "cross-site" });
      expect(res.status).toBe(403);
    }
  });
});

describe("HTML responses", () => {
  it("carry the CSP and the other security headers", async () => {
    for (const res of [await get("/"), await post("/login", {})]) {
      expect(res.headers.get("content-security-policy")).toMatch(/^default-src 'self'/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("answers HEAD without a body", async () => {
    const res = await exports.default.fetch(new Request(`${ORIGIN}/`, { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("serves the stylesheet, script and icon from public/", async () => {
    const types: Record<string, RegExp> = {
      "/app.css": /^text\/css/,
      "/app.js": /javascript/,
      "/favicon.svg": /^image\/svg\+xml/,
    };
    for (const [path, type] of Object.entries(types)) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(type);
      expect((await res.text()).length).toBeGreaterThan(0);
    }
  });

  it("scope the script by the page and send X-Requested-With with API calls", async () => {
    const script = await (await get("/app.js")).text();
    expect(script).toContain('document.body.getAttribute("data-page")');
    expect(script).toContain('"X-Requested-With": "fetch"');
  });
});

describe("views", () => {
  it("shows a consumer one sorted list of its granted packages", async () => {
    const ci = await credential("panel-ci", "publish", [
      { eco: "composer", package: "acme/*", versions: "*" },
    ]);
    ciToken = ci;
    expect((await publishComposer(ci, "acme/http", "1.1.0")).status).toBe(201);
    const sdk = { require: { php: "^8.1", "acme/http": "^1.0" } };
    expect((await publishComposer(ci, "acme/sdk", "1.0.0", "a", sdk)).status).toBe(201);
    expect((await publishComposer(ci, "acme/sdk", "1.1.0", "b", sdk)).status).toBe(201);
    await call("POST", "/api/v1/packages/composer/acme%2Fsdk/1.0.0/yank", { token: adminToken });
    await call("POST", "/api/v1/packages/composer/acme%2Fsdk/1.1.0/yank", { token: adminToken });
    expect((await publishComposer(ci, "acme/sdk", "1.2.0", "c", sdk)).status).toBe(201);
    expect((await publishComposer(ci, "acme/private", "1.0.0")).status).toBe(201);
    expect((await publishComposer(ci, "acme/billing", "2.0.0")).status).toBe(201);
    await call("POST", "/api/v1/packages/composer/acme%2Fbilling/2.0.0/yank", {
      token: adminToken,
    });
    const reader = await credential("panel-shop", "read", [
      { eco: "composer", package: "acme/sdk", versions: "^1.1" },
      { eco: "composer", package: "acme/billing", versions: "*" },
    ]);
    readerCookie = await login(reader);

    const page = await (await get("/", readerCookie)).text();
    expect(page).toContain("Signed in as <strong>panel-shop</strong>");
    expect(page).toContain("<h1>Your packages</h1>");
    expect(page).not.toContain("<h2>Composer</h2>");
    const billing = page.indexOf('href="/packages/composer/acme%2Fbilling"');
    const sdkRow = page.indexOf('href="/packages/composer/acme%2Fsdk"');
    expect(billing).toBeGreaterThan(0);
    expect(sdkRow).toBeGreaterThan(billing);
    expect(page).toContain('<span class="eco-badge" data-eco="composer">Composer</span>');
    expect(page).toContain(
      '<span>2 versions</span><span class="pkg-latest">latest <span class="version">1.2.0</span></span>',
    );
    expect(page).toContain(
      '<span class="version">2.0.0</span> <span class="badge warn">yanked</span>',
    );
    expect(page).not.toContain("acme/http");
    expect(page).not.toContain("acme/private");
    expect(page).not.toContain("data-copy");
    expect(page).toContain("data-pkg-filter hidden");
    expect(page).not.toContain("data-api-url");
  });

  it("tells a publish credential that it can only publish", async () => {
    const ci = await credential("panel-ci2", "publish", []);
    const page = await (await get("/", await login(ci))).text();
    expect(page).toContain("This credential can only publish.");
  });

  it("sends an admin from the home page to the admin pages", async () => {
    const cookie = await login(adminToken);
    const home = await get("/", cookie);
    expect(home.status).toBe(303);
    expect(home.headers.get("location")).toBe("/admin/packages");
    // The tabs of the former admin view still lead to their pages.
    const tab = await get("/?tab=credentials", cookie);
    expect(tab.headers.get("location")).toBe("/admin/credentials");
  });

  it("shows the admin pages with the navigation", async () => {
    const cookie = await login(adminToken);
    const packages = await (await get("/admin/packages", cookie)).text();
    expect(packages).toContain('<a href="/admin/packages" aria-current="page">Packages</a>');
    expect(packages).toContain('href="/packages/composer/acme%2Fprivate"');
    expect(packages).toContain('data-api-url="/api/v1/packages/composer/acme%2Fsdk/reindex"');

    const credentials = await (await get("/admin/credentials", cookie)).text();
    expect(credentials).toContain('aria-current="page">Credentials</a>');
    expect(credentials).toContain('href="/admin/credentials/panel-shop">panel-shop</a>');

    const shop = await get("/admin/credentials/panel-shop", cookie);
    expect(shop.status).toBe(200);
    const page = await shop.text();
    expect(page).toContain("<div><dt>Login</dt><dd><code>panel-shop</code></dd></div>");
    const danger = await (await get("/admin/credentials/panel-shop?tab=danger", cookie)).text();
    expect(danger).toContain('data-api-url="/api/v1/credentials/panel-shop" data-confirm-name');
    const secrets = await (await get("/admin/credentials/panel-shop?tab=secrets", cookie)).text();
    expect(secrets).toContain('action="/admin/credentials/panel-shop/secrets"');
    expect(secrets).toContain('<details class="add-secret" id="add-secret">');
    const adding = await get("/admin/credentials/panel-shop?tab=secrets&add=1", cookie);
    expect(await adding.text()).toContain('<details class="add-secret" id="add-secret" open>');
    const unknown = await (await get("/admin/credentials/panel-shop?tab=nope", cookie)).text();
    expect(unknown).toContain(
      'href="/admin/credentials/panel-shop?tab=overview" aria-current="page"',
    );

    const missing = await get("/admin/credentials/nobody", cookie);
    expect(missing.status).toBe(404);

    const form = await (await get("/admin/credentials/new", cookie)).text();
    expect(form).toContain('action="/admin/credentials/new"');

    await storeLatestRelease({
      tag: "v99.0.0",
      url: "https://github.com/kduma-OSS/serverless-registry-worker/releases/tag/v99.0.0",
      checkedAt: new Date().toISOString(),
    });
    const settings = await (await get("/admin/settings", cookie)).text();
    expect(settings).toContain('aria-current="page">Settings</a>');
    expect(settings).toContain('<code class="setup-name">ECOSYSTEMS</code>');
    // The test bindings carry every required setting, never shown.
    expect(settings).toContain(
      '<code class="setup-name">S3_SECRET_ACCESS_KEY</code> <span class="status" data-status="set">Set</span>',
    );
    expect(settings).not.toContain("test-secret-access-key");
    // PUBLIC_URL is unset in the tests: the Worker uses the request's origin.
    expect(settings).toMatch(
      /<code class="setup-name">PUBLIC_URL<\/code> <span class="status" data-status="missing">Missing<\/span>/,
    );
    expect(settings).toMatch(
      /Value: <code>https?:\/\/[^<]+<\/code> <span class="hint">\(default\)<\/span>/,
    );
    // R2_BUCKET_NAME is a plain variable: its value is shown like the others.
    expect(settings).toMatch(
      /<code class="setup-name">R2_BUCKET_NAME<\/code>[\s\S]*?Value: <code>serverless-registry<\/code><\/p>/,
    );
    expect(settings).toContain(">v99.0.0</a> is available.");
  });

  it("gives an admin the package actions on the package page", async () => {
    const cookie = await login(adminToken);
    const page = await (await get("/packages/composer/acme%2Fsdk", cookie)).text();
    expect(page).toContain('<li><a href="/admin/packages">Packages</a></li>');
    expect(page).toContain('data-api-url="/api/v1/packages/composer/acme%2Fsdk/1.2.0/yank"');
    expect(page).toContain('data-api-url="/api/v1/packages/composer/acme%2Fsdk/1.0.0"');
    expect(page).toContain('data-confirm-name="acme/sdk" data-api-next="/admin/packages"');
    // Every version's dependencies, collapsed, though an admin has no grants.
    expect(page).toContain('<details class="dependencies">\n<summary>Dependencies (1)</summary>');
    expect(page).toContain('<a href="/packages/composer/acme%2Fhttp">acme/http</a>');
    const reader = await (await get("/packages/composer/acme%2Fsdk", readerCookie)).text();
    expect(reader).not.toContain("data-api");
  });

  it("keeps the admin pages from other credentials", async () => {
    const paths = [
      "/admin/packages",
      "/admin/credentials",
      "/admin/credentials/new",
      "/admin/settings",
    ];
    for (const path of paths) {
      const anonymous = await get(path);
      expect(anonymous.status, path).toBe(303);
      expect(anonymous.headers.get("location")).toBe("/");
      const reader = await get(path, readerCookie);
      expect(reader.status, path).toBe(403);
      expect(await reader.text()).toContain("This page is only for admin credentials.");
      const publisher = await get(path, await login(ciToken));
      expect(publisher.status, path).toBe(403);
    }
    const post = await exports.default.fetch(
      new Request(`${ORIGIN}/admin/credentials/new`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...SAME_ORIGIN,
          cookie: readerCookie,
        },
        body: new URLSearchParams([
          ["project", "sneaky"],
          ["roles", "admin"],
        ]),
      }),
    );
    expect(post.status).toBe(403);
    expect(await env.AUTH.get("cred:sneaky")).toBeNull();
  });
});

describe("credential forms", () => {
  function adminPost(
    path: string,
    fields: [string, string][],
    cookie: string,
    headers = SAME_ORIGIN,
  ) {
    return exports.default.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers, cookie },
        body: new URLSearchParams(fields),
        redirect: "manual",
      }),
    );
  }

  function tokenOf(page: string): string {
    return /<pre><code>([^<]+)<\/code><\/pre>/.exec(page)?.[1] ?? "";
  }

  it("create a credential with its grants and a key as the first secret, shown once", async () => {
    const cookie = await login(adminToken);
    const res = await adminPost(
      "/admin/credentials/new",
      [
        ["project", "form-shop"],
        ["roles", "read"],
        ["first_secret", "key"],
        ["description", "CI of the shop"],
        ["read_grant", "0"],
        ["read_grant_eco", "composer"],
        ["read_grant_package", "acme/sdk"],
        ["read_grant_versions", "^1.1"],
        ["read_grant", "added-1"],
        ["read_grant_eco", "composer"],
        ["read_grant_package", "acme/billing"],
        ["read_grant_versions", ""],
        ["read_grant_transitive", "added-1"],
        ["read_grant", "added-2"],
        ["read_grant_eco", "composer"],
        ["read_grant_package", ""],
        ["read_grant_versions", "*"],
      ],
      cookie,
    );
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("<h1>Credential created</h1>");
    expect(page).toContain('<a class="button block" href="/admin/credentials/form-shop">');
    const token = tokenOf(page);
    expect(token).toMatch(/^form-shop:[A-Za-z0-9]{32}$/);
    expect((await call("GET", "/api/v1/whoami", { token })).status).toBe(200);
    // The message for the person the token is for: server, login, token, what it may do, how.
    expect(page).toContain("Message for the user");
    const message =
      /<textarea hidden readonly data-handover-text>([\s\S]*?)<\/textarea>/.exec(page)?.[1] ?? "";
    expect(message).toMatch(new RegExp(`Server:\\s+${ORIGIN}`));
    expect(message).toMatch(/Login:\s+form-shop/);
    expect(message).toContain(token);
    expect(message).toContain("Read access");
    expect(message).toContain("Composer: acme/sdk (versions ^1.1)");
    expect(message).toContain("Composer: acme/billing (all versions)");
    expect(message).toContain("Using Composer packages");
    expect(message).not.toContain("Publish access");
    expect(page).toContain('<script src="/handover.js" defer></script>');
    // These pages (and only these) may load the PDF library from cdnjs.
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    const stored = await (
      await call("GET", "/api/v1/credentials/form-shop", { token: adminToken })
    ).json();
    expect(stored).toMatchObject({
      kind: "read",
      roles: ["read"],
      auth: [{ type: "key", description: "CI of the shop", scope: ["read"] }],
      grants: [
        { eco: "composer", package: "acme/sdk", versions: "^1.1", transitive: false },
        { eco: "composer", package: "acme/billing", versions: "*", transitive: true },
      ],
    });
  });

  it("create a credential without a secret by default and go to its secrets", async () => {
    const cookie = await login(adminToken);
    const res = await adminPost(
      "/admin/credentials/new",
      [
        ["project", "form-bare"],
        ["roles", "publish"],
        ["grant", "0"],
        ["grant_eco", "composer"],
        ["grant_package", "acme/*"],
        ["grant_versions", "*"],
      ],
      cookie,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/credentials/form-bare?tab=secrets");
    const stored = await (
      await call("GET", "/api/v1/credentials/form-bare", { token: adminToken })
    ).json();
    expect(stored).toMatchObject({ kind: "publish", auth: [] });
  });

  it("create a credential with a login and a one-time code, shown once with a QR code", async () => {
    const cookie = await login(adminToken);
    const res = await adminPost(
      "/admin/credentials/new",
      [
        ["project", "form-login"],
        ["roles", "read"],
        ["first_secret", "login"],
        ["totp", "on"],
        ["description", "Jane"],
      ],
      cookie,
    );
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("<h1>Credential created</h1>");
    expect(page).toContain('<div class="qr"><svg ');
    expect(page).toMatch(/otpauth:\/\/totp\/[^<]*form-login\?secret=[A-Z2-7]+/);
    expect(page).toContain("Sign in as <code>form-login</code> with this password.");
    const msg =
      /<textarea hidden readonly data-handover-text>([\s\S]*?)<\/textarea>/.exec(page)?.[1] ?? "";
    expect(msg).toMatch(/Password:\s+\S{12,}/);
    expect(msg).toContain("authenticator app");
    expect(msg).toMatch(/Link:\s+otpauth:\/\/totp\/[^\s]*form-login\?secret=[A-Z2-7]+/);
    expect(msg).toContain(`sreg login --registry ${ORIGIN}`);
    expect(page).toMatch(/<canvas width="1" height="1" data-handover-qr="[01,]+"/);
    expect(res.headers.get("content-security-policy")).toContain("https://cdnjs.cloudflare.com");
    const stored = await (
      await call("GET", "/api/v1/credentials/form-login", { token: adminToken })
    ).json();
    expect(stored).toMatchObject({
      auth: [{ type: "login", totp: true, description: "Jane" }],
    });
  });

  it("create a credential with both roles and a scoped first key", async () => {
    const cookie = await login(adminToken);
    const refused = await adminPost(
      "/admin/credentials/new",
      [
        ["project", "form-dual"],
        ["roles", "read"],
        ["roles", "publish"],
        ["first_secret", "key"],
      ],
      cookie,
    );
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("`scope` is required");

    const res = await adminPost(
      "/admin/credentials/new",
      [
        ["project", "form-dual"],
        ["roles", "read"],
        ["roles", "publish"],
        ["first_secret", "key"],
        ["scope", "read"],
        ["read_grant", "0"],
        ["read_grant_eco", "composer"],
        ["read_grant_package", "acme/sdk"],
        ["read_grant_versions", "*"],
        ["publish_grant", "0"],
        ["publish_grant_eco", "composer"],
        ["publish_grant_package", "acme/sdk"],
        ["publish_grant_versions", "*"],
      ],
      cookie,
    );
    expect(res.status).toBe(200);
    const token = tokenOf(await res.text());
    const whoami = await call("GET", "/api/v1/whoami", { token });
    expect(await whoami.json()).toMatchObject({ project: "form-dual", roles: ["read"] });
    const stored = await call("GET", "/api/v1/credentials/form-dual", { token: adminToken });
    expect(await stored.json()).toMatchObject({
      roles: ["read", "publish"],
      read_grants: [{ package: "acme/sdk" }],
      publish_grants: [{ package: "acme/sdk" }],
    });
  });

  it("adds a publish-scoped token that cannot open the panel", async () => {
    const cookie = await login(adminToken);
    const res = await adminPost(
      "/admin/credentials/form-dual/secrets",
      [
        ["type", "key"],
        ["scope", "publish"],
      ],
      cookie,
    );
    expect(res.status).toBe(200);
    const token = tokenOf(await res.text());
    expect(await (await call("GET", "/api/v1/whoami", { token })).json()).toMatchObject({
      roles: ["publish"],
    });
    expect((await post("/login", { mode: "token", token })).status).toBe(401);
  });

  it("opens the panel with a read-scoped login but not with a publish-scoped one", async () => {
    const cookie = await login(adminToken);
    for (const [scope, password] of [
      ["publish", "publish-scoped-pass"],
      ["read", "read-scoped-pass-1"],
    ] as const) {
      const res = await adminPost(
        "/admin/credentials/form-dual/secrets",
        [
          ["type", "login"],
          ["scope", scope],
          ["password", password],
          ["password_repeat", password],
        ],
        cookie,
      );
      expect(res.status).toBe(200);
    }
    const publishOnly = await post("/login", {
      mode: "password",
      login: "form-dual",
      password: "publish-scoped-pass",
    });
    expect(publishOnly.status).toBe(401);
    const readOnly = await post("/login", {
      mode: "password",
      login: "form-dual",
      password: "read-scoped-pass-1",
    });
    expect(readOnly.status).toBe(303);
  });

  it("opens the admin or the consumer panel by the scope of the login of an admin + read credential", async () => {
    const cookie = await login(adminToken);
    const created = await adminPost(
      "/admin/credentials/new",
      [
        ["project", "form-opsread"],
        ["roles", "read"],
        ["roles", "admin"],
        ["first_secret", "key"],
        ["scope", "admin"],
        ["read_grant", "0"],
        ["read_grant_eco", "composer"],
        ["read_grant_package", "acme/sdk"],
        ["read_grant_versions", "*"],
      ],
      cookie,
    );
    expect(created.status).toBe(200);
    for (const [scope, password] of [
      ["admin", "ops-admin-login-pass"],
      ["read", "ops-reader-login-pass"],
    ] as const) {
      const res = await adminPost(
        "/admin/credentials/form-opsread/secrets",
        [
          ["type", "login"],
          ["scope", scope],
          ["password", password],
          ["password_repeat", password],
        ],
        cookie,
      );
      expect(res.status).toBe(200);
    }
    const home = async (password: string) => {
      const res = await post("/login", { mode: "password", login: "form-opsread", password });
      expect(res.status).toBe(303);
      return exports.default.fetch(
        new Request(`${ORIGIN}/`, { headers: { cookie: cookieOf(res) }, redirect: "manual" }),
      );
    };
    const asAdmin = await home("ops-admin-login-pass");
    expect(asAdmin.status).toBe(303);
    expect(asAdmin.headers.get("location")).toBe("/admin/packages");
    const asReader = await home("ops-reader-login-pass");
    expect(asReader.status).toBe(200);
    expect(await asReader.text()).not.toContain("Credentials</a>");
  });

  it("edits the roles of an existing secret in place, like editing a GitHub Actions secret", async () => {
    const cookie = await login(adminToken);
    const stored = await (
      await call("GET", "/api/v1/credentials/form-dual", { token: adminToken })
    ).json<{ auth: { id: string; type: string; scope: string[] }[] }>();
    const key = stored.auth.find((e) => e.type === "key" && e.scope.join() === "read");
    expect(key).toBeDefined();
    const id = key?.id ?? "";

    const page = await exports.default.fetch(
      new Request(`${ORIGIN}/admin/credentials/form-dual?tab=secrets&edit=${id}`, {
        headers: { cookie },
      }),
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`Editing the roles of the secret <code>${id}</code>`);
    expect(html).toContain(`action="/admin/credentials/form-dual/secrets/${id}"`);

    const refused = await adminPost(
      `/admin/credentials/form-dual/secrets/${id}`,
      [["scope", "admin"]],
      cookie,
    );
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain(`Editing the roles of the secret <code>${id}</code>`);

    const saved = await adminPost(
      `/admin/credentials/form-dual/secrets/${id}`,
      [["scope", "both"]],
      cookie,
    );
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/admin/credentials/form-dual?tab=secrets");
    const after = await (
      await call("GET", "/api/v1/credentials/form-dual", { token: adminToken })
    ).json<{ auth: { id: string; scope: string[] }[] }>();
    expect(after.auth.find((e) => e.id === id)?.scope).toEqual(["read", "publish"]);

    const foreign = await exports.default.fetch(
      new Request(`${ORIGIN}/admin/credentials/form-dual/secrets/${id}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams([["scope", "read"]]),
        redirect: "manual",
      }),
    );
    expect(foreign.status).toBe(403);
  });

  it("create an admin credential with a login and a chosen password", async () => {
    const cookie = await login(adminToken);
    const password = "correct-horse-battery";
    const res = await adminPost(
      "/admin/credentials/new",
      [
        ["project", "form-ops"],
        ["roles", "admin"],
        ["password", password],
        ["password_repeat", password],
      ],
      cookie,
    );
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Sign in as <code>form-ops</code> with this password.");
    expect(tokenOf(page)).toBe(password);
    const signIn = await post("/login", { mode: "password", login: "form-ops", password });
    expect(signIn.status).toBe(303);
  });

  it("show the create form again with the error", async () => {
    const cookie = await login(adminToken);
    const taken = await adminPost(
      "/admin/credentials/new",
      [
        ["project", "form-shop"],
        ["roles", "publish"],
      ],
      cookie,
    );
    expect(taken.status).toBe(409);
    const page = await taken.text();
    expect(page).toContain('<p class="error" role="alert">This credential already exists.</p>');
    expect(page).toContain('value="publish" checked');

    const mismatch = await adminPost(
      "/admin/credentials/new",
      [
        ["project", "form-ops2"],
        ["roles", "admin"],
        ["password", "correct-horse-battery"],
        ["password_repeat", "correct-horse-batterz"],
      ],
      cookie,
    );
    expect(mismatch.status).toBe(400);
    const again = await mismatch.text();
    expect(again).toContain("The passwords do not match.");
    expect(again).not.toContain("correct-horse");
    expect(await env.AUTH.get("cred:form-ops2")).toBeNull();
  });

  it("refuse cross-site posts", async () => {
    const cookie = await login(adminToken);
    for (const path of ["/admin/credentials/new", "/admin/credentials/form-shop/secrets"]) {
      const res = await adminPost(
        path,
        [
          ["project", "evil"],
          ["roles", "admin"],
        ],
        cookie,
        {
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        },
      );
      expect(res.status, path).toBe(403);
    }
    expect(await env.AUTH.get("cred:evil")).toBeNull();
  });

  it("add a key secret and show its token once", async () => {
    const cookie = await login(adminToken);
    const res = await adminPost(
      "/admin/credentials/form-shop/secrets",
      [
        ["type", "key"],
        ["expires", "2099-01-01"],
      ],
      cookie,
    );
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("<h1>Secret added</h1>");
    expect(page).toContain('href="/admin/credentials/form-shop?tab=secrets"');
    const token = tokenOf(page);
    expect(token).toMatch(/^form-shop:/);
    const message =
      /<textarea hidden readonly data-handover-text>([\s\S]*?)<\/textarea>/.exec(page)?.[1] ?? "";
    expect(message).toContain(token);
    expect(message).toMatch(/Valid until:\s+2099-01-01/);
    expect(message).toContain("Read access");
    expect(res.headers.get("content-security-policy")).toContain("https://cdnjs.cloudflare.com");
    expect((await call("GET", "/api/v1/whoami", { token })).status).toBe(200);
  });

  it("add a gh secret and go back to the credential", async () => {
    const cookie = await login(adminToken);
    const res = await adminPost(
      "/admin/credentials/form-shop/secrets",
      [
        ["type", "gh"],
        ["repository", "acme/shop"],
        ["repository_id", ""],
        ["repository_owner_id", ""],
        ["pin_on_first_use", "on"],
        ["ref", "refs/tags/v*"],
        ["workflow", ""],
        ["environment", ""],
        ["password", "ignored-for-gh-secrets"],
      ],
      cookie,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/credentials/form-shop?tab=secrets");
    const unpinned = await adminPost(
      "/admin/credentials/form-shop/secrets",
      [
        ["type", "gh"],
        ["repository", "acme/other"],
      ],
      cookie,
    );
    expect(unpinned.status).toBe(303);
    const stored = await (
      await call("GET", "/api/v1/credentials/form-shop", { token: adminToken })
    ).json();
    expect(stored).toMatchObject({
      auth: [
        { type: "key" },
        { type: "key" },
        { type: "gh", repository: "acme/shop", ref: "refs/tags/v*", pin_on_first_use: true },
        { type: "gh", repository: "acme/other", pin_on_first_use: false },
      ],
    });
    const page = await (await get("/admin/credentials/form-shop?tab=secrets", cookie)).text();
    expect(page.match(/pinned on first use/g)).toHaveLength(1);
  });

  it("add a login secret and show its password and one-time code once", async () => {
    await call("POST", "/api/v1/credentials", {
      token: adminToken,
      body: { project: "login-shop", kind: "read", grants: [] },
    });
    const cookie = await login(adminToken);
    const form = await (
      await get("/admin/credentials/login-shop?tab=secrets&add=1", cookie)
    ).text();
    expect(form).toContain('value="login"');
    expect(form).toContain('name="totp"');
    const res = await adminPost(
      "/admin/credentials/login-shop/secrets",
      [
        ["type", "login"],
        ["totp", "on"],
        ["password", "correct-horse-battery"],
        ["password_repeat", "correct-horse-battery"],
      ],
      cookie,
    );
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("<h1>Login added</h1>");
    expect(page).toContain("correct-horse-battery");
    const message =
      /<textarea hidden readonly data-handover-text>([\s\S]*?)<\/textarea>/.exec(page)?.[1] ?? "";
    expect(message).toMatch(/Password:\s+correct-horse-battery/);
    expect(message).toContain("One-time code");
    expect(page).toContain('<div class="qr"><svg ');
    expect(page).toMatch(/otpauth:\/\/totp\/[^<]*login-shop\?secret=[A-Z2-7]+/);
    const stored = JSON.stringify(
      await (await call("GET", "/api/v1/credentials/login-shop", { token: adminToken })).json(),
    );
    expect(stored).toContain('"type":"login"');
    expect(stored).toContain('"totp":true');
    expect(stored).not.toContain("correct-horse-battery");

    const mismatch = await adminPost(
      "/admin/credentials/login-shop/secrets",
      [
        ["type", "login"],
        ["password", "correct-horse-battery"],
        ["password_repeat", "different-password-here"],
      ],
      cookie,
    );
    expect(mismatch.status).toBe(400);

    // An admin credential can have a login too, and a key is never a password.
    const admin = await (await get("/admin/credentials/root?tab=secrets&add=1", cookie)).text();
    expect(admin).toContain('value="login"');
    expect(admin).toContain('data-password="type:login"');
    expect(admin).not.toContain("type:key");
  });

  it("ignore a password typed for a key and generate the token", async () => {
    const cookie = await login(adminToken);
    const res = await adminPost(
      "/admin/credentials/login-shop/secrets",
      [
        ["type", "key"],
        ["password", "correct-horse-battery"],
        ["password_repeat", "correct-horse-battery"],
        ["description", "for CI"],
      ],
      cookie,
    );
    expect(res.status).toBe(200);
    const token = tokenOf(await res.text());
    expect(token).toMatch(/^login-shop:[A-Za-z0-9]{32}$/);
    expect(token).not.toContain("correct-horse-battery");
  });

  it("show the credential again with the error of a refused secret", async () => {
    const cookie = await login(adminToken);
    const res = await adminPost(
      "/admin/credentials/form-shop/secrets",
      [
        ["type", "gh"],
        ["repository", "not a repository"],
      ],
      cookie,
    );
    expect(res.status).toBe(400);
    const page = await res.text();
    expect(page).toContain("`repository` must be `owner/repo` or `owner/*`.");
    expect(page).toContain("<h1>form-shop");
    // The tabs of a page answering a post link to the credential, not to the post's path.
    expect(page).toContain('href="/admin/credentials/form-shop?tab=secrets" aria-current="page"');
    expect(page).toContain('<details class="add-secret" id="add-secret" open>');
    const gone = await adminPost("/admin/credentials/nobody/secrets", [["type", "key"]], cookie);
    expect(gone.status).toBe(404);
  });

  it("reach a credential called new past the create form", async () => {
    const cookie = await login(adminToken);
    await credential("new", "read", []);
    const res = await get("/admin/credentials/%6Eew", cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<div><dt>Login</dt><dd><code>new</code></dd></div>");
    const list = await (await get("/admin/credentials", cookie)).text();
    expect(list).toContain('href="/admin/credentials/%6Eew">new</a>');
  });

  it("show the description of every secret in a cell that saves it with a PATCH", async () => {
    const cookie = await login(adminToken);
    const page = await (await get("/admin/credentials/form-shop?tab=secrets", cookie)).text();
    expect(page).toContain("<th>Description</th>");
    expect(page).toContain(
      'data-api-form="describe" data-api-method="PATCH" data-api-url="/api/v1/credentials/form-shop/secrets/',
    );
    expect(page).toContain('maxlength="200"');
    expect(page).toContain('value="CI of the shop"');
    // The same endpoint the cell uses changes and clears the description.
    const view = await (
      await call("GET", "/api/v1/credentials/form-shop", { token: adminToken })
    ).json<{ auth: { id: string; type: string }[] }>();
    const key = view.auth.find((e) => e.type === "key");
    const patched = await call("PATCH", `/api/v1/credentials/form-shop/secrets/${key?.id}`, {
      token: adminToken,
      body: { description: "renamed" },
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ secret: { id: key?.id, description: "renamed" } });
  });

  describe("editing a GitHub Actions secret", () => {
    const ghEntries = async () =>
      (
        await (
          await call("GET", "/api/v1/credentials/form-shop", { token: adminToken })
        ).json<{
          auth: { id: string; type: string; repository?: string; expires: string | null }[];
        }>()
      ).auth.filter((e) => e.type === "gh");

    it("offers Edit on a gh secret and fills the form with it", async () => {
      const cookie = await login(adminToken);
      const [entry] = await ghEntries();
      const list = await (await get("/admin/credentials/form-shop?tab=secrets", cookie)).text();
      expect(list).toContain(`?tab=secrets&amp;edit=${entry?.id}#add-secret">Edit</a>`);
      const page = await (
        await get(`/admin/credentials/form-shop?tab=secrets&edit=${entry?.id}`, cookie)
      ).text();
      expect(page).toContain(`Editing the secret <code>${entry?.id}</code>`);
      expect(page).toContain(`<input type="hidden" name="edit_of" value="${entry?.id}">`);
      expect(page).toContain(
        `name="repository" placeholder="owner/repo or owner/*" spellcheck="false" value="${entry?.repository}"`,
      );
      expect(page).toContain('name="expire_old" checked>');
      expect(page).toContain('<details class="add-secret" id="add-secret" open>');
      expect(page).toContain("Save as a new secret");
      // Only a gh secret can be edited; anything else opens the plain form.
      const view = await (
        await call("GET", "/api/v1/credentials/form-shop", { token: adminToken })
      ).json<{ auth: { id: string; type: string }[] }>();
      const key = view.auth.find((e) => e.type === "key");
      const plain = await (
        await get(`/admin/credentials/form-shop?tab=secrets&edit=${key?.id}`, cookie)
      ).text();
      expect(plain).not.toContain("Editing the secret");
    });

    it("saves a changed copy and expires the old one, or keeps it when the box is off", async () => {
      const cookie = await login(adminToken);
      const [entry] = await ghEntries();
      const edit = (extra: [string, string][]) =>
        adminPost(
          "/admin/credentials/form-shop/secrets",
          [
            ["type", "gh"],
            ["repository", entry?.repository ?? ""],
            ["ref", "refs/heads/main"],
            ["edit_of", entry?.id ?? ""],
            ["description", "edited"],
            ...extra,
          ],
          cookie,
        );
      const kept = await edit([]);
      expect(kept.status).toBe(303);
      let entries = await ghEntries();
      expect(entries.find((e) => e.id === entry?.id)?.expires).toBeNull();
      expect(entries).toHaveLength(3);

      const replaced = await edit([
        ["expire_old", "on"],
        ["description", "edited twice"],
      ]);
      // The first copy is now an identical active entry, so this one is refused.
      expect(replaced.status).toBe(400);
      expect(await replaced.text()).toContain("An identical active `gh` entry already exists.");

      const changed = await adminPost(
        "/admin/credentials/form-shop/secrets",
        [
          ["type", "gh"],
          ["repository", entry?.repository ?? ""],
          ["ref", "refs/tags/v*"],
          ["edit_of", entry?.id ?? ""],
          ["expire_old", "on"],
        ],
        cookie,
      );
      expect(changed.status).toBe(303);
      entries = await ghEntries();
      expect(entries.find((e) => e.id === entry?.id)?.expires).not.toBeNull();
      expect(entries).toHaveLength(4);
    });
  });
});

describe("package pages", () => {
  it("show a consumer a granted package with versions, dependencies and snippets", async () => {
    const res = await get("/packages/composer/acme%2Fsdk", readerCookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const page = await res.text();
    expect(page).toContain("<h1>acme/sdk</h1>");
    expect(page).toContain('<li><a href="/">Packages</a></li>');
    expect(page).toContain('href="/packages/composer/acme%2Fsdk/1.2.0">1.2.0</a>');
    expect(page).toContain(
      'href="/packages/composer/acme%2Fsdk/1.1.0">1.1.0</a>\n<span class="badge warn">yanked</span>',
    );
    expect(page).not.toContain(">1.0.0<");
    expect(page).toContain("<summary>Dependencies (1)</summary>");
    expect(page).toContain('<a href="/packages/composer/acme%2Fhttp">acme/http</a>');
    expect(page).toContain("https://&lt;token&gt;@registry.test/composer");
    expect(page).toContain("composer require acme/sdk");
    expect(page).not.toContain("acme/billing");
    expect(page).toContain("replace <code>&lt;token&gt;</code> with your token");
    expect(page).toContain("data-copy");
  });

  it("show a package the grant opens transitively, and hide everything else", async () => {
    const http = await get("/packages/composer/acme%2Fhttp", readerCookie);
    expect(http.status).toBe(200);
    const page = await http.text();
    expect(page).toContain("Available as a dependency of a package granted to this credential.");
    expect(page).toContain('href="/packages/composer/acme%2Fhttp/1.1.0">1.1.0</a>');

    for (const path of [
      "/packages/composer/acme%2Fprivate",
      "/packages/composer/acme%2Fmissing",
      "/packages/nuget/acme%2Fsdk",
      "/packages/unknown/acme%2Fsdk",
      "/packages/composer/acme%2Fsdk/1.0.0",
      "/packages/composer/acme%2Fprivate/1.0.0",
      "/packages/composer/acme%2Fsdk/9.9.9",
      "/packages/composer/acme%2Fsdk/1.0.0/files/acme-sdk-1.0.0.zip",
      "/packages/composer/acme%2Fsdk/1.2.0/files/other.zip",
      "/packages/composer/acme%2Fsdk/1.2.0/files/manifest.json",
    ]) {
      const res = await get(path, readerCookie);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toContain("<h1>Not found</h1>");
    }
  });

  it("show a version's files with checksums, a download link and how to get it", async () => {
    const res = await get("/packages/composer/acme%2Fsdk/1.2.0", readerCookie);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('<h1>acme/sdk <span class="version">1.2.0</span></h1>');
    expect(page).toContain('<span class="file-name">acme-sdk-1.2.0.zip</span>');
    expect(page).toMatch(/<dt>sha256<\/dt><dd><code>[0-9a-f]{64}<\/code><\/dd>/);
    expect(page).not.toContain("Addresses used by the client");
    expect(page).toContain("<summary>Get exactly this version</summary>");
    expect(page).toContain("composer require acme/sdk:1.2.0\n");
    expect(page).not.toContain("Native URL");
    expect(page).toContain(
      'href="/packages/composer/acme%2Fsdk/1.2.0/files/acme-sdk-1.2.0.zip">Download</a>',
    );
  });

  it("download a file through a presigned redirect", async () => {
    const res = await get(
      "/packages/composer/acme%2Fsdk/1.2.0/files/acme-sdk-1.2.0.zip",
      readerCookie,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("https://test-account.r2.cloudflarestorage.com");
    expect(location.pathname).toBe(
      "/serverless-registry/composer/pkg/acme__sdk/1.2.0/acme-sdk-1.2.0.zip",
    );
    expect(location.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(location.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(location.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="acme-sdk-1.2.0.zip"',
    );
  });

  it("let an admin see every version, generic files included", async () => {
    const cookie = await login(adminToken);
    expect((await get("/packages/composer/acme%2Fprivate", cookie)).status).toBe(200);
    const yanked = await get("/packages/composer/acme%2Fsdk/1.0.0", cookie);
    expect(yanked.status).toBe(200);
    expect(await yanked.text()).toContain('<span class="badge warn">yanked</span> This version');

    await env.R2_BUCKET.put(
      "generic/pkg/tools/1.0.0/manifest.json",
      JSON.stringify({
        eco: "generic",
        name: "tools",
        version: "1.0.0",
        files: [
          {
            name: "tool-linux.tar.gz",
            size: 2048,
            sha256: "ab".repeat(32),
            role: "binary",
            labels: { os: "linux" },
            digests: { sha512: "cd".repeat(64) },
          },
        ],
        published: "2026-10-01T00:00:00Z",
        publishedBy: "panel-ci",
        yanked: false,
        native: { channel: "stable" },
      }),
    );
    const pkg = await (await get("/packages/generic/tools", cookie)).text();
    expect(pkg).not.toContain("Metadata");
    expect(pkg).toContain("sreg generic get tools latest --label os=linux --out ./downloads");
    const version = await get("/packages/generic/tools/1.0.0", cookie);
    expect(version.status).toBe(200);
    const page = await version.text();
    expect(page).toContain('<tr><th scope="row">channel</th><td>stable</td></tr>');
    expect(page).toContain('<span class="badge">os: linux</span>');
    expect(page).toContain(`<dt>sha512</dt><dd><code>${"cd".repeat(64)}</code></dd>`);
    const file = await get("/packages/generic/tools/1.0.0/files/tool-linux.tar.gz", cookie);
    expect(file.status).toBe(302);
    const location = new URL(file.headers.get("location") ?? "");
    expect(location.pathname).toBe(
      "/serverless-registry/generic/pkg/tools/1.0.0/tool-linux.tar.gz",
    );
    expect(location.searchParams.has("X-Amz-Signature")).toBe(true);
  });

  it("find NuGet packages whatever the casing and show the id as published", async () => {
    await env.R2_BUCKET.put(
      "nuget/pkg/acme.sdk/1.0.0/manifest.json",
      JSON.stringify({
        eco: "nuget",
        name: "acme.sdk",
        version: "1.0.0",
        files: [
          { name: "acme.sdk.1.0.0.nupkg", size: 10, sha256: "ab".repeat(32), role: "archive" },
        ],
        published: "2026-10-01T00:00:00Z",
        publishedBy: "panel-ci",
        yanked: false,
        native: { id: "Acme.Sdk", version: "1.0.0", nuspec: "", dependencyGroups: [] },
      }),
    );
    await addPackageToMeta(env, "nuget", "acme.sdk", {
      versions: 1,
      updated: "2026-10-01T00:00:00Z",
    });
    const reader = await credential("panel-dotnet", "read", [
      { eco: "nuget", package: "ACME.*", versions: "*" },
    ]);
    const cookie = await login(reader);
    for (const name of ["acme.sdk", "Acme.Sdk", "ACME.SDK"]) {
      const pkg = await get(`/packages/nuget/${name}`, cookie);
      expect(pkg.status, name).toBe(200);
      const pkgPage = await pkg.text();
      expect(pkgPage).toContain("<h1>Acme.Sdk</h1>");
      expect(pkgPage).toContain('href="/packages/nuget/Acme.Sdk/1.0.0">1.0.0</a>');
      expect(pkgPage).toContain("dotnet add package Acme.Sdk");
      const version = await get(`/packages/nuget/${name}/1.0.0`, cookie);
      expect(version.status, name).toBe(200);
      const versionPage = await version.text();
      expect(versionPage).toContain('<h1>Acme.Sdk <span class="version">1.0.0</span></h1>');
      expect(versionPage).toContain(
        'href="/packages/nuget/Acme.Sdk/1.0.0/files/acme.sdk.1.0.0.nupkg">Download</a>',
      );
      const file = await get(`/packages/nuget/${name}/1.0.0/files/acme.sdk.1.0.0.nupkg`, cookie);
      expect(file.status, name).toBe(302);
      expect(new URL(file.headers.get("location") ?? "").pathname).toBe(
        "/serverless-registry/nuget/pkg/acme.sdk/1.0.0/acme.sdk.1.0.0.nupkg",
      );
    }
    expect((await get("/packages/nuget/Acme.Other", cookie)).status).toBe(404);
    // Composer names are stored in lower case and found in any casing too.
    const admin = await login(adminToken);
    expect((await get("/packages/composer/ACME%2FSDK/1.2.0", admin)).status).toBe(200);
    // Generic names are compared as written.
    expect((await get("/packages/generic/Tools", admin)).status).toBe(404);
  });

  it("answer a publish credential with its notice and 403", async () => {
    const cookie = await login(ciToken);
    for (const path of [
      "/packages/composer/acme%2Fsdk",
      "/packages/composer/acme%2Fsdk/1.2.0",
      "/packages/composer/acme%2Fsdk/1.2.0/files/acme-sdk-1.2.0.zip",
    ]) {
      const res = await get(path, cookie);
      expect(res.status, path).toBe(403);
      expect(res.headers.get("location")).toBeNull();
      expect(await res.text()).toContain("This credential can only publish.");
    }
  });

  it("send visitors without a session to the login page", async () => {
    for (const path of [
      "/packages/composer/acme%2Fsdk",
      "/packages/composer/acme%2Fsdk/1.2.0/files/acme-sdk-1.2.0.zip",
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(303);
      expect(res.headers.get("location")).toBe("/");
    }
  });
});

describe("package groups", () => {
  const MOVE = "/admin/packages/move";

  /** A form post with repeated fields, as the Organize mode sends it. */
  function postPairs(path: string, pairs: [string, string][], cookie: string) {
    return exports.default.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...SAME_ORIGIN, cookie },
        body: new URLSearchParams(pairs),
        redirect: "manual",
      }),
    );
  }

  const groupIds = async () =>
    (
      JSON.parse((await env.AUTH.get("pkg-groups")) ?? "null") as { groups: { id: string }[] }
    ).groups.map((g) => g.id);

  it("shows the plain list until a group exists, with the Organize link", async () => {
    const cookie = await login(adminToken);
    const page = await (await get("/admin/packages", cookie)).text();
    expect(page).not.toContain("pkg-group");
    expect(page).toContain('href="/admin/packages?organize=1"');
    const organize = await (await get("/admin/packages?organize=1", cookie)).text();
    expect(organize).toContain('name="package" value="composer:acme/sdk" data-select-row');
    expect(organize).toContain('name="package" value="composer:acme/billing" data-select-row');
    expect(organize).not.toContain("data-api-url");
  });

  it("moves the checked packages to a new group and lists it above the rest", async () => {
    const cookie = await login(adminToken);
    const res = await postPairs(
      MOVE,
      [
        ["package", "composer:acme/sdk"],
        ["package", "composer:acme/billing"],
        ["package", "composer:acme/gone"],
        ["target", ""],
        ["new_name", "  Shop  stack "],
        ["new_parent", ""],
      ],
      cookie,
    );
    expect(res.status).toBe(303);
    const [id] = await groupIds();
    expect(id).toBeDefined();
    // The package that does not exist is ignored.
    expect(res.headers.get("location")).toBe(`/admin/packages?organize=1&moved=2&to=${id}`);
    const stored = JSON.parse((await env.AUTH.get("pkg-groups")) ?? "null");
    expect(stored.groups).toEqual([{ id, name: "Shop stack", parent: null }]);
    expect(stored.packages).toEqual({ "composer:acme/sdk": id, "composer:acme/billing": id });

    const page = await (await get(`/admin/packages?organize=1&moved=2&to=${id}`, cookie)).text();
    expect(page).toContain("Moved 2 packages to Shop stack.");
    expect(page.indexOf("pkg-ungrouped")).toBeGreaterThan(0);
    expect(page.indexOf(`id="group-${id}"`)).toBeGreaterThan(page.indexOf("pkg-ungrouped"));
    expect(page).toContain(`data-name="acme/sdk" data-groups="${id}"`);
    expect(page).toContain('data-name="acme/private" data-groups="_"');
  });

  it("shows a consumer the groups with only the packages it may see", async () => {
    const page = await (await get("/", readerCookie)).text();
    expect(page).toContain('<span class="pkg-group-name">Shop stack</span>');
    expect(page).toContain('<span class="pkg-group-count">2</span>');
    // Everything it may see is in the group: no Ungrouped section.
    expect(page).not.toContain("pkg-ungrouped");
    expect(page).not.toContain("acme/private");
    expect(page).not.toContain("organize");
    expect(page).not.toContain("Manage groups");
  });

  it("moves a package back to Ungrouped, and refuses a move without a package", async () => {
    const cookie = await login(adminToken);
    const none = await postPairs(MOVE, [["target", ""]], cookie);
    expect(none.status).toBe(400);
    expect(await none.text()).toContain("Check at least one package");
    const res = await postPairs(
      MOVE,
      [
        ["package", "composer:acme/billing"],
        ["target", ""],
      ],
      cookie,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/packages?organize=1&moved=1");
    const stored = JSON.parse((await env.AUTH.get("pkg-groups")) ?? "null");
    expect(Object.keys(stored.packages)).toEqual(["composer:acme/sdk"]);
  });

  it("shows the group on the package page and moves the package from there", async () => {
    const cookie = await login(adminToken);
    const [id] = await groupIds();
    const page = await (await get("/packages/composer/acme%2Fsdk", cookie)).text();
    expect(page).toContain(`<a href="/admin/packages#group-${id}">Shop stack</a>`);
    const res = await postPairs(
      MOVE,
      [
        ["package", "composer:acme/sdk"],
        ["return", "package"],
        ["target", ""],
      ],
      cookie,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/packages/composer/acme%2Fsdk");
    const after = await (await get("/packages/composer/acme%2Fsdk", cookie)).text();
    expect(after).toContain('<span class="muted">Ungrouped</span>');
    // A consumer's package page has no group.
    const reader = await (await get("/packages/composer/acme%2Fsdk", readerCookie)).text();
    expect(reader).not.toContain("group-switch");
  });

  it("creates, renames, moves and deletes groups on the groups page", async () => {
    const cookie = await login(adminToken);
    const [shop] = await groupIds();
    const page = await (await get("/admin/packages/groups", cookie)).text();
    expect(page).toContain(`action="/admin/packages/groups/${shop}"`);

    const created = await post(
      "/admin/packages/groups",
      { name: "Web", parent: shop ?? "" },
      {
        ...SAME_ORIGIN,
        cookie,
      },
    );
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/admin/packages/groups?notice=created");
    const notice = await (await get("/admin/packages/groups?notice=created", cookie)).text();
    expect(notice).toContain("Group created.");
    expect(await (await get("/admin/packages/groups?notice=<b>", cookie)).text()).not.toContain(
      "<b>",
    );
    const web = (await groupIds()).find((id) => id !== shop) ?? "";

    const dup = await post(
      "/admin/packages/groups",
      { name: "web", parent: shop ?? "" },
      {
        ...SAME_ORIGIN,
        cookie,
      },
    );
    expect(dup.status).toBe(400);
    expect(await dup.text()).toContain("already a group called web here");

    const renamed = await post(
      `/admin/packages/groups/${web}`,
      { name: "Frontend", parent: "" },
      {
        ...SAME_ORIGIN,
        cookie,
      },
    );
    expect(renamed.status).toBe(303);
    expect(renamed.headers.get("location")).toBe("/admin/packages/groups?notice=saved");
    const stored = JSON.parse((await env.AUTH.get("pkg-groups")) ?? "null");
    expect(stored.groups).toContainEqual({ id: web, name: "Frontend", parent: null });

    const into = await post(
      `/admin/packages/groups/${web}`,
      { name: "Frontend", parent: web },
      {
        ...SAME_ORIGIN,
        cookie,
      },
    );
    expect(into.status).toBe(400);
    expect(await into.text()).toContain("cannot be moved into itself");

    const gone = await post(
      `/admin/packages/groups/${shop}/delete`,
      {},
      { ...SAME_ORIGIN, cookie },
    );
    expect(gone.headers.get("location")).toBe("/admin/packages/groups?notice=deleted");
    const left = JSON.parse((await env.AUTH.get("pkg-groups")) ?? "null");
    expect(left.groups).toEqual([{ id: web, name: "Frontend", parent: null }]);
    // `acme/sdk` was in `Shop stack` no more, so nothing is left assigned.
    expect(left.packages).toEqual({});
    const missing = await post(
      "/admin/packages/groups/nope/delete",
      {},
      { ...SAME_ORIGIN, cookie },
    );
    expect(missing.status).toBe(400);
  });

  it("hides a hidden group with its packages for everybody and lets an admin show it", async () => {
    const cookie = await login(adminToken);
    const before = new Set(await groupIds());
    const created = await post(
      "/admin/packages/groups",
      { name: "Vault", parent: "", visibility: "hidden" },
      { ...SAME_ORIGIN, cookie },
    );
    expect(created.status).toBe(303);
    const vault = (await groupIds()).find((id) => !before.has(id)) ?? "";
    const stored = JSON.parse((await env.AUTH.get("pkg-groups")) ?? "null");
    expect(stored.groups).toContainEqual({
      id: vault,
      name: "Vault",
      parent: null,
      visibility: "hidden",
    });

    // `acme/billing` goes in the vault; the reader may see it and `acme/sdk`.
    const moved = await postPairs(
      MOVE,
      [
        ["package", "composer:acme/billing"],
        ["target", vault],
      ],
      cookie,
    );
    expect(moved.headers.get("location")).toBe(`/admin/packages?organize=1&moved=1&to=${vault}`);

    const list = await (await get("/admin/packages", cookie)).text();
    expect(list).not.toContain("acme/billing");
    expect(list).not.toContain("Vault");
    expect(list).toContain(
      'href="/admin/packages?hidden=1" aria-pressed="false">Show hidden groups (1)</a>',
    );
    const shown = await (await get("/admin/packages?hidden=1", cookie)).text();
    expect(shown).toContain("acme/billing");
    expect(shown).toContain('<span class="badge pkg-group-flag">hidden</span>');
    expect(shown).toContain("Hide hidden groups");
    const home = await (await get("/", readerCookie)).text();
    expect(home).not.toContain("acme/billing");
    expect(home).toContain("acme/sdk");
    expect(home).not.toContain("Vault");
    // The package itself stays reachable, and the admin finds its group with the hidden groups shown.
    expect((await get("/packages/composer/acme%2Fbilling", readerCookie)).status).toBe(200);
    const page = await (await get("/packages/composer/acme%2Fbilling", cookie)).text();
    expect(page).toContain(`<a href="/admin/packages?hidden=1#group-${vault}">Vault</a>`);

    // Moving from the list with the hidden groups shown stays in that mode.
    const back = await postPairs(
      MOVE,
      [
        ["package", "composer:acme/billing"],
        ["target", ""],
        ["show_hidden", "1"],
      ],
      cookie,
    );
    expect(back.headers.get("location")).toBe("/admin/packages?organize=1&moved=1&hidden=1");
    expect(await (await get("/", readerCookie)).text()).toContain("acme/billing");
  });

  it("shows the groups above a package in its breadcrumb, to a consumer too", async () => {
    const cookie = await login(adminToken);
    const before = new Set(await groupIds());
    const mk = async (name: string, parent: string, visibility = "visible") => {
      const res = await post(
        "/admin/packages/groups",
        { name, parent, visibility },
        { ...SAME_ORIGIN, cookie },
      );
      expect(res.status).toBe(303);
      return (await groupIds()).find((id) => !before.has(id) && !seen.has(id)) ?? "";
    };
    const seen = new Set<string>();
    const outer = await mk("Crumb outer", "");
    seen.add(outer);
    const inner = await mk("Crumb inner", outer);
    seen.add(inner);
    await postPairs(
      MOVE,
      [
        ["package", "composer:acme/sdk"],
        ["target", inner],
      ],
      cookie,
    );

    const reader = await (await get("/packages/composer/acme%2Fsdk", readerCookie)).text();
    const from = reader.indexOf('<nav class="crumbs"');
    const trail = reader.slice(from, reader.indexOf("</nav>", from));
    expect(trail).toContain(`<a href="/#group-${outer}">Crumb outer</a>`);
    expect(trail).toContain(`<a href="/#group-${inner}">Crumb inner</a>`);
    expect(trail.indexOf("Crumb outer")).toBeLessThan(trail.indexOf("Crumb inner"));
    expect(trail.indexOf("Crumb inner")).toBeLessThan(trail.indexOf("acme/sdk"));
    const admin = await (await get("/packages/composer/acme%2Fsdk", cookie)).text();
    expect(admin).toContain(`<a href="/admin/packages#group-${inner}">Crumb inner</a>`);

    // Hiding the outer group takes the trail away from the reader, not from the admin.
    await post(
      `/admin/packages/groups/${outer}`,
      { name: "Crumb outer", parent: "", visibility: "hidden" },
      { ...SAME_ORIGIN, cookie },
    );
    const hidden = await (await get("/packages/composer/acme%2Fsdk", readerCookie)).text();
    expect(hidden).not.toContain("Crumb outer");
    expect(hidden).not.toContain("Crumb inner");
    const stillAdmin = await (await get("/packages/composer/acme%2Fsdk", cookie)).text();
    expect(stillAdmin).toContain(
      `<a href="/admin/packages?hidden=1#group-${outer}">Crumb outer</a>`,
    );

    // Put things back for the tests after this one.
    await postPairs(
      MOVE,
      [
        ["package", "composer:acme/sdk"],
        ["target", ""],
      ],
      cookie,
    );
    await post(`/admin/packages/groups/${outer}/delete`, {}, { ...SAME_ORIGIN, cookie });
    await post(`/admin/packages/groups/${inner}/delete`, {}, { ...SAME_ORIGIN, cookie });
  });

  it("sets the visibility of a group, keeps it when a form does not send it and refuses an unknown one", async () => {
    const cookie = await login(adminToken);
    const [id] = await groupIds();
    const send = (fields: Record<string, string>) =>
      post(`/admin/packages/groups/${id}`, fields, { ...SAME_ORIGIN, cookie });
    const stored = async () =>
      (
        JSON.parse((await env.AUTH.get("pkg-groups")) ?? "null") as {
          groups: { id: string; visibility?: string }[];
        }
      ).groups.find((g) => g.id === id);
    expect((await send({ name: "Frontend", parent: "", visibility: "collapsed" })).status).toBe(
      303,
    );
    expect((await stored())?.visibility).toBe("collapsed");
    const list = await (await get("/admin/packages", cookie)).text();
    expect(list).not.toContain(`id="group-${id}" open`);
    // A form without the field leaves it alone.
    expect((await send({ name: "Frontend 2", parent: "" })).status).toBe(303);
    expect(await stored()).toMatchObject({ name: "Frontend 2", visibility: "collapsed" });
    const bad = await send({ name: "Frontend 2", parent: "", visibility: "secret" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("Unknown visibility.");
    expect((await send({ name: "Frontend 2", parent: "", visibility: "visible" })).status).toBe(
      303,
    );
    expect((await stored())?.visibility).toBeUndefined();
    const badNew = await post(
      "/admin/packages/groups",
      { name: "Nope", parent: "", visibility: "secret" },
      { ...SAME_ORIGIN, cookie },
    );
    expect(badNew.status).toBe(400);
  });

  it("is for admins only and refuses a cross-site post", async () => {
    const forbidden = await postPairs(
      MOVE,
      [
        ["package", "composer:acme/sdk"],
        ["target", ""],
      ],
      readerCookie,
    );
    expect(forbidden.status).toBe(403);
    for (const path of ["/admin/packages/groups", "/admin/packages/groups/x"]) {
      const res = await post(path, { name: "x" }, { ...SAME_ORIGIN, cookie: readerCookie });
      expect(res.status).toBe(403);
    }
    expect((await get("/admin/packages/groups", readerCookie)).status).toBe(403);
    const cookie = await login(adminToken);
    const cross = await post(
      MOVE,
      { package: "composer:acme/sdk" },
      {
        origin: "https://evil.example",
        cookie,
      },
    );
    expect(cross.status).toBe(403);
    const anonymous = await get("/admin/packages/groups");
    expect(anonymous.status).toBe(303);
  });
});

describe("session API calls", () => {
  it("need X-Requested-With for mutations", async () => {
    await credential("panel-doomed", "read", []);
    const cookie = await login(adminToken);
    const bare = await call("DELETE", "/api/v1/credentials/panel-doomed", { headers: { cookie } });
    expect(bare.status).toBe(403);
    const withHeader = await call("DELETE", "/api/v1/credentials/panel-doomed", {
      headers: { cookie, "x-requested-with": "fetch" },
    });
    expect(withHeader.status).toBe(200);
    expect(await withHeader.json()).toEqual({ project: "panel-doomed", deleted: true });
  });
});

describe("logout", () => {
  it("clears the cookie", async () => {
    const cookie = await login(adminToken);
    const res = await post("/logout", {}, { ...SAME_ORIGIN, cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toMatch(/^sreg_session=; .*Max-Age=0/);
  });

  it("clears a stale cookie on the home page", async () => {
    const home = await get("/", `sreg_session=${"x".repeat(20)}.${"A".repeat(43)}`);
    expect(await home.text()).toContain('action="/login"');
    expect(home.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
});

describe("without SESSION_SECRET", () => {
  const unsigned = { ...env, SESSION_SECRET: undefined };

  it("answers the panel login with 500 naming the setting", async () => {
    const token = await credential("no-secret-admin", "admin");
    const request = new Request(`${ORIGIN}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...SAME_ORIGIN },
      body: new URLSearchParams({ mode: "token", token }),
    });
    const res = await handlePanel(request, unsigned, new URL(request.url));
    expect(res?.status).toBe(500);
    const page = (await res?.text()) ?? "";
    expect(page).toContain("SESSION_SECRET");
    expect(page).not.toContain(token);
  });

  it("keeps API tokens working", async () => {
    const token = await credential("no-secret-reader", "read");
    const request = new Request(`${ORIGIN}/api/v1/whoami`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await handleApi(request, unsigned, new URL(request.url));
    expect(res.status).toBe(200);
  });
});
