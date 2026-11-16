---
slug: channel-sender-identity
id: 260721-215837
created: 2026-07-21
status: ideation
---

# Forward Channel Sender Identity into Prompts and Session UI

**Slug:** channel-sender-identity
**Author:** Claude (orchestrator) for Dorian
**Date:** 2026-07-21
**Tracker:** DOR-411

---

## 1) Intent & Assumptions

- **Task brief:** When a Telegram or Slack message triggers an agent session through Relay, the agent has no idea who it is talking to — `senderName` and `channelName` are captured at the inbound adapter but dropped before the prompt is built. The cockpit likewise can only say "Telegram", never "Telegram · Dorian". Forward sender identity into (1) the prompt the agent reads and (2) the session `originLabel` the cockpit shows (DOR-408 surface).
- **Assumptions:**
  - Sender identity is advisory display/context data, never a security boundary — the same posture as ADR 260721-153851 (session origin).
  - The derive-at-read-time architecture from DOR-408 is the right vehicle: whatever the producer bakes into the `<relay_context>` transcript head, the classifier can recover with zero extra IO.
  - Old sessions (no `Sender:`/`Chat:` lines) degrade gracefully to the current plain platform label.
- **Out of scope:**
  - The webhook adapter — it publishes an ad hoc payload with no identity fields; any caller identity lives in an arbitrary `data` blob. Nothing to forward.
  - `senderAvatar` — defined in `StandardPayloadSchema` but never populated by any adapter; populating it is separate work.
  - A persisted chat-title/user-name side-store (bindings.json / agent-sessions.json enrichment) — not needed once identity rides the transcript.
  - Client component changes — `originLabel` already flows through `OriginMark`/`SessionHeader` as an opaque string.

## 2) Pre-reading Log

- `packages/relay/src/adapters/telegram/inbound.ts:143-166` — builds `StandardPayload` with `senderName` (first+last → username → 'unknown'), `channelName` (chat title, groups only), `channelType`, `platformData` (chatId, fromId, username).
- `packages/relay/src/adapters/slack/inbound.ts:583-606` — same shape; `resolveUserName` via `users.info` (display_name → real_name → name → id), 1h cache; `channelName` resolved for groups only.
- `packages/shared/src/relay-envelope-schemas.ts:123-139` — `StandardPayloadSchema` already declares `senderName`, `channelName`, `channelType`, `senderAvatar` (unpopulated); no schema change needed.
- `packages/relay/src/lib/payload-utils.ts:25-39` — `extractPayloadContent` pulls only `content`/`text`; identity fields silently discarded here.
- `packages/relay/src/adapters/claude-code/agent-handler.ts:416-443` — `formatPromptWithContext` builds the `<relay_context>` header (`Agent-ID`, `Session-ID`, `From:` = raw subject string, `Message-ID`, `Subject`, `Sent`, budget lines). Never reads `envelope.payload` identity fields. **This is the gap.**
- `apps/server/src/services/runtimes/claude-code/sessions/classify-origin.ts` — channel branch returns hardcoded literals (`'Telegram'`, `'Slack'`, `'Webhook'`, `'Channel'`) from a case-insensitive substring match on the `From:` value.
- `apps/server/src/services/runtimes/claude-code/sessions/__tests__/classify-origin.test.ts:4-28` — the DOR-408 coupling fixture mirroring `formatPromptWithContext`'s exact line format; must be updated in lockstep with any format change (explicit comment in file).
- `apps/client/src/layers/entities/session/ui/OriginMark.tsx`, `SessionHeader.tsx` — `label ?? descriptor.label`; server `originLabel` renders directly in the chip and tooltips. No client change needed.

## 3) Codebase Map

