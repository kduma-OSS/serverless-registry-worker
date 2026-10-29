/**
 * The message for the person a new secret is for, shown on the one-time pages that reveal it
 * (`src/pages/token.ts`): the server, the login, the token or the password and one-time code, what
 * the secret may do and how to use it, ready to send. The message is made once, as a list of
 * {@link Block}s, and written three ways: a preview for the page (with classes), the same with
 * inline styles for pasting into a mail client (Outlook ignores a page's style sheet) and plain
 * text. `public/handover.js` copies them, draws the QR code as an image and builds the PDF from
 * the blocks (jsPDF from cdnjs, loaded only when the PDF is asked for).
 */

import type { Adapter, Eco, Snippet } from "../adapters/types";
import { KINDS, type GrantRole, type Kind } from "../core/auth";
import { isTransitive, type Grant } from "../core/grants";
import { encodeQr } from "../core/qr";
import { ECO_NAMES, day } from "./catalog";
import { markup, SafeHtml, type HtmlValue } from "./html";

/** One part of the message. */
export type Block =
  | { t: "title"; text: string }
  | { t: "h"; text: string }
  | { t: "p"; text: string }
  /** A remark, set apart. */
  | { t: "note"; text: string }
  | { t: "kv"; rows: { label: string; value: string; mono?: boolean }[] }
  | { t: "list"; items: string[] }
  | { t: "code"; title?: string; text: string }
  /** A QR code: the rows of its modules as strings of `1` (dark) and `0`. */
  | { t: "qr"; rows: string[]; caption: string };

/** What the message is made from. */
export interface HandoverInput {
  /** The registry's address, e.g. `https://packages.example.com`. */
  server: string;
  /** The login: the project, with the installation's token prefix. */
  login: string;
  secret:
    | { kind: "key"; token: string }
    | { kind: "login"; password: string; totp?: { secret: string; otpauthUri: string } };
  /** The roles the secret may use. */
  roles: readonly Kind[];
  grants: Record<GrantRole, readonly Grant[]>;
  /** When the secret stops working, `null` for never. */
  expires: string | null;
  /** The adapter of an ecosystem that is enabled, for its client configuration. */
  adapterOf(eco: Eco): Pick<Adapter, "clientConfig"> | null;
}

const ROLE_ORDER: readonly Kind[] = KINDS;

/** What a grant lets, in words. */
function describeGrant(grant: Grant): string {
  const { package: name, versions } = grant;
  let what: string;
  if (name === "*") what = "every package";
  else if (name.endsWith("*")) what = `every package whose name starts with ${name.slice(0, -1)}`;
  else what = name;
  const which = versions === "*" ? "all versions" : `versions ${versions}`;
  return `${ECO_NAMES[grant.eco]}: ${what} (${which})`;
}

/** The names a grant list spells out, per ecosystem (patterns left out). */
function exactNames(grants: readonly Grant[], eco: Eco): string[] {
  return [
    ...new Set(
      grants.filter((g) => g.eco === eco && !g.package.includes("*")).map((g) => g.package),
    ),
  ];
}

/** The ecosystems of a grant list, in the order they first appear. */
function ecosystemsOf(grants: readonly Grant[]): Eco[] {
  return [...new Set(grants.map((g) => g.eco))];
}

/** The first alternative of each group of snippets, and the snippets that stand alone. */
function firstAlternatives(snippets: readonly Snippet[]): Snippet[] {
  const first = new Map<string, string | undefined>();
  return snippets.filter((s) => {
    if (s.group === undefined) return true;
    if (!first.has(s.group)) first.set(s.group, s.variant);
    return s.variant === first.get(s.group);
  });
}

