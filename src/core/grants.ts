import { isEco, type Eco } from "../adapters/types";
import { ValidationError } from "./errors";

/** What a credential may install (`read`) or release (`publish`); docs/api.md 5.1. */
export interface Grant {
  eco: Eco;
  /** Exact package name, or a pattern whose only `*` is its last character. */
  package: string;
  /** Version constraint in the ecosystem's syntax; `*` = all versions. */
  versions: string;
  /**
   * For `read`: whether the grant also opens the package's dependencies in this registry
   * (docs/api.md 5.3). Absent means `true`; {@link validateGrant} and {@link normalizeGrant}
   * always set it. Accepted for every kind, meaningful only for `read`.
   */
  transitive?: boolean;
}

/** Whether a grant opens dependencies transitively (absent = `true`). */
export function isTransitive(grant: Grant): boolean {
  return grant.transitive !== false;
}

/** A stored grant with `transitive` made explicit (`true` when it was absent). */
export function normalizeGrant(grant: Grant): Grant {
  return { ...grant, transitive: isTransitive(grant) };
}

/** The ecosystem's `satisfies(version, constraint)`, looked up by the caller. */
export type Satisfies = (version: string, constraint: string) => boolean;

/**
 * Whether a version constraint parses in an ecosystem's syntax: the adapter's
 * `validateRange`, looked up by the caller (see `validateRange` in `src/adapters/index.ts`).
 */
export type ValidateRange = (eco: Eco, constraint: string) => boolean;

/**
 * npm and Composer package names, NuGet ids and Swift package identifiers are
 * case-insensitive; cargo, generic and Maven names are compared as written.
 */
export function foldCase(eco: Eco | undefined, value: string): string {
  return eco === "npm" || eco === "composer" || eco === "nuget" || eco === "swift"
    ? value.toLowerCase()
    : value;
}

/**
 * Whether a grant pattern matches a package name. `*` alone matches every package; otherwise
 * a trailing `*` matches any sequence of characters without `/`. Every other character,
 * `.` and `:` included (Swift `scope.name`, Maven `group:artifact`), is literal. Pass `eco` to
 * compare npm, Composer and Swift names and NuGet ids case-insensitively.
 */
export function matchesPackage(pattern: string, name: string, eco?: Eco): boolean {
  if (pattern === "*") return true;
  const p = foldCase(eco, pattern);
  const n = foldCase(eco, name);
  if (!p.endsWith("*")) return p === n;
  const prefix = p.slice(0, -1);
  return n.startsWith(prefix) && !n.slice(prefix.length).includes("/");
}

/** `*` (or an empty constraint) means every version, prereleases included. */
function allVersions(versions: string): boolean {
  const v = versions.trim();
  return v === "*" || v === "";
}

/**
 * Whether any grant of the ecosystem covers the package and version. A grant whose
 * `versions` is `*` covers every version, including prereleases, without consulting
 * `satisfies` (whose ranges exclude prereleases unless they name one).
 */
export function isAllowed(
  grants: readonly Grant[],
  eco: Eco,
  name: string,
  version: string,
  satisfies: Satisfies,
): boolean {
  return grants.some(
    (g) =>
      g.eco === eco &&
      matchesPackage(g.package, name, eco) &&
      (allVersions(g.versions) || satisfies(version, g.versions)),
  );
}

/**
 * Whether a grant of the ecosystem covers every version of the package (its `versions` is `*`).
 * A narrower constraint is not enough: it would not cover versions published later.
 */
export function coversAllVersions(grants: readonly Grant[], eco: Eco, name: string): boolean {
  return grants.some(
    (g) => g.eco === eco && matchesPackage(g.package, name, eco) && allVersions(g.versions),
  );
}

/** Whether any grant of the ecosystem covers the package, whatever the version. */
export function isPackageAllowed(grants: readonly Grant[], eco: Eco, name: string): boolean {
  return grants.some((g) => g.eco === eco && matchesPackage(g.package, name, eco));
}

/** The distinct package patterns granted for an ecosystem, in grant order. */
export function allowedPackages(grants: readonly Grant[], eco: Eco): string[] {
  return [...new Set(grants.filter((g) => g.eco === eco).map((g) => g.package))];
}

/** Whether a package pattern is well formed: no whitespace, `*` only as the last character. */
export function isValidPackagePattern(pattern: string): boolean {
  if (pattern === "" || pattern.length > 214 || /\s/.test(pattern)) return false;
  const star = pattern.indexOf("*");
  return star === -1 || star === pattern.length - 1;
}

/**
 * Validates one grant from a request body; throws `400 invalid_request`. The version
 * constraint is checked with the ecosystem adapter's rules through `validateRange`.
 */
export function validateGrant(value: unknown, validateRange: ValidateRange): Grant {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("invalid_request", "A grant must be an object.");
  }
  const { eco, package: pkg, versions = "*", transitive = true } = value as Record<string, unknown>;
  if (!isEco(eco)) {
    throw new ValidationError(
      "invalid_request",
      "Grant `eco` must be composer, npm, cargo, generic, nuget, swift or maven.",
    );
  }
  if (typeof pkg !== "string" || !isValidPackagePattern(pkg)) {
    throw new ValidationError(
      "invalid_request",
      "Grant `package` must be a package name or a pattern with `*` as its last character.",
    );
  }
  if (
    typeof versions !== "string" ||
    !(allVersions(versions) || validateRange(eco, versions.trim()))
  ) {
    throw new ValidationError(
      "invalid_request",
      `Grant \`versions\` is not a valid ${eco} version constraint.`,
    );
  }
  if (typeof transitive !== "boolean") {
    throw new ValidationError("invalid_request", "Grant `transitive` must be a boolean.");
  }
  return {
    eco,
    package: pkg,
    versions: versions.trim() === "" ? "*" : versions.trim(),
    transitive,
  };
}

/** Validates a list of grants from a request body; throws `400 invalid_request`. */
export function validateGrants(value: unknown, validateRange: ValidateRange): Grant[] {
  if (!Array.isArray(value)) {
    throw new ValidationError("invalid_request", "`grants` must be an array.");
  }
  return value.map((grant) => validateGrant(grant, validateRange));
}

/**
 * Parses the CLI shorthand `eco:package[:versions[:transitive]]`, split at the first two `:`
 * (for maven, whose names are `group:artifact`, at the first three; `versions` defaults to
 * `*`). When the rest after the second `:` ends with `:true` or
 * `:false`, that suffix is `transitive` (default `true`), so ranges containing `:` stay intact.
 * Throws `400 invalid_request` when invalid.
 */
export function parseGrantShorthand(shorthand: string, validateRange: ValidateRange): Grant {
  const first = shorthand.indexOf(":");
  if (first === -1) {
    throw new ValidationError(
      "invalid_request",
      "A grant must look like eco:package[:versions[:transitive]].",
    );
  }
  // Maven package names contain one `:` themselves (`com.acme:sdk`).
  const nameColon =
    shorthand.slice(0, first) === "maven" ? shorthand.indexOf(":", first + 1) : first;
  const second = nameColon === -1 ? -1 : shorthand.indexOf(":", nameColon + 1);
  const eco = shorthand.slice(0, first);
  const pkg = second === -1 ? shorthand.slice(first + 1) : shorthand.slice(first + 1, second);
  let versions = second === -1 ? "*" : shorthand.slice(second + 1);
  let transitive = true;
  const suffix = /:(true|false)$/.exec(versions);
  if (suffix !== null) {
    transitive = suffix[1] === "true";
    versions = versions.slice(0, suffix.index);
  }
  return validateGrant({ eco, package: pkg, versions, transitive }, validateRange);
}
