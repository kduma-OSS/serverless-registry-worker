/**
 * The package page (`GET /packages/<eco>/<name>`): the ecosystem badge and name, the versions
 * the credential may see (each a link to its version page, with the publication date, the
 * yanked marker and the number of files), the dependencies its grant opens transitively (for
 * an admin those of every version; collapsed, omitted when there are none) and the ready-to-paste configuration for this package
 * with copy buttons (collapsed; alternatives such as two ways to authenticate in a chooser). For an admin the same page also manages the
 * package: "Yank" and "Delete" on every version, "Reindex" in the header and "Delete package"
 * (typing its name) in the danger zone, all `fetch` calls to `/api/v1` made by `public/app.js`.
 */

import type { Snippet } from "../adapters/types";
import { groupPath, isGroupHidden, type PackageGroups } from "../core/groups";
import type { PackageDependency, PackageView } from "../core/packages";
import {
  backLink,
  breadcrumbs,
  day,
  ecoBadge,
  packageHref,
  placeholderNote,
  plural,
  snippetList,
  versionHref,
} from "./catalog";
import { apiButton, apiPath, dangerZone } from "./admin";
import { markup, type SafeHtml } from "./html";
import { groupListHref, packageGroupSwitcher } from "./groups";
import { homeHref, layout, type PageContext } from "./layout";

/** What the package page shows from the manifest of the highest visible version. */
export interface PackageDetails {
  /** Generic: the first label of the highest visible version's files, for the sreg example. */
  label?: { key: string; value: string };
}

/** What the package page shows. */
export interface PackagePageData extends PackageDetails {
  /** The package with the versions the credential may see, highest first. */
  view: PackageView;
  /** `adapter.clientConfig` for this package, with placeholders instead of the token. */
  snippets: Snippet[];
  /** The package is visible only through the dependencies of another package's grant. */
  transitive?: boolean;
  /** Show the admin actions. */
  admin?: boolean;
  /**
   * The package groups, the package's key in them and the group it is in: the breadcrumb shows
   * the groups above the package, and an admin can move the package.
   */
  groups?: { state: PackageGroups; key: string; current: string | null };
}

type Version = PackageView["versions"][number];

/**
 * The "Actions" cell of one version: "Yank" and "Delete", right-aligned. A yanked version has
 * an invisible placeholder where "Yank" would be, so the dates and "Delete" of every row line
 * up. Deleting the last version opens the package list.
 */
function versionActions(view: PackageView, v: Version): SafeHtml {
  const url = apiPath("packages", view.eco, view.name, v.version);
  const label = `${view.name} ${v.version}`;
  const yank = v.yanked
    ? markup`<span class="button secondary small action-placeholder" aria-hidden="true">Yank</span>`
    : apiButton(
        "Yank",
        "POST",
        `${url}/yank`,
        { message: `Yank ${label}? It disappears from the indexes; lockfiles keep working.` },
        { ariaLabel: `Yank ${label}` },
      );
  const last = view.versions.length === 1 ? { next: "/admin/packages" } : {};
  const remove = apiButton(
    "Delete",
    "DELETE",
    url,
    { message: `Delete ${label} and its files? Lockfiles that use it stop working.` },
    { style: "danger small", ariaLabel: `Delete ${label}`, ...last },
  );
  return markup`\n<span class="row-actions version-actions" role="group" aria-label="Actions">${yank}${remove}</span>`;
}

function versionList(view: PackageView, admin: boolean): SafeHtml {
  const items = view.versions.map(
    (v) => markup`<li class="version-row">
<a class="version" href="${versionHref(view.eco, view.name, v.version)}">${v.version}</a>
${v.yanked ? markup`<span class="badge warn">yanked</span>` : ""}
<span class="version-meta"><time datetime="${v.published}">${day(v.published)}</time> · ${plural(v.files.length, "file")}</span>${admin ? versionActions(view, v) : ""}
</li>`,
  );
  return markup`<section class="pkg-section" aria-labelledby="versions">
<h2 id="versions">Versions</h2>
<ul class="version-list">
${items}
</ul>
</section>`;
}

