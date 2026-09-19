---
name: maintaining-dependencies
description: Judgment for keeping a pnpm workspace's dependencies patched and current without a person in the loop — how to fix a transitive advisory, when an override is a lie, why cooldown does not apply to security patches, how to read a red Dependabot PR by its failure signature, and what a CodeQL alert needs before it may be dismissed. Use when running /app:upgrade, fixing a dependency advisory, diagnosing a red Dependabot PR, or deciding whether a bump is safe to land unattended.
user-invocable: false
---

# Maintaining Dependencies

`/app:upgrade` is the procedure; this is the reasoning it leans on. Read it
before the first lane, and come back to the signature table the moment a
dependency PR goes red.

## Core principle: three files, one truth

A pnpm workspace states its dependencies in three places, and they disagree
silently:

| File                  | What it is                | Who may be lying                           |
| --------------------- | ------------------------- | ------------------------------------------ |
| every `package.json`  | a **claim** about a range | any spec an override rewrites              |
| root `pnpm.overrides` | a **rewrite** of claims   | any entry whose reason is gone             |
| `pnpm-lock.yaml`      | the **truth** — what runs | never, but it only tells you what, not why |

Plus the ledger, `contributing/dependency-overrides.md`, which is where the
_why_ lives because `package.json` is strict JSON and cannot carry a comment.

Every change keeps all four consistent **in one commit**. A bump that moves a
spec but not the override that masks it changed nothing and now lies. An
override that moves without its ledger entry outlives its reason. The
override-masking check — for every touched override, every workspace spec
naming that package is at or below its floor — is not optional, it is the
difference between a bump and a claim.

## Direct or transitive — the first question for any advisory

```bash
pnpm why <package>                                             # paths from workspace packages
grep -oE "^  /?<package>@[0-9][0-9.]*" pnpm-lock.yaml | sort -uV   # every resolved line
```

**Direct** (a workspace `package.json` declares it): bump the spec in every
declaring package, keeping the dep type and range style the file uses. No
override — a redundant override duplicates a spec the repo already declares
and hides the next bump (ledger rule 2).

**Transitive** (only reached through something we depend on): an override in
the root `package.json`. Reach for it only when no direct bump clears the
finding — if the parent has shipped a version that resolves past the
advisory, bump the parent instead (ledger rule 1).

**Scope the override to the major line that exists.** When the lockfile holds
both `js-yaml@3` (for `gray-matter`) and `js-yaml@4`, a bare `js-yaml`
override forces one version on both and breaks the consumer that needed the
other line. Write `js-yaml@3` and `js-yaml@4` as separate entries. The same
holds for 0.x lines — `fflate@0.4` beside an untouched `fflate@0.8`. After
the relock, list the resolved lines again: the vulnerable one is gone and
every other line is still there.

**Raise the floor to the patched version, not to a range that admits it.**
`hono: ^4.12.34` allowed 4.13.5 and the lockfile stayed on vulnerable 4.13.4
for nine days, because nothing asked for a re-resolve. pnpm records the
overrides block in the lockfile; a changed override is what forces
`pnpm install` to re-resolve the affected package. An unchanged override
forces nothing.

**Never `pnpm audit --fix`.** It writes blanket, unscoped overrides — the
exact shape the previous paragraph forbids — and it does not touch the ledger.

**Drop a transient pin when the parent moves past it.** The check: remove the
entry, `pnpm install --lockfile-only`, and if the resolved version is still at
or above the patched one, the parent's own range now carries the fix and the
pin is redundant. Ledger rule 2 applies in reverse: a pin that does nothing
will fight the next bump.

## Cooldown: features wait, fixes do not

The 21-day cooldown is supply-chain hygiene for **feature** bumps — a
compromised release is usually pulled within days, and a feature can wait
three weeks at no cost.

