# DorkBot issue triage (off by default)

This folder holds a skill that lets DorkBot do first-touch triage on incoming
GitHub issues: label each new issue, flag likely duplicates, and ask for missing
reproduction steps. It ships **turned off**. Nothing here runs a live bot, and
there is no GitHub Action. Turning it on is a deliberate step that needs a token
and an owner decision, because it posts as a bot on the public repository.

## What it does

`SKILL.md` is a prose instruction set for DorkBot. It watches for open issues
labeled `needs-triage`, adds a type label (and a runtime label when relevant),
notes likely duplicates for a human to confirm, and posts at most one polite
comment asking for reproduction steps when they are missing. It never closes,
locks, assigns, or edits issues, and it never posts more than one comment per
issue per run. By default it only suggests actions; it applies them only when you
explicitly allow it.

## The labels it uses

The issue templates already apply `bug`, `enhancement`, and `needs-triage`. The
triage skill also uses runtime labels. Create the ones that do not exist yet:

```bash
gh label create needs-triage --description "New issue awaiting first-touch triage" --color FBCA04
gh label create runtime/claude-code --description "Affects the Claude Code runtime" --color 5319E7
gh label create runtime/codex --description "Affects the Codex runtime" --color 5319E7
gh label create runtime/opencode --description "Affects the OpenCode runtime" --color 5319E7
```

`bug` and `enhancement` are GitHub defaults and already exist.

## Turn it on for DorkBot (manual, suggest-only)

1. Copy this skill into DorkBot's workspace so DorkBot can load it:

   ```bash
   mkdir -p ~/.dork/agents/dorkbot/.claude/skills/dorkbot-triage
   cp .github/dorkbot-triage/SKILL.md ~/.dork/agents/dorkbot/.claude/skills/dorkbot-triage/
   ```

2. In a DorkBot session, ask it to triage the queue. It will read the
   `needs-triage` issues and print a plan. Nothing is changed on GitHub yet.

3. To let it act (add labels, post the one comment), give the session a token with
   `issues: write` scope and tell it acting is allowed. Start with a dry run and
   review the plan before allowing it to apply changes.

## Turn on the live bot later (owner decision, still off)

A fully automatic bot that comments within the hour would run as a scheduled
DorkOS Task or a GitHub Action. That is intentionally **not** included here. It
needs a dedicated bot token, rate limits, and an owner sign-off, since it writes
in public under the project's name. When you are ready:

- Create a scoped bot token (a machine account is better than a personal one).
- Run the skill on a schedule (a DorkOS Task) or in a workflow, acting enabled.
- Keep the one-comment-per-issue and no-close guardrails from the skill.
- Watch the first runs closely; a noisy triage bot is worse than none.

Until then, triage stays a human-in-the-loop step, which is the right default for
an alpha.
