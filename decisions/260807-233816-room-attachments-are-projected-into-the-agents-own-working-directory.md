---
id: 260807-233816
title: Room attachments reach agents as files projected into the agent's own working directory
status: draft
created: 2026-08-07
spec: room-attachments
superseded-by: null
---

# 260807-233816. Room attachments reach agents as files projected into the agent's own working directory

## Status

Draft (auto-extracted from spec: room-attachments)

## Context

Attachment paths are delivered to room agents automatically with the entry, with no opt-in step
(locked at the 2026-08-07 spec review). The bytes live at `<dorkHome>/rooms/<roomId>/attachments/`,
which is outside every agent's working directory: a room turn runs with `cwd: request.agentPath`
(`room-turn-runner.ts`). Handing the model an absolute path therefore asks a runtime to read outside
its cwd, which is what a runtime asks permission for — and in a room that parks the turn on
`awaiting_approval` until a person acts. An approval prompt IS an opt-in step, so absolute paths
would make the locked decision false in practice. The alternative of granting the directory per turn
means widening the `AgentRuntime` port with a filesystem-grant concept, then implementing it three
different ways — `settings.permissions` for claude-code, something else for codex and opencode — and
gating it in `runtimeConformance`. Chat, meanwhile, already ships the shape that works: the file sits
inside the working directory and the agent is told a relative path (ADR-0100).

## Decision

Before a triggered room turn starts, the turn runner **projects** every attachment that turn's
context window mentions into that agent's own tree, at
`{agentPath}/.dork/.temp/room-attachments/{entryId}/{attachmentId}-{name}`.

<!-- Amended 2026-08-16 (DOR-1266): the path the model is TOLD is now that same location spelled
     absolute. See the amendment at the end of this record; the paragraph below is the original. -->

The projection hardlinks
when the source and destination share a filesystem — which they normally do, since `<dorkHome>` and
the default agents directory are both under `~/.dork` — and falls back to a copy on `EXDEV`/`EPERM`,
or to a fetch when the store's `localPath` answers `null`. It is idempotent (an existing projection
is left alone), scoped to the same capped 30-entry window `room-context.ts` builds, and sweeps entry
directories older than 24 hours on each run so no scheduler is introduced. `RoomContextEntry` carries
`{ name, path }` where `path` is **relative** to the agent's working directory — identical for every
agent, a pure function of the entry id and the stored filename — which is what lets `room-context.ts`
stay pure and knowing of no cwd. (**Amended 2026-08-16, DOR-1266:** the rendered `path` is now
cwd-absolute and `room-context.ts` takes `agentPath`, so this sentence's purity claim no longer
holds — see the amendment below; the projection PLAN is still relative and still agent-independent.) One shared helper computes that path for both the projector and the
context builder, so what the model is told and what is on disk cannot drift.

## Consequences

### Positive

- "Automatic" is true: the agent reads the file on the first try, with nothing to approve.
- It works identically on claude-code, codex, and opencode, because it uses no runtime feature at
  all — the `AgentRuntime` port is untouched and `runtimeConformance` gains nothing to gate.
- It is the shape chat already ships and every agent already handles (ADR-0100), so consistency is
  gained rather than spent.
- A hardlink costs an inode and no bytes, and a re-trigger costs one `stat` per file.
- Only what the model is actually shown is projected, so every path in a turn's context is one that
  turn can open — there is no half-state where the agent is told about a file it cannot read.

### Negative

- DorkOS writes into an agent's working tree to deliver a message, which is a coupling the room
  domain did not previously have.
- A copy is a real duplicate when the fallback fires (cross-device, or a remote store), bounded by
  the configured `maxFileSize × maxFiles` per entry.
- The 24-hour sweep is a rule someone has to know about: an agent that is never triggered again keeps
  its projections until something else in that agent's tree triggers a run.
- The relative path leaks DorkOS's temp-directory layout into the model's context, and a future move
  of that directory is a change in two places even with the shared helper.
- An agent could read another entry's projected file by listing the directory, so the projection is
  scoped by what it contains rather than by permissions — acceptable because everything in it is
  already something that agent's room told it about.

## Amendment — 2026-08-16 (DOR-1266): the path the model is told is cwd-absolute

**What changed.** The decision above says `RoomContextEntry` carries a path **relative** to the
agent's working directory. It now carries `path.join(agentPath, <that same relative path>)` —
absolute, and still pointing inside the same working directory at the same file. The projector is
unchanged, and so is the shared helper: `projectedAttachmentPath` still computes the relative path
and is still the one expression both sides use, joined onto `agentPath` the same way in both.

**Why the original was wrong in practice.** "Relative to the agent's working directory" is only
openable by a reader who knows what it is relative to, and a live eval measured that the reader does
not: told `.dork/.temp/room-attachments/…`, the agent resolved it against the DorkOS home instead of
its own cwd and got "File does not exist". The rerun with the absolute form opened the file on the
first `Read`. Nothing is disclosed by this that the agent did not already have — it is its own cwd.

**What this amendment does NOT give up.** The worry that motivated the decision was reading OUTSIDE
the working directory, because that is what parks a turn on `awaiting_approval` and makes
"automatic" false. That is untouched: the path is inside the cwd, the file is still brought to the
agent rather than the agent sent to the file, and the `AgentRuntime` port still gains nothing.
Confirmed on claude-code by the live rerun (`rooms-recall-attachment`, 2026-08-17).

**What it does give up, and what is unverified.**

- **The purity property is gone.** The decision called the path "identical for every agent, a pure
  function of the entry id and the stored filename — which is what lets `room-context.ts` stay pure
  and knowing of no cwd". `buildRoomContext` now takes `agentPath` and its output is per-agent. The
  PLAN it returns (`ProjectableAttachment.relativePath`) stays relative and stays agent-independent,
  so the projector still knows no cwd.
- **codex and opencode are UNVERIFIED for the absolute form.** The original claim of working
  "identically on claude-code, codex, and opencode" rested on the path being relative and on no
  runtime feature being used. An absolute path inside the cwd should be equally readable on all
  three, and nothing in their sandboxes is known to forbid it — but only claude-code has actually
  been driven end to end. Do not restate the three-runtime claim as measured until it is.
- **A working directory that survives sanitizing unchanged is now load-bearing.** The path renders
  through `sanitizeIdentity` like every label outside the untrusted fence, and that collapses
  whitespace runs — so a directory containing a tab or two consecutive spaces would render a path
  that does not open. Sanitizing anyway is deliberate (a directory named `</room_context>` is legal
  on POSIX, and the region is trusted only because everything in it was sanitized), so the residual
  is made LOUD instead: `room-context-block.ts` logs
  `[rooms] an attachment path was changed by sanitizing and may not open` with the path. Before this
  amendment every component was server-generated `[a-zA-Z0-9._-]` and the case could not arise.
