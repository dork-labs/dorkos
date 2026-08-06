---
description: Re-audit accepted ADRs against the codebase — verify each still holds, then amend, supersede, or deprecate the ones that don't
argument-hint: '[N | ADR-id | --all]'
allowed-tools: Read, Write, Edit, Grep, Glob, Bash(node:*), Bash(date:*), Task, AskUserQuestion
category: documentation
---

# Audit Accepted ADRs Against Reality

**Argument:** $ARGUMENTS

---

## Purpose

`/adr:review` moves _proposed_ ADRs to a terminal state; nothing else ever re-examines an
_accepted_ one, so `accepted` silently rots as the codebase moves on (the 2026-08 corpus audit
measured ~39% of accepted ADRs as drifted or obsolete — `research/20260806_adr-corpus-health-and-lifecycle.md`).
This command closes that loop: it verifies accepted ADRs against the current code and makes their
status true again. ADR bodies stay immutable — only statuses, links, Status-section notes, and
manifest metadata change.

**Division of labor (deliberate):** scripts compute the worklist and every mechanical signal;
cheap parallel subagents do the per-ADR code verification; the orchestrating model only
adjudicates contested verdicts and reviews the final diff. Do not read 300 ADRs serially in the
main context.

**When to run:**

- The SessionStart hook reports accepted ADRs unverified in 120+ days
- After a large program lands (renames, architecture shifts)
- Quarterly, as general maintenance

## Steps

### Step 1: Build the worklist

```bash
node .claude/scripts/adr-staleness-scan.mjs --json
```

The `worklist` array is every accepted ADR needing verification, load-bearing first (citation
count descending). Scope by `$ARGUMENTS`:

| Argument     | Scope                                          |
| ------------ | ---------------------------------------------- |
| empty        | Top 12 of the worklist (one comfortable batch) |
| a number `N` | Top N                                          |
| an ADR id    | Just that ADR                                  |
| `--all`      | The whole worklist                             |

Also note the scanner's `staleCitations` output — report it at the end (fixing source comments
that cite superseded ADRs is follow-up work, not part of the audit itself).

### Step 2: Fan out verifier subagents

Batch the scoped worklist ~12 ADRs per subagent and launch the batches **in parallel** (model:
sonnet — this is verification work, not judgment work). Each verifier is read-only and returns,
per ADR:

```
<adr file="decisions/<key>-<slug>.md" verdict="CURRENT|DRIFTED|OBSOLETE|UNVERIFIABLE">
evidence: 1-2 sentences citing the specific files checked and what they showed
contradicted_by: newer ADR id(s) that conflict, or "none"
successor: ADR id that replaces this decision, or "none"
affects: up to 3 path globs this decision governs (from the evidence), or "none"
</adr>
```

Verifier prompt requirements: identify the ADR's concrete claims (named files, packages,
patterns); grep/read the code to check each; search `decisions/manifest.json` for newer ADRs on
the same topic. "Accepted" status is not evidence. A moved file with the decision still governing
is DRIFTED, not OBSOLETE.

### Step 3: Adversarially verify the negatives

Every DRIFTED/OBSOLETE verdict gets one independent refuter subagent (sonnet): "Try to refute
this verdict with code evidence." Refuter disagrees → the orchestrator reads the cited files and
adjudicates itself. CURRENT verdicts skip this — the cost asymmetry is deliberate (a wrong
CURRENT costs one more audit cycle; a wrong OBSOLETE mislabels a live decision).

### Step 4: Apply outcomes

| Verdict                                 | Action                                                                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CURRENT                                 | Stamp `lastVerified: <today>` in the manifest entry. No file edit.                                                                                                                                      |
| DRIFTED                                 | Stamp `lastVerified`. Append a dated one-line note to the ADR's Status section naming what moved (file renames, scope changes). Body otherwise untouched.                                               |
| OBSOLETE, fully replaced by a successor | Old ADR → `status: superseded` + `supersededBy` (manifest + frontmatter + Status section link). Successor's manifest entry gets `supersedes: <old>`.                                                    |
| OBSOLETE, partially replaced            | Old ADR **stays accepted**; the newer ADR gets `amends: <old>` (manifest + frontmatter) and the old Status section names the retired clause. See `writing-adrs` → Partial supersession.                 |
| OBSOLETE, no successor exists           | → `status: deprecated`, with a one-line "what actually happened" in the Status section. If the abandoned decision still deserves a record of _why_, create the successor ADR via `/adr:create` instead. |
| UNVERIFIABLE                            | No stamp, no status change; list it in the summary for a human call.                                                                                                                                    |

Record `affects` globs returned by verifiers into the manifest entries (they scope future audits
and PR-time surfacing).

For batches of status flips, apply manifest changes with a single `node` script rather than
hand-editing JSON 30 times.

### Step 5: Verify the result

```bash
node .claude/scripts/adr-drift-check.mjs        # must stay silent
node .claude/scripts/adr-staleness-scan.mjs     # worklist + stale-citation counts must drop
pnpm vitest run scripts/__tests__/adr-corpus-checks.test.ts
```

### Step 6: Summarize

Report counts per verdict, every status flip with its one-line reason, UNVERIFIABLE items needing
a human call, and the current stale-citation list (as follow-up work). If any flipped ADR is
cited in `AGENTS.md`, `.claude/rules/`, or `contributing/`, flag those files for a doc pass —
`/docs:reconcile` territory.

## Notes

- Batches of ~12 keep each verifier's context small enough for real code-reading; do not exceed ~15.
- `lastVerified` lives **only** in the manifest — never in ADR frontmatter — so audits don't churn
  365 files.
- The scanner already excludes `specs/` and `research/` (historical records may cite superseded
  ADRs freely).
