import type {
  AuthRecordEntry,
  CredentialRecord,
  Identity,
  Kind,
  RoleGrants,
} from "../src/core/auth";
import type { Grant } from "../src/core/grants";

/** The grants of a credential that holds only `kind`, as the role lists of a record. */
export function roleGrants(kind: Kind, grants: Grant[] = []): RoleGrants {
  return {
    read: kind === "read" ? grants : [],
    publish: kind === "publish" ? grants : [],
    yank: kind === "yank" ? grants : [],
    delete: kind === "delete" ? grants : [],
  };
}

/** A credential record holding one role, with its grants. */
export function recordOf(
  project: string,
  kind: Kind,
  auth: AuthRecordEntry[] = [],
  grants: Grant[] = [],
): CredentialRecord {
  return { project, roles: [kind], auth, grants: roleGrants(kind, grants) };
}

/** The identity of a caller holding one role, as `authenticate` builds it. */
export function identityOf(
  project: string,
  kind: Kind,
  grants: Grant[] = [],
  entryId = "x",
): Identity {
  const record = recordOf(project, kind, [], grants);
  return { project, roles: [kind], grants: record.grants, record, entryId };
}

/** A record written the way schema version 3 stored it: one `kind` and one flat `grants` list. */
export interface LegacyRecord {
  project: string;
  kind: Kind;
  auth: AuthRecordEntry[];
  grants: Grant[];
}

/** The current-shape record for a legacy literal. */
export function legacy(r: LegacyRecord): CredentialRecord {
  return recordOf(r.project, r.kind, r.auth, r.grants);
}
