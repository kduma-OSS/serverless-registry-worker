/**
 * Informational dependency-confusion hints for `publish/init`: names that are shared with, or
 * easily mistaken for, a public registry. They never block a publish; the Worker only reports
 * them in `warnings` so the publisher can rename the package or pin consumers to this registry.
 */

import type { Eco } from "../adapters/types";

/** Composer vendors that exist on Packagist and are commonly depended upon. */
const COMPOSER_PUBLIC_VENDORS = new Set([
  "symfony",
  "laravel",
  "illuminate",
  "guzzlehttp",
  "monolog",
  "doctrine",
  "phpunit",
  "league",
  "nesbot",
  "psr",
  "composer",
  "twig",
  "ramsey",
  "spatie",
]);

/** Maven group id prefixes owned by well-known public projects. */
const MAVEN_PUBLIC_PREFIXES = [
  "org.apache",
  "org.springframework",
  "org.jetbrains",
  "org.junit",
  "com.google",
  "com.fasterxml",
  "io.netty",
  "javax",
  "jakarta",
];

/** NuGet ID prefixes reserved by their owners on nuget.org. */
const NUGET_RESERVED_PREFIXES = ["microsoft.", "system.", "azure.", "aspnet", "xamarin."];

/** Warnings for a package name, empty when the name does not look like a public one. */
export function publicNameWarnings(eco: Eco, name: string): string[] {
  const lower = name.toLowerCase();
  switch (eco) {
    case "npm":
      return name.startsWith("@")
        ? []
        : [
            `"${name}" is not scoped: anyone can publish this name on npmjs.com. Use a scope you own (@scope/name) so clients can route it only to this registry.`,
          ];
    case "cargo":
      return [
        `Crate names are global to crates.io: consumers must set registry on every dependency on "${name}", otherwise Cargo resolves it against crates.io.`,
      ];
    case "composer": {
      const vendor = lower.split("/")[0] ?? "";
      return COMPOSER_PUBLIC_VENDORS.has(vendor)
        ? [`The vendor "${vendor}" exists on Packagist; keep this repository canonical in clients.`]
        : [];
    }
    case "maven": {
      const hit = MAVEN_PUBLIC_PREFIXES.find((p) => lower === p || lower.startsWith(`${p}.`));
      return hit === undefined
        ? []
        : [
            `The group "${hit}" belongs to a public project on Maven Central; pin it to this repository in clients.`,
          ];
    }
    case "nuget": {
      const hit = NUGET_RESERVED_PREFIXES.find((p) => lower.startsWith(p));
      return hit === undefined
        ? []
        : [
            `The ID prefix "${hit}" is reserved on nuget.org; map these IDs to this source with packageSourceMapping.`,
          ];
    }
    default:
      return [];
  }
}