/** The message as blocks. */
export function handoverBlocks(input: HandoverInput): Block[] {
  const { server, login, secret, grants } = input;
  const roles = ROLE_ORDER.filter((r) => input.roles.includes(r));
  const host = server.replace(/^https?:\/\//, "");
  const blocks: Block[] = [
    { t: "title", text: `Access to the package registry ${host}` },
    { t: "p", text: `You have been given access to the private package registry at ${server}.` },
    { t: "h", text: "Your details" },
  ];

  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: "Server", value: server, mono: true },
    { label: "Login", value: login, mono: true },
  ];
  if (secret.kind === "key") rows.push({ label: "Token", value: secret.token, mono: true });
  else rows.push({ label: "Password", value: secret.password, mono: true });
  rows.push({
    label: "Valid until",
    value: input.expires === null ? "no expiry" : day(input.expires),
  });
  blocks.push({ t: "kv", rows });

  if (secret.kind === "login" && secret.totp !== undefined) {
    const { otpauthUri, secret: key } = secret.totp;
    blocks.push(
      { t: "h", text: "One-time code" },
      {
        t: "p",
        text: "Signing in also needs a code from an authenticator app (for example Microsoft Authenticator, Google Authenticator or 1Password). Add this login to the app with the QR code, the key or the link below.",
      },
    );
    const matrix = encodeQr(otpauthUri);
    if (matrix !== null) {
      blocks.push({
        t: "qr",
        rows: matrix.map((line) => line.map((dark) => (dark ? "1" : "0")).join("")),
        caption: "Scan with the authenticator app",
      });
    }
    blocks.push({
      t: "kv",
      rows: [
        { label: "Key", value: key, mono: true },
        { label: "Link", value: otpauthUri, mono: true },
      ],
    });
  }

  for (const role of roles) {
    if (role === "read") {
      blocks.push({ t: "h", text: "Read access" });
      if (grants.read.length === 0) {
        blocks.push({ t: "p", text: "No packages are granted to this login yet." });
      } else {
        blocks.push(
          { t: "p", text: "You can install these packages from the registry:" },
          { t: "list", items: grants.read.map(describeGrant) },
        );
        if (grants.read.some(isTransitive)) {
          blocks.push({
            t: "note",
            text: "The packages they depend on in this registry are available too.",
          });
        }
      }
    } else if (role === "publish") {
      blocks.push({ t: "h", text: "Publish access" });
      if (grants.publish.length === 0) {
        blocks.push({ t: "p", text: "No packages are granted to this login for publishing yet." });
      } else {
        blocks.push(
          {
            t: "p",
            text: "You can publish new versions of these packages with the sreg command-line tool, for example from CI:",
          },
          { t: "list", items: grants.publish.map(describeGrant) },
        );
      }
    } else if (role === "yank" || role === "delete") {
      const verb = role === "yank" ? "yank" : "permanently delete";
      blocks.push({ t: "h", text: `${role === "yank" ? "Yank" : "Delete"} access` });
      if (grants[role].length === 0) {
        blocks.push({ t: "p", text: `No packages are granted to this login for ${role} yet.` });
      } else {
        blocks.push(
          {
            t: "p",
            text: `You can ${verb} versions of these packages with the sreg command-line tool:`,
          },
          { t: "list", items: grants[role].map(describeGrant) },
        );
      }
    } else {
      blocks.push(
        { t: "h", text: "Administrator access" },
        {
          t: "p",
          text: `You can manage the registry in the panel at ${server}: packages, credentials and settings.`,
        },
      );
    }
  }

  blocks.push(...howToUse(input, roles));
  return blocks;
}

