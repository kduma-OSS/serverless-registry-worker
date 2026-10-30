/**
 * The version page (`GET /packages/<eco>/<name>/<version>`): the files of one version with
 * their size, role and labels, checksums (`sha256` and any extra `digests`), a download link
 * through the panel (`…/files/<file>`, a redirect to a presigned URL), for generic packages the
 * version's `meta` as a key/value table and, collapsed, how to get exactly this version: the
 * adapter's pinned install snippets.
 */

import type { Eco, ManifestFile, Snippet } from "../adapters/types";
import {
  backLink,
  breadcrumbs,
  day,
  ecoBadge,
  fileHref,
  metadataSection,
  packageHref,
  plural,
  snippetList,
} from "./catalog";
import { apiButton, apiPath } from "./admin";
import { formatBytes } from "./components";
import type { PackageGroups } from "../core/groups";
import { markup, type SafeHtml } from "./html";
import { homeHref, layout, type PageContext } from "./layout";
import { groupCrumbs } from "./package";

/** One file of the version page. */
export interface VersionFile extends ManifestFile {
  /** Extra digests computed at commit (docs/api.md 6.5), lower-case hex by algorithm. */
  digests?: Record<string, string>;
  /**
   * The native download URL (`adapter.fileUrl`); `null` when the adapter serves this file
   * through no native endpoint (NuGet symbols), absent when the ecosystem has none at all.
   */
  nativeUrl?: string | null;
}

/** What the version page shows. */
export interface VersionPageData {
  eco: Eco;
  name: string;
  version: string;
  published: string;
  yanked: boolean;
  /** The deprecation warning, absent for a version that is not deprecated. */
  deprecated?: { message: string; at: string; by: string };
  files: VersionFile[];
  /** Generic: the version's free-form `meta` (the manifest's `native`). */
  meta?: Record<string, unknown>;
  /** `adapter.versionSnippets` for this version: how to get exactly it. */
  snippets?: Snippet[];
  /** The package groups and the group the package is in: the breadcrumb shows its path. */
  groups?: { state: PackageGroups; current: string | null };
}

/** `1234567` → `1,234,567`. */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function labels(file: VersionFile): SafeHtml {
  const role = file.role === undefined ? "" : markup`<span class="badge">${file.role}</span>`;
  const pairs = Object.entries(file.labels ?? {}).map(
    ([key, value]) => markup`<span class="badge">${key}: ${value}</span>`,
  );
  if (role === "" && pairs.length === 0) return markup``;
  return markup`<span class="file-labels">${role}${pairs}</span>`;
}

function checksums(file: VersionFile): SafeHtml {
  const all: [string, string][] = [["sha256", file.sha256], ...Object.entries(file.digests ?? {})];
  return markup`<dl class="checksums">${all.map(
    ([algorithm, hex]) => markup`<div><dt>${algorithm}</dt><dd><code>${hex}</code></dd></div>`,
  )}</dl>`;
}

function fileRow(data: VersionPageData, file: VersionFile): SafeHtml {
  return markup`<tr>
<td data-label="File"><span class="file-name">${file.name}</span>${labels(file)}</td>
<td data-label="Size"><span title="${groupDigits(file.size)} bytes">${formatBytes(file.size)}</span></td>
<td data-label="Checksums">${checksums(file)}</td>
<td data-label="Download"><a class="button small" href="${fileHref(data.eco, data.name, data.version, file.name)}">Download</a></td>
</tr>`;
}

/** The collapsed "Get exactly this version"; nothing without snippets. */
function getThisVersion(data: VersionPageData): SafeHtml {
  const snippets = data.snippets ?? [];
  if (snippets.length === 0) return markup``;
  return markup`<details class="collapsible" id="get-version">
<summary>Get exactly this version</summary>
${snippetList(snippets, "pin")}
</details>`;
}

/** The admin's form to deprecate a version, or to remove its deprecation. */
function deprecationForm(data: VersionPageData): SafeHtml {
  const url = `${apiPath("packages", data.eco, data.name, data.version)}/deprecate`;
  const label = `${data.name} ${data.version}`;
  const clear =
    data.deprecated === undefined
      ? ""
      : apiButton(
          "Remove deprecation",
          "DELETE",
          url,
          { message: `Remove the deprecation of ${label}?` },
          { ariaLabel: `Remove the deprecation of ${label}` },
        );
  return markup`<section class="pkg-section" aria-labelledby="deprecation">
<h2 id="deprecation">Deprecation</h2>
<p class="hint">A deprecated version stays installable; clients that support it show the message.</p>
<form class="inline-form" data-api-form="deprecate" data-api-method="POST" data-api-url="${url}">
<label for="deprecate-message">Message</label>
<input type="text" id="deprecate-message" name="message" maxlength="1000" required value="${data.deprecated?.message ?? ""}">
<button type="submit" class="secondary small">${data.deprecated === undefined ? "Deprecate" : "Update message"}</button>
<p class="error" role="alert" data-form-error hidden></p>
</form>
${clear}
</section>`;
}

/** The version page. */
export function versionPage(ctx: PageContext, data: VersionPageData): string {
  const pkg = packageHref(data.eco, data.name);
  const admin = ctx.user?.roles.includes("admin") === true;
  const yanked = data.yanked
    ? markup`<p class="hint"><span class="badge warn">yanked</span> This version is no longer offered to dependency resolution; existing lockfiles can still download it.</p>`
    : "";
  const deprecated =
    data.deprecated === undefined
      ? ""
      : markup`<p class="hint"><span class="badge warn">deprecated</span> ${data.deprecated.message}</p>`;
  const manage = admin ? deprecationForm(data) : "";
  return layout(
    ctx,
    `${data.name} ${data.version}`,
    markup`<div class="catalog">
${breadcrumbs([
  { label: "Packages", href: homeHref(ctx) },
  ...groupCrumbs(data.groups, admin, homeHref(ctx)),
  { label: data.name, href: pkg },
  { label: data.version },
])}
<header class="pkg-header">
${ecoBadge(data.eco)}
<h1>${data.name} <span class="version">${data.version}</span></h1>
<p class="pkg-meta">Published <time datetime="${data.published}">${day(data.published)}</time> · ${plural(data.files.length, "file")}</p>
${yanked}
${deprecated}
</header>
<section class="pkg-section" aria-labelledby="files">
<h2 id="files">Files</h2>
<div class="files-wrap"><table class="files">
<thead><tr><th>File</th><th>Size</th><th>Checksums</th><th><span class="visually-hidden">Download</span></th></tr></thead>
<tbody>
${data.files.map((file) => fileRow(data, file))}
</tbody>
</table></div>
</section>
${metadataSection(data.meta)}
${getThisVersion(data)}
${manage}
${backLink(pkg, data.name)}
</div>`,
    { page: "version", section: "packages" },
  );
}
