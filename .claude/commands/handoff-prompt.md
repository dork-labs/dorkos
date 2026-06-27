---
description: Write a self-destructing handoff doc to .temp/ and print a paste-ready prompt that bootstraps a fresh agent with full context
argument-hint: [optional focus / special instructions for the next agent]
allowed-tools: Bash(git:*), Bash(gh:*), Bash(date:*), Bash(mkdir:*), Bash(ls:*), Bash(echo:*), Read, Write, Glob, Grep
---

Produce a **handoff** so a brand-new agent — empty context, fresh session — can resume this exact work with an incredible start. Aim higher than the handoff you'd want to receive: the next agent should act correctly within its first few tool calls and never relearn what this session already paid for.

## Live state (captured now — embed the REAL values, don't paraphrase)

- When: !`date "+%Y-%m-%d %H:%M %Z"`
- Repo root: !`git rev-parse --show-toplevel`
- Branch: !`git branch --show-current`
- HEAD: !`git log --oneline -1`
- Working tree: !`git status --short`
- Worktrees: !`git worktree list`
- Upstream delta (left = behind, right = ahead): !`git rev-list --left-right --count @{u}...HEAD 2>/dev/null || echo "no upstream"`
- Recent commits: !`git log --oneline -10`
- Open PRs: !`gh pr list --state open --limit 10 2>/dev/null || echo "gh unavailable"`

## 1. Choose the file path

Temp dir = `.temp/` at the repo root (gitignored). Run `mkdir -p .temp`. Filename: `handoff-<YYYY-MM-DD-HHMM>.md` derived from the timestamp above. Use the **absolute path** in the doc banner and in the prompt.

## 2. Write the handoff doc

Synthesize everything from THIS session plus the live state above. Rules: be **concrete** (name real files, SHAs, commands, URLs, env vars — never "the relevant file"); lead with what matters; lean but complete; specifics over prose; no vague encouragement. Sections, in order:

1. **🔥 Self-destruct banner** (very top): "Temporary handoff — read in full, then delete: `rm <abs-path>`. Untracked; never commit. Written <timestamp> by the prior session."
2. **TL;DR** — 2–4 sentences: exactly where we are and the single most important next step.
3. **Where to work** — worktree path, branch, working directory, HEAD SHA, remote + ahead/behind, and tree clean vs **uncommitted / in-flight work**. Call WIP out _loudly_ — the next agent must not lose or clobber it. If multiple worktrees exist, say which one to use and why.
4. **What this is** — one paragraph; point at `CLAUDE.md` / README rather than re-explaining the codebase.
5. **What's been done** — shipped/merged work with SHAs + PR numbers; mark what is **verified** vs merely **assumed**.
6. **Immediate task** — the concrete next objective and its first few steps, with **who-drives-what** (operator/user-only steps vs agent steps) where it matters.
7. **▶ Do this FIRST — verification recipes** — the exact commands the new agent must run to confirm the repo is in the expected state _before changing anything_ (typecheck / test / build / CLI / health-check as fits), each with its expected output. Highest-value section: tell the agent to trust nothing until it re-verifies.
8. **Critical facts & decisions — do NOT relearn or undo** — the hard-won gotchas, non-obvious operational details, and decisions + their rationale. **Read `MEMORY.md` and the relevant files in this project's memory dir and fold the operationally-critical ones in here**, each a tight bullet with the "why". These are what cost this session the most time.
9. **Required reading & pointers** — ADRs, design/plan docs, research notes, runbooks, and pivotal source files, **by path**. Link; don't duplicate.
10. **Risks / watch-outs** — where it can go wrong; residual unknowns; anything fragile or surprising.
11. **Open questions for the user** — pending decisions and unverified assumptions.
12. **Guardrails** — standing constraints (never commit secrets/data; branch before committing; push / open PRs / merge only when the user asks; operator-only steps; any repo-specific rules).

## 3. Print the user's bootstrap prompt

After writing the file, output to me **one fenced code block** I can paste to a fresh agent verbatim. It must:

- give the **absolute path** to the handoff and tell the agent to read it **in full** first;
- tell it to run the verification recipes to confirm repo state before acting;
- tell it to **delete the doc** (`rm <abs-path>`) once read — it self-destructs;
- tell it to reply with a 2–3 sentence summary of where things stand + the immediate next step, then proceed;
- weave in any special instructions / focus for this handoff: **$ARGUMENTS**

Below the code block, print the handoff file's absolute path and a one-line note of what you captured. **Do not delete the file yourself** — the next agent does that after reading.
