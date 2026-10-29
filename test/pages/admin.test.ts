import { describe, expect, it } from "vitest";
import type { Credential } from "../../src/core/auth";
import type { PackageView } from "../../src/core/packages";
import {
  adminPackagesPage,
  apiPath,
  awaitsPin,
  credentialHref,
  secretSummary,
} from "../../src/pages/admin";
import { setupStatus } from "../../src/core/config";
import {
  credentialPage,
  credentialsPage,
  credentialTab,
  newCredentialPage,
  type CredentialPageData,
} from "../../src/pages/credentials";
import { layout } from "../../src/pages/layout";
import { markup } from "../../src/pages/html";
import { packagePage } from "../../src/pages/package";
import { settingsPage } from "../../src/pages/settings";
import { versionPage } from "../../src/pages/version";
import { assignPackages, createGroup, NO_GROUPS, type PackageGroups } from "../../src/core/groups";
import { groupsPage } from "../../src/pages/groups";

const ctx = {
  host: "packages.example.com",
  version: "1.0.0",
  user: { project: "root", roles: ["admin"] as const },
};
const NOW = new Date("2026-10-28T10:00:00Z");

const npmSdk: PackageView = {
  eco: "npm",
  name: "@acme/sdk",
  versions: [
    {
      version: "2.0.0",
      published: "2026-10-28T10:12:00Z",
      yanked: false,
      files: [{ name: "sdk-2.0.0.tgz", size: 2048, sha256: "a".repeat(64), role: "archive" }],
    },
    { version: "1.0.0", published: "2026-01-01T00:00:00Z", yanked: true, files: [] },
  ],
};

const shop: Credential = {
  project: "shop",
  kind: "read",
  roles: ["read"],
  auth: [
    {
      id: "3f9a1c0b7d2e",
      type: "key",
      scope: ["read"],
      created: "2026-10-28T09:00:00Z",
      expires: null,
    },
    {
      id: "a41d07e9c2b5",
      type: "key",
      scope: ["read"],
      created: "2026-06-01T08:30:00Z",
      expires: "2026-11-11T00:00:00Z",
    },
    {
      id: "c08e5b1f9a27",
      type: "gh",
      scope: ["read"],
      repository: "acme/shop",
      ref: null,
      workflow: null,
      repository_id: "123",
      repository_owner_id: null,
      environment: "release",
      created: "2026-06-01T08:30:00Z",
      expires: "2026-10-01T00:00:00Z",
    },
  ],
  grants: [{ eco: "composer", package: "acme/*", versions: "^1.0", transitive: false }],
  read_grants: [{ eco: "composer", package: "acme/*", versions: "^1.0", transitive: false }],
  publish_grants: [],
  yank_grants: [],
  delete_grants: [],
};

const root: Credential = {
  project: "root",
  kind: "admin",
  roles: ["admin"],
  auth: [
    {
      id: "0123456789ab",
      type: "key",
      scope: ["admin"],
      created: "2026-10-28T09:00:00Z",
      expires: null,
    },
  ],
  grants: [],
  read_grants: [],
  publish_grants: [],
  yank_grants: [],
  delete_grants: [],
};

function detail(credential: Credential, extra: Partial<CredentialPageData> = {}): string {
  return credentialPage(ctx, {
    credential,
    ecosystems: ["composer", "npm"],
    now: NOW,
    login: credential.project,
    ...extra,
  });
}

describe("helpers", () => {
  it("encodes API paths segment by segment", () => {
    expect(apiPath("packages", "npm", "@acme/sdk", "1.0.0")).toBe(
      "/api/v1/packages/npm/%40acme%2Fsdk/1.0.0",
    );
  });

  it("links credentials, keeping the project new apart from the create form", () => {
    expect(credentialHref("shop")).toBe("/admin/credentials/shop");
    expect(credentialHref("new")).toBe("/admin/credentials/%6Eew");
  });

  it("summarises the active secrets and the nearest expiry", () => {
    expect(secretSummary(shop, NOW)).toEqual({
      active: 2,
      nearestExpiry: "2026-11-11T00:00:00Z",
    });
    expect(secretSummary(root, NOW)).toEqual({ active: 1, nearestExpiry: null });
  });
});

describe("admin navigation", () => {
  it("links the admin sections and marks the current one", () => {
    const page = layout(ctx, "T", markup``, { section: "credentials" });
    expect(page).toContain(
      '<nav class="site-nav" aria-label="Administration"><a href="/admin/packages">Packages</a><a href="/admin/credentials" aria-current="page">Credentials</a><a href="/admin/settings">Settings</a></nav>',
    );
    expect(page).toContain('<a class="brand" href="/admin/packages">');
    expect(page).toContain('action="/logout"');
  });

  it("is shown to admins only", () => {
    const reader = { ...ctx, user: { project: "shop", roles: ["read"] as const } };
    expect(layout(reader, "T", markup``, { section: "packages" })).not.toContain("site-nav");
  });

  it("follows the roles of the session, not one kind, and shows each as a badge", () => {
    const both = { ...ctx, user: { project: "ops", roles: ["read", "admin"] as const } };
    const page = layout(both, "T", markup``, { section: "packages" });
    expect(page).toContain("site-nav");
    expect(page).toContain('<a class="brand" href="/admin/packages">');
    expect(page).toContain('<span class="badge">read</span> <span class="badge">admin</span>');
    // The same credential signed in with a read-only secret gets no admin navigation.
    const reading = { ...ctx, user: { project: "ops", roles: ["read"] as const } };
    const plain = layout(reading, "T", markup``, { section: "packages" });
    expect(plain).not.toContain("site-nav");
    expect(plain).toContain('<a class="brand" href="/">');
    expect(plain).toContain('<span class="badge">read</span>');
    expect(plain).not.toContain('<span class="badge">admin</span>');
  });

  it("flags a new release to admins only", () => {
    const update = { tag: "v2.0.0" };
    const flagged = layout({ ...ctx, update }, "T", markup``, { section: "packages" });
    expect(flagged).toContain(
      'href="/admin/settings" title="Version v2.0.0 is available">Update available</a>',
    );
    expect(layout(ctx, "T", markup``, {})).not.toContain("update-flag");
    const reader = { ...ctx, update, user: { project: "shop", roles: ["read"] as const } };
    expect(layout(reader, "T", markup``, {})).not.toContain("update-flag");
  });

  it("names the page for app.js", () => {
    expect(layout(ctx, "T", markup``, { page: "credential" })).toContain(
      '<body data-page="credential">',
    );
  });
});

