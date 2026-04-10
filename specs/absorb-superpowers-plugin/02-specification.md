---
slug: absorb-superpowers-plugin
number: 185
created: 2026-03-26
status: specified
---

# Absorb Superpowers Plugin into DorkOS Harness

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-03-26

---

## 1. Overview

Migrate the best elements of the superpowers plugin (v5.0.6, by Jesse Vincent) into the DorkOS `.claude` harness as first-party skills, agents, commands, and hooks. After migration, the superpowers plugin dependency is removed entirely.

This is not a wholesale copy — it is a selective absorption that preserves superpowers' most valuable techniques (rationalization prevention, TDD enforcement, verification gates, two-stage review, visual companion) while integrating them into DorkOS's existing artifact-driven spec pipeline.

---

## 2. Background / Problem Statement

Three workflow systems coexist without integration:

1. **DorkOS commands** (`/ideate` → `/ideate-to-spec` → `/spec:create` → `/spec:decompose` → `/spec:execute`) — persistent artifacts in `specs/`, manifest tracking, composable pipeline. But weaker ideation quality, loses fidelity of existing work, no visual companion, no TDD enforcement, no pre-completion verification gate.

2. **Superpowers plugin** — better question style (one-at-a-time, multiple-choice), visual companion server, TDD Iron Law, verification-before-completion gate, two-stage review (spec compliance then code quality), rationalization prevention tables. But writes artifacts to wrong location (`docs/superpowers/`), no manifest integration, over-questions obvious decisions, no ADR/doc triggers.

3. **Feature-dev plugin** — good parallel exploration but entirely ephemeral (no artifacts).

Pain points from the user:

- `/ideate` reduces fidelity of existing detailed work (#8)
- Briefs aren't referenced in ideation documents (#9)
- Superpowers brainstorming asks better questions but too many of them (#2, #7)
- Using superpowers or feature-dev bypasses ADR creation and doc updates (#4, #5)
- No TDD enforcement during spec execution
- No verification gate before completion claims

---

## 3. Goals

- Create 4 new first-party skills: `test-driven-development`, `verification-before-completion`, `receiving-code-review`, `visual-companion`
- Create 1 new agent: `code-reviewer`
- Upgrade `/ideate` with maturity detection, brief preservation, improved question style, approach comparison, visual companion reference, and research cache checking
- Upgrade `executing-specs` with TDD enforcement, verification gates, two-stage review, and implementer escalation protocol
- Upgrade `debugging-systematically` with 3-fix architecture questioning rule, condition-based-waiting, and find-polluter script
- Consolidate code review into a proper skill with structured dispatch
- Add completion hooks for auto-ADR extraction on spec creation and spec status auto-progression
- Wire verification-before-completion into `/git:commit` and `/git:push`
- Remove superpowers plugin dependency

---

## 4. Non-Goals

- Absorbing superpowers' `using-superpowers` bootstrap skill (DorkOS has its own harness bootstrap)
- Absorbing superpowers' `writing-plans` artifact format (DorkOS uses `03-tasks.json` + `03-tasks.md`)
- Absorbing superpowers' `finishing-a-development-branch` as a standalone skill (DorkOS's `/git:commit` and `/git:push` cover this)
- Absorbing superpowers' `dispatching-parallel-agents` (DorkOS's `orchestrating-parallel-work` skill is equivalent)
- Absorbing superpowers' `using-git-worktrees` (DorkOS has `/worktree:*` commands)
- Absorbing superpowers' `executing-plans` (DorkOS's `executing-specs` is more sophisticated)
- Absorbing superpowers' `writing-skills` meta-skill (the `skill-creator:skill-creator` plugin handles this)
- Absorbing platform support files (OpenCode, Codex, Gemini, Cursor adapters)
- Absorbing pressure test scenarios (methodology lives in skill-creator, not in this repo)
- Creating an integration layer to catch superpowers artifacts in `docs/superpowers/` (the plugin is being removed, not coexisting)

---

## 5. Technical Dependencies

- No external library dependencies — all skills are markdown files
- Visual companion server is zero-dependency Node.js (RFC 6455 WebSocket from scratch)
- Existing DorkOS harness infrastructure: `.claude/skills/`, `.claude/agents/`, `.claude/commands/`, `.claude/hooks/`, `.claude/settings.json`

---

