/**
 * The credential pages (kind `admin`): the list (`GET /admin/credentials`), the create form
 * (`GET /admin/credentials/new`, posted to the same path) and one credential
 * (`GET /admin/credentials/<project>`) in server-rendered tabs (`?tab=`): the overview, the
 * grants, the secrets with the collapsed "add a secret" form (posted to `…/secrets`) and the
 * danger zone. Creating a credential or a `key` secret answers with the one-time token page
 * (`src/pages/token.ts`); editing grants, expiring a secret and deleting the credential are
 * `fetch` calls to `/api/v1` made by `public/app.js`.
 */

import type { Eco } from "../adapters/types";
import {
  GRANT_ROLES,
  KINDS,
  emptyGrants,
  type AuthEntry,
  type Credential,
  type GrantRole,
  type Kind,
} from "../core/auth";
import type { Grant } from "../core/grants";
import { apiPath, awaitsPin, credentialHref, dangerZone, isActiveAt, secretSummary } from "./admin";
import { breadcrumbs, day, ECO_NAMES, plural } from "./catalog";
import {
  attr,
  descriptionField,
  errorMessage,
  passwordFields,
  segmented,
  toggles,
  totpField,
  type Toggle,
} from "./components";
import { SLUG_PATTERN } from "./firstRun";
import { markup, type SafeHtml } from "./html";
import { layout, type PageContext } from "./layout";

/** Every role in the order the panel lists them; a scope or role set is always written so. */
const ALL_ROLES: readonly Kind[] = KINDS;

/** The roles as toggles, each with what it may do. */
const ROLE_TOGGLES: readonly Toggle[] = [
  {
    value: "read",
    label: "read",
    hint: "Installs packages: sees the packages of its read grants and, for transitive grants, their dependencies in this registry.",
  },
  {
    value: "publish",
    label: "publish",
    hint: "Publishes new versions of the packages of its publish grants, usually from CI. It cannot install or list packages.",
  },
  {
    value: "yank",
    label: "yank",
    hint: "Yanks versions of the packages of its yank grants, with a key, a GitHub Actions secret or a login. It cannot install, publish or delete.",
  },
  {
    value: "delete",
    label: "delete",
    hint: "Permanently deletes versions of the packages of its delete grants; deleting a whole package needs a grant for all versions. It cannot undo a delete.",
  },
  {
    value: "admin",
    label: "admin",
    hint: "Manages packages and credentials in this panel and through the API; sees every package and may yank and delete anything. It has no grants of its own.",
  },
];

/** The values of the create form, kept when it is shown again after an error. */
export interface CredentialFormValues {
  project: string;
  roles: Kind[];
  /** The grants of each role; only the roles held are sent. */
  grants: Record<GrantRole, Grant[]>;
  /** The scope chosen for the first secret of a credential with several roles. */
  scope: Kind[];
  /** What the first secret is: nothing yet, a generated key or a login (`admin`: not none). */
  firstSecret: "none" | "key" | "login";
  /** `login` only: whether a one-time code is required. */
  totp: boolean;
  description: string;
}

/** The values of the "add a secret" form, kept when it is shown again after an error. */
export interface SecretFormValues {
  type: "key" | "gh" | "login";
  /** The roles the secret may use; asked only when the credential holds several. */
  scope: Kind[];
  /** `login` only: whether a one-time code is required besides the password. */
  totp: boolean;
  description: string;
  /** Editing a `gh` secret: the `id` of the one the new entry replaces. */
  replaces: string;
  /** Editing: whether the old secret expires now (the box is ticked). */
  expire_old: boolean;
  repository: string;
  repository_id: string;
  repository_owner_id: string;
  ref: string;
  workflow: string;
  environment: string;
  pin_on_first_use: boolean;
  expires: string;
}

const NEW_GRANT: Grant = { eco: "composer", package: "", versions: "*", transitive: true };

/** The script of the text view of the grants (`public/grants.js`), loaded where grants are edited. */
const GRANTS_SCRIPT = "/grants.js";

const FORM_ERROR = markup`<p class="error" role="alert" data-form-error hidden></p>`;

// ---------------------------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------------------------

/**
 * One grant row. Its fields carry `name`s for the create form, which is posted as is: every
 * row sends `grant` (its key), `grant_eco`, `grant_package` and `grant_versions`, and a ticked
 * `grant_transitive` sends the row's key, so an unticked box (which sends nothing) still pairs
 * with its row. `data-field` names the same fields for the JSON that `app.js` builds when the
 * grants of a credential are saved. The template row has an empty key; `app.js` gives every
 * added row a fresh one.
 */