A **security patch inside the current line** is the opposite trade: waiting
keeps a known hole open for the sake of a hypothetical one. It moves on day
zero. The two HIGH `js-yaml` advisories sat for a week because a run applied
cooldown to a CVE fix; do not repeat that.

A fix that needs a **major** is neither: it is a migration with a security
motive, and it goes to the majors ticket with "security" as the first row of
its decision table.

## What never lands unattended

Not "usually not" — never, under `auto`, regardless of how safe it looks:

- **A major version.** Behaviour changes; the decision needs a person and a
  migration guide, and the guide is wrong about one thing per package.
- **A runtime-SDK family** (`@anthropic-ai/claude-agent-sdk*`,
  `@anthropic-ai/sdk`, `@openai/codex*`, `@opencode-ai/*`). Each sits behind an
  adapter boundary and moves in seven places in one commit through the
  `upgrading-runtime-dependencies` skill. A bump of half a family breaks the
  packaged desktop app (DOR-1644).
- **A family edit to `.github/dependabot.yml`.** Version-scoped ignores for a
  known-bad version are fine; adding, removing or narrowing a family pattern
  is not — the lockstep test exists because that went wrong once.
- **A secret-scanning alert.** Not dismissed, not rotated. Headline and stop.
- **The merge itself.** A PR is the unit of blast radius; the queue and the
  automated review are the gate.
- **`pnpm audit --fix`, `git checkout -- <path>`, `git stash`.** The first
  writes unscoped overrides; the other two are blocked by the git guard
  because they have destroyed work here.

## Reading a red Dependabot PR

Dependabot never diagnoses. The next weekly run force-pushes a larger version
of the same failure, so a red group PR stays red until someone reads it.
Read the signature before the diff — in this repo the cause is almost always
one of these, and the fix is different for each:

