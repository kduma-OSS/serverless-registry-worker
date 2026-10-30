# Serverless Registry – specification

## Goals and assumptions

We are building a private, serverless package repository for Composer, npm, cargo, NuGet, Swift, Maven (Java/Kotlin/Android) and arbitrary files (generic), hosted entirely on Cloudflare (Workers, R2, KV), with publishing done through our own CLI written in Rust. It is the successor of the current Serverless Satis solution: a new deployment, a new address, no backwards compatibility.

**What we build**

- A Worker serving the native read protocols of six ecosystems plus a simple JSON feed for generic files, from a single R2 bucket.
- A push model: the CLI packs and uploads a version in the publishing pipeline (GHA); the Worker owns the index.
- Named credentials per consumer project, with grants for packages and version ranges, safe to commit into the consumer's repository.
- Versions are immutable from the CLI; an admin can delete or yank a version.
- All file transfer goes through presigned URLs to R2 (upload and download); the Worker serves metadata only.
- A home page with login, a list of available packages and ready-to-use configuration instructions; a minimal admin panel.
- Open source, deployable with one button, updated by syncing the fork.

**What we do not build**

- Scanning of VCS repositories (pull) – replaced by push from the CLI.
- Publishing endpoints for native clients (`npm publish`, `cargo publish` straight to the Worker) – publishing happens exclusively through the CLI.
- An audit log, Durable Objects, Cloudflare Access, front-end frameworks, external dependencies in the panel.
- Mirroring of public registries.

## Architecture

One Worker with a shared kernel and seven adapters, one R2 bucket as the source of truth, one KV namespace for credentials. Indexes are derived from manifests, not separate state.

_Architecture diagram (5 components):_ the package manager clients (Composer, npm, cargo, NuGet, Swift, Maven/Gradle), HTTP clients of the generic feed and the `sreg` CLI talk only to the Worker for metadata; the Worker reads and writes the R2 bucket (package files, manifests, indexes) and the `AUTH` KV namespace (credentials, the `gh-repo` index, schema version); file bytes flow directly between the clients/CLI and R2 through presigned URLs; the hourly cron (`scheduled` handler of the same Worker) cleans up R2 staging and expired secrets in KV.

The Worker never passes archive bytes through itself: the CLI uploads them with a presigned PUT, and clients get a `302` to a presigned GET; only indexes, manifests and the page go through the Worker.

| Component          | Role                                                                      | Technology                                      |
| ------------------ | ------------------------------------------------------------------------- | ----------------------------------------------- |
| Worker             | Auth, publishing API, serving indexes, redirects to files, page and panel | TypeScript, Workers Static Assets for HTML/CSS  |
| R2                 | Package files, version manifests, generated indexes                       | R2 binding + S3 API key (secret) for presigning |
| KV                 | Credentials, the `gh-repo` index, `schema_version`                        | `AUTH` binding                                  |
| CLI                | Packing and publishing versions from CI                                   | Rust, binaries in GitHub Releases               |
| Cron (`scheduled`) | Cleaning up uncommitted uploads and expired secrets                       | handler in the same Worker                      |

**Kernel** (`src/core/`): parsing and verifying credentials, evaluating grants, SigV4 presigning, writing manifests and rebuilding indexes with optimistic concurrency, routing to adapters, sessions, cron.

**Adapter** (`src/adapters/<eco>/`): knows how to extract the name, version and dependencies from an archive and manifest, how to build its ecosystem's index from a list of manifests, and how to filter it for a given credential. It does not touch auth or R2 directly.

**The index as a derivative.** Every version is, in R2, a `manifest.json` (normalised metadata) plus its files (usually one: the archive). Indexes (`p2/*.json`, the npm packument, cargo sparse index files) are generated from the manifests at publish time and cached in R2; an admin can rebuild them from the listing. Per-credential filtering (explicit grants plus the dependency closure, see Credentials) happens on the fly when serving, so a consumer with a limited grant never sees versions it has no access to.

## Credentials

One credential = the identity of a project (a consumer, a package's CI, both, or an admin) with one or more roles, grants per role and a list of auth entries, each limited to some of the roles. The record comes from KV or from an external HTTP provider. The token is `[<source>.]<project>:[<type>.]<secret>` – a login:password pair in one string, which works as Bearer, Basic and as a raw header.

**Token format**

```text
[<source>.]<project>:[<type>.]<secret>

shop-frontend:k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e          KV, static key (default type)
ci-acme-sdk:gh.eyJhbGciOi….eyJpc3Mi….SflKxw…              KV, GitHub OIDC
okta.shop-frontend:Zm9vYmFy…                            provider "okta", key
okta.ci-acme-sdk:gh.eyJ…                                provider "okta", OIDC
```

- The colon separates the identity (login) from the credential (password); nothing on the left is secret, nothing on the right ever reaches the logs.
- `source` (optional): a provider identifier from `vars.AUTH_PROVIDERS`; absent = record in KV.
- `project`: a slug `[a-z0-9][a-z0-9-]{1,62}`, unique within the source.
- `type` (optional): the kind of secret – `key` (default, omitted), `gh` (a JWT from GitHub OIDC) or `st` (a signed login token, below); more types in the future.
- `secret`: for `key`, 32 base62 characters (~190 bits), generated by the Worker and shown once; for `gh`, the whole JWT (it contains dots – irrelevant, because the secret is everything after the type); for `st`, `<payload>.<signature>`.
- An optional fixed prefix (e.g. `srg_`) in front of the whole token, to detect leaks with grep; enabled with the `TOKEN_PREFIX` flag.

**Parsing**: 1) split at the first colon into login and password; 2) login: one segment → project, two → `source.project`; 3) password: no dot → type `key`, with a dot → the first segment is the type, the rest is the secret. The lists of providers and types are used only for validation, not for determining boundaries.

**Login `_` (identity from the JWT)**: the reserved login `_` (not allowed by the slug regex) means "the project follows from the credential" and is allowed only with the `gh` type: `_:gh.<jwt>`. The Worker verifies the JWT as usual and then, using the `gh-repo:<owner/repo>` index in KV (a list of projects, maintained on every credential write in the panel/API), picks the credential whose `gh` entry matches the `repository`/`ref`/`workflow` claims. Ambiguity is resolved by the role the request needs: the publishing endpoints pick credentials with the `publish` role, the routes that need the `admin` role alone (yank, delete, reindex, credentials, secrets, the GitHub lookup, bucket accept) pick the `admin` role, every other route picks the `read` role, and only an entry whose `scope` covers that role counts, so one repository can be a consumer and a publisher at the same time, in two credentials or in one. When more than one project matches for the given role → `401` with a message saying that the project must be given. `whoami` and `publishedBy` record the resolved name, never `_`.

**Authentication forms accepted by the Worker**

| Header                                         | Who sends it                                                        | Normalisation                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Authorization: Bearer <token>`                | Composer (`bearer`), npm (`_authToken`), CLI, cargo                 | parser as above                                                                                                           |
| `Authorization: Basic base64(<token>)`         | Composer (`http-basic`), npm (`_auth`), cargo (`token = "Basic …"`) | the Basic login and password are exactly the two sides of the colon in the token; after decoding, the string is the token |
| `Authorization: Basic base64(<login>:<token>)` | the user pasted the whole token as the password                     | the password contains a colon → treated as the full token, the login must match, otherwise `401`                          |
| `Authorization: <token>` (raw)                 | cargo with `token = "<token>"`                                      | as Bearer                                                                                                                 |

| Token                           | Login                | Password            |
| ------------------------------- | -------------------- | ------------------- |
| `shop-frontend:k7Qx…`           | `shop-frontend`      | `k7Qx…`             |
| `ci-acme-sdk:gh.eyJ….eyJ….Sfl…` | `ci-acme-sdk`        | `gh.eyJ….eyJ….Sfl…` |
| `okta.shop-frontend:Zm9v…`      | `okta.shop-frontend` | `Zm9v…`             |
| `okta.ci-acme-sdk:gh.eyJ…`      | `okta.ci-acme-sdk`   | `gh.eyJ…`           |

**Record sources** – an interface `CredentialSource { resolve(project, type, secret): Record | null }` with two implementations:

- `KvSource` (no source prefix): reads `cred:<project>` and verifies the secret with the verifier for its type: `key` → SHA-256 compared in constant time with every active entry; `gh` → the JWT signature checked against the keys from `https://token.actions.githubusercontent.com/.well-known/jwks` (cached for 24 h), `iss`, `aud` = `PUBLIC_URL`, `exp`, and the `repository`/`ref`/`workflow` claims against the entry in the record; the JWKS is cached in the Cache API (24 h), and the JWT itself is verified on every request – an ES256/RS256 signature costs a fraction of a millisecond, while a cache in KV would eat up the write limit.
- `HttpSource` (`<source>` from `AUTH_PROVIDERS`): `POST <url>` with `Authorization: Bearer <shared secret from vars>` and the body `{ "project", "type", "secret" }`; the provider answers `200` with a record in the same shape as in KV (`roles`, `grants`, optionally `expires`, `cacheSeconds`) or `403`. Positive answers are cached in the Cache API under the hash of the whole token (TTL from `cacheSeconds`, default 60 s, max 300 s), negative ones for 10 s. Provider unavailable → `503` for tokens from that source, never a fallback to no auth. Projects from providers are not editable in the panel; logging in with them works normally.

`admin` credentials are always local in KV. `whoami` and `publishedBy` in the manifest record `[<source>.]<project>`.

**Version 1** implements the parser for the full format, `KvSource` and the `key`, `gh` and `st` types (for both roles); `HttpSource` is reserved and described here so that the format does not change when it is added.

**Record in KV** (`cred:<project>`):

```json
{
  "project": "shop-frontend",
  "roles": ["read"],
  "auth": [
    { "type": "key", "hash": "sha256:…", "created": "2026-10-28", "expires": null },
    { "type": "key", "hash": "sha256:…", "created": "2026-06-01", "expires": "2026-11-11" },
    {
      "type": "gh",
      "repository": "acme/shop-frontend",
      "repository_id": "123456789",
      "ref": "refs/heads/main",
      "workflow": null
    }
  ],
  "grants": {
    "read": [
      { "eco": "composer", "package": "acme/*", "versions": "*" },
      { "eco": "npm", "package": "@acme/sdk", "versions": "^2.0", "transitive": false },
      { "eco": "cargo", "package": "acme-core", "versions": ">=1.4, <2" }
    ],
    "publish": []
  }
}
```

A credential that is both a consumer and a publisher has `"roles": ["read", "publish"]`, a list of grants under each role, and a `scope` on every secret:

```json
{
  "project": "acme-sdk",
  "roles": ["read", "publish"],
  "auth": [
    {
      "type": "key",
      "hash": "sha256:…",
      "scope": ["read"],
      "created": "2026-10-28",
      "expires": null
    },
    {
      "type": "gh",
      "repository": "acme/acme-sdk",
      "ref": "refs/tags/v*",
      "scope": ["publish"],
      "created": "2026-10-28",
      "expires": null
    }
  ],
  "grants": {
    "read": [{ "eco": "composer", "package": "acme/*", "versions": "*" }],
    "publish": [{ "eco": "composer", "package": "acme/acme-sdk", "versions": "*" }]
  }
}
```

