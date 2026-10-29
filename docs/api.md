# HTTP API contract (`/api/v1`)

This document is the contract between the Worker and the `sreg` CLI (and the admin panel). It
is the source of truth for the `/api/v1` surface: a client can be implemented from this
document alone. The native read protocols (`/composer`, `/npm`, `/cargo`) and the panel's
`/login` and `/logout` are described in [spec.md](spec.md) and are out of scope here. The
generic feed (`/generic/…`, section 8), the NuGet feed (`/nuget/…`, section 9), the Swift
registry (`/swift/…`, section 10) and the Maven repository (`/maven/…`, section 11) are not
part of `/api/v1`, but the CLI and the package manager clients depend on their exact shape, so
they are specified here. Section 12 records details of the npm and cargo read protocols that
the spec leaves open.

Changes to this document must be backwards compatible (new optional request fields, new
response fields, new endpoints, new error codes) or must introduce `/api/v2`. When a new path
version is introduced, the previous one stays available for at least one minor release of the
Worker.

## 1. Conventions

### 1.1 Base URL and versioning

- Base URL: `<PUBLIC_URL>/api/v1`, e.g. `https://packages.example.com/api/v1`. `PUBLIC_URL`
  has no trailing slash. All paths below are relative to the host (they include `/api/v1`).
- The API version is part of the path. There is no version negotiation through media types.

### 1.2 Encoding

- Every request body and every response body is JSON encoded as UTF-8. There are no
  successful responses without a body (the API never answers `204`).
- Requests that carry a body must send `Content-Type: application/json`. A body with any other
  content type, a body that is not valid JSON, or a JSON value that is not an object is
  rejected with `400 invalid_request`. Requests without a body (all `GET`, and `POST`/`DELETE`
  endpoints whose body is optional) may omit the header and the body entirely; an empty body
  is equivalent to `{}`.
- Request bodies are limited to 4 MiB; larger bodies are rejected with
  `413 payload_too_large`. An upload (`init`) declares at most 64 files; more are rejected with
  `400 invalid_request`.
- Every response carries `Content-Type: application/json; charset=utf-8` and
  `Cache-Control: no-store`.
- Unknown fields in request bodies are ignored by the Worker, unless an endpoint says
  otherwise. Clients must ignore unknown fields in response bodies and unknown response
  headers.
- Field names are `camelCase`, except where a field mirrors an ecosystem-native format (the
  `manifest` object, cargo index fields, HTTP header names in `headers`).
- Timestamps are RFC 3339 strings in UTC with a `Z` suffix and second precision, e.g.
  `2026-10-28T10:12:00Z`. Where a request accepts a timestamp, a date-only value
  `YYYY-MM-DD` is also accepted and means `00:00:00Z` of that day. Responses always use the
  full form.
- `sha256` values are 64 lower-case hexadecimal characters.
- Sizes are integers in bytes.
- Lists are not paginated in `v1`.
- There are no CORS headers; the panel is served from the same origin.

### 1.3 Path parameters

| Parameter       | Format                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<eco>`         | `composer`, `npm`, `cargo`, `generic`, `nuget`, `swift` or `maven`, and only when it is enabled in `ECOSYSTEMS` (1.5). Any other value answers `404 not_found`.                                                                                                                                                                                                   |
| `<name>`        | Package name, percent-encoded as one path segment: `/` must be sent as `%2F`, `@` may be sent literally or as `%40`. Examples: `acme%2Fsdk` (composer), `%40acme%2Fsdk` (npm), `acme-core` (cargo), `acme%2Fplugin-foo` (generic), `Acme.Sdk` (nuget; matched case-insensitively), `acme.Networking` (swift; matched case-insensitively), `com.acme:sdk` (maven). |
| `<version>`     | Exact version string as published, percent-encoded (versions never contain `/`); for nuget it is normalised first (5.2).                                                                                                                                                                                                                                          |
| `<project>`     | A local project slug, `[a-z0-9][a-z0-9-]{1,62}`. A value containing `.` (a provider-backed project) answers `400 invalid_request`.                                                                                                                                                                                                                                |
| `<hash-prefix>` | 8 to 12 lower-case hexadecimal characters identifying an auth entry (see 6.1).                                                                                                                                                                                                                                                                                    |

The Worker matches paths on the raw (still percent-encoded) path and decodes each segment
separately, so `%2F` inside `<name>` never splits the segment.

### 1.4 Evaluation order

The Worker processes an `/api/v1` request in this order and answers with the first failure:

1. Bucket check, only for the package and publish endpoints (`/api/v1/packages…`,
   `/api/v1/publish/…`) → `503 bucket_mismatch` (6.23).
2. Version check (`X-Client-Version`, section 3) → `400 invalid_request` or
   `426 client_too_old`.
3. Routing → `404 not_found` for an unknown path or an unsupported method on a known path.
4. Body parsing and size → `400 invalid_request`, `413 payload_too_large`.
5. Authentication → `401 unauthorized`, `503 provider_unavailable`.
6. Role check → `403 forbidden`.
7. Field validation → `400 invalid_request`, `413 payload_too_large`.
8. Grant check and endpoint logic → `400 upload_incomplete`, `403 forbidden`, `404 not_found`,
   `409 …`.

### 1.5 Installation variables

These Worker variables (see the spec, "Deployment, configuration and updates") change what
the contract allows:

| Variable              | Default                                              | Effect                                                                                                                                                                                                                                                                         |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PUBLIC_URL`          | the request's origin                                 | base of every URL in responses (`url` fields, `aud` of `gh` tokens)                                                                                                                                                                                                            |
| `ECOSYSTEMS`          | `composer,npm,cargo,generic,nuget,swift,maven` (all) | enabled ecosystems; a disabled one is treated as unknown: `<eco>` paths answer `404 not_found`, `eco` in `init` is `400 invalid_request`, listings omit it and every path of its read protocol (e.g. `/generic/…`, `/nuget/…`, `/swift/…`, `/maven/…`) answers `404 not_found` |
| `MAX_UPLOAD_BYTES`    | `536870912` (512 MiB)                                | largest `size` of each file in `init`                                                                                                                                                                                                                                          |
| `APPEND_WINDOW_HOURS` | `24`                                                 | how long after `published` files may still be appended to a version (6.4.1)                                                                                                                                                                                                    |
| `MAX_PUBLISH_SCOPES`  | `20`                                                 | most `scopes` a publish login (2.6, 6.20) can name; 1 to 100, anything else means the default                                                                                                                                                                                  |
| `TOKEN_PREFIX`        | empty                                                | optional token prefix (2.1)                                                                                                                                                                                                                                                    |
| `SESSION_SECRET`      | none (a secret)                                      | HMAC key of the panel session cookie (2.3); while it is unset, a panel login answers `500 internal_error` naming the setting; rotating it invalidates every session                                                                                                            |

## 2. Authentication

### 2.1 Token format

```text
[<TOKEN_PREFIX>][<source>.]<project>:[<type>.]<secret>
```

- `source` (optional): an identifier of an external credential provider configured in
  `AUTH_PROVIDERS`. Absent means the credential is stored in the Worker's KV. In `v1` only KV
  credentials are implemented; a token naming a source answers `401 unauthorized` until
  providers are implemented. When they are, an unreachable provider answers
  `503 provider_unavailable` for tokens of that source.
- `project`: slug `[a-z0-9][a-z0-9-]{1,62}`, or the reserved login `_` (2.5).
- `type` (optional): `key` (default; never written out), `gh` (a GitHub Actions OIDC JWT) or
  `st` (a signed login token, 2.6).
- `secret`: for `key`, 32 base62 characters generated by the Worker (a `key` is never a
  password; an `admin` password stored as a `key` by an older Worker still verifies, see 6.17);
  for `gh`, the whole JWT (it contains
  dots, which is fine: the secret is everything after `<type>.`); for `st`,
  `<base64url payload>.<base64url signature>`.

Parsing:

1. If `TOKEN_PREFIX` is a non-empty string and the token starts with it, strip it.
2. Split at the **first** `:` into login and password. No `:` → `401`.
3. Login: one `.`-separated segment → `project`; two segments → `source.project`; anything
   else → `401`. The login `_` (it fails the slug pattern, so it can never name a project) is
   allowed only alone and only with type `gh`; anything else with `_` → `401`.
4. Password: when it contains a `.` and the part before the first `.` is a known secret type
   (`key`, `gh` or `st`), that part is the type and the rest is the secret; otherwise the type is
   `key` and the whole password is the secret. So a legacy admin password with dots works as
   `admin:my.pass.word`, and `admin:key.my.pass.word` is the same token. (This refines the
   spec's "with a dot, the first segment is the type": an unknown first segment is no longer
   `401` but part of a `key` secret, which then simply fails verification unless it is a
   password.) A `gh` secret must be a compact JWT; a `st` secret must be two base64url
   segments, the second 43 characters long (the login `_` never takes `st`); a `key` secret
   must be non-empty and at most 512 characters.

`TOKEN_PREFIX` (a Worker variable, empty by default) is a fixed string such as `srg_` that the
Worker puts in front of every token it issues, so leaked tokens can be found with grep. When
it is set, tokens are accepted both with and without the prefix, so enabling it does not
invalidate existing tokens. The prefix must contain a character that cannot occur in a source
or project slug (the recommended form ends with `_`).

Examples:

```text
shop-frontend:k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e     project shop-frontend, type key
ci-acme-sdk:gh.eyJhbGciOi….eyJpc3Mi….SflKxw…       project ci-acme-sdk, type gh
shop-frontend:st.eyJwcm9qZWN0Ij….Qm9o2dGhpcyBp…    project shop-frontend, type st (2.6)
_:gh.eyJhbGciOi….eyJpc3Mi….SflKxw…                 project resolved from the JWT (2.5)
srg_shop-frontend:k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e with TOKEN_PREFIX = "srg_"
```

### 2.2 Accepted `Authorization` forms

| Form           | Header                                         | Normalisation                                                                                                                       |
| -------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Bearer         | `Authorization: Bearer <token>`                | the value after `Bearer ` is the token                                                                                              |
| Basic (token)  | `Authorization: Basic base64(<token>)`         | the decoded string is the token (Basic login = token login, Basic password = token password)                                        |
| Basic (pasted) | `Authorization: Basic base64(<login>:<token>)` | the decoded password contains `:`, so the password is the full token; the Basic login must equal the token's login, otherwise `401` |
| Raw            | `Authorization: <token>`                       | the whole header value is the token                                                                                                 |

The scheme names `Bearer` and `Basic` are case-insensitive. The CLI always uses the Bearer
form. A `gh` token is verified against GitHub's JWKS, with `aud` equal to `PUBLIC_URL`; the
CLI requests the OIDC token with exactly that audience. Its signature is verified on every
request: the Worker caches GitHub's JWKS (in the Cache API, for 24 hours, refetched early when
a token names an unknown key), never the outcome of a verification. Credential records are
cached by each Worker isolate for up to 60 seconds, so a change made elsewhere (a revoked
secret, new grants) takes effect within about a minute, like KV propagation.

### 2.3 Panel sessions

