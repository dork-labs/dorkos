---
id: 261017-153539
title: One memory per agent — Claude Code auto-memory off on agent turns; DorkOS memory gains notes files
status: accepted
created: 2026-10-17
spec: agent-memory
superseded-by: null
amends: [0273]
---

# 261017-153539. One memory per agent — Claude Code auto-memory off on agent turns; DorkOS memory gains notes files

## Status

Accepted (operator decision 2026-10-17, from the core-skills study `research/20261017_core-skills-recommendation.md` §8, "One memory per agent"; design reviewed by the designer agent).

**Amends:** [0273](0273-runtime-neutral-context-injection.md): `excludeDynamicSections` does not drop Claude Code's auto-memory, as decision A2 assumed. It moves the working-directory, auto-memory and git-status sections out of the system prompt into the first user message (SDK 0.3.280, the `systemPrompt` docs). Auto-memory is now switched off separately. Whether git status is still sent twice is a separate question, left to its own ticket.

## Context

Every DorkOS Claude Code turn kept two memories: the agent's DorkOS memory (`.dork/MEMORY.md`, capped at 8,000 characters, injected and fenced, written through `memory_write` with DorkOS-written stamps and the outsider rule) and Claude Code's own auto-memory (`<account>/projects/<slug>/memory/`, a `MEMORY.md` index plus topic files). Only teammate turns switched the second one off (DOR-2955). Agents reported notes split across both, and the two most active agents' DorkOS memory files were at the cap.

Pointing Claude Code's `autoMemoryDirectory` at the agent's folder was possible (the CLI honours it from the SDK's flag settings), but its writes are plain file writes: no stamp, no outsider rule, no cap, an unfenced index in the prompt, and only on one of the three runtimes.

## Decision

1. **Claude Code's auto-memory is off for every turn that runs as an agent**, by `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, which the CLI checks before any setting layer. Two cases keep it: a plain-folder session, which has no DorkOS memory to use instead, and an agent whose Claude Code memory folder (for the account the turn launches with) still holds notes and no "moved" marker, so an upgrade never hides notes nobody has copied yet.
2. **DorkOS memory gets a second level: notes files**, `<agentPath>/.dork/memory/<name>.md`, never injected. `memory_write` takes an optional `note` (a whitelisted name, resolved only by the engine's jail) and, to create one, a required one-line `description`. A new `memory_read` lists notes newest first, 50 at a time with a cursor and a `query` filter, or opens one; what it returns is fenced as data. Both tools reach Codex and OpenCode over the external server too. Stamps, the outsider rule and the privacy wording apply to notes exactly as to `MEMORY.md`. A note may hold 32,000 characters.
3. **The memory block names the notes**: one DorkOS-written line with the count, and the three most recently changed names inside a fence, because a name is the agent's own text. Above 150 notes it adds a nudge to tidy up. It is advice only, and notes a migration copied in during the last week do not count toward it. Removing a note's last line deletes the note, so tidying can bring the count down.
4. **The port grows a `notes` capability** gating `listNotes`, `readNote` and a write or forget that names a note; the conformance suite asserts both branches.
5. **A one-time migration copies Claude Code's memory folders into agents' notes** (`pnpm --filter @dorkos/server migrate:claude-memory`), mapping each folder to the agent whose path has its slug. It is a dry run by default. It never edits or deletes an original, never overwrites a note, and never writes `MEMORY.md`; it leaves a marker file in each old folder whose every copy succeeded, and that marker is what lets item 1 switch Claude Code's memory off for the agent. A second run skips marked folders. Folders no agent matches, or two agents share, are reported and left alone, and so are folders in a named account (`~/.claude-<name>`, often a work account kept apart on purpose) unless `--include-account <name>` asks for them. The real run waits for a person's go after the dry-run report. It is a repo script for now; a way to run it from the app is follow-up work.

## Consequences

### Positive

- One memory per agent, on every runtime, with the same trust rules everywhere.
- Detail that does not fit in 8,000 characters has a home that costs no prompt space.
- Notes files carry their own `.gitignore`, so they are never committed in a repo an agent lives in.

### Negative

- Agents lose a habit Claude Code taught them; the session-model block and the tool descriptions carry the replacement.
- A bare `claude` session started outside DorkOS in an agent's folder still writes Claude Code's memory. Only a person can change that, in their own settings.
- Until an agent's old Claude Code notes are copied, it still has two memories. For a person without the repo there is no way to copy them yet.
- Listing notes reads the first 4 KB of every notes file on the way into a turn. At a few hundred notes this is milliseconds; a much larger folder would want an index.
