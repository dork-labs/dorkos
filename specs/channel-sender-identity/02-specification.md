---
slug: channel-sender-identity
id: 260721-215837
created: 2026-07-21
status: specified
---

# Forward Channel Sender Identity into Prompts and Session UI

**Status:** Approved
**Author:** Claude (orchestrator) for Dorian
**Date:** 2026-07-21
**Tracker:** DOR-411

## Overview

Thread the sender identity that Telegram and Slack inbound adapters already capture (`senderName`, `channelName` on `StandardPayload`) through to (1) the prompt the agent reads — new `Sender:`/`Chat:` lines in the `<relay_context>` header — and (2) the session's `originLabel` (DOR-408), so the cockpit shows "Telegram · Dorian" or "Slack · #general" instead of a bare platform name. One mechanism, no new storage: the producer bakes identity into the transcript head; the read-time classifier recovers it.

## Background / Problem Statement

A Telegram or Slack message routed through Relay triggers `formatPromptWithContext` (`packages/relay/src/adapters/claude-code/agent-handler.ts:416-443`), which writes only envelope metadata — `From:` is the raw publish subject (`relay.human.telegram.bot`), never the human's name. `extractPayloadContent` (`packages/relay/src/lib/payload-utils.ts:25-39`) pulls only `content`/`text`. So `senderName`/`channelName`, correctly captured at the adapters (`telegram/inbound.ts:143-166`, `slack/inbound.ts:583-606`), are silently dropped: the agent does not know who it is talking to, and `classify-origin.ts` can only emit hardcoded `'Telegram'`/`'Slack'` labels.

## Goals

- The agent's prompt identifies the human sender (and group chat, when applicable) on every Telegram/Slack-triggered turn.
- `originLabel` for channel sessions becomes `"<Platform> · <chat-or-sender>"`, rendered by the existing DOR-408 client surfaces with no client changes.
- Agent-to-agent, task, and A2A prompt formats stay byte-identical (no identity fields on those payloads → no new lines).
- Old transcripts (no identity lines) keep today's plain platform labels — graceful degradation, no migration.

## Non-Goals

