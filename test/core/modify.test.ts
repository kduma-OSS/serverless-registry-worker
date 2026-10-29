import { describe, expect, it } from "vitest";
import { emptyGrants, type Kind, type RoleGrants } from "../../src/core/auth";
import type { Grant } from "../../src/core/grants";
import { mayModify } from "../../src/core/modify";

const env = { ECOSYSTEMS: undefined };
const grant = (versions: string, name = "acme/*"): Grant => ({
  eco: "composer",
  package: name,
  versions,
});
const op = (kind: "yank" | "delete", version?: string, name = "acme/sdk") => ({
  op: kind,
  eco: "composer" as const,
  package: name,
  ...(version === undefined ? {} : { version }),
});
const grants = (extra: Partial<RoleGrants>): RoleGrants => ({ ...emptyGrants(), ...extra });

describe("mayModify", () => {
  it("lets an admin yank and delete anything, grants or not", () => {
    for (const kind of ["yank", "delete"] as const) {
      expect(mayModify(env, ["admin"], emptyGrants(), op(kind, "1.0.0"))).toBe(true);
    }
    expect(mayModify(env, ["admin"], emptyGrants(), op("delete"))).toBe(true);
  });

  it("needs the role of the operation and a grant of that role", () => {
    const g = grants({ yank: [grant("*")], delete: [grant("*", "other/*")] });
    expect(mayModify(env, ["yank"], g, op("yank", "1.0.0"))).toBe(true);
    expect(mayModify(env, ["yank"], g, op("delete", "1.0.0"))).toBe(false);
    expect(mayModify(env, ["delete"], g, op("yank", "1.0.0"))).toBe(false);
    expect(mayModify(env, ["delete"], g, op("delete", "1.0.0", "acme/sdk"))).toBe(false);
    expect(mayModify(env, ["delete"], g, op("delete", "1.0.0", "other/x"))).toBe(true);
  });

  it("ignores the grants of a role the secret may not use", () => {
    const roles: Kind[] = ["read"];
    const g = grants({ yank: [grant("*")] });
    expect(mayModify(env, roles, g, op("yank", "1.0.0"))).toBe(false);
  });

  it("honours version constraints, but deletes a whole package only with all versions", () => {
    const narrow = grants({ delete: [grant("^1.0")] });
    expect(mayModify(env, ["delete"], narrow, op("delete", "1.2.0"))).toBe(true);
    expect(mayModify(env, ["delete"], narrow, op("delete", "2.0.0"))).toBe(false);
    expect(mayModify(env, ["delete"], narrow, op("delete"))).toBe(false);
    expect(mayModify(env, ["delete"], grants({ delete: [grant("*")] }), op("delete"))).toBe(true);
  });
});
