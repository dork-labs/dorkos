---
description: Orchestrate the full development lifecycle for a roadmap item
argument-hint: "<item-id>"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, TaskCreate, TaskUpdate, TaskList, TaskGet, Skill, AskUserQuestion
category: roadmap
---

# Roadmap Work

Orchestrate the complete development lifecycle for a roadmap item, from ideation through release.

## Arguments

- `$ARGUMENTS` - The UUID of the roadmap item to work on

## Workflow State Machine

```
not-started → ideating → specifying → decomposing → implementing → testing → committing → releasing → completed
```

### Phase Details

| Phase | Command | Human Approval | Auto-Retry |
|-------|---------|----------------|------------|
| ideating | `/ideate --roadmap-id <id>` | After completion | No |
| specifying | `/ideate-to-spec <path>` | After completion | No |
| decomposing | `/spec:decompose <path>` | No (automatic) | Yes |
| implementing | `/spec:execute <path>` | No (internal loops) | Yes |
| testing | `pnpm test` | On persistent failure | Yes (3x) |
| committing | `/git:commit` + `/git:push` | No | Yes |
| releasing | `/system:release` | Required | No |

## Implementation

### Step 1: Validate and Load Item

```bash
cat roadmap/roadmap.json
```

Find the item with ID matching `$ARGUMENTS`. If not found, exit with error:
```
Error: Item not found: {id}
Please verify the UUID is correct using /roadmap:show or /roadmap:next
```

### Step 2: Determine Current Phase

Check `item.workflowState.phase`:
- If not set or `not-started`, begin with `ideating`
- Otherwise, resume from current phase

Display current state:
```markdown
## Resuming Work

**Item:** {title}
**Current Phase:** {phase}
**Progress:** {tasksCompleted}/{tasksTotal} tasks
**Last Session:** {lastSession}
```

### Step 3: Execute Phase

For each phase, follow this pattern:

1. **Update workflowState.phase** in roadmap.json:
   ```bash
   python3 roadmap/scripts/update_workflow_state.py <id> phase=<phase>
   ```

2. **Execute the phase command** (see Phase Details above)

3. **Handle failures:**
   - Increment `workflowState.attempts`
   - If attempts < 3: Retry with error context
   - If attempts >= 3: Add to `blockers`, pause for human

4. **On success:**
   - Reset attempts to 0
   - Check if human approval needed (ideating, specifying, releasing)
   - If approval needed: Present output and ask user to approve
   - If approved or no approval needed: Advance to next phase

5. **Output completion signal:**
   ```
   <promise>PHASE_COMPLETE:<phase></promise>
   ```

### Step 4: Human Approval Checkpoints

**After `ideating` phase:**

Use AskUserQuestion:
```
header: "Ideation Review"
question: "The ideation document has been created. How would you like to proceed?"
options:
  - label: "Approve and continue (Recommended)"
    description: "Proceed to specification phase"
  - label: "Revise ideation"
    description: "Provide feedback to update the ideation"
  - label: "Abort"
    description: "Stop work on this item"
```

**After `specifying` phase:**

Use AskUserQuestion:
```
header: "Specification Review"
question: "The specification has been created. How would you like to proceed?"
options:
  - label: "Approve and implement (Recommended)"
    description: "Proceed to decompose and implement"
  - label: "Revise specification"
    description: "Provide feedback to update the specification"
  - label: "Abort"
    description: "Stop work on this item"
```

**Before `releasing` phase:**

Use AskUserQuestion:
```
header: "Release Decision"
question: "Implementation complete and tests passing. Create a release?"
options:
  - label: "Create release (Recommended)"
    description: "Run /system:release to create a new version"
  - label: "Skip release"
    description: "Mark as completed without releasing"
  - label: "Review first"
    description: "Let me review the changes before deciding"
```

### Step 5: Completion

When all phases complete:

1. Update status to `completed`:
   ```bash
   python3 roadmap/scripts/update_status.py <id> completed
   python3 roadmap/scripts/update_workflow_state.py <id> phase=completed
   ```

