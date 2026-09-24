---
description: Keep dependencies current and the GitHub security tab clean — CVE fixes through pnpm overrides, red Dependabot PRs taken over, routine bumps landed, CodeQL alerts triaged. Autonomous by default, one PR per lane, asks nothing.
argument-hint: '[check|audit|plan|interactive] [package...] [--lanes=security,dependabot,routine,majors,scanning,pipeline] [--patch|--minor|--major] [--security] [--no-cooldown] [--dry-run]'
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, WebSearch, WebFetch, AskUserQuestion, TodoWrite, PushNotification, mcp__plugin_context7_context7__resolve-library-id, mcp__plugin_context7_context7__query-docs
category: application
---

# Application Upgrade

Dependency maintenance for the whole workspace, built to run **unattended on a
schedule**. A plain `/app:upgrade` reads the GitHub security tab and the local
tree, fixes what a machine can safely fix, opens one small PR per kind of
change, files a ticket for what needs a person, and reports. It asks nothing.

Load the `maintaining-dependencies` skill before Phase 1 — it holds the judgment
this command's steps depend on (direct vs. transitive fixes, override scoping,
cooldown policy, how to read a red Dependabot PR, when a CodeQL alert may be
dismissed). This file is the procedure; the skill is the reasoning.

## Arguments

Parse `$ARGUMENTS`.

### Modes (mutually exclusive)

| Mode          | Effect                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| _(none)_      | **`auto`** — run every lane, open PRs, file tickets, dismiss what the rules allow, report. Never asks.              |
| `check`       | Outdated packages and open alerts, counted by lane. Changes nothing.                                                |
| `audit`       | Security only: Dependabot alerts ∪ `pnpm audit`, code/secret scanning, Dependabot pipeline health. Changes nothing. |
| `plan`        | Everything `auto` would do, printed instead of done. Same as `--dry-run`.                                           |
| `interactive` | The lanes of `auto`, with a question at every decision that changes a PR, a ticket, or an alert. The old default.   |

### Flags

| Flag            | Effect                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `--lanes=a,b`   | Run only these lanes: `security`, `dependabot`, `routine`, `majors`, `scanning`, `pipeline`. Default: all.                |
| `--security`    | Shorthand for `--lanes=security,scanning,pipeline`.                                                                       |
| `--patch`       | Routine lane takes patch bumps only.                                                                                      |
| `--minor`       | Routine lane takes patch + minor (the default).                                                                           |
| `--major`       | Routine lane may also take majors — **`interactive` only**; ignored under `auto` with a line in the report saying so.     |
| `--no-cooldown` | Skip the 21-day cooldown in the routine lane. Security fixes never wait for cooldown, so this flag is not needed there.   |
| `--dry-run`     | Do the reads and the local work, but no push, no PR, no ticket, no dismissal, no comment. Print what would have happened. |
| `[package...]`  | Restrict the security and routine lanes to these packages.                                                                |

### Examples

```bash
/app:upgrade                                  # the daily run
/app:upgrade plan                             # see what the daily run would do
/app:upgrade audit                            # the security picture, read-only
/app:upgrade --security                       # CVEs, scanning, pipeline; skip routine bumps
/app:upgrade --lanes=dependabot               # just take over the red Dependabot PR
/app:upgrade interactive react --major        # guided major bump of the React cluster
/app:upgrade check                            # counts only
```

---

## The autonomous contract

Every rule below holds in `auto` whether or not anyone is watching. They are
what make a scheduled run safe; do not relax one to get a lane through.

1. **Nothing merges here.** Every change lands as a PR that rides the normal
   pipeline — automated review, required checks, merge queue. `merge-tail`
   arms finished PRs; this command arms only when the queue is **empty**
   (below). A PR is the unit of blast radius, so one lane never shares a PR
   with another.
2. **No major bumps, no runtime-SDK families, no `dependabot.yml` family
   edits, no secret-scanning changes.** Those get a plan and a ticket, never a
   commit. The list of families is the `ignore:` block in `.github/dependabot.yml`
   and the "Deliberate pins" table in `contributing/dependency-overrides.md`.
3. **Idempotent by construction.** Each lane owns a branch prefix. Before
   opening a PR, look for an open one under that prefix; if it exists, tend it
   (rebase, re-diagnose, re-arm) instead of opening a second. A run on a quiet
   day changes nothing and says so.