After a successful login (with any form of 2.2, including `_:gh.<jwt>`, which resolves with
the `read` role) the panel sets the cookie `sreg_session` (`HttpOnly; Secure; SameSite=Lax;
Path=/`, 12 hours). The session is not stored on the server: the cookie value is
`<payload>.<signature>`, where the payload is the base64url JSON `{ "project", "exp" }` and the
signature its base64url HMAC-SHA256 under a key derived from the Worker secret
`SESSION_SECRET` and the payload type. The payload also carries `"typ": "sess"`, which the
Worker checks, so a cookie never verifies as a login token (2.6) or the other way round. A
session started with a `login` secret (2.6) additionally carries `"entry"` (the entry's `id`)
and, when that entry has a one-time code, `"totp_at"` (when a code was last verified); it ends
with that entry. The panel signs in with the login and password of a `login` secret (the
default on the login page; any credential, an admin too; a `login` limited to `publish` does
not open the panel of a credential that can also read) in two steps when the entry
has a one-time code: the password, then the code (2.6). A token can still be pasted instead
(`Token` on the login page). Cookies without `"typ"` (written by Worker versions before login secrets)
are not accepted, so deploying this version signs every panel user out once. The Worker
verifies the signature (in constant time) and `exp` on every request, and the credential must
still exist and have an active auth entry. Logging out clears the cookie; a copied cookie
stays valid until `exp`, and changing `SESSION_SECRET` ends every session. Without
`SESSION_SECRET` the panel login answers `500` naming the missing setting, while
`Authorization` tokens keep working.

The panel calls the same endpoints authenticated by its session cookie instead of an
`Authorization` header. When both are present, `Authorization` wins. A cookie-authenticated
`POST`, `PATCH` or `DELETE` must carry a non-empty `X-Requested-With` header, otherwise it is
rejected with `403 forbidden` (CSRF protection). Requests authenticated with `Authorization`
do not need that header. The CLI never uses cookies.

### 2.4 Credential roles

A credential has one or more roles: any non-empty combination of `read`, `publish`, `yank`,
`delete` and `admin`. `read`, `publish`, `yank` and `delete` each have their own list of grants;
`admin` has none of its own. Every secret (an auth entry) has a `scope`, the roles it may use,
a non-empty subset of the credential's roles. A request uses the roles of the credential
within the scope of the secret that authenticated it:

| Role      | May call                                                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`    | `whoami`, package listing and generic feed (filtered by its `read` grants)                                                                                                          |
| `publish` | `whoami`, `publish/init`, `publish/commit` (within its `publish` grants)                                                                                                            |
| `yank`    | `whoami`, package listing (filtered by its `yank` grants), `yank` of the versions its `yank` grants cover                                                                           |
| `delete`  | `whoami`, package listing (filtered by its `delete` grants), `delete` of the versions its `delete` grants cover; a whole package only with a grant for all versions (`versions: *`) |
| `admin`   | `whoami`, package listing and generic feed (unfiltered), package administration (yank and delete anywhere, reindex), credentials                                                    |

`yank` and `delete` let an account clean up packages without being an administrator: they
reach none of the credential, reindex or bucket routes, cannot install or publish, and their
package listing never has `dependencies`. An `admin` may yank and delete anywhere, whatever the
grants say. A `yank`/`delete` secret is a `key`, a `gh` entry (for a job that yanks, see 2.5) or a
`login` (2.6). A `login` that has a `yank` or `delete` role in its scope signs in to the panel: a
session started with it carries those roles (never `publish`), so the panel's "Yank" and
"Delete" buttons, which call this API, work within the grants. Without `read` the panel shows
only the packages the grants cover, their versions with those buttons and "Delete package"
(with a grant for all versions), and no version pages, downloads, configuration or `/admin/*`.

A login token approved for a yank or delete (2.6) carries the `admin` role, or for a credential
that holds `yank` and/or `delete` instead of it, those roles, but only the operations it
names: it may call `whoami` and those yank and delete routes and nothing else (the table above
does not apply to it).

Any role may hold `key` and `gh` entries; a `publish` credential usually has `gh` entries and
may also have `key` entries (for publishing from outside GitHub Actions). Any credential may also
hold `login` entries for people (2.6). A credential that holds `admin` together with `read` or
`publish` is one identity whose secrets are told apart by their `scope`: a `key` scoped to
`read` reads with the `read` grants and cannot call the administrative API, while a `login`
scoped to `admin` signs in to the panel. A secret never gains a role: adding
a role to a credential leaves its existing secrets with the roles they had, so a `key`
committed to a consumer's repository cannot start publishing. When a credential holds both
roles, a new secret must say which it may use (`scope`, 6.17); a `login` is limited the same
way, and a login token carries only the role it was approved for (2.6). A cookie session (2.3)
never carries `publish`.

Credential records are cached in the Worker isolate for 60 seconds. A deleted credential, an
expired or removed secret and changed grants can therefore keep working for up to 60 seconds
on a warm isolate, in addition to KV propagation (up to about 60 seconds).

`GET /api/v1/version` requires no credential. A missing, malformed, unknown, expired or
otherwise invalid credential answers `401 unauthorized` with
`WWW-Authenticate: Bearer realm="serverless-registry"`. A valid credential or secret without the role the endpoint needs,
or without a grant for the requested package and version, answers `403 forbidden`.

### 2.5 `gh` entries and the `_` login

A `gh` auth entry matches the claims of a GitHub Actions OIDC JWT. The kernel always checks
`iss` (`https://token.actions.githubusercontent.com`), `aud` (= `PUBLIC_URL`), `exp` and `nbf`
itself; an entry then matches when every field it sets matches (an absent or `null` optional
field means "any"):

| Field                 | Claim                 | Match                                                                                                                        |
| --------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `repository`          | `repository`          | required; `owner/repo` (equal, case-insensitively) or `owner/*` (any repository of that owner)                               |
| `repository_id`       | `repository_id`       | equal (a string of digits)                                                                                                   |
| `repository_owner_id` | `repository_owner_id` | equal (a string of digits)                                                                                                   |
| `ref`                 | `ref`                 | glob over the full ref, `*` matches any characters (including `/`): `refs/heads/main`, `refs/tags/v*`                        |
| `workflow`            | `workflow_ref`        | equal to the claim after stripping the leading `owner/repo/` and the trailing `@<ref>`, e.g. `.github/workflows/release.yml` |
| `environment`         | `environment`         | equal                                                                                                                        |
| `expires`             | –                     | the entry is active while `expires` is `null` or in the future                                                               |

Pinning on first use: every `gh` entry also has `pin_on_first_use` (boolean, stored
explicitly, default `true`). When a token matches an entry with `pin_on_first_use: true` that
has no `repository_id` (only for an exact `owner/repo` entry) or no `repository_owner_id`
(any entry), the Worker writes the token's `repository_id` and `repository_owner_id` claims
into the entry before answering, and from then on they must match like any other set field.
So an entry created by name stops matching a repository (or owner) that is deleted and
re-created under the same name. An `owner/*` entry pins only the owner id. Ids that are
already set are never changed, an entry with `pin_on_first_use: false` is never changed, and
a token without the id claims pins nothing. The write updates the stored credential like an
admin edit; concurrent first requests write the same values.

With `<project>:gh.<jwt>` the credential `<project>` must have a matching active `gh` entry.
With the reserved login, `_:gh.<jwt>`, the Worker resolves the project from the JWT:

1. Verify the JWT as above (failure → `401 unauthorized`).
2. Read the `repository` claim and look up the KV keys `gh-repo:<owner/repo>` and
   `gh-repo:<owner>/*`, both lower-cased (GitHub names are case-insensitive). Each value is a
   JSON array of project names; the union is the list of candidates.
3. Load every candidate's record and keep the ones with a matching active `gh` entry.
4. Keep only the credentials that hold the role the request needs, through a matching entry
   whose `scope` includes it: `publish` for `/api/v1/publish/*`, `admin` for the routes that
   need the `admin` role alone (reindex of packages, credentials and their secrets, the GitHub
   repository lookup and bucket accept), `admin` or `yank` for a yank and `admin` or `delete`
   for a delete (the credential's `yank` / `delete` grants are then checked as for a key),
   `read` for every other
   authenticated route (including `whoami`, the package listing, the generic and NuGet feeds
   and a panel login). So `sreg yank --oidc` and `sreg delete --oidc` need no `--project`
   when exactly one credential with the `admin` (or `yank` / `delete`) role has a matching `gh`
   entry; `<project>:gh.<jwt>` works for an `admin`-, `yank`- or `delete`-scoped `gh` entry on
   the same routes.
5. Exactly one left → that is the identity. None → `401 unauthorized`. More than one →
   `401 unauthorized` with the message
   "more than one project matches this token; use <project>:gh.<jwt>".

The resolved name is what `whoami` returns as `project` and what manifests record as
`publishedBy`; `_` never appears there. A panel login with `_` resolves the same way, with
the `read` role. Only KV credentials take part (a provider source cannot be combined with `_`).

The `gh-repo:<owner/repo>` index (and `gh-repo:<owner>/*` for owner globs) is maintained by
every credential write in the API and the panel (create, replace grants, add or expire a
secret, delete) and is rebuilt by data migration 2.

### 2.6 `login` entries and browser login

A `login` auth entry is a password and, optionally, a time-based one-time code (TOTP, RFC 6238:
HMAC-SHA1, 30-second steps, 6 digits, one step of drift either way). It is never sent as a
token. A person uses it to sign in to the panel (any credential, an `admin` too) and
to approve one operation in a browser, and the client then receives a short-lived **login
token** (`type` `st`, 2.1) for the credential the entry belongs to. The token carries one
role and the grants of that role: a pull login issues a `read` token and a publish login a
`publish` token, and the credential must hold that role with the `login`'s `scope` including it
(a credential with both roles can issue both kinds; a `login` scoped to `read` only issues pull
tokens). A yank or delete login issues a token limited to the operations it names: an `admin`
token (a credential with the `admin` role and a `login` whose scope includes `admin`) or, for
a credential without `admin`, a `yank` / `delete` token (the credential holds that role, the
`login`'s scope includes it, and its grants of that role cover **every** operation, 5.1). A
`login` whose scope has no `read` or `publish` (an `admin`, `yank` or `delete` login) approves
yank and delete logins; it never issues a pull, a publish or a general administration token
(the approval page of those does not accept it). A `yank` or `delete` only `login` signs in
to the panel (2.4).

The flow (the CLI does it for `sreg login`, `sreg auth <ecosystem> --login`, `sreg generic get
--login`, `sreg <ecosystem> publish --login`, `sreg yank --login` and `sreg delete --login`):

1. The client calls `POST /api/v1/auth/sessions` (6.20) with what it needs: a pull, a
   publish of named package versions, or a yank or delete of named versions or packages. It receives a signed session id, the page to open and a
   poll token. **Nothing is stored**, so anonymous callers cannot use up KV writes.
2. The person opens `<PUBLIC_URL>/authorize/<session>`. The page shows the request. Without a
   login session the person signs in in up to two steps. **Step 1** is the project name and the
   password. A wrong project and a wrong password give the same answer. When the password is
   right and the entry has no one-time code, the browser gets its session. When it has one,
   the Worker sets the short-lived cookie `sreg_pending` and the page asks for the code
   (**step 2**); the password is not carried over. The cookie is a signed value
   (`typ` `pending`, so it is neither a session nor a token) holding `{ project, entry, ctx,
exp }`, valid 5 minutes, `HttpOnly; Secure; SameSite=Lax`, limited to the path of the step
   (`/authorize/` here, `/login` for the panel) and tied to this login request (`ctx` is its
   nonce, `panel` for the panel login); nothing reads it but the code step, and it opens no
   page and no API. A right code starts the session (with `totp_at`) and clears the cookie; a
   wrong code keeps the cookie, so the person can try again within the 5 minutes. A
   one-time code is accepted once (`last_step` is stored with the entry). The panel login
   (`POST /login`, then `GET`/`POST /login/code`) works the same way.
3. With a login session the page asks only for approval. A **publish** is shown with every
   package version and is approved only when the credential has the `publish` role (within the
   login's scope) and its `publish` grants allow **each** of them (5.1); otherwise the page lists the versions that are not
   allowed and offers no approval. The same checks run again on the approval request. When
   the entry has a one-time code, a publish also needs one verified within the last 15
   minutes in this browser session; if not, the page asks for a new one first. A **pull** has
   a checkbox "extended validity". A **yank** or **delete** is shown with every package
   version (a delete may be a whole package, shown as such, with a warning that deleting
   cannot be undone) and is approved only when the credential has the `admin` role (within the
   login's scope), or the `yank` (for a yank) / `delete` (for a delete) role and grants of that
   role that cover **each** version (a whole package needs a grant with `versions: *`);
   otherwise the page offers no approval. The same checks run again on the approval request.
   It needs the same fresh one-time code as a publish. The sign-in on this page accepts a login
   with only `admin`, `yank` or `delete` for a yank or delete, and not for a pull or a publish.
4. On approval the Worker issues the token and stores it at `login-session:<nonce>` for the
   rest of the session's life (at most 10 minutes). The client polls `POST
/api/v1/auth/sessions/poll` (6.21) until it receives the token, which is then deleted.

A pull token lasts 1 hour, or `LOGIN_TOKEN_EXTENDED_TTL_HOURS` (default 24) when extended
validity was ticked; a publish token and an admin token (yank, delete) last 15 minutes. A publish token carries `scopes`, the
approved `{ eco, package, version }` list (at most `MAX_PUBLISH_SCOPES`, default 20): `publish/init` and `publish/commit`
answer `403 forbidden` for anything else, and `whoami` (6.3) returns the scopes.

An admin token carries `ops`, the approved operations, `{ "op": "yank" | "delete", "eco",
"package", "version"? }` (at most `MAX_PUBLISH_SCOPES`); `version` is absent for the deletion
of a whole package. It carries the `admin` role (for a credential without it: the `yank` and/or
`delete` role its operations need) and may call only:
`POST /api/v1/packages/<eco>/<name>/<version>/yank` for a version in a `yank` operation,
`DELETE /api/v1/packages/<eco>/<name>/<version>` for a version in a `delete` operation,
`DELETE /api/v1/packages/<eco>/<name>` for a `delete` operation without `version`, and `GET
/api/v1/whoami`. Names and versions are compared in their stored form (1.3). An operation
that was not approved is `403 forbidden` ("This login token was not approved for this
operation."), every other route is `403 forbidden` ("This login token may not perform this
operation."): the package listing, `reindex`, credentials, secrets, the GitHub lookup, bucket
accept and publishing, and so are the native protocol routes and the panel login. A delete of
a whole package does not approve deleting one of its versions, nor the other way round.

The token is `<project>:st.<payload>.<signature>`; the payload is base64url JSON
`{ "typ": "st", "project", "entry", "exp", "scopes"?, "ops"? }` and the signature its HMAC-SHA256 under
a key derived from `SESSION_SECRET` and `"st"`. Nothing is stored per token. On every request
the Worker verifies the signature, `typ`, `exp` and `project`, that the credential is not
lacks the role (`read` for a pull token, `publish` when `scopes` are present, `admin` when `ops`
are present; a token never has both), and that the `login` entry named by
`entry` still exists and is active and its scope includes the role: expiring or removing the entry, deleting the credential or
changing `SESSION_SECRET` ends every token it issued (within the cache time of 2.4).

The one-time code's shared secret has to be recoverable, so it is stored AES-GCM encrypted
under a key derived from `SESSION_SECRET`; changing `SESSION_SECRET` makes such an entry
unusable and it has to be replaced. Passwords are stored as `pbkdf2-sha256$<iterations>$<salt
base64>$<hash base64>` with a random 16-byte salt and 10 000 PBKDF2-SHA256 iterations, which
costs about 5 ms of CPU per verification in the Workers runtime and so stays within the free
plan's 10 ms per request; verification uses the iteration count stored with each hash.

There is no rate limiting in `v1`: the only protection against guessing a password or code is
the cost of PBKDF2 and the one-time code itself. Operators should add a rate limiting rule for
`/authorize/*` at the edge (see the deployment guide).

## 3. Client version negotiation

- The CLI sends `X-Client-Version: <semver>` (its own version, e.g. `0.3.1`) on every
  request. Browsers and other clients may omit it; then no check is made.
- Every `/api/v1` response, including errors and `404`s, carries
  `X-Min-Client-Version: <semver>`, the oldest CLI version this Worker supports.
- If `X-Client-Version` is present and lower than the minimum (semver precedence, so
  `0.2.0-beta.1` < `0.2.0`), the Worker answers `426 Upgrade Required` with error
  `client_too_old`, before authentication. A value that is not a valid semver version answers
  `400 invalid_request`.
- `GET /api/v1/version` is exempt from the check so that old clients can always discover the
  requirement.
- The CLI should also compare its own version with `X-Min-Client-Version` on successful
  responses and may warn when it is close to the minimum. On `426` it prints a message with a
  link to the latest release and exits with code `3`.

## 4. Errors

Every non-2xx response has this body:

```json
{ "error": "<snake_case_code>", "message": "<human-readable text>" }
```

`error` is stable and meant for programs; `message` is for humans and may change. Messages
never contain secrets (tokens, hashes, presigned URLs). Clients must treat an unknown `error`
value according to its HTTP status. A few codes add fields after these two (`ambiguous`,
8.7); clients ignore fields they do not know.

| Code                   | Status | Meaning                                                                                                                      |
| ---------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `invalid_request`      | 400    | Malformed JSON, missing or invalid field, malformed header, constraint that cannot be parsed, and similar.                   |
| `upload_incomplete`    | 400    | On `commit`: at least one declared file is missing from staging (its `PUT` never completed).                                 |
| `unauthorized`         | 401    | No credential, or the credential could not be verified (unknown project, wrong secret, expired, bad JWT).                    |
| `forbidden`            | 403    | Valid credential, but without the role, no matching grant, missing `X-Requested-With`, or a protected operation.             |
| `not_found`            | 404    | Unknown path or method, unknown or disabled ecosystem, unknown package, version, file, credential, auth entry or `uploadId`. |
| `version_exists`       | 409    | The version is already published (on `init` without `append`, and on `commit`).                                              |
| `version_closed`       | 409    | `append` to a version whose append window (`APPEND_WINDOW_HOURS`) has passed, or that is yanked.                             |
| `file_exists`          | 409    | `append` with a file name that already exists in the version.                                                                |
| `upload_mismatch`      | 409    | On `commit`: the size or SHA-256 of a staged file differs from the `init` declaration.                                       |
| `credential_exists`    | 409    | `POST /api/v1/credentials` for a project that already exists.                                                                |
| `ambiguous`            | 409    | Generic label-selected download (8.7): more than one file matches; the body also lists `version` and the candidate `files`.  |
| `payload_too_large`    | 413    | Request body over 4 MiB, or the `size` of a file in `init` above `MAX_UPLOAD_BYTES`.                                         |
| `client_too_old`       | 426    | `X-Client-Version` is lower than `X-Min-Client-Version`.                                                                     |
| `rate_limited`         | 429    | Reserved; not emitted in `v1`. If received, wait for `Retry-After` seconds (default 10) and retry.                           |
| `internal_error`       | 500    | Unexpected failure in the Worker.                                                                                            |
| `provider_unavailable` | 503    | The external credential provider of the token's source did not answer. Never falls back to no auth.                          |
| `bucket_mismatch`      | 503    | The R2 bucket is not the one this installation used before (6.23). The body also has `reason`: `empty` or `other`.           |

To avoid leaking the existence of packages, a `read` credential asking for a package it has
no grant for receives `404 not_found`, not `403`.

## 5. Common types

Written as TypeScript for precision; `?` marks an optional field, `| null` a field that is
always present but may be `null`.

```ts
type Eco = "composer" | "npm" | "cargo" | "generic" | "nuget" | "swift" | "maven";
type Kind = "read" | "publish" | "yank" | "delete" | "admin"; // a role of a credential
type Role = "read" | "publish" | "yank" | "delete"; // the roles that carry grants

interface Grant {
  eco: Eco;
  package: string; // exact name or a pattern with a trailing "*" (see 5.1)
  versions: string; // version constraint in the ecosystem's syntax, "*" = all
  transitive?: boolean; // default true; only meaningful in "read" grants (see 5.3)
}

interface KeyAuthEntry {
  id: string; // 12 lower-case hex chars: the prefix of the secret's SHA-256
  type: "key";
  scope: Kind[]; // the roles this secret may use, within the credential's roles
  created: string; // RFC 3339
  expires: string | null; // RFC 3339; null = never
  description: string | null; // a note, at most 200 characters; editable (6.22)
}

interface GhAuthEntry {
  id: string; // 12 lower-case hex chars, opaque and stable
  type: "gh";
  scope: Kind[]; // the roles this secret may use, within the credential's roles
  repository: string; // "owner/repo" or "owner/*" (2.5)
  repository_id: string | null; // digits; null = any
  repository_owner_id: string | null; // digits; null = any
  ref: string | null; // glob over the full ref, e.g. "refs/tags/v*"; null = any ref
  workflow: string | null; // workflow file path, e.g. ".github/workflows/release.yml"; null = any
  environment: string | null; // GitHub Actions environment; null = any
  pin_on_first_use: boolean; // fill in missing ids from the first matching token (2.5)
  created: string;
  expires: string | null;
  description: string | null; // a note, at most 200 characters; editable (6.22)
}

interface LoginAuthEntry {
  id: string; // 12 lower-case hex chars, opaque and stable (6.1)
  type: "login";
  totp: boolean; // whether a one-time code is required besides the password
  created: string;
  expires: string | null;
  description: string | null; // a note, at most 200 characters; editable (6.22)
}

type AuthEntry = KeyAuthEntry | GhAuthEntry | LoginAuthEntry;

interface Credential {
  project: string; // local slug
  roles: Kind[]; // a non-empty subset of ["read", "publish", "yank", "delete", "admin"]
  auth: AuthEntry[]; // includes expired entries until the hourly cron removes them
  read_grants: Grant[]; // [] without the "read" role
  publish_grants: Grant[]; // [] without the "publish" role
  yank_grants: Grant[]; // [] without the "yank" role
  delete_grants: Grant[]; // [] without the "delete" role
  /** Deprecated, kept for clients written before roles: "admin" when the credential holds it, else "read", "publish", "yank" or "delete" (in that order). */
  kind: Kind;
  /** Deprecated: the grants of `kind` ([] for "admin"). */
  grants: Grant[];
}

