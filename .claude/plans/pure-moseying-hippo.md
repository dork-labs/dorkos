# Plan: Linear Loop System Upgrade

## Context

The Linear Loop system (Phase 1) is architecturally complete but has gaps: no universal input command, no async human-in-the-loop mechanism, a hardcoded project list that requires manual config updates, no persistent next-steps on issues, and zero Phase 2 templates. This upgrade addresses all six gaps in one cohesive change.

## Summary of Changes

| Change                                                | Files                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| Universal intake mode for `/pm`                       | `pm.md`, new `templates/triage-intake.md`                  |
| `needs-input` label + async questions                 | Linear label, `conventions/labels.md`, `SKILL.md`, `pm.md` |
| Ownership-based filtering (replaces `activeProjects`) | `config.json`, `SKILL.md`, `pm.md`                         |
| Next-steps comments convention                        | `SKILL.md`, `pm.md`, `linear/idea.md`                      |
| 4 priority templates                                  | 4 new files in `templates/`                                |
| Empty project detection                               | `SKILL.md`, `pm.md`                                        |
| `/linear:idea` thin wrapper                           | `linear/idea.md`                                           |
| Documentation updates                                 | `AGENTS.md`, `.claude/README.md`                           |

## Implementation Sequence

### Step 1: Create `needs-input` label in Linear

Use `create_issue_label` MCP tool:

- **name:** `needs-input`
- **color:** `#F59E0B` (orange)
- **description:** "Blocked on human input — agent posted a question"
- **parent:** `agent`
- **teamId:** `a171dbd5-3ccc-40ab-b58b-1fae7644fba8`

No file dependencies. Must exist before any code references it.

### Step 2: Update `config.json`

**File:** `.claude/skills/linear-loop/config.json`

Remove `defaultProject` and `activeProjects`. Add `filter.ownership`:

```json
{
  "team": {
    "slug": "dorkos",
    "name": "DorkOS",
    "id": "a171dbd5-3ccc-40ab-b58b-1fae7644fba8",
    "key": "DOR"
  },
  "filter": {
    "ownership": "unassigned"
  },
  "pm": {
    "autoLimit": 5,
    "approvalGates": ["hypothesis-review", "pivot-decision", "project-creation"]
  },
  "relay": {
    "channel": null
  }
}
```

`filter.ownership` values:

- `"unassigned"` (default) — projects with no lead AND issues with no assignee
- `"all"` — everything in the team
- Could also be a user ID for specific-person filtering

### Step 3: Update `conventions/labels.md`

**File:** `.claude/skills/linear-loop/conventions/labels.md`

Add `needs-input` row to Agent State table:

| Label         | Color  | Description                                      |
| ------------- | ------ | ------------------------------------------------ |
| `needs-input` | orange | Blocked on human input — agent posted a question |

Add `needs-input` Protocol section explaining the full flow (post question comment, add label, assign to user, check for responses on next run).

### Step 4: Update `SKILL.md`

**File:** `.claude/skills/linear-loop/SKILL.md`

Updates to existing sections:

- **Configuration section:** Replace `activeProjects` docs with `filter.ownership` docs
- **Label Taxonomy:** Add `needs-input` to agent state list
- **Template Routing table:** Add `triage-intake.md` row, remove Phase 2 note (4 templates now exist)
- **Multiple Projects section:** Replace `activeProjects` reference with ownership filter explanation

New sections to add:

- **Sizing Criteria** — Simple vs complex: simple = single file, <200 LOC, no new patterns; complex = 3+ files, new patterns, architectural decisions
- **Next-Steps Comments** — Convention: after any action, add structured comment with Action, Reasoning, Next steps
- **Async Human Questions (needs-input)** — Full protocol: post question, add label, assign user (triggers notification), check for answers on next SYNC
- **Empty Project Detection** — Flag projects with zero active issues during ASSESS

### Step 5: Create 4 templates

All in `.claude/skills/linear-loop/templates/`:

**5a. `triage-intake.md` — Universal Input Classifier**

- Input parsing (file path detection -> read file; otherwise use raw text)
- Classification rubric: idea, bug/signal, research question, feedback, brief, ambiguous
- Multi-concern detection (brief -> project-creation approval gate -> decompose into typed issues)
- Routing table mapping classification -> issue creation
- Post-creation: add next-steps comment, report created issues

**5b. `triage-idea.md` — Single Idea Evaluation**

- Alignment check against active projects
- Feasibility quick-check
- Duplication search via `list_issues(query: ...)`
- Decision matrix: accept (-> Backlog), reject (-> Cancelled), needs research, needs refinement (-> `needs-input`)
- Post-triage: next-steps comment, recommend next lifecycle stage

**5c. `plan-simple.md` — Hypothesis to Linear Tasks**

- Sizing confirmation (verify this is actually simple)
- Decompose into `type/task` sub-issues (each single-session scope)
- Create as children of hypothesis via `parentId`
- Set up `blockedBy`/`blocks` relations
- Add `agent/ready` to dependency-free tasks
- Update hypothesis to "In Progress"

**5d. `plan-complex.md` — Hypothesis to Spec Workflow**