Records written before roles existed (`"kind": "read"` and a flat `"grants": [...]`) read as `roles: [kind]` with the list under that role; data migration 4 rewrites them.

A `gh` entry matches the claims of a GitHub Actions JWT; every field except `repository` is optional and means "any" when omitted or `null`:

| Field                 | JWT claim             | Value                                                                                                                                                                                                                                                                                  | Example                           |
| --------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `repository`          | `repository`          | required; `owner/repo` or a glob `owner/*`                                                                                                                                                                                                                                             | `acme/shop-frontend`              |
| `repository_id`       | `repository_id`       | numeric id of the repository (a string); recommended, because an owner/repo name can be taken again after the repository is deleted, an id cannot; the panel fills it in automatically from the GitHub API once the name is entered (for public repositories) or it is entered by hand | `"123456789"`                     |
| `repository_owner_id` | `repository_owner_id` | numeric id of the organisation or user; useful with an `owner/*` glob instead of `repository_id`                                                                                                                                                                                       | `"98765"`                         |
| `ref`                 | `ref`                 | glob over the full name of the ref                                                                                                                                                                                                                                                     | `refs/heads/main`, `refs/tags/v*` |
| `workflow`            | `workflow_ref`        | path of the workflow file in the repository (without `owner/repo@ref`)                                                                                                                                                                                                                 | `.github/workflows/release.yml`   |
| `environment`         | `environment`         | name of the GHA environment                                                                                                                                                                                                                                                            | `production`                      |
| `expires`             | –                     | as for `key`: expiry date of the entry                                                                                                                                                                                                                                                 | `2027-01-01`                      |

For `publish`, at least `ref: refs/tags/v*` or `workflow` is recommended, so that only the release workflow can publish, not any PR. The `iss`, `aud`, `exp` and `nbf` fields are checked by the kernel, not by the entry.

- `roles`: `read` (consumer: installation, token committed in the consumer's repository), `publish` (a package's CI: only `init`/`commit`, no reading of indexes; token in GHA secrets), both, `yank` and/or `delete` (an account that may only yank or delete the versions its grants cover, with a key, a `gh` entry or a browser login; no administration), and/or `admin` (panel and administrative API; yanks and deletes anywhere). Any combination is allowed: an `admin` that also holds `read` or `publish` is one identity whose secrets are told apart by their scope.
- `scope` (on every `auth` entry): the roles that secret may use, a non-empty subset of the credential's roles. This is what keeps a token with write permission out of a consumer's repository now that one credential can hold both roles: the `key` committed to a consumer's repository gets `["read"]`, the `gh` entry of the release workflow gets `["publish"]`. When creating a secret for a credential with several roles the scope must be given (it may include `admin`, so that a key for CI never administers by accident); with a single role it is that role and need not be stored. A secret never gains a role: adding a role to a credential (`read` to an `admin`, say) leaves its existing secrets with the roles they had. A secret authenticates a request only for a role in its scope; for any other the answer is `403`, and the `_` login ignores entries whose scope lacks the role the request needs. Panel sessions (cookies) never carry `publish`.
- `yank` and `delete` each have their own list of grants (`yank_grants`, `delete_grants`) in the same shape as the others; `transitive` means nothing there. Deleting a whole package needs a `delete` grant for it with `versions: *`. An `admin` needs no grants for either. The Worker checks these grants on every yank and delete, and a browser login for a yank or delete is approved only when they cover every operation it names.
- `admin` has no grants of its own: a secret with the `admin` role sees and manages everything and is used by a human in the browser (panel) or directly through the API; to install or publish with grants, an administrator holds the `read` or `publish` role too, on separate secrets.
- `grants.package`: an exact name or a `*` glob at the end of a segment; `grants.versions`: a semver constraint in the syntax of the given ecosystem, evaluated in the Worker, `*` = all. No grant for an ecosystem = no access. The `read` grants say "what you may install", the `publish` grants "what you may release"; they are separate lists, so a credential may install `acme/*` and publish only `acme/sdk`.
- `grants.transitive` (`read` only, default `true`): the grant also covers the package's dependencies that are in this registry. The Worker computes the closure from the **constraints** declared in the manifests (`native`): starting from the versions covered by the grant, it takes their dependencies that point to packages of the same ecosystem in the registry, admits the versions that satisfy the constraint, and so on recursively. The result is exactly the set of versions the consumer's resolver may legitimately choose: A `1.x` with `"B": "^1.1"` gives access to B 1.1.0 and 1.4.0, but not to B 2.0; when A 1.5 declares `"B": "^2.0"`, the closure extends by itself. `optional`, `dev` and `peer` dependencies count like normal ones. Transitive access is not a grant on B: a consumer that wants B directly, with its own, wider constraint, needs an explicit grant. `generic` declares no dependencies, so it does not take part. `publish` always requires an explicit grant for every package it releases. The closure is computed from the dependency graph `_meta/deps/<eco>.json` in R2 (updated at commit, yank and delete together with the index) and cached in the Cache API with a TTL of 60 s – with no writes to KV and no invalidation.
- `auth`: a list of credentials of different types; it enables rotation without changing the identity or the grants (the admin adds a new entry, sets `expires` on the old one, the cron removes expired ones) and combining types: a consumer credential usually has a `key` (committed, for humans) and optionally a `gh` (for the consumer's CI, with no secret in the repository); a `publish` credential usually has `gh`, and optionally also `key` (e.g. for publishing from outside GitHub Actions); a credential with both roles scopes each secret. The JWT exists only inside a GitHub Actions job, so `gh` never replaces `key` for local work.
- KV is eventually consistent (up to ~60 s for propagation); for token revocation this is acceptable.

**`login` entries and browser login.** Any credential may hold `login` entries (one whose scope has neither `read` nor `publish` is for the panel and for approving a yank or delete, and never issues a pull or publish token): a password (PBKDF2) and, optionally, a TOTP shared secret (stored AES-GCM encrypted under a key derived from `SESSION_SECRET`, because it has to be recoverable). A login is never sent as a token. A person uses it on `/authorize/<session>` to approve one operation started by the CLI (`sreg login`, `sreg auth <eco> --login`, `sreg <eco> publish --login`, `sreg generic get --login`, `sreg yank --login`, `sreg delete --login`), and the CLI then collects a short-lived **login token** `<project>:st.<payload>.<signature>` that carries one role – `read` for a pull login, `publish` for a publish login, `admin` for a yank or delete login – and the grants of that role; the credential must hold the role and the login's `scope` must include it. A yank or delete token is limited to the approved operations (`ops`: yank of exact versions, delete of exact versions or of whole packages) and to the matching routes, lasts 15 minutes and needs the same fresh one-time code as a publish; the page shows a delete with a warning. A publish token is limited to the approved `{eco, package, version}` list; the page approves only when every one of them is within the credential's `publish` grants, and when the login has a one-time code a publish needs one verified in the last 15 minutes. Tokens are stateless – an HMAC-signed `{ typ: "st", project, entry, exp, scopes?, ops? }` – and are checked on every request against the credential's still-active `login` entry, so removing or expiring that entry revokes them. The browser session (cookie) is created by the same sign-in, in two steps when the entry has a one-time code: the password, then the code, between which a short-lived signed cookie (`sreg_pending`, `typ: "pending"`, 5 minutes, limited to the path of the step, no password inside, opening nothing) carries the sign-in. The panel login works the same way and defaults to the login and password. A `key` is always a generated token and never a password (an `admin` password stored as a `key` by an older version still verifies). Every secret has an editable description; a `gh` secret is "edited" by adding a changed copy that replaces (expires) the old one. The only KV write of a login is the approval (`login-session:<nonce>`, a few minutes), because creating the session writes nothing: the session id is a signed value. See docs/api.md 2.6 and 6.20–6.21.

**Panel session**: after login, the Worker issues an `HttpOnly; Secure; SameSite=Lax` cookie containing a payload `{ typ: "sess", project, exp }` (a session started with a `login` entry also has `entry` and `totp_at`) signed with HMAC (a key derived from `SESSION_SECRET` and the payload type, so a cookie and a login token never verify as each other), valid for 12 h – with nothing written to KV; the lack of revocation before expiry is acceptable at this horizon, and changing `SESSION_SECRET` invalidates all sessions.

## Data layout

R2 holds archives and manifests as the source of truth, and indexes as a cache; KV holds only credentials (with the `gh-repo` index), the package groups and the schema version.

**Keys in R2**

| Key                                        | Contents                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `<eco>/pkg/<name>/<version>/manifest.json` | normalised version manifest (below)                                                |
| `<eco>/pkg/<name>/<version>/<file>`        | version files: `.zip` (composer), `.tgz` (npm), `.crate` (cargo), any (generic)    |
| `<eco>/index/…`                            | indexes generated from manifests, in the layout required by the ecosystem          |
| `_staging/<upload-id>/<file>`              | file uploaded via presign, not yet committed                                       |
| `_meta/packages.json`                      | list of all packages per ecosystem, with the description of their versions (below) |
| `_meta/installation.json`                  | the installation id (`{ "id": … }`), the same as `installation_id` in KV           |
| `_meta/deps/<eco>.json`                    | dependency graph of the ecosystem for transitive grants (below)                    |

The package name in the key is encoded safely: `/` and `@` in composer/npm names are replaced (`acme/sdk` → `acme__sdk`, `@acme/sdk` → `@acme__sdk`), so that listing by prefix is unambiguous. Generic names are encoded the same way (`acme/plugin-foo` → `acme__plugin-foo`). Composer names cannot collide under this encoding, because Composer forbids consecutive separators; npm names could collide only through a scope that itself contains `__`, because decoding reverses only the first `__` (`@a__b/c` and `@a/b__c` both become `@a__b__c`).

**Version manifest** (common format, the adapter fills in `native`):

```json
{
  "eco": "npm",
  "name": "@acme/sdk",
  "version": "2.3.1",
  "files": [
    { "name": "sdk-2.3.1.tgz", "size": 48213, "sha256": "…", "role": "archive", "labels": {} }
  ],
  "published": "2026-10-28T10:12:00Z",
  "publishedBy": "ci-acme-sdk",
  "yanked": false,
  "native": { "...ecosystem-specific fields, e.g. deps, dist-tags, autoload..." }
}
```

`files` is a list: `role` identifies a file within the ecosystem. The kernel requires only a non-empty list with unique names; the adapter decides about roles: composer, npm and cargo require exactly one `archive` file (and may allow additional ones, e.g. `attestation` for npm provenance), generic does not use `role` but filters by arbitrary `labels` instead. Both fields are optional in the kernel.

`native` is literally what the adapter needs to reproduce the entry in the index: for composer the whole `composer.json` of the version, for npm the `versions[v]` entry of the packument, for cargo the index line (`deps`, `features`, `cksum`).

`files[].digests` (optional): additional digests besides `sha256`, e.g. `{ "sha1": "…", "md5": "…" }`, needed by ecosystems whose clients verify other algorithms (Maven). The adapter declares in `init` the list of required algorithms (`digests: ["sha1", "md5"]`), and the Worker computes them at `commit` while streaming the object from staging to its target key, and stores them in the manifest. Without a declaration by the adapter nothing is computed; `reindex` does not recompute digests. The `sha256` field stays mandatory and separate: it is the only digest that the CLI computes before sending, that the Worker enforces in the presign (`x-amz-checksum-sha256`) and checks at `commit`, so it is the proof of the upload's integrity, while `digests` are only derivatives for clients.

**Keys in KV**

| Key                     | Contents                                                                       | TTL           |
| ----------------------- | ------------------------------------------------------------------------------ | ------------- |
| `cred:<project>`        | credential record                                                              | none          |
| `schema_version`        | integer                                                                        | none          |
| `installation_id`       | the id that must match `_meta/installation.json` in the bucket                 | none          |
| `gh-repo:<owner/repo>`  | list of the projects with a `gh` entry for this repository (for the `_` login) | none          |
| `pkg-groups`            | the package groups of the panel and the packages in them (below)               | none          |
| `login-session:<nonce>` | the approval or refusal of a browser login, until the CLI collects it          | a few minutes |

KV holds only state changed by a human (credentials, the `gh-repo` index, the package groups, the schema version). Everything that is a cache or derived data lives outside KV, because the free plan allows only 1,000 writes and 1,000 deletes a day:

| Data                              | Where                                                                           | Why not KV                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| closure of transitive grants      | computed from `_meta/deps/<eco>.json` in R2, cached in the Cache API (TTL 60 s) | a write after every publication × every credential, plus invalidation through `list` + `delete`, would exhaust the limits |
| GitHub JWKS, `HttpSource` answers | Cache API                                                                       | a per-colo cache with a TTL is enough                                                                                     |
| verified JWTs                     | not cached – verified on every request                                          | every CI job is a new JWT = a write                                                                                       |
| panel sessions                    | signed cookie (HMAC, `SESSION_SECRET`)                                          | zero writes                                                                                                               |
| credential record                 | KV + a cache in the isolate's memory (TTL 60 s)                                 | limits KV reads, because consecutive requests of one installation usually hit the same isolate                            |

`_meta/deps/<eco>.json`: the graph `{ "<package>": { "<version>": { "<dependency>": "<constraint>" } } }`, updated at `commit`, yank and delete together with the index (the same `onlyIf`).

`_meta/packages.json`: `{ "<eco>": { "<package>": { "versions": 3, "updated": "<RFC 3339>", "names": ["1.0.0", "1.1.0", "1.2.0"], "latestYanked": false, "display": "Acme.Sdk" } } }`, keyed by the decoded name. `versions` is the number of versions (yanked ones included) and `updated` the time of the last change. `names` (every version, lowest first by the ecosystem's order), `latestYanked` (whether the newest version is yanked) and `display` (the name the lists show, only when it differs from the stored one: the casing NuGet and Swift were published with) describe the versions so that the package lists of the panel need no listing of the bucket and no manifest: for an admin the home page and `/admin/packages` are made from this one file, and a `read` credential's from it too, plus the manifest of its newest visible version when that is not the newest one (for its `yanked` flag). They are written together with the index at `commit`, yank, delete and reindex, from the manifests the Worker has just read; the file is derived data and a stale or damaged description is repaired by reindexing the package. An entry without `names` (written by an older release, or with a `names` that disagrees with `versions`) is read like before, with one listing and one manifest read for the package, and the hourly cleanup gives up to 20 such packages an hour the description, so a registry upgraded from an older release catches up on its own.

**Package groups** (`pkg-groups`): labels that organise the package list in the panel and on the home page of `read` credentials, and nothing else: no grant, index, native protocol or `/api/v1` response knows about them. One JSON value, global to the installation: `{ "groups": [{ "id", "name", "parent", "visibility" }], "packages": { "<eco>:<name>": "<group id>" } }`. `id` is a short random string, `parent` is the id of the enclosing group or `null`, and `visibility` (stored only when it is not the default `visible`) is `collapsed` (the group is closed in the list until opened) or `hidden` (the group, its subgroups and every package in them are left out of the package lists for everybody, until an admin asks to see the hidden groups; they only organise the lists, so access, the package pages and the protocols are unaffected). A group inside a hidden group is hidden too; deleting a group moves its packages and subgroups up with their own visibility, so what was inside a hidden group is shown like the group above. Groups nest at most 5 levels deep, an installation has at most 200, a name has 1–60 characters and is unique among its siblings (ignoring case and everything but letters and digits). A package is in at most one group (the map holds one group per package), or in none, "Ungrouped". A package's key is `<eco>:<name>`, the name as listed (NuGet and Swift in lower case, because their listing follows the casing of the newest manifest). A value that is inconsistent (an unknown parent, a cycle, too deep, an assignment to a missing group) is repaired when it is read by moving the group to the top level or dropping the entry. It is written only by an admin's action, read through the isolate cache (60 s) like a credential, and a write replaces the whole value (the last write wins; two admins reorganising at the same moment can lose a change).

**Concurrency.** Writing an index is `r2.put(key, body, { onlyIf: { etagMatches } })` with the etag from the read; on conflict the Worker reads again and retries up to 5 times. Manifests are added under a unique key (immutability), so they do not conflict. We do not use Durable Objects. If things drift apart, the admin has a "rebuild package index" action that generates it from the listing of manifests.

## Publishing

Publishing is three steps: `init` (validation and presign), `PUT` directly to R2, `commit` (object verification, writing the manifest, rebuilding the index). A version, once committed, is immutable.

_Publishing flow diagram (6 steps):_ 1) the CLI calls `init` on the Worker with the declared metadata and list of files; 2) the Worker validates the grant and immutability and returns one presigned `PUT` URL per file; 3) the CLI uploads every file directly to R2 staging with those URLs and then calls `commit`; 4) the Worker runs `head()` on every staged object and verifies its size and checksum; 5) the Worker copies the files to their final keys, writes `manifest.json` and rebuilds the package index; 6) the Worker deletes the staging objects (cleanup).

