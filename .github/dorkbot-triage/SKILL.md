---
name: dorkbot-triage
description: >-
  Labeling helper for incoming GitHub issues on dork-labs/dorkos. Use when
  DorkBot is asked to label the issue queue: set a type and runtime label on
  each new issue and flag likely duplicates. Read-and-suggest by default; only
  edits labels when explicitly allowed to act. Replies to reporters belong to
  /feedback:triage, not here.
kind: skill
metadata:
  repo: dork-labs/dorkos
---

# DorkBot issue triage

You are labeling the public GitHub issue tracker for `dork-labs/dorkos` so a
human can scan it: every new issue gets a type label, a runtime label where one
applies, and a note when it looks like a duplicate.

This skill is **suggest-only unless told otherwise**. Read the queue, decide the
labels, and print them. Apply them only when the operator has enabled acting and
provided a token with `issues: write` scope.

**You never write to a reporter.** No comments, ever. The person who filed the
issue hears back through `/feedback:triage`, where a human approves the exact
text of every reply. Two voices on one issue is the failure mode this rule
prevents. Never close, lock, assign, or edit the body of an issue either.

## What counts as the queue

Open issues with no feedback mirror yet: no issue in the Linear feedback team
carries a `Source: https://github.com/dork-labs/dorkos/issues/<n>` line for that
number. Process oldest first.

## For each issue, decide

1. **Type label.** Exactly one of:
   - `bug` for something broken.
   - `enhancement` for a new capability or improvement.
   - `documentation` for a docs error or gap.
   - `question` for a support question, not a code change.

   Keep the label the template already set unless the content clearly disagrees.

2. **Runtime label**, only when the issue is about one runtime. Add one of
   `runtime/claude-code`, `runtime/codex`, or `runtime/opencode`. Read the
   body's "Which runtime?" field first; fall back to obvious signals in the
   text.

3. **Duplicate check.** Search open and recently closed issues for the same
   symptom: a matching error string, the same feature, the same runtime. On a
   strong match, print the likely duplicate number for a human to confirm. Do
   not add a duplicate label yourself. Weak matches are not duplicates.

4. **Missing reproduction.** For a bug or a runtime issue, note whether it has
   what happened, what was expected, and steps to reproduce. Print what is
   missing so the `/feedback:triage` reply can ask for it. Do not ask for it
   yourself, and do not ask for logs the reporter already attached.

## Output

Print a short plan per issue: the number, the labels to set, any likely
duplicate, and anything missing from the report. If acting is enabled, apply the
labels and report what you changed. If acting is disabled, stop after printing
the plan.

## Guardrails

- Never comment, close, lock, assign, or edit the body of an issue.
- Never invent a duplicate; only print a number you actually found.
- If you are unsure of the type, leave the labels alone and say why.
