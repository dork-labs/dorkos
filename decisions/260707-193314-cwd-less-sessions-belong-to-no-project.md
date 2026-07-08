---
id: 260707-193314
title: A cwd-less session belongs to no project; runtimes floor the turn cwd at the server root
status: accepted
created: 2026-07-07
spec: null
superseded-by: null
---

# 260707-193314. A cwd-less session belongs to no project; runtimes floor the turn cwd at the server root

## Status

Accepted

## Context

Two orphan `codex_threads` rows (NULL `cwd`, NULL `title`) rendered as nameless "ghost" sessions under **every** agent in the dashboard sidebar (DOR-202). Three compounding rules produced this:

1. `CodexSessionRegistry.list(projectDir)` (and its mirror in test-mode) implemented "a cwd-less session cannot be attributed to any project" as `s.cwd === undefined || s.cwd === projectDir` — i.e. it fanned unattributable sessions into **every** project's list.
2. The Codex adapter could bind a thread with no cwd at all: `POST /sessions/:id/messages` accepts an optional `cwd`, and the adapter's resolution chain (send opts → registry → persisted binding) had no floor, so `setThreadId` persisted NULL-cwd rows. The Claude adapter never had this hole — it floors on a constructor-injected root (`opts?.cwd || session.cwd || this.cwd`).
3. Client surfaces disagreed on membership: the Agent Hub filtered `s.cwd === projectPath` (ghosts hidden) while the dashboard sidebar and session sidebar applied no cwd scoping (ghosts shown), so the same data rendered differently per surface (DOR-203).

## Decision

**Read side — "no project", not "every project".** A tracked session without a cwd is returned by `list(projectDir)` for **no** projectDir (exact match only), in every tracked-session registry: `CodexSessionRegistry`, `OpenCodeSessionRegistry`, and `TestModeSessionRegistry`. It stays reachable by id (`get`/`getSession`), so it is hidden, not lost. The rule is pinned cross-runtime by the shared conformance suite (`runtimeConformance`), not just per-adapter tests.

**Write side — every runtime turn resolves a real cwd.** `CodexRuntime` takes a `defaultCwd` (defaulting to the server's resolved root, `DEFAULT_CWD`) as the floor of its turn-cwd resolution chain, mirroring the Claude adapter. Every thread bind now persists a real cwd; NULL-cwd rows can no longer be minted. Legacy NULL-cwd rows resume in the default root and are **durably backfilled** on that turn (`CodexThreadMap.backfillCwd`, NULL-guarded so the first-write-wins binding is never overwritten) — the session stays on the list across restarts. Claude transcript-derived sessions likewise always carry a cwd: `TranscriptReader.listSessions` attributes a head-record-less transcript to the project directory it was listed from.

**Client — one membership rule.** `selectAgentSessions(sessions, projectPath)` in the session entity (exact `cwd === projectPath`, newest-first) is THE per-agent membership rule; `useAgentSessions(projectPath)` wraps it for React consumers. All surfaces (dashboard sidebar, session sidebar, Agent Hub, agents list, command palette) consume it instead of filtering `useSessions()` themselves.

**Rendering — never a blank row.** A title-less session renders as "Untitled session" via `sessionDisplayTitle()` rather than a bare timestamp; sessions are not hidden for lacking a title (a just-created session is legitimately title-less until its first message derives one).

## Consequences

- Ghost sessions disappear from every agent list; per-agent membership is identical on every surface.
- A session created via `ensureSession` without a cwd is invisible in project lists until its first turn attributes it — an accepted trade: "unattributable" no longer means "everywhere".
- Cwd-less durable rows written by older builds no longer appear in any list; blank orphans can be deleted (`DELETE FROM codex_threads WHERE cwd IS NULL AND title IS NULL`), and rows with real content permanently resurface under the default root on their next turn (the cwd backfill is durable, not per-process).
- The old "omit `workingDirectory` on legacy resume" degradation is gone: a legacy resume now runs in the server root instead of the server process's cwd — a deliberate, more predictable behavior.