interface PackageFile {
  name: string; // unique within the version
  size: number;
  sha256: string;
  digests?: Record<string, string>; // extra digests computed at commit (see 6.5), hex
  role?: string; // per ecosystem (6.4), e.g. "archive", "symbols", "manifest", "pom"; absent for generic
  labels?: Record<string, string>; // generic: always present ({} when none); absent elsewhere
}

interface PackageVersion {
  version: string;
  published: string; // RFC 3339, the first publish of the version (appends do not change it)
  yanked: boolean;
  files: PackageFile[]; // in upload order; appended files come last
}

// Stored at <eco>/pkg/<name>/<version>/manifest.json; no endpoint returns it as a whole.
interface Manifest {
  eco: Eco;
  name: string; // decoded, e.g. "@acme/sdk"; nuget and swift: lower case (the casing as published is kept too)
  version: string; // nuget: normalised (5.2)
  files: PackageFile[]; // non-empty, unique names
  published: string; // RFC 3339
  publishedBy: string; // [<source>.]<project> of the credential that published it
  yanked: boolean;
  native: Record<string, unknown>; // the init `manifest` as normalised by the adapter (generic: `meta`)
}

interface Package {
  eco: Eco;
  name: string; // decoded, e.g. "@acme/sdk"
  versions: PackageVersion[]; // sorted by version precedence, highest first
  dependencies?: PackageDependency[]; // kind "read" only, see 6.6
}

