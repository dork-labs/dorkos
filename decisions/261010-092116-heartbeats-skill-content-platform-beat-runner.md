---
id: 261010-092116
title: Heartbeats are a skill-shaped HEARTBEAT.md plus a platform beat runner; beats end with end_beat
status: accepted
created: 2026-10-10
spec: heartbeats
superseded-by: null
amends: [261001-000811]
---

# 261010-092116. Heartbeats are a skill-shaped HEARTBEAT.md plus a platform beat runner; beats end with end_beat

## Status

Accepted (operator decisions 2026-10-07, confirmed 2026-10-10; Linear DOR-2788). Design canon: `meta/PROACTIVE-AGENTS.md` §5, §9 and §10.

**Amends:** [261001-000811](261001-000811-credits-are-a-runs-on-choice-not-a-flag.md): DorkOS credits can now also pay for a beat's cheap check, under the same rule that a person chose it.

## Context

DorkOS agents are co-workers who should keep working between conversations: wake on a beat or an event, notice what changed, act inside their job, and report up. The obvious build is a scheduled skill: skills already take a `schedule:` block. Role-plays showed why that fails: every quiet beat is a full agent turn (a coding agent's quiet beats used most of a weekly Claude plan in three days), it only wakes at fixed times, every quiet run fills run history, a schedule found in a file waits for a person's approval, and each run is alone, so nothing can hold a 2am message for the morning or drop a fact two agents both noticed. OpenClaw, the most-copied heartbeat, also showed that ending a quiet beat with a magic word leaks: the marker reached a Telegram chat, and a made-up reply was delivered as a real alert.

## Decision

- **The content is a skill.** `<agent>/.dork/HEARTBEAT.md`, a convention file beside `SOUL.md`, `NOPE.md` and `MEMORY.md`, skill-shaped (frontmatter plus body): how the agent wakes (`timed`, `events`, `off`), which gatherers it uses, its report rhythm, and in prose what to watch, how to judge, what it never does unasked and the report shape. Templates per agent type ship it; agents and people edit it; it is read only by beats, never injected into ordinary turns. No file means events only.
- **The beating is platform,** a new server domain `services/heartbeats/`: timers with adaptive cadence and event wakes, code-only gatherers, triage on the decision-model ladder (`packages/decisions`, wired into the server for the first time under `services/decisions/`), a turn on the agent's own runtime only when triage says so, holding messages to people for their hours and batching them per agent, de-duplication across agents, raise-once, away states, and one audit row per beat. Only agents on a runtime this server runs beat, and messages from outsiders never wake one.
- **A beat ends with a tool call.** `end_beat` takes a summary for the record and a list of raises, each with its rung (report, room, DM, note) and an urgency flag. It is callable only from a heartbeat-origin turn, and it is the only way a beat's words reach a person: free text in the beat chat goes nowhere, and a turn that never calls it delivers nothing.
- **A new turn origin, `heartbeat`,** seeded with the operator's configured stop on insert, like a room turn: trusted by default, nobody waiting to answer a prompt. Beat turns run unattended, count toward the machine's live-launch cap, and run in one beat chat per agent per local day, which a person can open.
- **Triage may spend DorkOS credits** for agents on any runtime (operator approval 2026-10-07), but only after a person answers a one-time offer with **Use credits**; until then, and without credits, built-in rules decide what they can and the rest goes to the agent's own runtime: unsure goes up, never down to silence. Where checks run is shown live on every agent's Heartbeat page.
- **Reports-to and the person's hours.** Every agent manifest gains an optional `reportsTo` and a machine-written `createdBy`; unset reports to the creator, then the owner, and every chain ends at a person (cycles refused). A person's time zone, working hours and away state live on their profile; hours decide when a message to a person is delivered, never when work happens.
- **Commitments** are a table any member can read, written through tools by the agent that promised, and measures (kept rate, useful-raise rate, interruptions per useful outcome, mutes and pauses) are computed from the record, never from the agent's account of itself.

## Consequences

- Most beats cost nothing: plain code finds no change and the beat ends with a record line. Proactivity can be the default for every agent instead of a premium feature.
- Existing agents change behavior only on events after upgrade; timed beats start for new agents from their template, or when a person or agent writes `wake: timed`.
- DorkOS credits can now pay for something a person did not start by typing, so it needs their yes first, is shown live, and is named in `AGENTS.md`'s money table.
- Messages from several agents due to one person at the same moment arrive in the same minute, one per agent; a single roll-up across agents is left to lead agents and a follow-up.
- `end_beat` makes "the agent decided to tell someone" a structured, countable act, which is what the useful-raise and interruption measures need.
- The loop watcher (DOR-2745) gets an observer on finished beats instead of special cases; pause everywhere (DOR-2738 PR 5) is honored through one seam.
- Rejected: a plain scheduled skill (cost, approval, no manners); a magic-word quiet reply (leaks); injecting `HEARTBEAT.md` into every turn (cost for every conversation); a separate permission system for beats (trusted by default; the record is the net); built-in spending caps (decision 10.4: limits live on the card an agent carries).