## 6. Detailed Design

### 6.1 New Skill: `test-driven-development`

**Location:** `.claude/skills/test-driven-development/SKILL.md`
**Supporting files:** `.claude/skills/test-driven-development/testing-anti-patterns.md`

**Source:** Superpowers `skills/test-driven-development/SKILL.md` and `testing-anti-patterns.md`

**What to absorb verbatim:**

- The Iron Law: "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST"
- RED-GREEN-REFACTOR cycle with Good/Bad code examples
- The rationalization prevention table (12 excuses with rebuttals)
- Red flags list
- "Violating the letter of the rules is violating the spirit of the rules"
- Verification checklist
- `testing-anti-patterns.md` (5 anti-patterns with gate functions)

**What to adapt:**

- Replace generic `npm test` commands with `pnpm vitest run` (DorkOS stack)
- Replace `jest.fn()` references with `vi.fn()` (Vitest)
- Add a "DorkOS-specific patterns" section referencing:
  - `@dorkos/test-utils` for `createMockTransport`, `FakeAgentRuntime`, `collectSseEvents`
  - The `testing.md` rule for environment directives, mock Transport patterns
  - The `TransportProvider` wrapper pattern for component tests
- Add cross-reference to `/debug:test` command for test failure debugging
- Replace `superpowers:test-driven-development` self-references with the new skill name

**Frontmatter:**

```yaml
---
name: test-driven-development
description: Use when implementing any feature or bugfix, before writing implementation code — enforces strict RED-GREEN-REFACTOR with failing tests before any production code
---
```

### 6.2 New Skill: `verification-before-completion`

**Location:** `.claude/skills/verification-before-completion/SKILL.md`

**Source:** Superpowers `skills/verification-before-completion/SKILL.md`

**What to absorb verbatim:**

- The Iron Law: "NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE"
- The Gate Function (IDENTIFY → RUN → READ → VERIFY → CLAIM)
- Common Failures matrix (Claim / Requires / Not Sufficient)
- Red Flags list
- Rationalization Prevention table (8 excuses)

**What to adapt:**

- Replace generic examples with DorkOS-specific verification commands:
  - Tests: `pnpm vitest run` or `pnpm test -- --run`
  - Lint: `pnpm lint`
  - Typecheck: `pnpm typecheck`
  - Build: `pnpm build`
- Add reference to DorkOS PostToolUse hooks (format, typecheck, lint, test) that provide automatic verification on file changes — but note these are per-file checks, not comprehensive verification
- Replace "your human partner" language with neutral phrasing

**Frontmatter:**

```yaml
---
name: verification-before-completion
description: Use when about to claim work is complete, fixed, or passing, before committing or creating PRs — requires running verification commands and confirming output before making any success claims
---
```

### 6.3 New Skill: `receiving-code-review`

**Location:** `.claude/skills/receiving-code-review/SKILL.md`

**Source:** Superpowers `skills/receiving-code-review/SKILL.md`

**What to absorb verbatim:**

- The Response Pattern (READ → UNDERSTAND → VERIFY → EVALUATE → RESPOND → IMPLEMENT)
- Forbidden responses ("You're absolutely right!", "Great point!", any gratitude expression)
- YAGNI check for "professional" features
- Source-specific handling (from human partner vs external reviewers)
- Implementation order (blocking → simple → complex)
- When to push back (with technical reasoning)
- Common mistakes table
- GitHub thread reply guidance

**What to adapt:**

- Replace "your human partner" with "the user" throughout
- Add reference to DorkOS's existing `code-quality.md` rule
- Add note about DorkOS convention: push back references ADRs in `decisions/` when architectural decisions are questioned

**Frontmatter:**

```yaml
---
name: receiving-code-review
description: Use when receiving code review feedback, before implementing suggestions — requires technical rigor and verification, not performative agreement or blind implementation
---
```

### 6.4 New Skill: `visual-companion`

**Location:** `.claude/skills/visual-companion/SKILL.md`
**Scripts:** `.claude/skills/visual-companion/scripts/` (5 files)

**Source:** Superpowers `skills/brainstorming/visual-companion.md` and `skills/brainstorming/scripts/`

**Infrastructure files to copy:**