/** The collapsed dependencies of a package; nothing when it has none in this registry. */
function dependencies(view: PackageView): SafeHtml {
  const deps: readonly PackageDependency[] = view.dependencies ?? [];
  if (deps.length === 0) return markup``;
  const items = deps.map(
    (d) => markup`<li>
<a href="${packageHref(view.eco, d.name)}">${d.name}</a>
<span class="dep-meta">${d.constraints.join(", ")} → ${d.versions.join(", ")}</span>
</li>`,
  );
  return markup`<details class="dependencies">
<summary>Dependencies (${deps.length})</summary>
<ul class="dep-list">
${items}
</ul>
</details>`;
}

/** A shell word: as it is when it only has safe characters, single-quoted otherwise. */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9._\-/:=+@,%]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `sreg generic get` example built from a label the package really has; nothing for other
 * ecosystems or a package whose highest version has no labelled file (the adapter's snippet
 * with placeholders is then the example).
 */
export function exampleSnippet(data: PackagePageData): Snippet[] {
  const { view, label } = data;
  if (view.eco !== "generic" || label === undefined) return [];
  const filter = shellWord(`${label.key}=${label.value}`);
  return [
    {
      title: "Example for this package",
      description: `Download the files of the latest version labelled ${label.key}=${label.value}.`,
      filename: "terminal",
      language: "shell",
      body: `sreg generic get ${shellWord(view.name)} latest --label ${filter} --out ./downloads\n`,
    },
  ];
}

/** The client configuration, collapsed; nothing without snippets. */
function configuration(snippets: readonly Snippet[]): SafeHtml {
  if (snippets.length === 0) return markup``;
  return markup`<details class="collapsible" id="configuration">
<summary>Configuration and installation</summary>
${placeholderNote(snippets)}
${snippetList(snippets, "config")}
</details>`;
}

/** "Delete package" in the danger zone of an admin's package page. */
function deletePackage(view: PackageView): SafeHtml {
  return dangerZone({
    title: "Delete this package",
    text: "Deletes every version with its files and the package's indexes. Lockfiles that use it stop working.",
    method: "DELETE",
    url: apiPath("packages", view.eco, view.name),
    name: view.name,
    button: "Delete package",
    next: "/admin/packages",
  });
}

/**
 * The groups above the package, from the top down, as breadcrumbs linking to them in the
 * list. Whoever is not an admin does not see a hidden group (the lists leave it out), so
 * nothing of its path is shown to them.
 */
export function groupCrumbs(
  groups: { state: PackageGroups; current: string | null } | undefined,
  admin: boolean,
  home: string,
): { label: string; href: string }[] {
  if (groups === undefined || groups.current === null) return [];
  const { state, current } = groups;
  if (!admin && isGroupHidden(state, current)) return [];
  return groupPath(state, current).map((g) => ({
    label: g.name,
    href: admin ? groupListHref(state, g.id) : `${home}#group-${g.id}`,
  }));
}

/** The package page. */
export function packagePage(ctx: PageContext, data: PackagePageData): string {
  const { view } = data;
  const admin = data.admin === true;
  const home = homeHref(ctx);
  const reindex = admin
    ? markup`<div class="pkg-header-actions">${apiButton(
        "Reindex",
        "POST",
        `${apiPath("packages", view.eco, view.name)}/reindex`,
        { message: `Rebuild the index of ${view.name} from its manifests?` },
      )}</div>`
    : "";
  const top = view.versions[0];
  const latest =
    top === undefined
      ? ""
      : markup` · latest <span class="version">${top.version}</span>${top.yanked ? markup` <span class="badge warn">yanked</span>` : ""}`;
  const group =
    admin && data.groups !== undefined
      ? packageGroupSwitcher(data.groups.state, data.groups.key, data.groups.current)
      : "";
  const via = data.transitive
    ? markup`<p class="hint">Available as a dependency of a package granted to this credential.</p>`
    : "";
  return layout(
    ctx,
    view.name,
    markup`<div class="catalog">
${breadcrumbs([
  { label: "Packages", href: home },
  ...groupCrumbs(data.groups, admin, home),
  { label: view.name },
])}
<header class="pkg-header">
${ecoBadge(view.eco)}
<h1>${view.name}</h1>
<p class="pkg-meta">${plural(view.versions.length, "version")}${latest}</p>
${via}
${group}
${reindex}
</header>
${versionList(view, admin)}
${dependencies(view)}
${configuration(data.snippets.length === 0 ? [] : [...data.snippets, ...exampleSnippet(data)])}
${admin ? deletePackage(view) : ""}
${backLink(home, "All packages")}
</div>`,
    { page: "package", section: "packages" },
  );
}