export function grantRow(
  ecosystems: readonly Eco[],
  grant?: Grant,
  key = "",
  prefix = "",
): SafeHtml {
  const options = ecosystems.map(
    (eco) =>
      markup`<option value="${eco}"${attr("selected", grant?.eco === eco)}>${ECO_NAMES[eco]}</option>`,
  );
  const transitive = grant === undefined || grant.transitive !== false;
  return markup`<div class="grant-row" data-grant-row>
<input type="hidden" name="${prefix}grant" value="${key}" data-grant-key>
<select name="${prefix}grant_eco" data-field="eco" aria-label="Ecosystem">${options}</select>
<input type="text" name="${prefix}grant_package" data-field="package" aria-label="Package" placeholder="acme/* or a package name" spellcheck="false" value="${grant?.package ?? ""}">
<input type="text" name="${prefix}grant_versions" data-field="versions" aria-label="Versions" placeholder="*" spellcheck="false" value="${grant?.versions ?? "*"}">
<label class="inline" data-transitive><input type="checkbox" name="${prefix}grant_transitive" value="${key}" data-field="transitive"${attr("checked", transitive)}> transitive</label>
<button type="button" class="danger small" data-remove-grant>Remove</button>
</div>`;
}

/**
 * The grant rows of a form for the grants of one `role`. `transitive` only means something for
 * `read`, so the stylesheet hides it (`[data-transitive]`) inside a `publish` fieldset. In a
 * form that holds both lists the field names carry the role as a prefix (`read_grant_eco`),
 * which `app.js` and `grants.js` also give to the rows they add. The fieldset is named by the
 * heading `headingId` of the page or of the form.
 */
function grantsFieldset(
  ecosystems: readonly Eco[],
  grants: readonly Grant[],
  role: GrantRole,
  headingId: string,
  hidden = false,
): SafeHtml {
  const rows = grants.map((g, i) => grantRow(ecosystems, g, String(i), `${role}_`));
  return markup`<fieldset class="plain" data-grants data-grant-kind="${role}" data-grant-role="${role}" aria-labelledby="${headingId}"${attr("hidden", hidden)}>
<p class="hint">Package: an exact name or a pattern ending in <code>*</code>. Versions: a constraint in the ecosystem's syntax, <code>*</code> for all.<span data-transitive> Transitive: also open the package's dependencies in this registry.</span></p>
<div class="grants-tools"><button type="button" class="secondary small" data-grants-toggle hidden>Edit as text</button></div>
<div data-grants-rows-pane>
<div data-grant-rows>${rows}</div>
<button type="button" class="secondary small" data-add-grant>Add grant</button>
</div>
<div data-grants-text-pane hidden>
<p class="error" role="alert" data-grants-text-error hidden></p>
<textarea class="grants-text" data-grants-text rows="8" aria-label="Grants as text" spellcheck="false" placeholder="npm:@acme/sdk:^2.0"></textarea>
<p class="hint">One grant per line: <code>eco:package[:versions[:transitive]]</code>, as in <code>sreg</code>. Versions default to <code>*</code>.<span data-transitive> Add <code>:false</code> to leave the dependencies closed.</span> Empty lines and lines starting with <code>#</code> are ignored.</p>
</div>
</fieldset>`;
}

/** What a role lets one secret do, shown under the toggles that choose a secret's roles. */
const SCOPE_HINTS: Readonly<Record<Kind, string>> = {
  read: "May install packages within the credential's read grants.",
  publish: "May publish new versions within the credential's publish grants.",
  yank: "May yank versions within the credential's yank grants.",
  delete: "May delete versions within the credential's delete grants.",
  admin:
    "May administer the registry: packages, credentials and secrets, in the panel and through the API. Keep it off for tokens committed to a repository or used in CI.",
};

/**
 * The roles of a secret as toggles named `scope`, one for each role in `held` (a role the
 * credential does not hold cannot be given to a secret). On the create form `held` is every
 * role and `app.js` hides the toggles of the roles that are off in the credential.
 */
function scopeToggles(
  label: string,
  selected: readonly Kind[],
  held: readonly Kind[],
  idPrefix: string,
): SafeHtml {
  const items = ROLE_TOGGLES.filter((t) => held.includes(t.value as Kind)).map((t) => ({
    value: t.value,
    label: t.label,
    hint: SCOPE_HINTS[t.value as Kind],
  }));
  return toggles("scope", label, items, selected, { idPrefix });
}