| Source file                   | Destination                                                   | Modifications                                                                           |
| ----------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `scripts/server.cjs`          | `.claude/skills/visual-companion/scripts/server.cjs`          | None — zero-dep, works as-is                                                            |
| `scripts/helper.js`           | `.claude/skills/visual-companion/scripts/helper.js`           | None                                                                                    |
| `scripts/frame-template.html` | `.claude/skills/visual-companion/scripts/frame-template.html` | Update header text from "Brainstorm" to "DorkOS Visual Companion"                       |
| `scripts/start-server.sh`     | `.claude/skills/visual-companion/scripts/start-server.sh`     | Change default session dir from `.superpowers/brainstorm/` to `.dork/visual-companion/` |
| `scripts/stop-server.sh`      | `.claude/skills/visual-companion/scripts/stop-server.sh`      | Match session dir change                                                                |

**SKILL.md content:**

- Standalone skill that any command can reference (not coupled to brainstorming)
- Documents when to use browser vs terminal (from `visual-companion.md`)
- Documents the content loop: write HTML → tell user → read events → iterate
- Documents available CSS classes for options, cards, mockups, split views
- Documents the JSONL events format for reading user selections
- Cross-references: "Used by `/ideate` for architecture visualization and approach comparison"

**Frontmatter:**

```yaml
---
name: visual-companion
description: Use when presenting visual content during brainstorming or design — architecture diagrams, UI mockups, approach comparisons, wireframes. Starts a local browser-based companion for interactive visual feedback.
---
```

### 6.5 New Agent: `code-reviewer`

**Location:** `.claude/agents/code-reviewer.md`

**Source:** Consolidation of:

- Superpowers `agents/code-reviewer.md` (general review persona)
- Superpowers `skills/requesting-code-review/code-reviewer.md` (review template)
- DorkOS `react-tanstack-expert` agent (React review checklist)
- DorkOS `typescript-expert` agent (TypeScript review checklist)

**Design:**

```yaml
---
name: code-reviewer
description: Senior code reviewer for production readiness. Reviews completed work against plans, specs, and coding standards. Dispatched after major tasks, features, or before merge.
model: inherit
---
```

**Agent persona content:**

- Plan alignment analysis (from superpowers)
- Code quality assessment including DorkOS-specific checks:
  - FSD layer violations
  - SDK import confinement
  - `os.homedir()` ban
  - TSDoc on exports
  - Tailwind class sorting
- Architecture and design review (from superpowers)
- Issue categorization: Critical / Important / Minor (from superpowers)
- Review template with placeholders: `{WHAT_WAS_IMPLEMENTED}`, `{PLAN_OR_REQUIREMENTS}`, `{BASE_SHA}`, `{HEAD_SHA}`, `{DESCRIPTION}`
- "Do not trust the report" instruction for spec compliance reviews
- Output format: Strengths → Issues (by severity with file:line) → Recommendations → Assessment (Ready to merge? Yes/No/With fixes)

### 6.6 New Skill: `requesting-code-review`

**Location:** `.claude/skills/requesting-code-review/SKILL.md`

**Source:** Superpowers `skills/requesting-code-review/SKILL.md`

**What to absorb:**

- When to request review (mandatory: after each task in spec execution, after major feature, before merge)
- How to dispatch: get git SHAs, fill template, dispatch `code-reviewer` agent
- How to act on feedback: fix Critical immediately, fix Important before proceeding, note Minor
- Integration with spec execution workflow

**What to adapt:**

- Reference DorkOS's `code-reviewer` agent (not superpowers)
- Reference DorkOS's `/review-recent-work` command as the lightweight alternative
- Add integration guidance for `/spec:execute` batch completion

**Frontmatter:**

```yaml
---
name: requesting-code-review
description: Use when completing tasks, implementing major features, or before merging to verify work meets requirements — dispatches code-reviewer agent with structured context
---
```

### 6.7 Upgrade: `/ideate` Command

**File:** `.claude/commands/ideate.md`

**Changes (in order of insertion point):**

#### 6.7.1 New Step 0: Maturity Detection (before Phase 1)

Insert before Phase 1 as a new "Phase 0: Input Assessment":

