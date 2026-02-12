# Autonomous Roadmap Execution

> **Novel Feature**: This system enables Claude Code to autonomously execute entire development workflows from ideation to release, with human oversight at strategic checkpoints.

## Quick Reference

| Command | Purpose |
|---------|---------|
| `/roadmap:next` | Intelligently select the next item to work on |
| `/roadmap:work <id>` | Execute full development lifecycle autonomously |

## Overview

The Autonomous Roadmap Execution system transforms Claude Code from a reactive assistant into a proactive development partner. Instead of manually invoking each command in sequence, you can now:

1. Run `/roadmap:next` to get an intelligent recommendation
2. Run `/roadmap:work <id>` and let Claude handle the entire workflow
3. Approve at key checkpoints (after ideation, specification, before release)
4. Come back to a completed feature ready for release

### The "Ralph Wiggum Loop"

Named after the Simpsons character who famously said "I'm in danger," this pattern keeps Claude working until the job is done:

```
┌─────────────────────────────────────────────────────────────┐
│                    STOP HOOK                                │
│                                                             │
│   Claude tries to stop  ──►  Hook checks roadmap.json      │
│                              │                              │
│                              ├─► Active work? ──► Block!    │
│                              │   (exit code 2)              │
│                              │                              │
│                              ├─► PHASE_COMPLETE? ──► Allow  │
│                              │   (exit code 0)              │
│                              │                              │
│                              └─► ABORT signal? ──► Allow    │
│                                  (exit code 0)              │
└─────────────────────────────────────────────────────────────┘
```

## Workflow Phases

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ not-started  │────►│   ideating   │────►│  specifying  │
└──────────────┘     └──────────────┘     └──────────────┘
                           │                     │
                     [Human Approval]      [Human Approval]
                           │                     │
                           ▼                     ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  completed   │◄────│  releasing   │◄────│ decomposing  │
└──────────────┘     └──────────────┘     └──────────────┘
       ▲                   │                     │
       │             [Human Approval]            │
       │                   │                     ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  committing  │◄────│   testing    │◄────│implementing  │
└──────────────┘     └──────────────┘     └──────────────┘
                           │
                     [Self-Correction]
                     (max 3 retries)
```

### Phase Details

| Phase | Command | Human Approval | Auto-Retry | Duration |
|-------|---------|----------------|------------|----------|
| ideating | `/ideate --roadmap-id <id>` | After completion | No | 5-15 min |
| specifying | `/ideate-to-spec <path>` | After completion | No | 10-20 min |
| decomposing | `/spec:decompose <path>` | No | Yes | 2-5 min |
| implementing | `/spec:execute <path>` | No (internal loops) | Yes | 15-60 min |
| testing | `pnpm test` | On persistent failure | Yes (3x) | 1-5 min |
| committing | `/git:commit` + `/git:push` | No | Yes | 1-2 min |
| releasing | `/system:release` | Required | No | 2-5 min |

## Commands

### `/roadmap:next`

Analyzes the roadmap and recommends the next item to work on.

**Selection Algorithm:**

1. **Filter eligible items:**
   - Status is `not-started` or `on-hold` (if dependencies now met)
   - Exclude items with unmet dependencies

2. **Sort by priority score:**
   ```
   Score = MoSCoW_weight + TimeHorizon_weight + Health_bonus - Unblock_factor

   MoSCoW:       must-have=1, should-have=2, could-have=3, wont-have=4
   TimeHorizon:  now=1, next=2, later=3
   Health:       at-risk/blocked=0, on-track/off-track=1
   Unblock:      -0.1 per item that depends on this one
   ```

3. **Return top candidate with rationale**

**Example Output:**

```markdown
## Next Roadmap Item

**Selected:** User Authentication System
**ID:** 550e8400-e29b-41d4-a716-446655440004
**Type:** feature | **MoSCoW:** must-have | **Horizon:** now
**Health:** on-track | **Effort:** 5 points

### Rationale
This is the highest priority item because:
1. It's a must-have feature in the "now" horizon
2. It unblocks 3 other items (dashboard, settings, profile)
3. No unmet dependencies

### To start work:
/roadmap:work 550e8400-e29b-41d4-a716-446655440004
```

### `/roadmap:work <id>`

Orchestrates the complete development lifecycle for a roadmap item.

**Arguments:**
- `<id>` — UUID of the roadmap item (from `/roadmap:next` or `/roadmap:show`)

**Behavior:**

1. **Loads item** from `roadmap.json`
2. **Checks current phase** in `workflowState`
3. **Resumes or starts** from the current phase
4. **Executes each phase** with appropriate commands
5. **Pauses for human approval** at checkpoints
6. **Self-corrects** during testing (up to 3 attempts)
7. **Outputs completion signals** for the stop hook

**Human Approval Checkpoints:**

After **ideating**:
```
Ideation Review
The ideation document has been created. How would you like to proceed?

