# Absorb Superpowers Plugin — Task Breakdown

**Spec:** `specs/absorb-superpowers-plugin/02-specification.md`
**Generated:** 2026-03-26
**Mode:** Full
**Total Tasks:** 16

---

## Phase 1: New Skills

> All Phase 1 tasks can run in parallel — no dependencies between them.

### Task 1.1: Create test-driven-development skill (SKILL.md + testing-anti-patterns.md)

| Field             | Value              |
| ----------------- | ------------------ |
| **ID**            | 1.1                |
| **Size**          | Medium             |
| **Priority**      | High               |
| **Dependencies**  | None               |
| **Parallel With** | 1.2, 1.3, 1.4, 1.5 |

**Files to create:**

- `.claude/skills/test-driven-development/SKILL.md`
- `.claude/skills/test-driven-development/testing-anti-patterns.md`

**Source files:** Superpowers `skills/test-driven-development/SKILL.md` and `testing-anti-patterns.md`

**Key adaptations:**

- Replace `npm test` with `pnpm vitest run`
- Replace `jest.fn()` with `vi.fn()`
- Replace "your human partner" with "the user"
- Add DorkOS-specific patterns section (test-utils, TransportProvider, FakeAgentRuntime, /debug:test)

---

### Task 1.2: Create verification-before-completion skill

| Field             | Value              |
| ----------------- | ------------------ |
| **ID**            | 1.2                |
| **Size**          | Medium             |
| **Priority**      | High               |
| **Dependencies**  | None               |
| **Parallel With** | 1.1, 1.3, 1.4, 1.5 |

**Files to create:**

- `.claude/skills/verification-before-completion/SKILL.md`

**Source file:** Superpowers `skills/verification-before-completion/SKILL.md`

**Key adaptations:**

- Replace generic commands with DorkOS-specific: `pnpm vitest run`, `pnpm typecheck`, `pnpm lint`, `pnpm build`
- Add DorkOS Automatic Checks section explaining PostToolUse hooks vs comprehensive verification
- Replace "your human partner" with "the user"

---

### Task 1.3: Create receiving-code-review skill

| Field             | Value              |
| ----------------- | ------------------ |
| **ID**            | 1.3                |
| **Size**          | Medium             |
| **Priority**      | High               |
| **Dependencies**  | None               |
| **Parallel With** | 1.1, 1.2, 1.4, 1.5 |

**Files to create:**

- `.claude/skills/receiving-code-review/SKILL.md`

**Source file:** Superpowers `skills/receiving-code-review/SKILL.md`

**Key adaptations:**

- Replace "your human partner" with "the user" throughout
- Remove "Strange things are afoot at the Circle K" signal
- Add DorkOS Conventions section (ADR references, code-quality.md rule, hard rules)

---

### Task 1.4: Create requesting-code-review skill

| Field             | Value              |
| ----------------- | ------------------ |
| **ID**            | 1.4                |
| **Size**          | Small              |
| **Priority**      | High               |
| **Dependencies**  | None               |
| **Parallel With** | 1.1, 1.2, 1.3, 1.5 |

**Files to create:**

- `.claude/skills/requesting-code-review/SKILL.md`

**Source file:** Superpowers `skills/requesting-code-review/SKILL.md`

**Key adaptations:**

- Replace "superpowers:code-reviewer" with DorkOS "code-reviewer" agent
- Update example paths to DorkOS conventions
- Add Lightweight Alternative section referencing /review-recent-work
- Update workflow integration names to DorkOS equivalents

---

### Task 1.5: Create code-reviewer agent

| Field             | Value              |
| ----------------- | ------------------ |
| **ID**            | 1.5                |
| **Size**          | Medium             |
| **Priority**      | High               |
| **Dependencies**  | None               |
| **Parallel With** | 1.1, 1.2, 1.3, 1.4 |

**Files to create:**

- `.claude/agents/code-reviewer.md`

**Source files:** Superpowers `agents/code-reviewer.md` (persona) + `skills/requesting-code-review/code-reviewer.md` (review template)

**Key design:**

- Consolidates superpowers agent persona with review template
- Adds DorkOS-specific checks (FSD layers, SDK confinement, os.homedir ban, TSDoc, Tailwind sorting)
- Includes "Do not trust the report" instruction for spec compliance
- Review template with 5 placeholders: {WHAT_WAS_IMPLEMENTED}, {PLAN_OR_REQUIREMENTS}, {BASE_SHA}, {HEAD_SHA}, {DESCRIPTION}
- Output format: Strengths / Issues (Critical/Important/Minor) / Recommendations / Assessment

---

## Phase 2: Visual Companion Infrastructure

> Both Phase 2 tasks can run in parallel.

### Task 2.1: Create visual-companion SKILL.md