| Signature in the failing job                                                                                                                                                  | What it is                                                                                                                                   | Fix                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` on **every** job                                                                                                                          | Dependabot regenerated the lockfile without the `overrides:` block (DOR-1644)                                                                | `dependabot-lockfile-repair.yml` pushes the fix; if its commit is absent the workflow failed; check the `dorkos-merge-tail` app secrets `MERGE_TAIL_APP_CLIENT_ID` and `MERGE_TAIL_APP_PRIVATE_KEY`. On a takeover branch a plain `pnpm install` repairs it. |
| A spec bumped in the diff, lockfile still resolves the **old** version                                                                                                        | **Override masking** — a dedupe override (`lucide-react`, `@vitejs/plugin-react`, `drizzle-orm`, `eslint-plugin-react-hooks`) pins it        | Move the override to the bumped version in the same commit, or revert the spec. #1847 shipped `lucide-react 1.44.0` in three manifests over a lockfile still on 1.39.0.                                                                                      |
| `TS7056: The inferred type of this node exceeds the maximum length…` in `apps/server/src/services/core/auth/index.ts`, or `BetterAuthError: Drizzle schema mismatch` in tests | **Duplicated peer instance** — two copies of `@better-auth/core` / `@better-auth/utils` / `jose` after a `better-auth` bump (DOR-1538 shape) | Hold `better-auth` + `@better-auth/api-key` at the last good exact version; ledger has the drop condition. `better-auth 1.7.4` did this on #1847.                                                                                                            |
| `'error' is of type 'unknown'` across `route-error-fallback.tsx`                                                                                                              | `@tanstack/react-router` narrowed its error type                                                                                             | Fix the call sites (narrow with `instanceof Error`, matching `app-crash-fallback.tsx`); check `main` for a fix PR already in flight before writing one                                                                                                       |
| A wall of type errors in a package that imports **neither** bumped package                                                                                                    | Duplicated peer instance, generic form                                                                                                       | `grep -oE "^  <suspect>@[0-9.]+" pnpm-lock.yaml \| sort -u` for each peer the failing package declares; two versions = the fork                                                                                                                              |
| Only the load-sensitive suites red; rerun passes                                                                                                                              | Contention on the shared runner, not a defect                                                                                                | `gh run rerun --failed` once and believe the second result. The `debugging-test-failures` skill names the suites that flake under load.                                                                                                                      |
| `Dependabot Updates` run red, but the group PR opened anyway                                                                                                                  | One dependency skipped (`HelperSubprocessFailed`, often `minimumReleaseAge` refusing a 2-day-old version)                                    | Cosmetic. Nothing to do.                                                                                                                                                                                                                                     |
| `Dependabot Updates` run red on a `for <package>` security job: "latest possible version … is `<current>`"                                                                    | The package is transitive; Dependabot cannot write a pnpm override                                                                           | Structural. Lane 1 of `/app:upgrade` is the only fix; the run will stay red until the advisory closes.                                                                                                                                                       |

**Peel, don't patch.** On a takeover branch, revert the culprit's spec lines
and relock; do not fix the culprit's breakage inside a 37-package bump. The
green remainder lands today; the culprit gets a hold, a version-scoped
Dependabot ignore, and a ticket with the signature. Two rounds of peeling is
the budget — past that, the suspect list goes in the ticket and the lane
stops.

## The ledger

`contributing/dependency-overrides.md` has three sections and each override
or hold belongs to exactly one:

- **Deliberate pins** — the version is a decision (runtime SDKs, dedupes,
  the Node line). These move only through a deliberate bump.
- **Transient security pins** — an unpatched advisory reachable through a
  dependency we do not control. Listed by name; dropped when the parent moves.
- **Version holds that are not overrides** — exact specs in each declaring
  `package.json` (`better-auth`, `@a2a-js/sdk`), each with a failure
  signature and a drop condition.

A run that adds an override adds the name to the second list. A run that
holds a culprit writes a subsection in the third, in the shape the existing
ones use: what breaks, the PR that showed it, why not a middle version, the
exact recipe to re-test, and the drop condition. A ledger entry without a
drop condition is a pin forever.

## CodeQL alerts: the evidence bar

An alert is a claim about a code path. Dismissing it is a counter-claim, and
the counter-claim needs a line of code:

- **`used in tests`** — the path is under `__tests__/`, is a `*.test.ts`, or
  is in `apps/e2e/`, and the rule is about production exposure
  (`js/missing-rate-limiting` on a test's express app is the common one).
  The file path is the evidence; quote it.
- **`false positive`** — the input is bounded before it reaches the sink, and
  you can name the line: the allowlist, the `path.resolve` + prefix check,
  the length cap before the regex. Quote that line in the dismissal comment.
  No line, no dismissal — file a ticket instead.
- **`won't fix`** — never from an unattended run. That is a product decision.

A **fix** from an unattended run is allowed when it is confined to one
function, ships a regression test that fails before and passes after, and is
one of at most two fix PRs in the run. `js/path-injection` in a handler that
joins user input into a filesystem path usually qualifies (resolve, then
assert the prefix). `js/tainted-format-string` where the taint is a log
message usually qualifies (pass the value as an argument, not in the format
string). `js/polynomial-redos` usually does **not** — the fix is a different
regex, and a different regex is a behaviour change that needs a reviewer who
knows the inputs. Ticket it with the rule help attached.

## When the daily run should do nothing

- `main`'s typecheck is red. A dependency PR cannot be told apart from the
  pre-existing failure; nothing can be validated. Report and stop.
- A secret-scanning alert is open. Nothing else matters until it is closed.
- An earlier run's PR for the same lane is open. Tend it; never open a twin.
- The merge queue is non-empty and the lane's PR is `CLEAN`. Leave arming to
  `merge-tail`; an entry armed into a busy ALLGREEN queue is the one most
  likely to be ejected for a neighbour's red.

Doing nothing and saying so is a successful run. Skipping a lane and printing
a clean summary is the one failure this skill exists to prevent.
