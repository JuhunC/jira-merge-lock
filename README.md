# merge-lock

A GitHub App that blocks pull-request merges until every Jira issue referenced
in the PR's commit messages is done.

## How the lock works

The app scans every commit message in a PR for Jira keys (e.g. `PRJ-123`),
looks up each issue's status in Jira, and posts a check run named
`merge-lock/jira-issue` on the PR's head commit — `failure` while any referenced
issue is not in a done status, `success` otherwise. Organization rulesets whose
name starts with a configurable prefix (`merge-lock` by default) define
*which* repos and branches are locked: the app automatically injects its own
required-check entry (pinned to its app id, so no other app can forge a green
check) into every prefix-matched ruleset. GitHub then refuses the merge while
the check is red.

Two mechanisms keep the verdict current, with different check-run lifecycles:

- **Webhooks** — PR opened/updated/reopened/retargeted, check re-run requested,
  ruleset changed, merge-queue entry: each triggers an immediate re-evaluation.
  Event-triggered evaluations show the check as **in progress** right away and
  complete it with the verdict once the Jira lookup finishes — developers see
  the re-check happening instead of a stale result.
- **Stateless poller** — every `POLL_INTERVAL_SECONDS` (default 300) the app
  re-scans all open PRs in scope, so a Jira-side change (issue closed or
  reopened) flips the lock with no push and no webhook. Background re-checks
  update the verdict silently and only when it changes: writes are deduplicated
  by fingerprint (no in-progress phase), so steady-state cycles are almost pure
  reads.

Both paths fail closed when Jira cannot be consulted: **any evaluation while
Jira is unreachable or rejects the app's credentials fails the check** with an
explanatory message — a Jira outage is always visibly blocking. Verdicts
recover automatically within one poll interval of Jira returning, and the
fingerprint dedupe means an extended outage writes each PR's failure once, not
once per poll cycle.

There is no database; state lives in GitHub's own check runs. Restarts are free.

### Optional second lock: required discussion (`MIN_PR_COMMENTS`)

Set `MIN_PR_COMMENTS=1` (or higher) and the app posts a **second required
check** (named `merge-lock/min-comment` by default, override with
`COMMENT_CHECK_NAME`) that blocks the merge until the PR has at least that many
comments **from someone other than the PR author**. What counts, each once:
PR conversation comments, inline review comments, and reviews with body text
(a bare Approve without text does not). The author's own comments and bot
accounts never count; comments whose author GitHub no longer knows (deleted
accounts) are skipped.

The comment check shares the Jira check's scope: auto-configure injects **both**
required-check contexts into every prefix ruleset while the feature is on, and
removes its own comment-check entry again when it is turned off (a required
context nobody posts would leave PRs permanently unmergeable). It re-evaluates
on comment/review webhooks (created, edited, deleted — so deleting the only
qualifying comment re-locks the PR), on its own check re-run, and every poll
cycle.

> ⚠ **Permissions:** this feature needs the **Issues: read** permission and the
> **Issue comment**, **Pull request review**, and **Pull request review
> comment** events. New registrations from `app.yml` get them automatically;
> for an app registered before v0.5.0, add the permission + events in the app's
> **Permissions & events** settings, then approve the permission request on the
> organization, **before** setting `MIN_PR_COMMENTS > 0`.

## Setup

> **Placeholder used throughout:** `YOUR-DEPLOYMENT-HOST` = the public HTTPS
> hostname your container is served behind. The image lives at
> `ghcr.io/juhunc/jira-merge-lock`.

### 1. Create the GitHub App from the manifest

Use GitHub's [register-an-app-from-a-manifest flow](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app-from-a-manifest)
with [`app.yml`](./app.yml) (edit `YOUR-DEPLOYMENT-HOST` first). The manifest
sets the name, permissions, webhook subscriptions, and URLs in one click; the
exchange hands you the **App ID**, a **private key (PEM)**, and the **webhook
secret** — keep all three for step 3.

