/**
 * Building blocks of the admin pages (kind `admin`) and the admin package list
 * (`GET /admin/packages`). Every mutation of the admin pages is a `fetch` to `/api/v1` made by
 * `public/app.js` from the `data-api-*` attributes rendered here, followed by a reload (or by
 * `data-api-next`, the page to go to afterwards); only the forms that create a secret post to
 * the panel, which answers with the one-time token page (`src/pages/token.ts`).
 */

import type { AuthEntry, Credential } from "../core/auth";
import type { PackageSummary } from "../core/packages";
import { markup, type SafeHtml } from "./html";
import { packageList } from "./consumer";
import { layout, type PageContext } from "./layout";

/** An `/api/v1` path with every segment percent-encoded (docs/api.md 1.3). */
export function apiPath(...segments: string[]): string {
  return `/api/v1/${segments.map(encodeURIComponent).join("/")}`;
}

/**
 * The panel page of a credential. The project `new` would be taken for the create form
 * (`/admin/credentials/new`), so its first letter is percent-encoded: the router compares the
 * raw segment with literal ones and decodes parameters, so `%6Eew` reaches the credential.
 */
export function credentialHref(project: string): string {
  const segment = project === "new" ? "%6Eew" : encodeURIComponent(project);
  return `/admin/credentials/${segment}`;
}

/** How an API button or form is confirmed before `app.js` sends it. */
export interface Confirmation {
  /** The question of the browser's confirmation dialog. */
  message: string;
  /** A name the user must type (`prompt`) instead of confirming. */
  typeName?: string;
}

/**
 * A button that `app.js` turns into an API call, after a confirmation. `next` is the page to
 * open afterwards (default: reload the current one).
 */
export function apiButton(
  label: string,
  method: string,
  url: string,
  confirm: Confirmation,
  options: { style?: string; next?: string; ariaLabel?: string } = {},
): SafeHtml {
  const typed =
    confirm.typeName === undefined ? "" : markup` data-confirm-name="${confirm.typeName}"`;
  const next = options.next === undefined ? "" : markup` data-api-next="${options.next}"`;
  const aria = options.ariaLabel === undefined ? "" : markup` aria-label="${options.ariaLabel}"`;
  return markup`<button type="button" class="${options.style ?? "secondary small"}" data-api-method="${method}" data-api-url="${url}" data-confirm="${confirm.message}"${typed}${next}${aria}>${label}</button>`;
}

/**
 * The "danger zone" of a page: a form that deletes something after its name is typed. The
 * button stays disabled until `app.js` sees the name typed exactly; afterwards it opens `next`.
 */
export function dangerZone(options: {
  title: string;
  text: SafeHtml | string;
  method: string;
  url: string;
  name: string;
  button: string;
  next: string;
}): SafeHtml {
  const { title, text, method, url, name, button, next } = options;
  return markup`<section class="section danger-zone" aria-labelledby="danger-zone">
<h2 id="danger-zone">Danger zone</h2>
<form class="box danger-box" data-api-form="delete" data-api-method="${method}" data-api-url="${url}" data-confirm-name="${name}" data-api-next="${next}">
<h3>${title}</h3>
<p>${text}</p>
<label for="confirm-name">Type <code>${name}</code> to confirm</label>
<div class="input-with-button">
<input type="text" id="confirm-name" data-confirm-input autocomplete="off" spellcheck="false">
<button type="submit" class="danger" disabled>${button}</button>
</div>
<p class="error" role="alert" data-form-error hidden></p>
</form>
</section>`;
}

/** Whether an auth entry is still active at `now`. */
export function isActiveAt(entry: Pick<AuthEntry, "expires">, now: Date): boolean {
  if (entry.expires === null) return true;
  const expires = Date.parse(entry.expires);
  return !Number.isNaN(expires) && expires > now.getTime();
}

/** The number of active auth entries and the nearest `expires` among them (`null` = never). */
export function secretSummary(
  credential: Pick<Credential, "auth">,
  now: Date,
): { active: number; nearestExpiry: string | null } {
  const active = credential.auth.filter((e) => isActiveAt(e, now));
  const expiries = active
    .map((e) => e.expires)
    .filter((e): e is string => e !== null)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return { active: active.length, nearestExpiry: expiries[0] ?? null };
}

/**
 * Whether a `gh` entry still waits for its first token to pin the repository and owner ids:
 * `pin_on_first_use` is set and neither id is stored yet.
 */
export function awaitsPin(entry: AuthEntry): boolean {
  if (entry.type !== "gh") return false;
  const pin = "pin_on_first_use" in entry && entry.pin_on_first_use === true;
  return pin && !entry.repository_id && !entry.repository_owner_id;
}

// ---------------------------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------------------------

/** The admin package list of an empty registry. */
export const NO_PACKAGES_PUBLISHED = "No packages have been published yet.";

/** "Reindex" and "Delete" at the end of a row of the admin package list. */
function packageActions(view: PackageSummary): SafeHtml {
  const url = apiPath("packages", view.eco, view.name);
  const reindex = apiButton("Reindex", "POST", `${url}/reindex`, {
    message: `Rebuild the index of ${view.name} from its manifests?`,
  });
  const remove = apiButton(
    "Delete",
    "DELETE",
    url,
    {
      message: `Type ${view.name} to delete the package with all its versions.`,
      typeName: view.name,
    },
    { style: "danger small", ariaLabel: `Delete the package ${view.name}` },
  );
  return markup`${reindex} ${remove}`;
}

/** `GET /admin/packages`: every package in one sorted list, each row with its actions. */
export function adminPackagesPage(ctx: PageContext, packages: readonly PackageSummary[]): string {
  const content =
    packages.length === 0
      ? markup`<div class="pkg-empty"><p>${NO_PACKAGES_PUBLISHED}</p></div>`
      : packageList(packages, "Open a package to yank or delete its versions.", packageActions);
  return layout(
    ctx,
    "Packages",
    markup`<div class="catalog wide">
<h1>Packages</h1>
${content}
</div>`,
    { page: "packages", section: "packages" },
  );
}