interface PackageDependency {
  name: string; // a package this grant opens transitively (5.3)
  constraints: string[]; // the declared constraints that lead to it, distinct, as written (maven: see 5.3)
  versions: string[]; // the concrete versions opened, highest first
}
```

The stored KV record (see spec) keeps the full secret hash in `hash`; the API never returns
it and exposes `id` instead. An auth entry is active when `expires` is `null` or in the
future.

The version manifest is the durable data contract (see spec); package listings (6.6–6.8) and
the generic feed (section 8) are derived from it. Clients must treat an absent `labels` like
`{}`.

### 5.1 Grants

- `eco`: one of the seven ecosystems. A grant may name an ecosystem that is disabled in
  `ECOSYSTEMS`; it takes effect once the ecosystem is enabled.
- `package`: an exact package name, or a pattern whose only `*` is its last character and
  starts a segment or ends one (`acme/*`, `@acme/*`, `acme-*`). `*` matches any sequence of
  characters that does not contain `/`. The pattern `*` alone matches every package of the
  ecosystem. For nuget and swift, package names and patterns are compared case-insensitively;
  for maven, `*` may also follow the `:` (`com.acme:*`).
- `versions`: a constraint in the ecosystem's syntax (Composer, npm/node-semver, cargo
  `VersionReq`; generic and swift use the npm/node-semver syntax; nuget uses NuGet version
  ranges: `[1.0,2.0)`, `1.0` (= `>=1.0`), `[1.0]`, `(,1.0]`, floating `1.*`; maven uses Maven
  version ranges: `[1.0,2.0)`, `(,1.0]`, `[1.0]`, `1.0` (= `>=1.0`)), or `*` for all versions.
  The ecosystem's adapter evaluates it. A constraint that does not parse is
  `400 invalid_request`.
- `transitive` (optional boolean, default `true`): for `read`, the grant also opens the
  package's dependencies in this registry (5.3). It is accepted on input for every role,
  ignored for `publish`, `yank` and `delete` (those always need an explicit grant) and
  meaningless for `admin`, which has no grants. The Worker stores it explicitly (`true` when it was absent)
  and always returns it, in the credentials API as well as in `whoami`.
- A credential without a grant for an ecosystem has no access to it. For `read` a grant means
  "may install", for `publish` "may publish", for `yank` "may yank" and for `delete` "may
  delete" the versions it covers (`versions`, as for the other roles). Deleting a whole package
  (6.10) needs a `delete` grant for the package with `versions` `*`, because a narrower
  constraint would not cover versions published later; an `admin` needs no grant.

Shorthand: `eco:package[:versions[:transitive]]`, split at the first two `:` (for maven,
whose package names contain one `:`, at the first three); `versions` defaults to `*`. When the
rest ends with `:true` or `:false`, that suffix is `transitive`, otherwise `transitive`
defaults to `true`. Examples: `composer:acme/*:*`,
`npm:@acme/sdk:^2.0:false`, `cargo:acme-core:>=1.4, <2`, `generic:acme/*:^1.0`,
`nuget:Acme.*:[1.0,2.0)`, `maven:com.acme:sdk:[1.0,2.0)`.

### 5.2 Versions

The version format is validated by the ecosystem's adapter (`validateVersion`), not by the
kernel:

- **composer, npm, cargo, generic, swift**: semver 2.0.0 versions `MAJOR.MINOR.PATCH[-PRERELEASE]`
  without a leading `v` and without build metadata (`+…` is rejected because Composer cannot
  represent it and cargo ignores it for identity). For composer the prerelease, when present,
  must be `alpha`, `beta` or `rc`, optionally followed by a number with or without a dot
  (`1.0.0-beta.1`, `1.0.0-rc2`), because Composer does not understand other labels.
- **nuget**: NuGet versions: 1 to 4 numeric parts, optionally followed by a SemVer 2.0.0
  prerelease (`1.2.3-alpha.1`). Build metadata (`+…`) is accepted, ignored and stripped. The
  CLI sends the version as written; the Worker normalises it and stores and serves only the
  NuGet normalised form: lower case, leading zeros removed from the numeric parts, at least
  three parts (`1.2` → `1.2.0`) and a fourth part of `0` removed (`1.2.3.0` → `1.2.3`). For
  example `01.2.3.0-Beta+abc` becomes `1.2.3-beta`. Package ids are case-insensitive: they are
  lower-cased in R2 keys and in feed paths, but served with the original casing from the
  manifest.
- **swift**: semver as above. Package identities `scope.name` are case-insensitive: stored as
  given, lower-cased in R2 keys.
- **maven**: any `[A-Za-z0-9._+-]{1,128}` that does not end in `-SNAPSHOT` (snapshots are
  mutable and not supported), ordered by Maven's `ComparableVersion` rules. A version is a
  prerelease when it carries a qualifier that `ComparableVersion` orders before the release
  (`alpha`/`a`, `beta`/`b`, `milestone`/`m`, `rc`/`cr`). Coordinates are case-sensitive and R2
  keys use `<groupId>:<artifactId>` verbatim.

Versions are compared as exact strings for immutability (for nuget, the normalised strings, so
`1.2` and `1.2.0` are the same version).

### 5.3 Transitive access

A `read` grant with `transitive: true` also allows the versions of other packages that its
packages depend on, as long as they are in this registry:

- The Worker computes the closure from the dependency **constraints** declared in the
  manifests (`native`): starting from the versions covered by the credential's transitive
  grants, it takes their dependencies on packages of the same ecosystem that exist in this
  registry, allows the versions that satisfy the constraint (evaluated by that ecosystem's
  adapter), and repeats for those versions until nothing new is added. Example: A `1.x`
  declaring `"B": "^1.1"` opens B 1.1.0 and 1.4.0 but not B 2.0.0; once A 1.5.0 declares
  `"B": "^2.0"`, B 2.x is opened too.
- Yanked versions take part like any other version, so lockfiles that pin a yanked version
  and its dependencies keep working (6.8).
- Optional, dev and peer dependencies count like normal ones, except where the table below
  says otherwise. A constraint the adapter cannot
  evaluate (for example an npm `file:`, `git+…` or `workspace:` specifier, or an alias) opens
  nothing. Generic packages have no dependencies.
- The dependencies come from the adapter's `dependencies(m: Manifest)`, which returns
  `{ name, constraint }` pairs:

  | Eco        | Dependencies taken from the manifest                                                                                                                                                                                                          |
  | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `composer` | `require` and `require-dev` entries whose key looks like `vendor/package`; `php`, `ext-*`, `lib-*` and `composer-plugin-api` are excluded                                                                                                     |
  | `npm`      | `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies`                                                                                                                                                              |
  | `cargo`    | `deps[]` entries whose `registry` is `null` (this registry); the name is `package ?? name`, the constraint is `req`                                                                                                                           |
  | `nuget`    | every `dependencyGroups[].dependencies[]` entry, with its `range` (ids compared case-insensitively)                                                                                                                                           |
  | `swift`    | `dumpPackage.dependencies` entries of kind `registry` (identity `scope.name`); a `range` requirement becomes `>=<lowerBound> <<upperBound>`, an `exact` one the exact version; `sourceControl` and `fileSystem` dependencies do not take part |
  | `maven`    | `dependencies` with `scope` `compile` or `runtime`, `optional: false` and a `version`; the name is `groupId:artifactId`; a range is used as written, a plain version `v` is exact and becomes the range `[v]` (also in listings, 6.6)         |
  | `generic`  | none                                                                                                                                                                                                                                          |

- Transitive access is not a grant on the dependency: it does not widen the explicit grants,
  and a consumer that wants the dependency directly, with its own wider constraint, needs an
  explicit grant. Publishing always requires an explicit `publish` grant.
- The native read protocols (composer, npm, cargo, NuGet, Swift, Maven) serve transitively allowed versions
  exactly like explicitly granted ones. The `/api/v1` package listings show them separately
  (6.6).
- The closure is derived from the dependency graph `_meta/deps/<eco>.json` in R2,
  `{ "<package>": { "<version>": { "<dependency>": "<constraint>" } } }`, which `commit`,
  yank, delete and `reindex` update together with the index. Every stored version is in the
  graph, yanked ones unmarked. When a version declares the same dependency more than once with
  different constraints (npm `dependencies` and `devDependencies`, NuGet target frameworks,
  cargo targets), the value is an array of the distinct constraints in declaration order,
  `{ "<dependency>": ["<constraint>", "<constraint>"] }`, and a version satisfying any of them
  is allowed. It is cached per credential in the
  Cache API for 60 seconds, with no invalidation and nothing stored in KV, so grant changes and
  new publications take up to 60 seconds to show in transitive access.

## 6. Endpoints

| Method | Path                                                  | Role                              | Section |
| ------ | ----------------------------------------------------- | --------------------------------- | ------- |
| GET    | `/api/v1/version`                                     | none                              | 6.2     |
| GET    | `/api/v1/whoami`                                      | any                               | 6.3     |
| POST   | `/api/v1/publish/init`                                | `publish`                         | 6.4     |
| POST   | `/api/v1/publish/commit`                              | `publish`                         | 6.5     |
| GET    | `/api/v1/packages`                                    | `read`, `yank`, `delete`, `admin` | 6.6     |
| GET    | `/api/v1/packages/<eco>/<name>`                       | `read`, `yank`, `delete`, `admin` | 6.7     |
| POST   | `/api/v1/packages/<eco>/<name>/<version>/yank`        | `yank`, `admin`                   | 6.8     |
| DELETE | `/api/v1/packages/<eco>/<name>/<version>`             | `delete`, `admin`                 | 6.9     |
| DELETE | `/api/v1/packages/<eco>/<name>`                       | `delete`, `admin`                 | 6.10    |
| POST   | `/api/v1/packages/<eco>/<name>/reindex`               | `admin`                           | 6.11    |
| GET    | `/api/v1/credentials`                                 | `admin`                           | 6.12    |
| POST   | `/api/v1/credentials`                                 | `admin`                           | 6.13    |
| GET    | `/api/v1/credentials/<project>`                       | `admin`                           | 6.14    |
| PATCH  | `/api/v1/credentials/<project>`                       | `admin`                           | 6.15    |
| DELETE | `/api/v1/credentials/<project>`                       | `admin`                           | 6.16    |
| POST   | `/api/v1/auth/sessions`                               | none                              | 6.20    |
| POST   | `/api/v1/auth/sessions/poll`                          | none                              | 6.21    |
| POST   | `/api/v1/credentials/<project>/secrets`               | `admin`                           | 6.17    |
| PATCH  | `/api/v1/credentials/<project>/secrets/<hash-prefix>` | `admin`                           | 6.22    |
| DELETE | `/api/v1/credentials/<project>/secrets/<hash-prefix>` | `admin`                           | 6.18    |
| GET    | `/api/v1/github/repository?name=<owner/repo>`         | `admin`                           | 6.19    |
| POST   | `/api/v1/bucket/accept`                               | `admin`                           | 6.23    |

### 6.1 Auth entry identifiers

Each auth entry has an `id`: for `key` entries, the first 12 hex characters of the SHA-256 of
the secret (the same digest the record stores); for `gh` and `login` entries, an opaque
12-character hex value that stays stable for the entry's lifetime. `<hash-prefix>` in a path is that `id` or
any prefix of it of at least 8 characters. It must match exactly one entry of the credential:
no match → `404 not_found`, more than one → `400 invalid_request`.

### 6.2 `GET /api/v1/version`

No authentication, no version check.

Response `200`:

```json
{ "version": "0.4.0", "minClientVersion": "0.1.0", "schemaVersion": 3 }
```

| Field              | Type    | Description                                                                          |
| ------------------ | ------- | ------------------------------------------------------------------------------------ |
| `version`          | string  | semver of the running Worker                                                         |
| `minClientVersion` | string  | oldest supported CLI version (same as `X-Min-Client-Version`)                        |
| `schemaVersion`    | integer | data schema version the running Worker uses (`schema_version` in KV after migration) |

### 6.3 `GET /api/v1/whoami`

Any role. Response `200`:

```json
{
  "project": "shop-frontend",
  "kind": "read",
  "grants": [{ "eco": "npm", "package": "@acme/sdk", "versions": "^2.0", "transitive": true }],
  "roles": ["read"],
  "access": {
    "read": [{ "eco": "npm", "package": "@acme/sdk", "versions": "^2.0", "transitive": true }]
  }
}
```

`roles` are the roles this token may use: the credential's roles within the scope of the secret
that authenticated the request. `access` has one list of grants per such role (`read`,
`publish`, `yank`, `delete`); it has no key for a role the token may not use, and is `{}` for a
token that has only `admin`. `kind` and `grants` are the legacy view: `admin` and `[]` when the
token may administer, otherwise `read` and its grants when it may read, otherwise `publish`,
`yank` or `delete` (in that order) and its grants.

A publish login token (2.6) adds `"scopes": [{ "eco", "package", "version" }]`, the only
versions it may publish. A yank or delete login token adds `"ops": [{ "op", "eco", "package",
"version"? }]`, the only operations it may perform; its `roles` are `["admin"]` (or the `yank` /
`delete` roles of a credential without `admin`), `access` is `{}` and the legacy `kind` is
`admin` with `grants` `[]`.

`project` is `[<source>.]<project>` (e.g. `okta.shop-frontend` for a provider-backed
credential); for an `_:gh.<jwt>` token it is the resolved project name, never `_` (2.5). Grants are returned as stored, with `transitive`; they are `[]` for `admin`.

### 6.4 `POST /api/v1/publish/init`

Role `publish`. Validates the declaration, checks the grant and immutability (or the append
rules, 6.4.1), stores the declaration in staging and returns one presigned upload URL per file.

Request:

| Field      | Type     | Required | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eco`      | string   | yes      | `composer`, `npm`, `cargo`, `generic`, `nuget`, `swift` or `maven`; must be enabled in `ECOSYSTEMS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `name`     | string   | yes      | package name: composer `vendor/package` (lower case), npm `@scope/name` (scoped names only), cargo crate name (`^[a-z][a-z0-9_-]{0,63}$`), generic `[a-z0-9][a-z0-9._-]*` with an optional single group segment (`acme/plugin-foo`) and without `__` anywhere (R2 keys encode `/` as `__`, so `acme__x` would collide with `acme/x`), nuget the package id as in the `.nuspec` (`[A-Za-z0-9_.-]{1,100}`), swift `<scope>.<name>` (`scope` `[a-zA-Z0-9-]{1,39}`, `name` `[a-zA-Z0-9_-]{1,100}`), maven `<groupId>:<artifactId>` (`groupId` dot-separated segments of `[A-Za-z0-9_-]`, `artifactId` `[A-Za-z0-9_.-]+`) |
| `version`  | string   | yes      | version, see 5.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `files`    | object[] | yes      | the files of this upload, see below; 1 to 64 entries, names unique                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `manifest` | object   | yes      | ecosystem-native metadata, or the free-form `meta` for generic; see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tag`      | string   | no       | npm only: dist-tag to point at this version. Default `latest`; for a prerelease version without `tag` the default is `next`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `append`   | boolean  | no       | default `false`; `true` adds files to an existing version, generic only (6.4.1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

`tag` must match `^[a-z][a-z0-9._-]{0,63}$` and must not itself be a valid semver range (for
example `v1` or `x`); sending it for any ecosystem other than npm is `400 invalid_request`.

Each entry of `files`:

| Field     | Type    | Required | Description                                                                                                                                                                                                                                                      |
| --------- | ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`    | string  | yes      | file name, `[A-Za-z0-9._+-]{1,255}`, unique within the request (compared byte for byte); `.`, `..`, `manifest.json`, `meta.json` and names starting with `_` are reserved and rejected; swift manifest variants may also contain `@` (`Package@swift-5.9.swift`) |
| `size`    | integer | yes      | size in bytes, `1 ≤ size ≤ MAX_UPLOAD_BYTES` (default 536870912) for each file individually; above → `413 payload_too_large`. There is no limit on the total of all files.                                                                                       |
| `sha256`  | string  | yes      | SHA-256 of the file, 64 lower-case hex characters                                                                                                                                                                                                                |
| `role`    | string  | no       | the file's role, see below; ignored for generic                                                                                                                                                                                                                  |
| `labels`  | object  | no       | generic only, see below; ignored for the other ecosystems                                                                                                                                                                                                        |
| `digests` | –       | –        | not sent: extra digests are computed by the Worker (6.5); the field is ignored                                                                                                                                                                                   |

Rules per ecosystem:

- **composer, npm, cargo**: exactly one file with `role: "archive"`; a single file without
  `role` is treated (and stored) as `archive`. The archive's name ends in `.zip` (composer)
  or `.tgz` (npm); for cargo it is exactly `<name>-<version>.crate`. No other roles are defined, so a second file, or a file
  with another role, is `400 invalid_request`. `labels` is ignored and not stored.
- **nuget**: exactly one file with `role: "archive"`, a `.nupkg` named
  `<id>.<version>.nupkg` in lower case, and optionally one file with `role: "symbols"`, a
  `.snupkg` with the same base name. `<version>` in the file name may be the version as sent
  or its normalised form. A single file without `role` is treated as `archive`; any other file
  is `400 invalid_request`. `labels` is ignored and not stored.
- **swift**: exactly one file with `role: "archive"`, the source archive produced by
  `swift package archive-source`, named `<name>-<version>.zip`; one file with
  `role: "manifest"` named `Package.swift`; and any number of further `manifest` files named
  `Package@swift-<X[.Y[.Z]]>.swift`. Any other file is `400 invalid_request`. `labels` is
  ignored and not stored.
- **maven**: files named `<artifactId>-<version>[-<classifier>].<ext>`. The Worker derives
  each file's role from its name (a `role` sent by the client must agree, otherwise
  `400 invalid_request`): `pom` for `<artifactId>-<version>.pom` (required, exactly one);
  `archive` for the main artifact without a classifier whose extension follows the POM's
  `<packaging>` (`jar`, `aar`, `war`, …; optional, absent for `pom` packaging such as BOMs);
  `sources` for `-sources.jar`; `javadoc` for `-javadoc.jar`; `module` for `.module` (Gradle
  Module Metadata); `extra` for anything else (e.g. other classifiers or `.asc` signatures).
  Names ending in `.md5`, `.sha1`, `.sha256` or `.sha512` are rejected, because the Worker
  serves those checksums itself (11.4). The maven adapter declares
  `digests: ["sha1", "md5", "sha512"]` (6.5). `labels` is ignored and not stored.
- **generic**: any number of files; `role` is ignored and not stored. `labels` is an optional
  object mapping strings to strings: at most 32 entries, keys `[a-z0-9][a-z0-9._-]{0,63}`,
  values strings of at most 256 characters; anything else is `400 invalid_request`. Labels are
  stored as sent (`{}` when absent) and are not interpreted, only filtered on (8.1).

`manifest` per ecosystem:

- **composer**: the complete `composer.json` of the version as a JSON object. `name` is
  required and must equal `name`. If it contains `version`, that must equal `version`. The
  Worker adds `version`, `version_normalized` and `dist` itself when building the index.
- **npm**: the `package.json` found inside the tarball (`package/package.json`), as a JSON
  object. `name` and `version` must equal the request's `name` and `version`. The Worker adds
  `_id` and `dist` (`tarball` pointing to the Worker, see 12.1, and `integrity` as
  `sha256-<base64>` of the verified digest) itself; fields starting with `_` are dropped.
- **cargo**: one cargo sparse-index line without the fields the Worker computes (`cksum`,
  `yanked`, `v`), produced by the CLI from `cargo metadata`:

  ```json
  {
    "name": "acme-core",
    "vers": "1.4.2",
    "deps": [
      {
        "name": "serde",
        "req": "^1.0",
        "features": ["derive"],
        "optional": false,
        "default_features": true,
        "target": null,
        "kind": "normal",
        "registry": "https://github.com/rust-lang/crates.io-index",
        "package": null
      }
    ],
    "features": { "default": ["std"], "std": [] },
    "features2": { "json": ["dep:serde_json"] },
    "links": null,
    "rust_version": "1.75"
  }
  ```

  - `name`, `vers`: required, equal to the request's `name` and `version`.
  - `deps`: required array in the index shape: `name` is the name used in code (the rename
    when the dependency is renamed) and `package` is the real crate name when renamed,
    otherwise `null`; `req` is the requirement as written; `kind` is `normal`, `dev` or
    `build`; `target` is the `cfg(…)` or triple string or `null`; `registry` is the index URL
    of the dependency's registry, or `null` when it comes from this registry. Dependencies
    from crates.io use `https://github.com/rust-lang/crates.io-index`.
  - `features`: required object; `features2` optional object holding the features that use the
    `dep:` or `pkg?/feature` syntax, split exactly like `cargo publish` does. The Worker
    always serves index lines with `v: 2` (12.2).
  - `links`, `rust_version`: optional, string or `null`.
  - `cksum` is the `sha256` of the archive file.

- **generic**: the version's `meta`: any JSON object, possibly empty (`{}`), at most 64 KiB
  (65536 bytes) in its compact JSON serialisation as UTF-8; larger is `400 invalid_request`.
  The registry does not interpret it; it stores it unchanged and returns it as `meta` in the
  generic feed (section 8).
- **nuget**: the package metadata, parsed by the CLI from the `.nuspec` inside the `.nupkg`:

  ```json
  {
    "id": "Acme.Sdk",
    "version": "1.2.0",
    "nuspec": "<?xml version=\"1.0\" encoding=\"utf-8\"?><package …>…</package>",
    "description": "Acme SDK for .NET",
    "authors": "Acme",
    "projectUrl": "https://github.com/acme/sdk-dotnet",
    "licenseExpression": "MIT",
    "tags": ["acme", "sdk"],
    "dependencyGroups": [
      {
        "targetFramework": "net8.0",
        "dependencies": [{ "id": "Newtonsoft.Json", "range": "[13.0.1, )" }]
      },
      { "targetFramework": null, "dependencies": [] }
    ]
  }
  ```

  - `id`, `version`: required, equal to the request's `name` and `version` (as sent).
  - `nuspec`: required, the complete `.nuspec` XML as a string. The Worker serves it verbatim
    (9.5).
  - `dependencyGroups`: required array; `targetFramework` is the target framework moniker or
    `null` for a group without one; `dependencies[].id` is a package id and `range` the NuGet
    version range as written in the `.nuspec`.
  - `description`, `authors`, `projectUrl`, `licenseExpression`: optional strings; `tags`:
    optional array of strings.
  - The Worker builds the registration and search responses (9.6, 9.7) from these fields.

- **swift**:

  ```json
  {
    "toolsVersion": "5.9",
    "repositoryURL": "https://github.com/acme/networking",
    "readmeURL": "https://github.com/acme/networking/blob/main/README.md",
    "dumpPackage": { "name": "Networking", "dependencies": [], "…": "…" }
  }
  ```

  - `toolsVersion`: required, the tools version of `Package.swift`.
  - `repositoryURL`, `readmeURL`: optional strings; `repositoryURL` is what
    `GET /swift/identifiers` matches (10.6).
  - `dumpPackage`: required object, the JSON printed by `swift package dump-package`; its
    `dependencies` feed transitive grants (5.3).

- **maven**:

  ```json
  {
    "groupId": "com.acme",
    "artifactId": "sdk",
    "version": "1.4.0",
    "packaging": "jar",
    "pom": "<?xml version=\"1.0\"?><project …>…</project>",
    "dependencies": [
      {
        "groupId": "com.squareup.okhttp3",
        "artifactId": "okhttp",
        "version": "4.12.0",
        "scope": "compile",
        "optional": false
      }
    ]
  }
  ```

  - `groupId`, `artifactId`, `version`: required, equal to the request's `name` and
    `version`.
  - `packaging`: required, the POM's `<packaging>` (`jar` when the POM has none).
  - `pom`: required, the effective POM as an XML string (no `<parent>`, no unresolved
    `${…}` properties).
  - `dependencies`: required array; `scope` is `compile`, `runtime`, `provided`, `test` or
    `import`; `optional` is a boolean; `version` is a version or a range as written, or
    `null` (or absent) when the POM leaves it to an imported BOM; such a dependency takes no
    part in transitive access (5.3).

Example request (npm):

```json
{
  "eco": "npm",
  "name": "@acme/sdk",
  "version": "2.3.1",
  "files": [
    {
      "name": "sdk-2.3.1.tgz",
      "size": 48213,
      "sha256": "9f2c4e0a1b3d5f7092a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8",
      "role": "archive"
    }
  ],
  "manifest": { "name": "@acme/sdk", "version": "2.3.1", "main": "dist/index.js" },
  "tag": "latest"
}
```

Example request (generic, one job of a CI matrix):

```json
{
  "eco": "generic",
  "name": "acme/plugin-foo",
  "version": "1.4.0",
  "files": [
    {
      "name": "plugin_foo-x86_64-pc-windows-msvc.dll",
      "size": 1048576,
      "sha256": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
      "labels": { "platform": "x86_64-pc-windows-msvc", "kind": "library" }
    }
  ],
  "manifest": { "minAppVersion": "3.2" },
  "append": true
}
```

Response `200`:

```json
{
  "uploadId": "01JBX9T6Q4ZK3M8N2P5R7S9V0W",
  "expires": "2026-10-28T10:22:00Z",
  "uploads": [
    {
      "name": "sdk-2.3.1.tgz",
      "putUrl": "https://<account>.r2.cloudflarestorage.com/<bucket>/_staging/01JBX9T6Q4ZK3M8N2P5R7S9V0W/sdk-2.3.1.tgz?X-Amz-Algorithm=AWS4-HMAC-SHA256&…",
      "headers": {
        "content-length": "48213",
        "x-amz-checksum-sha256": "nyxOChs9X3CSpMbosNL0psjgstT2qMDitNb4oMLkttg="
      }
    }
  ]
}
```

| Field      | Type     | Description                                                                |
| ---------- | -------- | -------------------------------------------------------------------------- |
| `uploadId` | string   | opaque identifier, `[A-Za-z0-9_-]{16,64}`; pass it to `commit`             |
| `expires`  | string   | when every `putUrl` of this upload stops working (10 minutes after `init`) |
| `uploads`  | object[] | one entry per file of the request, in the same order                       |

Each entry of `uploads`:

| Field     | Type   | Description                                                                                  |
| --------- | ------ | -------------------------------------------------------------------------------------------- |
| `name`    | string | the file name from the request                                                               |
| `putUrl`  | string | presigned SigV4 `PUT` URL on the R2 S3 endpoint; the host is not the Worker's host           |
| `headers` | object | exactly `content-length` (decimal string) and `x-amz-checksum-sha256` (base64 of the digest) |

Every file is uploaded with `PUT <putUrl>` of its entry, with the file bytes as the body and
exactly the headers from its `headers` (plus `Host`). The CLI must send a fixed-length body (no
chunked transfer encoding), must not add `x-amz-*` or `Content-Type` headers, and must not
modify `putUrl`. The signature covers both headers, so R2 rejects any other content. R2 answers
`200` on success. The files may be uploaded in any order, also in parallel.

Errors: `400 invalid_request` (validation, name or version mismatch with `manifest`, `append`
for an ecosystem other than generic), `403 forbidden` (no `publish` grant covering the name and
version), `409 version_exists`, `409 version_closed`, `409 file_exists`,
`413 payload_too_large`.

A pending `init` reserves neither the version nor the file names: two uploads of the same
version may coexist, and `commit` checks the rules again (6.5). Uncommitted uploads are deleted
by the hourly cron after 24 hours. `--dry-run` stops after this call.

#### 6.4.1 Appending files to an existing version

A CI matrix that builds one file per job publishes them as one version by sending
`append: true` from every job:

- Only generic supports it. `append: true` for any other ecosystem is `400 invalid_request`,
  whether or not the version exists. `append: false` (or no `append`) is accepted everywhere.
- On a version that does not exist, `append: true` behaves exactly like a normal publish.
- On an existing version it is allowed when `published` is less than `APPEND_WINDOW_HOURS`
  (default 24) hours ago and the version is not yanked, otherwise `409 version_closed`; and
  when every file name is new in the version, otherwise `409 file_exists`.
- The grant check is the same as for a new version. `manifest` is validated but ignored: the
  version keeps the `meta` of its first publish. `published` and `publishedBy` do not change.
- Without `append`, an existing version is `409 version_exists`, as for every ecosystem.

A file, once committed, is immutable; appending only adds entries to the version's `files`.

### 6.5 `POST /api/v1/publish/commit`

Role `publish`, and the credential must be the one that called `init`.

Request:

```json
{ "uploadId": "01JBX9T6Q4ZK3M8N2P5R7S9V0W" }
```

The Worker runs `head()` on every staged file and compares it with the declaration, checks
immutability again (for an upload with `append: true`, the rules of 6.4.1), copies the files
to their final keys (computing the adapter's extra digests on the way, see below), writes the
version manifest (an append adds its entries to `files` with a
conditional write, retried on conflict), rebuilds the package index (and npm dist-tags), and
deletes the staged files.

Extra digests: an adapter may declare a static list of algorithms (`digests`, any of `sha1`,
`md5`, `sha512`) for ecosystems whose clients verify more than SHA-256. `init` records the
list in the staging declaration, and `commit` computes those digests while streaming each
staged object to its final key (a `DigestStream`) and stores them as `files[].digests`
(lower-case hex) in the manifest. Listings (6.6–6.8) and the generic feed return `digests`
when present; `reindex` (6.11) never recomputes them. `sha256` stays mandatory and separate:
it is declared by the client, enforced by the presigned `PUT` and checked at `commit`. Only
the maven adapter declares extra digests (`sha1`, `md5` and `sha512`, see 6.4).

The rules are checked against the state at commit time. Without `append`, the first commit of
a version wins and later ones get `409 version_exists`. With `append`, a commit that finds the
version already published (for example by a parallel job of the same CI matrix) is applied as
an append when 6.4.1 allows it, and fails with `409 version_closed` or `409 file_exists`
otherwise.

Response `201`:

```json
{
  "eco": "npm",
  "name": "@acme/sdk",
  "version": "2.3.1",
  "url": "https://packages.example.com/npm/@acme/sdk/-/sdk-2.3.1.tgz",
  "files": [
    {
      "name": "sdk-2.3.1.tgz",
      "url": "https://packages.example.com/npm/@acme/sdk/-/sdk-2.3.1.tgz"
    }
  ]
}
```

For generic:

```json
{
  "eco": "generic",
  "name": "acme/plugin-foo",
  "version": "1.4.0",
  "url": "https://packages.example.com/generic/acme%2Fplugin-foo/1.4.0",
  "files": [
    {
      "name": "plugin_foo-x86_64-pc-windows-msvc.dll",
      "url": "https://packages.example.com/generic/acme%2Fplugin-foo/1.4.0/plugin_foo-x86_64-pc-windows-msvc.dll"
    }
  ]
}
```

`name` is the stored name (lower case for nuget and swift; the URLs keep the casing as
published) and `version` the stored version (normalised for nuget). `url` is the archive's download URL in
the ecosystem's native protocol, or the version's URL in the generic feed:

| Eco        | `url`                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `composer` | `<PUBLIC_URL>/composer/dist/<vendor>/<package>/<version>.zip`                                                                  |
| `npm`      | `<PUBLIC_URL>/npm/<name>/-/<unscoped>-<version>.tgz`, whatever the uploaded file was called (12.1)                             |
| `cargo`    | `<PUBLIC_URL>/cargo/dl/<crate>/<version>`                                                                                      |
| `generic`  | `<PUBLIC_URL>/generic/<name>/<version>`                                                                                        |
| `nuget`    | `<PUBLIC_URL>/nuget/flat/<id>/<version>/<id>.<version>.nupkg` (lower case)                                                     |
| `swift`    | `<PUBLIC_URL>/swift/<scope>/<name>/<version>.zip`                                                                              |
| `maven`    | `<PUBLIC_URL>/maven/<group/as/path>/<artifactId>/<version>/<file>` of the `archive`, or of the `.pom` when there is no archive |

`files` lists the files added by this upload (for an append, only the appended ones; the status
is `201` either way), each with its download URL. For generic that is
`<PUBLIC_URL>/generic/<name>/<version>/<file>`; generic names are encoded as described in 8.1.
For composer, npm, cargo, nuget, swift and maven the archive's entry has the same `url` as the
response; the nuget `symbols` file has no download endpoint and its `url` is `null`; a swift
`manifest` file's `url` is `<PUBLIC_URL>/swift/<scope>/<name>/<version>/Package.swift`, with
`?swift-version=<X>` for a variant; every maven file has its own path (11.3).

Errors:

- `400 upload_incomplete`: at least one staged file is missing (its `PUT` never completed).
  Nothing is published and the upload stays as it was: the client may finish the missing
  `PUT`s while the URLs are valid and commit again, or start again from `init`.
- `404 not_found`: `uploadId` unknown, expired (cleaned up) or created by another credential.
- `409 upload_mismatch`: the size or SHA-256 of a staged file differs from the declaration.
  Nothing is published; start again from `init`.
- `409 version_exists`: the version was published after this `init` (upload without `append`).
- `409 version_closed`, `409 file_exists`: an append upload whose rules (6.4.1) no longer hold.

Commit is idempotent: after a successful commit the Worker keeps a small record of the result
under the upload's staging prefix until the cron removes it (24 hours), and a repeated
`commit` with the same `uploadId` returns the same `201` body. A client that lost the response
to `commit` can therefore simply retry it.

### 6.6 `GET /api/v1/packages`

Role `read`, `yank`, `delete` or `admin`. Lists packages with their versions. A `yank` or `delete`
credential sees the versions its own grants cover (never `dependencies`, and its `read` grants do
not count); it needs this to find what to yank or delete. For `read`, the top-level entries
are the packages of the credential's explicit grants with the versions those grants cover;
packages with no such version are omitted. Packages reachable only transitively (5.3) are not
top-level entries: instead every `read` entry carries `dependencies`, the packages and
concrete versions that its grant opens transitively, direct and indirect, flattened per source
package and sorted by name (`[]` when the grant has `transitive: false` or opens nothing). A
package that is also granted explicitly still appears in another entry's `dependencies` when
that entry opens it. For `admin`, everything is listed and there is no `dependencies` field.
Yanked versions are included and marked. Ecosystems disabled in `ECOSYSTEMS` are omitted.

Response `200`:

```json
{
  "packages": [
    {
      "eco": "composer",
      "name": "acme/sdk",
      "versions": [
        {
          "version": "1.2.0",
          "published": "2026-10-28T10:12:00Z",
          "yanked": false,
          "files": [
            { "name": "sdk-1.2.0.zip", "size": 183204, "sha256": "3b1f…", "role": "archive" }
          ]
        }
      ]
    },
    {
      "eco": "generic",
      "name": "acme/plugin-foo",
      "versions": [
        {
          "version": "1.4.0",
          "published": "2026-10-28T11:02:00Z",
          "yanked": false,
          "files": [
            {
              "name": "plugin_foo-x86_64-pc-windows-msvc.dll",
              "size": 1048576,
              "sha256": "2c26…",
              "labels": { "platform": "x86_64-pc-windows-msvc", "kind": "library" }
            }
          ]
        }
      ]
    }
  ]
}
```

Packages are sorted by `eco` and then `name` (byte order); versions by precedence, highest
first. The example above is an `admin` response; a `read` entry looks like this:

```json
{
  "eco": "npm",
  "name": "@acme/sdk",
  "versions": [
    {
      "version": "2.3.1",
      "published": "2026-10-28T10:12:00Z",
      "yanked": false,
      "files": [{ "name": "sdk-2.3.1.tgz", "size": 48213, "sha256": "9f2c…", "role": "archive" }]
    }
  ],
  "dependencies": [
    { "name": "@acme/http", "constraints": ["^1.1"], "versions": ["1.4.0", "1.1.0"] },
    { "name": "@acme/log", "constraints": ["~0.3.0", "^0.3.2"], "versions": ["0.3.5", "0.3.2"] }
  ]
}
```

For nuget and swift, `name` is the name with the casing of the manifest of the highest version
the caller may see (the order of the list follows the lower-case name). `dependencies[].name`
is the stored (lower-case) name.

### 6.7 `GET /api/v1/packages/<eco>/<name>`

Role `read`, `yank`, `delete` or `admin`. Response `200`: one `Package` object (same filtering and
`dependencies` as 6.6), e.g.
`GET /api/v1/packages/npm/%40acme%2Fsdk`:

```json
{
  "eco": "npm",
  "name": "@acme/sdk",
  "versions": [
    {
      "version": "2.3.1",
      "published": "2026-10-28T10:12:00Z",
      "yanked": false,
      "files": [{ "name": "sdk-2.3.1.tgz", "size": 48213, "sha256": "9f2c…", "role": "archive" }]
    }
  ]
}
```

Errors: `404 not_found` when the package does not exist or, for `read`, when no version of it
is covered by an explicit grant (a package reachable only transitively is listed under the
`dependencies` of its source package instead).

### 6.8 `POST /api/v1/packages/<eco>/<name>/<version>/yank`

Role `yank` (within its `yank` grants, 5.1) or `admin`. No body. A `yank` credential outside its
grants gets `403 forbidden`. Marks the version as yanked: it disappears from the composer and npm
indexes, is listed with `yanked: true` in the cargo index, is left out of the generic feed
unless `?include=yanked` (section 8) and gets `listed: false` in the NuGet registration while
the flat container keeps it (section 9). For swift it carries a `problem` in the release list
and its metadata answers `410` (section 10); for maven it disappears from
`maven-metadata.xml` (section 11). Its files stay downloadable, so consumers' lockfiles keep
working. An npm dist-tag pointing at it moves to the highest remaining stable version.
Yanking an already yanked version succeeds. A yanked generic version is closed for appending.

Response `200`: the `PackageVersion` plus `eco` and `name`:

```json
{
  "eco": "npm",
  "name": "@acme/sdk",
  "version": "2.3.1",
  "published": "2026-10-28T10:12:00Z",
  "yanked": true,
  "files": [{ "name": "sdk-2.3.1.tgz", "size": 48213, "sha256": "9f2c…", "role": "archive" }]
}
```

Errors: `404 not_found` (package or version).

### 6.9 `DELETE /api/v1/packages/<eco>/<name>/<version>`

Role `delete` (within its `delete` grants, 5.1) or `admin`; `403 forbidden` outside the grants.
No body. Deletes the manifest and all files of the version and rebuilds the
index; consumers' lockfiles that point at it stop working, and the version can be published
again. Dist-tags move as for yank.

Response `200`:

```json
{ "eco": "npm", "name": "@acme/sdk", "version": "2.3.1", "deleted": true }
```

Errors: `404 not_found`.

### 6.10 `DELETE /api/v1/packages/<eco>/<name>`

Role `delete` (with a `delete` grant for the package that covers all versions, `versions: *`,
5.1) or `admin`; `403 forbidden` otherwise. No body. Deletes every version, the package's indexes and its entry in
`_meta/packages.json`. Confirmation (typing the name) is the client's responsibility.

Response `200`:

```json
{ "eco": "composer", "name": "acme/sdk", "deletedVersions": ["1.2.0", "1.1.0"] }
```

Errors: `404 not_found`.

### 6.11 `POST /api/v1/packages/<eco>/<name>/reindex`

Role `admin`. No body. Rebuilds the package's index files from the listing of its manifests.
It does not touch the manifests themselves (for example, it never recomputes `digests`).

Response `200`:

```json
{ "eco": "composer", "name": "acme/sdk", "manifests": 2 }
```

`manifests` is the number of version manifests the index was built from. Errors:
`404 not_found` when the package has no manifests.

### 6.12 `GET /api/v1/credentials`

Role `admin`. Lists credentials stored in KV (provider-backed projects are not listed),
sorted by `project`.

Response `200`:

```json
{
  "credentials": [
    {
      "project": "shop-frontend",
      "roles": ["read"],
      "kind": "read",
      "auth": [
        {
          "id": "3f9a1c0b7d2e",
          "type": "key",
          "scope": ["read"],
          "created": "2026-10-28T09:00:00Z",
          "expires": null
        },
        {
          "id": "a41d07e9c2b5",
          "type": "key",
          "scope": ["read"],
          "created": "2026-06-01T08:30:00Z",
          "expires": "2026-11-11T00:00:00Z"
        },
        {
          "id": "c08e5b1f9a27",
          "type": "gh",
          "scope": ["read"],
          "repository": "acme/shop-frontend",
          "repository_id": "123456789",
          "repository_owner_id": null,
          "ref": "refs/heads/main",
          "workflow": null,
          "environment": null,
          "pin_on_first_use": true,
          "created": "2026-10-28T09:05:00Z",
          "expires": null
        }
      ],
      "grants": [
        { "eco": "composer", "package": "acme/*", "versions": "*", "transitive": true },
        { "eco": "npm", "package": "@acme/sdk", "versions": "^2.0", "transitive": false },
        { "eco": "cargo", "package": "acme-core", "versions": ">=1.4, <2", "transitive": true }
      ],
      "read_grants": [
        { "eco": "composer", "package": "acme/*", "versions": "*", "transitive": true },
        { "eco": "npm", "package": "@acme/sdk", "versions": "^2.0", "transitive": false },
        { "eco": "cargo", "package": "acme-core", "versions": ">=1.4, <2", "transitive": true }
      ],
      "publish_grants": [],
      "yank_grants": [],
      "delete_grants": []
    }
  ]
}
```

`kind` and `grants` are the legacy view (2.4, section 5): `roles`, `read_grants`,
`publish_grants`, `yank_grants`, `delete_grants` and each entry's `scope` are authoritative.

### 6.13 `POST /api/v1/credentials`

Role `admin`. Creates a credential and, by default, its first `key` secret.

Request:

| Field            | Type     | Required | Description                                                                                                                                                                                                                                       |
| ---------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project`        | string   | yes      | slug `[a-z0-9][a-z0-9-]{1,62}`                                                                                                                                                                                                                    |
| `roles`          | string[] | yes\*    | a non-empty list of `read`, `publish`, `yank`, `delete` and `admin`                                                                                                                                                                               |
| `kind`           | string   | yes\*    | legacy form of `roles` with one role: `read`, `publish`, `yank`, `delete` or `admin`; not together with `roles`                                                                                                                                   |
| `read_grants`    | Grant[]  | no       | default `[]`; must be empty or absent without the `read` role                                                                                                                                                                                     |
| `yank_grants`    | Grant[]  | no       | default `[]`; must be empty or absent without the `yank` role                                                                                                                                                                                     |
| `delete_grants`  | Grant[]  | no       | default `[]`; must be empty or absent without the `delete` role                                                                                                                                                                                   |
| `publish_grants` | Grant[]  | no       | default `[]`; must be empty or absent without the `publish` role                                                                                                                                                                                  |
| `grants`         | Grant[]  | no       | legacy form: the grants of a credential with one role; `400` for two roles, and not together with any of the `<role>_grants`; empty or absent for `admin`                                                                                         |
| `secret`         | object   | no       | the first auth entry, same shape as the body of 6.17 (`scope` required with several roles); default `{ "type": "key" }`; `null` creates the credential **without** a secret (not for a credential that holds `admin`, which needs one to sign in) |

\* One of `roles` and `kind`.

Example:

```json
{
  "project": "acme-sdk",
  "roles": ["read", "publish"],
  "read_grants": [{ "eco": "composer", "package": "acme/*", "versions": "*" }],
  "publish_grants": [{ "eco": "composer", "package": "acme/acme-sdk", "versions": "*" }],
  "secret": { "type": "key", "scope": ["read"] }
}
```

A credential with both roles needs a `scope` in `secret` (the default `{ "type": "key" }` is
`400 invalid_request`), so that no token gets write permission by omission. The legacy
request `{ "project": "shop-frontend", "kind": "read", "grants": [...] }` keeps working.

Response `201`:

```json
{
  "credential": {
    "project": "shop-frontend",
    "roles": ["read"],
    "kind": "read",
    "auth": [
      {
        "id": "3f9a1c0b7d2e",
        "type": "key",
        "scope": ["read"],
        "created": "2026-10-28T09:00:00Z",
        "expires": null
      }
    ],
    "grants": [{ "eco": "composer", "package": "acme/*", "versions": "*", "transitive": true }],
    "read_grants": [
      { "eco": "composer", "package": "acme/*", "versions": "*", "transitive": true }
    ],
    "publish_grants": [],
    "yank_grants": [],
    "delete_grants": []
  },
  "token": "shop-frontend:k7Qx2mN9pLw4vR8sT1bYc3dF6hJ0aZ5e"
}
```

`token` (including `TOKEN_PREFIX` when set) is present only when the first secret is of type
`key`, and is never returned again; for a `login` first secret the response has `login` instead (6.17); with `"secret": null` it has neither. Errors: `400 invalid_request`,
`409 credential_exists`.

### 6.14 `GET /api/v1/credentials/<project>`

Role `admin`. Response `200`: one `Credential`. Errors: `404 not_found`.

### 6.15 `PATCH /api/v1/credentials/<project>`

Role `admin`. Replaces the grants of the roles named and/or changes the roles.

Request (at least one of the fields):

```json
{
  "read_grants": [{ "eco": "npm", "package": "@acme/*", "versions": "*" }],
  "roles": ["read", "publish"],
  "publish_grants": [{ "eco": "npm", "package": "@acme/sdk", "versions": "*" }]
}
```

`read_grants`, `publish_grants`, `yank_grants` and `delete_grants` each replace that role's whole list (`[]` removes all
access); a list for a role the credential does not hold (after `roles` is applied) must be
empty. The legacy `grants` replaces the list of a credential with one role, and is
`400 invalid_request` for two roles or together with any of the `<role>_grants`.
`roles` may add or remove any role, `admin` included, so an `admin` credential can be given
`read` or `publish` and a `read` credential can become an administrator; the last credential
that holds `admin` cannot lose it (`403 forbidden`). A removed role loses its grants. Existing
secrets keep exactly the roles they had (adding a role never widens them, an `admin`'s login
stays `admin`-only until its scope is edited); removing a role is `400 invalid_request` while
an active secret would be left with no role, so expire that secret first (6.18). Any other known field
(`project`, `kind`, `auth`) is `400 invalid_request`: identity cannot change, secrets are
managed with 6.17 and 6.18. Non-empty grants on a credential whose only role is `admin`, and
a list for a role the credential does not hold, are `400 invalid_request`.

Response `200`: the updated `Credential`. Errors: `400 invalid_request`, `404 not_found`.

### 6.16 `DELETE /api/v1/credentials/<project>`

Role `admin`. No body. Deletes the credential; its tokens stop working (KV propagation and the
in-isolate credential cache can each take up to about 60 seconds, 2.4).

Response `200`:

```json
{ "project": "shop-frontend", "deleted": true }
```

Errors: `404 not_found`; `403 forbidden` when it is the last `admin` credential (deleting it
would lock everyone out of the panel).

### 6.17 `POST /api/v1/credentials/<project>/secrets`

Role `admin`. Adds an auth entry.

Request:

| Field                 | Type           | Required           | Description                                                                                                                                            |
| --------------------- | -------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`                | string         | yes                | `key`, `gh` or `login`                                                                                                                                 |
| `scope`               | string[]       | several roles: yes | the roles the secret may use: a non-empty list of the credential's roles (`admin` too, when it holds it); with one role the default is that role       |
| `password`            | string         | no (`login` only)  | the password; generated (24 base62 characters) when absent. A `key` never takes one: `400 invalid_request`                                             |
| `description`         | string \| null | no                 | a note, at most 200 characters, no control characters; trimmed, blank or `null` = none; editable later (6.22)                                          |
| `replaces`            | string         | no (`gh` only)     | the `id` (or a prefix, 6.1) of a `gh` secret to replace: it expires now in the same write and an identical active entry is not a duplicate (see below) |
| `totp`                | boolean        | no (`login` only)  | default `false`: also require a one-time code; the shared secret is generated and returned once                                                        |
| `expires`             | string \| null | no                 | RFC 3339 or `YYYY-MM-DD`; default `null` (never)                                                                                                       |
| `repository`          | string         | `gh`: yes          | `owner/repo` or `owner/*` (2.5)                                                                                                                        |
| `repository_id`       | string \| null | no (`gh` only)     | digits only; `null` = any                                                                                                                              |
| `repository_owner_id` | string \| null | no (`gh` only)     | digits only; `null` = any                                                                                                                              |
| `ref`                 | string \| null | no (`gh` only)     | glob over the full ref, e.g. `refs/heads/main` or `refs/tags/v*`; `null` = any                                                                         |
| `workflow`            | string \| null | no (`gh` only)     | workflow file path, e.g. `.github/workflows/release.yml`, matched against the `workflow_ref` claim (2.5); `null` = any                                 |
| `environment`         | string \| null | no (`gh` only)     | GitHub Actions environment name; `null` = any                                                                                                          |
| `pin_on_first_use`    | boolean        | no (`gh` only)     | default `true`: the first matching token fills in a missing `repository_id` / `repository_owner_id` (2.5)                                              |

Passwords: only a `login` entry has one, on any kind of credential (one scoped to `admin` or
`read` signs in to the panel with it): 12 to 128 characters of any script, printable, without `:` and without
whitespace. A `password` on a `key` or `gh` entry, or a password outside these rules, is
`400 invalid_request`. Passwords are stored as `pbkdf2-sha256$<iterations>$<salt
base64>$<hash base64>` (2.6); the `id` of a `login` entry is opaque and stable, and a password
is never returned except once, in `login`. Generated `key` secrets are stored as
`sha256:<hex>`. **Older Workers** let an `admin` credential store a chosen password as a
`key`; such entries still verify (as a token, and with the login and password of the panel
when the credential has no `login` entry) but cannot be created any more.

Any of the `gh` fields (`pin_on_first_use` included) on a `key` entry is
`400 invalid_request`, as is a `gh` entry identical (all six claim fields and the scope equal) to
an existing active one; the same claims may appear twice with different scopes. A missing
`scope` on a credential with several roles, an empty or repeated one, and a role the credential
does not hold are `400 invalid_request`. A secret with `admin` in its scope administers the
registry, so clients should confirm it. **Editing a `gh`
entry** is adding a changed copy with `replaces`: the response is the new entry as usual, the
replaced one gets `expires` = now (an earlier expiry is kept, an entry is never extended), both
in one write, and the duplicate check ignores the replaced entry, so even an unchanged copy is
accepted; the copy takes its own `scope`. `replaces` that does not name exactly one existing
`gh` entry is `404 not_found` / `400 invalid_request` (6.1), and it is refused on any other
type. For secrets whose scope includes `publish`, set at least `ref` (e.g. `refs/tags/v*`) or
`workflow`, so that only the release workflow can publish. The `repository_id` of a public
repository can be looked up with 6.19.

Response `201` for `key`:

```json
{
  "secret": {
    "id": "7c21de4490ab",
    "type": "key",
    "scope": ["read"],
    "created": "2026-10-28T09:10:00Z",
    "expires": null
  },
  "token": "shop-frontend:Q2w9Er7Ty5Ui3Op1As8Df6Gh4Jk2Lz0X"
}
```

For `gh` the response has `secret` only, echoing every field (`null` when not set):

```json
{
  "secret": {
    "id": "c08e5b1f9a27",
    "type": "gh",
    "scope": ["publish"],
    "repository": "acme/sdk",
    "repository_id": "123456789",
    "repository_owner_id": null,
    "ref": "refs/tags/v*",
    "workflow": ".github/workflows/release.yml",
    "environment": null,
    "pin_on_first_use": true,
    "created": "2026-10-28T09:05:00Z",
    "expires": null
  }
}
```

For `login` the response has `secret` (`type` `login`, `totp`, `created`, `expires`; never the
password) and, shown once and never returned again, `login`:

```json
{
  "secret": {
    "id": "5d3b8e21c7f0",
    "type": "login",
    "totp": true,
    "created": "2026-10-28T09:10:00Z",
    "expires": null
  },
  "login": {
    "password": "Hq3vN8xZk1Lp6RtY0wUe5mCa",
    "totp": {
      "secret": "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
      "otpauth_uri": "otpauth://totp/registry.example.com:shop-frontend?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=registry.example.com&algorithm=SHA1&digits=6&period=30"
    }
  }
}
```

`login.totp` is absent without `totp`. 6.13 accepts the same `secret` and returns `login`
instead of `token`. `description` is returned in every view of a secret (`null` when none). The CI job builds its token as `<project>:gh.<jwt>` or `_:gh.<jwt>` (2.5). Errors:
`400 invalid_request`, `404 not_found`.

To rotate a secret, a client (the panel) calls this endpoint and then 6.18 with an `expires`
in the future for every previously active `key` entry.

### 6.18 `DELETE /api/v1/credentials/<project>/secrets/<hash-prefix>`

Role `admin`. Expires an auth entry (it is not removed immediately; the hourly cron removes
entries whose `expires` has passed).

Optional request body:

```json
{ "expires": "2026-11-11T00:00:00Z" }
```

Default `expires` is now; a value in the past is treated as now. Response `200`:

```json
{
  "secret": {
    "id": "a41d07e9c2b5",
    "type": "key",
    "created": "2026-06-01T08:30:00Z",
    "expires": "2026-11-11T00:00:00Z"
  }
}
```

Errors: `400 invalid_request` (ambiguous prefix), `404 not_found`.

### 6.20 `POST /api/v1/auth/sessions`

No credential. Starts a browser login (2.6). Request, a pull:

```json
{ "purpose": "pull", "eco": "npm" }
```

`eco` is optional and only labels the page (`generic` hides the extended-validity choice). A
publish names every version to approve:

```json
{
  "purpose": "publish",
  "scopes": [{ "eco": "composer", "package": "acme/sdk", "version": "1.4.0" }]
}
```

A yank or delete names what to approve the same way, with the purpose in `purpose`:

```json
{
  "purpose": "yank",
  "scopes": [{ "eco": "npm", "package": "@acme/sdk", "version": "2.3.1" }]
}
```

Every scope of a `yank` needs a `version`. A scope of a `delete` may leave `version` out (or
send `null`) to mean the whole package with every version; a version and the whole package of
the same package may both be listed. `eco` is not allowed for them. The session is approved
by a credential with the `admin` role (2.6), and the poll (6.21) then returns a token with
`"kind": "admin"` that lasts 15 minutes.

`scopes` has 1 to `MAX_PUBLISH_SCOPES` entries (default 20, at most 100), and the resulting `url`
may be at most 8000 characters (the signed session, scopes included, is in it); `eco` must be enabled, `version` valid for it, and `package` and
`version` are returned in their stored form (NuGet and Swift names lower-cased, NuGet versions
normalised); duplicates are dropped. Response `201`:

```json
{
  "session": "<signed session id>",
  "url": "https://registry.example.com/authorize/<signed session id>",
  "poll_token": "<43 base64url characters>",
  "interval": 2,
  "expires_at": "2026-10-28T09:10:00.000Z"
}
```

Nothing is stored. The session lives 10 minutes. Errors: `400 invalid_request`,
`500 internal_error` (no `SESSION_SECRET`).

### 6.21 `POST /api/v1/auth/sessions/poll`

No credential. Request `{ "session": "...", "poll_token": "..." }`; the poll token must be the
one returned with the session (`401 unauthorized` otherwise). Responses:

- `202` `{ "status": "pending" }`: not decided yet (poll again after `interval` seconds). It is
  also what a client sees if it polls again after it received the token.
- `200` once approved, and only once:

  ```json
  {
    "status": "approved",
    "token": "shop-frontend:st.<payload>.<signature>",
    "expires_at": "2026-10-28T10:00:00.000Z",
    "project": "shop-frontend",
    "kind": "read"
  }
  ```

  `kind` is `read` for a pull, `publish` for a publish and `admin` for a yank or delete.
  `token` includes `TOKEN_PREFIX` when it is set.

- `403 forbidden`: the person refused. `404 not_found`: the session has expired.

### 6.22 `PATCH /api/v1/credentials/<project>/secrets/<hash-prefix>`

Role `admin`. Sets or clears the description of one auth entry and/or replaces its `scope`, and
changes nothing else (`expires` and the `id` do not change):

```json
{ "description": "Jane's laptop", "scope": ["read", "publish"] }
```

At least one of the two is required. `description` is a string (trimmed, at most 200
characters, no control characters) or `null`; blank or `null` clears it. `scope` is a
non-empty list of unique roles within the credential's roles (6.17): it replaces the whole
list and takes effect on the next request with that secret, and for a panel session started with
a `login` it takes effect at once. It is `400 invalid_request` for an empty or unknown list or
a role the credential does not hold, and for a `gh` entry whose claims and new scope are
identical to another active `gh` entry. Giving a secret the `publish` or `admin` role lets
whoever holds it publish or administer, so clients should confirm it. Any other field is `400 invalid_request`. Response `200`:
`{ "secret": <AuthEntry> }`. Errors: `400 invalid_request`, `404 not_found`.

### 6.19 `GET /api/v1/github/repository?name=<owner/repo>`

Role `admin`. Looks up a GitHub repository so that the panel can fill in `repository_id` and
`repository_owner_id` of a `gh` entry without contacting GitHub from the browser (the panel's
Content Security Policy only allows its own origin). The Worker calls
`https://api.github.com/repos/<owner>/<repo>` without credentials, so only public repositories
are found.

Response `200`:

```json
{ "fullName": "acme/sdk", "id": "123456789", "ownerId": "98765" }
```

`fullName` has GitHub's casing; `id` and `ownerId` are strings of digits. Errors:
`400 invalid_request` (missing `name` or not `owner/repo`), `404 not_found` (the repository is
private or does not exist), `503 provider_unavailable` (any other failure of the GitHub API, e.g. a rate limit or an outage).

### 6.23 `POST /api/v1/bucket/accept`

Role `admin`. Confirms the R2 bucket the Worker is bound to as the installation's own.

The installation has an id, kept in KV (`installation_id`) and in the bucket
(`_meta/installation.json`). A new installation gets one on its first request; an installation
from before ids adopts the bucket it finds, unless KV says it was set up before
(`schema_version`) while the bucket never was. When KV and the bucket disagree, which happens
when a deploy repoints the `R2_BUCKET` binding at another or a new bucket, every request to
the native protocols and to `/api/v1/packages…` and `/api/v1/publish/…` answers
`503 bucket_mismatch`, no migration runs and the hourly cleanup is skipped, so nothing is
written to the wrong bucket. The panel, the credential endpoints and the login endpoints keep
working; the panel shows a banner with a button that makes the same call.

```json
{ "error": "bucket_mismatch", "message": "The R2 bucket is not the one …", "reason": "empty" }
```

`reason` is `empty` (the bucket carries no id of this installation, or was never set up) or
`other` (it carries another installation's id). The usual fix is to point the binding back at
the right bucket. This endpoint is for the other case, a bucket that really is the new one: it
stores a new id in the bucket and in KV and, when the bucket has no `_meta/packages.json`,
builds it from the manifests (an empty bucket gets an empty list). It sends no body and
answers `200 { "accepted": true }`. Errors: `401 unauthorized`, `403 forbidden`.

## 7. Client behaviour

### 7.1 Configuration

The CLI reads the base URL from `--registry` or `REGISTRY_URL` and the token from `--token`
or `REGISTRY_TOKEN`. With `--oidc`, it requests a GitHub Actions OIDC token with audience
`PUBLIC_URL` and builds `<project>:gh.<jwt>` when a project is given, or `_:gh.<jwt>` when it
is not, letting the Worker resolve the project from the `repository` claim (2.5). `sreg auth`
takes the project as `--project <p>` (see the spec); the publish commands take it as
`--oidc-project <p>`, because `sreg nuget publish` already uses `--project` for the `.csproj`,
and the same name is used on every publish command for consistency. It sends `Authorization: Bearer <token>`,
`X-Client-Version` and `Accept: application/json` on every API request, and
`Authorization: Bearer <token>` on every request to the Worker's generic feed.

### 7.2 Publish commands and packaging

`sreg` never calls the native tools' `publish`; it runs their packing commands, reads the
result and uploads it itself. Flags that `sreg` sets are reserved; everything after `--` is
passed verbatim to the packing tool (`sreg cargo publish --version 1.2.0 -- --features ssl --locked`).

| Command                                                                                                               | Packing command                                                                                      | Flags set by `sreg`                                                                 | Passed after `--` (examples)                    |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| `sreg composer publish [--version <v> \| --tag-prefix <p>] [--path <dir>]`                                            | `git archive --format=zip HEAD:<path>` (fallback: a zip of the directory without `vendor/`, `.git/`) | –                                                                                   | –                                               |
| `sreg npm publish [--version <v> \| --tag-prefix <p>] [--tag <t>] [--workspace <w>] [-- …]`                           | `npm pack`                                                                                           | `--json`, `--pack-destination <tmp>`, `-w <pkg>` from `--workspace`                 | `--ignore-scripts`                              |
| `sreg cargo publish [--version <v> \| --tag-prefix <p>] [--package <crate>] [-- …]`                                   | `cargo package`                                                                                      | `--no-verify`, `--allow-dirty`, `-p <crate>` from `--package`, `--target-dir <tmp>` | `--features`, `--locked`, `--manifest-path`     |
| `sreg nuget publish [--version <v> \| --tag-prefix <p>] [--project <csproj>] [--no-symbols] [-- …]`                   | `dotnet pack <project>`                                                                              | `-o <tmp>`, `-p:PackageVersion=<v>` from `--version`                                | `-c Release`, `--no-build`, `--include-symbols` |
| `sreg swift publish [--version <v> \| --tag-prefix <p>] [--path <dir>]`                                               | `swift package archive-source -o <tmp>` and `swift package dump-package`                             | `-o <tmp>`                                                                          | –                                               |
| `sreg maven publish [--version <v> \| --tag-prefix <p>] --from-dir <dir> [--coords <group:artifact>]`                 | none – the artifacts come from a local file repository                                               | –                                                                                   | –                                               |
| `sreg generic publish <name> <version> <file>... [--label k=v]... [--meta k=v]... \| --spec files.json [--no-append]` | none – the files are ready                                                                           | –                                                                                   | –                                               |

What each command sends to `init` (6.4):

- composer, npm, cargo: one file with `role: "archive"` and the ecosystem-native `manifest`.
  With `--version`, npm first runs `npm pkg set version=<v>` (with `-w` for a workspace) and
  cargo rewrites `package.version` in the crate's `Cargo.toml`, so that the version inside the
  archive matches the registry; the CLI prints that the file was modified.
- nuget: unpacks the `.nupkg` (a zip), reads the `.nuspec` into `manifest` and sends the
  `.nupkg` as `archive`, plus the `.snupkg` as `symbols` when `dotnet pack` produced one,
  unless `--no-symbols` is given.
- swift: runs `swift package archive-source -o <tmp>` and `swift package dump-package`, and
  sends the source archive as `archive` and `Package.swift` plus every `Package@swift-*.swift`
  as `manifest` files; `manifest` carries the tools version, the dump and, when known, the
  repository and README URLs.
- maven: reads a local file repository produced by
  `mvn deploy -DaltDeploymentRepository=local::file:./out` or by a Gradle `publish` to a
  `file://` URL. It parses the `.pom` for the coordinates, `<packaging>` and
  `<dependencies>`; the POM must be the effective POM, so a POM with `<parent>` or unresolved
  `${…}` properties is refused with a hint to generate the effective POM. It sends every file
  of the version directory except checksum files and `maven-metadata*.xml`.
- generic: the given files with their `labels` and the `meta` as `manifest`. It sends
  `append: true` by default, so that every job of a CI matrix can add its files to the same
  version (6.4.1); `--no-append` sends `append: false` to require a fresh version.

Monorepos – every publish command points at one package within the repository and works from
any working directory:

- composer: `--path packages/foo` → `git archive HEAD:packages/foo`; the subdirectory becomes
  the root of the archive, `export-ignore` in `.gitattributes` is honoured in subdirectories
  too, and `composer.json` is read from that path.
- npm: `--workspace <name|path>` → `npm pack -w <…>`.
- cargo: `--package <crate>` → `cargo package -p <crate>`. With `version.workspace = true` in
  the crate, `--version` is refused; the version must be set in the workspace.
- nuget: `--project <path to .csproj>`; a `.sln` is refused because it produces several
  packages.
- swift: `--path <dir>`, the package directory.
- maven: `--from-dir <dir>` points at the local file repository; `--coords <group:artifact>`
  picks one artifact when it contains several, and `--version` (or the tag) selects the
  version directory. `sreg maven publish` never edits `pom.xml`.
- Version: `--version <v>`, or a git tag on `HEAD`. With `--tag-prefix <p>` (e.g. `foo/v`,
  `foo-v`) the CLI takes the tag on `HEAD` with that prefix; without `--tag-prefix` and
  `--version` it accepts only a `v<semver>` tag and refuses when `HEAD` has more than one.
- One call publishes one package in one version; several packages are several calls (a loop
  or a matrix).

Common flags of every publish command:

- `--dry-run`: stop after `init` (7.3).
- `--skip-existing`: treat `409 version_exists` and `409 file_exists` from `init` or `commit`
  as success: exit code `0` and a message instead of an error; with `--json` the output is
  `{ "skipped": true, "eco": "…", "name": "…", "version": "…" }`. This makes re-running a
  workflow idempotent.
- `--oidc` and `--oidc-project <p>` (7.1), `--json`.

### 7.3 Publishing sequence

Every publish follows these steps:

1. Compute `size` and `sha256` of every file and build `manifest`.
2. `POST /api/v1/publish/init`. Stop here with `--dry-run`.
3. For every entry in `uploads`, `PUT <putUrl>` with exactly its `headers`:
   - up to 3 attempts per file in total, waiting 1 s and then 2 s (exponential backoff, ±20%
     jitter) between attempts;
   - retry on network errors, timeouts and `5xx` from R2;
   - if `expires` has passed (or is less than 30 seconds away) before an attempt, or R2
     answers `403` because the request expired, call `init` again with the same declaration
     and upload all files again with the new `uploadId` and `uploads` (files uploaded under the
     previous `uploadId` are not reused); `init` is called at most twice per publish;
   - any other `4xx` from R2 (e.g. a checksum mismatch because the file changed) is fatal.
4. `POST /api/v1/publish/commit`. On a network error or `5xx`, retry the commit (it is
   idempotent) with the same backoff. On `409 upload_mismatch` or `400 upload_incomplete`,
   start again from `init` once.
5. Print the result (`--json` prints the `201` body).

### 7.4 Downloading generic files

`sreg generic get <name> [<version>|<range>|latest] [--label k=v]... [--sole] [--out <dir>] [--prerelease]`:

1. `GET /generic/<name>/<version>` for an exact version, or `GET /generic/<name>/latest` (the
   default, with `?channel=prerelease` for `--prerelease`), with one `?label=k:v` per
   `--label` (8.4, 8.5). Any other second argument is a version constraint in npm syntax
   (`^1.2`, `~1.4`, `>=1 <2`): it is sent as `GET /generic/<name>/latest?version=<range>`, so
   the highest version satisfying it is downloaded. With `--json`, print this response and
   stop.
2. With `--sole`, exactly one file must remain after the label filter: none, or several, is
   an error that lists the candidates and downloads nothing (the same check that 8.7 makes on
   the server with `409 ambiguous`).
3. For every entry in `files`, `GET` its `url` with the `Authorization` header and without
   following redirects automatically. The answer is `302`; follow it manually with a `GET` of
   the `Location` URL that carries **no** `Authorization` header (and no other credential): the
   presigned URL authorises itself, the token must not reach the storage host, and R2 rejects
   a request that combines both. If the presigned `GET` answers `403` because it expired,
   request the `302` endpoint again (once per file).
4. Verify the size and SHA-256 of every downloaded file against the feed entry; on a mismatch,
   delete the file and fail.
5. Write the files into `--out` (default: the current directory) under their `name` and print
   the paths.

### 7.5 Other retries

`GET` requests, including the generic feed, may be retried on network errors, `5xx` and `429`
(honouring `Retry-After`). Clients do not retry non-idempotent admin calls
(`POST /api/v1/credentials`, `POST …/secrets`) automatically.

### 7.6 Exit codes

| Code | When                                                                                                                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | success, or an already published version with `--skip-existing`                                                                                                                                |
| 1    | any error not listed below                                                                                                                                                                     |
| 2    | already published, without `--skip-existing`: `409 version_exists` or `409 file_exists` from `init` or `commit` (the pipeline can treat it as a no-op; a re-run matrix job gets `file_exists`) |
| 3    | `426 client_too_old` (the CLI prints the minimum version and a link to the release)                                                                                                            |

## 8. Generic feed (`/generic/…`)

The read protocol of the generic ecosystem: a JSON feed for HTTP clients such as auto-updaters,
and the protocol `sreg generic get` uses. It is not part of `/api/v1`: sections 1.2, 1.4 and 3
do not apply. It exists only while `generic` is enabled in `ECOSYSTEMS`; otherwise every
`/generic/…` path answers `404 not_found`.

### 8.1 Conventions

- **Authentication**: any form of 2.2. A token with the `read` role sees only the versions covered by its
  `read` `generic` grants, `admin` sees everything, a token without `read` (`publish` only) gets `403 forbidden`. A
  missing or invalid credential gets `401 unauthorized` with
  `WWW-Authenticate: Bearer realm="serverless-registry"`. A `read` credential without a grant
  for the package gets `404 not_found`, as in section 4.
- **Methods**: only `GET`; any other method answers `404 not_found`. `/generic` is the same as
  `/generic/`.
- **Endpoints**:

  | Path                                          | Answer                                                     | Section |
  | --------------------------------------------- | ---------------------------------------------------------- | ------- |
  | `/generic/`                                   | the packages the credential can see                        | 8.2     |
  | `/generic/<name>[?version=<range>]`           | every version (or those satisfying the range) and `latest` | 8.3     |
  | `/generic/<name>/latest[?version=<range>]`    | the highest qualifying version                             | 8.4     |
  | `/generic/<name>/<version>`                   | one version                                                | 8.5     |
  | `/generic/<name>/<version>/<file>`            | `302` to the file                                          | 8.6     |
  | `/generic/<name>/<version>/-/download?label=` | `302` to the one file of the version the labels select     | 8.7     |
  | `/generic/<name>/latest/-/download?label=`    | `302` to the one file the labels select in the 8.4 version | 8.7     |

- **Paths**: `<name>` is one path segment; the `/` of a grouped name is sent as `%2F`
  (`acme%2Fplugin-foo`), and the Worker matches on the raw path as in 1.3. A literal `/` would
  be ambiguous (`/generic/acme/latest`). `<version>` is the exact version, `<file>` the exact
  file name, both percent-encoded. The `-/download` suffix of 8.7 cannot collide with a file
  named `-`: its path has one segment more than 8.6.
- **Responses**: JSON in UTF-8 (`Content-Type: application/json; charset=utf-8`), and
  `Cache-Control: private, no-store` on every response, like every native protocol. Errors use
  the body of section 4 (`invalid_request`, `unauthorized`, `forbidden`, `not_found`,
  `ambiguous` (8.7 only), `internal_error`, `provider_unavailable`).
- **ETag**: every `200` JSON response carries a strong `ETag`: a quoted prefix of the hex
  SHA-256 of the body (clients treat it as opaque). A request whose `If-None-Match` contains
  that value (or `*`) gets `304 Not Modified` with the `ETag` and no body. The body depends on
  the credential, so the `ETag` does too. `no-store` keeps shared caches out; an application
  that keeps its own copy of a response revalidates it with `If-None-Match`.
- **URLs**: every `url` field is the URL of the `302` endpoint of 8.6
  (`<PUBLIC_URL>/generic/<name>/<version>/<file>`), never a presigned URL, so a stored response
  stays valid.
- **Query parameters**:
  - `label=<key>:<value>`, repeatable: split at the first `:`; the key must match the label
    key format of 6.4, otherwise `400 invalid_request`. A file matches when it has every
    requested label with exactly the requested value. Labels filter only the files: a version
    without a matching file is still listed, with an empty `files` array.
  - `include=yanked`: also return yanked versions (8.3, 8.5, and 8.7 with an explicit
    version).
  - `channel=prerelease` (8.4 and `latest` in 8.7 only): also consider prerelease versions.
  - `version=<range>` (8.3, 8.4 and `latest` in 8.7): a version constraint in npm
    (node-semver) syntax, e.g. `^1.2`, `~1.4.0`, `>=1.2 <2`, `1.x || >=3`, sent
    percent-encoded. Only versions satisfying it qualify. A prerelease satisfies it only when
    a comparator of the range names the same `major.minor.patch` with a prerelease
    (`>=2.0.0-beta.0` admits `2.0.0-beta.1`, `^2` does not), the npm rule that grant
    constraints follow too. With `channel=prerelease`, a prerelease also qualifies when its release version satisfies the range (`^2` admits
    `2.0.0-beta.1` because `2.0.0` satisfies it, `^1` does not). A range that does not parse,
    an empty value or the parameter given twice is `400 invalid_request`. Elsewhere it is
    validated the same way but has no effect.
  - Any other value of `include` or `channel` is `400 invalid_request`; unknown parameters
    are ignored.
- **Versions** are compared by semver precedence. `latest` is the highest non-yanked stable
  version covered by the credential's grants, computed on the fly from the manifests, or
  `null` when there is none.
- A file entry is `{ name, size, sha256, digests?, labels, url }`; `digests` only when the
  version has them (6.5); `labels` is always present (`{}` when
  the file has none).

### 8.2 `GET /generic/`

Packages the credential can see (at least one version covered by its grants, yanked
included), sorted by name:

```json
{
  "packages": [
    { "name": "acme/plugin-foo", "latest": "1.4.0" },
    { "name": "acme/plugin-bar", "latest": null }
  ]
}
```

### 8.3 `GET /generic/<name>`

All versions of a package covered by the grants, highest first (clients must not rely on the
order of object keys); yanked versions only with `?include=yanked`. `?label=` filters the files
of every version. `latest` is not affected by `?label=` or `?include=`.

With `?version=<range>`, `versions` holds only the versions satisfying the range (a
prerelease only when the range pins it; `channel` has no effect here), and `latest` is the
highest non-yanked one of them, which is what 8.4 answers for the same range without
`channel`, or `null` when there is none. A range that matches nothing answers `200` with an
empty `versions` object.

```json
{
  "name": "acme/plugin-foo",
  "latest": "1.4.0",
  "versions": {
    "1.4.0": {
      "published": "2026-10-28T11:02:00Z",
      "yanked": false,
      "meta": { "minAppVersion": "3.2" },
      "files": [
        {
          "name": "plugin_foo-x86_64-pc-windows-msvc.dll",
          "size": 1048576,
          "sha256": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
          "labels": { "platform": "x86_64-pc-windows-msvc", "kind": "library" },
          "url": "https://packages.example.com/generic/acme%2Fplugin-foo/1.4.0/plugin_foo-x86_64-pc-windows-msvc.dll"
        }
      ]
    }
  }
}
```

Errors: `404 not_found` when the package does not exist or no version of it is covered by
the grants.

### 8.4 `GET /generic/<name>/latest`

The highest non-yanked stable version covered by the grants; with `?channel=prerelease`,
prerelease versions are considered too. With `?version=<range>`, the highest non-yanked
version covered by the grants that satisfies the range, prereleases as described in 8.1
(`latest?version=%5E1` is the newest `1.x`). `?label=` filters its files as above but does not
take part in choosing the version: a version without a matching file is answered with an
empty `files` array. Response `200` in the single-version shape:

```json
{
  "name": "acme/plugin-foo",
  "version": "1.4.0",
  "published": "2026-10-28T11:02:00Z",
  "yanked": false,
  "meta": { "minAppVersion": "3.2" },
  "files": [
    {
      "name": "plugin_foo-x86_64-pc-windows-msvc.dll",
      "size": 1048576,
      "sha256": "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
      "labels": { "platform": "x86_64-pc-windows-msvc", "kind": "library" },
      "url": "https://packages.example.com/generic/acme%2Fplugin-foo/1.4.0/plugin_foo-x86_64-pc-windows-msvc.dll"
    }
  ]
}
```

Errors: `400 invalid_request` for an invalid `version` range; `404 not_found` when no version
qualifies.

### 8.5 `GET /generic/<name>/<version>`

One version in the shape of 8.4; `?label=` filters its files. Errors: `404 not_found` when the
version does not exist, is not covered by the grants, or is yanked and `?include=yanked` is
not given.

### 8.6 `GET /generic/<name>/<version>/<file>`

`302 Found` with `Location` set to a presigned `GET` URL of the file, valid for 15 minutes, and
no body. Files of yanked versions stay downloadable. Errors: `404 not_found` when the version
is not covered by the grants or the file does not exist. Clients follow the redirect without
the `Authorization` header (7.4).

### 8.7 `GET /generic/<name>/<version|latest>/-/download`

Downloads the one file that the labels select, for clients that know the platform they need
but not the file name, in a single request:

```
GET /generic/acme%2Fplugin-foo/latest/-/download?version=%5E1&label=platform:x86_64-unknown-linux-gnu
```

1. The version: the exact `<version>` (yanked only with `?include=yanked`, like 8.5), or for
   `latest` the version 8.4 answers for the same `?version=` and `?channel=` (never a yanked
   one). The grants are checked for the resolved version as for any download.
2. The files of that version that carry every `?label=` (`label` is repeatable; without it,
   every file of the version is a candidate).
3. Exactly one file: `302 Found` with `Location` set to a presigned `GET` URL of it, valid for
   15 minutes, as in 8.6, plus `X-Resolved-Version: <version>` and
   `X-Resolved-File: <file name>`, so that the client learns what it got (e.g. to verify it
   against the feed or to name the downloaded file).

Errors: `400 invalid_request` for an invalid `label` or `version`; `404 not_found` when the
version does not exist, is not covered by the grants, is yanked (without `?include=yanked`
for an explicit version), no version qualifies for `latest`, or no file carries the labels;
`409 ambiguous` when more than one file does, with the resolved version and the names of the
candidates, sorted, so that the client can add a label:

```json
{
  "error": "ambiguous",
  "message": "3 files of acme/plugin-foo 1.4.0 match; add labels to select one.",
  "version": "1.4.0",
  "files": [
    "plugin_foo-aarch64-apple-darwin.dylib",
    "plugin_foo-x86_64-pc-windows-msvc.dll",
    "plugin_foo-x86_64-unknown-linux-gnu.so"
  ]
}
```

## 9. NuGet feed (`/nuget/…`)

The NuGet V3 protocol, as used by `dotnet` and NuGet clients. It is not part of `/api/v1`:
sections 1.2, 1.4 and 3 do not apply. It exists only while `nuget` is enabled in `ECOSYSTEMS`;
otherwise every `/nuget/…` path answers `404 not_found`.

### 9.1 Conventions

- **Authentication**: any form of 2.2. NuGet clients send Basic credentials from
  `packageSourceCredentials` in `nuget.config` (user name = the token's login, password = the
  token's password); Bearer works too. A token with the `read` role sees only the versions allowed by its
  `read` `nuget` grants, including transitive access (5.3), `admin` sees everything, a token without `read` gets `403 forbidden`. A missing
  or invalid credential gets `401 unauthorized` with both
  `WWW-Authenticate: Basic realm="serverless-registry"` and
  `WWW-Authenticate: Bearer realm="serverless-registry"`, so that `dotnet` prompts for
  credentials. A `read` credential without a grant for the package gets `404 not_found`.
- **Methods**: only `GET`; any other method answers `404 not_found`.
- **Paths**: `<id>` and `<ver>` are lower case, with `<ver>` in the normalised form (5.2); the
  Worker matches `<id>` case-insensitively and normalises `<ver>` before matching.
- **Responses**: JSON in UTF-8, except the `.nuspec` (XML) and the `302` redirect;
  `Cache-Control: private, no-store` on every response. Error bodies follow section 4.
- **Yank**: a yanked version has `listed: false` in the registration and is left out of
  search, but the flat container still lists it and serves its `.nupkg` and `.nuspec`.
- All URLs below are absolute and start with `PUBLIC_URL`.

### 9.2 `GET /nuget/index.json`

The service index:

```json
{
  "version": "3.0.0",
  "resources": [
    {
      "@id": "https://packages.example.com/nuget/flat/",
      "@type": "PackageBaseAddress/3.0.0"
    },
    {
      "@id": "https://packages.example.com/nuget/registration/",
      "@type": "RegistrationsBaseUrl/3.6.0"
    },
    {
      "@id": "https://packages.example.com/nuget/search",
      "@type": "SearchQueryService/3.5.0"
    }
  ]
}
```

### 9.3 `GET /nuget/flat/<id>/index.json`

The versions of the package covered by the grants, yanked ones included, lower case and
normalised, in ascending order:

```json
{ "versions": ["1.0.0", "1.2.0-beta.1", "1.2.0"] }
```

Errors: `404 not_found` when the package does not exist or no version is covered.

### 9.4 `GET /nuget/flat/<id>/<ver>/<id>.<ver>.nupkg`

`302 Found` to a presigned `GET` URL of the `.nupkg`, valid for 15 minutes. .NET drops the
`Authorization` header when it follows a redirect to another host, so the redirect to R2 works.
Errors: `404 not_found`.

### 9.5 `GET /nuget/flat/<id>/<ver>/<id>.nuspec`

The stored `nuspec` string of the version, verbatim, with
`Content-Type: application/xml; charset=utf-8`. Errors: `404 not_found`.

### 9.6 `GET /nuget/registration/<id>/index.json`

The registration index with one page, inlined, holding every version covered by the grants
(yanked ones with `listed: false`) in ascending order. No separate page or leaf documents are
served, so their `@id` values are the URL of this document with a fragment.

```json
{
  "count": 1,
  "items": [
    {
      "@id": "https://packages.example.com/nuget/registration/acme.sdk/index.json#page/1.2.0/1.2.0",
      "count": 1,
      "lower": "1.2.0",
      "upper": "1.2.0",
      "items": [
        {
          "@id": "https://packages.example.com/nuget/registration/acme.sdk/index.json#1.2.0",
          "packageContent": "https://packages.example.com/nuget/flat/acme.sdk/1.2.0/acme.sdk.1.2.0.nupkg",
          "catalogEntry": {
            "@id": "https://packages.example.com/nuget/registration/acme.sdk/index.json#1.2.0",
            "id": "Acme.Sdk",
            "version": "1.2.0",
            "listed": true,
            "published": "2026-10-28T10:12:00Z",
            "packageContent": "https://packages.example.com/nuget/flat/acme.sdk/1.2.0/acme.sdk.1.2.0.nupkg",
            "dependencyGroups": [
              {
                "targetFramework": "net8.0",
                "dependencies": [{ "id": "Newtonsoft.Json", "range": "[13.0.1, )" }]
              }
            ],
            "description": "Acme SDK for .NET",
            "authors": "Acme",
            "tags": ["acme", "sdk"]
          }
        }
      ]
    }
  ]
}
```

`catalogEntry` carries `id` (original casing), `version`, `listed` (not yanked), `published`,
`packageContent`, `dependencyGroups`, and `description`, `authors` and `tags` when the manifest
has them. A dependency group whose `targetFramework` is `null` is served without
`targetFramework`. Errors: `404 not_found`.

### 9.7 `GET /nuget/search?q=&skip=&take=&prerelease=`

A simple search over the packages in `_meta/packages.json`, filtered by the grants (it is what
`dotnet package search` uses).

| Parameter    | Default | Meaning                                                              |
| ------------ | ------- | -------------------------------------------------------------------- |
| `q`          | empty   | case-insensitive substring of the package id; empty matches every id |
| `skip`       | `0`     | number of results to skip                                            |
| `take`       | `20`    | number of results to return                                          |
| `prerelease` | `false` | `true` also considers prerelease versions                            |

A non-numeric `skip` or `take`, or a `prerelease` other than `true` or `false`, is
`400 invalid_request`; unknown parameters (such as `semVerLevel`) are ignored. Only listed (not
yanked) versions are considered, and packages without such a version are left out. Results are
sorted by id; `totalHits` counts all matches before `skip` and `take`.

```json
{
  "totalHits": 1,
  "data": [
    {
      "id": "Acme.Sdk",
      "version": "1.2.0",
      "description": "Acme SDK for .NET",
      "authors": "Acme",
      "tags": ["acme", "sdk"],
      "registration": "https://packages.example.com/nuget/registration/acme.sdk/index.json",
      "totalDownloads": 0,
      "versions": [
        {
          "version": "1.2.0",
          "downloads": 0,
          "@id": "https://packages.example.com/nuget/registration/acme.sdk/index.json#1.2.0"
        }
      ]
    }
  ]
}
```

`version` is the highest considered version; `versions` lists every considered version.
Download counts are not tracked and are always `0`.

## 10. Swift registry (`/swift/…`)

The Swift Package Registry protocol (SE-0292), as used by SwiftPM. The registry URL that
clients configure is `<PUBLIC_URL>/swift`. It is not part of `/api/v1`: sections 1.2, 1.4 and
3 do not apply. It exists only while `swift` is enabled in `ECOSYSTEMS`; otherwise every
`/swift/…` path answers `404 not_found`.

### 10.1 Conventions

- **Authentication**: any form of 2.2; SwiftPM sends Basic (from
  `swift package-registry login --username/--password`, the keychain or `.netrc`) or Bearer
  (`--token`). A token with the `read` role sees the versions allowed by its `read` `swift` grants, including
  transitive access (5.3); `admin` sees everything; a token without `read` gets `403`. A missing
  or invalid credential gets `401` with both `WWW-Authenticate: Basic realm="serverless-registry"`
  and `WWW-Authenticate: Bearer realm="serverless-registry"`. A `read` credential without
  access to the package gets `404`.
- **Content negotiation**: every response carries `Content-Version: 1`. The Worker accepts
  `Accept: application/vnd.swift.registry.v1+json` (and `…v1+zip`, `…v1+swift` for archives and
  manifests); a missing `Accept`, or a generic one such as `application/json`, is tolerated.
  An `Accept` naming another API version (e.g. `application/vnd.swift.registry.v2+json`)
  answers `415 Unsupported Media Type`.
- **Errors** are problem details (`Content-Type: application/problem+json`):
  `{ "status": 404, "title": "Not Found", "detail": "…" }`.
- **Paths**: `<scope>` and `<name>` are matched case-insensitively; responses use the casing
  stored with the package. `Cache-Control: private, no-store` on every response.
- **Yank**: a yanked release carries `problem` in the release list (10.2), its metadata answers
  `410` (10.3), and its archive and manifests stay downloadable for `Package.resolved`.

### 10.2 `GET /swift/<scope>/<name>`

The releases covered by the grants:

```json
{
  "releases": {
    "1.2.0": { "url": "https://packages.example.com/swift/acme/Networking/1.2.0" },
    "1.1.0": {
      "url": "https://packages.example.com/swift/acme/Networking/1.1.0",
      "problem": { "status": 410, "title": "Gone", "detail": "this release was yanked" }
    }
  }
}
```

Errors: `404` when the package does not exist or no release is visible.

### 10.3 `GET /swift/<scope>/<name>/<version>`

Release metadata:

```json
{
  "id": "acme.Networking",
  "version": "1.2.0",
  "resources": [
    {
      "name": "source-archive",
      "type": "application/zip",
      "checksum": "a2ac54cf25fbc1ad0028f03f0aa4b96833b83bb05a14e510892bb27dea4dc812"
    }
  ],
  "metadata": {
    "repositoryURLs": ["https://github.com/acme/networking"],
    "readmeURL": "https://github.com/acme/networking/blob/main/README.md"
  },
  "publishedAt": "2026-10-28T10:12:00Z"
}
```

`checksum` is the hex SHA-256 of the archive. `metadata.repositoryURLs` and
`metadata.readmeURL` are present only when the manifest had `repositoryURL` / `readmeURL`.
`Link` headers point at neighbouring releases among the visible, non-yanked ones:
`rel="latest-version"` (the highest), `rel="successor-version"` (the next higher) and
`rel="predecessor-version"` (the next lower), each omitted when there is none. A yanked release
answers `410` with a problem body. Errors: `404`.

### 10.4 `GET /swift/<scope>/<name>/<version>/Package.swift[?swift-version=X]`

The content of a `manifest` file, verbatim, as `Content-Type: text/x-swift`. Without
`swift-version` it is `Package.swift`. With `swift-version=X` it is `Package@swift-X.swift`
when it exists, otherwise the variant with the highest version not above `X` (SwiftPM's own
selection rule), otherwise `Package.swift`. Every response lists the other variants as
`Link: <…/Package.swift?swift-version=5.9>; rel="alternate"; filename="Package@swift-5.9.swift"; swift-tools-version="5.9"`.
Errors: `404`.

### 10.5 `GET /swift/<scope>/<name>/<version>.zip`

`302 Found` to a presigned `GET` URL of the source archive, valid for 15 minutes, with
`Digest: sha-256=<base64 of the SHA-256>`. Yanked releases stay downloadable. SwiftPM does not
forward `Authorization` to the storage host. Errors: `404`.

### 10.6 `GET /swift/identifiers?url=<repo-url>`

Maps a repository URL to package identities:

```json
{ "identifiers": ["acme.Networking"] }
```

The URL is compared case-insensitively with the `repositoryURL` of every visible package's
manifests, with or without a trailing `.git`. Errors: `400` without `url`, `404` when no
visible package matches.

### 10.7 `POST /swift/login`

`swift package-registry login` checks the credentials with this request. It answers `200` with
an empty body for any valid credential, and `401` otherwise.

## 11. Maven repository (`/maven/…`)

The Maven 2 repository layout, as used by Maven and Gradle (Android included). Clients
configure `<PUBLIC_URL>/maven` as the repository URL. It is not part of `/api/v1`: sections
1.2, 1.4 and 3 do not apply. It exists only while `maven` is enabled in `ECOSYSTEMS`;
otherwise every `/maven/…` path answers `404 not_found`.

### 11.1 Conventions

- **Authentication**: any form of 2.2; Maven sends Basic from `settings.xml`
  (`<server><username>`/`<password>`), Gradle Basic from `credentials { username; password }`
  or Bearer through `HttpHeaderCredentials`. A token with the `read` role sees the versions allowed by its
  `read` `maven` grants, including transitive access (5.3); `admin` sees everything; a token
  without `read` gets `403`. A missing or invalid credential gets `401` with both
  `WWW-Authenticate: Basic realm="serverless-registry"` and
  `WWW-Authenticate: Bearer realm="serverless-registry"`, so that Maven sends its credentials.
  A `read` credential without access to the package gets `404`.
- **Paths**: `<group/as/path>` is the `groupId` with `.` replaced by `/`. The Worker parses a
  path from its end: the last segment is the file name; `maven-metadata.xml` (and its
  checksums) directly under `<group/as/path>/<artifactId>/` is the package metadata; otherwise
  the segment before the file is the version and the one before it the `artifactId`.
  Version-level `maven-metadata.xml` files (used only for snapshots) answer `404`.
- **Responses**: `Cache-Control: private, no-store` on every response; error bodies follow
  section 4.
- **Yank**: a yanked version disappears from `maven-metadata.xml`; its files stay
  downloadable under their full paths, which Maven and Gradle lockfiles use.

### 11.2 `GET /maven/<group/as/path>/<artifactId>/maven-metadata.xml`

Generated from the manifests of the visible, non-yanked versions, as
`Content-Type: application/xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>com.acme</groupId>
  <artifactId>sdk</artifactId>
  <versioning>
    <latest>1.5.0-rc1</latest>
    <release>1.4.0</release>
    <versions>
      <version>1.3.0</version>
      <version>1.4.0</version>
      <version>1.5.0-rc1</version>
    </versions>
    <lastUpdated>20261028101200</lastUpdated>
  </versioning>
</metadata>
```

`<versions>` is in ascending `ComparableVersion` order; `<latest>` is the highest version,
`<release>` the highest non-prerelease version (5.2), omitted when there is none;
`<lastUpdated>` is the newest `published` of the listed versions as `yyyyMMddHHmmss` in UTC.
`maven-metadata.xml.sha1`, `.md5`, `.sha256` and `.sha512` are computed from the generated XML
(which depends on the credential) and returned as lower-case hex in `text/plain`. Errors:
`404` when no version is visible.

### 11.3 `GET /maven/<group/as/path>/<artifactId>/<version>/<file>`

`302 Found` to a presigned `GET` URL of the file, valid for 15 minutes. Maven and Gradle do not
forward `Authorization` to the storage host. Errors: `404` when the version is not visible or
the file does not exist.

### 11.4 `GET …/<version>/<file>.sha1|.md5|.sha256|.sha512`

The digest of a version file as lower-case hex in `text/plain`: `.sha256` from the file's
`sha256`, the others from its `digests` (6.5). Errors: `404` when the file or that digest does
not exist.

## 12. npm and cargo read protocols

These details of the native npm and cargo protocols are implemented as described here; the
spec describes the endpoints in general terms.

Packages with no visible version: for a `read` credential, the npm packument and the composer
`p2/<vendor>/<package>.json` answer `404` when the package name is outside the credential's
grants and transitive closure (5.3). When the name is granted but no version of it is visible
(for example all of them are yanked or outside the granted range), they answer `200` with an
empty document: a packument whose `versions`, `dist-tags` and `time` are empty, and for
composer `{ "packages": { "<name>": [] }, "minified": "composer/2.0" }`. The cargo index
answers `404` in both cases, and the single-version endpoint `/npm/<name>/<version>` answers
`404` whenever the version is not visible.

### 12.1 npm (`/npm/…`)

- **Packument** (`GET /npm/<@scope/name>`, also with `%2f`): exactly the keys `_id`, `name`,
  `dist-tags`, `versions` and `time`. `versions` is in ascending version order; each entry is
  the version's `package.json` without keys starting with `_`, plus `name`, `version`, `_id`
  (`<name>@<version>`) and `dist: { tarball, integrity }` with `integrity` =
  `sha256-<base64>`. `time` has `created`, `modified` and one entry per version. Yanked
  versions are absent from `versions`, `time` and `dist-tags`.
- **Tarball URL**: always `<PUBLIC_URL>/npm/<@scope/name>/-/<unscoped>-<version>.tgz`, whatever
  the uploaded file was called. The route also accepts the `npm pack` form
  `<scope>-<unscoped>-<version>.tgz`; both answer `302` to a presigned `GET`.
- **Dist-tags** are not stored; they are derived from the manifests on every request (the tag
  each version was published with, 6.4):
  - every tag points at the highest visible version published with it;
  - when no visible version asked for `latest`, `latest` falls back to the highest stable
    version, and `next` likewise to the highest prerelease;
  - other tags disappear when all their versions are hidden (yanked, deleted or not granted);
  - an explicit `latest` on a lower or prerelease version is kept.
- **Single version** (`GET /npm/<name>/<version-or-dist-tag>`): the version entry as in the
  packument; `404` when the version (or the version the tag points at) is not visible.
- **`GET /npm/-/ping`** answers `{}` and **`GET /npm/-/whoami`** answers
  `{ "username": "<project>" }`, for any credential role (`publish` included).

### 12.2 cargo (`/cargo/…`)

- **Crate names** are lower case, `^[a-z][a-z0-9_-]{0,63}$`; the `.crate` file of a version is
  named `<name>-<version>.crate` (6.4).
- **`GET /cargo/index/config.json`** requires a credential, like the rest of the registry.
- **Index files**: one JSON line per version, in ascending version order, yanked versions
  included (`"yanked": true`). The keys of a line, in this order: `name`, `vers`, `deps`,
  `cksum`, `features`, `features2` (when present), `yanked`, `links` (when present),
  `rust_version` (when present), `v` (always `2`).
- **`GET /cargo/api/v1/crates/<name>`**:
  `{ "crate": { "name", "max_version", "versions": [ { "num", "yanked" } ] } }`, versions
  highest first.