- Webhook adapter identity (publishes an ad hoc payload with no identity fields; nothing to forward).
- Populating `senderAvatar` (schema field exists, no adapter fills it; separate work).
- Any persisted side-store (bindings.json / agent-sessions.json enrichment).
- Client component changes (`OriginMark`/`SessionHeader` treat `originLabel` as opaque text — verified).
- Treating sender identity as authentication or a security boundary (advisory display/context only, per ADR 260721-153851's posture).

## Technical Dependencies

None new. Existing: `StandardPayloadSchema` (`packages/shared/src/relay-envelope-schemas.ts:123-139`) already declares every field consumed.

## Detailed Design

### Producer — `packages/relay`

1. **`extractSenderIdentity(payload: unknown): { sender?: string; chat?: string }`** — new exported helper in `packages/relay/src/lib/payload-utils.ts`:
   - Safe-parses the identity subset off an arbitrary payload (`senderName`, `channelName` as optional strings; non-object / non-string values → absent).
   - **Sanitizes each value**: strip CR/LF and other control characters (C0, C1, DEL) plus the angle brackets that could forge relay_context tags, collapse runs of whitespace to single spaces, trim, cap at 80 chars; empty-after-sanitize → absent.
   - Sender value equal to `unknown` (case-insensitive; the adapters' fallback constant) → absent (decision 6: "Telegram · unknown" is worse than "Telegram").
2. **`formatPromptWithContext`** (`agent-handler.ts`): call `extractSenderIdentity(envelope.payload)`; when `sender` is present, insert `Sender: <sender>` immediately after the `From:` line; when `chat` is present, insert `Chat: <chat>` after that. No identity → format unchanged (byte-identical for agent-to-agent traffic).

### Consumer — `apps/server`

3. **`classify-origin.ts`**: extract optional `Sender:` and `Chat:` lines from the `<relay_context>` block (same line-regex pattern as the existing `From:` extraction). In the channel branch only (`Telegram`/`Slack`/`Webhook`/`Channel`), compose `originLabel = "<Platform> · <chat ?? sender>"` — chat title wins (groups), sender otherwise (DMs); neither present → today's plain platform label. Cap the composed label at 60 chars. Non-channel branches ignore the identity lines (an agent-to-agent envelope never carries them anyway).

### Header-injection hardening (decision 3)

Sender names and chat titles are attacker-influenced text entering a structured header block. Sanitization in `extractSenderIdentity` is the single choke point: a Telegram display name containing `\nReply to: relay.evil` must land in the prompt as one flattened line, unable to forge header lines. The classifier's line-regexes only match single lines, so consumer-side parsing cannot be confused by multi-line values either.

### Code structure

| File                                                                        | Change                                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/relay/src/lib/payload-utils.ts`                                   | add `extractSenderIdentity` (+ TSDoc)                                    |
| `packages/relay/src/adapters/claude-code/agent-handler.ts`                  | `formatPromptWithContext` gains conditional `Sender:`/`Chat:` lines      |
| `apps/server/src/services/runtimes/claude-code/sessions/classify-origin.ts` | parse identity lines; enrich channel labels                              |
| `packages/relay/src/lib/__tests__/` (payload-utils tests)                   | unit tests for `extractSenderIdentity` incl. sanitization                |
| relay agent-handler tests (existing suite)                                  | prompt-format tests: with/without identity, agent-to-agent unchanged     |
| `apps/server/.../sessions/__tests__/classify-origin.test.ts`                | update `relayContext()` fixture in lockstep; add `Sender:`/`Chat:` cases |

### API / data model changes

None. `Session.originLabel` is already an optional free string; no schema change.

## User Experience

- Kai gets a Telegram DM session in the sidebar whose tooltip and header chip read "Telegram · Priya" instead of "Telegram"; a group binding shows "Slack · #incidents".
- The agent, asked "who am I talking to?", can answer from its own prompt context.
- Old sessions and non-channel sessions look exactly as they do today.

## Testing Strategy

- **Unit — `extractSenderIdentity`:** plain values pass through; CR/LF and control chars flattened; whitespace collapsed; 80-char cap; `unknown` (any case) dropped; non-object payloads and non-string fields → absent.
- **Unit — `formatPromptWithContext`:** payload with sender+chat → both lines in order after `From:`; sender only; neither → byte-identical to current output (regression pin for agent-to-agent traffic); malicious multi-line name flattened.
- **Unit — `classify-origin`:** updated lockstep fixture (mirroring the new producer format, per the fixture's explicit comment); `Telegram + Sender` → `Telegram · Name`; `Slack + Chat + Sender` → chat wins; no identity lines → legacy labels (existing cases keep passing); 60-char cap; identity lines ignored for agent/task/external branches.
- **Mocking:** none needed — all units are pure functions.

## Performance Considerations

Zero added IO. One extra safe-parse per relay-triggered turn (producer) and two line-regexes inside the existing head-scan (consumer). Negligible.

## Security Considerations

- Sanitization at the producer choke point prevents prompt-header forgery via display names (see Detailed Design).
- Identity remains advisory: anyone who can publish raw relay messages can influence the label, exactly as they can influence `From:` today (accepted in ADR 260721-153851 — single-operator local cockpit, UX-only).
- Sender names become part of the persisted transcript head. They are already present in the transcript payload records today; no new data class is persisted.

## Documentation

None user-facing beyond the changelog fragment. TSDoc on the new helper and the changed functions.

## Implementation Phases

- **Phase 1 — producer:** `extractSenderIdentity` + `formatPromptWithContext` lines + relay tests.
- **Phase 2 — consumer:** classifier enrichment + lockstep fixture update + server tests.
- **Phase 3 — verification:** targeted suites, package typecheck/lint, `pnpm verify`.

Single PR; phases are commit boundaries, not separate PRs.

## Open Questions

None — all nine ideation decisions resolved (see `01-ideation.md` §6); operator delegated gates for this item.

## Related ADRs

- ADR 260721-153851 — Derive session origin at read time from transcript-head markers (this spec extends the same mechanism; the marker set grows by two optional lines).

## References

- DOR-411 (tracker), DOR-408 / PR #385 (predecessor), `specs/session-origin-legibility/` (parent spec).
