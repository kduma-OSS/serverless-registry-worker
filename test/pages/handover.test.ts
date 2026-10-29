import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../../src/adapters/index";
import { ECOS } from "../../src/adapters/types";
import type { Grant } from "../../src/core/grants";
import {
  QR_IMAGE_MARKER,
  handoverBlocks,
  handoverEmail,
  handoverFilename,
  handoverPreview,
  handoverSection,
  handoverText,
  type Block,
  type HandoverInput,
} from "../../src/pages/handover";
import { loginSecretPage, tokenPage } from "../../src/pages/token";
import { markup } from "../../src/pages/html";

const ctx = { host: "packages.example.com", version: "1.0.0" };
const TOKEN = "acme-ci:eD2L9YeaKIyInTvWeqTgckOQlENnRryl";
const TOTP = {
  secret: "ZP4RIMDEA34BBSFRKRKSE2R5TK2PKU3N",
  otpauthUri:
    "otpauth://totp/packages.example.com:acme-ci?secret=ZP4RIMDEA34BBSFRKRKSE2R5TK2PKU3N&issuer=packages.example.com",
};

const read: Grant[] = [
  { eco: "composer", package: "acme/*", versions: "*", transitive: true },
  { eco: "npm", package: "@acme/ui", versions: "^1.2", transitive: false },
];
const publish: Grant[] = [{ eco: "composer", package: "acme/sdk", versions: "*" }];

function input(overrides: Partial<HandoverInput> = {}): HandoverInput {
  return {
    server: "https://packages.example.com",
    login: "acme-ci",
    secret: { kind: "key", token: TOKEN },
    roles: ["read"],
    grants: { read, publish },
    expires: null,
    adapterOf: (eco) => ADAPTERS[eco],
    ...overrides,
  };
}

const headings = (blocks: readonly Block[]) => blocks.flatMap((b) => (b.t === "h" ? [b.text] : []));
const text = (overrides?: Partial<HandoverInput>) => handoverText(handoverBlocks(input(overrides)));

describe("the message for a key secret", () => {
  it("gives the server, the login and the token, and says when it stops working", () => {
    const blocks = handoverBlocks(input({ expires: "2027-01-31T00:00:00Z" }));
    expect(blocks[0]).toEqual({
      t: "title",
      text: "Access to the package registry packages.example.com",
    });
    const details = blocks.find((b) => b.t === "kv");
    expect(details).toEqual({
      t: "kv",
      rows: [
        { label: "Server", value: "https://packages.example.com", mono: true },
        { label: "Login", value: "acme-ci", mono: true },
        { label: "Token", value: TOKEN, mono: true },
        { label: "Valid until", value: "2027-01-31" },
      ],
    });
    expect(text()).toContain("Valid until: no expiry");
  });

  it("explains read access with what the grants let and the setup of each ecosystem", () => {
    const message = text();
    expect(headings(handoverBlocks(input()))).toEqual([
      "Your details",
      "Read access",
      "Using Composer packages",
      "Using npm packages",
    ]);
    expect(message).toContain(
      "- Composer: every package whose name starts with acme/ (all versions)",
    );
    expect(message).toContain("- npm: @acme/ui (versions ^1.2)");
    expect(message).toContain("The packages they depend on in this registry are available too.");
    // The ready configuration holds the real token and the server.
    expect(message).toContain("https://packages.example.com/composer");
    expect(message).toContain("eD2L9YeaKIyInTvWeqTgckOQlENnRryl");
    expect(message).toContain("npm config set @acme:registry https://packages.example.com/npm/");
    expect(message).not.toContain("Publish access");
    expect(message).not.toContain("REGISTRY_TOKEN");
  });

  it("leaves out the note about dependencies when no grant opens them", () => {
    const message = text({ grants: { read: [read[1] as Grant], publish: [] } });
    expect(message).not.toContain("depend on");
  });

  it("says when nothing is granted yet", () => {
    expect(text({ grants: { read: [], publish: [] } })).toContain(
      "No packages are granted to this login yet.",
    );
  });

  it("explains publish access and how to publish with sreg", () => {
    const blocks = handoverBlocks(input({ roles: ["publish"] }));
    expect(headings(blocks)).toEqual(["Your details", "Publish access", "Publishing"]);
    const message = handoverText(blocks);
    expect(message).toContain("- Composer: acme/sdk (all versions)");
    expect(message).toContain("export REGISTRY_URL=https://packages.example.com");
    expect(message).toContain(`export REGISTRY_TOKEN=${TOKEN}`);
    expect(message).toContain("sreg composer publish");
    expect(message).toContain("https://github.com/kduma-OSS/serverless-registry-cli");
    // A publish-only secret gets no installation setup.
    expect(message).not.toContain("Using Composer packages");
  });

  it("explains a secret that reads and publishes, in the order read, publish", () => {
    const blocks = handoverBlocks(input({ roles: ["publish", "read"] }));
    const found = headings(blocks);
    expect(found.indexOf("Read access")).toBeLessThan(found.indexOf("Publish access"));
    expect(found).toContain("Publishing");
    expect(found).toContain("Using Composer packages");
  });

  it("explains administrator access", () => {
    const message = text({ roles: ["admin"] });
    expect(message).toContain("Administrator access");
    expect(message).toContain(
      "You can manage the registry in the panel at https://packages.example.com",
    );
    expect(message).toContain("sreg whoami");
    expect(message).not.toContain("Read access");
  });

  it("only mentions the roles the secret may use", () => {
    const blocks = handoverBlocks(input({ roles: ["read"], grants: { read, publish } }));
    expect(handoverText(blocks)).not.toContain("acme/sdk");
  });
});