```markdown
## Phase 0: Input Assessment

### Step 0.1: Detect Existing Materials

Before creating anything, check if the user provided existing work:

1. If `$ARGUMENTS` contains a file path or the user referenced an existing document:
   - Read the document
   - Classify its maturity:
     - **rough-notes**: Bullet points, stream-of-consciousness, no structure → proceed with normal ideation
     - **partial-spec**: Has requirements, some decisions, but incomplete → skip ideation, fast-track to /ideate-to-spec
     - **detailed-spec**: Has architecture, API design, data models → skip ideation AND spec creation, adapt directly to 02-specification.md format

2. If maturity is `partial-spec` or `detailed-spec`:
   - Create `specs/{slug}/` and update manifest
   - Copy/adapt the document preserving ALL original content (never summarize away detail)
   - Add a "## Source Material" section at the top linking to the original file path
   - Display: "Detected existing [maturity] — preserving full fidelity, skipping redundant phases"
   - For `partial-spec`: suggest `/ideate-to-spec` as next step
   - For `detailed-spec`: write directly as `02-specification.md`, run ADR extraction, suggest `/spec:decompose`

3. If maturity is `rough-notes` or no existing document: proceed to Phase 1
```

#### 6.7.2 Brief Referencing (Step 1.2 enhancement)

Modify Step 1.2 "Echo Intent & Assumptions" to include:

```markdown
### Step 1.2: Echo Intent & Assumptions

Write a quick "Intent & Assumptions" block:

- Restate the task brief in 1-3 sentences
- List explicit assumptions
- List what's explicitly out-of-scope

**If the task brief references or was derived from an existing document (brief, RFC, design doc, research report):**

- Add a "## Source Brief" section to the ideation document
- Include the file path to the original document
- Extract and preserve key details VERBATIM — numbers, names, constraints, examples, acceptance criteria
- Instruction: "Preserve all specific details from the brief — do not paraphrase away precision. The original document is the floor for detail, not the ceiling."

Store this for the ideation document.
```

#### 6.7.3 Research Cache Check (Step 2.2 enhancement)

Add to Step 2.2 "Launch Research Agent" prompt, before the research tasks:

```markdown
### 0. Check Research Cache

Before doing any new research, search `research/` directory for existing reports:

- Glob for `research/*{relevant-keywords}*.md`
- If relevant reports exist, read them and incorporate findings
- Only research topics NOT already covered by existing reports
- Reference existing reports in your findings: "See research/YYYYMMDD_topic.md"
```

#### 6.7.4 Improved Question Style (Step 3.5 replacement)

Replace the current Step 3.5 "Interactive Clarification" with:

```markdown
## Phase 3.5: Interactive Clarification

### Step 3.5.1: Identify Key Decisions

Analyze exploration and research findings. Identify unresolved decisions, but apply these filters:

**Skip questions where:**

- The codebase exploration already provides a clear answer (state the answer, ask for confirmation)
- The research findings converge on an obvious approach
- The brief/source material already specified the answer
- The decision is a standard DorkOS convention (check AGENTS.md, contributing/ guides)

**Ask questions about:**

- Scope boundaries when the task brief is genuinely ambiguous
- Technical approach when research found multiple viable solutions with meaningfully different trade-offs
- Behavioral decisions (error handling, edge cases, UX flows) not specified anywhere

### Step 3.5.2: Ask Clarifying Questions

**One question per message.** Do not batch questions.

For each question:

1. Provide context: why this decision matters, what the exploration/research revealed
2. Offer 2-3 options as multiple-choice, with the first being your recommendation (labeled "(Recommended)" with rationale)
3. Include an "Other" option for custom answers
4. Wait for the answer before asking the next question

**If only 1-2 decisions need resolving**, ask them and move on quickly. Do not pad with confirmatory questions about obvious choices.

### Step 3.5.3: Propose Approaches (for non-trivial features)

If the feature involves meaningful architectural choices (not simple bug fixes or small additions):

1. Present 2-3 approaches with trade-offs in a comparison table
2. Include your recommendation with rationale
3. Ask the user to choose

This replaces the old pattern of jumping to a single approach.

### Step 3.5.4: Visual Companion (conditional)

If this feature involves UI, architecture with multiple components, or comparison of approaches:

- Reference `Skill(visual-companion)` to show the user a visual alongside the current question
- Use for: architecture diagrams, UI mockups, side-by-side comparisons
- Skip for: pure backend logic, config changes, simple bug fixes, features where the user already provided detailed mockups

### Step 3.5.5: Incorporate Answers

Store user's answers for the ideation document's Decisions section.
```

### 6.8 Upgrade: `executing-specs` Skill

**File:** `.claude/skills/executing-specs/SKILL.md`

**Changes:**

#### 6.8.1 TDD Reference in Implementation Agent Prompt

**File:** `.claude/skills/executing-specs/implementation-agent-prompt.md`

Add to the "Your Workflow" section, before Step 2:

```markdown
### Step 1.5: Follow TDD

For every piece of implementation:

1. Write a failing test first (RED)
2. Run it — confirm it fails for the right reason
3. Write minimal code to pass (GREEN)
4. Run it — confirm it passes and no regressions
5. Refactor if needed, keeping green

See the `test-driven-development` skill for the full methodology. The Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
```

#### 6.8.2 Verification Gate Before Task Completion

**File:** `.claude/skills/executing-specs/implementation-agent-prompt.md`

Add after Step 4 "Self-Review", before Step 5 "Report Results":

```markdown
### Step 4.5: Verification Gate

Before reporting results, run full verification:

1. Run `pnpm vitest run` (or relevant test command) — ALL tests must pass
2. Run `pnpm typecheck` — zero type errors
3. Run `pnpm lint` — zero lint errors
4. Read the output of each command

Only claim completion if you have FRESH verification evidence from THIS step. Do not rely on previous runs or assumptions. Evidence before assertions.
```

#### 6.8.3 Two-Stage Review in Batch Execution

**File:** `.claude/skills/executing-specs/SKILL.md`

Add a new section between Phase 3 Step D and Step E:

```markdown
**Step D.5: Two-Stage Review (per task)**

After each task's agent completes successfully:

**Stage 1 — Spec Compliance Review:**
Dispatch a review agent to verify the implementation matches the task spec:

- Did the agent implement everything requested?
- Did the agent add anything not requested?
- Did the agent misinterpret any requirements?
- CRITICAL: The reviewer must read actual code, not trust the implementer's report.

If issues found: dispatch the implementer agent to fix, then re-review.

**Stage 2 — Code Quality Review (only after Stage 1 passes):**
Dispatch the `code-reviewer` agent with:

- `{WHAT_WAS_IMPLEMENTED}`: from the implementer's report
- `{PLAN_OR_REQUIREMENTS}`: the task description from `03-tasks.json`
- `{BASE_SHA}`: commit before task
- `{HEAD_SHA}`: current commit
- `{DESCRIPTION}`: task summary

If Critical or Important issues found: dispatch fix agent, then re-review.

Never start Stage 2 before Stage 1 passes.
```

#### 6.8.4 Implementer Escalation Protocol

**File:** `.claude/skills/executing-specs/implementation-agent-prompt.md`

Replace the current report format section with:

```markdown
### Step 5: Report Results

Return a structured report with one of four statuses:

- **DONE**: Task complete, all acceptance criteria met, all tests pass
- **DONE_WITH_CONCERNS**: Task complete but with doubts about correctness, scope, or approach. List specific concerns.
- **NEEDS_CONTEXT**: Cannot complete without additional information. Describe exactly what is needed.
- **BLOCKED**: Cannot complete the task. Describe the blocker, what was attempted, and what kind of help is needed.

It is always OK to report BLOCKED or NEEDS_CONTEXT. Bad work is worse than no work.

[existing report format template]
```

### 6.9 Upgrade: `debugging-systematically` Skill

**File:** `.claude/skills/debugging-systematically/SKILL.md`
**New files:**

- `.claude/skills/debugging-systematically/condition-based-waiting.md`
- `.claude/skills/debugging-systematically/defense-in-depth.md`
- `.claude/skills/debugging-systematically/root-cause-tracing.md`
- `.claude/skills/debugging-systematically/find-polluter.sh`

**Changes to SKILL.md:**

Add a new section after "Anti-Patterns" (before "Quick Reference"):

```markdown
## The 3-Fix Rule

If you have attempted 3 or more fixes without success:

**STOP. Question the architecture.**

Pattern indicating an architectural problem:

- Each fix reveals new shared state, coupling, or problems in a different place
- Fixes require "massive refactoring" to implement
- Each fix creates new symptoms elsewhere

This is NOT a failed hypothesis — this is a wrong architecture. Discuss with the user before attempting more fixes.
```

**Supporting files** — copy from superpowers with these adaptations:

| File                         | Adaptations                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `condition-based-waiting.md` | Replace `npm test` with `pnpm vitest run`. Add reference to DorkOS's existing `waitFor` patterns in test-utils. |
| `defense-in-depth.md`        | No changes needed — patterns are universal.                                                                     |
| `root-cause-tracing.md`      | Replace `superpowers:test-driven-development` reference with DorkOS skill name.                                 |
| `find-polluter.sh`           | Replace `npm test` with `pnpm vitest run`. Make executable.                                                     |

Add cross-references in SKILL.md:

```markdown
## Supporting Techniques

- **`condition-based-waiting.md`** — Replace arbitrary timeouts with condition polling
- **`defense-in-depth.md`** — Add validation at multiple layers after finding root cause
- **`root-cause-tracing.md`** — Trace bugs backward through call stack to find original trigger
- **`find-polluter.sh`** — Bisection script to find which test creates unwanted state
```

### 6.10 Upgrade: `/git:commit` and `/git:push`

**File:** `.claude/commands/git/commit.md`

Add before Step 6 "Create Commit":

```markdown
### Step 5.5: Verification Gate

Before committing, verify all checks pass with FRESH evidence:

1. Confirm Step 1 validation passed (or was skipped with --no-verify)
2. Review the staged diff one more time
3. Ensure no incomplete work is being committed (no TODO markers, no commented-out code, no partial implementations)

Refer to the `verification-before-completion` skill: never claim work is ready to commit without fresh verification evidence.
```

**File:** `.claude/commands/git/push.md`

Add after Step 2 "Run Validation Checks":

```markdown
### Step 2.5: Verification Gate

After all checks pass, verify with fresh evidence:

1. Re-read the output of lint, typecheck, and build
2. Confirm zero errors in each
3. Do not push based on a previous run — the checks in Step 2 ARE the fresh evidence

Refer to the `verification-before-completion` skill.
```

### 6.11 Upgrade: `/review-recent-work` Command

**File:** `.claude/commands/review-recent-work.md`

Expand the existing lightweight command to reference structured review:

Add after the current "Task" section:

```markdown
## Structured Review Option

For a more thorough review, dispatch the `code-reviewer` agent:

1. Get git SHAs: `BASE_SHA=$(git merge-base HEAD main)`, `HEAD_SHA=$(git rev-parse HEAD)`
2. Dispatch the `code-reviewer` agent with the review template
3. Act on findings: fix Critical immediately, fix Important before proceeding, note Minor

This is recommended for:

- Pre-merge reviews
- After completing a spec implementation phase
- When multiple files were changed across the codebase

See the `requesting-code-review` skill for the full workflow.
```

### 6.12 Completion Hooks

#### 6.12.1 Auto-ADR Extraction on Spec Creation

**File:** `.claude/hooks/auto-extract-adrs.sh`
**Hook type:** PostToolUse (on Write tool)
**Matcher:** `Write` (with file_path matching `specs/*/02-specification.md`)

**Logic:**

1. Check if the written file is a `02-specification.md`
2. If yes, output a reminder:
   ```
   [ADR Auto-Extract] A specification was just written: specs/<slug>/02-specification.md
   Consider running /adr:from-spec <slug> to extract architectural decisions as draft ADRs.
   ```

This is a reminder hook (non-blocking), not an automatic extraction — ADR extraction requires judgment about which decisions are significant.

**Settings.json addition:**

```json
{
  "PostToolUse": [
    {
      "matcher": "Write",
      "hooks": [
        {
          "type": "command",
          "command": "bash .claude/hooks/auto-extract-adrs.sh"
        }
      ]
    }
  ]
}
```

#### 6.12.2 Spec Status Auto-Progression

**File:** `.claude/hooks/spec-status-sync.sh`
**Hook type:** PostToolUse (on Write tool)
**Matcher:** `Write` (with file_path matching `specs/*/0[1-5]-*.md`)

**Logic:**

1. Check if a spec artifact was written (01-ideation.md, 02-specification.md, 03-tasks.md, 04-implementation.md, 05-feedback.md)
2. Determine the highest artifact number in the spec directory
3. Map to status: 01 → `ideation`, 02 → `specified`, 03 → `specified`, 04 → `implemented`, 05 → `implemented`
4. Read `specs/manifest.json`, find the entry for this slug
5. If current manifest status is lower than detected status, update it
6. Output: `[Spec Status] Updated <slug> status to <new-status>`

This keeps the manifest accurate regardless of which command/skill/path created the artifact.

#### 6.12.3 Upgrade Stop Hook for ADR + Doc Reminders

**File:** `.claude/hooks/check-docs-changed.sh` (existing, modify)

Add to the existing hook, after the documentation drift check:

```bash
# Check for specs that have specifications but no ADRs
for spec_dir in specs/*/; do
  slug=$(basename "$spec_dir")
  if [ -f "$spec_dir/02-specification.md" ]; then
    # Check if any ADR references this slug
    adr_count=$(grep -rl "extractedFrom.*$slug\|spec:.*$slug" decisions/ 2>/dev/null | wc -l)
    if [ "$adr_count" -eq 0 ]; then
      echo "  - specs/$slug has a specification but no linked ADRs. Run /adr:from-spec $slug"
    fi
  fi