Least-privilege note: `organization_administration: write` exists solely for
ruleset auto-configure. See [Hardened mode](#hardened-mode) to drop the writes.

Registering manually instead? Set: repository **Checks: read & write**,
**Pull requests: read**, **Contents: read**, **Issues: read**,
**Merge queues: read** (+ Metadata, preset), and organization
**Administration: read & write** — then subscribe to the events
**Pull request**, **Check run**, **Check suite**, **Repository ruleset**,
**Merge group**, **Issue comment**, **Pull request review**, and
**Pull request review comment**. Event checkboxes appear in the UI only after
the permission gating them is selected: *Repository ruleset* requires
Administration (repo or org) read, *Merge group* requires Merge queues read,
and *Issue comment* requires Issues read.

### 2. Install the app on your organization — on ALL repositories

⚠ **Install on “All repositories”, not “Only select repositories”.**

A prefix-matched ruleset can target repositories by pattern. If such a ruleset
covers a repo the app is *not* installed on, GitHub still requires the
`merge-lock/*` checks there — but nothing can ever post them. Every PR in that
repo becomes **permanently unmergeable**, and the app cannot see the repo to
warn you. Installing on all repositories removes the failure mode entirely;
the app logs a loud warning at auto-configure time if it detects
`repository_selection: selected`.

### 3. Deploy the container

Two equivalent setups — grab the one you prefer from the
[latest release](https://github.com/JuhunC/jira-merge-lock/releases/latest):

**Option A — single file, tweaks inline.** Download
`docker-compose.sample.yml`: every setting lives in the compose file itself
with comments, defaults, and the three required values marked ➊ ➋ ➌. Drop your
App's PEM next to it as `private-key.pem`, fill in the marks, then:

```sh
docker compose -f docker-compose.sample.yml up -d
```

**Option B — compose + env file.** Download `docker-compose.yml` and
`.env.example` (attached as `default.env.example` — GitHub release assets
cannot start with a dot), save the latter as `.env`, fill it in, then:

```sh
docker compose up -d
```

All variables (defaults in parentheses; blank = required):

| Variable | Required | Default | Notes |
|---|---|---|---|
| `APP_ID` | ✓ | — | numeric GitHub App id; also pins the ruleset entry and filters check-run reads |
| `PRIVATE_KEY` / `PRIVATE_KEY_PATH` | one of | — | PEM contents (base64 accepted) or path to a mounted PEM file |
| `WEBHOOK_SECRET` | ✓ | — | from app creation |
| `PORT` | | `3000` | webhooks + `/healthz` + `/readyz` + `/status` + homepage |
| `HOST` | | `0.0.0.0` | listen address; keep the default in containers |
| `PUBLIC_URL` | | — | public HTTPS base URL of this deployment; when set, check runs link to the guidelines page |
| `GHE_HOST` | | — | GitHub Enterprise Server hostname (e.g. `github.yourco.com`); unset = github.com. Register the App **on your GHES instance**, not github.com |
| `GHE_PROTOCOL` | | `https` | protocol for `GHE_HOST` |
| `LOG_LEVEL` | | `info` | `trace`…`silent` |
| `LOG_FORMAT` | | `json` | `pretty` for local dev |
| `JIRA_BASE_URL` | ✓ | — | no trailing slash; also builds `/browse/` links |
| `JIRA_AUTH_METHOD` | ✓ | — | `cloud` \| `pat` \| `basic` |
| `JIRA_EMAIL` + `JIRA_API_TOKEN` | if `cloud` | — | Jira Cloud email + API token |
| `JIRA_PAT` | if `pat` | — | Jira Server/DC 8.14+ personal access token |
| `JIRA_USERNAME` + `JIRA_PASSWORD` | if `basic` | — | legacy Jira Server |
| `GITHUB_TIMEOUT_MS` | | `30000` | per-request timeout for GitHub API calls |
| `JIRA_TIMEOUT_MS` | | `10000` | per-request timeout |
| `JIRA_DONE_STATUSES` | | `Closed,Resolved` | comma list, trimmed, case-insensitive |
| `JIRA_DONE_USE_CATEGORY` | | `false` | `true`: status category `done` also unlocks (rename/locale-proof) |
| `JIRA_KEY_REGEX` | | `[A-Z][A-Z0-9]+-\d+` | word-boundary wrapped |
| `JIRA_PROJECT_KEYS` | | — | allowlist, e.g. `PRJ,OPS`; recommended — kills `UTF-8`/`SHA-256` false positives |
| `REQUIRE_ISSUE_KEY` | | `false` | `true`: zero-key PRs fail instead of passing |
| `MIN_PR_COMMENTS` | | `0` | `>0`: also require N comments from non-authors as a [second check](#optional-second-lock-required-discussion-min_pr_comments); `0` disables |
| `COMMENT_CHECK_NAME` | | `merge-lock/min-comment` | name of the second check run / required status context |
| `RULESET_NAME_PREFIX` | | `merge-lock` | which org rulesets define scope / get auto-configured |
| `RULESET_AUTOCONFIGURE` | | `true` | `false` = never write rulesets ([hardened mode](#hardened-mode)) |
| `CHECK_NAME` | | `merge-lock/jira-issue` | check-run name / required status context |
| `POLL_INTERVAL_SECONDS` | | `300` | open-PR re-scan interval; `0` disables |
| `POLL_CONCURRENCY` | | `5` | repos in flight per installation |

### 4. Expose it over public HTTPS

The compose file binds to `127.0.0.1:3000` on purpose. Put a reverse proxy
(nginx, Caddy, Traefik, …) with a public TLS endpoint in front of it, then set
on the GitHub App's settings page (already correct if you edited `app.yml`
before step 1):

- **Webhook URL** → `https://YOUR-DEPLOYMENT-HOST/api/github/webhooks`
- **Homepage URL** → `https://YOUR-DEPLOYMENT-HOST/` — the app serves its own
  developer-guidelines page there (linked from every check run's output), so a
  developer staring at a locked PR can find out why and how to unlock.

### 5. Create the org rulesets

In **Organization → Settings → Repository → Rulesets**, create branch rulesets
named `merge-lock…` (or your `RULESET_NAME_PREFIX`) targeting the
repositories and branches you want locked — e.g. `merge-lock-main`
targeting `main` across all repos. You do **not** add the required check
yourself: the app injects its required-check entry (pinned to its app id)
automatically on startup, on ruleset events, and at the top of each poll
cycle. It never touches anything else in the ruleset — not other rules, not
other required checks, and **never the enforcement state**: flipping a ruleset
between Disabled/Evaluate/Active stays a deliberate human action.

To exempt a ruleset from auto-configure, rename it off the prefix (the app
then supersedes its stale check with a `skipped` run) or set
`RULESET_AUTOCONFIGURE=false`.

## Operations

### Upgrading from jira-merge-lock (v0.5.x and earlier)

v0.6.0 renamed the app to **merge-lock** and namespaced its checks: the Jira
check default is now `merge-lock/jira-issue` (was `jira-merge-lock`), the
comment check default is `merge-lock/min-comment`, and the
`RULESET_NAME_PREFIX` default is `merge-lock` (was `jira-merge-lock`).

⚠ **Do not upgrade with default config and old rulesets in place.** Rulesets
named `jira-merge-lock*` no longer match the new default prefix, so the app
stops managing them — while they still require the old `jira-merge-lock`
context that nothing posts anymore, leaving every PR under them permanently
unmergeable. Pick one path:

1. **Keep the old names (zero churn):** set `RULESET_NAME_PREFIX=jira-merge-lock`
   and `CHECK_NAME=jira-merge-lock` (plus `COMMENT_CHECK_NAME=jira-merge-lock-comments`
   if the comment gate is on) in your environment, then upgrade. Nothing else
   changes.
2. **Adopt the new names:** rename each `jira-merge-lock*` org ruleset to start
   with `merge-lock` (e.g. `merge-lock-main`), then upgrade. On the next
   startup/poll cycle auto-configure removes the old `jira-merge-lock` entry
   (it is pinned to the app id, so the app may delete it) and injects the new
   contexts; open PRs receive the new checks within one poll cycle. In
   [hardened mode](#hardened-mode) an admin swaps the required-check contexts
   by hand instead.

The GitHub App's **display name** is renamed manually on its settings page
(the manifest only names new registrations), and the container image path is
unchanged: `ghcr.io/juhunc/jira-merge-lock`.

### Run exactly ONE replica

Duplicate pollers double GitHub/Jira rate-limit costs, and concurrent
auto-configure widens the read-modify-write race on org rulesets. Do not scale
the service; one container handles many organizations.

### Log line cheat-sheet

Structured JSON logs; one line per noteworthy event:

| `evt` | Meaning |
|---|---|
| `verdict` | one PR evaluated — `owner, repo, pr, head_sha, trigger, keys, blocking, conclusion, duration_ms`. "Why is my PR locked?" is one grep away. |
| `comment_verdict` | the `MIN_PR_COMMENTS` discussion gate evaluated one PR — `min_required, conclusion, trigger, duration_ms`. |
| `poll_done` | end-of-cycle budget — `installations, rulesets, repos_scanned, repos_pruned, prs, jira_fetches, duration_ms`. A `poll_overrun` warning means raise `POLL_INTERVAL_SECONDS`. |
| `ruleset_autoconfig` | a ruleset was updated — `action: injected` (entry written) or `repinned` (integration id fixed). |
| `installation_coverage_warning` | the installation is on "selected repositories" — prefix rulesets may target repos the app cannot see (see troubleshooting). |
| `jira_degraded` / `jira_auth_failed` | Jira outage / credential failure — every evaluation fails the check (fail closed) until Jira works again; dedupe caps it at one failure write per PR per outage. |

### Status page

`GET /status` (machine-readable: `GET /status.json`) shows live operational
state for users and admins: the configured GitHub API target and Jira base URL,
the outcome of the most recent call to each (connected / failing, with a coarse
failure category), the last webhook delivery received, and the last poll cycle —
when it completed, how long it took, and what it covered (org installations,
discovered `RULESET_NAME_PREFIX*` rulesets, repos scanned, open PRs evaluated,
Jira lookups). The page auto-refreshes every 10 seconds and is linked from the
homepage. Like the homepage it is publicly reachable: it shows the GitHub/Jira
base URLs by design but never credentials or raw error detail (full errors stay
in the logs). Start troubleshooting here before digging into logs.

### Troubleshooting

| Symptom | Check |
|---|---|
| “A PR is locked — why?” | Open the `merge-lock/jira-issue` check run on the PR: its summary table lists every referenced issue, its Jira status, and whether it blocks (with links into Jira). Fix: move the issues to a done status, then hit **Re-run** on the check or wait ≤ `POLL_INTERVAL_SECONDS`. |
| Nothing happens on PRs | Is the app installed on the org (and on **all** repositories)? Does an org ruleset name start with `RULESET_NAME_PREFIX`? Is that ruleset's enforcement **Active** (Disabled/Evaluate rulesets are out of scope by design)? Does it actually target the PR's repo and base branch? |
| Every PR blocked with “Jira unreachable — cannot verify” (or “Jira authentication failed”) | Jira credentials or connectivity: check `/status` (shows the last Jira failure category) or `/readyz`, verify the auth block in `.env`, and for self-signed Jira Server/DC mount your CA and set `NODE_EXTRA_CA_CERTS` (below). Note: this is the designed fail-closed behavior — every evaluation during a Jira outage (or credential failure) fails the check; verdicts recover automatically within one poll interval of Jira coming back, and dedupe writes each PR's failure once per outage, not per cycle. |
| PRs in some repo permanently unmergeable, app logs show nothing for it | Installation-coverage mismatch: a prefix ruleset targets a repo the app is not installed on. Install on **All repositories** (setup step 2). |
| Comment check (`MIN_PR_COMMENTS`) never reacts to new comments, or errors when listing them | The app is missing the **Issues: read** permission or the comment/review event subscriptions (added for v0.5.0). Update the app's **Permissions & events** settings and approve the org's permission request — until then comment webhooks are not delivered and comment listing can 403. The poll cycle is the fallback trigger either way. |
| `poll_cycle_failed` mentions `api.github.com` although `GHE_HOST` is set | The variable is not reaching the container. Check the startup log line `github_api_base` (it states the exact API target), and `docker compose exec merge-lock env \| grep GHE`. Note: `docker-compose.sample.yml` does **not** read `.env` — set `GHE_HOST` in its `environment:` block. With the plain `docker-compose.yml`, put it in `.env`. Restart after changing either. |

### Merge queues

Branches using GitHub merge queues are supported: the app handles
`merge_group.checks_requested` and posts its check on the merge-group head SHA.
Without that, a queue requiring the check would time out forever — so if you
use merge queues, make sure your app grants the **Merge queues: read**
repository permission and subscribes to the `merge_group` event (the
`app.yml` manifest here does both — the permission exists solely to receive
the event; the app never writes to merge queues).

### Self-signed Jira Server/DC certificates

Mount your corporate CA bundle and point Node at it — uncomment in
`docker-compose.yml`:

```yaml
volumes:
  - ./corp-ca.pem:/certs/corp-ca.pem:ro
environment:
  - NODE_EXTRA_CA_CERTS=/certs/corp-ca.pem
```

### Hardened mode

If granting `organization_administration: write` is unacceptable, set
`RULESET_AUTOCONFIGURE=false` and have an org admin add the required check by
hand to each prefix-named ruleset: rule **Require status checks to pass** →
add context `merge-lock/jira-issue` (your `CHECK_NAME`) selecting the
merge-lock app as the source. Scope detection uses only the repo
branch-rules endpoint and needs no org permission, so everything else keeps
working; you may then also remove the org permission from the app.

## Verify a deployment (e2e recipe)

End-to-end smoke test against a sandbox org, using the bundled fake Jira and a
[smee.io](https://smee.io) webhook proxy:

1. Create the app from `app.yml` via the manifest flow in a **test org**;
   install it on a sandbox repo (choose All repositories). For local testing,
   set the app's webhook URL to a fresh smee.io channel.
2. Start the pieces:

   ```sh
   node tools/mock-jira.mjs                # fake Jira on :8089 — PRJ-1 starts "In Progress"
   npx smee -u https://smee.io/YOUR-CHANNEL -t http://localhost:3000/api/github/webhooks
   docker compose up                       # .env: JIRA_BASE_URL=http://host.docker.internal:8089
                                           #       JIRA_AUTH_METHOD=cloud (any creds — the mock ignores auth)
                                           #       POLL_INTERVAL_SECONDS=30
   ```

3. Create an org ruleset `merge-lock-main` (enforcement **Active**, target
   the sandbox repo's `main`, **no rules**). Verify the logs show
   `ruleset_autoconfig action:injected` and the org ruleset UI now shows the
   required check pinned to the app — that's auto-configure working.
4. Open a PR with a commit message `PRJ-1: test` → the check fails and the
   merge button is blocked.
5. Flip the issue: `curl -X POST http://localhost:8089/toggle/PRJ-1` → within
   one poll interval (≤30 s here) the check turns green **with no push** —
   that's the poller working. Toggle again → the PR re-locks.
6. Rename the ruleset off the prefix → on the next event the existing run is
   superseded by a `skipped` run, and the app stops touching that ruleset.
7. Health and homepage: `curl localhost:3000/healthz`, `curl localhost:3000/readyz`,
   then open `http://localhost:3000/` — the guidelines page must show your
   configured done statuses and check name and contain no secrets. Confirm the
   GitHub App's homepage link and the check-run footer link land on it.
8. Status page: open `http://localhost:3000/status` — GitHub and Jira must show
   **connected**, the last poll cycle **succeeded** with a non-zero ruleset
   count, and the page must contain no credentials. Stop the mock Jira and
   re-run a check → the page flips Jira to **failing** and overall to
   **Degraded**; restart mock Jira → it recovers within one poll interval.

## Releasing

1. Tag and publish: `git tag vX.Y.Z && git push --tags`, then create a
   **GitHub Release** for the tag (publishing it triggers
   `.github/workflows/release.yml`).
2. The workflow runs the test suite, then builds and pushes a multi-arch
   (amd64/arm64) image to `ghcr.io/juhunc/jira-merge-lock` tagged `X.Y.Z`,
   `X.Y`, `X`, and a commit-sha tag — consumers pinning the major (`:1`) get
   compatible updates automatically. It also attaches `docker-compose.yml`
   and `.env.example` to the release as the consumer artifacts.
3. **One-time:** make the ghcr package public (Package settings → Danger Zone →
   Change visibility) so consumers can pull without authentication.
