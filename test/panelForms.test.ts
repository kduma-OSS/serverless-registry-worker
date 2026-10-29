import { describe, expect, it } from "vitest";
import { credentialForm, formGrants, secretForm } from "../src/panelForms";

function form(fields: [string, string][]): URLSearchParams {
  return new URLSearchParams(fields);
}

describe("formGrants", () => {
  it("pairs each ticked transitive box with its row by key and skips empty rows", () => {
    const grants = formGrants(
      form([
        ["grant", "0"],
        ["grant_eco", "npm"],
        ["grant_package", " @acme/* "],
        ["grant_versions", ""],
        ["grant", "added-1"],
        ["grant_eco", "composer"],
        ["grant_package", ""],
        ["grant_versions", "*"],
        ["grant_transitive", "added-1"],
        ["grant", "added-2"],
        ["grant_eco", "composer"],
        ["grant_package", "acme/sdk"],
        ["grant_versions", "^1.0"],
        ["grant_transitive", "added-2"],
      ]),
    );
    expect(grants).toEqual([
      { eco: "npm", package: "@acme/*", versions: "*", transitive: false },
      { eco: "composer", package: "acme/sdk", versions: "^1.0", transitive: true },
    ]);
  });
});

describe("credentialForm", () => {
  // The grant rows of one role: each list of the form has its own field names.
  const rowOf = (role: "read" | "publish" | "yank" | "delete"): [string, string][] => [
    [`${role}_grant`, "0"],
    [`${role}_grant_eco`, "npm"],
    [`${role}_grant_package`, "x"],
    [`${role}_grant_versions`, "*"],
  ];
  const grantRow = rowOf("read");

  it("sends the grants of read and publish credentials, with no secret by default", () => {
    const { body, values } = credentialForm(
      form([
        ["project", " shop "],
        ["roles", "publish"],
        ["password", "ignored-password"],
        ...rowOf("publish"),
        // The list of a role the credential does not hold is left out, even when filled in.
        ...rowOf("read").map(([name, value]): [string, string] => [
          name,
          name.endsWith("package") ? "ignored" : value,
        ]),
      ]),
    );
    expect(body).toEqual({
      project: "shop",
      roles: ["publish"],
      publish_grants: [{ eco: "npm", package: "x", versions: "*", transitive: false }],
      secret: null,
    });
    expect(values).toMatchObject({
      roles: ["publish"],
      firstSecret: "none",
      totp: false,
    });
  });

  it("sends the yank and delete lists of a credential that holds those roles", () => {
    const { body, values } = credentialForm(
      form([
        ["project", "cleaner"],
        ["roles", "yank"],
        ["roles", "delete"],
        ...rowOf("yank"),
        ...rowOf("delete"),
        ...rowOf("read"),
      ]),
    );
    expect(body).toMatchObject({ project: "cleaner", roles: ["yank", "delete"], secret: null });
    expect(body).toHaveProperty("yank_grants", [
      { eco: "npm", package: "x", versions: "*", transitive: false },
    ]);
    expect(body).toHaveProperty("delete_grants");
    expect(body).not.toHaveProperty("read_grants");
    expect(values.roles).toEqual(["yank", "delete"]);
  });

  it("sends a generated key as the first secret, with its description", () => {
    const { body, values } = credentialForm(
      form([
        ["project", "shop"],
        ["roles", "read"],
        ["first_secret", "key"],
        ["description", " CI of the shop "],
        ["password", "ignored-for-keys"],
        ...grantRow,
      ]),
    );
    expect(body.secret).toEqual({ type: "key", description: "CI of the shop" });
    expect(values).toMatchObject({ firstSecret: "key", description: "CI of the shop" });
    expect(
      credentialForm(
        form([
          ["roles", "read"],
          ["first_secret", "key"],
        ]),
      ).body.secret,
    ).toEqual({ type: "key" });
  });

  it("sends a login with its password untrimmed, its one-time code and its description", () => {
    const { body, password, repeat, values } = credentialForm(
      form([
        ["project", "ops"],
        ["roles", "admin"],
        ["first_secret", "login"],
        ["totp", "on"],
        ["description", "Jane"],
        ["password", " correct-horse "],
        ["password_repeat", " correct-horse "],
      ]),
    );
    expect(body).toEqual({
      project: "ops",
      roles: ["admin"],
      secret: { type: "login", totp: true, password: " correct-horse ", description: "Jane" },
    });
    expect([password, repeat]).toEqual([" correct-horse ", " correct-horse "]);
    expect(values).toMatchObject({ firstSecret: "login", totp: true });
    // No password typed: the registry generates one.
    expect(
      credentialForm(
        form([
          ["roles", "read"],
          ["first_secret", "login"],
        ]),
      ).body.secret,
    ).toEqual({ type: "login", totp: false });
  });

  it("gives an admin a login unless it chose a key, never no secret", () => {
    expect(credentialForm(form([["roles", "admin"]])).body).toEqual({
      project: "",
      roles: ["admin"],
      secret: { type: "login", totp: false },
    });
    expect(
      credentialForm(
        form([
          ["roles", "admin"],
          ["first_secret", "none"],
        ]),
      ).values.firstSecret,
    ).toBe("login");
    expect(
      credentialForm(
        form([
          ["roles", "admin"],
          ["first_secret", "key"],
        ]),
      ).body.secret,
    ).toEqual({ type: "key" });
  });

  it("ignores the one-time code and the password of a first secret that is not a login", () => {
    const { body, password, values } = credentialForm(
      form([
        ["roles", "read"],
        ["first_secret", "key"],
        ["totp", "on"],
        ["password", "typed-anyway-1"],
        ...grantRow,
      ]),
    );
    expect(values.totp).toBe(false);
    expect(password).toBe("");
    expect(body.secret).toEqual({ type: "key" });
  });

  it("sends both lists and the scope of the first secret for read + publish", () => {
    const { body, values } = credentialForm(
      form([
        ["project", "dual"],
        ["roles", "read"],
        ["roles", "publish"],
        ["first_secret", "key"],
        ["scope", "read"],
        ...rowOf("read"),
        ["read_grant_transitive", "0"],
        ...rowOf("publish").map(([name, value]): [string, string] => [
          name,
          name.endsWith("package") ? "y" : value,
        ]),
      ]),
    );
    expect(body).toEqual({
      project: "dual",
      roles: ["read", "publish"],
      read_grants: [{ eco: "npm", package: "x", versions: "*", transitive: true }],
      publish_grants: [{ eco: "npm", package: "y", versions: "*", transitive: false }],
      secret: { type: "key", scope: ["read"] },
    });
    expect(values.scope).toEqual(["read"]);
  });

  it("scopes a login as first secret of read + publish too, and sends no scope for none", () => {
    const { body } = credentialForm(
      form([
        ["roles", "read"],
        ["roles", "publish"],
        ["first_secret", "login"],
        ["scope", "publish"],
        ["scope", "read"],
      ]),
    );
    expect(body.secret).toEqual({ type: "login", totp: false, scope: ["read", "publish"] });
    expect(
      credentialForm(
        form([
          ["roles", "read"],
          ["roles", "publish"],
        ]),
      ).body.secret,
    ).toBeNull();
  });

  it("leaves the scope out when none is ticked, so that the API asks for one", () => {
    const { body } = credentialForm(
      form([
        ["roles", "read"],
        ["roles", "publish"],
        ["first_secret", "key"],
      ]),
    );
    expect(body.secret).toEqual({ type: "key" });
  });

  it("scopes the first secret of a credential that administers and reads", () => {
    const { body, values } = credentialForm(
      form([
        ["project", "ops"],
        ["roles", "read"],
        ["roles", "admin"],
        ["first_secret", "key"],
        ["scope", "read"],
        ["scope", "admin"],
        ...rowOf("read"),
        // An admin credential that reads takes read grants only.
        ...rowOf("publish"),
      ]),
    );
    expect(body).toEqual({
      project: "ops",
      roles: ["read", "admin"],
      read_grants: [{ eco: "npm", package: "x", versions: "*", transitive: false }],
      secret: { type: "key", scope: ["read", "admin"] },
    });
    expect(values).toMatchObject({ roles: ["read", "admin"], scope: ["read", "admin"] });
    expect(
      credentialForm(
        form([
          ["roles", "read"],
          ["roles", "publish"],
          ["roles", "admin"],
        ]),
      ).body.roles,
    ).toEqual(["read", "publish", "admin"]);
  });

  it("reads the roles toggled on, in the panel's order, and ignores anything else", () => {
    const rolesOf = (...values: string[]) =>
      credentialForm(form(values.map((v): [string, string] => ["roles", v]))).body.roles;
    expect(rolesOf("admin", "read")).toEqual(["read", "admin"]);
    expect(rolesOf("publish", "root", "publish")).toEqual(["publish"]);
    // Nothing on: the API refuses it ("a non-empty list").
    expect(rolesOf()).toEqual([]);
  });
});

