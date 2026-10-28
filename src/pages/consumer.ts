/**
 * The consumer view (kind `read`): every package of the credential's explicit grants in one
 * list sorted by name, each row a link to its package page (`src/pages/package.ts`) with the
 * ecosystem badge, the number of versions and the latest version (marked when yanked). A
 * filter bar (name and ecosystem) is rendered hidden and enabled by `public/app.js`, which
 * only hides rows and, while a filter is active, says how many rows are shown in the lead line;
 * without JavaScript the full list stays usable. The admin package list (`src/pages/admin.ts`)
 * is the same list with actions at the end of each row.
 */

import type { Eco } from "../adapters/types";
import type { PackageSummary, PackageView } from "../core/packages";
import { ECO_NAMES, ecoBadge, packageHref, plural } from "./catalog";
import { markup, type SafeHtml } from "./html";
import { layout, type PageContext } from "./layout";

// The admin view imports these from here.
export { day, ECO_NAMES } from "./catalog";

/** The message shown when the credential has no package. */
export const NO_PACKAGES = "No packages are granted to this credential yet.";

function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sorted by name, ignoring case; the same name in two ecosystems by ecosystem, names that
 * differ only in case in byte order.
 */
export function sortPackages<T extends PackageSummary>(packages: readonly T[]): T[] {
  return [...packages].sort(
    (a, b) =>
      byteOrder(a.name.toLowerCase(), b.name.toLowerCase()) ||
      byteOrder(a.eco, b.eco) ||
      byteOrder(a.name, b.name),
  );
}

function latest(view: PackageSummary): SafeHtml {
  const top = view.versions[0];
  if (top === undefined) return markup``;
  const yanked = top.yanked ? markup` <span class="badge warn">yanked</span>` : "";
  return markup`<span class="pkg-latest">latest <span class="version">${top.version}</span>${yanked}</span>`;
}

/** Actions shown at the end of a package's row (the admin list). */
export type RowActions = (view: PackageSummary) => SafeHtml;

function row(view: PackageSummary, actions?: RowActions): SafeHtml {
  const link = markup`<a class="pkg-link" href="${packageHref(view.eco, view.name)}">
${ecoBadge(view.eco)}
<span class="pkg-name">${view.name}</span>
<span class="pkg-meta"><span>${plural(view.versions.length, "version")}</span>${latest(view)}</span>
</a>`;
  const end =
    actions === undefined ? "" : markup`\n<div class="pkg-actions">${actions(view)}</div>`;
  return markup`<li class="pkg-row${actions === undefined ? "" : " with-actions"}" data-pkg-row data-eco="${view.eco}" data-name="${view.name.toLowerCase()}">
${link}${end}
</li>`;
}

/** The ecosystems present, sorted by display name. */
function ecosystemsOf(packages: readonly PackageSummary[]): Eco[] {
  return [...new Set(packages.map((p) => p.eco))].sort((a, b) =>
    ECO_NAMES[a].localeCompare(ECO_NAMES[b], "en"),
  );
}

/**
 * The filter bar (with two or more packages): a labelled name filter and, with two or more
 * ecosystems, a toggle chip per ecosystem. Hidden until `public/app.js` enables it.
 */
function filterBar(packages: readonly PackageSummary[]): SafeHtml {
  if (packages.length < 2) return markup``;
  const ecos = ecosystemsOf(packages);
  const chips =
    ecos.length < 2
      ? ""
      : markup`<div class="pkg-chips" role="group" aria-label="Ecosystems">
${ecos.map((eco) => markup`<button type="button" class="chip" data-filter-eco="${eco}" aria-pressed="false">${ECO_NAMES[eco]}</button>`)}
</div>`;
  return markup`<div class="pkg-filter" data-pkg-filter hidden>
<div class="pkg-search">
<label for="pkg-filter-name">Filter by name</label>
<input type="search" id="pkg-filter-name" data-filter-name autocomplete="off" spellcheck="false">
</div>
${chips}
</div>`;
}

/**
 * The sorted, filterable package list after a lead line (`N packages in M ecosystems.` and
 * `hint`), with `actions` at the end of each row when given.
 */
export function packageList(
  packages: readonly PackageSummary[],
  hint: string,
  actions?: RowActions,
): SafeHtml {
  const sorted = sortPackages(packages);
  const ecos = ecosystemsOf(sorted).length;
  const lead = `${plural(sorted.length, "package")}${ecos > 1 ? ` in ${ecos} ecosystems` : ""}. ${hint}`;
  return markup`<p class="consumer-lead" data-pkg-lead aria-live="polite">${lead}</p>
${filterBar(sorted)}
<ul class="pkg-list" data-pkg-list>
${sorted.map((view) => row(view, actions))}
</ul>
<p class="pkg-none-match" data-pkg-empty role="status" hidden>No packages match the filter.</p>`;
}

/** The consumer view. */
export function consumerPage(ctx: PageContext, packages: readonly PackageView[]): string {
  const content =
    packages.length === 0
      ? markup`<div class="pkg-empty">
<p>${NO_PACKAGES}</p>
<p class="hint">Ask an administrator for access.</p>
</div>`
      : packageList(
          packages,
          "Open a package for its versions and the configuration to install it.",
        );
  return layout(
    ctx,
    "Packages",
    markup`<div class="catalog">
<h1>Your packages</h1>
${content}
</div>`,
    { page: "packages" },
  );
}