2. Output final summary:
   ```markdown
   ## Work Complete

   **Item:** {title}
   **Phases Completed:** ideating → specifying → decomposing → implementing → testing → committing → completed
   **Spec:** specs/{slug}/
   **Released:** Yes/No

   Run `/roadmap:next` to see the next recommended item.
   ```

3. Output completion signal:
   ```
   <promise>PHASE_COMPLETE:completed</promise>
   ```

## Self-Correction During Testing Phase

After `/spec:execute` completes, run the test suite:

```bash
pnpm test
```

**If tests fail:**

1. Analyze the test output to identify failures
2. Attempt to fix the failing tests (up to 3 attempts)
3. Re-run tests after each fix attempt
4. If still failing after 3 attempts:
   - Document failures in `workflowState.blockers`:
     ```bash
     python3 roadmap/scripts/update_workflow_state.py <id> \
       'blockers=["Test failures after 3 correction attempts"]' \
       attempts=3
     ```
   - Pause for human intervention
   - Output `<promise>ABORT</promise>`

### Test Feedback Loop Details

1. **Run test suite:**
   ```bash
   pnpm test 2>&1 | tee .temp/test-output.txt
   TEST_EXIT_CODE=${PIPESTATUS[0]}
   ```

2. **If tests fail, for each attempt:**
   - Parse test output for failure details
   - Read the failing test file
   - Read the source file being tested
   - Identify issue (implementation bug vs test bug)
   - Make targeted fix
   - Re-run tests

3. **Max 3 attempts before human intervention**

## Bug Discovery Protocol

When a bug is discovered during testing that is too complex to fix inline:

1. **Estimate complexity:**
   - **Trivial** (< 5 min): Fix inline, continue
   - **Small** (< 30 min): Fix inline, continue
   - **Medium** (< 2 hours): Consider adding to roadmap
   - **Large** (> 2 hours): Must add to roadmap

2. **For medium/large bugs:**
   - Use `/roadmap:add "Bug: {description}"`
   - Set: `type: bugfix`, `moscow: must-have`, `timeHorizon: now`, `health: at-risk`
   - If blocking current work: Link as dependency, pause
   - If workaround possible: Continue, note workaround

3. **Output for discovered bugs:**
   ```markdown
   ## Bug Discovered

   **Title:** {bug description}
   **Estimated Complexity:** {trivial/small/medium/large}
   **Blocking:** {yes/no}
   **Roadmap Item Created:** {yes/no - id if created}
   ```

## Error Handling

| Error | Action |
|-------|--------|
| Item not found | Exit with "Item not found: {id}" |
| Phase command fails | Increment attempts, retry with context |
| Max attempts exceeded | Document blockers, output `<promise>ABORT</promise>` |
| Git push fails | Pause for human, provide recovery commands |
| User types "abort" | Output `<promise>ABORT</promise>`, stop work |
| Invalid phase | Reset to last valid phase, report error |

## Resumability

If interrupted, the workflow can be resumed:
1. Run `/roadmap:work <id>` again
2. The command checks `workflowState.phase` and resumes from there
3. All progress is persisted in roadmap.json
4. Previous session context is loaded from spec files

## Cost Controls

| Setting | Value |
|---------|-------|
| Max retry attempts per phase | 3 |
| Max total iterations | 100 |

## Phase Command Reference

| Phase | Command | Notes |
|-------|---------|-------|
| ideating | `/ideate --roadmap-id $ID` | Creates `specs/{slug}/01-ideation.md` |
| specifying | `/ideate-to-spec specs/{slug}/01-ideation.md` | Creates `specs/{slug}/02-specification.md` |
| decomposing | `/spec:decompose specs/{slug}/02-specification.md` | Creates tasks |
| implementing | `/spec:execute specs/{slug}/02-specification.md` | Implements tasks |
| testing | `pnpm test` | Runs test suite |
| committing | `/git:commit` then `/git:push` | Commits and pushes |
| releasing | `/system:release` | Creates release (optional) |