- **Producer:** `packages/relay` — `agent-handler.ts` (`formatPromptWithContext`), `payload-utils.ts` (new identity extractor helper).
- **Consumer:** `apps/server` — `classify-origin.ts` (parse `Sender:`/`Chat:` lines, compose enriched channel label).
- **Data flow:** Telegram/Slack inbound → `StandardPayload{senderName, channelName}` on `RelayEnvelope.payload` → `formatPromptWithContext` bakes `Sender:`/`Chat:` lines into `<relay_context>` → persisted in SDK JSONL transcript head → `classifyOrigin` head-scan recovers them → `originLabel: "Telegram · Dorian"` → client chip/tooltip.
- **Blast radius:** relay agent-handler prompt format (every relay-triggered session's first message), classifier output, the DOR-408 fixture test, `context-roundtrip.test.ts` (different mechanism — verify no drift, likely untouched).

## 4) Root Cause Analysis

Omitted — not a bug fix (capability gap by design of the original prompt path).

## 5) Research

- **Potential solutions:**
  1. **Transcript-head lines (producer + consumer), derive at read time** — add `Sender:`/`Chat:` to the `<relay_context>` block; classifier parses them back out. Pros: zero new IO, zero new storage, retroactive-safe (old sessions degrade), the agent gets the identity in-prompt for free, single mechanism already proven by DOR-408. Cons: heuristic coupling to marker text (mitigated by the existing lockstep fixture test).
  2. **Persisted side-store** (enrich bindings.json or a new map keyed by chatId with chat titles/user names, read at session-list time). Pros: label available even if the prompt format never changes. Cons: new storage + reconciliation, doesn't inform the _agent_ at all (misses half the ticket), more moving parts.
  3. **Structured additionalContext entry** (the ADR-0273 context channel). Pros: structured. Cons: that channel is for MCP-injected context, not the inbound prompt header; the classifier reads transcript text, so it would still need a text marker; more plumbing for no gain.
- **Recommendation:** Solution 1. It solves both halves of the ticket with one mechanism and no new state.

## 6) Decisions

| #   | Decision                         | Choice                                                                                                                                                           | Rationale                                                                                                                                         |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where identity enters the prompt | `formatPromptWithContext` appends `Sender: <name>` and `Chat: <title>` lines directly after `From:`, only when present on the payload                            | Agent-to-agent envelopes lack these fields, so their format is byte-identical to today; channel prompts gain exactly the two lines that matter    |
| 2   | Payload access                   | A small typed helper `extractSenderIdentity(payload)` in `payload-utils.ts` (safe-parse of the identity subset), unit-tested; `extractPayloadContent` untouched  | Keeps the generic content extractor generic; the identity concern gets its own seam                                                               |
| 3   | Header-injection hardening       | Sanitize both values: strip CR/LF and control chars, collapse whitespace, cap at 80 chars, drop if empty after sanitizing                                        | Sender names are attacker-influenced text entering a structured header block; a name containing a newline must not forge `Reply to:`/budget lines |
| 4   | Label composition rule           | Channel origins: `"<Platform> · <chat ?? sender>"` — chat title wins when present (groups), sender name otherwise (DMs); plain platform when neither line exists | Matches how humans name conversations: group chats by title, DMs by person; old transcripts keep today's labels                                   |
| 5   | Label length                     | Classifier caps the composed label at 60 chars                                                                                                                   | It renders in a breadcrumb chip and tooltips; unbounded input text must not blow up the UI                                                        |
| 6   | 'unknown' sender                 | If the sanitized sender is `unknown` (the adapters' fallback), omit the suffix — label stays plain `"Telegram"`                                                  | "Telegram · unknown" is worse than "Telegram"                                                                                                     |
| 7   | Fixture lockstep                 | Update `classify-origin.test.ts`'s `relayContext()` fixture to the new format and add `Sender:`/`Chat:` cases; add a symmetric fixture test on the producer side | The DOR-408 coupling test exists precisely to catch this drift; the change must go through it, not around it                                      |
| 8   | Storage                          | None — no bindings.json/agent-sessions.json enrichment                                                                                                           | Derive-at-read-time (ADR 260721-153851) already covers it                                                                                         |
| 9   | Client                           | No component changes; existing `originLabel` plumbing renders the enriched string                                                                                | Verified: `OriginMark`/`SessionHeader` treat the label as opaque text                                                                             |

**Next step:** SPECIFY — the decisions above are complete; no open questions for the operator.