| Field             | Value  |
| ----------------- | ------ |
| **ID**            | 2.1    |
| **Size**          | Medium |
| **Priority**      | High   |
| **Dependencies**  | None   |
| **Parallel With** | 2.2    |

**Files to create:**

- `.claude/skills/visual-companion/SKILL.md`

**Source file:** Superpowers `skills/brainstorming/visual-companion.md`

**Key adaptations:**

- Replace `.superpowers/brainstorm/` with `.dork/visual-companion/`
- Update script paths to `.claude/skills/visual-companion/scripts/`
- Add Integration cross-reference section (used by /ideate)
- Simplify platform instructions (keep macOS/Linux, Windows, Other — drop Codex/Gemini)

---

### Task 2.2: Copy and adapt visual companion scripts

| Field             | Value  |
| ----------------- | ------ |
| **ID**            | 2.2    |
| **Size**          | Medium |
| **Priority**      | High   |
| **Dependencies**  | None   |
| **Parallel With** | 2.1    |

**Files to create:**

- `.claude/skills/visual-companion/scripts/server.cjs` (verbatim copy)
- `.claude/skills/visual-companion/scripts/helper.js` (verbatim copy)
- `.claude/skills/visual-companion/scripts/frame-template.html` (rename header)
- `.claude/skills/visual-companion/scripts/start-server.sh` (change session dir)
- `.claude/skills/visual-companion/scripts/stop-server.sh` (update comments)

**Source directory:** Superpowers `skills/brainstorming/scripts/`

**Key adaptations:**

- frame-template.html: "DorkOS Visual Companion" in title/header, remove superpowers link
- start-server.sh: `.dork/visual-companion/` instead of `.superpowers/brainstorm/`
- stop-server.sh: Update comments to reference .dork/
- Make start-server.sh and stop-server.sh executable

---

## Phase 3: Upgrade Existing Commands and Skills

### Task 3.1: Upgrade /ideate command

| Field             | Value                            |
| ----------------- | -------------------------------- |
| **ID**            | 3.1                              |
| **Size**          | Large                            |
| **Priority**      | High                             |
| **Dependencies**  | 2.1 (visual companion reference) |
| **Parallel With** | 3.3, 3.4, 3.5                    |

**File to modify:** `.claude/commands/ideate.md`

**Changes:**

1. Add Phase 0: Input Assessment (maturity detection: rough-notes/partial-spec/detailed-spec)
2. Enhance Step 1.2 with brief referencing and VERBATIM preservation
3. Add Research Cache Check as step 0 in research agent prompt
4. Replace Step 3.5 with improved question style (one-at-a-time, smart filtering, approach comparison, conditional visual companion)

---

### Task 3.2: Upgrade executing-specs skill and implementation-agent-prompt

| Field             | Value              |
| ----------------- | ------------------ |
| **ID**            | 3.2                |
| **Size**          | Large              |
| **Priority**      | High               |
| **Dependencies**  | 1.1, 1.2, 1.4, 1.5 |
| **Parallel With** | None               |

**Files to modify:**

- `.claude/skills/executing-specs/implementation-agent-prompt.md`
- `.claude/skills/executing-specs/SKILL.md`

**Changes:**

- implementation-agent-prompt.md: Add Step 1.5 (TDD), Step 4.5 (Verification Gate), replace Step 5 with escalation protocol (DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED)
- SKILL.md: Add Step D.5 (Two-Stage Review: spec compliance then code quality via code-reviewer agent)

---

### Task 3.3: Upgrade debugging-systematically skill + add supporting files

| Field             | Value         |
| ----------------- | ------------- |
| **ID**            | 3.3           |
| **Size**          | Large         |
| **Priority**      | Medium        |
| **Dependencies**  | None          |
| **Parallel With** | 3.1, 3.4, 3.5 |

**File to modify:** `.claude/skills/debugging-systematically/SKILL.md`

**Files to create:**

- `.claude/skills/debugging-systematically/condition-based-waiting.md`
- `.claude/skills/debugging-systematically/defense-in-depth.md`
- `.claude/skills/debugging-systematically/root-cause-tracing.md`
- `.claude/skills/debugging-systematically/find-polluter.sh`

**Source directory:** Superpowers `skills/systematic-debugging/`

**Changes:**

- SKILL.md: Add 3-Fix Rule section + Supporting Techniques reference
- Supporting files: Copy from superpowers with `npm test` -> `pnpm vitest run` replacement
- defense-in-depth.md: verbatim copy (universal patterns)
- find-polluter.sh: make executable

---

### Task 3.4: Upgrade /review-recent-work command

| Field             | Value         |
| ----------------- | ------------- |
| **ID**            | 3.4           |
| **Size**          | Small         |
| **Priority**      | Medium        |
| **Dependencies**  | 1.4, 1.5      |
| **Parallel With** | 3.1, 3.3, 3.5 |

