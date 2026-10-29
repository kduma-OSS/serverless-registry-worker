/**
 * The consumer view (kind `read`): every package of the credential's explicit grants in one
 * list sorted by name, each row a link to its package page (`src/pages/package.ts`) with the
 * ecosystem badge, the number of versions and the latest version (marked when yanked). A
 * filter bar (name and ecosystem) is rendered hidden and enabled by `public/app.js`, which
 * only hides rows and, while a filter is active, says how many rows are shown in the lead line;
 * without JavaScript the full list stays usable. The admin package list (`src/pages/admin.ts`)
 * is the same list with actions at the end of each row. With package groups
 * (`src/core/groups.ts`) the list is split into collapsible sections, "Ungrouped" first, and the
 * filter bar gets a chip per group; the admin's "organize" mode adds a checkbox to every row.
 */

import type { Eco } from "../adapters/types";
import {
  childrenOf,
  groupOf,
  isPackageHidden,
  packageGroupKey,
  type Group,
  type PackageGroups,
} from "../core/groups";
import type { PackageSummary } from "../core/packages";
import { sortPackages } from "../core/sort";
import { ECO_NAMES, ecoBadge, packageHref, plural } from "./catalog";
import { markup, type SafeHtml } from "./html";
import { layout, type PageContext } from "./layout";

// The admin view imports these from here.
export { day, ECO_NAMES } from "./catalog";

/** The message shown when the credential has no package. */
export const NO_PACKAGES = "No packages are granted to this credential yet.";

export { sortPackages };

function latest(view: PackageSummary): SafeHtml {
  const top = view.versions[0];
  if (top === undefined) return markup``;
  const yanked = top.yanked ? markup` <span class="badge warn">yanked</span>` : "";
  return markup`<span class="pkg-latest">latest <span class="version">${top.version}</span>${yanked}</span>`;
}

/** Actions shown at the end of a package's row (the admin list). */
export type RowActions = (view: PackageSummary) => SafeHtml;

function row(
  view: PackageSummary,
  actions?: RowActions,
  groups: readonly string[] = [],
  select = false,
): SafeHtml {
  const link = markup`<a class="pkg-link" href="${packageHref(view.eco, view.name)}">
${ecoBadge(view.eco)}
<span class="pkg-name">${view.name}</span>
<span class="pkg-meta"><span>${plural(view.versions.length, "version")}</span>${latest(view)}</span>
</a>`;
  const end =
    actions === undefined ? "" : markup`\n<div class="pkg-actions">${actions(view)}</div>`;
  const start = select
    ? markup`<label class="pkg-select"><input type="checkbox" name="package" value="${packageGroupKey(view.eco, view.name)}" data-select-row aria-label="Select ${view.name}"></label>\n`
    : "";
  const boxed = actions !== undefined || select;
  const where = groups.length === 0 ? "" : markup` data-groups="${groups.join(" ")}"`;
  return markup`<li class="pkg-row${boxed ? " with-actions" : ""}${select ? " with-select" : ""}" data-pkg-row data-eco="${view.eco}" data-name="${view.name.toLowerCase()}"${where}>
${start}${link}${end}
</li>`;
}

/** An ecosystem present in the list and how many of the packages are in it. */
interface EcoCount {
  eco: Eco;
  count: number;
}

/**
 * The ecosystems present with their package counts, sorted by display name (ignoring case). A
 * plain comparison: `localeCompare` with a locale builds an `Intl.Collator` on every call,
 * which costs milliseconds of CPU in a Worker and the CPU time of a request is limited.
 */
function ecosystemsOf(packages: readonly PackageSummary[]): EcoCount[] {
  const counts = new Map<Eco, number>();
  for (const p of packages) counts.set(p.eco, (counts.get(p.eco) ?? 0) + 1);
  const label = (eco: Eco) => ECO_NAMES[eco].toLowerCase();
  return [...counts.entries()]
    .map(([eco, count]) => ({ eco, count }))
    .sort((a, b) => {
      const x = label(a.eco);
      const y = label(b.eco);
      return x < y ? -1 : x > y ? 1 : 0;
    });
}

/** An entry of a filter selector: a value to narrow the list to, how it reads and how many match. */
interface FilterChoice {
  value: string;
  label: string;
  count: number;
  /** The level of a group: 1 at the top (indents the entry); 1 for everything else. */
  depth: number;
}

/**
 * A selector that takes several choices at once: a button that opens a panel of checkboxes
 * (`<details>`), with the choices made shown on the button. `public/app.js` filters by the
 * checked values and keeps the button's text; none checked means everything.
 */
function multiFilter(kind: string, label: string, choices: readonly FilterChoice[]): SafeHtml {
  return markup`<div class="pkg-multi">
<span class="multi-caption" id="multi-${kind}-caption">${label}</span>
<details class="multi" data-filter-multi="${kind}">
<summary aria-labelledby="multi-${kind}-caption multi-${kind}-value"><span class="multi-value" id="multi-${kind}-value" data-multi-value>All</span></summary>
<div class="multi-panel" role="group" aria-labelledby="multi-${kind}-caption">
${choices.map((c) => markup`<label class="multi-option depth-${c.depth}"><input type="checkbox" value="${c.value}" data-multi-option data-label="${c.label}"><span class="multi-name">${c.label}</span><span class="multi-count">${c.count}</span></label>`)}
<button type="button" class="link multi-clear" data-multi-clear>Clear</button>
</details>
</div>`;
}