The Worker sees only metadata and one `head()` per file; if an object in staging does not match the declaration from `init`, commit rejects it and nothing goes into the index.

**`POST /api/v1/publish/init`** (role `publish`)

```json
{
  "eco": "npm",
  "name": "@acme/sdk",
  "version": "2.3.1",
  "files": [{ "name": "sdk-2.3.1.tgz", "size": 48213, "sha256": "…", "role": "archive" }],
  "manifest": { "...native fields from the archive..." }
}
```

The Worker: checks the `publish` grant for the package and version, rejects with `409` if the `manifest.json` of this version exists, writes `_staging/<upload-id>/meta.json` and returns:

```json
{
  "uploadId": "…",
  "expires": "2026-10-28T10:22:00Z",
  "uploads": [
    {
      "name": "sdk-2.3.1.tgz",
      "putUrl": "https://<account>.r2.cloudflarestorage.com/<bucket>/_staging/<upload-id>/sdk-2.3.1.tgz?X-Amz-…",
      "headers": { "content-length": "48213", "x-amz-checksum-sha256": "<base64>" }
    }
  ]
}
```

The presign (SigV4, `PUT`, 10 min) covers `content-length` and `x-amz-checksum-sha256`, so it is impossible to upload to R2 any file other than the declared one.

**`PUT <putUrl>`** – the CLI sends every file from the `uploads` list with exactly these headers. Network error → the CLI retries the PUT; after the URL expires → it starts again from `init`.

**`POST /api/v1/publish/commit`** `{ "uploadId": "…" }`

The Worker: runs `head()` on every object in staging, compares the size and `checksums.sha256` with `meta.json` (any file missing → `400`), checks immutability again (someone may have committed in the meantime), copies the objects to the target keys (`r2.put` with the stream from `get()`), writes `manifest.json`, runs `adapter.rebuildIndex(name)`, deletes the staging objects. Response `201` with `{ name, version, url }`; `409` when the version already exists.

**Immutability and admin operations**

- The CLI has no way to overwrite or delete a version; `init` on an existing version ends with `409`.
- The admin (`kind admin`, the panel or `DELETE /api/v1/packages/<eco>/<name>/<version>`) has two operations: `yank` (the manifest gets `yanked: true`; the version disappears from dependency resolution, but the file stays downloadable, so consumers' lockfiles keep working – table below) and `delete` (manifest and files deleted, index rebuilt, consumers' lockfiles stop working, the version is free to be published again).
- Deleting a whole package (`DELETE /api/v1/packages/<eco>/<name>`, from the panel after typing its name) = `delete` of all versions plus removing the entry from `_meta/packages.json`.

| Ecosystem | What a yank looks like in the index                                                                                                    | Download from a lockfile                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| cargo     | native: the entry stays in the sparse index with `"yanked": true`; `cargo update` skips it                                             | yes, natively (`Cargo.lock`)                                                                     |
| npm       | no native concept; here the entry is removed from `versions` and `dist-tags` in the packument, the tarball is still at `/-/<file>.tgz` | yes – `package-lock.json` has the tarball URL and `integrity`, it does not ask for the packument |
| Composer  | no native concept; here the entry is removed from `p2/<pkg>.json`, the dist is still at `/dist/…`                                      | yes – `composer.lock` has the dist URL and shasum                                                |
| generic   | `"yanked": true` in the version JSON, skipped in the list and in `latest`, visible with `?include=yanked`                              | yes, directly by URL                                                                             |
| NuGet     | native: `listed: false` in the registration; the flat container still returns the version and the `.nupkg`                             | yes                                                                                              |
| Swift     | native: a `problem` field on the release in the release list, `410` for the version metadata                                           | yes – `Package.resolved` points at the version, the archive is still served                      |
| Maven     | no native concept; here the version disappears from `maven-metadata.xml`, the files under their full path stay                         | yes – the Gradle lockfile and Maven use full paths                                               |

In npm and Composer a yanked version is invisible, not marked – the client gets no warning, it simply stops seeing it; this is deliberately closer to the cargo semantics than to npm's `deprecated`, which only warns and still lets the version be chosen.

**Publication time (cooldowns).** Client-side cooldowns (npm `min-release-age`, pnpm/Bun `minimumReleaseAge`, Yarn `npmMinimalAgeGate`, uv `exclude-newer`, Composer `config.policy.cooldown`, Cargo publish-age handling) skip versions published less than N ago, so they need a trustworthy per-version time. `manifest.published` is that time: the Worker sets it at `commit`, it is never taken from the publisher or the archive, appending files to a version does not change it, and reindexing keeps it. Each adapter puts it where its client looks:

