/**
 * The two admin forms that the panel receives as form posts instead of `fetch` calls, because
 * their answer is the one-time token page: "new credential" and "add a secret". Each is read
 * into the JSON body of the matching `/api/v1` call (docs/api.md 6.15 and 6.17), which the
 * same kernel functions validate, and into the values that show the form again after an
 * error (never the passwords).
 */

import type { Eco } from "./adapters/types";
import type { Grant } from "./core/grants";
import type { CredentialFormValues, SecretFormValues } from "./pages/credentials";
import { GRANT_ROLES, KINDS, type Kind } from "./core/auth";

function field(form: URLSearchParams, name: string): string {
  return (form.get(name) ?? "").trim();
}

/** The roles of the credential switched on in the toggles named `roles`. */
export function formRoles(form: URLSearchParams): Kind[] {
  const chosen = form.getAll("roles");
  return KINDS.filter((role) => chosen.includes(role));
}

/**
 * The roles chosen with the toggles named `scope`: one value for every one that is on. The
 * values `read+publish` and `both`, as older forms sent them, are read as several roles.
 */
export function formScope(form: URLSearchParams): Kind[] {
  const chosen = form
    .getAll("scope")
    .flatMap((value) => (value === "both" ? ["read", "publish"] : value.split("+")));
  return KINDS.filter((role) => chosen.includes(role));
}

/**
 * The grant rows of a form: `grant` is each row's key, `grant_eco`, `grant_package` and
 * `grant_versions` follow in the same order, and `grant_transitive` lists the keys of the
 * rows whose box is ticked. Rows without a package are left out. With a `prefix` (`read_`,
 * `publish_`) the fields of that role's list are read instead.
 */
export function formGrants(form: URLSearchParams, prefix = ""): Grant[] {
  const keys = form.getAll(`${prefix}grant`);
  const ecos = form.getAll(`${prefix}grant_eco`);
  const packages = form.getAll(`${prefix}grant_package`);
  const versions = form.getAll(`${prefix}grant_versions`);
  const transitive = new Set(form.getAll(`${prefix}grant_transitive`));
  const grants: Grant[] = [];
  keys.forEach((key, i) => {
    const pkg = (packages[i] ?? "").trim();
    if (pkg === "") return;
    grants.push({
      // Checked by the kernel; here it is only shown again.
      eco: (ecos[i] ?? "") as Eco,
      package: pkg,
      versions: (versions[i] ?? "").trim() || "*",
      transitive: transitive.has(key),
    });
  });
  return grants;
}

/** The "new credential" form: the API body and the values to show again. */
export function credentialForm(form: URLSearchParams): {
  body: Record<string, unknown>;
  values: CredentialFormValues;
  password: string;
  repeat: string;
} {
  const roles = formRoles(form);
  const administer = roles.includes("admin");
  const grants = {
    read: formGrants(form, "read_"),
    publish: formGrants(form, "publish_"),
    yank: formGrants(form, "yank_"),
    delete: formGrants(form, "delete_"),
  };
  const scope = formScope(form);
  const project = field(form, "project");
  const chosen = field(form, "first_secret");
  // An admin always has a first secret (it could not sign in otherwise); anyone else none.
  const firstSecret: CredentialFormValues["firstSecret"] =
    chosen === "key" || chosen === "login" ? chosen : administer ? "login" : "none";
  const totp = firstSecret === "login" && form.has("totp");
  const description = field(form, "description");
  // A password is sent as typed, without trimming.
  const password = firstSecret === "login" ? (form.get("password") ?? "") : "";
  const repeat = firstSecret === "login" ? (form.get("password_repeat") ?? "") : "";
  const body: Record<string, unknown> = { project, roles };
  // Only the lists of the roles chosen: the fields of the other one may still be filled in.
  for (const role of GRANT_ROLES) if (roles.includes(role)) body[`${role}_grants`] = grants[role];
  // A credential with several roles scopes its first secret; nothing chosen leaves `scope` out,
  // so that the API says it is required.
  const scoped = roles.length > 1 && scope.length > 0 ? { scope } : {};
  if (firstSecret === "none") {
    body.secret = null;
  } else if (firstSecret === "key") {
    body.secret =
      description === "" ? { type: "key", ...scoped } : { type: "key", description, ...scoped };
  } else {
    const secret: Record<string, unknown> = { type: "login", totp, ...scoped };
    if (password !== "") secret.password = password;
    if (description !== "") secret.description = description;
    body.secret = secret;
  }
  return {
    body,
    values: { project, roles, grants, scope, firstSecret, totp, description },
    password,
    repeat,
  };
}

/** The "add a secret" form: the API body and the values to show again. */
export function secretForm(form: URLSearchParams): {
  body: Record<string, unknown>;
  values: SecretFormValues;
  password: string;
  repeat: string;
} {
  const typeField = field(form, "type");
  const type: SecretFormValues["type"] =
    typeField === "gh" || typeField === "login" ? typeField : "key";
  const values: SecretFormValues = {
    type,
    scope: formScope(form),
    totp: form.has("totp"),
    description: field(form, "description"),
    replaces: type === "gh" ? field(form, "edit_of") : "",
    expire_old: form.has("expire_old"),
    repository: field(form, "repository"),
    repository_id: field(form, "repository_id"),
    repository_owner_id: field(form, "repository_owner_id"),
    ref: field(form, "ref"),
    workflow: field(form, "workflow"),
    environment: field(form, "environment"),
    pin_on_first_use: form.has("pin_on_first_use"),
    expires: field(form, "expires"),
  };
  const password = type === "login" ? (form.get("password") ?? "") : "";
  const repeat = type === "login" ? (form.get("password_repeat") ?? "") : "";
  const body: Record<string, unknown> = { type };
  if (type === "login") {
    body.totp = values.totp;
    if (password !== "") body.password = password;
  } else if (type === "gh") {
    Object.assign(body, {
      repository: values.repository,
      repository_id: values.repository_id || null,
      repository_owner_id: values.repository_owner_id || null,
      ref: values.ref || null,
      workflow: values.workflow || null,
      environment: values.environment || null,
      pin_on_first_use: values.pin_on_first_use,
    });
    if (values.replaces !== "" && values.expire_old) body.replaces = values.replaces;
  }
  if (values.description !== "") body.description = values.description;
  if (values.expires !== "") body.expires = values.expires;
  // Only a credential with both roles asks for a scope; the API requires it there.
  if (values.scope.length > 0) body.scope = values.scope;
  return { body, values, password, repeat };
}