describe("package list", () => {
  const page = adminPackagesPage(ctx, [npmSdk, { ...npmSdk, eco: "composer", name: "zeta/a" }]);

  it("is the sorted, filterable list with links to the package pages", () => {
    expect(page).toContain('aria-current="page">Packages</a>');
    expect(page).toContain("<h1>Packages</h1>");
    expect(page).toContain('<a class="pkg-link" href="/packages/npm/%40acme%2Fsdk">');
    expect(page.indexOf("%40acme%2Fsdk")).toBeLessThan(page.indexOf("zeta%2Fa"));
    expect(page).toContain("data-pkg-filter hidden");
    expect(page).toContain('<body data-page="packages">');
  });

  it("offers reindex and a typed delete at the end of each row", () => {
    expect(page).toContain('<li class="pkg-row with-actions"');
    expect(page).toContain(
      'data-api-method="POST" data-api-url="/api/v1/packages/npm/%40acme%2Fsdk/reindex"',
    );
    expect(page).toMatch(
      /data-api-method="DELETE" data-api-url="\/api\/v1\/packages\/npm\/%40acme%2Fsdk" data-confirm="[^"]+" data-confirm-name="@acme\/sdk"/,
    );
    // Versions are managed on the package page.
    expect(page).not.toContain("/yank");
  });

  it("explains an empty registry", () => {
    expect(adminPackagesPage(ctx, [])).toContain("No packages have been published yet.");
  });
});

