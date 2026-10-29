/**
 * The one-time token page: a new token (a first admin, a new credential, a new `key` secret)
 * is shown once, on the response to the form that created it, in the centred card with a
 * "Copy" button and a link to go on. Nothing stores the token for a later page.
 */

import { qrSvg } from "../core/qr";
import { copyBlock } from "./components";
import { handoverSection, type HandoverInput } from "./handover";
import { markup, SafeHtml } from "./html";
import { centredLayout, type LayoutOptions, type PageContext } from "./layout";

/** What the token page shows. */
export interface TokenPageData {
  /** The page title and heading ("Credential created"). */
  title: string;
  /** What was created and how to use the token. */
  text: SafeHtml;
  token: string;
  /** Where to go on, e.g. the credential's page. */
  next: { href: string; label: string };
  /** Makes the message for the person the token is for (`src/pages/handover.ts`). */
  handover?: HandoverInput;
}

/** A page with the message is wider and loads the script that copies it. */
function handoverLayout(handover: HandoverInput | undefined): LayoutOptions {
  return handover === undefined
    ? { page: "token" }
    : { page: "token", wide: true, scripts: ["/handover.js"] };
}

/** The token page. */
export function tokenPage(ctx: PageContext, data: TokenPageData): string {
  return centredLayout(
    ctx,
    data.title,
    markup`<h1>${data.title}</h1>
<p class="sub">${data.text}</p>
<p class="once">The token is shown <strong>only once</strong>. Copy it now and store it in a password manager or a CI secret.</p>
${copyBlock(data.token)}
${data.handover === undefined ? "" : handoverSection(data.handover)}
<a class="button block" href="${data.next.href}">${data.next.label}</a>`,
    handoverLayout(data.handover),
  );
}

/** What the one-time login page shows. */
export interface LoginPageData {
  /** The page title and heading; default "Login created". */
  title?: string;
  /** What was created, shown under the heading; default says how to sign in. */
  text?: SafeHtml;
  /** The credential's project: the login. */
  project: string;
  password: string;
  /** The one-time code enrolment, when the secret has TOTP. */
  totp?: { secret: string; otpauthUri: string };
  next: { href: string; label: string };
  /** Makes the message for the person the login is for (`src/pages/handover.ts`). */
  handover?: HandoverInput;
}

/**
 * The one-time page of a new `login` secret: the login and password, and the shared secret of
 * the one-time codes as a link authenticator apps open. Nothing stores them for a later page.
 */
export function loginSecretPage(ctx: PageContext, data: LoginPageData): string {
  const title = data.title ?? "Login created";
  const text =
    data.text ??
    markup`Sign in as <strong>${data.project}</strong> with <code>sreg login</code> or the approval page the command opens.`;
  let totp: SafeHtml | string = "";
  if (data.totp !== undefined) {
    const svg = qrSvg(data.totp.otpauthUri, "QR code for the authenticator app");
    const code =
      svg === null
        ? ""
        : markup`<div class="qr">${new SafeHtml(svg)}</div>
<p class="hint qr-caption">Scan this code with an authenticator app, or use the link or the key below.</p>`;
    totp = markup`<p class="once">Add the one-time code to an authenticator app. Without it nobody can sign in with this login.</p>
${code}
${copyBlock(data.totp.otpauthUri, "Authenticator link")}
${copyBlock(data.totp.secret, "Key")}`;
  }
  return centredLayout(
    ctx,
    title,
    markup`<h1>${title}</h1>
<p class="sub">${text}</p>
<p class="once">The password is shown <strong>only once</strong>. Copy it now and store it in a password manager.</p>
${copyBlock(data.password, "Password")}
${totp}
${data.handover === undefined ? "" : handoverSection(data.handover)}
<a class="button block" href="${data.next.href}">${data.next.label}</a>`,
    handoverLayout(data.handover),
  );
}
