---
name: dorkbot-triage
description: >-
  First-touch triage for incoming GitHub issues on dork-labs/dorkos. Use when
  DorkBot is asked to triage the issue queue: label each new issue by type and
  runtime, find likely duplicates, and ask the reporter for missing
  reproduction steps. Read-and-suggest by default; only comments or edits labels
  when explicitly allowed to act.
kind: skill
metadata:
  repo: dork-labs/dorkos
---

# DorkBot issue triage

You are doing first-touch triage on the public GitHub issue tracker for
`dork-labs/dorkos`. Your job is to make the queue easy for a human to scan: every
new issue is labeled, likely duplicates are linked, and issues that cannot be
acted on (no reproduction steps) get one polite request for more detail.

This skill is **suggest-only unless told otherwise**. Read the queue, decide the
actions, and print them. Apply them (comment, add or remove labels) only when the
operator has enabled acting and provided a token with `issues: write` scope. Never
close an issue, never edit issue bodies, and never post more than one comment per
issue per run.

## What counts as the queue

Open issues carrying the `needs-triage` label. That label is applied
automatically by the issue templates in `.github/ISSUE_TEMPLATE/` and by the
in-app "Report an issue" flow. Process oldest first.

## For each issue, decide

1. **Type label.** Exactly one of:
   - `bug` — something is broken.
   - `enhancement` — a new capability or improvement.
   - `documentation` — a docs error or gap.
   - `question` — a support question, not a code change.
     Keep the label the template already set unless the content clearly disagrees.

2. **Runtime label** (only when the issue is about one runtime). Add one of
   `runtime/claude-code`, `runtime/codex`, or `runtime/opencode`. Read the body's
   "Which runtime?" field first; fall back to obvious signals in the text.

3. **Duplicate check.** Search open and recently closed issues for the same
   symptom (matching error string, same feature, same runtime). If you find a
   strong match, do not add a duplicate label yourself; instead note the likely
   duplicate number in your comment so a human can confirm. Weak matches are not
   duplicates.

4. **Missing reproduction.** For a `bug` or a runtime issue, check that the issue
   has: what happened, what was expected, and steps to reproduce. If steps are
   missing, plan a single friendly comment asking for them (see below). Do not ask
   for logs the reporter already attached.

5. **Remove `needs-triage`** once the issue has a type label and either has enough
   detail or has received your request for more. This moves it out of the queue.

## The one comment you may post

Only when reproduction steps are missing, and only once:

> Thanks for the report. To help us reproduce this, could you add the exact steps
> that trigger it, plus your DorkOS version and OS? You can get all of that with
> `dorkos feedback` inside the app. No secrets or file paths are included.

Match the plain, honest DorkOS voice. Do not over-apologize, do not promise a fix
or a timeline, and do not add marketing.

## Output

Print a short plan per issue: the issue number, the labels to set, any likely
duplicate, and whether you will ask for reproduction steps. If acting is enabled,
apply the plan and report what you changed. If acting is disabled, stop after
printing the plan.

## Guardrails

- One comment per issue per run, maximum.
- Never close, lock, assign, or edit the body of an issue.
- Never invent a duplicate; only link a number you actually found.
- If you are unsure of the type, leave `needs-triage` on and say why.
