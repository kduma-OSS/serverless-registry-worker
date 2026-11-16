# Deploying Serverless Registry

This guide takes you from nothing to a working registry on your own Cloudflare account, and
then covers updates, the limits of the free plan, backups and troubleshooting. The
[specification](spec.md) ("Deployment, configuration and updates") describes the design behind
it; the [HTTP API contract](api.md) has the exact behaviour of every endpoint.

- [1. Before you start](#1-before-you-start)
- [2. Deploy the Worker](#2-deploy-the-worker)
- [3. What gets provisioned](#3-what-gets-provisioned)
- [4. Settings](#4-settings)
- [5. Custom domain](#5-custom-domain)
- [6. First run](#6-first-run)
- [7. Updating](#7-updating)
- [8. Cloudflare free plan limits](#8-cloudflare-free-plan-limits)
- [9. Backups](#9-backups)
- [10. Troubleshooting](#10-troubleshooting)

## 1. Before you start

You need:

- A **Cloudflare account**. The free plan is enough for a small team (see
  [section 8](#8-cloudflare-free-plan-limits)). R2 has to be enabled once in the dashboard
  (**R2 Object Storage** → **Overview**); Cloudflare may ask for a payment method even for the
  free tier.
- A **GitHub account** for the repository the registry is deployed from, and for publishing
  with GitHub Actions.
- Optionally, a **domain whose DNS is on Cloudflare**, e.g. `packages.example.com`. Without
  one the registry runs at `https://serverless-registry.<your-subdomain>.workers.dev`.
- The [`sreg` CLI](https://github.com/kduma-OSS/serverless-registry-cli#install) on your
  machine, or the [publish action](https://github.com/kduma-OSS/serverless-registry-action)
  in your pipelines, to publish packages.

Nothing installation-specific is ever committed to the repository: account IDs, bucket
credentials, the domain and every secret live in the Cloudflare dashboard. That is what keeps
updates conflict-free ([section 7](#7-updating)).

## 2. Deploy the Worker

The same repository supports three ways to deploy. Pick one.

| Path                                                        | For whom                        | Deploys on                       |
| ----------------------------------------------------------- | ------------------------------- | -------------------------------- |
| [Deploy to Cloudflare button](#deploy-to-cloudflare-button) | most installations              | every push to your `main`        |
| [Fork + GitHub Actions](#fork-and-github-actions)           | those who prefer GitHub Actions | every push to your fork's `main` |
| [Local `npm run deploy`](#local-deploy)                     | developers and one-off installs | every time you run it            |

### Deploy to Cloudflare button

1. Open
   <https://deploy.workers.cloudflare.com/?url=https://github.com/kduma-OSS/serverless-registry-worker>
   (the button at the top of the [README](../README.md) links there) and sign in to
   Cloudflare.
2. Connect your GitHub account and choose a name for the repository Cloudflare creates for
   you. It is a copy of this repository in your account, not a fork.
3. Review the resources Cloudflare is about to create from `wrangler.jsonc`: the Worker
   `serverless-registry`, a KV namespace for the `AUTH` binding and the R2 bucket
   `serverless-registry`. **Keep the suggested names.** If you rename the bucket, the
   `R2_BUCKET_NAME` variable must be changed to the same name ([section 4](#4-settings)), and
   every renamed resource makes later updates harder.
4. The setup page also asks for the five installation settings listed in
   [`.dev.vars.example`](../.dev.vars.example) (`PUBLIC_URL`, `S3_ENDPOINT`,
   `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `SESSION_SECRET`) and stores them as secrets.
   [Section 4](#4-settings) explains each one; whatever you do not have yet (the R2 API token
   needs the bucket to exist), enter as a placeholder and replace it there after the deploy.
5. Leave the build settings at their defaults (`npx wrangler deploy`) and click **Create and
   deploy**.

<!-- screenshot: the Deploy to Cloudflare page with the repository name, the KV namespace and the R2 bucket -->

Cloudflare builds and deploys the Worker with Workers Builds and redeploys it on every push to
the `main` branch of the new repository. The registry is not usable yet: continue with
[section 4](#4-settings).

### Fork and GitHub Actions

The repository contains `.github/workflows/deploy.yml`, which runs `npx wrangler deploy` on
every push to `main` and on demand. In the upstream repository it skips itself because the
secrets below are not set.

1. **Fork** the repository on GitHub.
2. **Create a Cloudflare API token**: **My Profile** → **API Tokens** → **Create Token** →
   template **Edit Cloudflare Workers**. Limit it to your account (and, if you use a custom
   domain, to its zone). Make sure it includes **Workers KV Storage: Edit** and **Workers R2
   Storage: Edit**: the first deploy creates the KV namespace and the bucket.
3. **Find your account ID**: the **Account ID** shown on the account home page or on
   **Workers & Pages** → **Overview**.
4. In the fork, open **Settings** → **Secrets and variables** → **Actions** and add two
   repository secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. Open the **Actions** tab. GitHub disables workflows in new forks; enable them, then run
   **Deploy** with **Run workflow**.

<!-- screenshot: the fork's Actions secrets with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID -->

From now on, every push to the fork's `main` (including "Sync fork") deploys.

### Local deploy

With Node.js 22:

```sh
git clone https://github.com/kduma-OSS/serverless-registry-worker.git
cd serverless-registry-worker
npm ci
npx wrangler login
npm run deploy
```

`wrangler login` opens a browser to authorise Wrangler for your account. To update, check out
a newer release tag and run `npm ci` and `npm run deploy` again.

For local development, copy [`.dev.vars.example`](../.dev.vars.example) to `.dev.vars` (it is
ignored by git), fill in the values and run `npm run dev`. `.dev.vars` is read only by
`wrangler dev`; it is never deployed.

## 3. What gets provisioned

Everything comes from [`wrangler.jsonc`](../wrangler.jsonc). Its bindings carry no IDs:
Wrangler creates the resources on the first deploy and finds them by name afterwards.

| What                            | Name                                          | Used for                                                                                                      |
| ------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Worker                          | `serverless-registry`                         | the registry: native protocols, `/api/v1`, the home page and the panel                                        |
| KV namespace, binding `AUTH`    | created by Wrangler                           | credentials, the `gh-repo:` index, the package groups (`pkg-groups`), `schema_version` and short-lived caches |
| R2 bucket, binding `R2_BUCKET`  | `serverless-registry`                         | package files, version manifests, generated indexes, staging of uploads                                       |
| Static assets, binding `ASSETS` | `./public`                                    | the panel's stylesheet, script and icon                                                                       |
| Cron trigger                    | `0 * * * *`                                   | hourly cleanup: uploads that were never committed (after 24 hours) and expired secrets                        |
| `keep_vars: true`, no `vars`    | see [section 4](#where-settings-live)         | deploys keep the variables set in the dashboard; the defaults live in code                                    |
| Observability                   | enabled                                       | Workers Logs in the dashboard                                                                                 |
| `workers.dev` route             | `serverless-registry.<subdomain>.workers.dev` | the address until you add a custom domain                                                                     |

What is **not** provisioned, because it is specific to your installation, are the settings in
the next section.

## 4. Settings

### Where settings live

Every setting lives in the dashboard (**Workers & Pages** → `serverless-registry` →
**Settings** → **Variables and Secrets** → **Add**) or comes from `npx wrangler secret put
<NAME>`, never from a file of the repository. Five of them are needed:

| Name                   | Required           | Value                                                                           |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `PUBLIC_URL`           | yes                | the registry's address without a trailing slash, `https://packages.example.com` |
| `S3_ENDPOINT`          | yes                | `https://<account-id>.r2.cloudflarestorage.com`                                 |
| `S3_ACCESS_KEY_ID`     | yes                | access key ID of the R2 API token (below)                                       |
| `S3_SECRET_ACCESS_KEY` | yes                | secret access key of the R2 API token                                           |
| `SESSION_SECRET`       | yes, for the panel | a long random string (below)                                                    |

Add `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `SESSION_SECRET` with the type _Secret_.
`PUBLIC_URL` and `S3_ENDPOINT` are not confidential and may be plain _Text_ variables, so you
can read them back in the dashboard; secrets work too. The Worker reads both kinds the same
way, and both survive deploys (Workers Builds, the GitHub workflow or `npm run deploy`):
`wrangler.jsonc` sets `keep_vars: true` and has no `vars` of its own, so a deploy neither
deletes the variables set in the dashboard nor resets them.

<!-- screenshot: Settings → Variables and Secrets with the five settings added -->

With Wrangler, run each command and paste the value when asked (add `--name
serverless-registry` when you are not inside a checkout of the repository); this stores all
five as secrets:

```sh
npx wrangler secret put PUBLIC_URL
npx wrangler secret put S3_ENDPOINT
npx wrangler secret put S3_ACCESS_KEY_ID
npx wrangler secret put S3_SECRET_ACCESS_KEY
npx wrangler secret put SESSION_SECRET
```

If you use Workers Builds, do not put these under the build settings: build variables are
visible only to the build, not to the running Worker.

### R2 API token (`S3_*`)

Archives never pass through the Worker. It signs short-lived S3 URLs with which the CLI
uploads and package managers download straight from R2, and it needs an R2 API token for that.
Scope the token to the registry's bucket only:

1. **R2 Object Storage** → **Overview** → **Manage API tokens** → **Create API token** (an
   account token, so that it does not depend on your user).
2. **Permissions**: **Object Read & Write**.
3. **Specify bucket(s)**: **Apply to specific buckets only** → `serverless-registry`.
4. **TTL**: forever (or a date, if you want to rotate it; set a reminder).
5. **Create**. Copy the **Access Key ID** into `S3_ACCESS_KEY_ID`, the **Secret Access Key**
   into `S3_SECRET_ACCESS_KEY` and the S3 endpoint
   (`https://<account-id>.r2.cloudflarestorage.com`, without the bucket name) into
   `S3_ENDPOINT`. The secret access key is shown only once.

<!-- screenshot: creating the R2 API token with Object Read & Write on the serverless-registry bucket -->

A bucket created in a jurisdiction (for example the EU) has its own endpoint,
`https://<account-id>.eu.r2.cloudflarestorage.com`; use the endpoint shown on the bucket's
**Settings** page.

### `SESSION_SECRET`

`SESSION_SECRET` signs the panel's session cookies (HMAC-SHA256). Generate at least 48 random
bytes:

```sh
openssl rand -base64 48
# or
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))"
```

Changing it signs everyone out of the panel and ends every login token (`st`, see
[Logins for people](#logins-for-people)); it also makes the one-time codes of existing `login`
secrets unusable, so those secrets have to be replaced. Static API tokens are not affected.
Without it, the panel login and browser login answer `500` naming the setting, while static
tokens keep working.

### `PUBLIC_URL`

`PUBLIC_URL` is the address clients use: it appears in indexes, download links and the
configuration snippets of the panel, and it is the audience every GitHub Actions OIDC token
must carry. Set it to the custom domain ([section 5](#5-custom-domain)) or to the
`workers.dev` address, with `https://` and without a trailing slash. Without it the Worker
falls back to the address of each request, but `gh` (OIDC) tokens are always rejected.

### Optional variables

These have defaults in the Worker's code that apply while the variable is not set. To change
one, add it in the dashboard as a plain _Text_ variable (**Settings** → **Variables and
Secrets**); to go back to the default, delete it. The panel's **Settings** page lists every
setting as _Set_, _Missing_ or _Default_ (never the value of a secret), shows these variables
as set in the dashboard and, for one that is not set, the default the Worker uses, marked
"(default)".

| Variable                         | Default                                        | Effect                                                                                                                                            |
| -------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `R2_BUCKET_NAME`                 | `serverless-registry`                          | bucket name in presigned URLs; must equal `bucket_name` of the `R2_BUCKET` binding                                                                |
| `ECOSYSTEMS`                     | `composer,npm,cargo,generic,nuget,swift,maven` | enabled ecosystems; a disabled one answers `404` everywhere and disappears from listings and the panel                                            |
| `MAX_UPLOAD_BYTES`               | `536870912` (512 MiB)                          | largest accepted file of a version                                                                                                                |
| `APPEND_WINDOW_HOURS`            | `24`                                           | how long after publishing files may still be appended to a generic version                                                                        |
| `TOKEN_PREFIX`                   | empty                                          | a fixed prefix such as `srg_` in front of every issued token, so leaked tokens can be found with grep; existing tokens keep working               |
| `LOGIN_TOKEN_EXTENDED_TTL_HOURS` | `24`                                           | how long a pull token lasts when it is approved with "extended validity" (1 to 720); otherwise a pull token lasts one hour                        |
| `MAX_PUBLISH_SCOPES`             | `20`                                           | most package versions one publish login token can approve (1 to 100); the approval link carries them too, so it is also capped at 8000 characters |
| `CHECK_UPDATES`                  | `true`                                         | the Settings page compares the running version with the latest release on GitHub (once a day)                                                     |

A value set in the dashboard stays in place across deploys and updates. Do not add a `vars`
block to `wrangler.jsonc` for this: Wrangler re-applies every value in `vars` on each deploy,
which would overwrite the dashboard and make updates conflict with your copy of the file.

## 5. Custom domain

Add the domain in the dashboard, not through `routes` in `wrangler.jsonc`:

1. **Workers & Pages** → `serverless-registry` → **Settings** → **Domains & Routes** →
   **Add** → **Custom domain**.
2. Enter the host name, e.g. `packages.example.com`. Its zone must be on Cloudflare;
   Cloudflare creates the DNS record and the certificate.
3. Set `PUBLIC_URL` to `https://packages.example.com` ([section 4](#public_url)).

<!-- screenshot: Settings → Domains & Routes → Add custom domain -->

The `workers.dev` address keeps working, but links the Worker generates use `PUBLIC_URL`, and
OIDC tokens must be requested for `PUBLIC_URL`. Publish and install through one address.

## 6. First run

### Create the admin

Open `PUBLIC_URL` in a browser. The first page checks the settings of section 4 and lists the
missing ones with how to add them; while `SESSION_SECRET` is missing it shows only that list
(with a button that generates a value in the browser), because nobody could sign in. While the
registry has no credential at all, the page then offers to create the first **admin**: enter a
project name (e.g. `admin`), optionally choose a password (at least 12 characters, typed
twice; otherwise the Worker generates one) and tick **Require a one-time code** to protect the
login with an authenticator app. The Worker shows the password **once**, with a QR code (and a
link and a key) for the authenticator when you asked for the code. Store the password in a
password manager. The form never appears again, and there is no password reset: consider
creating a second `admin` credential for a colleague or for a safe, because when every admin
login is lost the only way back is editing KV by hand.

<!-- screenshot: the first-run form and the password shown once with its QR code -->

Sign in with the project name as the login and the password (and the code from your
authenticator when asked: it comes as a second step after the password). The login page
offers **Token** as the other tab, for a `key` secret. An admin can also have a generated
`key` token for the API: add it on the credential's **Secrets** tab. The admin's header links
three pages: **Packages**, **Credentials** and **Settings**.
Check that **Settings** shows your `PUBLIC_URL` and the expected ecosystems.

### Credentials in short

Every credential is a project name with one or more roles, a list of grants for each role
and one or more secrets:

- `read` – installs packages; its `key` token is meant to be committed into the consumer's
  repository (`auth.json`, `.npmrc`, …).
- `publish` – publishes versions with `sreg`, usually from GitHub Actions; a token that only
  publishes never reads.
- both – the same project installs and publishes, with separate grants for each role. Every
  secret then has a **scope** (`read`, `publish` or both) that you choose when you add it, so
  the `key` you commit into a repository can stay `read`-only while the release workflow's
  `gh` secret is `publish`-only. Adding a role later never widens the secrets the credential
  already has.
- `admin` – the panel and the administrative API; no grants of its own. It signs in to the
  panel with a login (and a one-time code) and can have a `key` token for the API. It may be
  combined with `read` and `publish` in one credential, so an administrator can also install or
  publish with grants: each secret then has a **scope**, and a secret scoped to `admin` is the
  only one that administers. Adding `read` or `publish` to an existing admin (Grants tab,
  **Roles**) leaves its current secrets `admin`-only.

A grant is an ecosystem, a package name or `vendor/*` pattern and a version constraint in that
ecosystem's syntax (`*` for all). `read` grants are transitive by default: they also open the
versions of this registry's packages that the granted versions depend on. The token format is
`<project>:<secret>`; it works as Bearer, Basic and raw `Authorization` header.

### A publish credential for GitHub Actions (OIDC, no secret)

1. **Credentials** → **New credential**: project `ci-acme-sdk`, kind `publish`, grant
   `composer` / `acme/sdk` / `*`. Leave the first secret on **None** (the default); you add
   the OIDC secret next, and no token is created that you would have to expire.
2. On the **Secrets** tab, **Add a secret** → **GitHub Actions**:
   - **Repository**: `acme/sdk`. **Look up** fills in the repository and owner IDs for a
     public repository; for a private one, enter them by hand (they protect against a
     deleted repository's name being taken again).
   - **Ref**: `refs/tags/v*`, and/or **Workflow**: `.github/workflows/release.yml`, so that
     only the release workflow can publish, not every pull request.
3. In the package's repository, publish on tags with the
   [publish action](https://github.com/kduma-OSS/serverless-registry-action):

   ```yaml
   on:
     push:
       tags: ["v*"]

   jobs:
     publish:
       runs-on: ubuntu-latest
       permissions:
         contents: read
         id-token: write
       steps:
         - uses: actions/checkout@v4
         - uses: kduma-OSS/serverless-registry-action/publish@v1
           with:
             ecosystem: composer
             registry: https://packages.example.com
   ```

   `registry` must be exactly `PUBLIC_URL`. Without a `token` input the action uses the job's
   OIDC token and the registry finds the project from the repository; when one repository
   has several matching credentials with the `publish` role, name it with `oidc-project`.

<!-- screenshot: adding a gh secret with the repository, its IDs, the ref and the workflow -->

### A publish credential with a key

Outside GitHub Actions, or if you prefer a stored secret: create the `publish` credential as
above, copy the token shown once into a repository secret (e.g. `REGISTRY_PUBLISH_TOKEN`) and
pass it as `token: ${{ secrets.REGISTRY_PUBLISH_TOKEN }}` to the action, or as
`REGISTRY_TOKEN` to `sreg`.

### One credential for installing and publishing

A project that both installs from and publishes to the registry can use one credential:
**New credential** → kind **read + publish**, read grants (what it installs) and publish
grants (what it releases), and the scope of the first token. For example, `acme-sdk` with
read `composer` / `acme/*` / `*`, publish `composer` / `acme/acme-sdk` / `*` and a first
`key` scoped to `read` for the consumers' `auth.json`. Then add a **GitHub Actions** secret
scoped to `publish` for the release workflow. To turn an existing credential into this, open
its **Grants** tab, tick the other role under **Roles**, add its grants and add a secret
scoped to the new role: the secrets it already has keep only the roles they had. To change what an existing secret may do, use **Edit** in its row on the **Secrets** tab and pick
`read`, `publish` or `read + publish`; a key or a login keeps its value and id, and a GitHub
Actions secret is replaced by a changed copy.

### Read credentials for consumers

Create one `read` credential per consuming project (`shop-frontend`, grant `composer` /
`acme/*` / `*`), copy its token and give it to that project. Logging in to the panel with it
shows the packages it may install and ready-to-paste client configuration for each ecosystem.
For the consumer's own CI, add a `gh` secret for its repository and use
`sreg auth <eco> --oidc` there instead of committing anything (see the CLI's
[README](https://github.com/kduma-OSS/serverless-registry-cli#commands)).

<!-- screenshot: the consumer view with packages and configuration snippets -->

### Logins for people

A `read` or `publish` credential can also hold a **login** secret: a password and, optionally,
a one-time code for an authenticator app. Add it on the credential's **Secrets** tab (type
_Login_); the password and the code's key are shown once. People then use the CLI instead of
copying tokens around:

- `sreg login` prints `export REGISTRY_TOKEN=…` for a short-lived pull token (`eval "$(sreg
login)"`); with `--publish composer:acme/sdk@1.4.0` (repeatable) it issues a publish token
  for exactly those versions.
- `sreg auth <eco> --login` writes a pull token into the package manager's credentials file,
  `sreg <eco> publish --login` publishes one version, `sreg generic get --login` downloads
  one file.
- `sreg yank <eco> <name> <version> --login` and `sreg delete <eco> <name> <version|--all>
--login` ask an `admin` credential with a login secret to approve one yank or delete in the
  browser (a delete is shown with a warning) and use the resulting 15-minute token for that
  operation only. In GitHub Actions `--oidc` works for an `admin` credential with a matching
  `gh` entry.

Each opens the registry's `/authorize/…` page in the browser. Signed in already, you only
approve; a publish is approved only when the credential's grants allow every listed package
version, and with a one-time code it needs one entered in the last 15 minutes. Pull tokens
last one hour (or `LOGIN_TOKEN_EXTENDED_TTL_HOURS` hours if you tick "extended validity"),
publish tokens 15 minutes. Expiring the login secret ends its tokens and browser sessions.

The Worker does not limit attempts. Add a rate limiting rule in the Cloudflare dashboard
(**Security** → **WAF** → **Rate limiting rules**) for the path starting with `/authorize/`,
for example 10 requests per minute per IP address.

### Publish the first version

Install `sreg` ([install instructions](https://github.com/kduma-OSS/serverless-registry-cli#install))
and publish from a tagged checkout:

```sh
export REGISTRY_URL=https://packages.example.com
export REGISTRY_TOKEN='ci-acme-sdk:…'
git tag v1.0.0
sreg composer publish --dry-run   # the registry checks everything, nothing is uploaded
sreg composer publish
```

The version appears on the admin's **Packages** page and, for credentials whose grants cover
it, in the consumer view.

## 7. Updating

Releases are tagged `vX.Y.Z` (semantic versioning). Prereleases (`vX.Y.Z-beta.N`) are marked
as such on GitHub, are meant for testing and are not reported by the update check. Read
[`CHANGELOG.md`](../CHANGELOG.md) before updating:

- Entries marked **Breaking** need something from you, e.g. a new required secret.
- Entries marked **Requires migration** change the data schema. You do not run anything: on
  the first request after the deploy, the Worker compares `schema_version` in KV with the
  version it expects and runs the missing migrations in order (they are small and
  idempotent). If a release changes an index format, it says so and asks for a reindex of
  the packages, which rebuilds them from the manifests.

Check the `R2_BUCKET` binding after every deploy (**Settings** → **Bindings**), especially
when your repository has its own `wrangler.jsonc`: the Worker refuses to use a bucket that is
not the one it used before ([troubleshooting](#503-bucket_mismatch-or-a-red-the-r2-bucket-is-not-the-one-this-registry-used-before-banner)),
but it cannot know which bucket you meant.

The **Settings** page shows the running version and data schema version and, unless
`CHECK_UPDATES` is set to `false`, whether a newer release exists.

The easiest way on the GitHub paths is the [Update from upstream
workflow](#updating-with-a-workflow): one click in your repository's **Actions** tab. How to
update by hand depends on the path you deployed with. You never edit files, and the settings
in the dashboard survive the deploy, so there is nothing to conflict:

- **Fork + GitHub Actions**: on GitHub, open your fork → **Sync fork** → **Update branch**. The
  push to `main` deploys. To follow releases rather than `main`, merge a release tag instead:

  ```sh
  git remote add upstream https://github.com/kduma-OSS/serverless-registry-worker.git
  git fetch upstream --tags
  git merge v0.2.0
  git push origin main
  ```

- **Deploy to Cloudflare button**: your repository is a copy, not a fork, so GitHub offers no
  "Sync fork". Merge a release tag as above; Workers Builds deploys the push. If Git refuses
  because the histories are unrelated (the copy may start from a fresh commit), merge the
  first time with `git merge --allow-unrelated-histories -X theirs v0.2.0`.
- **Local**: `git fetch --tags`, `git checkout v0.2.0`, `npm ci`, `npm run deploy`.

`sreg` and the Worker are released independently; see the [README](../README.md#compatibility)
for how their versions are kept compatible.

To roll back, use **Workers & Pages** → `serverless-registry` → **Deployments** (or
`npx wrangler rollback`), but only to a version that expects the same `schema_version`: a
migration is not undone by rolling back the code.

### Updating with a workflow

`.github/workflows/update.yml` (**Update from upstream**) brings the code of this project
(`kduma-OSS/serverless-registry-worker`) into your repository and pushes it to your default
branch, which deploys it. It works for a fork and for the copy the Deploy to Cloudflare button
makes, and it skips itself in the upstream repository.

1. In your repository open **Actions** → **Update from upstream** → **Run workflow**.
2. Choose what to update to and run it:

   | Input     | Meaning                                                                                                                                                   |
   | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `channel` | `stable`: the newest release. `prerelease`: the newest release of any kind, betas included. `custom`: the tag below. `develop`: upstream's `main` branch. |
   | `tag`     | Only for `custom`: a release tag such as `v0.2.0` (the `v` is optional).                                                                                  |
   | `dry_run` | Show what would change in the run's summary; nothing is committed or pushed.                                                                              |

<!-- screenshot: the Update from upstream workflow's Run workflow form -->

What it does, in this order, and stops at the first failure without pushing anything:

- **Chooses the release** from upstream's tags and refuses one whose version is **older than
  the one in your repository** (`package.json`); the same version is fine. To go back, use the
  rollback of [the Cloudflare dashboard](#7-updating), not this workflow.
- **Merges it** into the default branch. A copy without a shared history (the button's) takes
  upstream's files. A conflict in `wrangler.jsonc` is settled for you; a conflict in any other
  file (you changed it yourself) aborts the update and lists the files: merge by hand as
  described above.
- **Keeps your bindings.** When `wrangler.jsonc` conflicts (or has no shared history), the
  workflow takes upstream's file with its comments and lays what your file configured over it:
  your bindings (matched by their `binding` name, so `bucket_name` of `R2_BUCKET` and the `id`
  of `AUTH` stay yours and a binding upstream adds is added), `name`, `routes`, `account_id`,
  `vars` and any key upstream does not know. Always taken from upstream: `main`,
  `compatibility_date`, `compatibility_flags`, `assets`, `triggers`, `observability`,
  `keep_vars` and `$schema`.
- **Checks the result**: `npm ci`, the type check and `wrangler deploy --dry-run` (the
  configuration parses and the bindings resolve; nothing is deployed).
- **Pushes** to the default branch. Workers Builds deploys from the push; with the GitHub
  Actions deploy path the workflow starts **Deploy** itself, because a push made with
  `GITHUB_TOKEN` does not start other workflows.

Set up once:

- **Workflow permissions.** In your repository **Settings** → **Actions** → **General** →
  **Workflow permissions** choose **Read and write permissions**. A protected default branch
  must let the workflow push (or use `UPDATE_TOKEN` below).
- **Files of `.github/workflows` (optional `UPDATE_TOKEN`).** GitHub does not let `GITHUB_TOKEN`
  change workflow files, so without a token the workflow **leaves your copies of
  `.github/workflows/` as they are**, says so in a warning and in the summary, and updates
  everything else. To update them too, create a fine-grained personal access token for your
  repository with **Contents: Read and write** and **Workflows: Read and write** and save it as
  the repository secret `UPDATE_TOKEN`. The first time, a repository from before this workflow
  has to get the workflow files by one manual update as described above.
- After every deploy, check the `R2_BUCKET` binding (**Settings** → **Bindings**); see
  [troubleshooting](#503-bucket_mismatch-or-a-red-the-r2-bucket-is-not-the-one-this-registry-used-before-banner).

The **Settings** page of the panel mentions this workflow whenever a newer release exists.
Try `dry_run` first if you changed files other than `wrangler.jsonc`.

### Configure bindings

`.github/workflows/configure.yml` (**Configure bindings**) writes the bindings of your
installation into `wrangler.jsonc`, commits the change to the default branch and starts the
deploy. Pinning them in your repository means the **Update from upstream** workflow keeps
them, and a deploy never binds the Worker to another bucket. Run it from **Actions** →
**Configure bindings** → **Run workflow**; a setting left empty stays as it is.

| Input             | Written to `wrangler.jsonc`                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `worker_name`     | `name`                                                                                                                                                                   |
| `r2_bucket`       | `bucket_name` of the `R2_BUCKET` binding (3 to 63 characters: lowercase letters, digits, hyphens)                                                                        |
| `r2_jurisdiction` | `jurisdiction` of the `R2_BUCKET` binding: `eu` or `fedramp` for a bucket created in one, `none` for the default one, `unchanged` (the default) leaves the file as it is |
| `kv_namespace_id` | `id` of the `AUTH` binding (32 hexadecimal characters); empty lets Wrangler find or create it by name                                                                    |
| `route`           | `routes`: your custom domain as a Workers custom domain, e.g. `packages.example.com` (no path)                                                                           |
| `dry_run`         | Show the change in the summary; nothing is committed or pushed                                                                                                           |

**A bucket created in a jurisdiction (for example the EU) needs `jurisdiction` in the binding.**
Without it a deploy binds the Worker to a bucket of the same name in the default jurisdiction,
which is another, empty bucket: the Worker then refuses to use it (`503 bucket_mismatch`) and
the packages seem gone. If the Cloudflare dashboard shows your binding with a jurisdiction
(**Settings** → **Bindings**, or the configuration view, where it appears under `unsafe`), run
this workflow with the same `r2_bucket` and `r2_jurisdiction`; the **Update from upstream**
workflow keeps it from then on. The S3 endpoint must be the jurisdiction's too
(`https://<account-id>.eu.r2.cloudflarestorage.com`, see [Settings](#r2-api-token-s3_)).

It touches only these bindings. The variables and secrets of the Worker stay in the
dashboard: when you change the bucket here, `R2_BUCKET_NAME` there must be the same name.

### Releasing (maintainers)

Releases of this repository are cut from `main` with the manual **Bump and release** workflow
(`.github/workflows/bump-and-release.yml`): **Actions** → **Bump and release** → **Run
workflow**, or `gh workflow run bump-and-release.yml -f bump=prerelease`. Started from any
other branch it fails straight away, so releases stay linear; runs are serialised by the
`release` concurrency group. Do not tag by hand: a release tag must match the version in
`package.json`.

`bump` says how the version changes; the current version is read from `package.json`.
`version` is used with `bump: custom` only.

| `bump`                             | Result                                                                                                                                                                               | Examples                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `prerelease` (default)             | The next prerelease. A prerelease increments its last number; a stable version starts a `-beta.1` of the next patch (like `npm version prerelease --preid beta`, counting from `1`). | `1.2.0-beta.3` → `1.2.0-beta.4`, `1.2.0-rc.1` → `1.2.0-rc.2`, `1.2.0` → `1.2.1-beta.1`             |
| `prepatch`, `preminor`, `premajor` | The first prerelease (`-beta.1`) of the next patch, minor or major version.                                                                                                          | `1.2.0` → `1.2.1-beta.1`, `1.3.0-beta.1`, `2.0.0-beta.1`                                           |
| `patch`, `minor`, `major`          | Like `npm version`: the next patch, minor or major version; from a prerelease of that version, its stable base.                                                                      | `1.2.3` → `1.2.4`; `1.2.0-beta.3` → `1.2.0` (`patch`, `minor`); `2.0.0-beta.1` → `2.0.0` (`major`) |
| `release`                          | Drops the prerelease suffix; an error for a stable version.                                                                                                                          | `1.2.0-beta.3` → `1.2.0`                                                                           |
| `none`                             | Releases the current version as it is; an error when its tag exists.                                                                                                                 | `0.1.0` → `0.1.0`                                                                                  |
| `custom`                           | The `version` input: strict semver without a leading `v` or build metadata, greater than the current version.                                                                        | `1.2.0` → `1.3.0-rc.1`                                                                             |

A computed version must not have a tag yet. The run then:

1. Checks out `main` with its full history and tags and computes the version with
   `scripts/bump-version.mjs`.
2. Sets it in `package.json`, `package-lock.json` (the root package, as
   `npm version --no-git-tag-version` would) and `VERSION` in `src/version.ts`.
   `MIN_CLIENT_VERSION` is not touched; raise it in a normal commit (see the
   [README](../README.md#compatibility)).
3. Rolls `CHANGELOG.md`: the `[Unreleased]` entries move under `## [<version>] - <today>`
   (UTC), an empty `[Unreleased]` stays above, and the compare links at the bottom are
   updated. When the version already has a section (written ahead, as for `0.1.0`), the
   entries are merged into its `### Added`/`### Changed`/… groups and its date is set to
   today. An empty `[Unreleased]` without a section for the version is an error (nothing to
   release), except with `bump: none`.
4. Runs `npm ci`, `npm run check`, `npm run lint`, `npm test` and the script's own tests.
5. Commits `chore(release): v<version>` as `github-actions[bot]`, creates the annotated tag
   `v<version>` with the changelog section as its message, and pushes both to `main`.
6. Creates the GitHub Release `v<version>` with the changelog section as its notes, marked
   as a prerelease when the version has a suffix (`-beta.1`), and writes a summary with the
   version, the tag and a link to the release.

The panel's update check reads `releases/latest` from the GitHub API, which ignores
prereleases and drafts: installations are told about stable releases only, and a `-beta`
release never shows up as an available update.

The workflow declares `contents: write` itself, so **Settings → Actions → General → Workflow
permissions** can stay at the default, and no pull request is opened. It pushes the release
commit and the tag straight to `main`, so branch protection or rulesets on `main` must let that
push through. `GITHUB_TOKEN` cannot be put on a ruleset's bypass list, so a ruleset that
requires status checks (for example `Changelog entry`, which only exists on pull requests)
rejects it with `GH013: Required status check … is expected`. For that case the workflow pushes
as a GitHub App when the repository has these (as variables or secrets):

- `SERVERLESS_REGISTRY_RELEASE_APP_ID` – the App ID,
- `SERVERLESS_REGISTRY_RELEASE_APP_PRIVATE_KEY` – the App's private key (PEM; a secret).

The App needs the **Contents: Read and write** permission, must be installed on the
repository, and must be on the ruleset's **Bypass list** (Add bypass → Apps). Without the two
values the workflow uses `GITHUB_TOKEN`, which is enough when `main` has no such rule. Pushes
made as the App start the other workflows (a CI run on the release commit; the deploy workflow
skips itself without its Cloudflare secrets); the run still checks everything itself before
pushing.

`scripts/bump-version.mjs` needs only Node.js and works locally too:

```sh
node scripts/bump-version.mjs prerelease          # prints the next version
node scripts/bump-version.mjs custom 0.2.0-rc.1   # with bump custom
node scripts/bump-version.mjs patch --dry-run     # also prints every change it would make
node scripts/bump-version.mjs patch --apply       # rewrites the version files and CHANGELOG.md
node scripts/bump-version.mjs --current           # the current version
```

`--notes-file <path>` writes the release notes (the version's changelog section) and
`--date YYYY-MM-DD` overrides today's date. Its tests run with
`node --test 'scripts/*.test.mjs'`.

## 8. Cloudflare free plan limits

The registry is designed to run on the free plan for a small team. These are the limits that
matter (as of this release; check Cloudflare's current pricing pages):

| Resource              | Free plan                                            | What uses it                                                                     |
| --------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Worker requests**   | **100,000 a day**                                    | every request that reaches the Worker (below); this is the limit you reach first |
| KV reads              | 100,000 a day                                        | credential lookups, mostly absorbed by a 60-second cache in each Worker isolate  |
| KV writes and deletes | 1,000 a day each                                     | credential changes in the panel, the hourly cleanup and migrations (below)       |
| R2                    | 10 GB, 1 million writes and 10 million reads a month | uploads, downloads and index rebuilds; egress is free                            |
| CPU time              | 10 ms per request                                    | signature checks and index building; ample for metadata requests                 |

**What counts against the 100,000 requests a day.** Every metadata request of a package
manager (Composer's `packages.json` and one `p2` file per package, npm's packument per package,
one cargo index file per crate, the NuGet, Swift, Maven and generic feeds), every download
(the Worker answers with a redirect to R2, so each download is one Worker request plus one R2
read), every `/api/v1` call (a publish is two: `init` and `commit`) and every panel page or
form. Not counted: the transfers to and from R2 themselves, the panel's static files, and
requests answered from a client's own cache. A `composer install` of 20 private packages with
an empty cache is about 40 requests, so the daily limit is roughly 2,500 such installs.

Practical advice:

- **Cache package manager downloads in CI** (`actions/cache` or the setup actions' `cache:`
  option). A warm cache skips the download redirects, which are about half of the requests.
- **Enable only the ecosystems you use** (`ECOSYSTEMS`) – it does not save requests, but keeps
  the panel short and closes endpoints nobody needs.
- **Watch the usage** in **Workers & Pages** → **Overview** (requests) and **Storage &
  Databases** → **KV** (operations). When the daily request limit is used up, Cloudflare
  answers further requests with an error page until the counter resets at 00:00 UTC; installs
  and publishes fail in that time.
- KV writes come only from credential changes, the hourly cleanup of expired secrets and data
  migrations. The update check and the 60-second cache of the transitive dependencies of
  `read` credentials use the Cache API, and the dependency graph behind that cache is stored in
  R2, so installing and publishing write nothing to KV.

**When to move to Workers Paid.** A larger team, CI that installs many times an hour, or a
registry that serves public pipelines should switch the account to **Workers Paid** ($5 a
month: 10 million requests and 10 million KV reads a month included, 1 million KV writes, 30
seconds of CPU per request). Nothing in the registry changes; it is a billing setting of the
account (the **Workers plans** page of the dashboard). Paid is also the answer if commits of very large
files with extra digests (Maven's SHA-1 and MD5) fail with a CPU-time error on the free plan.

**D1.** The registry does not use D1. Moving credentials from KV to D1 (whose free plan allows
5 million row reads and 100,000 row writes a day) has been considered and is not planned; it
would only become worthwhile if the registry needed queries such as search or reports.

## 9. Backups

**R2 is the source of truth.** Each version is a `manifest.json` and its files under
`<eco>/pkg/<name>/<version>/`. Everything else in the bucket is derived from the manifests:
the indexes under `<eco>/index/`, `_meta/packages.json` and the dependency graphs
`_meta/deps/<eco>.json`. **The manifests are the only
durable data contract** – future releases may change index formats, but they will always read
the manifests.

- **Back up the bucket**, at least the `*/pkg/` prefixes, with any S3 tool and a read-only R2
  API token for the bucket, e.g. with [rclone](https://rclone.org/s3/#cloudflare-r2):

  ```sh
  rclone sync r2:serverless-registry ./registry-backup --exclude "_staging/**"
  ```

  Deleting a version or a package in the panel is permanent; R2 keeps no previous versions.

- **Back up the credentials** if recreating them would be painful. KV holds only hashes of
  secrets, so a backup cannot leak tokens, but restoring it saves redistributing new tokens.
  The `cred:<project>` keys are enough:

  ```sh
  # the namespace ID is shown in Storage & Databases → KV
  npx wrangler kv key list --namespace-id <id> --remote --prefix cred: > cred-keys.json
  npx wrangler kv key get --namespace-id <id> --remote cred:shop-frontend > cred-shop-frontend.json
  ```

  After restoring `cred:` keys into a namespace, delete its `schema_version` key: the
  migrations then run again on the next request and rebuild the `gh-repo:` index.

- **Restore** by copying the `<eco>/pkg/` prefixes back into the bucket and running
  **Reindex** for each package (the Packages page, or
  `POST /api/v1/packages/<eco>/<name>/reindex` with an admin token for every package listed by
  `GET /api/v1/packages`). Reindex rebuilds the package's indexes from its manifests; a
  missing `_meta/packages.json` is rebuilt by the migrations as above.

### Backfill Composer archive checksums

New Composer publications include SHA-1 in `dist.shasum`, calculated from the uploaded ZIP
in addition to the mandatory SHA-256. After deploying this feature, enrich existing versions
from the Worker checkout with Node.js 22 or newer:

```sh
export REGISTRY_URL=https://packages.example.com
# Set REGISTRY_TOKEN to an admin token through your usual secret environment mechanism.
node scripts/backfill-composer-shasum.mjs
# Optionally limit the operation to one package:
node scripts/backfill-composer-shasum.mjs --package acme/sdk
```

The tool processes versions sequentially, including yanked versions. The Worker streams each
archive once to compute missing digests and verify the size and SHA-256 before changing its
manifest. It preserves archive bytes and publication metadata. A mismatch or missing artifact
is reported as an error; investigate the stored object and restore the original archive from
backup rather than accepting a different checksum.

Check the final updated/skipped/error counts. The tool continues after individual failures
and exits nonzero if any operation failed. Rerun it to resume: completed versions are skipped,
and every visited package is reindexed even when no sums remain missing. This also repairs
an interrupted run that wrote manifests but had not rebuilt their indexes. Ordinary reindex
never reads archives or computes missing digests. No cron or blocking migration is installed.

Uploads initialized before deployment retain their old digest declarations. Repeat the tool
after those publication jobs have completed, or their staging data has been removed by cleanup
(uncommitted uploads older than 24 hours). Upload URLs expire after 10 minutes, but already
uploaded staging objects can still be committed later; URL expiry alone does not close that
window. A rerun includes any versions committed by an older publication flow.

Existing consumer `composer.lock` files do not gain `shasum` automatically. Consumers must
refresh dependency metadata and commit the updated lock file to enable checksum verification
for previously locked packages. SHA-1 is for Composer compatibility; SHA-256 remains the
registry's upload integrity check.

### NuGet archive checksums

New NuGet publications compute SHA-512 in addition to mandatory SHA-256. The native endpoint
`GET /nuget/flat/<id>/<ver>/<id>.<ver>.nupkg.sha512` serves the archive digest as Base64 under
the same read grants as the package, including yanked versions. Existing versions return
`404` until enriched and reindexed. With an admin credential, call
`POST /api/v1/packages/nuget/<id>/<version>/backfill-digests` for each existing version, then
`POST /api/v1/packages/nuget/<id>/reindex` for each package. Backfill verifies stored size and
SHA-256 first; rerunning is safe. Include yanked versions and repeat after uploads initialized
before deployment have finished, as described for Composer above.

The checksum endpoint does not by itself make `dotnet restore` verify server-provided hashes.
For repeatable restores in PackageReference projects, enable `RestorePackagesWithLockFile`,
commit `packages.lock.json`, and use `dotnet restore --locked-mode` in CI. NuGet compares its
content hashes with the lock file; for signed packages these may differ from the full archive
hash exposed by the endpoint. Existing author signatures survive unchanged archive uploads;
verification follows the client's platform and `nuget.config` trust policy. The Worker does
not add repository signatures.

## 10. Troubleshooting

Start with the Worker's logs: **Workers & Pages** → `serverless-registry` → **Logs**, or
`npx wrangler tail` while you reproduce the problem. Messages never contain secrets.

### `500` "Presigning is not configured: set … in the Worker settings."

Publishing (`init`) and every download need `S3_ENDPOINT`, `S3_ACCESS_KEY_ID` and
`S3_SECRET_ACCESS_KEY`; the message names the ones that are missing, or says that
`S3_ENDPOINT` is not an `http(s)` URL. Add them in **Settings** → **Variables and Secrets**
([section 4](#4-settings)), not among the build variables of Workers Builds, which the running
Worker does not see.

If the settings are present but the upload to R2 fails (`403` with `SignatureDoesNotMatch` or
`AccessDenied` from R2), check that the token has **Object Read & Write** on this bucket, that
`S3_ENDPOINT` is the account's endpoint (or the jurisdiction's) without the bucket name, and
that `R2_BUCKET_NAME` equals the bucket's real name.

### `503 bucket_mismatch`, or a red "The R2 bucket is not the one this registry used before" banner

The Worker is bound to an R2 bucket that is not the one its data lives in, usually because a
deploy repointed or recreated the `R2_BUCKET` binding (a different `bucket_name` in your
`wrangler.jsonc`, a bucket renamed in the dashboard). The Worker remembers an installation id
in KV and in the bucket (`_meta/installation.json`); when they differ it refuses to read or
write packages (so nothing is published into the new bucket and nothing looks deleted), runs
no migration and skips the hourly cleanup. The panel, credentials and logins keep working.

1. Check **Workers & Pages** → `serverless-registry` → **Settings** → **Bindings**: the
   `R2_BUCKET` binding must point at the bucket that holds your packages, and `bucket_name`
   in your `wrangler.jsonc` and `R2_BUCKET_NAME` must be that bucket's name. A bucket created
   in a jurisdiction (EU, FedRAMP) also needs its `jurisdiction` in `wrangler.jsonc`: without
   it the deploy binds the bucket of that name in the default jurisdiction, which is another
   one. The [Configure bindings](#configure-bindings) workflow sets both.
2. Fix the binding and deploy again: the next request notices, no confirmation is needed.
3. Only when the bucket really is the new one (you moved the data on purpose, or you restored
   a backup into a new bucket), sign in as an admin and press **Use this bucket** in the
   banner (or `POST /api/v1/bucket/accept`, see docs/api.md 6.23). That makes it the
   installation's own and builds `_meta/packages.json` if it is missing; after a restore run
   a reindex as described in [Backups](#9-backups).

An installation from before this check adopts the bucket it is bound to at its first request
after the update, so update while the binding is right.

### `500` "Sessions are not configured"

The panel login needs `SESSION_SECRET`. API tokens and package managers work without it.

### `401 unauthorized`

`401` means the credential could not be verified. A valid credential that lacks the right
role or grant gets `403` instead, and a `read` credential asking for a package it has no grant
for gets `404`, so that it cannot learn which packages exist.

| Symptom                                                             | Likely cause                                                                                                                                                        | Fix                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| every request with the token fails                                  | token mistyped or truncated (no `:`), unknown project, secret expired or removed                                                                                    | check the token against the panel (Credentials → Secrets); issue a new `key`                                             |
| a token stops working at a known date                               | the secret had an `expires` date; the hourly cleanup removed it                                                                                                     | add a new secret before expiring the old one                                                                             |
| `gh` (OIDC) tokens always fail, `key` tokens work                   | `PUBLIC_URL` is not set, or differs from the `registry` URL the CLI requested the token for (the token's audience)                                                  | set `PUBLIC_URL`; use exactly the same URL (scheme, host, no trailing slash) in `REGISTRY_URL` / the action's `registry` |
| `gh` tokens fail for one repository                                 | the `gh` entry does not match the job: repository, its IDs (recreated or transferred repository), `ref` (branch vs. `refs/tags/v*`), `workflow` path, `environment` | compare the entry with the job; the workflow path is the file, e.g. `.github/workflows/release.yml`                      |
| "more than one project matches this token"                          | the `_` login found several credentials with the needed role and a matching `gh` entry whose scope covers it                                                        | name the project: `oidc-project` in the action, `--oidc-project` / `--project` in `sreg`                                 |
| `_:gh.…` fails although an `admin` credential trusts the repository | `_` resolves only credentials with the `read` or `publish` role and an entry scoped to it                                                                           | use a `publish` or `read` credential for CI                                                                              |
| Basic authentication fails with a pasted token                      | the Basic login differs from the project in the pasted token                                                                                                        | use the project as login, or put the whole token in the password and the project in the login                            |
| a token with a `source.` prefix (`okta.project:…`)                  | external credential providers are not implemented yet                                                                                                               | use a credential stored in the registry                                                                                  |
| a change to a credential seems to be ignored                        | credentials are cached for up to 60 seconds per Worker isolate, and KV takes up to a minute to propagate                                                            | wait a minute                                                                                                            |

### `426 client_too_old` (exit code `3`)

The Worker requires a newer `sreg` than the one that sent the request; the message names the
minimum version. Update `sreg`, or the action (`@v1` picks up each new stable `sreg` release
through a release of the action; a pinned `sreg-version` or full release tag must be raised).
`sreg version --registry <url>` shows the registry's version and the minimum client version
it accepts.

### The update check shows nothing or fails

Unless `CHECK_UPDATES` is set to `false`, the Settings page asks `https://api.github.com` for
the latest release at most once a day and caches a failure for an hour. It first reads the
redirect of `https://github.com/<owner>/<repo>/releases/latest`, which has no API rate limit,
and only then falls back to the API. The Worker needs outbound access to `github.com` and
`api.github.com` for this, and `api.github.com` for the **Look up** button for repository
IDs. GitHub limits anonymous API calls per IP address, and Workers share their outbound
addresses, so the API alone can fail; the reason of each failed attempt is logged
(`npx wrangler tail`) and the check is retried after the hour. To see the full error without
logs, click **Check now** on the Settings page: it ignores the cache, asks GitHub right away
and lists the error of each attempt. Set
`CHECK_UPDATES=false` to turn the check off. GitHub Actions OIDC verification separately fetches GitHub's signing keys from
`token.actions.githubusercontent.com`.

### Other errors

- `413 payload_too_large` when publishing: a file is larger than `MAX_UPLOAD_BYTES`.
- `409 version_exists`: versions are immutable. Publish a new version, or pass
  `--skip-existing` (the action's default) to make re-runs succeed.
- `500` "Data migration failed; try again later.": a migration could not finish (usually a
  temporary KV error). The next request retries it; check the logs if it persists.

**Migration 3 on a large registry.** Migration 3 builds the dependency graphs
`_meta/deps/<eco>.json` by reading every version manifest in the bucket within the single
request that runs the migrations. A Worker request may make only a limited number of calls to
R2, so on a registry with more than roughly a thousand versions the migration can fail with
the `500` above on every attempt. Run the upgrade while the bucket holds fewer manifests – for
example deploy it before importing a large backup, or temporarily move the `<eco>/pkg/`
prefixes of rarely used ecosystems aside, let one request migrate, move them back and run
**Reindex** for their packages – or open a support issue in the Worker's repository.