| Ecosystem | Field filled from `published`                                                     |
| --------- | --------------------------------------------------------------------------------- |
| npm       | packument `time[<version>]` (`created` and `modified` recomputed after filtering) |
| Composer  | p2 `published-time` and `time` (a `time` in `composer.json` is ignored)           |
| cargo     | sparse index line `pubtime`                                                       |
| NuGet     | registration `catalogEntry.published`                                             |
| Swift     | release metadata `publishedAt`                                                    |
| generic   | version JSON `published` (also the clock for a future appcast `pubDate`)          |
| Maven     | none: Maven has no per-version field; use the registry-side cooldown (#34)        |

Composer 2.11 fails a `require`/`update` when a version has no `published-time`; own packages can be exempted with the `ignore` option of the cooldown policy, or `--no-cooldown`. Yanked versions stay out of the index as before.

**Appending files to an existing version** (generic only): building `cdylib` libraries or installers in a CI matrix produces one file per job, while there is only one version. That is why `init` with `"append": true` on an existing version is allowed when (a) the adapter permits it, (b) less than `APPEND_WINDOW_HOURS` (default 24) have passed since `published`, and (c) every file name is new. A file, once committed, is immutable; `commit` appends the entries to `files[]` in the manifest (a write with `onlyIf`) and rebuilds the index. Once the window has passed, the version is closed. An alternative without a window: a job that collects the artifacts and publishes once.

**Cleanup** – a cron every hour: deletes `_staging/*` entries older than 24 h and secrets whose `expires` date has passed.

**Limits** – a single presigned PUT up to 5 GB (the R2 limit for one object without multipart); `init` rejects a `size` above `MAX_UPLOAD_BYTES` (default 512 MB).

## Adapters and endpoints

Each ecosystem is one module implementing a common interface; the kernel does not know the formats, the adapter does not know R2 or auth. The Worker serves only reads of the native protocols plus its own publishing and administration API.

**Modularity.** Adapters are modules in one repository (not plugins loaded at runtime): in the Worker, `src/adapters/<eco>/` directories registered in `src/adapters/index.ts`; in the CLI, `crates/eco-<eco>` crates linked into one binary. Adding an ecosystem = a PR to both repositories. Selective enabling: in the Worker, `vars.ECOSYSTEMS` (a list, default: all) – a disabled adapter is not routed and does not appear on the page or in the panel; in the CLI, Cargo feature flags (`--features composer,npm`, all by default), so that `sreg` can be built with only the adapters that are needed.

**Adapter contract** (`src/adapters/<eco>/index.ts`):

```ts
interface Adapter {
  eco: "composer" | "npm" | "cargo" | "generic" | "nuget" | "swift" | "maven";
  // validation and normalisation of what the CLI sent in init
  parseManifest(input: PublishInit): Manifest;
  // how to name the keys of the version's files in R2
  fileKey(m: Manifest, file: ManifestFile): string;
  // rebuild the index of one package from the list of manifests (including yanked)
  buildIndex(name: string, manifests: Manifest[]): IndexFile[]; // { key, body, contentType }
  // read routing: returns an index file to filter or an archive key to redirect to
  route(req: Request, url: URL): IndexRoute | ArchiveRoute | null;
  // index filter for a credential: only versions covered by grants
  // (editorial note: the implementation also passes the IndexRoute being served as a third argument)
  filterIndex(body: unknown, allowed: (name: string, version: string) => boolean): unknown;
  // configuration snippets for the home page
  // (editorial note: a Snippet has a title, file name, language and body, and optionally a one-sentence description and a group and variant that mark alternative ways to do the same thing; they are shown on the package page)
  clientConfig(baseUrl: string, token: string, packages: string[]): Snippet[];
  // dependencies declared in a manifest, for transitive grants (none for generic)
  dependencies(m: Manifest): Array<{ name: string; constraint: string }>;
  // version format, validation and comparison (semver / Composer / cargo / NuGet)
  validateVersion(version: string): boolean;
  satisfies(version: string, constraint: string): boolean;
}
```

(editorial note: the sketch is abridged. The implemented interface in `src/adapters/types.ts` passes `buildIndex` an `IndexContext` with the public URL as a third argument and `filterIndex` the `IndexRoute` being served as a third argument, and adds members such as `fileUrl`, `versionUrl`, `compareVersions`, `validateRange` and the optional `supportsAppend`, `digests`, `buildListing`, `buildConfig`, `selectFile`, `finalizeResponse`, `storedName`, `storedVersion`, `displayName` and `versionSnippets`, which returns the snippets that install exactly one version for the version page.)

**Composer** (`/composer/…`)

| Endpoint                                                          | Returns                                                                                                         |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /composer/packages.json`                                     | `{ "metadata-url": "/composer/p2/%package%.json", "available-packages": [...] }` – list filtered by grants      |
| `GET /composer/p2/<vendor>/<pkg>.json`                            | stable versions in the Composer 2 format (`minified: composer/2.0`), only allowed ones                          |
| `GET /composer/p2/<vendor>/<pkg>~dev.json` (always an empty list) | Composer 2 asks for this file; the registry does not serve `dev-*` versions, so it returns `{ "packages": {} }` |
| `GET /composer/dist/<vendor>/<pkg>/<version>.zip`                 | `302` → presigned GET (15 min)                                                                                  |

Client: `auth.json` with `bearer` or `http-basic` and `repositories: [{ type: composer, url: https://<domain>/composer }]`, or without `auth.json`, with the token in the URL: `https://<token>@<domain>/composer` (Composer extracts the userinfo as `http-basic`). npm and cargo do not support credentials in the URL.

**npm** (`/npm/…`)

| Endpoint                                      | Returns                                                                                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /npm/<name>` or `/npm/@<scope>%2f<name>` | packument: `versions`, `dist-tags` (`latest` = the highest non-yanked stable version), `time`; `dist.tarball` points to the Worker (editorial note: the exact shape and the dist-tag rules are in the API contract) |
| `GET /npm/<name>/<version>`                   | a single version entry (editorial note: a dist-tag is accepted in place of the version)                                                                                                                             |
| `GET /npm/<name>/-/<file>.tgz`                | `302` → presigned GET                                                                                                                                                                                               |
| `GET /npm/-/ping`, `GET /npm/-/whoami`        | `200` for checking auth; `whoami` returns `{ username: <project> }` (editorial note: both answer any credential kind, `publish` included)                                                                           |

Client: `.npmrc` with `@scope:registry=https://<domain>/npm/` and `//<domain>/npm/:_authToken=<token>`. Scoped packages are required (pointing the whole `registry` at the private registry would cut off public packages, because we do not mirror).

**cargo** (`/cargo/…`, sparse registry)

| Endpoint                                                                 | Returns                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /cargo/index/config.json`                                           | `{ "dl": "https://<domain>/cargo/dl/{crate}/{version}", "api": "https://<domain>/cargo", "auth-required": true }` (editorial note: this file also requires a credential)                                                                                 |
| `GET /cargo/index/1/<c>`, `/2/<cc>`, `/3/<c>/<ccc>`, `/<cc>/<cc>/<name>` | index file: one JSON line per version (`name`, `vers`, `deps`, `cksum`, `features`, `yanked`, `v: 2`), filtered by grants (editorial note: lines in ascending version order, yanked ones included; `features2`, `links` and `rust_version` when present) |
| `GET /cargo/dl/<crate>/<version>`                                        | `302` → presigned GET                                                                                                                                                                                                                                    |
| `GET /cargo/api/v1/crates/<name>`                                        | optional metadata for the panel, not required by cargo (editorial note: `{ crate: { name, max_version, versions: [ { num, yanked } ] } }`, highest version first)                                                                                        |

Client: `.cargo/config.toml` with `[registries.<name>] index = "sparse+https://<domain>/cargo/index/"` and `token = "<token>"` (cargo sends it verbatim as `Authorization`). `auth-required: true` enforces the token also when fetching the index and files.

**NuGet** (`/nuget/…`, V3 protocol)

| Endpoint                                       | Returns                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /nuget/index.json`                        | service index with the resources `PackageBaseAddress/3.0.0`, `RegistrationsBaseUrl/3.6.0`, `SearchQueryService/3.5.0`          |
| `GET /nuget/flat/<id>/index.json`              | `{ "versions": [...] }` – the versions covered by a grant, lower case, normalised                                              |
| `GET /nuget/flat/<id>/<ver>/<id>.<ver>.nupkg`  | `302` → presigned GET                                                                                                          |
| `GET /nuget/flat/<id>/<ver>/<id>.nuspec`       | the `.nuspec` from the manifest (`native`)                                                                                     |
| `GET /nuget/registration/<id>/index.json`      | pages with a `catalogEntry` per version: `id`, `version`, `dependencyGroups` (by target framework), `listed`, `packageContent` |
| `GET /nuget/search?q=&skip=&take=&prerelease=` | a simple search over `_meta/packages.json`, filtered by grants (needed for `dotnet package search`)                            |

Normalisation: identifiers and versions in paths are lower case; NuGet versions allow 4 parts (`1.0.0.0`) and have their own comparison rules, so the adapter provides its own `satisfies` and version validation. Yank = `listed: false`. An optional second file, a `.snupkg`, has the role `symbols`.

Client: `dotnet nuget add source https://<domain>/nuget/index.json -n <name> -u <login> -p <password> --store-password-in-clear-text` (`packageSourceCredentials` in `nuget.config` → Basic; .NET drops `Authorization` on a redirect to another host, so the `302` to R2 works).

**Swift** (`/swift/…`, Package Registry SE-0292)

A package is `scope.name` (`scope` `[a-zA-Z0-9-]{1,39}`, `name` `[a-zA-Z0-9_-]{1,100}`); versions are semver 2.0 only. The client sends `Accept: application/vnd.swift.registry.v1+json`, and responses carry `Content-Version: 1`. Base URL with a path prefix (`https://<domain>/swift`) – to be confirmed at the start of the implementation.

| Endpoint                                                              | Returns                                                                                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /swift/<scope>/<name>`                                           | `{ "releases": { "1.2.0": { "url": "…" }, … } }` – the versions covered by a grant; yanked ones with a `problem` field                                                   |
| `GET /swift/<scope>/<name>/<version>`                                 | release metadata: `id`, `version`, `resources: [{ name: "source-archive", type: "application/zip", checksum }]`, `metadata`, `Link` headers to the neighbouring versions |
| `GET /swift/<scope>/<name>/<version>/Package.swift[?swift-version=X]` | the manifest from `files[]` (role `manifest`), also the `Package@swift-X.swift` variants                                                                                 |
| `GET /swift/<scope>/<name>/<version>.zip`                             | `302` → presigned GET (the specification allows a redirect), with a `Digest: sha-256=…` header                                                                           |
| `GET /swift/identifiers?url=<repo-url>`                               | mapping of a repository URL → `scope.name`, from `meta.repositoryURL` of the manifest                                                                                    |

Files: the `source-archive` `.zip` (role `archive`) plus the manifests `Package.swift` / `Package@swift-X.swift` (role `manifest`). Yank: the native `problem` in the release list and `410` for the metadata; the archive is still served for `Package.resolved`. Signatures (SE-0391) are out of scope, but `files[]` can carry them.

Client: `swift package-registry login https://<domain>/swift --username <login> --password <password>` (Basic) or `--token <token>` (Bearer); the credentials are kept in the keychain/`.netrc`, in CI `--netrc-file`.

**Maven** (`/maven/…`, Maven 2 layout – Maven and Gradle, Android included)

The package name = `groupId:artifactId`; versions are arbitrary strings ordered by the `ComparableVersion` rules, ranges are `[1.0,2.0)` – the adapter provides `validateVersion` and `satisfies`. `-SNAPSHOT` versions are not supported (they are mutable). Any path prefix (the client configures the full URL).

| Path                                                                                    | Returns                                                                                                             |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `/maven/<group/as/path>/<artifact>/maven-metadata.xml`                                  | `<versioning>` with `<versions>`, `<latest>`, `<release>`, `<lastUpdated>` – from the manifests, filtered by grants |
| `/maven/<group/as/path>/<artifact>/<version>/<artifact>-<version>[-<classifier>].<ext>` | `302` → presigned GET for every file of the version                                                                 |
| `…/<file>.sha1`, `.md5`, `.sha256`, `.sha512`                                           | checksums from `files[].sha256` and `files[].digests` (the adapter requests `sha1`, `md5`, `sha512` in `init`)      |

Files: the `.pom` (mandatory, role `pom`), the main archive (role `archive`; extension from `<packaging>`: `.jar`, `.aar`, `.war`; none for `pom`/BOM), `-sources.jar`, `-javadoc.jar`, `.module` (Gradle Module Metadata – important for Android: AGP variants; Gradle reads it instead of the POM when it finds the `published-with-gradle-metadata` marker). Dependencies for transitive grants come from the POM (`compile`/`runtime`); the CLI provides the effective POM. Yank: the version disappears from `maven-metadata.xml`, the files under their full path stay.

Client: Maven `settings.xml` → `<server><id>…</id><username>…</username><password>…</password>` (Basic); Gradle `credentials { username; password }` or `HttpHeaderCredentials` (Bearer). Both follow the `302` and do not carry `Authorization` over to another host.

**generic** (`/generic/…`, own JSON protocol)

An ecosystem for files without a native package manager: DLL plugins loaded by an application, `cdylib` libraries built for many architectures, `msi`/`pkg` installers as an auto-updater feed. One version = any number of files, each with arbitrary labels; the version metadata (`meta`) is arbitrary JSON from the publisher.

- Package name: `[a-z0-9][a-z0-9._-]*`, optionally with one group segment (`acme/plugin-foo`) (editorial note: a name must not contain `__`, two consecutive underscores, because `/` is encoded as `__` in R2 keys and `acme__x` would collide with `acme/x`). Version: semver, immutable as everywhere.
- Files: `name` (unique within the version), `size`, `sha256` and optional `labels` – a string→string map with arbitrary keys, which the registry does not interpret but only filters by. The convention shown in the README (not a schema): `platform` = Rust target triple (`x86_64-pc-windows-msvc`, `aarch64-apple-darwin`), `kind` = `installer` / `library` / `symbols`, `profile` = `release` / `debug`.
- `meta`: e.g. `{ "minAppVersion": "3.2", "notes": "…", "releaseNotesUrl": "…" }` – the registry does not interpret it, it only passes it on.

| Endpoint                                           | Returns                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /generic/`                                    | list of the packages available to the credential, with the latest version of each                                                                                                                                                                                                                                                                                                 |
| `GET /generic/<name>`                              | `{ name, latest, versions: { "<v>": { published, yanked, meta, files: [ { name, size, sha256, labels, url } ] } } }` – only versions covered by a grant; `?label=<key>:<value>` (repeatable, all conditions must be met) filters the files, `?include=yanked` adds yanked versions, `?version=<range>` (npm syntax) keeps the versions satisfying it and sets `latest` among them |
| `GET /generic/<name>/latest`                       | the highest non-yanked stable version; `?version=<range>` takes the highest one satisfying the range; `?channel=prerelease` admits prereleases; `?label=` as above                                                                                                                                                                                                                |
| `GET /generic/<name>/<version>`                    | a single version                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /generic/<name>/<version>/<file>`             | `302` → presigned GET                                                                                                                                                                                                                                                                                                                                                             |
| `GET /generic/<name>/<version\|latest>/-/download` | `302` → presigned GET of the single file of the version (resolved as above for `latest`) that every `?label=` selects, with `X-Resolved-Version` and `X-Resolved-File`; `404` when no file matches, `409 ambiguous` with the candidates when several do                                                                                                                           |

JSON responses have an `ETag`; `If-None-Match` → `304`, so that an auto-updater can poll often at no cost. `url` in the files is the address of the `302` endpoint (not a presigned URL), so the response can be cached on the client side. Versions are compared as semver; `latest` is computed on the fly from the manifests.

Client: any HTTP client with the `Authorization: Bearer <token>` header (or Basic); in a pipeline, `sreg generic get`. The instructions page shows a `curl` and an `sreg` example.

**Own API** (`/api/v1/…`, JSON, Bearer)

| Endpoint                                                                         | Role      | Description                                                       |
| -------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------- |
| `POST /api/v1/publish/init`, `POST /api/v1/publish/commit`                       | `publish` | see Publishing                                                    |
| `GET /api/v1/packages`                                                           | `read`    | packages and versions available to the credential (home page)     |
| `GET /api/v1/packages/<eco>/<name>`                                              | `read`    | versions of one package                                           |
| `POST /api/v1/packages/<eco>/<name>/<version>/yank`, `DELETE …/<version>`        | `admin`   | yank, delete                                                      |
| `POST /api/v1/packages/<eco>/<name>/reindex`                                     | `admin`   | rebuild the index from manifests                                  |
| `GET/POST /api/v1/credentials`, `GET/PATCH/DELETE /api/v1/credentials/<project>` | `admin`   | list, create, edit grants and roles, delete                       |
| `POST /api/v1/credentials/<project>/secrets`, `DELETE …/secrets/<hash-prefix>`   | `admin`   | add a new secret (returns the full token once), expire an old one |
| `GET /api/v1/whoami`                                                             | any       | project name, roles, grants                                       |
| `GET /api/v1/version`                                                            | none      | Worker version, `minClientVersion`, `schema_version`              |

All native-protocol responses have `Cache-Control: private, no-store` – indexes depend on the credential.

## Home page and panel

One HTML + CSS application with minimal vanilla JS (only `fetch` to `/api/v1`), served from Workers Static Assets, without a bundler or external dependencies. The user's view follows from the roles of the credential they logged in with (a secret limited to `publish` does not open the panel of a credential that can also read; a credential that only yanks or deletes gets a home page with the packages its grants cover and, on each package page, "Yank" and "Delete" on the versions they cover, without version pages, downloads or configuration).

**Login** (`GET /`): the registry's name above one centred card with "Sign in", a pill switch between the two fields "login / password" (the default) and a single "token" field (two radios styled by CSS; scripts show only the chosen fields, without scripts both stay visible); with a one-time code the card asks for it in a second step after the password, a "show" button on the secret fields and a full-width "Sign in" button; a failed login shows its error above the switch. The footer names the version and links the documentation. `POST /login` verifies like any other request, creates a session in KV and sets the cookie. `POST /logout` deletes the session. The first-run form and the pages that show a new token once share the centred card.

**Consumer view** (role `read`):

- One list of the packages from explicit grants, sorted by name (ignoring case and everything but letters and digits), not grouped by ecosystem: each row shows an ecosystem badge, the name, the number of versions covered by the grant and the latest of them (marked when yanked), and links to the package page. With package groups the list is split into collapsible sections, "Ungrouped" first, then the groups by name, with subgroups inside their group and the number of packages (subgroups included) in each heading; only the packages the credential may see count, and a group with none of them is not shown (nor is a hidden group, with what is in it; a collapsed group is closed) (and when no visible package is in a group the list is a plain list). A filter bar (name, a "Group" selector listing "Ungrouped" and the groups with packages in tree order, indented, with their counts, and an "Ecosystem" selector with the ecosystems present and their counts) only hides rows; both selectors are panels of checkboxes that take several choices at once (a row stays when it matches any checked ecosystem and any checked group, a group taking in its subgroups; none checked: all) and show the choice on their button; without JavaScript the full list stays usable. Packages available transitively are not a separate list.
- The package page `GET /packages/<eco>/<name>` (the name as one URL segment, `/` as `%2F`): the versions the credential may see, each a link with its date, yanked marker and number of files; the "dependencies" subtree, collapsed by default and omitted when empty, with the packages and version ranges that this grant opens (each linking to its own page, which a `read` credential may open through the closure); and ready-to-paste snippets for this one package with the domain and package name filled in and `<token>` as a placeholder: `composer.json` + `auth.json` (bearer and http-basic variants) and a variant without auth.json, with the token as userinfo in the repository URL (https://\<token>@\<domain>/composer – the token is already a login:password pair), `.npmrc`, `.cargo/config.toml`. The snippets are generated by `adapter.clientConfig(baseUrl, token, [name])`, each with a header row (title, file name, "copy" button). (editorial note: the snippets are collapsed under "Configuration and installation", each with a one-line description; alternatives of one group, such as a command, files or environment variables, or Maven and Gradle, are shown one at a time in a chooser that works without JavaScript, and every adapter offers the command and environment-variable variants its client supports. A generic page also shows an `sreg generic get` example built from a label the package has. Names of npm, Composer, NuGet and Swift packages are found in any casing.)
- The version page `GET /packages/<eco>/<name>/<version>`: its files with size, role and labels, `sha256` and any extra `digests`, and a download link `GET /packages/<eco>/<name>/<version>/files/<file>`, which checks the session's access to the version exactly like the native routes (explicit grants, then the closure) and answers `302` to a presigned `GET` (15 minutes) for every ecosystem. (editorial note: the native URLs are not shown; a collapsed "Get exactly this version" section shows the adapter's `versionSnippets`, which pin the version; a generic version also shows its `meta` as a table, on the version page only.)
- The package routes need a session (without one they redirect to the login page); `admin` sees every package and version, `publish` gets its notice with `403`, and a package or version the credential may not see is a `404`.

**Admin pages** (role `admin`): the header links **Packages · Credentials · Settings** (the current one highlighted) and "Log out"; `GET /` sends an admin on to `/admin/packages` (`303`). Admin pages need an admin session: without a session they redirect to the login page, other roles get a notice with `403`.

- `/admin/packages`: the consumer list (sorted, filterable, each row linking to the package page) with "Reindex" and "Delete" at the end of each row. The package page `GET /packages/<eco>/<name>` is the same page for everyone; an admin also gets "Yank" and "Delete" on every version, "Reindex" in the header and "Delete package" in a danger zone, which asks to type the package name. Instead of what a grant opens, the admin's collapsed "Dependencies" lists every package of the registry that any version depends on, directly or indirectly, with the constraints and the versions they admit. The list is grouped like the consumer's, but groups without packages are shown too; "Organize" (`?organize=1`) puts a checkbox on every row instead of the row actions and adds a bar under the list with the number checked, "Select all shown" and "Clear" (scripts; shift-click checks a range) and the controls "Move to" (Ungrouped or a group) and, as an alternative, "a new group" (a name, the group it goes inside and how it is shown); "Move selected" posts to `POST /admin/packages/move` (`package` once per checked row, `target`, `new_name`, `new_parent`), which ignores packages that do not exist, puts the rest in the group (creating it first when a name is given) and goes back to the list with a notice. "Manage groups" opens `/admin/packages/groups`. Hidden groups, and the packages in them, are left out of the list until the admin asks for them: when there is a hidden group a "Show hidden groups (N)" button (`?hidden=1`, kept by Organize mode and the Done link) shows them marked "hidden" and becomes "Hide hidden groups". Every group is a move target in Organize mode, a hidden one marked. Everything is a plain form post (checked like the other panel forms) and works without scripts.
- `/admin/packages/groups`: the groups as an indented tree (siblings by name) with, for each, its name and parent as a form ("Save": rename and/or move it with everything in it, within the nesting limit and never into itself or what is inside it), how its visibility is set ("Shown as": visible, collapsed or hidden), how many packages and subgroups it holds with a link to it in the list (with the hidden groups shown, for a hidden group), and "Delete" (its packages and subgroups move up one level, to Ungrouped from the top level, and a subgroup whose name is taken there stops the deletion); above the tree a "New group" form (a name, the group it goes inside and how it is shown). Changes are `POST /admin/packages/groups` (create), `POST /admin/packages/groups/<id>` (rename and move) and `POST /admin/packages/groups/<id>/delete`; a refused change shows the reason on the page again with `400`. The package page `GET /packages/<eco>/<name>` shows an admin the package's group (linking to it in the list) and a form to move the package to another group. Its breadcrumb, for everybody, is `Packages › <the groups above the package, from the top down> › <package>`, each group linking to it in the list (`#group-<id>`, which opens it and the groups above it, however they are collapsed); a hidden group is shown only to an admin, linking to the list with the hidden groups shown.
- `/admin/credentials`: a table of the projects (roles, number of active secrets, nearest expiry, number of grants of each role) with a filter by project, each row linking to the credential's page, and a "New credential" button.
- `/admin/credentials/new`: the creation form alone (project, the roles as five on/off toggles (read, publish, yank, delete, admin) with what each may do, a list of grants as eco/package/versions rows for each of read, publish, yank and delete it holds, the first secret: none (the default; not for a credential that administers), a generated key or a login with an optional password and one-time code, with the scope of the first secret for a credential with several roles, and a description). It is posted to the same path and answered with a "Credential created" page that shows the new token, or the login's password with a QR code and a link for the one-time code, once, with copy buttons, **the message for the person it is for** (see below) and a link to the credential's page (without a first secret it goes straight to the credential's Secrets tab); nothing stores them for later.
- `/admin/credentials/<project>`: server-rendered tabs under the heading, chosen with `?tab=` (plain links that work without JavaScript; an unknown value shows the overview): **Overview** (the default: roles, login, created, active secrets and their ids, nearest expiry, plus the counts of grants and secrets linking to the other tabs), **Grants** (editable rows for each role, "Save read grants" / "Save publish grants" / "Save yank grants" / "Save delete grants", and the roles themselves as the same five toggles with "Save roles" (an admin-only credential has no grants rows but the same roles form, to give it read or publish); with JavaScript, "Edit as text" switches to one grant per line in the CLI shorthand `eco:package[:versions[:transitive]]` to copy and paste, also on the creation form: the text is read back into the rows, `transitive` is written only for `read` grants and only when it is off), **Secrets** (type, id, scope, an editable description, created, expires, the claims of `gh` secrets; "Edit" on a `gh` secret opens the form below filled in and saving adds a changed copy and, with the box ticked, expires the old one; "Expire…" on active ones reveals the date and the confirm, which are shown inline without JavaScript; above the table a primary "Add a secret" button unfolds the form – a `<details>`, opened by `?tab=secrets&add=1` and when a refused form is shown again – for a `key`, a `login` (optional password, one-time code) or `gh` with "Look up" and pin-on-first-use, each with an optional description and, when the credential holds both roles, the roles of the secret as a toggle for each of the credential's roles, each saying what it lets the secret do (all off; at least one must be switched on); with several roles every secret has "Edit" in its row, which opens the same panel for its roles (a key or a login is changed in place and posted to `…/secrets/<id>`, a `gh` secret is replaced by a changed copy); posted to `…/secrets`, a new `key` answered with the token page and a new `login` with the password page like a new credential, a `gh` secret redirected to `?tab=secrets`) and **Danger zone** (deleting the credential after its name is typed). The project `new` is linked as `/admin/credentials/%6Eew`, because `new` names the creation form.
- `/admin/settings`: read-only – Worker version, flags from `vars` (editorial note: an unset variable shows the default the Worker uses, marked as such), a link to the latest release on GitHub (if `CHECK_UPDATES=true`).

The other admin mutations are `fetch` calls to `/api/v1` from `public/app.js`, followed by a reload; deletions confirm through a browser dialog or the typed name. Scripts are scoped by the `data-page` attribute of each page.

**Setup checklist**: the first-run page and the admin settings page list the installation settings (required: `SESSION_SECRET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`; recommended: `PUBLIC_URL`; optional, with their defaults: `ECOSYSTEMS`, `MAX_UPLOAD_BYTES`, `APPEND_WINDOW_HOURS`, `TOKEN_PREFIX`, `CHECK_UPDATES`, `R2_BUCKET_NAME`) as Set, Missing or Default – whether a setting is present, never a secret's value – with how to add the missing ones (the dashboard path, `npx wrangler secret put <NAME>` for secrets) and, for `SESSION_SECRET`, a value generated in the browser. While `SESSION_SECRET` is missing the first run shows only the checklist and creates no admin, since nobody could sign in.

**The message for the new secret's owner.** The one-time pages of a new `key` and a new `login` (not the first-run page) also show a ready message in English, built on the server from the credential: the server, the login, the token or password, the expiry, the one-time code (QR code, key and `otpauth` link) and then, for each role the secret has, what it allows – the read grants (with a note when the dependencies are included), the publish grants, the administrator access – followed by client configuration for every ecosystem of the read grants (the first alternative of each adapter's snippets, naming the exact packages) and the `sreg` commands for publishing or signing in. The credential's description is not in it. "Copy message" puts the formatted message on the clipboard (HTML with inline styles and the QR code as a PNG image, plus plain text) for pasting into a mail client; "Copy as text" copies plain text; "Download PDF" builds a PDF in the browser. The PDF library (jsPDF, pinned to a version and checked with a subresource integrity hash) comes from `cdnjs.cloudflare.com` when the PDF is asked for; these pages are the only ones whose `Content-Security-Policy` adds `script-src 'self' https://cdnjs.cloudflare.com`. Without JavaScript the message is shown and prints.

**First run**: no credential at all in KV → the page shows a "create admin" form (name, an optional chosen password and a one-time code box; the admin gets a `login` secret whose password, with a QR code and key for the code, is shown once). Once the first credential with the `admin` role is created, the form disappears permanently. Without this, the user would have to type hashes into KV by hand.

**Panel security**: all mutations via `POST`/`PATCH`/`DELETE` with the `X-Requested-With` header (CSRF protection with a `SameSite=Lax` cookie), `Content-Security-Policy: default-src 'self'`, no inline scripts. The panel's own form posts (login, logout, first run, a new credential, a new secret) carry no such header and are accepted only from the registry's own origin (`Origin`, or `Sec-Fetch-Site: same-origin` when `Origin` is hidden).

## Rust CLI

The CLI is the only way to publish: for npm and cargo it delegates packing to the native tools, for Composer it packs by itself. Binary name: `sreg`.

**Commands**

| Command                                                                                                               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sreg composer publish [--version <v> \| --tag-prefix <p>] [--path <dir>]`                                            | packs the directory (`git archive HEAD` honouring `export-ignore`, falling back to a zip of the directory without `vendor/` and `.git/`), reads `composer.json`; the version comes from `--version` or the git tag (`v1.2.3` → `1.2.3`); it must be semver, `dev-*` is rejected                                                                                                                                                                                                                                                                      |
| `sreg npm publish [--version <v> \| --tag-prefix <p>] [--tag <t>] [--workspace <w>] [-- <npm pack flags>]`            | with `--version`, first runs `npm pkg set version=<v>` (the version in `package.json` inside the tarball must match the registry), then `npm pack --json --pack-destination <tmp>`, reads the name, version and `package.json` from the tarball; `--tag` sets the dist-tag for this version (default `latest`, prerelease → `next`)                                                                                                                                                                                                                  |
| `sreg cargo publish [--version <v> \| --tag-prefix <p>] [--package <crate>] [-- <cargo package flags>]`               | with `--version`, replaces `package.version` in `Cargo.toml` (a formatting-preserving edit, `toml_edit`), then runs `cargo package --no-verify --allow-dirty` (flags can be passed through), reads the `.crate` and the metadata from `cargo metadata`                                                                                                                                                                                                                                                                                               |
| `sreg whoami`                                                                                                         | `GET /api/v1/whoami`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `sreg generic publish <name> <version> <file>... [--label k=v]... [--meta k=v]... \| --spec files.json`               | publishes the given files as one version; `--label` applies to all files in the call, files with different labels = separate calls (in a CI matrix every job sends its own file of the same version, see Publishing: appending files); `--spec` accepts JSON with a list of `{ path, labels }` for unusual cases; the CLI adds no default labels                                                                                                                                                                                                     |
| `sreg generic get <name> [<version>\|<range>\|latest] [--label k=v]... [--sole] [--out <dir>] [--prerelease]`         | downloads the files of a version (`latest` by default, the highest version satisfying a non-exact version given as a range, all files without `--label`; `--sole` requires exactly one file), verifies the sha256, prints the paths; `--json` returns the manifest without downloading                                                                                                                                                                                                                                                               |
| `sreg nuget publish [--version <v> \| --tag-prefix <p>] [--project <csproj>] [--no-symbols] [-- <dotnet pack flags>]` | runs `dotnet pack` (version through `-p:PackageVersion=<v>`), unpacks the `.nupkg` (zip), reads the `.nuspec` (id, version, dependencies), attaches the `.snupkg` as `symbols` if one was produced, unless `--no-symbols` is given                                                                                                                                                                                                                                                                                                                   |
| `sreg swift publish [--version <v> \| --tag-prefix <p>] [--path <dir>]`                                               | runs `swift package archive-source -o <tmp>` (an archive compatible with the registry) and `swift package dump-package` (JSON with the dependencies → `native`); attaches `Package.swift` and `Package@swift-X.swift` as `manifest` files                                                                                                                                                                                                                                                                                                            |
| `sreg maven publish [--version <v> \| --tag-prefix <p>] --from-dir <dir> [--coords <group:artifact>]`                 | reads the finished artifacts from the local file repository the build pushed them to (`mvn deploy -DaltDeploymentRepository=local::file:./out`, Gradle `publish` to `url = file://…`); reads the `.pom` (coordinates, `<dependencies>` with their scope → `native`; an effective POM is required), collects all files of the version; `--coords` narrows the choice when the directory contains several artifacts; `--version` through `-Dversion=` / `-Pversion=` after `--`, without editing `pom.xml`                                             |
| `sreg auth <eco> --oidc [--project <p>] [--write <file>]`                                                             | in a GHA job (`permissions: id-token: write`) fetches a JWT from `ACTIONS_ID_TOKEN_REQUEST_URL` with audience = `PUBLIC_URL`, assembles `<project>:gh.<jwt>` – or, without `--project`, `_:gh.<jwt>`, and the Worker resolves the project from the `repository` claim itself – and writes it to `auth.json` / `.npmrc` / `credentials.toml` (or prints it for export as `COMPOSER_AUTH` / a variable); without `--oidc` it does the same with `REGISTRY_TOKEN`. The `publish` commands use the JWT directly with `--oidc`, also without `--project`. |

The common `--version` of all publish commands: overrides the version from the project manifest and, where the client verifies consistency (npm, cargo), also replaces it in the manifest file before packing; the CLI prints that the file was modified. The CLI has no administrative commands (tokens, yank, delete) – the panel does that; they can be added later on top of the `/api/v1` API.

**Packaging: what the CLI calls.** `sreg` does not use the native tools' `publish`, only their packing commands, and does the upload itself. The flags it sets itself are reserved; everything after `--` goes verbatim to the tool (`sreg cargo publish --version 1.2.0 -- --features ssl --locked`).

| Ecosystem | Command                                                                                                  | Flags set by `sreg`                                                                 | Examples of flags to pass after `--`            |
| --------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| composer  | `git archive --format=zip HEAD:<path>` (fallback: a zip of the directory without `vendor/` and `.git/`)  | –                                                                                   | –                                               |
| npm       | `npm pack`                                                                                               | `--json`, `--pack-destination <tmp>`, `-w <pkg>` from `--workspace`                 | `--ignore-scripts`                              |
| cargo     | `cargo package`                                                                                          | `--no-verify`, `--allow-dirty`, `-p <crate>` from `--package`, `--target-dir <tmp>` | `--features`, `--locked`, `--manifest-path`     |
| nuget     | `dotnet pack <project>`                                                                                  | `-o <tmp>`, `-p:PackageVersion=<v>` from `--version`                                | `-c Release`, `--no-build`, `--include-symbols` |
| swift     | `swift package archive-source` + `swift package dump-package`                                            | `-o <tmp>`                                                                          | –                                               |
| maven     | none – artifacts from a local file repository (`--from-dir`) produced by `mvn deploy` / `gradle publish` | –                                                                                   | –                                               |
| generic   | none – the files are ready                                                                               | –                                                                                   | –                                               |

**Monorepo.** Every `publish` has a pointer to the package within the repository, and all of them work from any working directory:

- composer: `--path packages/foo` → `git archive HEAD:packages/foo` (the subdirectory becomes the root of the archive; `export-ignore` from `.gitattributes` is honoured in subdirectories too); `composer.json` is read from that path.
- npm: `--workspace <name|path>` → `npm pack -w <…>`; `npm pkg set version` with `-w`.
- cargo: `--package <crate>` → `cargo package -p <crate>`; the version is edited in that crate's `Cargo.toml` (with `version.workspace = true` the CLI refuses `--version` and asks for the version to be set in the workspace).
- nuget: `--project <path to .csproj>`; a `.sln` is rejected (it produces several packages).
- Version from a tag: in a monorepo the tag `v1.2.0` does not say which package it belongs to, so `--tag-prefix <prefix>` (e.g. `foo/v`, `foo-v`) selects the tag on HEAD with that prefix; without `--tag-prefix` and without `--version`, the CLI accepts only a `v<semver>` tag and refuses when there is more than one on HEAD.
- One call = one package, one version. Publishing several packages from a monorepo means several calls (a loop in the workflow or a matrix); `sreg` does not publish whole workspaces at once.

**Prebuilt archives.** `sreg npm|composer|cargo|nuget publish --archive <file>` publishes an archive built earlier (`.tgz`, `.zip`, `.crate`, `.nupkg`) instead of packing a project, so that the bytes that were tested and signed are the bytes that are published, and historical releases can be migrated with their checksums:

- The file is uploaded unchanged (the declared `sha256` and `size` are those of the input file); no packaging tool and no git checkout are needed, and tags of the current checkout are ignored. The name in `files[]` follows the adapter (`<scope>-<name>-<version>.tgz`, `<package>-<version>.zip`, `<name>-<version>.crate`, `<id>.<version>.nupkg` in lower case); the input file is neither renamed nor modified.
- `name`, `version` and `manifest` come from the manifest inside the archive (`package/package.json`, `composer.json` at the root or in the single top-level directory, `Cargo.toml` of `<name>-<version>/` (the cargo index line is built from it as `cargo publish` does), the `.nuspec`). The archive is read to its end and must be well formed; a malformed archive or an invalid name or version fails before `init`.
- `--version` is a consistency check and must equal the version in the archive; for a Composer archive whose `composer.json` has no `version` it is the version to publish. It never rewrites the archive.
- `--archive` conflicts with `--tag-prefix`, `--path`, `--workspace`, `--package`, `--project`, `--no-symbols` and the arguments after `--`. `--tag` (npm), `--oidc`, `--dry-run`, `--skip-existing` and `--json` behave as for projects. A `.snupkg` is not published in this mode.
- `sreg cargo publish --archive … --source-registry-index <index url>`: a dependency in the archived `Cargo.toml` whose `registry-index` equals the given index (compared without `sparse+`/`registry+`, case of the host and trailing `/`) is emitted as a dependency of this registry (`registry: null`); every other registry keeps its index URL and crates.io dependencies stay crates.io dependencies. The archive and its `Cargo.toml` are not changed, so the checksum is preserved and the retired host is never contacted by consumers.

Every publish command: computes the sha256 and size of every file, calls `init`, does the `PUT` of every file with retry (3 attempts, backoff), calls `commit`, prints the result. Common flags: `--dry-run` stops after `init`; `--skip-existing` turns a `409` (version exists) into exit code `0` with a message instead of an error, so that re-running a workflow is idempotent. Without this flag, `409` gives exit code `2`, so that the pipeline can tell it apart from an error.

**Configuration**: `--registry <url>` or `REGISTRY_URL`, `--token` or `REGISTRY_TOKEN`; in CI exclusively environment variables from GHA secrets. No configuration file.

**Workspace structure** (`serverless-registry-cli`):

- `crates/core` – HTTP client (reqwest + rustls), presigned upload, API models, version handling.
- `crates/eco-composer`, `crates/eco-npm`, `crates/eco-cargo`, `crates/eco-generic`, `crates/eco-nuget`, `crates/eco-swift`, `crates/eco-maven` – packing and manifest extraction; a common trait `Packager { fn package(&self, opts) -> Result<Package> }`.
- `crates/cli` – clap, subcommands, text and `--json` output.

**CLI ↔ Worker compatibility**: the CLI sends `X-Client-Version: <semver>`, the Worker answers with `X-Min-Client-Version`; CLI too old → a message with a link to the release and exit code `3`. The API is versioned in the path (`/api/v1`); the next Worker version keeps the previous one for at least one minor release.

**Distribution**: GitHub Releases through `cargo-dist` (linux-gnu/musl, macOS arm64/x86\_64, Windows; checksums), plus a GitHub Action `kduma-OSS/serverless-registry-action/publish@v1` (composite: downloads the binary at a pinned version, verifies the checksum, runs `sreg <eco> publish`) (editorial note: the action lives in its own repository, `kduma-OSS/serverless-registry-action` (formerly `serverless-registry-publish-action`), next to the `setup`, `auth` and `get` actions, and is versioned independently of the CLI; each action release names the `sreg` release it installs by default, `@v1` follows the latest 1.x release, and a stable CLI release triggers a patch release of the action with the new default). Example in the README:

```yaml
- uses: kduma-OSS/serverless-registry-action/publish@v1
  with:
    ecosystem: composer
    registry: https://packages.example.com
    token: ${{ secrets.REGISTRY_PUBLISH_TOKEN }}
```

## Deployment, configuration and updates

Principle: there is nothing installation-specific in the repository. Thanks to that, updating is "Sync fork" and an automatic deploy, without conflicts.

**Deployment paths** (all supported by the same repository):

| Path                                                                        | For whom                             | What the user does                                                                                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Deploy to Cloudflare" button (`deploy.workers.cloudflare.com/?url=<repo>`) | default                              | clicks; Cloudflare copies the repository to their GitHub, provisions R2 and KV from `wrangler.jsonc`, hooks up Workers Builds (auto-deploy from `main`) |
| Fork + GitHub Actions (`wrangler deploy`)                                   | those who do not want Workers Builds | fork, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets, run the workflow                                                                      |
| Locally `npm run deploy`                                                    | developers                           | clone, `wrangler login`, deploy                                                                                                                         |

**`wrangler.jsonc` in the repository** – bindings without identifiers, so that Wrangler provisions them or matches them by name:

```jsonc
{
  "name": "serverless-registry",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "assets": { "directory": "./public", "binding": "ASSETS" },
  "kv_namespaces": [{ "binding": "AUTH" }],
  "r2_buckets": [{ "binding": "R2_BUCKET", "bucket_name": "serverless-registry" }],
  "triggers": { "crons": ["0 * * * *"] },
  "vars": {
    "ECOSYSTEMS": "composer,npm,cargo,generic,nuget,swift,maven",
    "MAX_UPLOAD_BYTES": "536870912",
    "CHECK_UPDATES": "true",
    "TOKEN_PREFIX": "",
    "R2_BUCKET_NAME": "serverless-registry",
    "APPEND_WINDOW_HOURS": "24",
  },
}
```

**Installation configuration** – only in the Cloudflare dashboard (or `wrangler secret put`), never in files:

| Key                                                                                      | Kind   | Description                                                                                      |
| ---------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `PUBLIC_URL`                                                                             | var    | full address of the registry, e.g. `https://packages.example.com` (used in indexes and snippets) |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`                                               | secret | R2 S3 API key for presigning (permissions for this bucket only)                                  |
| `S3_ENDPOINT`                                                                            | var    | `https://<account>.r2.cloudflarestorage.com`                                                     |
| `ECOSYSTEMS`, `MAX_UPLOAD_BYTES`, `APPEND_WINDOW_HOURS`, `TOKEN_PREFIX`, `CHECK_UPDATES` | var    | override the defaults from the repository                                                        |
| `SESSION_SECRET`                                                                         | secret | HMAC key for signing the panel session cookie; changing it invalidates all sessions              |
| `R2_BUCKET_NAME`                                                                         | var    | name of the bucket used in presigned URLs; must match `bucket_name` of the `R2_BUCKET` binding   |

_Editorial note:_ the implementation sets `"keep_vars": true` in `wrangler.jsonc` and keeps the defaults above in code instead of `vars`, so the overrides set in the dashboard survive deploys (a deploy neither deletes nor resets them).

Domain: a custom domain of the Worker set in the dashboard, not through `routes` in the file. The README walks through this step by step with screenshots.

**Cloudflare free plan limits** (as of the date of this specification; check before a release): the registry is meant to run entirely on the free plan for a small team. After the KV optimisation (Data layout section), the binding limit is **Workers Free: 100,000 requests a day** – the same as 100,000 KV reads a day, so both limits run out at the same point (~2,500 installs at 40 requests a day). R2 free (10 GB, 1 million writes and 10 million reads a month) and the cron are not limiting. A larger team, or CI that runs very often, needs Workers Paid ($5 a month: 10 million requests, 10 million KV reads); the README describes this. An alternative, noted but not planned: D1 instead of KV (free: 5 million row reads and 100,000 row writes a day, SQL, strong consistency) – it makes sense once queries are needed (search, reports); the change would affect only the `storage`/`auth` layer.

**Updates**

- Releases tagged with semver, `CHANGELOG.md` with "breaking" and "requires migration" sections.
- The user: "Sync fork" (or merge a tag) → Workers Builds / GHA deploys. Zero file edits on their side, so zero conflicts.
- The panel shows the version and, with `CHECK_UPDATES=true`, compares it with the latest release on GitHub (one `fetch` per day, cached in the Cache API) (editorial note: earlier versions said "cached in KV"; like the other derived data in the Data layout section, the answer is kept in the Cache API, so the check makes no KV write).
- Data migrations: `schema_version` in KV; on the first request after a new version is deployed, the Worker compares it and runs the migrations in order (idempotent, small), and for large operations (e.g. a change of index format) a `reindex` of all packages from manifests is enough – the manifest is the only durable data contract.
- The CLI and the Worker are updated independently; the version headers (CLI section) protect against silent incompatibility.

**Licence and repositories**: MIT; `serverless-registry-worker` and `serverless-registry-cli` as two repositories with separate release cycles.

## Repository structure and decisions

**`serverless-registry-worker`**

```text
src/
  index.ts              # fetch + scheduled, routing by path prefix
  core/
    auth.ts             # header parsing, cred: lookup, hash comparison, sessions
    grants.ts           # grant evaluation (glob + constraint via adapter.satisfies)
    presign.ts          # SigV4 for R2 (PUT with checksum, GET)
    storage.ts          # R2 keys, manifests, onlyIf retry, listing
    publish.ts          # init / commit
    admin.ts            # yank, delete, reindex, credentials
    cron.ts             # cleanup of staging and expired secrets
    migrate.ts          # schema_version and migrations
    bucket.ts           # installation id: guards against a repointed R2 bucket
  adapters/
    types.ts            # interface Adapter, Manifest, IndexFile
    composer/  npm/  cargo/  generic/  nuget/  swift/  maven/
  pages/                # HTML rendering of the home page and the panel (template strings)
public/                 # CSS, minimal JS (Static Assets)
test/                   # vitest + @cloudflare/vitest-pool-workers, adapter tests on real fixtures
wrangler.jsonc  CHANGELOG.md  README.md
```

**`serverless-registry-cli`** – the workspace from the CLI section (`crates/core`, `crates/eco-*`, `crates/cli`), `dist-workspace.toml` for cargo-dist.

**`serverless-registry-action`** (formerly `serverless-registry-publish-action`) – the composite GitHub Actions `publish`, `setup`, `auth` and `get` (one `action.yml` per directory, the install, publish, auth and get scripts, its own release workflow and changelog; the root `action.yml` is a deprecated alias of `publish` in v1).

**Rollout order**

1. Kernel + composer adapter + CLI `composer publish` and auth, with the key and gh types (closes the existing use case and publishing without secrets).
2. Home page with login and snippets, admin panel, first run.
3. npm adapter + `npm publish`.
4. cargo adapter + `cargo publish`; generic adapter + generic publish/get; nuget adapter + nuget publish; swift adapter + swift publish; maven adapter + maven publish.
5. Deploy button, cargo-dist, publish-action, documentation.

**Settled decisions**

- CLI name: `sreg`.
- npm `dist-tags`: the CLI accepts `--tag` (default `latest`); a prerelease version without `--tag` gets `next`. Tags are kept in the package's `_meta`; yanking/deleting the version a tag points to moves the tag to the highest remaining stable version. (Editorial note: the implementation does not store tags; it derives them from the manifests on every request, see the API contract, section 12.)
- No support for `dev-*` in Composer: the version format is defined by the adapter (semver for composer/npm/cargo/generic/swift, NuGet versions for nuget, ComparableVersion for maven), prereleases allowed, all versions immutable. `sreg composer publish` rejects a non-semver version. Testing a branch before a release = a VCS repository temporarily listed in the consumer's `composer.json`.
- Presigned GET valid for 15 min.
- The panel allows deleting a whole package; confirmation by typing its name.

## Changes

| Version | Date       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13      | 2026-10-29 | Roles `yank` and `delete`: an account may be allowed to yank or delete the versions its own grants (`yank_grants`, `delete_grants`) cover, without being an `admin` (which still yanks and deletes anywhere). They authenticate with a `key`, a `gh` entry or a browser `login`; `whoami` gets `access.yank` / `access.delete`, `Credential` gets `yank_grants` and `delete_grants`, and a yank or delete login token carries `yank` / `delete` instead of `admin` for such a credential. Additive: no data migration, `MIN_CLIENT_VERSION` unchanged.                                                                                                                                                                                                                                                                                                                                                                |
| 12      | 2026-10-28 | CLI: `sreg yank` and `sreg delete` are back (administration remains available in the panel and the API), with `--oidc` and `--login`. Browser login gains the purposes `yank` and `delete`: an `admin` credential approves named package versions (a delete may name a whole package) and the CLI collects a 15-minute `admin` token limited to those operations (`ops`). The `_` login resolves `admin` credentials on the routes that need that role alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 11      | 2026-10-28 | `admin` may be combined with `read` and `publish` in one credential: `roles` takes any non-empty combination, `scope` may include `admin`, the legacy `kind` reports `admin` first, existing secrets are pinned when a role is added, and the last admin credential cannot lose `admin`. Logins scoped to `read` or `publish` on such a credential issue login tokens.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 10      | 2026-10-28 | Credentials with roles: one credential may hold `read` and `publish` together (`admin` stays alone), with separate grants per role (`read_grants`, `publish_grants`) and a `scope` on every secret that limits it to some of the roles, which is required when the credential holds both. `kind` and the flat `grants` stay in API responses as the legacy view. Data migration 4 rewrites `cred:*` records.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 9       | 2026-10-28 | CLI: `--archive` for composer, npm, cargo and nuget publishes a prebuilt archive byte for byte (identity, version and dependencies from the manifest inside it, no git or native tools), and `--source-registry-index` for cargo migrates crates built for a retired registry (`registry: null`) without changing the archive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 8       | 2026-10-28 | Optimisation for the free plan limits: KV only for state changed by a human. The grant closure from the `_meta/deps/<eco>.json` graph in R2 and the Cache API (no `closure:*` keys and no invalidation), JWKS and `HttpSource` in the Cache API, JWTs not cached, panel sessions as signed cookies (`SESSION_SECRET`, no `session:*` in KV), a credential cache in the isolate's memory. A new "Free plan limits" section in Deploy; D1 noted as an alternative.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 7       | 2026-10-28 | The Swift ecosystem (Package Registry SE-0292: release list, metadata, manifests as `manifest` files, archive through `302`, identifiers; `sreg swift publish` through `archive-source` + `dump-package`) and the Maven ecosystem (Maven 2 layout for Maven/Gradle/Android: `maven-metadata.xml`, files through `302`, checksums from `digests`; several files per version, `archive` from `<packaging>` including `.aar`, `.module`; no SNAPSHOT; `sreg maven publish --from-dir`).                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6       | 2026-10-28 | `files[].digests`: an adapter can request additional digests in `init` (sha1, md5, sha512), computed by the Worker at `commit` while copying from staging; `sha256` stays mandatory. The `_` login for `gh` tokens: the project is resolved from the `repository` claim through the `gh-repo:<owner/repo>` index in KV, and the kind of request selects `read`/`publish`; `sreg auth --oidc` and `publish --oidc` work without `--project`. The `gh` entry clarified: a table of fields (`repository`, `repository_id`, `repository_owner_id`, `ref`, `workflow`, `environment`, `expires`) mapped to claims; a `publish` credential may also have a `key`.                                                                                                                                                                                                                                                           |
| 5       | 2026-10-28 | Transitive grants (`grants.transitive`, default `true` for `read`): access to dependencies from the registry, computed from the constraints in the manifests, cached as `closure:<project>:<eco>` in KV; `publish` unchanged. The home page shows dependencies as a collapsed subtree under the source package.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4       | 2026-10-28 | CLI: a table of packing commands (`npm pack`, `cargo package`, `dotnet pack`, `git archive`) with the flags reserved by `sreg` and the rest passed through after `--`; monorepo support: `--path`, `--workspace`, `--package`, `--project`, `--tag-prefix`; one call = one package, one version. New flags: the common `--skip-existing` (code `0` on `409`), `--no-symbols` for nuget.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 3       | 2026-10-28 | Fifth ecosystem, NuGet (V3 protocol: service index, flat container, registration, search; Basic auth from `nuget.config`; `.snupkg` as `symbols`; `sreg nuget publish`). The version format is defined by the adapter (`validateVersion`), not by the kernel – NuGet allows 4 parts. A table of `yank` semantics per ecosystem in the Publishing section.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2       | 2026-10-28 | A package version is a list of files (`files[]`), not a single file: the manifest, `init`/`commit`, the adapter contract (`fileKey`) and the CLI accept multiple files; the "exactly one `archive`" rule belongs to the composer/npm/cargo adapters. New **generic** ecosystem: arbitrary files with an open `labels` map (`?label=k:v` filter) and `meta`, a JSON feed (list, `latest`, version, `302` to the file, `ETag`), the commands `sreg generic publish` (`--label k=v` per call, optional `--spec`) and `sreg generic get`, appending files to a version within the `APPEND_WINDOW_HOURS` window. Modularity clarified: adapters as modules in the repository, enabled through `vars.ECOSYSTEMS` and Cargo feature flags. CLI: `--version` also in `npm`/`cargo publish` (replacing the version in the manifest file), administrative commands removed – administration only through the panel and the API. |
| 1       | 2026-10-28 | First version of the specification.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