/**
 * The filter bar (with two or more packages): a labelled name filter and, with two or more
 * choices, a multiple-choice selector of the groups and one of the ecosystems. Hidden until
 * `public/app.js` enables it.
 */
function filterBar(
  total: number,
  ecosystems: readonly EcoCount[],
  groupChoices: readonly FilterChoice[] = [],
): SafeHtml {
  if (total < 2) return markup``;
  const ecos: FilterChoice[] = ecosystems.map(({ eco, count }) => ({
    value: eco,
    label: ECO_NAMES[eco],
    count,
    depth: 1,
  }));
  const ecosystemFilter = ecos.length < 2 ? "" : multiFilter("eco", "Ecosystem", ecos);
  const groups = groupChoices.length < 2 ? "" : multiFilter("group", "Group", groupChoices);
  return markup`<div class="pkg-filter" data-pkg-filter hidden>
<div class="pkg-search">
<label for="pkg-filter-name">Filter by name</label>
<input type="search" id="pkg-filter-name" data-filter-name autocomplete="off" spellcheck="false">
</div>
${groups}
${ecosystemFilter}
</div>`;
}

/** The id of the pseudo group "Ungrouped" in `data-groups` and in the group selector. */
export const UNGROUPED = "_";

/** A group with the packages in it and its subgroups, for rendering. */
interface GroupNode {
  group: Group;
  /** The ids from the top group down to this one. */
  chain: string[];
  /** The packages directly in the group, sorted. */
  packages: PackageSummary[];
  children: GroupNode[];
  /** The packages in the group and below. */
  total: number;
}

/** What a group's own visibility changes in its section. */
function isCollapsed(node: GroupNode): boolean {
  return node.group.visibility === "collapsed";
}

/** The packages split by group; `null` when the list should not be grouped. */
interface Grouped {
  ungrouped: PackageSummary[];
  roots: GroupNode[];
}

function grouped(
  state: PackageGroups | undefined,
  sorted: readonly PackageSummary[],
  keepEmpty: boolean,
  showHidden: boolean,
): Grouped | null {
  if (state === undefined || state.groups.length === 0) return null;
  const direct = new Map<string, PackageSummary[]>();
  const ungrouped: PackageSummary[] = [];
  for (const view of sorted) {
    const id = groupOf(state, view.eco, view.name);
    if (id === null) {
      ungrouped.push(view);
      continue;
    }
    const list = direct.get(id) ?? [];
    list.push(view);
    direct.set(id, list);
  }
  const build = (parent: string | null, above: string[]): GroupNode[] =>
    childrenOf(state, parent).flatMap((group) => {
      // A hidden group is left out with everything in it (its packages were left out of the list).
      if (group.visibility === "hidden" && !showHidden) return [];
      const chain = [...above, group.id];
      const children = build(group.id, chain);
      const packages = direct.get(group.id) ?? [];
      const total = packages.length + children.reduce((sum, c) => sum + c.total, 0);
      return total === 0 && !keepEmpty ? [] : [{ group, chain, packages, children, total }];
    });
  const roots = build(null, []);
  if (!keepEmpty && roots.length === 0) return null;
  return { ungrouped, roots };
}

/** The entries of the group selector: "Ungrouped", then every group with packages in tree order. */
function groupChoicesOf(split: Grouped): FilterChoice[] {
  const choices: FilterChoice[] = [];
  if (split.ungrouped.length > 0) {
    choices.push({ value: UNGROUPED, label: "Ungrouped", count: split.ungrouped.length, depth: 1 });
  }
  const walk = (nodes: readonly GroupNode[]): void => {
    for (const node of nodes) {
      if (node.total > 0) {
        choices.push({
          value: node.group.id,
          label:
            node.group.visibility === "hidden" ? `${node.group.name} (hidden)` : node.group.name,
          count: node.total,
          depth: node.chain.length,
        });
      }
      walk(node.children);
    }
  };
  walk(split.roots);
  return choices;
}

/** `<details>` of one group: its name and number of packages, its rows, then its subgroups. */
function groupSection(
  node: GroupNode,
  rowOf: (view: PackageSummary, chain: string[]) => SafeHtml,
): SafeHtml {
  const rows =
    node.packages.length === 0
      ? ""
      : markup`<ul class="pkg-list">
${node.packages.map((view) => rowOf(view, node.chain))}
</ul>`;
  const nested: SafeHtml | "" =
    node.children.length === 0
      ? ""
      : markup`<div class="pkg-subgroups">
${node.children.map((child) => groupSection(child, rowOf))}
</div>`;
  const empty =
    node.total === 0
      ? markup`<p class="pkg-group-empty hint">No packages in this group yet.</p>`
      : "";
  const flag =
    node.group.visibility === "hidden"
      ? markup` <span class="badge pkg-group-flag">hidden</span>`
      : "";
  return markup`<details class="pkg-group" id="group-${node.group.id}"${isCollapsed(node) ? "" : " open"} data-group-section>
<summary><span class="pkg-group-name">${node.group.name}</span> <span class="pkg-group-count">${node.total}</span>${flag}</summary>
${rows}${nested}${empty}
</details>`;
}