4. **The ledger is edited in the same commit as the override.** Every override
   and every version hold has its reason in `contributing/dependency-overrides.md`.
   A lockfile change that adds, moves, or drops one without touching that file
   is incomplete — a stale ledger is how a pin outlives its reason.
5. **Stop loudly, never quietly.** A red baseline on `main`, a missing
   credential, an open secret-scanning alert, a lane that cannot finish — each
   is a headline in the report and, under `auto`, a `PushNotification`. What
   this command must never do is skip a lane and print a clean summary.
6. **Time-box.** A lane that has not converged after two diagnosis rounds files
   a ticket with what it learned and moves on. The next scheduled run tries
   again with the ticket as context.

---

## Phase 0: Preflight

### 0.1 Where am I

The run needs an isolated tree. `main` in the shared checkout is not it (see
the `working-in-worktrees` skill: the checkpoint hook races other writers).

```bash
git rev-parse --git-dir --git-common-dir       # differ ⇒ already in a worktree
```

If not in a worktree, create the run's own and work there for every lane:

```bash
git gtr new deps/run-$(date +%Y%m%d) --from origin/main --yes
cd "$(git gtr go deps/run-$(date +%Y%m%d))"
```

Lanes branch **from `origin/main`, inside this worktree**, one branch each
(`git checkout -b <lane-branch> origin/main` — the git guard allows branch
checkouts; it blocks `git checkout -- <path>`, so never use that spelling to
discard, use `git reset --hard <sha>` on a branch you own).

Pin the base once and never name the moving ref again:

```bash
BASE=$(git rev-parse origin/main)
```

### 0.2 Read GitHub

All reads go through `gh`; the token needs `repo` (it carries
`security_events` for the dismissals in Lane 5).

```bash
R=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# Dependabot security alerts — the union with `pnpm audit` is Lane 1's input.
gh api "repos/$R/dependabot/alerts?state=open&per_page=100" --paginate

# Code scanning and secret scanning — Lane 5.
gh api "repos/$R/code-scanning/alerts?state=open&per_page=100"
gh api "repos/$R/secret-scanning/alerts?state=open"

# Dependabot's own PRs — Lane 2.
gh pr list --author app/dependabot --state open \
  --json number,title,headRefName,mergeStateStatus,createdAt,labels

# Dependabot pipeline health — Lane 6.
gh run list --workflow "Dependabot Updates" --limit 15 \
  --json databaseId,displayTitle,conclusion,createdAt

# Our own PRs from earlier runs — the idempotency check (rule 3).
gh pr list --state open --search "head:deps/" \
  --json number,title,headRefName,mergeStateStatus,createdAt
```

If `secret-scanning` returns anything open: **stop everything else**, put it
at the top of the report, notify. A leaked credential outranks every bump.

### 0.3 Baseline the tree

```bash
pnpm install --frozen-lockfile        # the lockfile must already be in sync
pnpm typecheck
pnpm audit --json > /tmp/audit-before.json
```

A red `typecheck` on `main` means nothing below can be validated. Stop, report
the failing package, notify. (Under `auto` this is the one case where the
right move is to do nothing — a dependency PR cannot be told apart from the
pre-existing red.)

