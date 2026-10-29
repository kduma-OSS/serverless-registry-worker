/**
 * Who may yank or delete (docs/api.md 2.4, 6.8–6.10): an `admin` anything, a credential with the
 * `yank` or `delete` role only what its grants of that role cover.
 */

import { getAdapter } from "../adapters/index";
import type { Env } from "../env";
import type { AdminOp, Identity, Kind, RoleGrants } from "./auth";
import { coversAllVersions, isAllowed } from "./grants";

/**
 * Whether roles and grants allow one yank or delete. `admin` may do both anywhere. Otherwise the
 * role named by the operation is needed and one of its grants must cover the version; deleting a
 * whole package (`version` absent) needs a grant for all versions (`versions: *`).
 */
export function mayModify(
  env: Pick<Env, "ECOSYSTEMS">,
  roles: readonly Kind[],
  grants: RoleGrants,
  op: Pick<AdminOp, "op" | "eco" | "package" | "version">,
): boolean {
  if (roles.includes("admin")) return true;
  if (!roles.includes(op.op)) return false;
  const list = grants[op.op];
  if (op.version === undefined) return coversAllVersions(list, op.eco, op.package);
  const adapter = getAdapter(env, op.eco);
  return adapter !== null && isAllowed(list, op.eco, op.package, op.version, adapter.satisfies);
}

/**
 * Whether the caller of a yank or delete route may perform it. A login token (`ops`) was checked
 * against the grants when it was approved and against its operations by the router, so it passes.
 */
export function identityMayModify(
  env: Pick<Env, "ECOSYSTEMS">,
  identity: Pick<Identity, "roles" | "grants" | "ops">,
  op: Pick<AdminOp, "op" | "eco" | "package" | "version">,
): boolean {
  return identity.ops !== undefined || mayModify(env, identity.roles, identity.grants, op);
}
