---
description: Scaffold the UI audit charter and capture this repo's landing profile
argument-hint: ''
allowed-tools: Read, Write, Edit, Grep, Glob, AskUserQuestion, Bash
category: workflow
---

# Initialize the UI audit

Read `.claude/skills/auditing-ui/SKILL.md` first. It is the procedure; this command is the
one-time setup.

## Contract

1. **Scaffold, create-if-absent, never overwrite.** Create `audits/ui.md` from the charter
   skeleton if it is missing, and `audits/README.md` if that is missing. Both accrete: the README
   is shared with every future audit domain, and the charter carries operator directives added
   since the last scaffold. If a file exists, report what is there and leave it alone. A missing
   _section_ may be offered as an additive patch the operator approves; a rewrite may not.

2. **Fill the repo-specific half of the charter.** The lens library, the lens keys, the rubric,
   and the validity rules are generic and land unchanged. The ground-truth pointer list is not:
   populate it with this repo's real design-system, motion, architecture-rule, and persona docs,
   and verify every path resolves before writing it.

3. **Capture the landing profile** to `audits/runs/ui/profile.md`. Ask, or infer from the repo
   and confirm. Every question exists because `run`, `pulse`, or `execute` reads the answer and
   behaves differently (`SKILL.md` §1):
   - **Landing style** — merge queue, or plain merges into the default branch?
   - **Changelog** — per-change fragments, a single file, or none?
   - **Isolation** — worktrees, branches in one checkout, or a single-writer repo?
   - **Formatting gate** — does CI fail on formatting, and what exact command satisfies it?
   - **Tracker mode** — the `/flow` adapter (with which team and project), or the markdown
     ledger at `audits/runs/ui/<date>/backlog.md`?
   - **Browser leg** — is there a runnable dev app, on what command and which free port, and
     which ports are already spoken for on this machine?
   - **Run-log root** — `audits/runs/ui/` unless the repo has a reason to put it elsewhere.

4. **Report** which files were created, which already existed and were left alone, and the
   captured profile. Note that no stamps exist yet, so the first audit must be `full` or scoped;
   `diff` and `/ui-audit:pulse` have no baseline until one has run. Do not run an audit.