describe("the message for a login secret", () => {
  const login = input({
    secret: { kind: "login", password: "pLerTMralIqix15DgJP8BJxD", totp: TOTP },
    roles: ["read", "publish"],
  });

  it("gives the password, the one-time code (QR code, key and link) and how to sign in", () => {
    const blocks = handoverBlocks(login);
    const message = handoverText(blocks);
    expect(message).toMatch(/Password:\s+pLerTMralIqix15DgJP8BJxD/);
    expect(message).not.toContain("Token:");
    expect(message).toContain(TOTP.secret);
    expect(message).toContain(TOTP.otpauthUri);
    expect(message).toContain("authenticator app");
    expect(message).toContain("sreg login --registry https://packages.example.com");
    expect(message).toContain(
      "sreg composer publish --login --registry https://packages.example.com",
    );
    const qr = blocks.find((b): b is Extract<Block, { t: "qr" }> => b.t === "qr");
    expect(qr).toBeDefined();
    // A square of 1s and 0s: a QR code of a version that holds the link.
    expect(qr?.rows.length).toBeGreaterThan(20);
    expect(qr?.rows.every((r) => r.length === qr.rows.length && /^[01]+$/.test(r))).toBe(true);
    // The setup of the ecosystems needs a token, which a login has none of.
    expect(message).not.toContain("Using Composer packages");
  });

  it("has no one-time code section without TOTP", () => {
    const blocks = handoverBlocks(
      input({ secret: { kind: "login", password: "pw" }, roles: ["read"] }),
    );
    expect(headings(blocks)).not.toContain("One-time code");
    expect(blocks.some((b) => b.t === "qr")).toBe(false);
    expect(handoverText(blocks)).toContain("sign in with the login and the password.");
  });
});

describe("every ecosystem", () => {
  it("has a configuration in the message of a read key", () => {
    const grants: Grant[] = ECOS.map((eco) => ({
      eco,
      package: eco === "maven" ? "org.acme:lib" : "acme-pkg",
      versions: "*",
    }));
    const blocks = handoverBlocks(input({ grants: { read: grants, publish: [] } }));
    const found = headings(blocks).filter((h) => h.startsWith("Using "));
    expect(found).toHaveLength(ECOS.length);
    for (const block of blocks) if (block.t === "code") expect(block.text.trim()).not.toBe("");
  });

  it("skips an ecosystem that is not enabled", () => {
    const message = text({ adapterOf: (eco) => (eco === "npm" ? ADAPTERS.npm : null) });
    expect(message).not.toContain("Using Composer packages");
    expect(message).toContain("Using npm packages");
  });
});