describe("secretForm", () => {
  it("reads the switch value both as the two roles", () => {
    const { body } = secretForm(
      form([
        ["type", "key"],
        ["scope", "both"],
      ]),
    );
    expect(body).toEqual({ type: "key", scope: ["read", "publish"] });
    expect(
      secretForm(
        form([
          ["type", "key"],
          ["scope", "publish"],
        ]),
      ).body,
    ).toEqual({
      type: "key",
      scope: ["publish"],
    });
  });

  it("reads every combination of roles written with plus signs", () => {
    const scopeOf = (value: string) =>
      secretForm(
        form([
          ["type", "key"],
          ["scope", value],
        ]),
      ).body.scope;
    expect(scopeOf("admin")).toEqual(["admin"]);
    expect(scopeOf("publish+admin")).toEqual(["publish", "admin"]);
    expect(scopeOf("read+publish+admin")).toEqual(["read", "publish", "admin"]);
    expect(scopeOf("admin+read")).toEqual(["read", "admin"]);
    expect(scopeOf("root")).toBeUndefined();
  });

  it("sends the ticked scope", () => {
    const { body, values } = secretForm(
      form([
        ["type", "key"],
        ["scope", "publish"],
        ["scope", "read"],
      ]),
    );
    expect(body).toEqual({ type: "key", scope: ["read", "publish"] });
    expect(values.scope).toEqual(["read", "publish"]);
    expect(secretForm(form([["type", "key"]])).body).not.toHaveProperty("scope");
  });

  it("builds a key secret with its description and expiry, and no password", () => {
    expect(secretForm(form([["type", "key"]])).body).toEqual({ type: "key" });
    const { body, password } = secretForm(
      form([
        ["type", "key"],
        ["password", "correct-horse"],
        ["description", " for CI "],
        ["expires", "2027-01-01"],
      ]),
    );
    expect(body).toEqual({ type: "key", description: "for CI", expires: "2027-01-01" });
    expect(password).toBe("");
  });

  it("builds a login secret with its optional password and one-time code", () => {
    expect(secretForm(form([["type", "login"]])).body).toEqual({ type: "login", totp: false });
    const { body, values, password, repeat } = secretForm(
      form([
        ["type", "login"],
        ["totp", "on"],
        ["password", "correct-horse-battery"],
        ["password_repeat", "correct-horse-batter"],
        ["expires", "2027-01-01"],
      ]),
    );
    expect(body).toEqual({
      type: "login",
      totp: true,
      password: "correct-horse-battery",
      expires: "2027-01-01",
    });
    expect(values).toMatchObject({ type: "login", totp: true });
    expect(password).toBe("correct-horse-battery");
    expect(repeat).toBe("correct-horse-batter");
  });

  it("sends the id of the edited gh secret only while the box to expire it is ticked", () => {
    const fields: [string, string][] = [
      ["type", "gh"],
      ["repository", "acme/shop"],
      ["edit_of", " 0123456789ab "],
      ["description", "edited"],
    ];
    const kept = secretForm(form(fields));
    expect(kept.body).not.toHaveProperty("replaces");
    expect(kept.body.description).toBe("edited");
    expect(kept.values).toMatchObject({ replaces: "0123456789ab", expire_old: false });
    const replacing = secretForm(form([...fields, ["expire_old", "on"]]));
    expect(replacing.body.replaces).toBe("0123456789ab");
    expect(replacing.values.expire_old).toBe(true);
    // Only a gh secret is edited this way.
    expect(
      secretForm(
        form([
          ["type", "key"],
          ["edit_of", "0123456789ab"],
          ["expire_old", "on"],
        ]),
      ).body,
    ).toEqual({ type: "key" });
  });

  it("builds a gh secret with empty claims as null and pin_on_first_use from the box", () => {
    const { body, values, password } = secretForm(
      form([
        ["type", "gh"],
        ["repository", " acme/shop "],
        ["repository_id", "123"],
        ["repository_owner_id", ""],
        ["ref", "refs/tags/v*"],
        ["password", "not-for-gh"],
      ]),
    );
    expect(body).toEqual({
      type: "gh",
      repository: "acme/shop",
      repository_id: "123",
      repository_owner_id: null,
      ref: "refs/tags/v*",
      workflow: null,
      environment: null,
      pin_on_first_use: false,
    });
    expect(password).toBe("");
    expect(values.pin_on_first_use).toBe(false);
    expect(
      secretForm(
        form([
          ["type", "gh"],
          ["pin_on_first_use", "on"],
        ]),
      ).body,
    ).toMatchObject({
      pin_on_first_use: true,
    });
  });
});
