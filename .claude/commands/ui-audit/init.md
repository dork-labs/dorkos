---
description: Scaffold the UI audit charter and capture this repo's landing profile
argument-hint: '[--force-profile]'
allowed-tools: Read, Write, Edit, Grep, Glob, AskUserQuestion, Bash(git:*), Bash(ls:*)
category: workflow
---

# Initialize the UI audit

Read `.claude/skills/auditing-ui/SKILL.md` first. It is the procedure; this command is the
setup step.

## Contract

1. **Scaffold the charter.** Create `audits/ui.md` from the charter skeleton if it does not
   exist. Create `audits/README.md` if it does not exist.
   **Create if absent, never overwrite.** Both files accrete: `audits/README.md` is shared with
   every future audit domain, and `audits/ui.md` carries operator directives added after the last
   scaffold. If a file exists, report what is already there and stop touching it. Missing
   _sections_ may be offered as an additive patch the operator approves; a rewrite may not.

2. **Capture the repo profile.** Ask (or infer from the repo, then confirm) and record the
   answers in `audits/runs/ui/profile.md`:
   - **Landing style** — merge queue, or plain merges into the default branch?
   - **Changelog** — per-change fragments, a single file, or none?
   - **Isolation** — worktrees, branches in one checkout, or a single-writer repo?
   - **Formatting gate** — does CI fail on formatting, and what command satisfies it?
   - **Tracker mode** — workflow-engine adapter, or the markdown ledger at
     `audits/runs/ui/<date>/backlog.md`?
   - **Browser leg** — is there a runnable dev app, on which command and which free port?

   Landing guidance adapts to this profile. A repo with no merge queue must not inherit
   arm-then-verify or bare `gh pr merge --auto`; a repo with no changelog fragments must not be
   told to write one.

3. **Fill the repo-specific half of the charter.** The lens library, rubric, and validity rules
   are generic and land unchanged. The ground-truth pointer list is repo-specific: populate it
   with this repo's real design-system, motion, architecture-rule, and persona docs, and verify
   every path resolves before writing it.

4. **Report** which files were created, which already existed and were left alone, and the
   captured profile. Do not run an audit.