`pnpm audit` here is the local half of Lane 1's input; GitHub's alert list is
the other half. They disagree at the edges (GitHub sees advisories `pnpm audit`
has not synced; `pnpm audit` sees paths GitHub's graph misses), so take the
union.

### 0.4 Decide the lane list

From the reads above, in this order:

| Lane | Runs when                                                                                           | Branch prefix    |
| ---- | --------------------------------------------------------------------------------------------------- | ---------------- |
| 1    | any open advisory with a patched version                                                            | `deps/security-` |
| 2    | a Dependabot PR is red, `DIRTY`, or older than 3 days without a queue entry                         | `deps/takeover-` |
| 3    | any direct dep has a patch/minor past cooldown that Lane 2's PR does not already carry              | `deps/routine-`  |
| 4    | any major or runtime-SDK drift, or an advisory whose only fix is a major                            | _(ticket only)_  |
| 5    | any open code-scanning alert                                                                        | `fix/codeql-`    |
| 6    | any `Dependabot Updates` failure in the last 7 days, or a Dependabot PR missing its lockfile repair | _(ticket only)_  |

**For `check`**: print the counts per lane and stop.
**For `audit`**: print Lanes 1, 5, 6 in full detail and stop.

---

## Lane 1: Security advisories

Input: the union of Dependabot alerts and `pnpm audit`, keyed by advisory id
(`GHSA-…`) and package. Deduplicate the same advisory across multiple
vulnerable version lines — it is one fix per **line**, not per alert.

### 1.1 Classify each advisory

```bash
pnpm why <package>          # every path from a workspace package to it
grep -oE "^  /?<package>@[0-9][0-9.]*" pnpm-lock.yaml | sort -uV   # every resolved line
```

| Shape                                               | Fix                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| Direct dep, patched version inside the current line | bump the spec in every declaring `package.json`                     |
| Transitive, patched version inside the line         | root `pnpm.overrides` entry (or raise the floor of an existing one) |
| Fix requires crossing a major                       | **Lane 4**: ticket, leave the alert open                            |
| No patched version published                        | ticket once (dedupe on the GHSA id), leave the alert open           |
| Alert on a dev-only or test-only path, no fix       | ticket, and say in it that the exposure is build-time only          |

**Cooldown does not apply here.** A security patch inside the current line is
the one bump whose risk of waiting exceeds its risk of moving. The 21-day
rule is for feature bumps (Lane 3).

**Never `pnpm audit --fix`.** It writes blanket overrides with no per-major
scoping — exactly the shape that broke `gray-matter` back when `js-yaml@3`
and `js-yaml@4` both lived in the tree. Write the override yourself.

### 1.2 Write the fix

For a transitive package, add or move the override in the root
`package.json`, in the **transient security pins** group (the second group of
the map — keep the two groups visually separate):

```jsonc
"pnpm": {
  "overrides": {
    // …deliberate pins above…
    "brace-expansion@1": "^1.1.18", // one entry PER MAJOR LINE that exists in the lockfile
    "brace-expansion@2": "^2.1.4",
    "fflate@0.4": "^0.4.9",     // scope 0.x lines too: a bare `fflate` would drag 0.8.x consumers down
    "hono": "^4.13.5"           // existing entry? raise its floor; a range that merely *admits* the fix does not force it
  }
}
```

Then re-resolve. The lockfile records the overrides block, so a changed
override forces pnpm to re-resolve exactly the affected packages:

```bash
pnpm install                    # NOT --frozen-lockfile: the lockfile is what is changing
```

For a direct package, edit the spec in each declaring workspace `package.json`
(keep the dep type and the range style the file already uses), then
`pnpm install`.

### 1.3 Prove it

```bash
pnpm install --frozen-lockfile                          # the lockfile is in sync again
pnpm audit --json > /tmp/audit-after.json               # the advisory is gone; nothing new appeared
grep -oE "^  /?<package>@[0-9][0-9.]*" pnpm-lock.yaml | sort -uV   # vulnerable line gone, other lines intact
```

And the override-masking check from the traps section: for every override you
touched, every workspace spec that names the same package must be **at or
below** the override's floor, or the spec is now a lie.

### 1.4 Update the ledger

In `contributing/dependency-overrides.md`, add each new package to the
**transient security pins** list, and if you scoped by major, say so in the
"Two shapes worth copying" paragraph. If an existing override moved, no prose
change is needed — the entry already explains why it exists.

### 1.5 Commit and land

One commit, one PR, all advisories together:

```
chore(deps): patch <n> advisories — js-yaml 3.15.2 / 4.3.2, hono 4.13.5, fflate 0.4.9

GHSA-2883-xcg3-v3hh (js-yaml, HIGH ×2), GHSA-gqvv-2mrq-wpjv GHSA-g6gw-c38x-mqfc
GHSA-crvj-82cr-hjcx (hono, MEDIUM ×3), GHSA-px8p-9vwx-vf98 (fflate, MEDIUM).
All transitive; fixed through pnpm.overrides, per-major scoped. Ledger updated.
```

Land it with the shared procedure below. GitHub closes the alerts on its own
once `main`'s lockfile no longer resolves a vulnerable version — do not
dismiss them by hand.

---

## Lane 2: Take over a red Dependabot PR

Dependabot's weekly group PR is the cheapest freshness this repo gets, and
when it goes red it stays red: Dependabot never diagnoses, and the next week's
run just force-pushes a bigger version of the same problem. This lane lands
the green part and quarantines the rest.

Skip the lane when the PR is `CLEAN` and either armed or in the queue — that
is `merge-tail`'s job. A `CLEAN` PR with `autoMergeRequest: null` **and** no
queue entry after 3 days is a PR nobody armed: arm it (empty-queue rule in the
landing procedure) and move on.

### 2.1 Diagnose before touching

Read the failing checks, most specific signature first (the skill has the
full table with the failure it names):

```bash
gh pr checks <n> | grep -vE '\bpass\b'
gh run view <run-id> --log-failed | grep -E '##\[error\]|ERR_PNPM|error TS' | head -40
```

| Signature                                                                  | Diagnosis                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` on every job                           | Dependabot dropped the overrides block and `dependabot-lockfile-repair.yml` has not run (or failed). Check for the `chore: repair pnpm-lock.yaml for Dependabot` commit; if it is missing, Lane 6 owns the workflow question, and this lane repairs by `pnpm install` on the takeover branch. |
| A bumped spec in the diff, but the lockfile still resolves the old version | **Override masking.** A dedupe override pins the package (e.g. `lucide-react`). Move the override with the bump — same version, same commit — or the manifest lies.                                                                                                                           |
| A wall of type errors in one package that names neither bumped package     | **Duplicated peer instance.** Two resolved copies of one transitive dep (the `better-auth` / `jose` shape). Find the fork in the lockfile before reading a single type error.                                                                                                                 |
| Errors inside a file that imports a bumped package                         | That package changed its types. Either fix the call sites (if a sibling already did — check `main` for a fix PR in flight) or hold the package.                                                                                                                                               |
| Only load-sensitive suites red, passing on rerun                           | Contention, not a defect. `gh run rerun --failed <run-id>` once, then believe the second result. The `debugging-test-failures` skill lists the suites that flake under load.                                                                                                                  |

### 2.2 Build the takeover branch

```bash
git checkout -b deps/takeover-$(date +%Y%m%d) origin/main
git cherry-pick <dependabot-commit-sha>          # the "bump the … group" commit, not the repair commit
pnpm install                                     # writes the overrides block back — the repair, for free
pnpm verify                                      # affected typecheck / lint / tests
```

Now peel the culprits, one family at a time, re-running `pnpm verify` after
each: revert the culprit's spec lines in every `package.json` that bumped it
(edit the file, then `pnpm install`), until the branch is green. Two rounds
max (contract rule 6); if it is still red, file the ticket with the
narrowed suspect list and stop the lane.

For each culprit:

- **Hold it** in `contributing/dependency-overrides.md` → "Version holds that
  are not overrides", with the failure signature, the PR that showed it, and
  a drop condition.
- **Stop Dependabot re-proposing it**: on a grouped PR the
  `@dependabot ignore` comments do not apply per package, so add a
  version-scoped ignore to `.github/dependabot.yml` in a clearly separate
  block — one package, one version, one ticket id:

  ```yaml
  # Known-bad versions, held until the ticket named on each entry closes.
  # These are NOT families (see the block above) — one package, one version.
  - dependency-name: 'better-auth'
    versions: ['1.7.4'] # DOR-xxxx: TS7056 in auth/index.ts, duplicated @better-auth/core
  ```

  `scripts/__tests__/dependabot-lockstep-families.test.ts` runs on any change
  to this file; it accepts a version-scoped entry for a non-family package.

- **File a ticket** via the tracker adapter (the `flow__linear-adapter`
  skill): title `Unblock <package> <version> (held by /app:upgrade)`, body =
  failure signature, the Dependabot PR, the drop condition. One ticket per
  culprit, deduped on title.

### 2.3 Land and close

Commit as `chore(deps): land the weekly group bump minus <culprits>`; the body
lists what landed and what was held and why. Land with the shared procedure.

Then close Dependabot's PR with the reason, so the next person reading it does
not re-diagnose:

```bash
gh pr close <n> --comment "Landed via #<takeover-pr> minus <culprits> (held: <ticket ids>; signatures in the PR body). Dependabot will re-propose the rest next week."
```

`--dry-run` and `interactive` stop before the close; `interactive` asks.

---

## Lane 3: Routine freshness

What Dependabot's weekly PR does not cover: direct-dep patch and minor bumps
that cleared cooldown and are not in flight elsewhere.

### 3.1 Candidate list

```bash
pnpm outdated -r --long 2>/dev/null
```

Drop from the list:

- majors (Lane 4), and anything matched by the `ignore:` block of
  `.github/dependabot.yml` (runtime-SDK families — the
  `upgrading-runtime-dependencies` skill owns those);
- anything already bumped in an open Dependabot or `deps/` PR (idempotency);
- anything in the ledger's "Version holds" section, at the held version;
- anything younger than 21 days, unless `--no-cooldown`:

  ```bash
  npm view <package>@<version> time --json | jq -r '.["<version>"]'
  ```

- anything `--patch` / `--minor` / `[package...]` excludes.

What survives is usually small (Dependabot's own cooldown is 3 days, so it
sees most versions first). Small is fine — this lane exists for the weeks
Dependabot's PR is red and Lane 2 had to hold things.

### 3.2 Bump by cluster

Peer clusters move together or not at all:

| Cluster       | Members                                                                             |
| ------------- | ----------------------------------------------------------------------------------- |
| React         | `react`, `react-dom`, `@types/react`, `@types/react-dom`, `@radix-ui/*`             |
| Drizzle       | `drizzle-orm` (root override — move it too), `drizzle-kit`                          |
| TanStack      | `@tanstack/react-query`, `@tanstack/react-query-devtools`, `@tanstack/react-router` |
| Tailwind      | `tailwindcss`, `@tailwindcss/postcss`                                               |
| Vite / Vitest | `vite`, `vitest` — peer-coupled; the majors are blocked (see Lane 4)                |
| Lexical       | `lexical`, `@lexical/*` — exact-version siblings, one bump                          |
| better-auth   | `better-auth`, `@better-auth/api-key` — exact-pinned; read the ledger first         |

Edit specs, `pnpm install`, then the override-masking check for any package
that also has a dedupe override (`lucide-react`, `@vitejs/plugin-react`,
`drizzle-orm`, `eslint-plugin-react-hooks`): move the override to the same
version in the same commit.

### 3.3 Validate and land

`pnpm verify`, then one commit per cluster on one branch
(`chore(deps): bump <cluster> to <version>`), one PR for the lane. A cluster
that fails validation is dropped from the PR, not fixed in it — note it in the
report; Lane 4's ticket picks it up next month if it keeps failing.

---

## Lane 4: Majors and runtime SDKs — plan, never bump

Under `auto` nothing here touches a manifest. The output is one ticket that
stays current.

### 4.1 Gather

- Every major from `pnpm outdated`, with days since release
  (`npm view <pkg>@<latest> time`) and whether the ledger or the
  `upgrading-runtime-dependencies` skill already defers it.
- Every runtime-SDK drift — the three families in
  `.claude/config/runtime-deps.json` — as `current → latest`, with the
  changelog source URL from that file. These go to `/app:runtime-upgrade`,
  never to a bump here.
- Every Lane 1 advisory whose only fix crosses a major, and every advisory
  with no patched version.
- Every cluster Lane 3 dropped for failing validation.

### 4.2 Assess the top three majors (only)

For the three highest-value majors — security fix first, then the oldest
release, then the widest cluster — fetch the migration guide and fill the
decision table. Use Context7, falling back to `WebSearch` for a package it
does not index:

```
mcp__plugin_context7_context7__resolve-library-id: { libraryName: "<package>" }
mcp__plugin_context7_context7__query-docs: { context7CompatibleLibraryID: "<id>", topic: "migration guide v<current> to v<target>" }
```

| Factor               | Favor upgrade                 | Favor delay                  |
| -------------------- | ----------------------------- | ---------------------------- |
| **Security**         | Has CVE fixes                 | No security issues           |
| **Maintenance**      | Old version EOL               | Old version still supported  |
| **Breaking changes** | Minimal, well-documented      | Extensive, poorly documented |
| **Ecosystem**        | Peers support the new version | Peers lag behind             |
| **Cooldown**         | Release >21 days old          | Just released                |

Migration briefs from changelog research average about one factual error per
package — write "per the guide" next to each claimed API change, never "the
API is". The person who picks the ticket up verifies against the installed
`.d.ts`.

Three, not all: each lookup costs a minute and a scheduled run should finish.
The rest are listed with `current → latest` and days-since-release only.

### 4.3 The ticket

One per month, refreshed by every run. Via the tracker adapter:

- search open items titled `Dependency review — <YYYY-MM>`;
- if none, create it (type `chore`, origin `automation`); if one exists,
  replace its description.

Description sections, in order: **Blocked advisories** (fix needs a major or
has no patch), **Runtime SDK drift** (→ `/app:runtime-upgrade`), **Majors
assessed** (the three tables), **Majors listed**, **Held by Lane 2 / dropped
by Lane 3** (with ticket ids). End with the run date.

`interactive` and `--major` unlock the old guided flow for a chosen major:
present the table, ask Proceed / Defer / More information, and on Proceed run
it as a Lane 3 cluster with its own PR and a `docs:` commit updating the
version references in `AGENTS.md` and `contributing/`.

---

## Lane 5: Code scanning and secret scanning

### 5.1 Secret scanning

Never dismissed, never rotated, never "fixed" by this command. If 0.2 found
one open, it is already the report's headline and a notification went out.
Nothing else in this lane runs until it is closed by a person.

### 5.2 Code scanning triage

For each open alert, read the location and the rule:

```bash
gh api "repos/$R/code-scanning/alerts/<n>" -q '{rule:.rule.id,sev:.rule.security_severity_level,path:.most_recent_instance.location.path,line:.most_recent_instance.location.start_line,help:.rule.help}'
```

Then exactly one of four outcomes, in this order of preference:

| Outcome                      | When                                                                                                                                                                      | Action                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Dismiss — used in tests**  | the path is a test file (`__tests__/`, `*.test.ts`, `apps/e2e/`), for a rule about production exposure (`js/missing-rate-limiting`, `js/clear-text-logging`, and friends) | `PATCH …/alerts/<n>` with `state=dismissed`, `dismissed_reason="used in tests"`, and a comment naming the file              |
| **Dismiss — false positive** | you can point at the line that bounds the input (an allowlist, a `path.resolve` + prefix check, a length cap before the regex)                                            | same call, `dismissed_reason="false positive"`, comment quotes that line — no line, no dismissal                            |
| **Fix in a PR**              | the fix is confined to one function, you can write a regression test that fails before and passes after, and the lane has opened fewer than 2 fix PRs this run            | branch `fix/codeql-<n>`, commit `fix(<scope>): …`, land with the shared procedure; the alert closes on the next weekly scan |
| **Ticket**                   | anything else — a fix that touches a public surface, a rule you are not sure about, the third fix of the run                                                              | via the adapter: `CodeQL: <rule> in <path>:<line>`, body = rule help, code excerpt, alert URL; dedupe on the alert URL      |

The evidence bar for a dismissal is a line of code, quoted in the dismissal
comment. "Probably fine" is a ticket.

Alerts whose `most_recent_instance` points at a line that no longer exists on
`main` resolve themselves at the next scan (`codeql.yml`, Mondays 06:30 UTC)
— list them as "stale, will self-close" and do nothing.

---

## Lane 6: Pipeline health

The bots this command leans on fail quietly. Check them.

### 6.1 `Dependabot Updates` failures (last 7 days)

Read each failed run's log and classify:

| Log says                                                                                                  | Meaning                                                                                                                       | Action                                                         |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `The latest possible version of <pkg> that can be installed is <current>` on a `for <pkg>` (security) job | Structural: the package is transitive and Dependabot cannot write a pnpm override. **Lane 1 is the fix.**                     | none — say so in the report, once per package                  |
| `HelperSubprocessFailed` on one package inside a version-update job, and the group PR still opened        | Cosmetic: one dependency skipped (often `minimumReleaseAge` refusing a version younger than 3 days). The PR carries the rest. | none                                                           |
| Anything else, or no group PR opened on a scheduled Monday                                                | The updater is broken                                                                                                         | ticket: `Dependabot updater failing since <date>`, log excerpt |

### 6.2 Lockfile repair

For each open Dependabot PR that touched `pnpm-lock.yaml`, the commit
`chore: repair pnpm-lock.yaml for Dependabot` must be present. If it is not
and `dependabot-lockfile-repair` failed (it cannot mint its `dorkos-merge-tail`
app token when the `MERGE_TAIL_APP_CLIENT_ID` or `MERGE_TAIL_APP_PRIVATE_KEY`
secret is missing or wrong), that is a headline + notification: every
Dependabot PR will be red until a person fixes the secret.

### 6.3 merge-tail

```bash
gh run list --workflow merge-tail --limit 3 --json conclusion,createdAt
```

Three failures in a row means nothing is arming. Headline + notification.

---

## Landing a lane (shared procedure)

Every lane that produced commits goes through this, in this order. It is the
`creating-pull-requests` skill's flow with the dependency-specific gates
added.

```bash
# 1. The lockfile is in sync and the tree is green.
pnpm install --frozen-lockfile
pnpm verify                                   # scripts tests, root lint, affected typecheck/lint/test

# 2. Formatting — the gate that has blocked more dependency PRs than any defect.
pnpm exec prettier --check $(git diff --name-only "$BASE"...HEAD | grep -vE 'pnpm-lock\.yaml$')
#    (pnpm-lock.yaml is in .prettierignore; never format it)

# 3. Changelog gate — chore(deps) mints no fragment, so this is a no-op unless a fix( commit is present.
python3 .claude/scripts/changelog_backfill.py --since "$BASE" --validate --changed-only

# 4. Push and open. Dependency PRs are not user-facing: skip-changelog + review:light.
git push -u origin HEAD
gh pr create --title "<subject of the first commit>" \
  --label skip-changelog --label review:light \
  --body "$(cat <<'EOF'
<what changed and why — the advisory ids, the culprits held, the ticket ids>

## Verification
- pnpm install --frozen-lockfile ✓ · pnpm verify ✓ · pnpm audit: <before> → <after>
- override-masking check: <packages compared> ✓

Opened by /app:upgrade (auto). Ledger: contributing/dependency-overrides.md.
EOF
)"
```

A `fix/codeql-` PR drops `review:light` — it is code, and the automated
review is the point.

### Arming

`merge-tail` arms every finished PR on a 10-minute tick, so arming here is
an optimisation, not a requirement. Do it only into an **empty** queue: the
queue's `ALLGREEN` grouping ejects every entry in a batch when one sibling
fails, with no recorded reason, and a lockfile PR is the entry most likely to
be blamed for a neighbour's red.

```bash
gh api graphql -f query='{ repository(owner:"'"${R%/*}"'",name:"'"${R#*/}"'"){ mergeQueue(branch:"main"){ entries(first:1){ totalCount } } } }' \
  -q '.data.repository.mergeQueue.entries.totalCount'
