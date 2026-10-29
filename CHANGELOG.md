# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases call
out breaking changes and changes that require a data migration in their own sections.

## [Unreleased]

### Added

- Roles `yank` and `delete`: a credential can be allowed to yank or delete only the package
  versions its own grants (`yank_grants`, `delete_grants`) cover, without being an `admin`
  (who still yanks and deletes anywhere). They work with a `key`, a `gh` entry (`_:gh.<jwt>`)
  or a browser login with the usual approval; the credentials API, the panel's credential
  forms and `whoami` know the new roles. Deleting a whole package needs a `delete` grant with
  all versions. Accounts with these roles also see the package listing, filtered by their grants.
- Existing credentials need no migration: a record without `yank` and `delete` grants reads as
  having none.

### Changed

- A yank or delete login (`purpose` `yank` / `delete`) is also approved by a credential that
  holds the `yank` / `delete` role and whose grants cover every operation; its token carries
  that role instead of `admin`.
- Accounts with only the `yank` and/or `delete` role can use the panel: after signing in with a
  `login` they see the packages their grants cover and get "Yank" and "Delete" on the versions
  those grants cover ("Delete package" with a grant for all versions), without version pages,
  downloads, configuration or the administration pages. A panel session carries every role of
  the `login` except `publish`.

## [0.3.6] - 2026-10-29

### Changed

- The breadcrumb of a version page shows the package's groups too, like the package page.

### Added

- The one-time pages of a new token or login show a ready message for the person it is for:
  the server, login, token or password, expiry and one-time code (with the QR code), what the
  secret may do (read, publish, administer) and client configuration for each ecosystem. It can
  be copied formatted for a mail client (with the QR code as an image), copied as plain text or
  downloaded as a PDF. The PDF library loads from cdnjs only when the PDF is asked for, and these
  pages are the only ones whose Content-Security-Policy allows that script source.

## [0.3.5] - 2026-10-29

### Changed

- The breadcrumb of a package page shows the groups the package is in, from the top down, each
  linking to the group in the list (which opens it, even when it is collapsed). A consumer sees
  it too, except for a hidden group, which only an admin sees (linking to the list with the
  hidden groups shown).

## [0.3.4] - 2026-10-29

### Added

- Package groups have a visibility: **visible** (open in the list, as before), **collapsed**
  (closed until opened) and **hidden**. A hidden group is left out of the package lists with its
  subgroups and every package in them, for admins and for `read` credentials alike (it only
  organises the lists: access and the package pages are unchanged). Admins bring hidden groups
  back with the new "Show hidden groups" button on `/admin/packages`, where they are marked.
  Set it per group on the groups page, "Shown as".

## [0.3.3] - 2026-10-29

### Changed

- The package lists (`/admin/packages` and the home page of `read` credentials) are made from
  `_meta/packages.json`: its entries now carry the version numbers of each package, whether the
  newest is yanked and the listed name, written at publish, yank, delete and reindex. An admin's
  list costs one read of the bucket instead of a listing and a manifest per package (about 400
  calls for 200 packages), and far less CPU. Packages with an entry written by an older release
  are read as before and are given the description by the hourly cleanup, 20 packages an hour;
  reindexing a package does it at once. No migration is needed.

## [0.3.2] - 2026-10-29

### Changed

- Package groups can be nested five levels deep instead of three. Existing groups are unaffected.

## [0.3.1] - 2026-10-29

### Fixed

- The package lists (`/admin/packages` and the home page of `read` credentials) used far more CPU
  than they need, which pushed a registry of a couple of hundred packages over the CPU time limit
  of a request ("Worker exceeded CPU time limit", most of all on the free plan). Ordering the
  ecosystems called `localeCompare` with a locale, which builds a collator every time, and the
  names were sorted by keys made again on every comparison. A cold render of 200 packages now
  takes about a third of the CPU time it did.

## [0.3.0] - 2026-10-29

### Added

- Package groups, to organise the package list in the panel. Create groups (nested up to three
  levels) on `/admin/packages/groups`, and put packages in them with the new Organize mode of
  `/admin/packages`: check any number of packages, then move them to a group, to Ungrouped or to
  a new group. A package is in at most one group. The list shows "Ungrouped" first, then the
  groups as collapsible sections, a "Group" selector in the filter bar (the ecosystem chips became an "Ecosystem" selector too; both take several choices at once), and an admin's package page shows its
  group and can move it. The home page of `read` credentials uses the same groups, showing only
  the packages the credential may see. Groups change nothing about access, indexes or the API.
  They are stored in one KV value, `pkg-groups`.

## [0.2.5] - 2026-10-29

### Changed

- The package lists (the admin panel and the home page of `read` credentials) now sort by name
  ignoring case and everything but letters and digits, so scoped npm packages such as
  `@acme/ui` are listed among the `a` packages instead of before all others.