**File to modify:** `.claude/commands/review-recent-work.md`

**Changes:** Add "Structured Review Option" section with code-reviewer agent dispatch, git SHA retrieval, and cross-reference to requesting-code-review skill.

---

### Task 3.5: Upgrade /git:commit and /git:push with verification gates

| Field             | Value         |
| ----------------- | ------------- |
| **ID**            | 3.5           |
| **Size**          | Small         |
| **Priority**      | Medium        |
| **Dependencies**  | 1.2           |
| **Parallel With** | 3.1, 3.3, 3.4 |

**Files to modify:**

- `.claude/commands/git/commit.md` — Add Step 5.5 (Verification Gate)
- `.claude/commands/git/push.md` — Add Step 2.5 (Verification Gate)

Both reference the `verification-before-completion` skill.

---

## Phase 4: Hooks and Automation

### Task 4.1: Create auto-extract-adrs hook

| Field             | Value    |
| ----------------- | -------- |
| **ID**            | 4.1      |
| **Size**          | Small    |
| **Priority**      | Medium   |
| **Dependencies**  | None     |
| **Parallel With** | 4.2, 4.3 |

**File to create:** `.claude/hooks/auto-extract-adrs.sh`

PostToolUse hook on Write that reminds about ADR extraction when `specs/*/02-specification.md` is written. Non-blocking reminder only.

---

### Task 4.2: Create spec-status-sync hook

| Field             | Value    |
| ----------------- | -------- |
| **ID**            | 4.2      |
| **Size**          | Medium   |
| **Priority**      | Medium   |
| **Dependencies**  | None     |
| **Parallel With** | 4.1, 4.3 |

**File to create:** `.claude/hooks/spec-status-sync.sh`

PostToolUse hook on Write that auto-updates spec status in `specs/manifest.json` when spec artifacts (01-05) are written. Maps artifact numbers to statuses, only progresses forward.

---

### Task 4.3: Upgrade check-docs-changed hook + register new hooks

| Field             | Value    |
| ----------------- | -------- |
| **ID**            | 4.3      |
| **Size**          | Medium   |
| **Priority**      | Medium   |
| **Dependencies**  | 4.1, 4.2 |
| **Parallel With** | None     |

**Files to modify:**

- `.claude/hooks/check-docs-changed.sh` — Add ADR checking for specs without linked ADRs
- `.claude/settings.json` — Register auto-extract-adrs.sh and spec-status-sync.sh as PostToolUse hooks

---

## Phase 5: Cleanup and Verification

### Task 5.1: Update .claude/README.md + final verification

| Field             | Value                        |
| ----------------- | ---------------------------- |
| **ID**            | 5.1                          |
| **Size**          | Medium                       |
| **Priority**      | Medium                       |
| **Dependencies**  | 3.1, 3.2, 3.3, 3.4, 3.5, 4.3 |
| **Parallel With** | None                         |

**File to modify:** `.claude/README.md`

**Changes:**

- Update inventory counts (6 agents, 17 skills, 13 hooks)
- Add new skills/agent/hooks to respective tables
- Update directory tree listing

**Verification:**

- Confirm all 15+ new files exist
- Verify shell scripts are executable
- Validate settings.json
- Check no stale superpowers references

---

## Dependency Graph

```
Phase 1 (all parallel):
  1.1 ──┐
  1.2 ──┤
  1.3 ──┤── No dependencies
  1.4 ──┤
  1.5 ──┘

Phase 2 (all parallel):
  2.1 ──┐── No dependencies
  2.2 ──┘

Phase 3:
  3.1 ←── 2.1
  3.2 ←── 1.1, 1.2, 1.4, 1.5
  3.3 ──── No dependencies (parallel with 3.1, 3.4, 3.5)
  3.4 ←── 1.4, 1.5
  3.5 ←── 1.2

Phase 4:
  4.1 ──┐── No dependencies
  4.2 ──┘
  4.3 ←── 4.1, 4.2

Phase 5:
  5.1 ←── 3.1, 3.2, 3.3, 3.4, 3.5, 4.3
```

## Execution Batches (Suggested)

| Batch       | Tasks                             | Notes                                       |
| ----------- | --------------------------------- | ------------------------------------------- |
| **Batch 1** | 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2 | All Phase 1 + Phase 2 (7 parallel)          |
| **Batch 2** | 3.1, 3.3, 3.4, 3.5, 4.1, 4.2      | Phase 3 subset + Phase 4 hooks (6 parallel) |
| **Batch 3** | 3.2                               | Depends on 1.1, 1.2, 1.4, 1.5 from Batch 1  |
| **Batch 4** | 4.3                               | Depends on 4.1, 4.2 from Batch 2            |
| **Batch 5** | 5.1                               | Final verification, depends on everything   |