[ ] Approve and continue (Recommended)
[ ] Revise ideation
[ ] Abort
```

After **specifying**:
```
Specification Review
The specification has been created. How would you like to proceed?

[ ] Approve and implement (Recommended)
[ ] Revise specification
[ ] Abort
```

Before **releasing**:
```
Release Decision
Implementation complete and tests passing. Create a release?

[ ] Create release (Recommended)
[ ] Skip release
[ ] Review first
```

## State Tracking

Workflow state is persisted in `roadmap.json` under each item's `workflowState` property:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440004",
  "title": "User Authentication",
  "workflowState": {
    "phase": "implementing",
    "specSlug": "user-authentication",
    "tasksTotal": 12,
    "tasksCompleted": 5,
    "lastSession": "2026-02-01T14:30:00Z",
    "attempts": 0,
    "blockers": []
  }
}
```

### Field Reference

| Field | Type | Description |
|-------|------|-------------|
| `phase` | enum | Current workflow phase |
| `specSlug` | string | Slug of spec directory (`specs/<slug>/`) |
| `tasksTotal` | number | Total tasks from decomposition |
| `tasksCompleted` | number | Tasks marked complete |
| `lastSession` | ISO date | When work was last performed |
| `attempts` | number | Retry attempts for current phase |
| `blockers` | string[] | Issues requiring human intervention |

### Update Script

```bash
# Set phase
python3 roadmap/scripts/update_workflow_state.py <id> phase=implementing

# Multiple fields
python3 roadmap/scripts/update_workflow_state.py <id> phase=testing attempts=0

# Add blockers
python3 roadmap/scripts/update_workflow_state.py <id> 'blockers=["Test failures in auth.test.ts"]'

# Reset state
python3 roadmap/scripts/update_workflow_state.py <id> phase=not-started attempts=0 blockers=[]
```

## Self-Correction

During the testing phase, Claude automatically attempts to fix failing tests:

```
┌─────────────────────────────────────────────────────────────┐
│                   SELF-CORRECTION LOOP                      │
│                                                             │
│   Run tests  ──►  Tests pass?  ──►  Continue to commit      │
│       │                                                     │
│       ▼                                                     │
│   Tests fail  ──►  Analyze failures                         │
│       │                                                     │
│       ▼                                                     │
│   Attempt fix  ──►  Re-run tests                           │
│       │                                                     │
│       │           (max 3 attempts)                          │
│       ▼                                                     │
│   Still failing?  ──►  Document blockers                    │
│                   ──►  Pause for human                      │
│                   ──►  Output ABORT signal                  │
└─────────────────────────────────────────────────────────────┘
```

### Fix Attempt Process

1. **Parse test output** for failure details
2. **Read failing test file** and source file
3. **Identify issue** (implementation bug vs test bug)
4. **Make targeted fix**
5. **Re-run tests**
6. **Repeat** up to 3 times

### When Human Intervention is Needed

After 3 failed attempts, Claude:
1. Documents failures in `workflowState.blockers`
2. Outputs `<promise>ABORT</promise>`
3. Allows the stop hook to release

## Bug Discovery Protocol

When bugs are discovered during testing:

| Complexity | Criteria | Action |
|------------|----------|--------|
| **Trivial** | < 5 min to fix | Fix inline, continue |
| **Small** | < 30 min to fix | Fix inline, continue |
| **Medium** | < 2 hours | Consider adding to roadmap |
| **Large** | > 2 hours | Must add to roadmap |

For medium/large bugs:
```bash
/roadmap:add "Bug: <description>"
# Sets: type=bugfix, moscow=must-have, timeHorizon=now, health=at-risk
```

## Resumability

The workflow is fully resumable. If interrupted (context limit, network issue, user stops):

1. State is preserved in `roadmap.json`
2. Run `/roadmap:work <id>` to resume
3. Picks up from current phase
4. Previous progress (completed tasks, modified files) is intact

**Example:**
```
Session 1: Started implementing, completed 5/12 tasks, interrupted
Session 2: /roadmap:work <id> → Resumes at implementing, 5 tasks done
```

## Stop Hook Configuration

The stop hook is configured in `.claude/hooks-config.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/scripts/hooks/autonomous-check.mjs"
          }
        ]
      }
    ]
  }
}
```

### Completion Signals

| Signal | Meaning | Hook Response |
|--------|---------|---------------|
| `<promise>PHASE_COMPLETE:<phase></promise>` | Phase finished successfully | Allow stop (exit 0) |
| `<promise>ABORT</promise>` | User requested abort | Allow stop (exit 0) |
| (no signal) | Work in progress | Block stop (exit 2) |