# 0 → gh pr merge --auto --squash <n>      (the queue ignores --squash; harmless)
# >0 → leave it; say "merge-tail will arm" in the report
```

A PR already in the queue reports `autoMergeRequest: null` — test
`mergeQueueEntry` (GraphQL only) before concluding nothing will merge it.

### Tending an existing PR (idempotency)

When 0.2 found an open PR under the lane's prefix:

- `DIRTY` → rebase onto `origin/main` in the worktree, re-run this procedure,
  `git push --force-with-lease`.
- red → diagnose with the Lane 2 table; the same signatures apply.
- `CLEAN`, unarmed, queue empty → arm.
- `CLEAN`, queued or armed → nothing.

Never open a second PR for the same lane while the first is open.

---

## Report

The last thing the run prints, in this order. Under `auto`, if the first
section is non-empty, also send one `PushNotification` with its first line.

```markdown
## Needs you

- <secret-scanning alert / red baseline / broken updater / three merge-tail failures / a lane that gave up> — one line each, with the link

## Opened

| PR | Lane | State | Armed |
| #1850 chore(deps): patch 6 advisories | security | CLEAN | yes |

## Tickets

- created: DOR-xxxx Unblock better-auth 1.7.4
- refreshed: DOR-yyyy Dependency review — 2026-09