done
```

---

## 7. User Experience

### Before (current state)

- User runs `/ideate` → gets a mediocre ideation doc that may lose fidelity of existing work
- User runs `/spec:execute` → implementation agents have no TDD enforcement, no verification gate
- User uses superpowers brainstorming → artifacts land in `docs/superpowers/`, no manifest entry, no ADRs
- User must remember to run `/adr:from-spec` and `/spec:doc-update` manually after every spec

### After (target state)

- User runs `/ideate` → maturity detector preserves existing work; one-question-at-a-time style with approach comparison; visual companion available for architecture decisions
- User runs `/spec:execute` → implementation agents follow TDD, pass verification gates, go through two-stage review
- No superpowers plugin → all techniques are built-in; artifacts always land in `specs/`
- Hooks remind about ADR extraction when specs are written; spec status auto-updates in manifest

### Interaction changes

The user's primary workflow (`/ideate` → `/ideate-to-spec` → `/spec:decompose` → `/spec:execute`) is unchanged. What changes:

1. `/ideate` asks fewer, better questions and preserves existing work
2. `/spec:execute` produces higher-quality code via TDD and review gates
3. Completion verification happens automatically at commit/push time
4. ADR and doc update reminders fire at the right moments without manual intervention

---

## 8. Testing Strategy

### Manual Validation

Since these are all markdown skills, agents, and shell hooks, testing is primarily manual:

1. **New skills**: Invoke each skill via `Skill(name)` and verify the full content loads and instructions are followable
2. **Visual companion**: Run `start-server.sh`, verify browser opens, write HTML content, verify events are recorded in JSONL, run `stop-server.sh`
3. **Hooks**: Trigger each hook's condition and verify the expected output appears

### Validation Scenarios

| Scenario                                                   | Expected Result                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Run `/ideate` with no existing materials                   | Normal flow with improved questions (one at a time)                                        |
| Run `/ideate` with a detailed brief file path              | Maturity detector classifies as rough-notes/partial-spec/detailed-spec; preserves fidelity |
| Run `/ideate` on a topic with existing `research/` reports | Research agent references existing reports instead of re-researching                       |
| Run `/spec:execute` on a feature                           | Implementation agents report TDD compliance, verification gate output visible              |
| Write a `02-specification.md` file                         | PostToolUse hook fires, reminder about ADR extraction appears                              |
| Write a `04-implementation.md` file                        | Spec status auto-progression updates manifest to `implemented`                             |
| Run `/git:commit`                                          | Verification gate runs before commit                                                       |
| Dispatch `code-reviewer` agent                             | Returns structured review with Strengths/Issues/Assessment                                 |

---

## 9. Performance Considerations

- New hooks add ~100ms per Write tool invocation (manifest read + grep for ADRs)
- Visual companion server has a 30-minute idle timeout (auto-cleanup)
- Two-stage review in spec execution adds 2 agent dispatches per task (spec reviewer + code quality reviewer) — increases total execution time but catches issues earlier, reducing rework

---

## 10. Security Considerations

- Visual companion server binds to `localhost` only (no external access)
- No secrets or credentials involved in any skill
- `find-polluter.sh` runs tests in sequence — safe for CI but slow
- Hooks only produce stdout reminders — no destructive actions

---

## 11. Documentation

After implementation, update:

| Document               | What to Update                                            |
| ---------------------- | --------------------------------------------------------- |
| `.claude/README.md`    | Add new skills, agent, and hooks to the harness inventory |
| `AGENTS.md`            | No changes needed (skills are auto-discovered)            |
| `contributing/` guides | No changes needed (skills don't affect code patterns)     |

---

## 12. Implementation Phases

### Phase 1: New Skills (no dependencies on other phases)

Create these files:

1. `.claude/skills/test-driven-development/SKILL.md`
2. `.claude/skills/test-driven-development/testing-anti-patterns.md`
3. `.claude/skills/verification-before-completion/SKILL.md`
4. `.claude/skills/receiving-code-review/SKILL.md`
5. `.claude/skills/requesting-code-review/SKILL.md`
6. `.claude/agents/code-reviewer.md`

### Phase 2: Visual Companion Infrastructure

Create these files:

1. `.claude/skills/visual-companion/SKILL.md`
2. `.claude/skills/visual-companion/scripts/server.cjs`
3. `.claude/skills/visual-companion/scripts/helper.js`
4. `.claude/skills/visual-companion/scripts/frame-template.html`
5. `.claude/skills/visual-companion/scripts/start-server.sh`
6. `.claude/skills/visual-companion/scripts/stop-server.sh`

### Phase 3: Upgrade Existing Commands and Skills

Modify these files:

1. `.claude/commands/ideate.md` — maturity detector, brief refs, question style, visual companion ref, research cache
2. `.claude/skills/executing-specs/SKILL.md` — two-stage review section
3. `.claude/skills/executing-specs/implementation-agent-prompt.md` — TDD ref, verification gate, escalation protocol
4. `.claude/skills/debugging-systematically/SKILL.md` — 3-fix rule, supporting technique references
5. `.claude/skills/debugging-systematically/condition-based-waiting.md` (new)
6. `.claude/skills/debugging-systematically/defense-in-depth.md` (new)
7. `.claude/skills/debugging-systematically/root-cause-tracing.md` (new)
8. `.claude/skills/debugging-systematically/find-polluter.sh` (new)
9. `.claude/commands/review-recent-work.md` — structured review option
10. `.claude/commands/git/commit.md` — verification gate
11. `.claude/commands/git/push.md` — verification gate

### Phase 4: Hooks and Automation

Create/modify these files:

1. `.claude/hooks/auto-extract-adrs.sh` (new)
2. `.claude/hooks/spec-status-sync.sh` (new)
3. `.claude/hooks/check-docs-changed.sh` (modify — add ADR check)
4. `.claude/settings.json` (modify — register new hooks)

### Phase 5: Cleanup and Verification

1. Update `.claude/README.md` with new inventory
2. Verify all skills load via `Skill(name)`
3. Verify visual companion server starts/stops
4. Verify hooks fire correctly
5. Remove superpowers plugin: `claude plugins remove superpowers` (or equivalent)

---

## 13. Open Questions

1. **Visual companion session directory**: Should it use `.dork/visual-companion/` (consistent with DorkOS data dir) or a temp directory? Superpowers uses `.superpowers/brainstorm/` under the project dir. Recommendation: use `.dork/visual-companion/` for persistence across sessions.

2. **Hook registration format**: The PostToolUse hook for auto-ADR extraction needs to match only `Write` calls to `specs/*/02-specification.md`. The current hook system's `matcher` field may need a regex or the hook script itself does the path filtering. Need to verify `.claude/settings.json` hook matcher capabilities.

3. **Two-stage review cost**: Adding spec compliance + code quality review per task in `/spec:execute` roughly triples agent invocations. Should this be opt-in (e.g., `--review` flag) or always-on? Recommendation: always-on for quality, but allow `--skip-review` flag for rapid iteration.

---

## 14. Related ADRs

- ADR-0043: Agent Storage (file-first write-through) — relevant to spec status auto-progression hook
- No existing ADRs directly about the superpowers plugin or TDD enforcement

---

## 15. References

- Superpowers plugin v5.0.6: `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.6/`
- Superpowers repository: https://github.com/obra/superpowers
- DorkOS harness README: `.claude/README.md`
- DorkOS spec pipeline: `/ideate` → `/ideate-to-spec` → `/spec:create` → `/spec:decompose` → `/spec:execute`

---

## Changelog

| Date       | Change                |
| ---------- | --------------------- |
| 2026-03-26 | Initial specification |