- Sizing confirmation (verify this is actually complex)
- Trigger `/ideate` with hypothesis as context
- Add `linear-issue: DOR-NNN` to spec frontmatter for traceability
- Keep hypothesis in "In Progress"
- Add next-steps comment with spec directory link

### Step 6: Rewrite `pm.md`

**File:** `.claude/commands/pm.md`

**Frontmatter changes:**

- Add `get_authenticated_user` and `save_project` to `allowed-tools`
- Update `argument-hint` to `[auto | DOR-123 | <text or file path>]`

**Add 4th mode — Freeform Input:**
When argument isn't `auto` and doesn't match `DOR-\d+`:

1. Load `templates/triage-intake.md`
2. Follow classification rubric
3. Create appropriate issue(s)
4. Add next-steps comments
5. Report what was created

**Rewrite SYNC phase — Ownership-based filtering:**

1. Call `get_authenticated_user` once (cache user ID for this run)
2. Read `filter.ownership` from config
3. Call `list_projects(team: "dorkos", includeMembers: true)` — filter by lead matching ownership setting
4. Query issues within filtered projects, also filtered by assignee matching ownership setting
5. **Always query `needs-input` issues regardless of filter** — call `list_issues(team: "dorkos", label: "needs-input")`
6. For `needs-input` issues: call `list_comments` to check for human responses
   - If human commented after agent's question -> queue for processing (remove label, set assignee to null, act on answer)
   - If no response -> add to "Awaiting Your Input" dashboard section
   - Key rule: agent reads these issues but ONLY takes action based on human's actual responses

**Update ASSESS priority order:**

1. Needs-input responses (human answered a question)
2. Overdue monitors
3. Issues in Triage
4. Ready tasks
5. Hypotheses without plans
6. Stale in-progress (>48h)
7. Empty projects (zero active issues)

**Update PRESENT dashboard:**
Add "Awaiting Your Input" section at top (before project groups). Add "Empty Projects" section at bottom.

**Update EXECUTE:**
After any action, add next-steps comment to the issue per SKILL.md convention.

### Step 7: Update `linear/idea.md`

**File:** `.claude/commands/linear/idea.md`

Keep as convenience shortcut but update:

- Add `save_comment` and `get_authenticated_user` to `allowed-tools`
- Add step 4: next-steps comment after issue creation
- Add tip at bottom: "For richer classification (bug reports, briefs, research questions), use `/pm <text>` instead."
- No behavior change — still creates `type/idea` directly, skipping classification

### Step 8: Update `README.md` and `AGENTS.md`

**`.claude/README.md`:** No count changes needed (no new commands or skills added). Verify tables are accurate.

**`AGENTS.md` Linear Workflow section:**

- Update `/pm` description to mention freeform input mode
- Add "Ownership Filtering" subsection explaining `filter.ownership` and how to exclude projects by assigning a lead

## Critical Files

| File                                                    | Action                                     | Risk                                     |
| ------------------------------------------------------- | ------------------------------------------ | ---------------------------------------- |
| `.claude/skills/linear-loop/config.json`                | Modify (remove fields, add filter)         | Medium — grep for `activeProjects` first |
| `.claude/skills/linear-loop/SKILL.md`                   | Modify (6 section updates, 4 new sections) | Low — all additive                       |
| `.claude/skills/linear-loop/conventions/labels.md`      | Modify (add row + section)                 | Low — additive                           |
| `.claude/skills/linear-loop/templates/triage-intake.md` | Create                                     | Low — new file                           |
| `.claude/skills/linear-loop/templates/triage-idea.md`   | Create                                     | Low — new file                           |
| `.claude/skills/linear-loop/templates/plan-simple.md`   | Create                                     | Low — new file                           |
| `.claude/skills/linear-loop/templates/plan-complex.md`  | Create                                     | Low — new file                           |
| `.claude/commands/pm.md`                                | Modify (major rewrite)                     | Medium — largest change                  |
| `.claude/commands/linear/idea.md`                       | Modify (minor)                             | Low                                      |
| `AGENTS.md`                                             | Modify (Linear Workflow section)           | Low                                      |
| `.claude/README.md`                                     | Verify (no count changes expected)         | Low                                      |

## Verification

1. **`/pm`** (no args) — SYNC uses ownership filter, shows dynamic project list
2. **`/pm auto`** — pauses at gates, creates `needs-input` issues assigned to user, adds next-steps comments
3. **`/pm DOR-47`** — unchanged direct-issue behavior
4. **`/pm "We should add dark mode"`** — classifies as idea, creates issue
5. **`/pm .temp/2026-03029-scheduled-tasks.md`** — reads file, classifies as brief, triggers project-creation gate
6. **`/linear:idea "Quick thought"`** — creates idea with next-steps comment
7. **`needs-input` round-trip** — agent posts question + assigns user -> user responds -> next `/pm` detects response, removes label, acts
8. **Empty project** — projects with no issues flagged in dashboard
9. **Ownership filter** — projects with leads don't appear
10. **No stale references** — grep confirms zero hits for `activeProjects` or `defaultProject` in `.claude/`
