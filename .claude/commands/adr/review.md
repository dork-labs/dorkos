---
description: Review proposed ADRs for lifecycle progression — accept implemented decisions, deprecate stale ones, archive trivial ones
argument-hint: '[spec-slug | ADR-number | --all]'
allowed-tools: Read, Write, Edit, Grep, Glob, AskUserQuestion
category: documentation
---

# Review ADRs for Lifecycle Progression

**Argument:** $ARGUMENTS

---

## Purpose

Move ADRs past the "proposed" stage. The `/adr:curate` command handles draft → proposed. This command handles the rest of the lifecycle: proposed → accepted | deprecated | superseded | archived.

**When to run:**

- After completing a spec implementation
- When the proposed ADR count exceeds 50
- Periodically (monthly) for general maintenance
- When a SessionStart hook suggests it

---

## Steps

### Step 1: Determine Scope

Parse `$ARGUMENTS` to decide what to review:

| Argument                                 | Scope                         |
| ---------------------------------------- | ----------------------------- |
| `--all` or empty                         | All proposed ADRs             |
| A spec slug (e.g., `relay-core-library`) | Only ADRs linked to that spec |
| An ADR number (e.g., `43` or `0043`)     | Single ADR                    |

### Step 2: Load Context

1. Read `decisions/manifest.json` — filter for proposed ADRs matching scope
2. Read `specs/manifest.json` — get spec statuses for cross-referencing
3. If reviewing all, group proposed ADRs by `specSlug`

### Step 3: Evaluate Each ADR (or Group)

For each proposed ADR, apply these checks **in order** (first match wins):

#### Check A: Is the linked spec implemented?

If the ADR has a `specSlug` and that spec's status is `implemented` or `completed` in the spec manifest:

- **Verify the decision is reflected in code** — do a quick grep/glob for the pattern or technology described in the ADR
- If confirmed: **Recommend → accepted**
- If the code diverged from the decision: **Recommend → deprecated** (note what actually happened)

#### Check B: Is the linked spec abandoned?

If the spec is still `ideation` and was created more than 30 days ago, OR the spec slug doesn't exist in the spec manifest:

- **Recommend → archived** (decision was never applied)

#### Check C: Was the ADR superseded?

Search the manifest for newer ADRs with similar titles or the same `specSlug` that might replace this one:

- If found: **Recommend → superseded** (link the newer ADR via `superseded-by`)

#### Check D: Is this now obvious?

Apply the "would surprise a new team member" test from the `writing-adrs` skill. Decisions that describe patterns now deeply embedded in the codebase (and visible from reading the code) no longer need an ADR:

- **Recommend → archived**

#### Check E: Still legitimately proposed

If the linked spec is `specified` (in progress) or recently created:

- **Recommend → keep as proposed** (too early to judge)

### Step 4: Present Recommendations in Batches

Group recommendations by spec and present as a table:

```
## ADR Review Recommendations

### relay-core-library (spec: implemented 2026-03-01)

| ADR | Title | Recommendation | Reason |
|-----|-------|---------------|--------|
| 0011 | Use NATS-Style Hierarchical Subject Matching | **Accept** | Pattern is in `packages/relay/src/subject-matcher.ts` |
| 0012 | Use ULID for Relay Message IDs | **Accept** | ULIDs used throughout relay package |
| 0013 | Use Hybrid Maildir + SQLite for Relay Storage | **Deprecate** | Maildir was later dropped (ADR-0010 deprecated) |

### dashboard-home-route (spec: implemented 2026-03-18)

| ADR | Title | Recommendation | Reason |
|-----|-------|---------------|--------|
| 0154 | ... | **Accept** | ... |

### Summary: 12 accept, 3 deprecate, 5 archive, 8 keep proposed
```

### Step 5: Confirm with User

Ask the user to confirm each batch using AskUserQuestion:

```
Review batch for "relay-core-library" — accept 0011/0012, deprecate 0013?
Options:
  - Approve all recommendations
  - Approve with changes (I'll specify)
  - Skip this batch
```

If reviewing a single ADR or spec, ask once. If reviewing all, ask per-spec-group to avoid overwhelming decision fatigue.

### Step 6: Apply Changes

For each confirmed change:

#### Accept (proposed → accepted)

1. Edit the ADR file: change frontmatter `status: proposed` to `status: accepted`
2. Edit the Status section in the body: change "Proposed" to "Accepted"
3. Update `decisions/manifest.json`: change the entry's status to `"accepted"`

#### Deprecate (proposed → deprecated)

1. Edit the ADR file: change frontmatter `status: proposed` to `status: deprecated`
2. Edit the Status section: change to "Deprecated — [brief reason]"
3. Update `decisions/manifest.json`: change the entry's status to `"deprecated"`

#### Supersede (proposed → superseded)

1. Edit the ADR file: change frontmatter `status: proposed` to `status: superseded`, set `superseded-by: NNNN`
2. Edit the Status section: change to "Superseded by [ADR-NNNN](../decisions/NNNN-slug.md)"
3. Update `decisions/manifest.json`: change status, add `supersededBy` field

#### Archive (proposed → archived)

1. Move file: `mv decisions/NNNN-slug.md decisions/archive/NNNN-slug.md`
2. Remove entry from `decisions/manifest.json`

### Step 7: Update Timestamp

Write the current ISO timestamp to `decisions/.last-reviewed`:

```bash
date -u +"%Y-%m-%dT%H:%M:%SZ" > decisions/.last-reviewed
```

### Step 8: Display Summary

```
ADR Review Complete

  Accepted:
    - 0011: Use NATS-Style Hierarchical Subject Matching
    - 0012: Use ULID for Relay Message IDs

  Deprecated:
    - 0013: Use Hybrid Maildir + SQLite for Relay Storage (Maildir approach abandoned)

  Archived:
    - 0049: Extract Manifest IO to Shared Package → decisions/archive/

  Superseded:
    - 0027: Use MessageReceiver Bridge → superseded by 0029

  Kept as Proposed:
    - 0195: Hybrid Agent UI Control (spec still in progress)

  Summary: 2 accepted, 1 deprecated, 1 archived, 1 superseded, 1 kept
  Proposed backlog: 134 → 131
```

---

## Cross-Reference Safety

Before archiving or deprecating any ADR, check if it's referenced elsewhere:

```
grep -r "ADR-NNNN\|decisions/NNNN" .claude/ contributing/ CLAUDE.md
```

If the ADR is referenced in rules, guides, or CLAUDE.md:

- **Do NOT archive** — these are load-bearing ADRs
- If deprecating, update the referencing files to note the deprecation
- Flag to the user: "ADR-NNNN is referenced in [file] — special handling needed"

The following ADRs are known to be referenced outside `decisions/` and `specs/`:

- **ADR-0005** — `.claude/skills/receiving-code-review/SKILL.md`
- **ADR-0030** — `contributing/relay-adapters.md`
- **ADR-0043** — `CLAUDE.md`, `.claude/rules/agent-storage.md`
- **ADR-0107** — `contributing/design-system.md`
- **ADR-0117** — `.claude/commands/chat/self-test.md`

---

## Notes

- Run `/adr:list` first to see the current state before reviewing
- This command complements `/adr:curate` — curate handles drafts, review handles proposed
- Aim for the proposed count to stay under 50 after each review
- When reviewing `--all`, process oldest ADRs first (they're most likely to need progression)
- The hook `adr-acceptance-check.sh` will remind you to run this after spec implementation