/** Organize mode of the admin list: the form around the list and its toolbar. */
export interface Organize {
  /** Where the form posts. */
  action: string;
  /** The controls that act on the checked rows (inside the form, after the list). */
  toolbar: SafeHtml;
}

/** What {@link packageList} can add to the plain list. */
export interface ListOptions {
  /** Split the list by these groups. */
  groups?: PackageGroups;
  /** Keep groups without packages (the admin sees them to fill them). */
  keepEmptyGroups?: boolean;
  /** Show the hidden groups (and the packages in them) too; the admin asks for it. */
  showHidden?: boolean;
  /** A checkbox on every row and a form around the list; the row `actions` are left out. */
  organize?: Organize;
}

/**
 * The sorted, filterable package list after a lead line (`N packages in M ecosystems.` and
 * `hint`), with `actions` at the end of each row when given.
 */
export function packageList(
  packages: readonly PackageSummary[],
  hint: string,
  actions?: RowActions,
  options: ListOptions = {},
): SafeHtml {
  const { groups: state } = options;
  const showHidden = options.showHidden === true;
  const sorted = sortPackages(
    state === undefined || showHidden
      ? packages
      : packages.filter((p) => !isPackageHidden(state, p.eco, p.name)),
  );
  if (sorted.length === 0 && packages.length > 0) {
    return markup`<div class="pkg-empty"><p>There is nothing to show: the packages are in hidden groups.</p></div>`;
  }
  const ecosystems = ecosystemsOf(sorted);
  const ecos = ecosystems.length;
  const lead = `${plural(sorted.length, "package")}${ecos > 1 ? ` in ${ecos} ecosystems` : ""}. ${hint}`;
  const { organize } = options;
  const rowActions = organize === undefined ? actions : undefined;
  const select = organize !== undefined;
  const split = grouped(state, sorted, options.keepEmptyGroups === true, showHidden);
  let list: SafeHtml;
  let choices: FilterChoice[] = [];
  if (split === null || options.groups === undefined) {
    list = markup`<ul class="pkg-list" data-pkg-list>
${sorted.map((view) => row(view, rowActions, [], select))}
</ul>`;
  } else {
    choices = groupChoicesOf(split);
    const rowOf = (view: PackageSummary, chain: string[]) => row(view, rowActions, chain, select);
    const ungrouped =
      split.ungrouped.length === 0
        ? ""
        : markup`<details class="pkg-group pkg-ungrouped" open data-group-section>
<summary><span class="pkg-group-name">Ungrouped</span> <span class="pkg-group-count">${split.ungrouped.length}</span></summary>
<ul class="pkg-list">
${split.ungrouped.map((view) => row(view, rowActions, [UNGROUPED], select))}
</ul>
</details>`;
    list = markup`<div class="pkg-grouped" data-pkg-list>
${ungrouped}
${split.roots.map((node) => groupSection(node, rowOf))}
</div>`;
  }
  const body = markup`${list}
<p class="pkg-none-match" data-pkg-empty role="status" hidden>No packages match the filter.</p>`;
  const content =
    organize === undefined
      ? body
      : markup`<form method="post" action="${organize.action}" class="organize" data-organize>
${body}
${organize.toolbar}
</form>`;
  return markup`<p class="consumer-lead" data-pkg-lead aria-live="polite">${lead}</p>
${filterBar(sorted.length, ecosystems, choices)}
${content}`;
}

/** The consumer view. */
export function consumerPage(
  ctx: PageContext,
  packages: readonly PackageSummary[],
  groups?: PackageGroups,
): string {
  const content =
    packages.length === 0
      ? markup`<div class="pkg-empty">
<p>${NO_PACKAGES}</p>
<p class="hint">Ask an administrator for access.</p>
</div>`
      : packageList(
          packages,
          "Open a package for its versions and the configuration to install it.",
          undefined,
          groups === undefined ? {} : { groups },
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

/**
 * The home of a `yank` or `delete` credential without `read`: the packages its grants cover,
 * each linking to the package page where its versions can be yanked or deleted.
 */
export function managePage(ctx: PageContext, packages: readonly PackageSummary[]): string {
  const content =
    packages.length === 0
      ? markup`<div class="pkg-empty">
<p>${NO_PACKAGES}</p>
<p class="hint">Ask an administrator for access.</p>
</div>`
      : packageList(packages, "Open a package to yank or delete its versions.");
  return layout(
    ctx,
    "Packages",
    markup`<div class="catalog">
<h1>Packages you can manage</h1>
${content}
</div>`,
    { page: "packages" },
  );
}