describe("package page for admins", () => {
  const page = packagePage(ctx, { view: npmSdk, snippets: [], admin: true });

  it("links back to the admin list", () => {
    expect(page).toContain('<li><a href="/admin/packages">Packages</a></li>');
    expect(page).toContain('<p class="back"><a href="/admin/packages">← All packages</a></p>');
  });

  it("offers yank and delete per version", () => {
    expect(page).toContain(
      'data-api-method="POST" data-api-url="/api/v1/packages/npm/%40acme%2Fsdk/2.0.0/yank"',
    );
    expect(page).not.toContain("1.0.0/yank");
    expect(page).toContain(
      'data-api-method="DELETE" data-api-url="/api/v1/packages/npm/%40acme%2Fsdk/1.0.0"',
    );
  });

  it("keeps the actions of every version in one aligned cell", () => {
    const cells = page.match(/<span class="row-actions version-actions"[^>]*>/g) ?? [];
    expect(cells).toHaveLength(npmSdk.versions.length);
    expect(cells[0]).toContain('role="group" aria-label="Actions"');
    // The yanked 1.0.0 keeps an invisible stand-in where "Yank" would be.
    expect(page).toContain(
      '<span class="button secondary small action-placeholder" aria-hidden="true">Yank</span><button type="button" class="danger small" data-api-method="DELETE" data-api-url="/api/v1/packages/npm/%40acme%2Fsdk/1.0.0"',
    );
    expect(page.match(/action-placeholder/g)).toHaveLength(1);
  });

  it("goes back to the list after deleting the only version", () => {
    const one = packagePage(ctx, {
      view: { ...npmSdk, versions: npmSdk.versions.slice(0, 1) },
      snippets: [],
      admin: true,
    });
    expect(one).toMatch(
      /data-api-url="[^"]+\/2\.0\.0" data-confirm="[^"]+" data-api-next="\/admin\/packages"/,
    );
    expect(page).not.toMatch(/2\.0\.0" data-confirm="[^"]+" data-api-next/);
  });

  it("offers reindex and deleting the package by typing its name", () => {
    expect(page).toContain(
      'data-api-method="POST" data-api-url="/api/v1/packages/npm/%40acme%2Fsdk/reindex"',
    );
    expect(page).toContain(
      '<form class="box danger-box" data-api-form="delete" data-api-method="DELETE" data-api-url="/api/v1/packages/npm/%40acme%2Fsdk" data-confirm-name="@acme/sdk" data-api-next="/admin/packages">',
    );
    expect(page).toContain("Type <code>@acme/sdk</code> to confirm");
    expect(page).toContain('<button type="submit" class="danger" disabled>Delete package</button>');
  });

  it("shows no actions to consumers", () => {
    const reader = { ...ctx, user: { project: "shop", roles: ["read"] as const } };
    const out = packagePage(reader, { view: npmSdk, snippets: [] });
    expect(out).not.toContain("data-api");
    expect(out).not.toContain("Danger zone");
    expect(out).toContain('<li><a href="/">Packages</a></li>');
  });

  it("links the version page back to the admin list", () => {
    const out = versionPage(ctx, {
      eco: "npm",
      name: "@acme/sdk",
      version: "2.0.0",
      published: "2026-10-28T10:12:00Z",
      yanked: false,
      files: [],
    });
    expect(out).toContain('<li><a href="/admin/packages">Packages</a></li>');
  });
});

const publisher: Credential = {
  ...shop,
  project: "ci",
  kind: "publish",
  roles: ["publish"],
  auth: shop.auth.map((e) => ({ ...e, scope: ["publish"] })),
  grants: [{ eco: "composer", package: "acme/*", versions: "*", transitive: true }],
  read_grants: [],
  publish_grants: [{ eco: "composer", package: "acme/*", versions: "*", transitive: true }],
  yank_grants: [],
  delete_grants: [],
};

const dual: Credential = {
  ...shop,
  project: "both",
  roles: ["read", "publish"],
  auth: [
    { ...shop.auth[0], scope: ["read"] },
    { ...shop.auth[1], scope: ["read", "publish"] },
  ] as Credential["auth"],
  publish_grants: [{ eco: "composer", package: "acme/sdk", versions: "*", transitive: true }],
  yank_grants: [],
  delete_grants: [],
};

describe("credential list", () => {
  const page = credentialsPage(ctx, [shop, root], NOW);

  it("lists projects sorted, with kind, active secrets, nearest expiry and grants", () => {
    expect(page).toContain(
      '<tr data-pkg-row data-name="shop">\n<td><a class="row-link" href="/admin/credentials/shop">shop</a></td>\n<td><span class="badge kind" data-kind="read">read</span> </td>\n<td class="num">2</td>\n<td class="nowrap"><time datetime="2026-11-11T00:00:00Z">2026-11-11</time></td>\n<td class="num">1</td>',
    );
    expect(page).toContain(
      '<td><span class="badge kind" data-kind="admin">admin</span> </td>\n<td class="num">1</td>\n<td class="nowrap"><span class="hint">never</span></td>',
    );
    expect(page.indexOf("credentials/root")).toBeLessThan(page.indexOf("credentials/shop"));
  });

  it("has a filter and a prominent button to create a credential", () => {
    expect(page).toContain("data-pkg-filter hidden");
    expect(page).toContain("Filter by project");
    expect(page).toContain('<a class="button" href="/admin/credentials/new">New credential</a>');
    expect(page).toContain('<body data-page="credentials">');
  });
});

describe("new credential form", () => {
  const page = newCredentialPage(ctx, { ecosystems: ["composer", "npm"] });

  it("loads the script of the grants as text", () => {
    expect(page).toContain('<script src="/grants.js" defer></script>');
    expect(page).toContain("data-grants-toggle");
  });

  it("posts to the panel with project, roles and grants", () => {
    expect(page).toContain(
      '<form class="box form" method="post" action="/admin/credentials/new" data-credential-form>',
    );
    expect(page).toContain('name="project"');
    // The roles are three on/off toggles; read is on by default.
    expect(page).toContain(
      '<input type="checkbox" name="roles" id="new-role-read" value="read" checked>',
    );
    expect(page).toContain(
      '<input type="checkbox" name="roles" id="new-role-publish" value="publish">',
    );
    expect(page).toContain(
      '<input type="checkbox" name="roles" id="new-role-admin" value="admin">',
    );
    expect(page).toContain('<template id="grant-row">');
    expect(page).toContain('<option value="npm">npm</option>');
    expect(page).toContain('<input type="hidden" name="read_grant" value="0" data-grant-key>');
    expect(page).toContain(
      '<input type="checkbox" name="read_grant_transitive" value="0" data-field="transitive" checked>',
    );
    // The template row has no prefix: the scripts give each added row its role's.
    expect(page).toContain('<input type="hidden" name="grant" value="" data-grant-key>');
    expect(page).not.toContain("data-api-form");
  });

  it("explains the roles", () => {
    expect(page).toContain("<strong>publish</strong><small>Publishes new versions");
    expect(page).toContain("<strong>admin</strong><small>Manages packages and credentials");
  });

  it("starts without a secret and offers a key or a login with a password", () => {
    expect(page).toContain(
      '<input type="radio" name="first_secret" id="first_secret-none" value="none" checked>',
    );
    expect(page).toContain('id="first_secret-key" value="key"');
    expect(page).toContain('id="first_secret-login" value="login"');
    expect(page).toContain(
      '<div data-password="first_secret:login" hidden>\n<label>Password (optional, at least 12 characters) <input type="password" name="password" minlength="12" autocomplete="new-password" spellcheck="false" disabled></label>',
    );
    expect(page).toContain("<div data-login-fields hidden>");
    expect(page).toContain('name="description"');
    // A key is never a password.
    expect(page).not.toContain("kind:admin");
  });

  it("shows the login fields when a login is the first secret, and hides the grants of an admin", () => {
    const admin = newCredentialPage(ctx, {
      ecosystems: ["composer"],
      values: {
        project: "ops",
        roles: ["admin"],
        grants: { read: [], publish: [], yank: [], delete: [] },
        scope: [],
        firstSecret: "login",
        totp: true,
        description: "Ops <team>",
      },
    });
    expect(admin).toContain('<div data-password="first_secret:login">');
    expect(admin).toContain("<div data-login-fields>");
    expect(admin).toContain('name="totp" checked>');
    expect(admin).toContain('value="Ops &lt;team&gt;"');
    expect(admin).toMatch(/<fieldset class="plain" data-grants[^>]* hidden>/);
  });

  it("shows the error and the values again", () => {
    const again = newCredentialPage(ctx, {
      ecosystems: ["composer", "npm"],
      error: "This credential already exists.",
      values: {
        project: '"><x',
        roles: ["publish"],
        grants: {
          read: [],
          publish: [{ eco: "npm", package: "@acme/*", versions: "^2", transitive: false }],
          yank: [],
          delete: [],
        },
        scope: [],
        firstSecret: "none",
        totp: false,
        description: "",
      },
    });
    expect(again).toContain('<p class="error" role="alert">This credential already exists.</p>');
    expect(again).toContain('value="&quot;&gt;&lt;x"');
    expect(again).toContain('name="roles" id="new-role-publish" value="publish" checked');
    expect(again).not.toContain('id="new-role-read" value="read" checked');
    expect(again).toContain('data-grants data-grant-kind="publish"');
    expect(again).toContain('<option value="npm" selected>npm</option>');
    expect(again).toContain('value="@acme/*"');
    expect(again).toContain(
      '<input type="checkbox" name="publish_grant_transitive" value="0" data-field="transitive"> transitive',
    );
  });
});

describe("credential page", () => {
  const page = detail(shop);
  const grantsTab = detail(shop, { tab: "grants" });
  const secretsTab = detail(shop, { tab: "secrets" });
  const dangerTab = detail(shop, { tab: "danger" });

  it("shows one tab at a time under a tab bar, the overview by default", () => {
    expect(page).toContain(
      '<nav class="tabs" aria-label="Credential"><a href="/admin/credentials/shop?tab=overview" aria-current="page">Overview</a><a href="/admin/credentials/shop?tab=grants">Grants <span class="tab-count">1</span></a><a href="/admin/credentials/shop?tab=secrets">Secrets <span class="tab-count">3</span></a><a href="/admin/credentials/shop?tab=danger">Danger zone</a></nav>',
    );
    const headings = ["Overview</h2>", "Grants</h2>", "Secrets</h2>", "Danger zone</h2>"];
    const tabs = [page, grantsTab, secretsTab, dangerTab];
    tabs.forEach((tab, i) => {
      headings.forEach((h, j) => expect(tab.includes(h), `${i} ${h}`).toBe(i === j));
      expect(tab).toContain('<body data-page="credential">');
      expect(tab).toContain('<li><a href="/admin/credentials">Credentials</a></li>');
      expect(tab).toContain("<h1>shop ");
    });
    expect(grantsTab).toContain('href="/admin/credentials/shop?tab=grants" aria-current="page"');
    expect(dangerTab).toContain("<title>shop · Danger zone · packages.example.com</title>");
  });

  it("falls back to the overview for an unknown tab", () => {
    expect(credentialTab("secrets")).toBe("secrets");
    expect(credentialTab("nope")).toBe("overview");
    expect(credentialTab(null)).toBe("overview");
  });

  it("links the overview to the other tabs with their counts", () => {
    expect(page).toContain(
      '<li><a href="/admin/credentials/shop?tab=grants"><strong>1 read grant</strong><span>Edit the grants and roles</span></a></li>',
    );
    expect(page).toContain(
      '<li><a href="/admin/credentials/shop?tab=secrets"><strong>2 active of 3 secrets</strong>',
    );
    expect(page).toContain('href="/admin/credentials/shop?tab=secrets&amp;add=1"');
    expect(page).toContain(
      '<a href="/admin/credentials/shop?tab=danger"><strong>Danger zone</strong><span>Delete this credential</span>',
    );
    expect(detail(root)).toContain("<strong>No grants (admin)</strong>");
    expect(detail(root)).toContain('<a href="/admin/credentials/root?tab=grants">Grants</a>');
  });

  it("shows an overview of the credential", () => {
    expect(page).toContain("<div><dt>Login</dt><dd><code>shop</code></dd></div>");
    expect(page).toContain(
      '<div><dt>Created</dt><dd><time datetime="2026-06-01T08:30:00Z">2026-06-01</time></dd></div>',
    );
    expect(page).toContain("<div><dt>Active secrets</dt><dd>2 of 3</dd></div>");
    expect(page).toContain("<code>3f9a1c0b7d2e</code> <code>a41d07e9c2b5</code>");
  });

  it("edits the grants with prefilled rows", () => {
    expect(grantsTab).toContain(
      'data-api-form="grants" data-api-method="PATCH" data-api-url="/api/v1/credentials/shop"',
    );
    expect(grantsTab).toContain('value="acme/*"');
    expect(grantsTab).toContain('value="^1.0"');
    expect(grantsTab).toContain('<option value="composer" selected>Composer</option>');
    expect(grantsTab).toContain('<template id="grant-row">');
    expect(page).not.toContain('<template id="grant-row">');
    expect(grantsTab).toContain(
      '<fieldset class="plain" data-grants data-grant-kind="read" data-grant-role="read" aria-labelledby="read-grants">',
    );
  });

  it("offers the grants as text, hidden until the script shows the toggle", () => {
    expect(grantsTab).toContain('<script src="/grants.js" defer></script>');
    expect(grantsTab).toContain("<div data-grants-text-pane hidden>");
    expect(grantsTab).toContain(
      '<button type="button" class="secondary small" data-grants-toggle hidden>',
    );
    expect(grantsTab).toContain("<code>eco:package[:versions[:transitive]]</code>");
    // The script is only loaded where grants are edited.
    expect(page).not.toContain("/grants.js");
    expect(secretsTab).not.toContain("/grants.js");
  });

  it("has no grants for admin credentials, and a password only for their logins", () => {
    const out = detail(root, { tab: "grants" });
    expect(out).toContain("This credential only administers");
    expect(out).not.toContain('data-api-form="grants"');
    // The roles can still be changed: an admin may be given read or publish.
    expect(out).toContain('data-api-form="roles"');
    expect(out).toContain('name="roles" id="credential-role-admin" value="admin" checked');
    expect(out).not.toContain('id="credential-role-read" value="read" checked');
    // An admin can have a login too; a key is never a password, for any credential.
    const adminSecrets = detail(root, { tab: "secrets" });
    expect(adminSecrets).toContain('value="login"');
    expect(adminSecrets).toContain('<div data-password="type:login" hidden>');
    expect(adminSecrets).not.toContain("type:key");
    expect(secretsTab).toContain("(<code>sreg login</code>)");
    expect(secretsTab).not.toContain("&lt;code&gt;");
    expect(secretsTab).toContain('<div data-password="type:login" hidden>');
    expect(secretsTab).not.toContain("type:key");
  });

  it("marks transitive so that it is hidden for publish grants", () => {
    const out = detail(publisher, { tab: "grants" });
    expect(out).toContain(
      'data-grants data-grant-kind="publish" data-grant-role="publish" aria-labelledby="publish-grants"',
    );
    expect(out).toContain("<span data-transitive> Transitive:");
  });

  it("lists the secrets with an expire action for active ones", () => {
    const page = secretsTab;
    expect(page).toContain(
      '<td class="nowrap" data-label="Expires"><time datetime="2026-11-11T00:00:00Z" title="2026-11-11T00:00:00Z">2026-11-11</time></td>',
    );
    // Every cell but the action names its column for the stacked cards of narrow screens.
    expect(page).toContain('<td data-label="ID"><code>3f9a1c0b7d2e</code></td>');
    // The actions share one line; a gh secret also has "Edit".
    expect(page).toContain(
      '<td class="secret-action"><div class="row-actions"><form class="inline-form expire-form"',
    );
    // The description is text with an "Edit" (shown by app.js) and a form of its own, saved
    // with a PATCH and shown inline without scripts.
    expect(page).toContain(
      '<td class="description" data-label="Description"><div class="description-cell" data-description>\n<span class="description-text"><span class="hint">None</span></span>\n<button type="button" class="link small" data-describe-open hidden>Add</button>',
    );
    expect(page).toContain(
      '<form class="inline-form describe-form" data-api-form="describe" data-api-method="PATCH" data-api-url="/api/v1/credentials/shop/secrets/3f9a1c0b7d2e" data-describe-form>',
    );
    expect(page).toContain(
      '<input type="text" name="description" maxlength="200" autocomplete="off" aria-label="Description of 3f9a1c0b7d2e" placeholder="Add a description" value="">',
    );
    expect(page).toContain("data-describe-cancel hidden>Cancel</button>");
    expect(page).toContain("<th>Description</th>");
    expect(page).toContain('data-api-url="/api/v1/credentials/shop/secrets/3f9a1c0b7d2e"');
    // "Expire…" (shown by app.js) reveals the date and the confirm, shown inline without it.
    expect(page).toContain(
      '<button type="button" class="danger small" data-expire-open hidden>Expire…</button>\n<span class="expire-fields" data-expire-fields>\n<input type="date" name="expires" aria-label="Expire 3f9a1c0b7d2e on (empty: now)">\n<button type="submit" class="danger small">Expire</button>',
    );
    // The expired gh entry has no expire action.
    expect(page).not.toContain(
      'data-api-method="DELETE" data-api-url="/api/v1/credentials/shop/secrets/c08e5b1f9a27"',
    );
    // A gh secret, expired or not, can be edited into a new one; a key cannot.
    expect(page).toContain(
      'href="/admin/credentials/shop?tab=secrets&amp;edit=c08e5b1f9a27#add-secret">Edit</a>',
    );
    expect(page).not.toContain("edit=3f9a1c0b7d2e");
    expect(page).toContain('<span class="badge warn">expired</span>');
    expect(page).toContain(
      "<code>acme/shop</code> · ref any · workflow any · repository id <code>123</code> · environment <code>release</code>",
    );
  });

  it("shows a description as escaped text with Edit, and the form for it", () => {
    const described = {
      ...shop,
      auth: shop.auth.map((e, i) => (i === 0 ? { ...e, description: 'CI <of> "shop"' } : e)),
    };
    const page = detail(described, { tab: "secrets" });
    expect(page).toContain('<span class="description-text">CI &lt;of&gt; &quot;shop&quot;</span>');
    expect(page).toContain("data-describe-open hidden>Edit</button>");
    expect(page).toContain('value="CI &lt;of&gt; &quot;shop&quot;"');
    expect(page).not.toContain("CI <of>");
  });

  it("adds secrets with a form post behind a collapsed button", () => {
    const page = secretsTab;
    expect(page).toContain(
      '<details class="add-secret" id="add-secret">\n<summary class="button"><span class="when-closed">Add a secret</span>',
    );
    expect(detail(shop, { tab: "secrets", addSecret: true })).toContain(
      '<details class="add-secret" id="add-secret" open>',
    );
    expect(page.indexOf('class="add-secret"')).toBeLessThan(
      page.indexOf('<table class="secrets">'),
    );
    expect(page).toContain(
      '<form class="box form" method="post" aria-label="Add a secret" action="/admin/credentials/shop/secrets" data-secret-form>',
    );
    expect(page).toContain('<input type="radio" name="type" id="type-key" value="key" checked>');
    expect(page).toContain("<div data-gh-fields hidden>");
    for (const field of [
      "repository",
      "repository_id",
      "repository_owner_id",
      "ref",
      "workflow",
      "environment",
      "expires",
    ]) {
      expect(page).toContain(`name="${field}"`);
    }
    expect(page).toContain("prefer the ref <code>refs/tags/v*</code> or a workflow");
    expect(page).toContain(
      '<button type="button" class="secondary small" data-gh-lookup>Look up</button>',
    );
    expect(page).toContain(
      '<label class="inline"><input type="checkbox" name="pin_on_first_use" checked> Pin repository ids on first use</label>',
    );
  });

  it("shows a refused secret form again with its error and values", () => {
    const out = detail(shop, {
      secretError: "`repository` must be owner/repo.",
      secretValues: {
        type: "gh",
        scope: [],
        totp: false,
        description: "",
        replaces: "",
        expire_old: true,
        repository: "bad",
        repository_id: "",
        repository_owner_id: "",
        ref: "refs/tags/v*",
        workflow: "",
        environment: "",
        pin_on_first_use: false,
        expires: "2027-01-01",
      },
    });
    expect(out).toContain('<p class="error" role="alert">`repository` must be owner/repo.</p>');
    // The refused form is shown on the secrets tab, unfolded.
    expect(out).toContain('href="/admin/credentials/shop?tab=secrets" aria-current="page"');
    expect(out).toContain('<details class="add-secret" id="add-secret" open>');
    expect(out).toContain('value="gh" checked');
    expect(out).toContain("<div data-gh-fields>");
    expect(out).toContain(
      'name="repository" placeholder="owner/repo or owner/*" spellcheck="false" value="bad"',
    );
    expect(out).toContain('<input type="checkbox" name="pin_on_first_use"> Pin');
    expect(out).toContain('name="expires" value="2027-01-01"');
  });

  it("deletes the credential by typing its name, then opens the list", () => {
    expect(page).not.toContain('data-api-form="delete"');
    expect(dangerTab).toContain(
      'data-api-form="delete" data-api-method="DELETE" data-api-url="/api/v1/credentials/shop" data-confirm-name="shop" data-api-next="/admin/credentials"',
    );
  });

  it("posts the secrets of the project new past the create form", () => {
    expect(detail({ ...shop, project: "new" }, { tab: "secrets" })).toContain(
      'action="/admin/credentials/%6Eew/secrets"',
    );
  });

  it("shows every claim value of a gh secret in code style", () => {
    const out = detail(
      {
        ...shop,
        auth: [
          {
            id: "d19f2a6c4e80",
            type: "gh",
            scope: ["read"],
            repository: "acme/shop",
            ref: "refs/tags/v*",
            workflow: ".github/workflows/release.yml",
            repository_id: null,
            repository_owner_id: "42",
            environment: null,
            created: "2026-06-01T08:30:00Z",
            expires: null,
          },
        ],
      },
      { tab: "secrets" },
    );
    expect(out).toContain(
      "<code>acme/shop</code> · ref <code>refs/tags/v*</code> · workflow <code>.github/workflows/release.yml</code> · owner id <code>42</code>",
    );
  });

  it("notes the gh secrets that wait for their ids to be pinned", () => {
    const gh = shop.auth[2];
    if (gh?.type !== "gh") throw new Error("fixture");
    const waiting = { ...gh, repository_id: null, pin_on_first_use: true };
    expect(awaitsPin(waiting)).toBe(true);
    expect(awaitsPin({ ...waiting, repository_owner_id: "7" })).toBe(false);
    expect(awaitsPin({ ...waiting, pin_on_first_use: false })).toBe(false);
    expect(awaitsPin(gh)).toBe(false);
    const out = detail({ ...shop, auth: [{ ...waiting, expires: null }] }, { tab: "secrets" });
    expect(out).toContain(
      'environment <code>release</code> · <span class="hint nowrap">pinned on first use</span>',
    );
    expect(secretsTab).not.toContain("pinned on first use</span>");
  });

  it("escapes credential data", () => {
    const out = detail(
      {
        ...shop,
        read_grants: [{ eco: "npm", package: '"><script>', versions: "*", transitive: true }],
      },
      { tab: "grants" },
    );
    expect(out).toContain('value="&quot;&gt;&lt;script&gt;"');
    expect(out).not.toContain('"><script>');
  });
});

describe("credential with both roles", () => {
  it("lists both roles and the grants of each", () => {
    const out = credentialsPage(ctx, [dual], NOW);
    expect(out).toContain(
      '<td><span class="badge kind" data-kind="read">read</span> <span class="badge kind" data-kind="publish">publish</span> </td>',
    );
    expect(out).toContain('<td class="num">read 1 · publish 1</td>');
  });

  it("edits the grants of each role in its own form and the roles in a third", () => {
    const out = detail(dual, { tab: "grants" });
    expect(out).toContain('data-api-form="grants"');
    expect(out).toContain('data-grants-field="read_grants"');
    expect(out).toContain('data-grants-field="publish_grants"');
    expect(out).toContain("Save read grants");
    expect(out).toContain("Save publish grants");
    expect(out).toContain('data-api-form="roles"');
    // The roles are three toggles, the credential's own on.
    expect(out).toContain('<div class="toggles" role="group" aria-label="Roles of the credential"');
    expect(out).toContain('id="credential-role-read" value="read" checked>');
    expect(out).toContain('id="credential-role-publish" value="publish" checked>');
    expect(out).toContain('id="credential-role-admin" value="admin">');
    expect(out.match(/<template id="grant-row">/g)).toHaveLength(1);
    // Only a read list shows `transitive`; the publish list is marked so that CSS hides it.
    expect(out).toContain('data-grant-kind="publish" data-grant-role="publish"');
  });

  it("offers the roles of a single-role credential for adding the other", () => {
    const out = detail(shop, { tab: "grants" });
    expect(out).toContain('id="credential-role-read" value="read" checked>');
    expect(out).toContain('id="credential-role-publish" value="publish">');
    expect(out).not.toContain('data-grants-field="publish_grants"');
  });

  it("shows the scope of every secret and asks for one on a new secret", () => {
    const out = detail(dual, { tab: "secrets" });
    expect(out).toContain(
      '<td class="scope" data-label="Scope"><span class="badge kind" data-kind="read">read</span> </td>',
    );
    // A new secret chooses with toggles that start off, one for each role of the credential.
    expect(out).toContain('name="scope" id="secret-scope-read" value="read">');
    expect(out).toContain('name="scope" id="secret-scope-publish" value="publish">');
    expect(out).not.toContain("secret-scope-admin");
    // Every secret of a credential with both roles can be edited, like a GitHub Actions secret.
    expect(out).toContain(
      'href="/admin/credentials/both?tab=secrets&amp;edit=3f9a1c0b7d2e#add-secret"',
    );
    // A credential with one role has nothing to choose, and only a `gh` secret has "Edit".
    const single = detail(shop, { tab: "secrets" });
    expect(single).not.toContain('name="scope"');
    expect(single).not.toContain("edit=3f9a1c0b7d2e");
    expect(single).toContain("edit=c08e5b1f9a27");
  });

  it("says what each role lets a secret do, for the roles the credential holds", () => {
    const add = detail(dual, { tab: "secrets" });
    expect(add).toContain("<strong>read</strong><small>May install packages");
    expect(add).toContain("<strong>publish</strong><small>May publish new versions");
    expect(add).not.toContain("May administer the registry");
    const edit = detail(dual, {
      tab: "secrets",
      editScope: { id: "3f9a1c0b7d2e", scope: ["read"] },
    });
    expect(edit).toContain("<strong>publish</strong><small>May publish new versions");
    const admin = detail(
      { ...dual, roles: ["read", "publish", "admin"] },
      { tab: "secrets", editScope: { id: "3f9a1c0b7d2e", scope: ["read"] } },
    );
    expect(admin).toContain("<strong>admin</strong><small>May administer the registry");
  });

  it("shows the ticked scope again after a refused form", () => {
    const out = detail(dual, {
      tab: "secrets",
      secretError: "Nope.",
      secretValues: {
        type: "key",
        scope: ["publish"],
        totp: false,
        description: "",
        replaces: "",
        expire_old: true,
        repository: "",
        repository_id: "",
        repository_owner_id: "",
        ref: "",
        workflow: "",
        environment: "",
        pin_on_first_use: true,
        expires: "",
      },
    });
    expect(out).toContain('id="secret-scope-publish" value="publish" checked>');
    expect(out).not.toContain('id="secret-scope-read" value="read" checked');
  });

  it("edits the roles of a secret in place, in the panel that adds one", () => {
    const out = detail(dual, {
      tab: "secrets",
      editScope: { id: "3f9a1c0b7d2e", scope: ["read"] },
    });
    expect(out).toContain('<details class="add-secret" id="add-secret" open>');
    expect(out).toContain('action="/admin/credentials/both/secrets/3f9a1c0b7d2e"');
    expect(out).toContain("Editing the roles of the secret <code>3f9a1c0b7d2e</code>");
    expect(out).toContain('id="edit-scope-read" value="read" checked>');
    expect(out).toContain('id="edit-scope-publish" value="publish">');
    expect(out).not.toContain("data-secret-form");
    expect(out).toContain('href="/admin/credentials/both?tab=secrets">Cancel</a>');
    const refused = detail(dual, {
      tab: "secrets",
      editScope: { id: "3f9a1c0b7d2e", scope: ["publish"], error: "Nope." },
    });
    expect(refused).toContain('<p class="error" role="alert">Nope.</p>');
    expect(refused).toContain('id="edit-scope-publish" value="publish" checked>');
  });

  it("offers read + publish in the create form with a scope for the first token", () => {
    const out = newCredentialPage(ctx, { ecosystems: ["composer"] });
    expect(out).toContain(
      '<input type="checkbox" name="roles" id="new-role-publish" value="publish">',
    );
    expect(out).toContain("<strong>read</strong>");
    expect(out).toContain("data-scope hidden");
    expect(out).toContain('data-grants data-grant-kind="publish" data-grant-role="publish"');
    expect(out).toContain("<legend>The first secret may use</legend>");
    const again = newCredentialPage(ctx, {
      ecosystems: ["composer"],
      values: {
        project: "x",
        roles: ["read", "publish"],
        grants: { read: [], publish: [], yank: [], delete: [] },
        scope: ["read"],
        firstSecret: "key",
        totp: false,
        description: "",
      },
    });
    expect(again).not.toContain("data-scope hidden");
    expect(again).toContain('id="first-scope-read" value="read" checked>');
    // All three roles are offered; the script hides those that are off for the credential.
    expect(out).toContain('id="first-scope-publish" value="publish">');
    expect(out).toContain('id="first-scope-admin" value="admin">');
  });
});

describe("credential with admin and read", () => {
  const adminReader: Credential = {
    ...shop,
    project: "ops",
    kind: "admin",
    roles: ["read", "admin"],
    auth: [
      { ...shop.auth[0], scope: ["admin"] },
      { ...shop.auth[1], scope: ["read"] },
    ] as Credential["auth"],
    grants: [],
  };

  it("lists the roles and keeps the grants of the data role", () => {
    const out = detail(adminReader, { tab: "grants" });
    expect(out).toContain('data-grants-field="read_grants"');
    expect(out).not.toContain('data-grants-field="publish_grants"');
    expect(out).toContain("A secret with the admin role sees every package");
    expect(out).toContain('id="credential-role-read" value="read" checked>');
    expect(out).toContain('id="credential-role-admin" value="admin" checked>');
    expect(detail(adminReader)).toContain("<strong>1 read grant</strong>");
  });

  it("offers a toggle for each of its roles for a secret, with edit links in every row", () => {
    const out = detail(adminReader, { tab: "secrets" });
    expect(out).toContain('id="secret-scope-admin" value="admin">');
    expect(out).toContain('id="secret-scope-read" value="read">');
    expect(out).not.toContain("secret-scope-publish");
    expect(out).toContain("edit=3f9a1c0b7d2e");
    expect(out).toContain('<span class="badge kind" data-kind="admin">admin</span>');
  });
});

describe("settings page", () => {
  const setup = setupStatus({
    SESSION_SECRET: "x",
    S3_ENDPOINT: "https://r2.example",
    S3_ACCESS_KEY_ID: "id",
    S3_SECRET_ACCESS_KEY: "",
    ECOSYSTEMS: "composer,npm",
  });
  const page = settingsPage(ctx, {
    version: "1.0.0",
    minClientVersion: "0.1.0",
    schemaVersion: 1,
    setup,
    vars: [
      { name: "ECOSYSTEMS", value: "composer,npm", default: "composer,npm,cargo" },
      { name: "MAX_UPLOAD_BYTES", value: "", default: "536870912" },
      { name: "TOKEN_PREFIX", value: "", default: "" },
      { name: "PUBLIC_URL", value: "" },
    ],
  });

  it("shows the versions read-only", () => {
    expect(page).toContain('aria-current="page">Settings</a>');
    expect(page).toContain("<tr><th>Worker version</th><td>1.0.0</td></tr>");
    expect(page).toContain("<tr><th>Minimum CLI version</th><td>0.1.0</td></tr>");
    expect(page).toContain("<tr><th>Schema version</th><td>1</td></tr>");
    expect(page).not.toContain("data-api");
  });

  it("lists every setting with its status, and plain values with defaults for unset ones", () => {
    expect(page).toContain('<h2 id="setup">Setup</h2>');
    expect(page.match(/class="setup-item"/g)).toHaveLength(setup.length);
    expect(page).toContain(
      '<code class="setup-name">ECOSYSTEMS</code> <span class="status" data-status="set">Set</span>',
    );
    expect(page).toContain("Value: <code>composer,npm</code>");
    expect(page).toContain(
      '<code class="setup-name">MAX_UPLOAD_BYTES</code> <span class="status" data-status="default">Default</span>',
    );
    expect(page).toContain('Value: <code>536870912</code> <span class="hint">(default)</span>');
    expect(page).toContain('Value: <span class="hint">empty (default)</span>');
    expect(page).toContain(
      '<code class="setup-name">S3_SECRET_ACCESS_KEY</code> <span class="status" data-status="missing">Missing</span>',
    );
    expect(page).toContain('href="/admin/settings">Check again</a>');
  });

  it("explains how to add what is missing", () => {
    expect(page).toContain("<pre><code>npx wrangler secret put S3_SECRET_ACCESS_KEY</code></pre>");
    expect(page).toContain("deployment.md#r2-api-token-s3_");
    expect(page).toContain("Wrangler has no command for dashboard variables.");
    // The present SESSION_SECRET needs no generator.
    expect(page).not.toContain("data-secret-gen");
  });
});

describe("admin page width", () => {
  it("is the same wide column on every admin page, so the left edge does not move", () => {
    const pages = [
      adminPackagesPage(ctx, [npmSdk]),
      credentialsPage(ctx, [shop, root], NOW),
      newCredentialPage(ctx, { ecosystems: ["composer"] }),
      detail(shop),
      settingsPage(ctx, {
        version: "1.0.0",
        minClientVersion: "0.1.0",
        schemaVersion: 1,
        setup: [],
        vars: [],
      }),
    ];
    for (const page of pages) expect(page).toContain('<main>\n<div class="catalog wide">');
  });
});

describe("the admin package list with groups", () => {
  const packages = [
    { eco: "npm" as const, name: "@acme/ui", versions: [{ version: "1.0.0" }] },
    { eco: "cargo" as const, name: "loose", versions: [{ version: "0.1.0" }] },
  ];
  let groups: PackageGroups = createGroup(NO_GROUPS, "Acme", null, "aaaa");
  groups = createGroup(groups, "Empty", null, "bbbb");
  groups = assignPackages(groups, ["npm:@acme/ui"], "aaaa");

  it("keeps empty groups, links to the groups page and to Organize mode", () => {
    const page = adminPackagesPage(ctx, packages, { groups });
    expect(page).toContain('id="group-bbbb"');
    expect(page).toContain("No packages in this group yet.");
    expect(page).toContain('href="/admin/packages?organize=1"');
    expect(page).toContain('href="/admin/packages/groups"');
    expect(page).toContain("data-api-url=");
    expect(page).not.toContain("data-organize");
  });

  it("puts a checkbox on every row in Organize mode, in a form with the controls", () => {
    const page = adminPackagesPage(ctx, packages, { groups, organize: true });
    expect(page).toContain(
      '<form method="post" action="/admin/packages/move" class="organize" data-organize>',
    );
    expect(page).toContain('name="package" value="npm:@acme/ui" data-select-row');
    expect(page).toContain('name="package" value="cargo:loose" data-select-row');
    // The row actions make no sense there, and "Done" leaves the mode.
    expect(page).not.toContain("data-api-url=");
    expect(page).toContain('<a class="button small" href="/admin/packages">Done</a>');
    expect(page).toContain('<select name="target" id="move-target">');
    expect(page).toContain('<option value="">Ungrouped</option>');
    expect(page).toContain('<option value="aaaa">Acme</option>');
    expect(page).toContain('name="new_name"');
    expect(page).toContain('<select name="new_parent" id="move-new-parent">');
  });

  it("has no tools and no Organize mode without packages", () => {
    const page = adminPackagesPage(ctx, [], { groups, organize: true });
    expect(page).toContain("No packages have been published yet.");
    expect(page).not.toContain("data-organize");
    expect(page).not.toContain("Manage groups");
  });

  it("shows a notice and an error", () => {
    const page = adminPackagesPage(ctx, packages, {
      notice: "Moved 1 package to Acme.",
      error: "No.",
    });
    expect(page).toContain('<p class="notice" role="status">Moved 1 package to Acme.</p>');
    expect(page).toContain('<p class="error" role="alert">No.</p>');
  });
});

describe("the groups page", () => {
  let state: PackageGroups = createGroup(NO_GROUPS, "Acme", null, "aaaa");
  state = createGroup(state, "Web", "aaaa", "bbbb");
  state = assignPackages(state, ["npm:a"], "aaaa");

  it("lists the groups with a form each and says how many packages they hold", () => {
    const page = groupsPage(ctx, { state, counts: new Map([["aaaa", 1]]) });
    expect(page).toContain(
      '<form method="post" action="/admin/packages/groups" class="box group-new">',
    );
    expect(page).toContain(
      '<form method="post" action="/admin/packages/groups/aaaa" class="group-edit">',
    );
    expect(page).toContain(
      '<form method="post" action="/admin/packages/groups/bbbb/delete" class="group-delete">',
    );
    expect(page).toContain('class="group-row depth-2" id="group-bbbb"');
    expect(page).toContain("1 package, 1 subgroup.");
    expect(page).toContain("0 packages.");
  });

  it("offers as parent of a group only places it can move to", () => {
    const page = groupsPage(ctx, { state, counts: new Map() });
    const edit = page.slice(page.indexOf('id="parent-aaaa"'), page.indexOf('id="name-bbbb"'));
    // `Acme` holds `Web`: nothing else can take it, so only the top level is offered.
    expect(edit).not.toContain('value="bbbb"');
    expect(edit).not.toContain('value="aaaa"');
  });

  it("says when there are no groups, and shows the notice and the error", () => {
    const page = groupsPage(ctx, {
      state: NO_GROUPS,
      counts: new Map(),
      notice: "Group created.",
      error: "Give the group a name.",
    });
    expect(page).toContain("There are no groups yet.");
    expect(page).toContain('<p class="notice" role="status">Group created.</p>');
    expect(page).toContain('<p class="error" role="alert">Give the group a name.</p>');
  });
});

describe("the group of a package", () => {
  const view: PackageView = { eco: "npm", name: "@acme/sdk", versions: [] };
  let state: PackageGroups = createGroup(NO_GROUPS, "Acme", null, "aaaa");
  state = assignPackages(state, ["npm:@acme/sdk"], "aaaa");

  it("shows an admin the group with a form to move the package", () => {
    const page = packagePage(ctx, {
      view,
      snippets: [],
      admin: true,
      groups: { state, key: "npm:@acme/sdk", current: "aaaa" },
    });
    expect(page).toContain('<a href="/admin/packages#group-aaaa">Acme</a>');
    expect(page).toContain('<input type="hidden" name="package" value="npm:@acme/sdk">');
    expect(page).toContain('<input type="hidden" name="return" value="package">');
    expect(page).toContain('<option value="aaaa" selected>Acme</option>');
  });

  it("says Ungrouped for a package in no group, and shows nothing to a consumer", () => {
    const loose = packagePage(ctx, {
      view,
      snippets: [],
      admin: true,
      groups: { state, key: "npm:@acme/sdk", current: null },
    });
    expect(loose).toContain('<span class="muted">Ungrouped</span>');
    const consumer = packagePage(ctx, { view, snippets: [] });
    expect(consumer).not.toContain("group-switch");
  });
});

describe("the admin package list and hidden groups", () => {
  const packages = [
    { eco: "npm" as const, name: "visible-one", versions: [{ version: "1.0.0" }] },
    { eco: "npm" as const, name: "vault-one", versions: [{ version: "1.0.0" }] },
    { eco: "cargo" as const, name: "vault-two", versions: [{ version: "1.0.0" }] },
  ];
  let groups: PackageGroups = createGroup(NO_GROUPS, "Vault", null, "aaaa", "hidden");
  groups = assignPackages(groups, ["npm:vault-one", "cargo:vault-two"], "aaaa");

  it("offers to show the hidden groups, with the number of packages in them", () => {
    const page = adminPackagesPage(ctx, packages, { groups });
    expect(page).toContain(
      '<a class="button secondary small" href="/admin/packages?hidden=1" aria-pressed="false">Show hidden groups (2)</a>',
    );
    expect(page).not.toContain("vault-one");
    expect(page).toContain("1 package.");
  });

  it("offers to hide them again when they are shown, and keeps the mode in its links", () => {
    const page = adminPackagesPage(ctx, packages, { groups, showHidden: true });
    expect(page).toContain(
      '<a class="button secondary small" href="/admin/packages" aria-pressed="true">Hide hidden groups</a>',
    );
    expect(page).toContain('href="/admin/packages?organize=1&amp;hidden=1">Organize</a>');
    expect(page).toContain("vault-one");
  });

  it("keeps the mode in Organize mode: the Done link, the toggle and the form", () => {
    const hidden = adminPackagesPage(ctx, packages, { groups, organize: true });
    expect(hidden).toContain('<a class="button small" href="/admin/packages">Done</a>');
    expect(hidden).toContain('href="/admin/packages?organize=1&amp;hidden=1"');
    expect(hidden).not.toContain('name="show_hidden"');
    const shown = adminPackagesPage(ctx, packages, { groups, organize: true, showHidden: true });
    expect(shown).toContain('<a class="button small" href="/admin/packages?hidden=1">Done</a>');
    expect(shown).toContain('<input type="hidden" name="show_hidden" value="1">');
    expect(shown).toContain('name="package" value="npm:vault-one"');
    expect(shown).toContain('href="/admin/packages?organize=1" aria-pressed="true"');
    // The groups are move targets whether they are shown or not.
    expect(hidden).toContain("Vault (hidden)</option>");
  });

  it("has no toggle without a hidden group", () => {
    const plain = createGroup(NO_GROUPS, "Open", null, "aaaa");
    expect(adminPackagesPage(ctx, packages, { groups: plain })).not.toContain("hidden groups");
  });
});

describe("the groups page and visibility", () => {
  let state: PackageGroups = createGroup(NO_GROUPS, "Open", null, "aaaa");
  state = createGroup(state, "Closed", null, "bbbb", "collapsed");
  state = createGroup(state, "Vault", null, "cccc", "hidden");
  state = createGroup(state, "Deep", "cccc", "dddd");

  it("offers the three visibilities on the new group form and on every group, the current one chosen", () => {
    const page = groupsPage(ctx, { state, counts: new Map() });
    expect(page).toContain('<select id="group-visibility" name="visibility">');
    for (const [id, chosen] of [
      ["bbbb", "collapsed"],
      ["cccc", "hidden"],
      ["aaaa", "visible"],
    ] as const) {
      const at = page.indexOf(`<select id="visibility-${id}" name="visibility">`);
      expect(at).toBeGreaterThan(0);
      const select = page.slice(at, page.indexOf("</select>", at));
      expect(select).toContain(`<option value="${chosen}" selected>`);
      expect(select.match(/ selected>/g)).toHaveLength(1);
      expect(select).toContain('value="visible"');
      expect(select).toContain('value="collapsed"');
      expect(select).toContain('value="hidden"');
    }
  });

  it("flags collapsed and hidden groups, and a group hidden by the one above, and links to them", () => {
    const page = groupsPage(ctx, { state, counts: new Map() });
    expect(page).toContain('<span class="badge">collapsed</span>');
    expect(page).toContain('<span class="badge">hidden</span>');
    expect(page).toContain('<span class="badge">hidden by a group above</span>');
    expect(page).toContain('<a href="/admin/packages#group-aaaa">Show in the list</a>');
    expect(page).toContain('<a href="/admin/packages?hidden=1#group-cccc">Show in the list</a>');
    expect(page).toContain('<a href="/admin/packages?hidden=1#group-dddd">Show in the list</a>');
  });
});

describe("the group of a package in a hidden group", () => {
  it("links to the list with the hidden groups shown", () => {
    const view: PackageView = { eco: "npm", name: "secret", versions: [] };
    let state: PackageGroups = createGroup(NO_GROUPS, "Vault", null, "aaaa", "hidden");
    state = assignPackages(state, ["npm:secret"], "aaaa");
    const page = packagePage(ctx, {
      view,
      snippets: [],
      admin: true,
      groups: { state, key: "npm:secret", current: "aaaa" },
    });
    expect(page).toContain('<a href="/admin/packages?hidden=1#group-aaaa">Vault</a>');
    expect(page).toContain("Vault (hidden)</option>");
  });
});

describe("the breadcrumb of a package page and its groups", () => {
  const view: PackageView = { eco: "npm", name: "@acme/sdk", versions: [] };
  const key = "npm:@acme/sdk";
  /** `Licensing Kit` > `Server` > `Sources` holds the package; `Vault` (hidden) > `Deep` another. */
  let state: PackageGroups = createGroup(NO_GROUPS, "Licensing Kit", null, "aaaa");
  state = createGroup(state, "Server", "aaaa", "bbbb");
  state = createGroup(state, "Sources", "bbbb", "cccc");
  state = createGroup(state, "Vault", null, "dddd", "hidden");
  state = createGroup(state, "Deep", "dddd", "eeee");
  const readerCtx = { ...ctx, user: { project: "shop", roles: ["read" as const] } };
  const crumbs = (page: string): string => {
    const start = page.indexOf('<nav class="crumbs"');
    return page.slice(start, page.indexOf("</nav>", start));
  };

  it("shows the groups above the package, from the top down, linking to them in the list", () => {
    const home = (admin: boolean) =>
      packagePage(admin ? ctx : readerCtx, {
        view,
        snippets: [],
        admin,
        groups: { state: assignPackages(state, [key], "cccc"), key, current: "cccc" },
      });
    const asAdmin = crumbs(home(true));
    expect(asAdmin).toContain('<li><a href="/admin/packages">Packages</a></li>');
    const order = ["Licensing Kit", "Server", "Sources", "@acme/sdk"].map((name) =>
      asAdmin.indexOf(name),
    );
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(asAdmin).toContain('<a href="/admin/packages#group-aaaa">Licensing Kit</a>');
    expect(asAdmin).toContain('<a href="/admin/packages#group-cccc">Sources</a>');
    expect(asAdmin).toContain('<li aria-current="page">@acme/sdk</li>');
    // A consumer sees the same trail, linking to its own list.
    const asReader = crumbs(home(false));
    expect(asReader).toContain('<a href="/#group-aaaa">Licensing Kit</a>');
    expect(asReader).toContain('<a href="/#group-bbbb">Server</a>');
    expect(asReader).toContain('<a href="/#group-cccc">Sources</a>');
  });

  it("is only the package when it is in no group", () => {
    const page = packagePage(ctx, { view, snippets: [], groups: { state, key, current: null } });
    expect(crumbs(page)).not.toContain("group-");
    expect(crumbs(page)).toContain('<li aria-current="page">@acme/sdk</li>');
    expect(crumbs(packagePage(ctx, { view, snippets: [] }))).not.toContain("group-");
  });

  it("shows a hidden group's path only to an admin, with the hidden groups shown in the list", () => {
    const groups = { state: assignPackages(state, [key], "eeee"), key, current: "eeee" };
    const asAdmin = crumbs(packagePage(ctx, { view, snippets: [], admin: true, groups }));
    expect(asAdmin).toContain('<a href="/admin/packages?hidden=1#group-dddd">Vault</a>');
    expect(asAdmin).toContain('<a href="/admin/packages?hidden=1#group-eeee">Deep</a>');
    const asReader = crumbs(packagePage(readerCtx, { view, snippets: [], groups }));
    expect(asReader).not.toContain("Vault");
    expect(asReader).not.toContain("Deep");
    expect(asReader).not.toContain("group-");
  });

  it("escapes a group's name", () => {
    const odd = createGroup(NO_GROUPS, "<b>x</b>", null, "aaaa");
    const page = packagePage(ctx, {
      view,
      snippets: [],
      groups: { state: odd, key, current: "aaaa" },
    });
    expect(crumbs(page)).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(crumbs(page)).not.toContain("<b>");
  });
});