/** The roles of a credential as toggles named `roles`, each with what it may do. */
function roleToggles(label: string, selected: readonly Kind[], idPrefix: string): SafeHtml {
  return toggles("roles", label, ROLE_TOGGLES, selected, { idPrefix });
}

function grantTemplate(ecosystems: readonly Eco[]): SafeHtml {
  return markup`<template id="grant-row">${grantRow(ecosystems)}</template>`;
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

/** Whether the credential only administers: it holds neither `read` nor `publish`. */
function isAdminOnly(credential: Pick<Credential, "roles">): boolean {
  return !credential.roles.some((role) => role !== "admin");
}

/** The roles of a credential as badges. */
function roleBadges(roles: readonly Kind[]): SafeHtml {
  return markup`${roles.map((role) => markup`<span class="badge kind" data-kind="${role}">${role}</span> `)}`;
}

/** The number of grants of each role a credential holds, as `read 2 · publish 1`. */
function grantCounts(credential: Credential): SafeHtml | number {
  const held = GRANT_ROLES.filter((role) => credential.roles.includes(role));
  if (held.length === 0) return markup`<span class="hint">—</span>`;
  const count = (role: GrantRole) => roleGrantsOf(credential, role).length;
  if (held.length === 1) return count(held[0] ?? "read");
  return markup`${held.map((role) => `${role} ${count(role)}`).join(" · ")}`;
}

/** The grants of one role of a credential. */
function roleGrantsOf(credential: Credential, role: GrantRole): Grant[] {
  return credential[`${role}_grants`];
}

/** `Read grants`, `Yank grants`: the heading of a role's list. */
function grantsHeading(role: GrantRole): string {
  return `${role.charAt(0).toUpperCase()}${role.slice(1)} grants`;
}

/** The roles a secret may use, as badges. */
function scopeBadges(entry: AuthEntry): SafeHtml {
  return roleBadges(entry.scope);
}

function listRow(credential: Credential, now: Date): SafeHtml {
  const { project } = credential;
  const { active, nearestExpiry } = secretSummary(credential, now);
  const expiry =
    nearestExpiry === null
      ? markup`<span class="hint">never</span>`
      : markup`<time datetime="${nearestExpiry}">${day(nearestExpiry)}</time>`;
  const grants = grantCounts(credential);
  return markup`<tr data-pkg-row data-name="${project}">
<td><a class="row-link" href="${credentialHref(project)}">${project}</a></td>
<td>${roleBadges(credential.roles)}</td>
<td class="num">${active}</td>
<td class="nowrap">${expiry}</td>
<td class="num">${grants}</td>
</tr>`;
}

/** `GET /admin/credentials`: every credential in a table with a filter by project. */
export function credentialsPage(
  ctx: PageContext,
  credentials: readonly Credential[],
  now: Date,
): string {
  const sorted = [...credentials].sort((a, b) => (a.project < b.project ? -1 : 1));
  const filter =
    sorted.length < 2
      ? ""
      : markup`<div class="pkg-filter" data-pkg-filter hidden>
<div class="pkg-search">
<label for="pkg-filter-name">Filter by project</label>
<input type="search" id="pkg-filter-name" data-filter-name autocomplete="off" spellcheck="false">
</div>
</div>`;
  const table =
    sorted.length === 0
      ? markup`<div class="pkg-empty"><p>No credentials yet.</p></div>`
      : markup`<div class="box table-box"><table class="credentials">
<thead><tr><th>Project</th><th>Roles</th><th class="num">Active secrets</th><th>Nearest expiry</th><th class="num">Grants</th></tr></thead>
<tbody data-pkg-list>
${sorted.map((c) => listRow(c, now))}
</tbody>
</table></div>
<p class="pkg-none-match" data-pkg-empty role="status" hidden>No credentials match the filter.</p>`;
  return layout(
    ctx,
    "Credentials",
    markup`<div class="catalog wide">
<div class="page-head">
<h1>Credentials</h1>
<a class="button" href="/admin/credentials/new">New credential</a>
</div>
<p class="consumer-lead" data-pkg-lead data-noun="credential" aria-live="polite">${plural(sorted.length, "credential")}. Open one to edit its grants and secrets.</p>
${filter}
${table}
</div>`,
    { page: "credentials", section: "credentials" },
  );
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

/** What the create form needs. */
export interface NewCredentialData {
  ecosystems: Eco[];
  error?: string;
  values?: CredentialFormValues;
}

/** `GET /admin/credentials/new`: the create form alone. */
export function newCredentialPage(ctx: PageContext, data: NewCredentialData): string {
  const { ecosystems } = data;
  const first = ecosystems[0] ?? NEW_GRANT.eco;
  const values: CredentialFormValues = data.values ?? {
    project: "",
    roles: ["read"],
    grants: emptyGrants(),
    scope: [],
    firstSecret: "none",
    totp: false,
    description: "",
  };
  const grantsOf = (role: GrantRole) => {
    const list = values.grants[role];
    return list.length > 0 ? list : [{ ...NEW_GRANT, eco: first }];
  };
  const { roles } = values;
  const firstSecrets = [
    { value: "none", label: "None" },
    { value: "key", label: "Key" },
    { value: "login", label: "Login" },
  ];
  const sections = GRANT_ROLES.map((role) => {
    const shown = roles.includes(role);
    return markup`<h2 class="form-heading" id="new-${role}-grants"${attr("hidden", !shown)} data-grants-heading data-role="${role}">${grantsHeading(role)}</h2>
${grantsFieldset(ecosystems, grantsOf(role), role, `new-${role}-grants`, !shown)}`;
  });
  return layout(
    ctx,
    "New credential",
    markup`<div class="catalog wide">
${breadcrumbs([{ label: "Credentials", href: "/admin/credentials" }, { label: "New credential" }])}
<h1>New credential</h1>
<p class="consumer-lead">A credential is a project with its roles, their grants and its secrets. Choose its first secret now or add one later.</p>
<form class="box form" method="post" action="/admin/credentials/new" data-credential-form>
${errorMessage(data.error)}
<label for="project">Project</label>
<input id="project" name="project" type="text" required pattern="${SLUG_PATTERN}" autocomplete="off" spellcheck="false" placeholder="e.g. shop-frontend" value="${values.project}">
<p class="hint">Lower-case letters, digits and dashes, 2 to 63 characters; the login of its tokens.</p>
<fieldset class="plain" data-kind>
<legend>Roles</legend>
${roleToggles("Roles of the credential", roles, "new-role")}
</fieldset>
<fieldset class="plain" data-first-secret>
<legend>First secret</legend>
${segmented("first_secret", "First secret", firstSecrets, values.firstSecret)}
<p class="hint">None: add a secret later, on the credential's Secrets tab. Key: a generated token for the API and package managers, shown once. Login: a password with an optional one-time code, for people who sign in to the panel or with <code>sreg login</code>.</p>
</fieldset>
<div data-login-fields${attr("hidden", values.firstSecret !== "login")}>
${totpField(values.totp)}
</div>
${passwordFields("first_secret:login", values.firstSecret === "login")}
${descriptionField(values.description)}
<fieldset class="plain" data-scope${attr("hidden", roles.length < 2 || values.firstSecret === "none")}>
<legend>The first secret may use</legend>
${scopeToggles("Roles of the first secret", values.scope, ALL_ROLES, "first-scope")}
<p class="hint">Further secrets get their own scope.</p>
</fieldset>
${sections}
<button type="submit">Create credential</button>
</form>
${grantTemplate(ecosystems)}
</div>`,
    { page: "credential-new", section: "credentials", scripts: [GRANTS_SCRIPT] },
  );
}

// ---------------------------------------------------------------------------------------------
// One credential
// ---------------------------------------------------------------------------------------------

/** A claim value of a `gh` entry in code style, or `any` when the claim is not checked. */
function claimValue(value: string | null | undefined): SafeHtml {
  return typeof value === "string" ? markup`<code>${value}</code>` : markup`any`;
}

function claims(entry: AuthEntry): SafeHtml {
  if (entry.type === "key") return markup`<span class="hint">—</span>`;
  if (entry.type === "login") {
    return markup`<span class="hint">${entry.totp === true ? "password and one-time code" : "password"}</span>`;
  }
  const optional: [string, string | null | undefined][] = [
    ["repository id", entry.repository_id],
    ["owner id", entry.repository_owner_id],
    ["environment", entry.environment],
  ];
  const extra = optional
    .filter((pair): pair is [string, string] => typeof pair[1] === "string")
    .map(([label, value]) => markup` · ${label} ${claimValue(value)}`);
  const pin = awaitsPin(entry)
    ? markup` · <span class="hint nowrap">pinned on first use</span>`
    : "";
  return markup`${claimValue(entry.repository)} · ref ${claimValue(entry.ref)} · workflow ${claimValue(entry.workflow)}${extra}${pin}`;
}

/**
 * The description of a secret: its text, and a small form that saves a new one with a `PATCH`
 * (`app.js`). The form is shown inline without scripts; with them it stays folded behind "Edit"
 * (or "Add"), like "Expire…".
 */
function descriptionCell(project: string, entry: AuthEntry): SafeHtml {
  const text =
    entry.description === null || entry.description === undefined
      ? markup`<span class="hint">None</span>`
      : markup`${entry.description}`;
  return markup`<div class="description-cell" data-description>
<span class="description-text">${text}</span>
<button type="button" class="link small" data-describe-open hidden>${entry.description ? "Edit" : "Add"}</button>
<form class="inline-form describe-form" data-api-form="describe" data-api-method="PATCH" data-api-url="${apiPath("credentials", project, "secrets", entry.id)}" data-describe-form>
<input type="text" name="description" maxlength="200" autocomplete="off" aria-label="Description of ${entry.id}" placeholder="Add a description" value="${entry.description ?? ""}">
<button type="submit" class="secondary small">Save</button>
<button type="button" class="link small" data-describe-cancel hidden>Cancel</button>
<span class="error" role="alert" data-form-error hidden></span>
</form>
</div>`;
}

function secretRow(project: string, entry: AuthEntry, now: Date, editableScope = false): SafeHtml {
  const active = isActiveAt(entry, now);
  const expires =
    entry.expires === null
      ? markup`<span class="hint">never</span>`
      : markup`<time datetime="${entry.expires}" title="${entry.expires}">${day(entry.expires)}</time>`;
  // Without scripts the date and "Expire" are shown inline; `app.js` hides them behind
  // "Expire…" until it is pressed.
  const expire = active
    ? markup`<form class="inline-form expire-form" data-api-form="expire" data-api-method="DELETE" data-api-url="${apiPath("credentials", project, "secrets", entry.id)}" data-confirm="Expire the secret ${entry.id} of ${project}?" data-expire-form>
<button type="button" class="danger small" data-expire-open hidden>Expire…</button>
<span class="expire-fields" data-expire-fields>
<input type="date" name="expires" aria-label="Expire ${entry.id} on (empty: now)">
<button type="submit" class="danger small">Expire</button>
<button type="button" class="link small" data-expire-cancel hidden>Cancel</button>
</span>
</form>`
    : markup`<span class="badge warn">expired</span>`;
  // A GitHub Actions secret is edited by adding a changed copy (and expiring this one); any
  // secret of a credential with both roles can have its roles changed in place.
  const edit =
    entry.type === "gh" || editableScope
      ? markup`<a class="button secondary small" href="${credentialHref(project)}?tab=secrets&amp;edit=${entry.id}#add-secret">Edit</a> `
      : "";
  return markup`<tr>
<td data-label="Type"><span class="badge">${entry.type}</span></td>
<td data-label="ID"><code>${entry.id}</code></td>
<td class="scope" data-label="Scope">${scopeBadges(entry)}</td>
<td class="description" data-label="Description">${descriptionCell(project, entry)}</td>
<td class="nowrap" data-label="Created"><time datetime="${entry.created}">${day(entry.created)}</time></td>
<td class="nowrap" data-label="Expires">${expires}</td>
<td class="claims" data-label="Claims">${claims(entry)}</td>
<td class="secret-action"><div class="row-actions">${edit}${expire}</div></td>
</tr>`;
}

function overview(credential: Credential, login: string, now: Date): SafeHtml {
  const { active, nearestExpiry } = secretSummary(credential, now);
  const created = credential.auth
    .map((e) => e.created)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const ids = credential.auth
    .filter((e) => isActiveAt(e, now))
    .map((e) => markup`<code>${e.id}</code> `);
  const facts: [string, SafeHtml | string][] = [
    ["Roles", roleBadges(credential.roles)],
    ["Login", markup`<code>${login}</code>`],
    [
      "Created",
      created === undefined ? "—" : markup`<time datetime="${created}">${day(created)}</time>`,
    ],
    ["Active secrets", `${active} of ${credential.auth.length}`],
    ["Nearest expiry", nearestExpiry === null ? "never" : day(nearestExpiry)],
    ["Active secret IDs", ids.length === 0 ? "—" : markup`${ids}`],
  ];
  const href = credentialHref(credential.project);
  const adminOnly = isAdminOnly(credential);
  const grants = adminOnly
    ? "No grants (admin)"
    : GRANT_ROLES.filter((role) => credential.roles.includes(role))
        .map((role) => plural(roleGrantsOf(credential, role).length, `${role} grant`))
        .join(" · ");
  const links: [string, string, string][] = [
    [
      `${href}?tab=grants`,
      grants,
      adminOnly ? "Admin credentials see everything" : "Edit the grants and roles",
    ],
    [
      `${href}?tab=secrets`,
      `${active} active of ${plural(credential.auth.length, "secret")}`,
      "Expire secrets",
    ],
    [`${href}?tab=secrets&add=1`, "New secret", "Add a key or GitHub Actions secret"],
    [`${href}?tab=danger`, "Danger zone", "Delete this credential"],
  ];
  return markup`<section class="section" aria-labelledby="overview">
<h2 id="overview">Overview</h2>
<div class="box"><dl class="facts">
${facts.map(([name, value]) => markup`<div><dt>${name}</dt><dd>${value}</dd></div>`)}
</dl></div>
<ul class="overview-links">
${links.map(([to, title, text]) => markup`<li><a href="${to}"><strong>${title}</strong><span>${text}</span></a></li>`)}
</ul>
</section>`;
}

function grantsSection(credential: Credential, ecosystems: readonly Eco[]): SafeHtml {
  const { project } = credential;
  const url = apiPath("credentials", project);
  const forms = GRANT_ROLES.filter((role) => credential.roles.includes(role)).map(
    (role) => markup`<h3 id="${role}-grants">${grantsHeading(role)}</h3>
<form class="box" data-api-form="grants" data-api-method="PATCH" data-api-url="${url}" data-grants-field="${role}_grants">
${grantsFieldset(ecosystems, roleGrantsOf(credential, role), role, `${role}-grants`)}
${FORM_ERROR}
<div class="form-actions"><button type="submit">Save ${role} grants</button></div>
</form>`,
  );
  const note = isAdminOnly(credential)
    ? markup`<div class="box"><p class="hint">This credential only administers: it sees and manages everything and has no grants. Give it the read, publish, yank or delete role below to let a secret use grants.</p></div>`
    : credential.roles.includes("admin")
      ? markup`<p class="hint">A secret with the admin role sees every package whatever the grants below say; the grants apply to its read, publish, yank and delete secrets.</p>`
      : "";
  return markup`<section class="section" aria-labelledby="grants">
<h2 id="grants">Grants</h2>
${note}
${forms}
<h3 id="roles">Roles</h3>
<form class="box" data-api-form="roles" data-api-method="PATCH" data-api-url="${url}">
${roleToggles("Roles of the credential", credential.roles, "credential-role")}
<p class="hint">Adding a role never widens the secrets the credential already has: they keep the roles they had, and new secrets choose their scope. A role cannot be removed while an active secret has nothing else, and the last admin credential keeps the admin role.</p>
${FORM_ERROR}
<div class="form-actions"><button type="submit">Save roles</button></div>
</form>
</section>`;
}

function secretsSection(credential: Credential, now: Date, add: SafeHtml): SafeHtml {
  const editableScope = credential.roles.length > 1;
  const rows = credential.auth.map((e) => secretRow(credential.project, e, now, editableScope));
  return markup`<section class="section" aria-labelledby="secrets">
<h2 id="secrets">Secrets</h2>
${add}
<div class="box table-box"><table class="secrets">
<thead><tr><th>Type</th><th>ID</th><th>Scope</th><th>Description</th><th>Created</th><th>Expires</th><th>Claims</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
</section>`;
}

const NO_SECRET_VALUES: SecretFormValues = {
  type: "key",
  scope: [],
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
};

/**
 * The "add a secret" form, collapsed behind a primary "Add a secret" button (a `<details>`, so
 * it works without scripts); `open` after `?add=1` or `?edit=<id>` and when a refused form is
 * shown again. When `values.replaces` names a `gh` secret, the form edits it: it is filled in
 * with that secret, and saving adds the changed copy and, when the box is ticked, expires the
 * old one.
 */
function addSecretSection(
  credential: Credential,
  values: SecretFormValues,
  error: string | undefined,
  open: boolean,
): SafeHtml {
  const gh = values.type === "gh";
  const login = values.type === "login";
  const types = [
    { value: "key", label: "Key" },
    { value: "gh", label: "GitHub Actions" },
    { value: "login", label: "Login" },
  ];
  const scope =
    credential.roles.length > 1
      ? markup`<fieldset class="plain" data-secret-scope>
<legend>This secret may use</legend>
${scopeToggles("Roles of the secret", values.scope, credential.roles, "secret-scope")}
<p class="hint">Choose which roles this secret may use. A token committed to a consumer's repository should be <code>read</code> only.</p>
</fieldset>`
      : "";
  const editing = values.replaces !== "";
  const heading = editing
    ? markup`<p class="notice">Editing the secret <code>${values.replaces}</code>: saving adds a new secret with these values.</p>
<input type="hidden" name="edit_of" value="${values.replaces}">
<label class="inline"><input type="checkbox" name="expire_old"${attr("checked", values.expire_old)}> Expire the old secret <code>${values.replaces}</code> now</label>`
    : "";
  return markup`<details class="add-secret" id="add-secret"${attr("open", open)}>
<summary class="button"><span class="when-closed">${editing ? "Edit the secret" : "Add a secret"}</span><span class="when-open">Close the form</span></summary>
<form class="box form" method="post" aria-label="Add a secret" action="${credentialHref(credential.project)}/secrets" data-secret-form>
${errorMessage(error)}
${heading}
<fieldset class="plain" data-secret-type>
<legend>Type</legend>
${segmented("type", "Type", types, values.type)}
<p class="hint">Key: a generated token, shown once. GitHub Actions: workflows of a repository sign in with their OIDC token, so there is no secret to store. Login: a password, with an optional one-time code, for people who sign in to the panel or from the command line (<code>sreg login</code>).</p>
</fieldset>
${passwordFields("type:login", login)}
<div data-login-fields${attr("hidden", !login)}>
${totpField(values.totp)}
</div>
${descriptionField(values.description)}
${scope}
<div data-gh-fields${attr("hidden", !gh)}>
<label for="repository">Repository</label>
<div class="input-with-button">
<input type="text" id="repository" name="repository" placeholder="owner/repo or owner/*" spellcheck="false" value="${values.repository}">
<button type="button" class="secondary small" data-gh-lookup>Look up</button>
</div>
<p class="hint">Look up fills in the repository and owner ids from GitHub (public repositories). Leave them empty to pin them on first use instead, for example for a private repository.</p>
<p class="error" role="alert" data-lookup-error hidden></p>
<div class="field-pair">
<div><label for="repository_id">Repository ID (optional)</label><input type="text" id="repository_id" name="repository_id" inputmode="numeric" pattern="[0-9]+" spellcheck="false" value="${values.repository_id}"></div>
<div><label for="repository_owner_id">Repository owner ID (optional)</label><input type="text" id="repository_owner_id" name="repository_owner_id" inputmode="numeric" pattern="[0-9]+" spellcheck="false" value="${values.repository_owner_id}"></div>
</div>
<label class="inline"><input type="checkbox" name="pin_on_first_use"${attr("checked", values.pin_on_first_use)}> Pin repository ids on first use</label>
<p class="hint">When the ids are left empty, the first token that matches by name stores the repository id and owner id, and later tokens must match them.</p>
<label for="ref">Ref (optional glob, empty: any)</label>
<input type="text" id="ref" name="ref" placeholder="refs/tags/v*" spellcheck="false" value="${values.ref}">
<label for="workflow">Workflow (optional path in the repository, empty: any)</label>
<input type="text" id="workflow" name="workflow" placeholder=".github/workflows/release.yml" spellcheck="false" value="${values.workflow}">
<label for="environment">Environment (optional, empty: any)</label>
<input type="text" id="environment" name="environment" spellcheck="false" value="${values.environment}">
<p class="hint">For secrets that may <code>publish</code> prefer the ref <code>refs/tags/v*</code> or a workflow, so that only the release workflow can publish.</p>
</div>
<label for="expires">Expires (empty: never)</label>
<input type="date" id="expires" name="expires" value="${values.expires}">
<div class="form-actions"><button type="submit">${editing ? "Save as a new secret" : "Add secret"}</button></div>
</form>
</details>`;
}

/** What the "edit the roles of a secret" form shows (`?tab=secrets&edit=<id>`). */
export interface ScopeEdit {
  id: string;
  scope: Kind[];
  /** A refused save: its message. */
  error?: string;
}

/**
 * The form that changes the roles of an existing secret in place (a key or a login cannot be
 * copied like a GitHub Actions secret): the same unfolded panel as "Add a secret", posted to
 * `…/secrets/<id>`.
 */
function editScopeSection(credential: Credential, edit: ScopeEdit): SafeHtml {
  const href = credentialHref(credential.project);
  return markup`<details class="add-secret" id="add-secret" open>
<summary class="button"><span class="when-closed">Edit the secret</span><span class="when-open">Close the form</span></summary>
<form class="box form" method="post" aria-label="Edit the roles of a secret" action="${href}/secrets/${edit.id}">
${errorMessage(edit.error)}
<p class="notice">Editing the roles of the secret <code>${edit.id}</code>. The secret, its id and its expiry stay; only what it may do changes.</p>
<fieldset class="plain" data-secret-scope>
<legend>This secret may use</legend>
${scopeToggles("Roles of the secret", edit.scope, credential.roles, "edit-scope")}
<p class="hint">A token committed to a consumer's repository should be <code>read</code> only.</p>
</fieldset>
<div class="form-actions"><button type="submit">Save roles</button> <a class="button secondary" href="${href}?tab=secrets">Cancel</a></div>
</form>
</details>`;
}

/** The tabs of a credential page (`?tab=`), in display order; the first is the default. */
export const CREDENTIAL_TABS = ["overview", "grants", "secrets", "danger"] as const;

export type CredentialTab = (typeof CREDENTIAL_TABS)[number];

const TAB_TITLES: Readonly<Record<CredentialTab, string>> = {
  overview: "Overview",
  grants: "Grants",
  secrets: "Secrets",
  danger: "Danger zone",
};

/** The tab named by `?tab=`; the overview for anything else. */
export function credentialTab(value: string | null): CredentialTab {
  return CREDENTIAL_TABS.find((tab) => tab === value) ?? "overview";
}

/** What the page of one credential needs. */
export interface CredentialPageData {
  credential: Credential;
  ecosystems: Eco[];
  now: Date;
  /** The login of its tokens (`TOKEN_PREFIX` + project). */
  login: string;
  /** The tab shown; default `overview`. A refused "add a secret" form shows `secrets`. */
  tab?: CredentialTab;
  /** Open the "add a secret" form (`?tab=secrets&add=1`). */
  addSecret?: boolean;
  /** A refused "add a secret" form: its error and the values to show again. */
  secretError?: string;
  secretValues?: SecretFormValues;
  /** Show the form that edits the roles of this secret instead of "Add a secret". */
  editScope?: ScopeEdit;
}

/** The tab bar under the heading: plain links, the current one marked. */
function tabBar(credential: Credential, current: CredentialTab): SafeHtml {
  const href = credentialHref(credential.project);
  const counts: Partial<Record<CredentialTab, number>> = {
    grants: isAdminOnly(credential)
      ? undefined
      : GRANT_ROLES.reduce((sum, role) => sum + roleGrantsOf(credential, role).length, 0),
    secrets: credential.auth.length,
  };
  const links = CREDENTIAL_TABS.map((tab) => {
    const count = counts[tab];
    const badge = count === undefined ? "" : markup` <span class="tab-count">${count}</span>`;
    return markup`<a href="${href}?tab=${tab}"${tab === current ? markup` aria-current="page"` : ""}>${TAB_TITLES[tab]}${badge}</a>`;
  });
  return markup`<nav class="tabs" aria-label="Credential">${links}</nav>`;
}

/** `GET /admin/credentials/<project>`: the heading, the tab bar and the chosen tab. */
export function credentialPage(ctx: PageContext, data: CredentialPageData): string {
  const { credential, ecosystems, now } = data;
  const { project } = credential;
  const refused = data.secretError !== undefined || data.editScope !== undefined;
  const tab = refused ? "secrets" : (data.tab ?? "overview");
  let body: SafeHtml;
  switch (tab) {
    case "overview":
      body = overview(credential, data.login, now);
      break;
    case "grants":
      body = markup`${grantsSection(credential, ecosystems)}
${isAdminOnly(credential) ? "" : grantTemplate(ecosystems)}`;
      break;
    case "secrets": {
      const values = data.secretValues ?? NO_SECRET_VALUES;
      const open = refused || data.addSecret === true;
      const form =
        data.editScope === undefined
          ? addSecretSection(credential, values, data.secretError, open)
          : editScopeSection(credential, data.editScope);
      body = secretsSection(credential, now, form);
      break;
    }
    case "danger":
      body = dangerZone({
        title: "Delete this credential",
        text: "All its tokens and GitHub Actions secrets stop working at once. The last admin credential cannot be deleted.",
        method: "DELETE",
        url: apiPath("credentials", project),
        name: project,
        button: "Delete credential",
        next: "/admin/credentials",
      });
      break;
  }
  return layout(
    ctx,
    `${project} · ${TAB_TITLES[tab]}`,
    markup`<div class="catalog wide">
${breadcrumbs([{ label: "Credentials", href: "/admin/credentials" }, { label: project }])}
<header class="pkg-header credential-header">
<h1>${project} ${roleBadges(credential.roles)}</h1>
</header>
${tabBar(credential, tab)}
<div class="tab-panel">
${body}
</div>
</div>`,
    {
      page: "credential",
      section: "credentials",
      scripts: tab === "grants" ? [GRANTS_SCRIPT] : [],
    },
  );
}