/** How to use the secret, by what it is and what it may do. */
function howToUse(input: HandoverInput, roles: readonly Kind[]): Block[] {
  const { server, secret, grants } = input;
  const out: Block[] = [];
  const sreg =
    "sreg is the command-line tool of the registry: https://github.com/kduma-OSS/serverless-registry-cli";
  if (secret.kind === "login") {
    out.push(
      { t: "h", text: "Signing in" },
      {
        t: "p",
        text: `Open ${server} and sign in with the login and the password${secret.totp === undefined ? "" : " and a code from the authenticator app"}.`,
      },
    );
    if (roles.includes("read")) {
      out.push(
        {
          t: "p",
          text: "To use the registry from the command line, install sreg and sign in through the browser; it prints a short-lived token:",
        },
        { t: "code", text: `sreg login --registry ${server}` },
      );
    }
    if (roles.includes("publish")) {
      const ecos = ecosystemsOf(grants.publish).slice(0, 1);
      out.push({
        t: "code",
        title: "Publish, signing in through the browser",
        text: `sreg ${ecos[0] ?? "composer"} publish --login --registry ${server}`,
      });
    }
    for (const role of ["yank", "delete"] as const) {
      if (!roles.includes(role)) continue;
      out.push({
        t: "code",
        title: `${role === "yank" ? "Yank" : "Delete"}, signing in through the browser`,
        text: `sreg ${role} <ecosystem> <package> <version> --login --registry ${server}`,
      });
    }
    if (roles.some((role) => role !== "admin")) out.push({ t: "note", text: sreg });
    return out;
  }

  if (roles.includes("read")) {
    for (const eco of ecosystemsOf(grants.read)) {
      const adapter = input.adapterOf(eco);
      if (adapter === null) continue;
      out.push({ t: "h", text: `Using ${ECO_NAMES[eco]} packages` });
      for (const snippet of firstAlternatives(
        adapter.clientConfig(server, secret.token, exactNames(grants.read, eco)),
      )) {
        if (snippet.description !== undefined) out.push({ t: "p", text: snippet.description });
        out.push({ t: "code", title: snippet.title, text: snippet.body.replace(/\n+$/, "") });
      }
    }
  }
  if (roles.includes("publish")) {
    const ecos = ecosystemsOf(grants.publish);
    out.push(
      { t: "h", text: "Publishing" },
      {
        t: "p",
        text: "Give sreg the address and the token, then publish from the project directory:",
      },
      {
        t: "code",
        text:
          `export REGISTRY_URL=${server}\nexport REGISTRY_TOKEN=${secret.token}\n` +
          (ecos.length === 0
            ? "sreg composer publish"
            : ecos.map((e) => `sreg ${e} publish`).join("\n")),
      },
      { t: "note", text: sreg },
    );
  }
  for (const role of ["yank", "delete"] as const) {
    if (!roles.includes(role)) continue;
    out.push(
      { t: "h", text: role === "yank" ? "Yanking versions" : "Deleting versions" },
      {
        t: "p",
        text: `Give sreg the address and the token, then ${role} a version of a package you were granted:`,
      },
      {
        t: "code",
        text: `export REGISTRY_URL=${server}\nexport REGISTRY_TOKEN=${secret.token}\nsreg ${role} <ecosystem> <package> <version>`,
      },
      { t: "note", text: sreg },
    );
  }
  if (roles.includes("admin") && !roles.includes("read") && !roles.includes("publish")) {
    out.push(
      { t: "h", text: "Using the token" },
      {
        t: "p",
        text: "With sreg the token manages packages (yank, delete, reindex) when it is set as REGISTRY_TOKEN:",
      },
      {
        t: "code",
        text: `export REGISTRY_URL=${server}\nexport REGISTRY_TOKEN=${secret.token}\nsreg whoami`,
      },
      { t: "note", text: sreg },
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Renderings
// ---------------------------------------------------------------------------------------------

/** The message as plain text. */
export function handoverText(blocks: readonly Block[]): string {
  const out: string[] = [];
  const gap = () => {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
  };
  for (const block of blocks) {
    switch (block.t) {
      case "title":
        out.push(block.text, "=".repeat(Math.min(block.text.length, 72)), "");
        break;
      case "h":
        gap();
        out.push(block.text, "-".repeat(Math.min(block.text.length, 72)));
        break;
      case "p":
        out.push(block.text, "");
        break;
      case "note":
        out.push(`Note: ${block.text}`, "");
        break;
      case "kv": {
        const width = Math.max(...block.rows.map((r) => r.label.length)) + 1;
        for (const row of block.rows) out.push(`${`${row.label}:`.padEnd(width + 1)}${row.value}`);
        out.push("");
        break;
      }
      case "list":
        for (const item of block.items) out.push(`- ${item}`);
        out.push("");
        break;
      case "code":
        if (block.title !== undefined) out.push(`${block.title}:`);
        for (const line of block.text.split("\n")) out.push(`    ${line}`);
        out.push("");
        break;
      case "qr":
        out.push(`[QR code: ${block.caption.toLowerCase()}]`, "");
        break;
    }
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return `${out.join("\n")}\n`;
}

/** The message for the page, styled by the style sheet. */
export function handoverPreview(blocks: readonly Block[]): SafeHtml {
  const parts: SafeHtml[] = blocks.map((block): SafeHtml => {
    switch (block.t) {
      case "title":
        return markup`<h3 class="handover-title">${block.text}</h3>`;
      case "h":
        return markup`<h4>${block.text}</h4>`;
      case "p":
        return markup`<p>${block.text}</p>`;
      case "note":
        return markup`<p class="handover-note">${block.text}</p>`;
      case "kv":
        return markup`<dl class="handover-kv">${block.rows.map((r) => markup`<div><dt>${r.label}</dt><dd${r.mono ? new SafeHtml(' class="mono"') : ""}>${r.value}</dd></div>`)}</dl>`;
      case "list":
        return markup`<ul>${block.items.map((i) => markup`<li>${i}</li>`)}</ul>`;
      case "code":
        return markup`<div class="handover-code">${block.title === undefined ? "" : markup`<div class="handover-code-title">${block.title}</div>`}<pre><code>${block.text}</code></pre></div>`;
      case "qr":
        return markup`<figure class="handover-qr"><canvas width="1" height="1" data-handover-qr="${block.rows.join(",")}" role="img" aria-label="${block.caption}"></canvas><figcaption>${block.caption}</figcaption></figure>`;
    }
  });
  return markup`${parts}`;
}

const EMAIL_FONT = "font-family:'Segoe UI',Calibri,Arial,sans-serif;";
const EMAIL_MONO = "font-family:Consolas,'Courier New',monospace;";

/** Escapes text for HTML, including quotes. */
function esc(value: string): string {
  return markup`${value}`.value;
}

/** The marker of the QR code's image, replaced by a PNG data URL when the message is copied. */
export const QR_IMAGE_MARKER = "%%QR%%";

/**
 * The message for a mail client: the same parts with the styling inline, because a pasted
 * message keeps its own styles and drops the page's. The QR code is an `<img>` whose source is
 * {@link QR_IMAGE_MARKER}: the browser makes the PNG (mail clients show no SVG).
 */
export function handoverEmail(blocks: readonly Block[]): string {
  const body = blocks
    .map((block): string => {
      switch (block.t) {
        case "title":
          return `<h2 style="${EMAIL_FONT}font-size:20px;margin:0 0 12px;color:#111">${esc(block.text)}</h2>`;
        case "h":
          return `<h3 style="${EMAIL_FONT}font-size:15px;margin:18px 0 6px;color:#111">${esc(block.text)}</h3>`;
        case "p":
          return `<p style="${EMAIL_FONT}font-size:14px;margin:0 0 8px;color:#222">${esc(block.text)}</p>`;
        case "note":
          return `<p style="${EMAIL_FONT}font-size:13px;margin:0 0 8px;color:#555;font-style:italic">${esc(block.text)}</p>`;
        case "kv":
          return `<table style="border-collapse:collapse;margin:0 0 8px">${block.rows
            .map(
              (r) =>
                `<tr><td style="${EMAIL_FONT}font-size:14px;padding:3px 14px 3px 0;color:#555;vertical-align:top;white-space:nowrap">${esc(r.label)}</td><td style="${r.mono ? EMAIL_MONO : EMAIL_FONT}font-size:${r.mono ? 13 : 14}px;padding:3px 0;color:#111;word-break:break-all">${esc(r.value)}</td></tr>`,
            )
            .join("")}</table>`;
        case "list":
          return `<ul style="${EMAIL_FONT}font-size:14px;margin:0 0 8px;padding-left:22px;color:#222">${block.items
            .map((i) => `<li style="margin:2px 0">${esc(i)}</li>`)
            .join("")}</ul>`;
        case "code":
          return `${block.title === undefined ? "" : `<p style="${EMAIL_FONT}font-size:13px;margin:8px 0 2px;color:#555">${esc(block.title)}</p>`}<pre style="${EMAIL_MONO}font-size:13px;background:#f3f4f6;border:1px solid #d9dce1;padding:8px 10px;margin:0 0 8px;white-space:pre-wrap;word-break:break-all;color:#111">${esc(block.text)}</pre>`;
        case "qr":
          return `<p style="margin:6px 0 10px"><img src="${QR_IMAGE_MARKER}" alt="${esc(block.caption)}" width="180" height="180" style="display:block;border:1px solid #d9dce1"><span style="${EMAIL_FONT}font-size:12px;color:#555">${esc(block.caption)}</span></p>`;
      }
    })
    .join("\n");
  return `<div style="${EMAIL_FONT}color:#222">\n${body}\n</div>`;
}

/** JSON for a `<script type="application/json">`: nothing in it can end the script or the page. */
function scriptJson(value: unknown): SafeHtml {
  const text = JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return new SafeHtml(text);
}

/** A file name for the PDF: `registry-access-<login>.pdf`, the login reduced to safe characters. */
export function handoverFilename(login: string): string {
  return `registry-access-${login.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "user"}.pdf`;
}

/**
 * The message section of a one-time page: the preview, the buttons (shown by
 * `public/handover.js`) and the data the script copies and builds the PDF from.
 */
export function handoverSection(input: HandoverInput): SafeHtml {
  const blocks = handoverBlocks(input);
  const parts: HtmlValue[] = [
    markup`<section class="handover" data-handover aria-labelledby="handover-heading">
<h2 id="handover-heading">Message for the user</h2>
<p class="hint">Ready to send. Copy it into a mail (the formatting and the QR code come along), or download it as a PDF. It holds the secret, so send it the way you would send the secret.</p>
<div class="handover-actions" data-handover-actions hidden>
<button type="button" data-handover-copy>Copy message</button>
<button type="button" class="secondary" data-handover-copy-text>Copy as plain text</button>
<button type="button" class="secondary" data-handover-pdf>Download PDF</button>
<span class="handover-status" data-handover-status role="status"></span>
</div>
<article class="handover-message" data-handover-preview>
${handoverPreview(blocks)}
</article>
<textarea hidden readonly data-handover-html>${handoverEmail(blocks)}</textarea>
<textarea hidden readonly data-handover-text>${handoverText(blocks)}</textarea>
<script type="application/json" data-handover-blocks>${scriptJson({ filename: handoverFilename(input.login), blocks })}</script>
</section>`,
  ];
  return markup`${parts}`;
}
