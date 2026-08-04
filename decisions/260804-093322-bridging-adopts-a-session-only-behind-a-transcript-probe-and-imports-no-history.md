---
id: 260804-093322
title: Bridging adopts an existing session only behind a transcript probe, and never imports platform history
status: proposed
created: 2026-08-04
spec: chats-as-channels
superseded-by: null
---

# 260804-093322. Bridging adopts an existing session only behind a transcript probe, and never imports platform history

## Status

Proposed. Consistent with ADR-0310 (session storage is runtime-owned). To be accepted when the `chats-as-channels` spec reaches `implemented`.

## Context

Bridging a chat that already has a live session should not make the agent forget the conversation so far - adopting the existing session as the room's `(room, agent)` session is attractive. But `BindingRouter` is not an `onProjectorRekey` listener, so a session id in `sessions.json` can name a session that was rekeyed out from under it, and the in-process session map is empty after a restart - precisely when a person is most likely to be setting a bridge up. Meanwhile Telegram gives bots no history read, so there is no honest way to backfill the room log with messages DorkOS never witnessed.

## Decision

We will adopt an existing session only behind a **durable transcript probe**: find the single `{bindingId}:chat:{chatId}` entry, then confirm via `TranscriptReader.hasTranscript` - the JSONL-on-disk signal, per runtime, never the in-process map - that a real transcript exists with a matching runtime type. Probe passes, we write it into the room-session ledger and post a notice that the conversation continues here; probe fails, we start fresh and post the same notice minus the pointer. The **room log does not gain the old messages** - copying a runtime-owned transcript into the room would be DorkOS asserting a record it did not witness, and the notice says so plainly.

## Consequences

### Positive

- Adoption survives a restart, because the probe reads the durable on-disk transcript rather than the empty in-process map - the exact moment a naive check would fail.
- A stale or rekeyed session id fails the probe and starts fresh instead of resuming the wrong conversation.
- The room log stays an honest record of only what DorkOS witnessed; no fabricated history.

### Negative

- The probe is per-runtime: only claude-code answers it today, so other runtimes always take the fresh-start path rather than guessing - a deliberate limit, not a bug, but it means adoption is uneven across runtimes.
- The adopted session's private transcript and the room log can diverge; the room log is authoritative, and nothing reads the transcript except this probe.
