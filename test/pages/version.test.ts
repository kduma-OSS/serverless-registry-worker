import { describe, expect, it } from "vitest";
import { assignPackages, createGroup } from "../../src/core/groups";
import { versionPage, type VersionPageData } from "../../src/pages/version";

const ctx = {
  host: "packages.example.com",
  version: "1.0.0",
  user: { project: "shop", roles: ["read"] as const },
};
const SHA = "ab".repeat(32);

const data: VersionPageData = {
  eco: "composer",
  name: "acme/sdk",
  version: "1.2.0",
  published: "2026-10-28T10:12:00Z",
  yanked: false,
  files: [
    {
      name: "acme-sdk-1.2.0.zip",
      size: 1536,
      sha256: SHA,
      nativeUrl: "https://packages.example.com/composer/dist/acme/sdk/1.2.0.zip",
    },
  ],
};

describe("versionPage", () => {
  it("shows breadcrumbs, the badge, the name, the version and the date", () => {
    const page = versionPage(ctx, data);
    expect(page).toContain("<title>acme/sdk 1.2.0 · packages.example.com</title>");
    expect(page).toContain(
      '<ol><li><a href="/">Packages</a></li><li><a href="/packages/composer/acme%2Fsdk">acme/sdk</a></li><li aria-current="page">1.2.0</li></ol>',
    );
    expect(page).toContain('<span class="eco-badge" data-eco="composer">Composer</span>');
    expect(page).toContain('<h1>acme/sdk <span class="version">1.2.0</span></h1>');
    expect(page).toContain(
      'Published <time datetime="2026-10-28T10:12:00Z">2026-10-28</time> · 1 file',
    );
    expect(page).toContain(
      '<p class="back"><a href="/packages/composer/acme%2Fsdk">← acme/sdk</a></p>',
    );
    expect(page).not.toContain("yanked");
  });

  it("lists the files with size, sha256 and a download link", () => {
    const page = versionPage(ctx, data);
    expect(page).toContain('<table class="files">');
    expect(page).toContain('<span class="file-name">acme-sdk-1.2.0.zip</span>');
    expect(page).toContain('<span title="1,536 bytes">1.5 KiB</span>');
    expect(page).toContain(`<dt>sha256</dt><dd><code>${SHA}</code></dd>`);
    expect(page).not.toContain("Native URL");
    expect(page).toContain(
      '<a class="button small" href="/packages/composer/acme%2Fsdk/1.2.0/files/acme-sdk-1.2.0.zip">Download</a>',
    );
    expect(page).not.toContain("file-labels");
  });

  it("shows roles, labels and extra digests, and leaves out a missing native URL", () => {
    const page = versionPage(ctx, {
      ...data,
      eco: "generic",
      name: "tools",
      yanked: true,
      files: [
        {
          name: "tool linux.tar.gz",
          size: 3 * 1024 * 1024,
          sha256: SHA,
          role: "binary",
          labels: { os: "linux", arch: "x64" },
          digests: { sha512: "cd".repeat(64) },
        },
        { name: "README.md", size: 12, sha256: SHA },
      ],
    });
    expect(page).toContain(
      '<span class="file-labels"><span class="badge">binary</span><span class="badge">os: linux</span><span class="badge">arch: x64</span></span>',
    );
    expect(page).toContain(`<dt>sha512</dt><dd><code>${"cd".repeat(64)}</code></dd>`);
    expect(page).toContain('<span title="3,145,728 bytes">3.0 MiB</span>');
    expect(page).toContain('href="/packages/generic/tools/1.2.0/files/tool%20linux.tar.gz"');
    expect(page).not.toContain("Native URL");
    expect(page).toContain("2 files");
    expect(page).toContain('<span class="badge warn">yanked</span> This version');
  });

  it("collapses how to get exactly this version, with its snippets only", () => {
    const page = versionPage(ctx, {
      ...data,
      snippets: [
        {
          title: "Require this version",
          description: "Require exactly this version.",
          filename: "terminal",
          language: "shell",
          body: "composer require acme/sdk:1.2.0\n",
        },
      ],
    });
    expect(page).toContain(
      '<details class="collapsible" id="get-version">\n<summary>Get exactly this version</summary>',
    );
    expect(page).not.toContain("<details open");
    expect(page).toContain('<p class="snippet-desc">Require exactly this version.</p>');
    expect(page).toContain("<pre><code>composer require acme/sdk:1.2.0\n</code></pre>");
    expect(page).not.toContain("Addresses used by the client");
    expect(page).not.toContain("packages.example.com/composer/dist");
    expect(page.indexOf("Files</h2>")).toBeLessThan(page.indexOf("Get exactly this version"));
  });

  it("shows alternatives of the version snippets in a chooser", () => {
    const snippet = { filename: "f", language: "x", group: "Build tool", description: "D." };
    const page = versionPage(ctx, {
      ...data,
      snippets: [
        { ...snippet, title: "pom.xml", variant: "Maven", body: "<dependency/>" },
        { ...snippet, title: "build.gradle.kts", variant: "Gradle", body: "implementation()" },
      ],
    });
    expect(page).toContain('<fieldset class="chooser" data-chooser="Build tool">');
    expect(page).toContain('name="pin-1" id="pin-1-1" value="Maven" checked>');
    expect(page).toContain('<label for="pin-1-2">Gradle</label>');
  });

  it("leaves out the section without snippets, even when files have native URLs", () => {
    const page = versionPage(ctx, data);
    expect(data.files[0]?.nativeUrl).toBeDefined();
    expect(page).not.toContain("Get exactly this version");
    expect(page).not.toContain("Addresses used by the client");
  });

  it("shows a generic version's meta, and nothing when it is empty", () => {
    const generic = { ...data, eco: "generic" as const, name: "tools" };
    const page = versionPage(ctx, { ...generic, meta: { channel: "stable", tags: ["a", "b"] } });
    expect(page).toContain('<h2 id="metadata">Metadata</h2>');
    expect(page).toContain('<tr><th scope="row">channel</th><td>stable</td></tr>');
    expect(page).toContain(
      '<th scope="row">tags</th><td><code class="meta-json">[\n  &quot;a&quot;,\n  &quot;b&quot;\n]</code>',
    );
    expect(page.indexOf("Files</h2>")).toBeLessThan(page.indexOf("Metadata</h2>"));
    expect(versionPage(ctx, { ...generic, meta: {} })).not.toContain("Metadata");
    expect(versionPage(ctx, data)).not.toContain("Metadata");
  });

  it("escapes file data", () => {
    const page = versionPage(ctx, {
      ...data,
      files: [{ name: "<x>.zip", size: 1, sha256: SHA, labels: { "<k>": "<v>" } }],
    });
    expect(page).toContain('<span class="file-name">&lt;x&gt;.zip</span>');
    expect(page).toContain("&lt;k&gt;: &lt;v&gt;");
    expect(page).not.toContain("<x>");
  });
});