describe("the renderings", () => {
  const blocks = handoverBlocks(
    input({
      secret: { kind: "login", password: "pw<&>", totp: TOTP },
      roles: ["read"],
      grants: { read: [{ eco: "npm", package: "@acme/<b>", versions: "*" }], publish: [] },
    }),
  );

  it("write plain text with the title underlined, lists and indented code", () => {
    const plain = handoverText(handoverBlocks(input({ roles: ["read", "publish"] })));
    expect(plain.startsWith("Access to the package registry packages.example.com\n=====")).toBe(
      true,
    );
    expect(plain).toContain("\nYour details\n------------\n");
    expect(plain).toContain("\n    export REGISTRY_URL=https://packages.example.com\n");
    expect(plain.endsWith("\n")).toBe(true);
    expect(plain).not.toContain("\n\n\n");
    expect(handoverText(blocks)).toContain("[QR code: scan with the authenticator app]");
  });

  it("write a preview with classes and no inline style, escaping everything", () => {
    const html = handoverPreview(blocks).value;
    expect(html).toContain('<h3 class="handover-title">');
    expect(html).toContain("pw&lt;&amp;&gt;");
    expect(html).toContain("@acme/&lt;b&gt;");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("style=");
    expect(html).toMatch(/<canvas width="1" height="1" data-handover-qr="[01,]+" role="img"/);
  });

  it("write a mail version with the style inline and the QR image to be filled in", () => {
    const html = handoverEmail(blocks);
    expect(html).toContain('style="');
    expect(html).toContain("font-family:'Segoe UI',Calibri,Arial,sans-serif");
    expect(html).toContain(`<img src="${QR_IMAGE_MARKER}"`);
    expect(html).toContain("pw&lt;&amp;&gt;");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("class=");
    expect(html).not.toContain("<script");
  });

  it("name the PDF after the login", () => {
    expect(handoverFilename("acme-ci")).toBe("registry-access-acme-ci.pdf");
    expect(handoverFilename("../we ird/na\\me")).toBe("registry-access-we-ird-na-me.pdf");
    expect(handoverFilename("")).toBe("registry-access-user.pdf");
  });
});

describe("the section of a page", () => {
  const section = handoverSection(input({ roles: ["read", "publish"] })).value;

  it("holds the preview, the buttons (hidden until the script runs) and the data", () => {
    expect(section).toContain('<section class="handover" data-handover');
    expect(section).toContain('<div class="handover-actions" data-handover-actions hidden>');
    for (const attribute of [
      "data-handover-copy",
      "data-handover-copy-text",
      "data-handover-pdf",
    ]) {
      expect(section).toContain(`${attribute}>`);
    }
    expect(section).toContain("<textarea hidden readonly data-handover-html>");
    expect(section).toContain("<textarea hidden readonly data-handover-text>");
    expect(section).toContain('<script type="application/json" data-handover-blocks>');
    expect(section).not.toContain('style="');
  });

  it("keeps the text in the textareas as escaped text", () => {
    const html = /<textarea hidden readonly data-handover-html>([\s\S]*?)<\/textarea>/.exec(
      section,
    );
    expect(html?.[1]).toContain("&lt;div style=");
    expect(html?.[1]).not.toContain("<div");
  });

  it("can not be ended by what is in the data", () => {
    const hostile = handoverSection(
      input({
        grants: {
          read: [{ eco: "npm", package: "@a/</script><img src=x>", versions: "*" }],
          publish: [],
        },
      }),
    ).value;
    const json = /<script type="application\/json" data-handover-blocks>([\s\S]*?)<\/script>/.exec(
      hostile,
    );
    expect(json).not.toBeNull();
    const body = json?.[1] ?? "";
    expect(body).not.toContain("<");
    const parsed = JSON.parse(body) as { filename: string; blocks: Block[] };
    expect(parsed.filename).toBe("registry-access-acme-ci.pdf");
    expect(JSON.stringify(parsed.blocks)).toContain("</script><img src=x>");
    // The page itself has exactly the script tags it should.
    expect(hostile.match(/<script/g)).toHaveLength(1);
  });
});

describe("the one-time pages", () => {
  const next = { href: "/admin/credentials/acme-ci", label: "Back to the credential" };

  it("show the message, wider and with its script, when they are given one", () => {
    const page = tokenPage(ctx, {
      title: "Secret added",
      text: markup`Added.`,
      token: TOKEN,
      next,
      handover: input(),
    });
    expect(page).toContain('<h2 id="handover-heading">Message for the user</h2>');
    expect(page).toContain('class="centred-box wide"');
    expect(page).toContain('<script src="/handover.js" defer></script>');
    expect(page.indexOf("<pre><code>" + TOKEN)).toBeLessThan(page.indexOf("Message for the user"));
    expect(page.indexOf("Message for the user")).toBeLessThan(
      page.indexOf("Back to the credential"),
    );

    const login = loginSecretPage(ctx, {
      project: "acme-ci",
      password: "pw",
      totp: TOTP,
      next,
      handover: input({ secret: { kind: "login", password: "pw", totp: TOTP }, roles: ["read"] }),
    });
    expect(login).toContain("Message for the user");
    expect(login).toContain('<script src="/handover.js" defer></script>');
  });

  it("are as they were without one", () => {
    const page = tokenPage(ctx, { title: "T", text: markup`x`, token: TOKEN, next });
    expect(page).not.toContain("Message for the user");
    expect(page).not.toContain("handover.js");
    expect(page).not.toContain('class="centred-box wide"');
    const login = loginSecretPage(ctx, { project: "acme-ci", password: "pw", next });
    expect(login).not.toContain("handover");
  });
});
