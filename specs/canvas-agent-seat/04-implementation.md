# Implementation Summary: The agent's seat at the canvas and the browser

**Created:** 2026-09-13
**Last Updated:** 2026-09-13
**Spec:** specs/canvas-agent-seat/02-specification.md
**Umbrella:** DOR-2004 (Linear project "Canvas and Browser in Rooms")

## Progress

**Status:** Complete
**Tasks Completed:** 6 / 6

Every phase ran in its own worktree, passed an adversarial review per `REVIEW.md` before its PR opened (every phase needed at least one fix round; every fix was pinned by a test that fails without it), and was verified in a browser. The spec landed in PR #1810.

## Tasks Completed

- 1.1 DOR-2006 — [Q1] The session canvas moves to the server, and the `ui` capability domain opens — PR #1822
- 1.2 DOR-2007 — [Q2] An agent drives the embedded browser through the in-page shim — PRs #1814, #1816
- 2.1 DOR-2008 — [Q3] Record a browser run as a GIF, and let an agent post a file to a room — PR #1821
- 2.2 DOR-2009 — [Q4] Every runtime gets the same canvas and browser seat (the `ui` capability domain) — PR #1830
- 3.1 DOR-2010 — [Q5] Follow a teammate's browser, and discuss a document — PR #1825
- 3.2 DOR-2011 — [Q6] Merge an agent's work from the diff, and put a document on another room — PR #1824

## What shipped

- **The session canvas lives on the server** (ADR `260912-025249`): one `canvas_documents` table for rooms and sessions (migration `0097`), one writer (`services/canvas/`), a seq'd `canvas` session event replayed gap-free, six session canvas routes, live sync across windows, a one-time per-document import of the old `localStorage` copy, `get_ui_state` reporting what the server holds.
- **An agent can act on its own preview** (ADR `260912-025251`): `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_wait_for`, `browser_read_page` through the shim's `act-request` arm, one driver seat per session arbitrated on the server (a keep-alive never moves it; only a person's own action in a window does), instant refusal on an uninstrumented page. Recording (`browser_record_start`/`browser_record_stop`, GIF via `gifenc`, bounded, honest about missed frames) and `post_to_room.attachments` (paths inside the agent's own cwd, bound in the entry's transaction, refused posts take their bytes back).
- **Every runtime has the same seat** (ADR `260912-025252`): `control_ui`, `get_ui_state`, the reads, the screenshot, the six driving verbs and the two recording tools are capabilities in the `ui` domain, keyed by the calling session, reached by Claude Code, Codex and OpenCode through the loopback server; Codex's separate `dorkos_ui` server is retired; the "reaches past the screen" refusal is a surface rule.
- **Follow mode and document threads**: a `presence` signal with discriminated `view`/`follows` payloads (no new signal names), publish-only-while-followed with a beat on the shared live-beat constant, people only, cleared on blur/close/leave/silence, never moving an editor; Discuss posts one system root bound to the document in the same transaction, and a thread turn's context narrows to that document.
- **Merge preview** (ADR `260912-025253`): worktree-vs-main for a diff ahead of main, an operator-only merge action posting one line and waking nobody, any person can send a hunk back through people-only, symlink-safe document routes; `control_ui.target: { roomId }` puts a document on another room the agent belongs to, with a per-turn ledger and one coalesced line.

## Defects the process caught before landing

Server file documents skipping viewer resolution; a refused re-open deleting a held document; the Obsidian embed writing a read-only database; a partial `localStorage` import losing a document; the driver seat flapping between two windows on every keep-alive; a recording reporting success for unfilmed actions; staged attachment bytes leaking on a refused post; a follow dying after 30 s of a still leader; an agent able to write another member's working copy through the new diff route; a symlink escape in its containment check; two read tools advertising no arguments through a barrel import cycle; a follower's scroll hijacked by a stale position; diffs from non-Claude-Code turns never recording how far ahead of main they were.

## Follow-ups

- DOR-2012 / DOR-2013: three real-filesystem watcher tests and one browser spec flake under load; they cost most pushes a local-gate bypass and several queue cycles.
- The e2e leg for a first-turn rename of a session with open canvas documents; a narrow pre-attach 404 on a never-used session (both named on DOR-2006).
- The docs-copy scanner for Settings labels reds on a legitimately bolded phrase near the instruction (named on DOR-2009).