describe("the breadcrumb of a version page and its groups", () => {
  let state = createGroup({ groups: [], packages: {} }, "Kit", null, "aaaa");
  state = createGroup(state, "Server", "aaaa", "bbbb");
  state = createGroup(state, "Vault", null, "cccc", "hidden");
  const crumbs = (page: string): string => {
    const start = page.indexOf('<nav class="crumbs"');
    return page.slice(start, page.indexOf("</nav>", start));
  };

  it("shows the groups between Packages and the package", () => {
    const grouped = assignPackages(state, ["composer:acme/sdk"], "bbbb");
    const page = versionPage(ctx, { ...data, groups: { state: grouped, current: "bbbb" } });
    const trail = crumbs(page);
    expect(trail).toContain('<a href="/#group-aaaa">Kit</a>');
    expect(trail).toContain('<a href="/#group-bbbb">Server</a>');
    expect(trail.indexOf("Kit")).toBeLessThan(trail.indexOf("Server"));
    expect(trail.indexOf("Server")).toBeLessThan(trail.indexOf("acme/sdk"));
    expect(trail).toContain('<li aria-current="page">1.2.0</li>');
  });

  it("leaves out a hidden group's path for a reader, shows it to an admin", () => {
    const hidden = { state, current: "cccc" };
    expect(crumbs(versionPage(ctx, { ...data, groups: hidden }))).not.toContain("Vault");
    const admin = { ...ctx, user: { project: "root", roles: ["admin" as const] } };
    expect(crumbs(versionPage(admin, { ...data, groups: hidden }))).toContain(
      '<a href="/admin/packages?hidden=1#group-cccc">Vault</a>',
    );
  });

  it("is unchanged without groups", () => {
    expect(crumbs(versionPage(ctx, data))).not.toContain("group-");
  });
});