## Alerts

- dismissed (used in tests): #144, #143
- fixed in PR: #142 → #1851
- ticketed: #145, #141
- will self-close: —

## Skipped, and why

- lucide-react 1.44.0: dedupe override moved with it in #1849 (Lane 2)
- @openai/codex-sdk 0.153.4 → 0.154.0: runtime SDK → /app:runtime-upgrade (in DOR-yyyy)

## Pipeline

- Dependabot Updates: 5 failures / 7d — 4 structural (transitive, Lane 1 fixed), 1 cosmetic (knip, minimumReleaseAge)
- lockfile repair: present on #1847 · merge-tail: last 3 green
```

`check` and `audit` print only the sections they computed. `plan` /
`--dry-run` print the same report with every action prefixed `would:`.

---

## Interactive mode

Same lanes, same rules, with `AskUserQuestion` at each of these points and
nowhere else:

1. after Phase 0's lane list — which lanes to run;
2. before closing a Dependabot PR (Lane 2.3);
3. before each major in Lane 4 — Proceed / Defer / More information;
4. before any alert dismissal (Lane 5);
5. before `gh pr create` for each lane — open / open as draft / discard branch.

A `--major` flag without `interactive` is ignored, with a line in the report.

---

## Rollback

The unit of rollback is the PR: `gh pr revert` or `git revert <merge-sha>`
then `pnpm install`. Within a run, a lane branch that went wrong is simply
reset (`git reset --hard "$BASE"` on that branch — you own it) and the lane
reported as skipped. Never rewrite a PR that has been armed; open a follow-up.

Do not use `git checkout main -- package.json pnpm-lock.yaml`: the git guard
blocks the `checkout -- <path>` spelling because it has destroyed uncommitted
work here before. `git show "$BASE":pnpm-lock.yaml > pnpm-lock.yaml` retrieves
a specific version without the discard semantics.

---

## Traps measured on past waves (DOR-1525 2026-08, #1847 2026-09)

- **A range that admits the fix does not force it.** `hono: ^4.12.34` was in
  overrides while the lockfile sat on vulnerable 4.13.4 — the range allowed
  4.13.5 and nothing asked for it. Raise the floor to the patched version;
  that is the only spelling that makes `pnpm install` re-resolve.
- **`pnpm.overrides` rewrite our own workspace specs too.** #1847 bumped
  `lucide-react` to 1.44.0 in three manifests; the `1.39.0` dedupe override
  held the lockfile at 1.39.0 and the manifests lied. Compare lockfile importer
  specifiers against every `package.json` after every relock; move dedupe
  overrides with the bump. Overrides also never reach auto-installed peers,
  and pnpm resolves those to _latest_, not the peer range; fix by declaring
  the dep explicitly in the importing package. The reason for every override
  lives in `contributing/dependency-overrides.md`.
- **A wall of `better-auth`-style type errors mid-bump = a duplicated peer
  instance** (two resolved copies of one transitive dep — a `jose` or
  `@better-auth/core` fork). `TS7056 … exceeds the maximum length the compiler