## [0.2.4] - 2026-10-29

### Added

- Browser login for `yank` and `delete`: `POST /api/v1/auth/sessions` accepts the purposes
  `yank` and `delete` with the versions (or, for a delete, whole packages) to approve. An
  `admin` credential approves them on `/authorize/<session>` (a delete is shown with a
  warning, a login with a one-time code needs a fresh code like for a publish) and the poll
  returns an `admin` token that lasts 15 minutes. The token carries `ops` and may call only
  the matching yank and delete routes and `whoami`; every other route answers `403`. `whoami`
  reports `ops`.

### Changed

- `_:gh.<jwt>` also resolves credentials with the `admin` role, on the routes that need that
  role alone (yank, delete, reindex, credentials, secrets, GitHub lookup, bucket accept).
  `publish` routes still pick `publish` credentials and every other route (`whoami`, the
  package listing, the native feeds, the panel login) still picks `read` credentials. A
  request that matches no credential of the needed role is `401 unauthorized`, and more than
  one is `401 unauthorized` ("more than one project matches this token; use
  <project>:gh.<jwt>").
- An `admin`-only `login` can sign in on the approval page of a yank or delete (not of a pull
  or publish).

## [0.2.3] - 2026-10-28

### Fixed

- The admin package list (`/admin/packages`) and the home page of `read` credentials failed with a `500` ("Too many API requests by
  single Worker invocation") on a registry with many versions, because it read every version
  manifest. They now read one manifest per package, the highest visible version's.

## [0.2.2] - 2026-10-28

### Added

- `admin` can be combined with `read` and `publish` in one credential, so an administrator can
  also install or publish with grants. `roles` takes any non-empty combination; a secret's
  `scope` may include `admin` (required with several roles, so a CI key never administers by
  accident). Adding a role to an existing admin leaves its secrets `admin`-only; the last
  credential with `admin` cannot lose it. Logins scoped to `read` or `publish` on such a
  credential issue login tokens.

### Changed

- The roles of a credential and of a secret are three on/off toggles (read, publish, admin) on the
  Grants tab, the create form and the add-secret and edit forms, instead of a read / publish
  switch; each says what the role lets it do.
- The legacy `kind` of a credential or token that may administer is `admin` even when it has
  other roles.
- The panel decides what to show from the roles of the session instead of one `kind`, and the
  header shows a badge for each role.

## [0.2.1] - 2026-10-28

### Added

- `MAX_PUBLISH_SCOPES` sets how many package versions one publish login token can approve
  (`sreg login --publish`, repeatable). The default stays 20; 1 to 100 is accepted. It is listed
  on the Settings page and the setup checklist. Lowering it does not end publish tokens that
  are already issued.
- A publish login whose approval link would exceed 8000 characters is refused with
  `invalid_request`, whatever `MAX_PUBLISH_SCOPES` says: the link carries the signed scopes, and
  long names make it grow fast.
- The roles of an existing secret can be changed: **Edit** in a secret's row (for credentials with
  both roles) opens the "Add a secret" panel for it, like editing a GitHub Actions secret. A key or
  a login keeps its value and id; `PATCH /api/v1/credentials/<project>/secrets/<id>` accepts
  `scope` besides `description` (`docs/api.md` 6.22). A panel session started with a login follows
  that login's scope at once.

### Changed

- The roles of a credential and the scope of a secret are chosen with a read / publish /
  read + publish switch like the rest of the panel instead of checkboxes, and the sections of the
  Grants tab have room between them.

### Fixed

- Two `gh` secrets with the same claims created in the same second got the same `id` (the scope is
  not part of it), so one could not be addressed; the second one's `created` now moves on until
  its `id` is free.

## [0.2.0] - 2026-10-28

### Added

- One credential can hold both `read` and `publish`, with a separate list of grants for each
  role (`read_grants`, `publish_grants`). Every secret has a `scope` (`read`, `publish` or
  both) that limits the roles it may use; it must be given when the credential has both roles.
  Adding a role never widens the secrets a credential already has, and panel sessions never
  carry `publish`. The `_:gh.<jwt>` login picks the credential by the role the request needs and
  the scope of the matching entry. A `login` secret (and the login token that `sreg login` obtains with it) carries the role it was approved for, `read` for a pull and `publish` for a publish, and respects the secret's scope. The panel's new-credential form, Grants tab and Secrets tab
  edit roles, grants per role and scopes. The API stays backwards compatible: `kind` and
  `grants` remain as the legacy view, `roles`, `read_grants`, `publish_grants`, `scope` and
  `whoami`'s `roles` and `access` are new. See `docs/api.md` 2.4, 6.12-6.17 and `docs/spec.md`.

### Requires migration

- Data schema version 4: `cred:*` records are rewritten from `kind` and a flat `grants` list to
  `roles` and `grants: { read, publish }`. It runs on the first request after the deploy and
  is idempotent; records are also read in either shape, so nothing fails during the rollout.
  An older Worker cannot read migrated records, so do not roll back across this release.

## [0.1.7] - 2026-10-28

### Added

- Admins see an **Update available** flag in the header of every panel page while a newer
  release exists; it links to Settings. The release is read from the cache, and a missing or
  stale answer is refreshed in the background, so no page waits for GitHub.

### Changed

- The update check on the Settings page is a box (amber for a new release, red for a failed
  check) with the instructions and the **Check now** link inside, and the "Up to date" line
  no longer repeats the version.

## [0.1.6] - 2026-10-28

### Added

- **Configure bindings** takes the `jurisdiction` of the R2 bucket (`eu`, `fedramp` or `none`).
  A bucket created in a jurisdiction needs it in `wrangler.jsonc`: without it a deploy binds
  the Worker to a bucket of the same name in the default jurisdiction, which is another, empty
  one. **Update from upstream** keeps the value (docs/deployment.md, "Configure bindings").

### Fixed

- The release workflow pushes the release commit and tag as the release GitHub App
  (`SERVERLESS_REGISTRY_RELEASE_APP_ID` and `SERVERLESS_REGISTRY_RELEASE_APP_PRIVATE_KEY`) when
  they are set. A ruleset that requires status checks on `main` rejected the push made with
  `GITHUB_TOKEN` (`GH013`, "Required status check is expected"); the App can be put on the
  ruleset's bypass list. Without the two values it still uses `GITHUB_TOKEN`.

## [0.1.5] - 2026-10-28

### Added

- **Two GitHub workflows for your own repository.** **Update from upstream**
  (`.github/workflows/update.yml`) brings the code of this project into your repository from
  the Actions tab: choose stable, prerelease, custom (a tag) or develop (upstream's `main`); it
  never goes to an older version than the repository has, settles a `wrangler.jsonc` conflict
  by keeping your bindings, name, routes and variables over upstream's file, checks the result
  with `wrangler deploy --dry-run` and pushes it to the default branch (a `dry_run` option
  shows the change only). Files of `.github/workflows` are updated only when the secret
  `UPDATE_TOKEN` is set. **Configure bindings** (`.github/workflows/configure.yml`) writes the
  R2 bucket, KV namespace, Worker name and custom domain into `wrangler.jsonc` from a form. The
  Settings page tells you to run the first one when a newer release exists (docs/deployment.md,
  "Updating with a workflow" and "Configure bindings").

- A **Check now** button next to the update check on the Settings page (`/admin/settings?check-updates=1`)
  asks GitHub right away, ignoring the cache, and the page lists the full error of each failed
  attempt (HTTP status, GitHub's message, network error) instead of a bare "could not check".

## [0.1.4] - 2026-10-28

### Added

- **Protection against a repointed R2 bucket.** The installation has an id, kept in KV
  (`installation_id`) and in the bucket (`_meta/installation.json`). When a deploy binds the
  Worker to another or a new bucket, the native protocols and the package and publish
  endpoints answer `503 bucket_mismatch` instead of working on the wrong bucket, no migration
  runs there and the hourly cleanup is skipped. The panel shows a banner; an admin confirms a
  bucket that really is the new one with **Use this bucket** or the new
  `POST /api/v1/bucket/accept`. An installation from before ids adopts its bucket on the
  first request after the update, so update while the binding is right (docs/deployment.md,
  docs/api.md 6.23).

### Fixed

- The update check no longer fails when GitHub rate-limits the shared outbound address of the
  Worker: it reads the `releases/latest` page redirect first (no API rate limit) and falls back
  to the API, and logs why each attempt failed (`wrangler tail`).
- The secrets table of a credential no longer grows wider than the page when the "Expire…"
  form is opened: the form wraps under the other buttons, and the one-card-per-secret layout
  starts below about 1056 px instead of 640 px.

## [0.1.3] - 2026-10-28

### Added

- **`login` secrets** for any credential: a password and an optional TOTP one-time code. An
  `admin` signs in to the panel with one; `read` and `publish` logins are also used on a new
  browser page, `/authorize/<session>`, where a person
  approves one operation started by the CLI, and give the CLI a short-lived signed login token
  (`<project>:st.<payload>.<signature>`) with the credential's kind and grants. A pull token
  lasts one hour (24 with extended validity, configurable with `LOGIN_TOKEN_EXTENDED_TTL_HOURS`);
  a publish token lasts 15 minutes and only allows the approved package versions, and is
  approved only when the credential's grants allow every one of them. New endpoints
  `POST /api/v1/auth/sessions` and `POST /api/v1/auth/sessions/poll`; `whoami` returns the
  `scopes` of a publish token; the panel's "add a secret" form has a _Login_ type.
- **Two-step sign-in** (the panel login and the approval page): the password, then the
  one-time code, between which a short-lived signed cookie (`sreg_pending`, 5 minutes, no
  password inside, valid only for that step) carries the sign-in. The panel login page now
  defaults to the login and password, with _Token_ as the other tab.
- **QR code** for the one-time code on the page that shows a new login's password (inline SVG
  made by a small built-in encoder, no library).
- **Descriptions** of secrets (`description`, at most 200 characters) on every secret type,
  editable with the new `PATCH /api/v1/credentials/<project>/secrets/<id>` and in the panel's
  secrets table.
- **Editing a GitHub Actions secret** in the panel: _Edit_ fills the form with the secret and
  saving adds a changed copy and, with the box ticked, expires the old one. The API takes
  `replaces` on `POST …/secrets` for this.
- `POST /api/v1/credentials` accepts `"secret": null` to create a credential without a secret;
  the panel's create form now starts with **None** as the first secret (or a key, or a login).

### Changed

- **Breaking for panel users:** session cookies now carry a payload type (`typ`) and are signed
  with a key derived from `SESSION_SECRET`; cookies from earlier versions are not accepted, so
  everyone signs in to the panel once more after the update. Static tokens are not affected.
- **A `key` is always a generated token and never a password:** `password` on a `key` secret is
  now `400 invalid_request` (use a `login`), and the first-run form and the panel forms no
  longer offer one. `admin` passwords stored as a `key` by earlier versions keep working.
- **First run creates a `login` secret** (a password and, optionally, a one-time code) instead
  of a generated `key` token for the first admin. Existing installations are not touched.
- Every view of a secret in `/api/v1` now has `description` (`null` when there is none).

## [0.1.2] - 2026-10-28

### Added

- The grants of a credential can be edited as text: **Edit as text** on the Grants tab and the
  new-credential form shows one grant per line in the CLI shorthand
  `eco:package[:versions[:transitive]]`, to copy and paste in bulk. The text is turned back into
  the rows before saving; the Worker validates the grants as before.

## [0.1.1] - 2026-10-28

### Added

- **Bump and release** workflow (`.github/workflows/bump-and-release.yml`, started by hand on
  `main`): computes the next version (`prerelease`, `patch`, `minor`, `release`, `custom`, …)
  with the dependency-free `scripts/bump-version.mjs`, sets it in `package.json`,
  `package-lock.json` and `src/version.ts`, rolls `CHANGELOG.md`, commits and tags
  `v<version>` and creates the GitHub Release (a prerelease for `-beta.N` versions, which the
  update check ignores).

## [0.1.0] - 2026-10-28

### Added

- English specification (`docs/spec.md`) and HTTP API contract (`docs/api.md`).
- Deployment guide (`docs/deployment.md`): the Deploy to Cloudflare button, a fork with the
  GitHub Actions workflow and a local deploy, the settings and secrets, the custom domain, the
  first run, updates, the free plan limits, backups and troubleshooting. The README leads with
  the deploy button and a quick start, and `wrangler.jsonc` explains its bindings and
  variables.
- Worker project scaffold: TypeScript, ESLint, Prettier, Wrangler configuration and tests
  running inside the Workers runtime.
- `GET /api/v1/version` endpoint.
- CI workflow and a GitHub Actions deploy workflow for forks.
- Adapter contracts (`Adapter`, `Manifest`, `IndexFile`, routes, snippets), the
  `ValidationError` class and JSON response helpers.
- Dependency-free version parsing and range evaluation in the npm, Composer and cargo
  dialects.
- Grant evaluation (package patterns, version constraints) and the `eco:package[:versions]`
  shorthand.
- Token parsing (`TOKEN_PREFIX`, sources, secret types) and normalisation of the Bearer,
  Basic and raw `Authorization` forms.
- Credential records in KV and verification of `key` secrets and GitHub Actions OIDC tokens
  (JWKS and positive verifications cached in KV).
- Panel sessions in KV with a 12-hour `sreg_session` cookie.
- Version manifests list one or more files (name, size, SHA-256, optional role and labels);
  `generic` and `nuget` ecosystems in the adapter contracts, with adapter-defined version
  validation and ordering.
- Dependency-free AWS Signature V4 presigning of R2 `PUT` (covering `content-length` and
  `x-amz-checksum-sha256`) and `GET` URLs.
- Installation settings helpers and the `R2_BUCKET_NAME`, `ECOSYSTEMS` and
  `APPEND_WINDOW_HOURS` variables.
- R2 storage layer: key layout, immutable manifest writes, version deletion, manifest and
  package listings, index files, optimistic read-modify-write with etag conditions,
  `_meta/packages.json`, appending files to a version (`409 file_exists`) and staging of
  uploads.
- Data schema migrations run once per isolate on the first request (`schema_version` in KV,
  best-effort `migrate:lock`); migration 1 creates `_meta/packages.json`.
- Hourly cleanup of uploads older than 24 hours and of expired auth entries.
- Adapter registry: adapters are created on first use and only the ecosystems enabled by
  `ECOSYSTEMS` are routed and listed; grant version constraints are validated by the
  ecosystem's adapter.
- Composer adapter: `composer.json` validation, Composer 2 minified `p2` metadata (newest
  first, yanked versions omitted, empty `~dev` file), per-credential `packages.json`, dist
  downloads and client configuration snippets (bearer, http-basic and token-in-URL).
- `POST /api/v1/publish/init` and `POST /api/v1/publish/commit` with one presigned `PUT` per
  file, staged object verification (`upload_incomplete`, `upload_mismatch`), idempotent
  commits and appending files to versions of adapters that support it (`version_closed`,
  `file_exists`).
- Package administration (`yank`, delete of a version or a package, `reindex`) and the
  credentials API (create, list, read, replace grants, delete, add and expire secrets), plus
  first-run helpers for creating the first admin.
- `GET /api/v1/packages` and `GET /api/v1/packages/<eco>/<name>` filtered by the caller's
  grants.
- Request routing: `/api/v1` with client version negotiation, JSON body limits, Bearer, Basic
  and raw tokens or the panel session cookie (`X-Requested-With` for mutations); native
  routes per enabled ecosystem with grant filtering and `302` redirects to presigned
  downloads; static assets for everything else.
- Transitive read grants (`transitive`, default `true`, also as the `:true`/`:false` shorthand
  suffix): the closure of the dependency constraints declared in the manifests (composer
  `require` and `require-dev`, yanked versions included) is served by the native protocol,
  cached in KV as `closure:<project>:<eco>` for 60 seconds and dropped on every publish,
  yank, delete, reindex and grant change; read entries of the package listings carry the
  `dependencies` each grant opens.
- Home page and admin panel rendered by the Worker (styles and a small dependency-free script
  served as static assets, `Content-Security-Policy: default-src 'self'`, no inline scripts):
  first-run creation of the admin with its token shown once, login with a token or a login
  and password (`POST /login`, `POST /logout`, 12-hour session cookie), the consumer view
  with the granted packages, their transitive dependencies and client configuration
  snippets, a publish-only notice, and the admin pages Packages, Credentials and Settings.
- Update check: with `CHECK_UPDATES=true` the Settings tab compares the running version with
  the latest GitHub release, fetched at most once a day and cached in KV (`updates:latest`).
- `gh` secrets store the optional `repository_id`, `repository_owner_id` and `environment`
  claims, a `ref` glob and an `owner/*` repository; the panel's add-secret form has the fields.
- `GET /api/v1/github/repository?name=owner/repo` (admin) returns a repository's ids from
  GitHub; the add-secret form's "Look up" button fills them in.
- `publish` credentials may hold `key` secrets; the panel offers them for every kind.
- npm adapter: scoped `package.json` manifests (fields starting with `_` dropped, the requested
  dist-tag recorded in the manifest's `meta`), the packument with tarball URLs, `sha256`
  integrity and `time`, dist-tags derived from the manifests (yanked versions removed, `latest`
  and `next` falling back to the highest stable and prerelease version) and recomputed for
  the versions each credential may see, single versions and dist-tags at
  `/npm/<name>/<version>`, tarball redirects, `ping`, `whoami`, `.npmrc` snippets (`_authToken`
  and `_auth`) and dependencies from every `package.json` dependency section.
- cargo adapter: index lines validated against the sparse index shape, lower-case crate names,
  one `<name>-<version>.crate` archive whose SHA-256 is the `cksum`, one sparse index file per
  crate with every version (yanked ones marked) and `v: 2`, `config.json`, `dl` redirects, a
  minimal `/cargo/api/v1/crates/<name>`, `config.toml`/`credentials.toml`/`Cargo.toml`
  snippets and dependencies from `deps[]` entries of this registry.
- Native routes for credential checks (`ping`, `whoami`) and configuration documents, index
  routes that select one entry or render another view, and `404` when the adapter's filter
  leaves nothing to serve (a cargo index file without visible versions, a hidden npm version).
- The reserved login `_:gh.<jwt>` resolves the project of a GitHub Actions token from its
  `repository` claim through the `gh-repo:<owner/repo>` and `gh-repo:<owner>/*` KV index:
  the matching credential of kind `publish` on `/api/v1/publish/*`, of kind `read` everywhere
  else (native protocols and the panel login included), never an `admin`; more than one match
  answers `401` asking for `<project>:gh.<jwt>`. Every credential write (API, panel, hourly
  cleanup) keeps the index in step, and data migration 2 builds it for existing credentials.
- Adapters may declare extra digests (`sha1`, `md5`, `sha512`): `commit` computes them while
  streaming each staged file to its final key (a `DigestStream` per algorithm, nothing
  buffered) and stores them as `files[].digests`, returned by the package listings and the
  yank response; `reindex` never recomputes them.
- `swift` and `maven` ecosystems in the adapter registry; `ECOSYSTEMS` defaults to all seven.
  Maven names
  (`group:artifact`) and Swift names (`scope.name`) keep `:` and `.` literally in R2 keys and
  grant patterns, Swift names match case-insensitively, and the grant shorthand splits Maven
  names correctly (`maven:com.acme:sdk:<versions>`).
- Generic adapter and feed (`/generic/…`): versions of any number of labelled files with a
  free-form `meta` (at most 64 KiB), appends within `APPEND_WINDOW_HOURS`, the package listing
  with each package's `latest`, package and version documents filtered by `?label=` and
  `?include=yanked`, `latest` with `?channel=prerelease`, `302` file downloads and client
  snippets for `curl` and `sreg generic get`.
- NuGet adapter and V3 feed (`/nuget/…`): NuGet versions (one to four parts, normalised form)
  and version ranges (minimums, intervals, exact and floating versions), `.nupkg` with an
  optional `.snupkg`, the service index, the flat container with `.nupkg` redirects and the
  `.nuspec`, an inlined registration index (`listed: false` for yanked versions), search,
  transitive access through dependency groups and `dotnet`/`nuget.config` snippets. A `401`
  on the feed carries a Basic challenge next to the Bearer one.
- Native JSON responses carry a strong `ETag` and answer a matching `If-None-Match` with
  `304`.
- Panel: `gh` secrets can pin their repository and owner ids on first use (a checkbox,
  checked by default), and entries still waiting for their ids are marked in the secrets
  table.
- Panel: admin credentials can use a chosen password (at least 12 characters, typed twice)
  instead of a generated secret, at first run, when creating an admin credential and when
  adding a key secret to one.
- Swift adapter and registry (`/swift/…`, SE-0292): `<scope>.<name>` identities matched
  case-insensitively (lower case in R2 keys, the published casing in responses), semver
  versions, the source archive plus `Package.swift` and its `Package@swift-X[.Y[.Z]].swift`
  variants (file names may contain `@`), one `releases.json` index per package, the release
  list (yanked releases with a `problem`), release metadata with `latest-version`,
  `successor-version` and `predecessor-version` links (`410` for a yanked release), manifests
  served from storage with SwiftPM's variant selection and `alternate` links, archive
  redirects with a `Digest` header, `GET /swift/identifiers?url=`, `POST /swift/login`,
  `Content-Version: 1` and problem details on every response, `415` for other API versions,
  transitive access through `registry` dependencies of `dump-package` and SwiftPM snippets.
- Maven adapter and repository (`/maven/…`): `ComparableVersion` ordering (no `-SNAPSHOT`
  versions), Maven version ranges (a plain version is a minimum in grants and exact as a
  dependency), file roles derived from the names (`pom`, `archive` by packaging, `sources`,
  `javadoc`, `module`, `extra`; checksum uploads rejected), `sha1`/`md5`/`sha512` digests
  computed at commit, `maven-metadata.xml` generated per credential from a JSON index
  (yanked versions left out) with its checksums, file redirects and file checksums, transitive
  access through `compile` and `runtime` dependencies and Maven/Gradle snippets.
- Swift and Maven `401` responses carry a Basic challenge next to the Bearer one.
- Adapter hooks for native responses: index filters may answer asynchronously and with their
  own status and headers, archive routes may serve small files inline from R2 and let the
  adapter pick the file and add headers (`selectFile`), static routes may set a status and
  content type, and `finalizeResponse` adjusts every response of an ecosystem.
- Generic feed: `?version=<range>` (npm syntax) on the package document and on `latest`
  (prereleases of a matching release with `?channel=prerelease`), and
  `GET /generic/<name>/<version|latest>/-/download?label=…`, which redirects to the single
  file the labels select (with `X-Resolved-Version` and `X-Resolved-File`) and answers
  `409 ambiguous` with the candidate files when several match. Archive routes can have their
  version resolved by the kernel through an index route (`resolve`), and error bodies can
  carry extra fields.

### Changed

- Specification version 8 and the matching HTTP API contract (including HMAC-signed panel
  session cookies, the Cache API for JWKS and the transitive closure, and no KV caches): a version is a list of files
  (`files[]` in manifests, `init`, `commit` and package listings), the new generic ecosystem
  with its JSON feed and appending files within `APPEND_WINDOW_HOURS`, the new NuGet
  ecosystem with its V3 feed, the Swift registry (SE-0292) and the Maven repository layout,
  adapter-defined version formats, transitive read grants with
  `dependencies` in package listings, CLI packaging and monorepo flags, the `_` login that
  resolves the project of a `gh` token through the `gh-repo:<owner/repo>` index, the full set
  of `gh` entry fields, optional `files[].digests`, ecosystems enabled through `ECOSYSTEMS`,
  and no administrative CLI commands. `/api/v1` changes in place because it has
  not been released yet.
- A panel session ends as soon as none of its credential's secrets is active any more.
- `gh` entries match every field of docs/api.md 2.5: `repository` case-insensitively or as an
  `owner/*` glob, `repository_id`, `repository_owner_id` and `environment` by equality, `ref`
  as a glob where `*` also matches `/`, and `workflow` against the workflow file path of the
  `workflow_ref` claim (previously the workflow's display name in the `workflow` claim).
- Data schema version 2 (migration 2 builds the `gh-repo:` index).
- Transitive access is computed from the dependency graph `_meta/deps/<eco>.json` in R2
  (`{ "<package>": { "<version>": { "<dependency>": "<constraint>" } } }`, yanked versions
  included; a dependency declared with several constraints lists them in an array), which
  `commit`, yank, delete and `reindex` update with the etag retry, so a closure costs one R2
  read instead of listing the manifests of every reachable package. The closure is cached
  per credential in the Cache API (`https://cache.internal/closure/<eco>/<project>`, 60
  seconds) instead of KV (`closure:<project>:<eco>`), with no invalidation: publications
  and grant changes reach transitive access within 60 seconds.
- Data schema version 3 (migration 3 builds `_meta/deps/<eco>.json` for every ecosystem from
  the existing manifests).
- The update check caches GitHub's answer in the Cache API
  (`https://cache.internal/updates/latest`, 24 hours, a failure for 1 hour) instead of KV
  (`updates:latest`).
- **Breaking:** `gh` tokens are verified on every request; the `ghok:` KV cache of positive
  verifications is gone. GitHub's JWKS is cached in the Cache API (`caches.default`, 24 hours,
  refetched after five minutes for an unknown key id) instead of KV (`jwks:github`).
- **Breaking:** panel sessions are signed cookies (`{ project, exp }` with HMAC-SHA256, 12
  hours) instead of `session:<id>` records in KV; logging out clears the cookie. The new
  `SESSION_SECRET` secret must be set, otherwise the panel login answers `500` naming it
  (API tokens keep working). Existing sessions end with the upgrade.
- Credential records and `gh-repo:` lists are cached in each Worker isolate for 60 seconds
  and replaced at once by the isolate's own writes.
- `gh` entries pin their repository on first use: with `pin_on_first_use` (stored explicitly,
  default `true`) the first matching token fills in a missing `repository_id` (exact entries)
  and `repository_owner_id`, after which the ids must match. Adding a secret through the
  credentials API accepts the field, and responses echo it.
- `admin` credentials may use a chosen password as a `key` secret (`password` when creating a
  credential, adding a secret or setting up the first admin; 12 to 128 printable characters
  without `:` or whitespace), stored as PBKDF2-SHA256 with 10 000 iterations; `read` and
  `publish` credentials answer `400`. The password part of a token is split into
  `<type>.<secret>` only when its first segment is a known type, so passwords may contain
  dots.
- Settings set in the dashboard survive deploys: `wrangler.jsonc` sets `keep_vars: true` and
  has no `vars` any more, so a deploy neither deletes plain-text variables nor resets them to
  the repository's values. `PUBLIC_URL` and `S3_ENDPOINT` may be plain variables. The defaults
  live in code and apply when a variable is unset: every ecosystem for `ECOSYSTEMS`,
  `536870912` for `MAX_UPLOAD_BYTES`, `24` for `APPEND_WINDOW_HOURS`, no `TOKEN_PREFIX`,
  `serverless-registry` for `R2_BUCKET_NAME`, and `CHECK_UPDATES` defaults to `true` (any
  other value than `true` disables the check). `.dev.vars.example` lists the five installation
  settings.
- The consumer view of the panel lists every package in one list sorted by name instead of a
  section per ecosystem: each row shows an ecosystem badge, the number of versions and the
  latest version (marked when yanked), and a filter bar narrows the list by name and
  ecosystem. Versions, dependencies and the configuration snippets moved to the new package
  page (`/packages/<eco>/<name>`), with snippets for that one package and the `<token>` note
  shown once; the new version page (`/packages/<eco>/<name>/<version>`) lists the files with
  sizes and checksums and downloads them through a presigned redirect. The layout is calmer:
  one card per package, more whitespace, snippets framed with a header row.
- The Settings tab shows, for a variable that is not set, the default the Worker uses (marked
  "(default)") instead of "not set".
- Package page: the configuration is collapsed under "Configuration and installation", every
  snippet has a one-line description, and alternative ways to set up the registry (a command,
  files, environment variables, Maven or Gradle) are shown one at a time in a chooser that
  works without JavaScript. Every adapter offers the command and environment-variable variants
  its client supports (`Snippet` gained the optional `description`, `group` and `variant`).
  The generic page shows an `sreg generic get` example built from a label the package really
  has; the adapter's own snippets use placeholders instead of
  made-up labels.
- Version page: a collapsed "Get exactly this version" with the adapter's pinned install
  snippets (new optional `Adapter.versionSnippets`), which replaces the "Native URL" line in
  the files table; generic versions show their `meta` (only here, not on the package page).
  The collapsed "Dependencies" of the package page has no explanatory sentence.
- Sizes use binary units (`KiB`, `MiB`, `GiB`) on every page, and the admin Packages tab links
  each package to its package page.
- The package filter says "Showing N of M packages." while a filter is active.
- The admin panel has pages instead of tabs: the header links **Packages**, **Credentials**
  and **Settings**, and `/` opens `/admin/packages`. Packages are managed on each package's
  page (yank, delete a version, reindex, delete the package after typing its name);
  credentials have a list with a filter (which counts like the package filter), a "New credential" form and a page each with its
  overview, grants, secrets and a danger zone. A new token is shown once on the page that
  answers the form.
- The login page is a centred card with a Token / Login & password switch, "show" buttons on
  the secret fields and a link to the documentation; the first-run and token pages share the
  card.
- The first run and the admin **Settings** page show a setup checklist: every installation
  setting as Set, Missing or Default (never a secret's value), how to add a missing one and,
  for `SESSION_SECRET`, a value generated in the browser. While `SESSION_SECRET` is missing,
  the first run shows only the checklist instead of creating an admin who could not sign in.
- The page of a credential is split into server-rendered tabs (`?tab=overview|grants|secrets|danger`,
  plain links that work without JavaScript): the overview links its counts to the other
  tabs; on the Secrets tab the date of "Expire" stays hidden until "Expire…" is pressed (inline
  without JavaScript) and the "Add a secret" form is collapsed behind a primary button
  (`?tab=secrets&add=1` opens it); the danger zone has a tab of its own. A `gh` secret added
  in the panel goes back to `?tab=secrets` instead of `#secrets`.
- An admin's package page has the collapsed "Dependencies" too: every package of the registry
  that any version depends on, with the constraints and the versions they admit.

### Fixed

- A password chosen for a new admin credential in the panel was ignored and a token was
  generated instead.
- `/api/v1/packages/<eco>/<name>` paths (package view, yank, delete, reindex) match NuGet and
  Swift names case-insensitively and accept NuGet versions in any form that normalises to the
  stored one, as docs/api.md 1.3 says; package listings show NuGet and Swift names with the
  casing of the highest visible version.

- Panel form posts (`/first-run`, `/login`, `/logout`) no longer answer `403` in browsers:
  pages are served with `Referrer-Policy: same-origin` instead of `no-referrer`, and a post
  with `Origin: null` or no `Origin` is accepted when `Sec-Fetch-Site` is `same-origin` or
  `none` (anything else without the registry's own origin is refused).
- The "Copy" button of code blocks sits above the block instead of covering it on narrow
  screens, and the "Look up" button no longer wraps and is as tall as the repository field.
- Spacing in the panel: sections of a credential card are set apart, card headings start at
  the card's top, and the card of the current tab joins the tabs bar.
- The grants of a credential card are headed once instead of twice.
- The `transitive` option is hidden for publish grants, where it has no effect.
- The version tables of the Packages tab have fixed columns that line up across packages.
- Every claim value of a `gh` secret (repository, ref, workflow, ids, environment) is shown in
  code style.
- The consumer view omits "Dependencies" for packages that have none.
- Input placeholders are lighter, and the first-run example reads "e.g. admin".
- Package, version and download routes of the panel find npm, Composer, NuGet and Swift
  packages whatever the casing of the name in the URL (`/packages/nuget/Acme.Sdk`), and the
  pages show NuGet ids and Swift identities with their published casing.
- The secrets table keeps dates on one line and gives the details the remaining width.
- The ecosystem chips of the filter bar are centred vertically.
- The first-run intro covers both a generated token and a chosen password.
- On an admin's package page the "Yank" and "Delete" of every version sit in one right-aligned
  actions cell, so the dates and "Delete" of a yanked version line up with the other rows.
- The Settings page shows the value of `R2_BUCKET_NAME` (or its default) like the other plain
  variables.
- Every admin page (Packages, Credentials, New credential, a credential, Settings) uses the
  same content width, so the left edge no longer moves between them.
- Every "Copy" button is outlined (the ones of the setup checklist and token pages were filled).
- The login card no longer moves when switching between Token and Login & password: the
  centred pages hang their card from a fixed distance below the top, and on phones the
  segments of the switch keep their text off the edge.

[Unreleased]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.3.6...HEAD
[0.3.6]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.2.5...v0.3.0
[0.2.5]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.1.7...v0.2.0
[0.1.7]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/kduma-OSS/serverless-registry-worker/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kduma-OSS/serverless-registry-worker/releases/tag/v0.1.0
