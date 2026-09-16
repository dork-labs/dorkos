# The public/private boundary guard

`scripts/check-boundary.ts` fails CI when something belonging to the closed-source side of DorkOS Cloud reaches this repository's source or prose. It is the enforcement for the rule `AGENTS.md` states under "## DorkOS Cloud": the control plane is closed-source, and prices, plan names, margins and supplier terms do not belong here.

Run it yourself with `pnpm run check:boundary`. It scans the whole tree in about two seconds.

## What a failure looks like, and why it says so little

```
boundary: mode=shape-only — generic mode, shape patterns only

check-boundary: 1 boundary hit(s):

  docs/self-hosting/deployment.mdx:41  BND-201
```

A finding is `path:line  rule-id`. That is deliberately all of it.

This repository is public, so its Actions logs are world-readable. On the one event the guard exists for — a private term reaching public source — a guard that printed the match would publish that term to a permanent public log, more durably than the paste it caught. So the guard never prints the matched text, and the code cannot: it only ever asks a pattern `test()`, so no matched substring is captured anywhere.

Open the file at the line it names. If the id appears under "Shape rules that fired", the failure message describes it. If it does not, the rule came from the private ruleset — resolve it against that list, or ask an operator.

## The two tiers

**Tier 1 — `scripts/boundary/shape-rules.tsv`, committed here.** Patterns that describe forms rather than secrets, so publishing them leaks nothing. Read that file's header for the block map and for why a local absolute path, the most obvious shape in the guard, is not one of them.

**Tier 2 — the exact term list, never committed here.** It reaches CI as the organisation Actions secret `BOUNDARY_TERMS`, in the same wire format as the tier-1 file, so one loader reads both and the two halves cannot drift.

## Modes and exit codes

Every run prints exactly one mode line, and neither names a term:

- `boundary: mode=shape-only — generic mode, shape patterns only`
- `boundary: mode=shape+terms — private ruleset loaded (N rules)`

Exit `0` clean, `1` findings, `2` the guard could not run. The third matters: with two codes, "the tree is clean" and "the ruleset was empty" would be the same answer.

A pull request from a fork gets no secrets and therefore runs shape-only. That is expected and green.

## If the guard is wrong

Add a scoped entry to `scripts/boundary/allowlist.json`: a `path` substring, the `rules` it covers, and a written `reason`. The file is an audit trail, so the reason has to say why the match is legitimate — an entry with no reason is rejected at load time, as is one whose `path` is empty (an empty path would match every file and silently disable the gate).

**Widen the path, never the rules.** An entry with no `rules` list exempts that path from the private ruleset too, which is almost never what you want.

## Operator setup

Two steps, **in this order**. Reversed, every non-fork pull request and every merge-queue run exits 2 and nothing can merge until the variable is removed again.

1. **Create the organisation secret `BOUNDARY_TERMS`.** Its value is the private ruleset: one rule per line, `<rule-id>` then a **tab** then a POSIX extended regular expression. A leading `#` is a comment, a blank line is ignored, and there is no third column. Patterns are matched case-insensitively, one input line at a time, and should stay inside the ERE subset JavaScript's `RegExp` also accepts — no lookaround, no `\b`. Rule ids are stable and are never reused or renumbered: the guard reports the id and only the id, so an id that changes meaning silently changes what every past failure meant. Blocks `BND-1xx` (local filesystem paths), `BND-4xx` (workspace and repository identifiers) and `BND-9xx` (exact terms) are reserved for this list.

2. **Set the repository or organisation variable `BOUNDARY_TERMS_REQUIRED` to a non-empty value.** This is the declaration that the secret exists. Without it the job runs shape-only; with it, an absent, empty or zero-rule ruleset fails the job instead of quietly downgrading — which is the hazard the switch exists for, because GitHub sets a missing secret to the empty string and emptiness alone cannot tell "this is a fork" from "someone renamed the secret".

Expect the first enforced run to surface a backlog: the tier-2 blocks cover a class of content that has never been guarded. Triage it before setting the variable, not after.

## Where it runs

The `typecheck` workflow, beside the two vocabulary gates, on both `pull_request` and `merge_group` — `typecheck` is already a required check and already reports in the merge queue, and a gate on a non-required check is not a gate. The guard is pinned by `scripts/__tests__/check-boundary.test.ts`, run by `scripts-test.yml`. The split matches `check-vocab-gate.ts`: that step enforces the result, the pin suite proves the mechanism.
