# DorkBot issue triage (off by default)

First-touch triage on GitHub issues runs through **`/feedback:triage`**. That
command reads the open issues, mirrors each new one into the Linear feedback
team, and drafts the reply the reporter gets on their own issue. It is the
process. This folder is an optional helper for the labeling half of it.

`SKILL.md` lets DorkBot label incoming issues by type and runtime and flag
likely duplicates. It ships **turned off**. Nothing here runs a live bot, and
there is no GitHub Action. Turning it on is a deliberate step that needs a token
and an owner decision, because it acts as a bot on the public repository.

## What counts as the queue

Open issues with no `<!-- beat:heard -->` comment on them. That marker is the
hidden line `/feedback:triage` puts on the first reply a reporter gets, so an
issue without one has not been answered yet. It needs nothing but `gh`, which is
all the setup below grants: DorkBot has no Linear access and never needs any.

`/feedback:triage` owns every reply to a reporter. DorkBot only labels, and the
command reads the label DorkBot set when it drafts that reply.

## The labels it uses

The issue templates apply `bug` and `enhancement`, which are GitHub defaults and
already exist. The triage skill also uses runtime labels. Create the ones that
do not exist yet:

```bash
gh label create runtime/claude-code --description "Affects the Claude Code runtime" --color 5319E7
gh label create runtime/codex --description "Affects the Codex runtime" --color 5319E7
gh label create runtime/opencode --description "Affects the OpenCode runtime" --color 5319E7
```

## Turn it on for DorkBot (manual, suggest-only)

1. Copy this skill into DorkBot's workspace so DorkBot can load it:

   ```bash
   mkdir -p ~/.dork/agents/dorkbot/.claude/skills/dorkbot-triage
   cp .github/dorkbot-triage/SKILL.md ~/.dork/agents/dorkbot/.claude/skills/dorkbot-triage/
   ```

2. In a DorkBot session, ask it to triage the queue. It reads the unanswered
   issues and prints a plan. Nothing is changed on GitHub yet.

3. To let it apply labels, give the session a token with `issues: write` scope
   and tell it acting is allowed. Start with a dry run and review the plan
   first.

## Turn on the live bot later (owner decision, still off)

A fully automatic bot would run as a scheduled DorkOS Task or a GitHub Action.
That is intentionally **not** included here. It needs a dedicated bot token,
rate limits, and an owner sign-off, since it writes in public under the
project's name. When you are ready:

- Create a scoped bot token (a machine account is better than a personal one).
- Run the skill on a schedule (a DorkOS Task) or in a workflow, acting enabled.
- Keep the no-close and no-comment guardrails from the skill. Replies to
  reporters stay with `/feedback:triage`, where a person approves each one.
- Watch the first runs closely; a noisy triage bot is worse than none.

Until then, triage stays a human-in-the-loop step, which is the right default
for an alpha.