### Fail-Open Design

If `roadmap.json` is unreadable (corrupted, missing), the hook allows stop (exit 0) to prevent getting stuck.

## Decision Matrix

### When to Use Autonomous Execution

| Scenario | Recommendation |
|----------|----------------|
| Well-defined feature with clear requirements | ✅ Use `/roadmap:work` |
| Bug fix with known root cause | ✅ Use `/roadmap:work` |
| Exploratory research task | ❌ Use manual commands |
| Quick one-file fix | ❌ Just edit directly |
| Complex refactoring affecting many systems | ⚠️ Use with close oversight |
| First time using the system | ⚠️ Start with a small feature |

### When to Abort

- Requirements changed mid-implementation
- Discovered the approach is fundamentally wrong
- Need to switch to a different priority
- Tests reveal architectural issues

## Anti-Patterns

### ❌ Starting Without Enrichment

```bash
# Bad: Starting work without context
/roadmap:work <id>  # Item has no ideationContext

# Good: Enrich first
/roadmap:enrich <id>
/roadmap:work <id>
```

### ❌ Ignoring Human Checkpoints

The checkpoints exist for a reason. Skipping review after ideation or specification can lead to:
- Building the wrong thing
- Wasted implementation time
- Having to redo work

### ❌ Not Monitoring Progress

While autonomous, you should periodically check:
- `/roadmap:show` to see current status
- The spec files being generated
- The implementation progress

### ❌ Using for Undefined Features

If you don't know what you want to build, autonomous execution will produce something — but maybe not what you need. Use manual ideation first to explore.

## Troubleshooting

### "Work in progress" message but nothing happening

**Cause:** Previous session was interrupted, state shows active phase
**Fix:**
```bash
# Option 1: Resume work
/roadmap:work <id>

# Option 2: Reset state (if you want to start over)
python3 roadmap/scripts/update_workflow_state.py <id> phase=not-started
```

### Tests keep failing after 3 attempts

**Cause:** Issue is too complex for auto-fix
**Fix:**
1. Read the blockers in `workflowState`
2. Fix manually
3. Reset attempts: `python3 roadmap/scripts/update_workflow_state.py <id> attempts=0 blockers=[]`
4. Resume: `/roadmap:work <id>`

### Stop hook not triggering

**Cause:** Hook configuration missing or incorrect
**Fix:** Verify `.claude/hooks-config.json` has the Stop hook configured

### Phase stuck at "implementing"

**Cause:** Background agents may have completed but state wasn't updated
**Fix:**
```bash
# Check task status
TaskList()  # Look for feature tasks

# If all tasks done, manually advance
python3 roadmap/scripts/update_workflow_state.py <id> phase=testing
```

## Integration Points

### With Roadmap Visualization

- Open `/roadmap` in browser to see visual progress
- Items show current `workflowState.phase`
- Click items to see full workflow history

### With Spec Workflow

The autonomous system uses the existing spec commands:
- `/ideate` — Creates `01-ideation.md`
- `/ideate-to-spec` — Creates `02-specification.md`
- `/spec:decompose` — Creates `03-tasks.md`
- `/spec:execute` — Creates `04-implementation.md`

### With Git Workflow

- `/git:commit` — Commits changes with validation
- `/git:push` — Pushes to remote with CI checks
- `/system:release` — Creates version, changelog, tag

## Best Practices

1. **Enrich items before starting** — Better context = better output
2. **Review at checkpoints** — Don't auto-approve blindly
3. **Start with small features** — Learn the workflow before tackling epics
4. **Monitor progress** — Check in periodically
5. **Use abort when needed** — Don't let Claude go down wrong paths
6. **Keep blockers documented** — Helps future sessions

## Example Full Workflow

```bash
# 1. See what's next
/roadmap:next
# → Recommends "Add dark mode toggle"

# 2. Start autonomous work
/roadmap:work 550e8400-e29b-41d4-a716-446655440004

# 3. Claude ideates...
# → "Ideation complete. Approve?"
# [Select: Approve and continue]

# 4. Claude specifies...
# → "Specification complete. Approve?"
# [Select: Approve and implement]

# 5. Claude decomposes, implements, tests...
# (All automatic, may take 20-40 minutes)

# 6. Release decision
# → "Tests passing. Create release?"
# [Select: Create release]

# 7. Done!
# → "Work complete. v1.2.0 released."
```

## Related Documentation

- [CLAUDE.md - Autonomous Workflow Section](/CLAUDE.md)
- [Roadmap Commands](/system/claude-code#roadmap)
- [Spec Workflow](/developer-guides/INDEX.md)
- [Parallel Execution](/developer-guides/11-parallel-execution.md)