will serialize` in `auth/index.ts` is that shape's signature. Check for
  duplicate copies in the lockfile before debugging a single type.
- **Cooldown is for features, not fixes.** A 21-day wait on a CVE patch inside
  the current line deferred both HIGH js-yaml advisories for a week. Security
  patches move on day zero; majors wait.
- **Dependabot cannot fix a transitive advisory here.** Its security jobs end
  in "latest possible version … is <current>" and never open a PR, forever.
  Overrides are the only path, and only a local run writes them.
- **Exact-version sibling families move in lockstep** (`lexical` +
  `@lexical/*`, electron-builder's packages); per-entry override pins fight
  the next bump.
- **`pnpm-lock.yaml` needs no formatting step.** It is in `.prettierignore` as
  of DOR-1715; the file `pnpm install` writes is the file CI accepts. A large
  lockfile diff today is a real resolution change worth reading.
- **Migration briefs from changelog research average ~1 factual error per
  package.** Verify claimed API changes against the installed `.d.ts` before
  coding to them.
- **Full-suite runs under multi-agent machine load flake with disjoint
  single-test timeouts each run.** Passing-in-isolation + a clean pre-push
  affected run is the bar; the merge queue is the arbiter. Turbo replays
  `test` cache hits in ~300ms — use `--force` when the run itself is the
  evidence.
- **The ALLGREEN merge queue ejects blameless PRs.** An entry thrown out of a
  batch is still `CLEAN` and reports no reason. Check the neighbours before
  touching the PR; arm into an empty queue.
