---
slug: slack-adapter-world-class
number: 166
created: 2026-03-22
status: ideation
---

# Slack Adapter World-Class Improvements

**Slug:** slack-adapter-world-class
**Author:** Claude Code
**Date:** 2026-03-22
**Branch:** preflight/slack-adapter-world-class

---

## 1) Intent & Assumptions

- **Task brief:** Implement all top recommended improvements to the DorkOS Slack Adapter — thread-aware mention gating, DM access control, message splitting, event dedup, graceful auth failure handling, thread-first responses, typing indicator default change, and channel-specific behavior overrides. Refactor core Relay/Adapter systems where needed.
- **Assumptions:**
  - Pre-release, greenfield — breaking changes to config schema are acceptable
  - The existing Slack adapter architecture (8 files, ~2,200 LOC) is sound and we're extending, not rewriting
  - Socket Mode remains the only connection method (no HTTP Events API)
  - These improvements are informed by OpenClaw's documented pain points (330K stars, well-cataloged GitHub issues) and broader AI Slack bot industry trends
  - The Telegram adapter's `splitMessage` utility is a good foundation for a shared implementation
- **Out of scope:**
  - OAuth cross-workspace support (manual token setup is fine for dev tools)
  - Slash command framework (adds complexity; @mentions are the primary interface)
  - Per-channel LLM model selection (agent selection is a Relay binding concern)
  - Slack's "Agents & AI Apps" framework (requires enterprise plan, unofficial API)
  - File/image upload support (valuable but a separate spec)
  - Block Kit rich responses beyond tool approval (separate spec)
  - Emoji shortcut commands (delight feature, separate spec)

## 2) Pre-reading Log

- `contributing/relay-adapters.md`: Comprehensive adapter architecture guide. BaseRelayAdapter base class, subject hierarchy conventions, hot-reload config, streaming API wrappers, PlatformClient pattern, tool approval event routing.
- `contributing/adapter-catalog.md`: AdapterManifest schema, ConfigField types (password masking, enums), CatalogEntry structure, BindingRouter most-specific-first scoring, hot-reload with zero-downtime restarts.
- `specs/slack-adapter/02-specification.md`: Original spec (completed). Socket Mode, native streaming, threading, typing indicators, formatForPlatform() helper. This spec was the roadmap for the current implementation.
- `packages/relay/src/adapters/slack/slack-adapter.ts` (536 lines): Facade extending BaseRelayAdapter. Lifecycle: `_start()` creates Bolt App, caches botUserId via `auth.test()`, registers message/app_mention/action handlers. Tool approval action handlers (tool_approve/tool_deny) in `_start()`.
- `packages/relay/src/adapters/slack/inbound.ts` (407 lines): Inbound parsing. SKIP_SUBTYPES filters 18 subtypes. Echo prevention via botUserId. Name resolution cached (500-entry, 1h TTL). Subject construction via SlackThreadIdCodec. Pending reaction queue for hourglass emoji.
- `packages/relay/src/adapters/slack/outbound.ts` (259 lines): Outbound delivery router. StreamEvent routing (text_delta, done, error, approval_required). Standard payload → formatForPlatform('slack') → truncate → chat.postMessage. Threading via resolveThreadTs().
- `packages/relay/src/adapters/slack/stream.ts` (566 lines): Native + legacy streaming. Per-channel activeStream tracking. 5-minute stream TTL reaping. 1s throttle for legacy chat.update.
- `packages/relay/src/adapters/slack/approval.ts` (192 lines): Block Kit approval cards with Approve/Deny buttons. Timeout management via pendingApprovalTimeouts Map.
- `packages/relay/src/adapters/slack/slack-platform-client.ts` (211 lines): PlatformClient wrapping WebClient. Supports native streaming flag.
- `packages/relay/src/base-adapter.ts` (268 lines): Status state machine, idempotency guards, error recording, message count tracking, callback factories.
- `packages/relay/src/lib/payload-utils.ts`: Shared utilities — extractPayloadContent(), formatForPlatform(), truncateText(), detectStreamEventType().
- `packages/relay/src/lib/thread-id.ts`: SlackThreadIdCodec — encode/decode subject strings with instanceId support. DM vs group channel detection via prefix (D=dm, C/G=group).
- `packages/shared/src/relay-adapter-schemas.ts`: Zod schemas. SlackAdapterConfigSchema: botToken, appToken, signingSecret, streaming, nativeStreaming, typingIndicator ('none'|'reaction', default 'none').
- `packages/relay/src/adapters/telegram/outbound.ts`: Telegram's splitMessage() (lines 138-157) — splits by newline boundaries within maxLen. Foundation for shared utility.
- `packages/relay/src/adapter-delivery.ts` (87 lines): 120s timeout wrapper, SQLite audit indexing.
- `research/20260313_slack_bot_adapter_best_practices.md`: Best practices for @slack/bolt, Socket Mode, streaming, threading, rate limits.
- `research/20260314_slack_bolt_socket_mode_best_practices.md`: Socket Mode reconnection, logLevel wiring, streaming throttling, thread handling, cache bounds, rate limits.
- `research/20260317_slack_tool_approval_block_kit.md`: Block Kit interactive buttons, app.action() handlers, timeout management, security.
- `research/20260318_slack_bot_typing_processing_indicators.md`: No native "bot is typing" API. Best options: reactions.add (current), native streaming (already implemented).
- `research/20260318_slack_app_manifest_deep_dive.md`: Manifest YAML format, URL-based app creation, missing reactions:read and mpim:history scopes.
- `research/20260318_slack_message_formatting_tables.md`: mrkdwn formatting, slackify-markdown, table alternatives.
- `research/20260322_openclaw_slack_integration_analysis.md`: OpenClaw's Slack integration — 330K stars, DM policies, mention gating (binary, #1 complaint), Block Kit, streaming, security nightmare (CVE-2026-25253). Thread-aware mention gating is the most-requested feature (Issue #30270).
- `research/20260322_slack_adapter_improvements_best_practices.md`: Targeted research for all six improvements. ThreadParticipationTracker pattern, event dedup via event_id LRU, auth failure fast-fail with 7 fatal error codes, message splitting with code-block-aware fencing.
- `decisions/0119-slack-socket-mode-only.md` (archived): Socket Mode chosen over HTTP Events API — no public URL needed.
- `decisions/0118-*` (archived): Native streaming API wrapping with `as unknown` casts.
- `decisions/0124-*` (archived): slackify-markdown newline collapsing workaround.
- `decisions/0125-*` (archived): Emoji reaction typing indicators (no native bot typing API in Slack).

## 3) Codebase Map

**Primary Components/Modules:**

| File                                                 | Lines | Role                        | Changes Needed                                                                           |
| ---------------------------------------------------- | ----- | --------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/relay/src/adapters/slack/slack-adapter.ts` | 536   | Facade, lifecycle, Bolt app | Add respondMode gating, dmPolicy checks, auth failure handler                            |
| `packages/relay/src/adapters/slack/inbound.ts`       | 407   | Inbound parsing, filtering  | Add mention detection, event dedup, DM allowlist, thread participation tracking          |
| `packages/relay/src/adapters/slack/outbound.ts`      | 259   | Outbound delivery router    | Add message splitting, thread-first enforcement                                          |
| `packages/relay/src/adapters/slack/stream.ts`        | 566   | Streaming delivery          | Thread-first enforcement for stream start                                                |
| `packages/shared/src/relay-adapter-schemas.ts`       | ~200  | Config schemas              | Add respondMode, dmPolicy, dmAllowlist, channelOverrides, typingIndicator default change |
| `packages/relay/src/lib/payload-utils.ts`            | ~150  | Shared utilities            | Add shared splitMessage() function                                                       |
| `packages/relay/src/adapters/telegram/outbound.ts`   | ~250  | Telegram outbound           | Refactor to use shared splitMessage()                                                    |

**Shared Dependencies:**

- `@slack/bolt` — Socket Mode app, event listeners, action handlers
- `@slack/web-api` — WebClient for API calls
- `slackify-markdown` — Markdown → mrkdwn conversion
- `packages/shared/src/relay-adapter-schemas.ts` — Zod config schemas (shared across server + relay)
- `packages/relay/src/lib/payload-utils.ts` — Shared formatting utilities
- `packages/relay/src/lib/thread-id.ts` — Subject encoding/decoding
- `packages/relay/src/base-adapter.ts` — Status state machine, lifecycle boilerplate

**Data Flow:**

```
Inbound:
  Slack message → Bolt event handler
    → [NEW] Event dedup (event_id LRU)
    → Echo prevention (botUserId)
    → [NEW] DM allowlist check (if DM + allowlist mode)
    → [NEW] Respond mode check (mention gating + thread participation)
    → Name resolution (cached)
    → Hourglass reaction (if typingIndicator='reaction')
    → relay.publish(subject, StandardPayload)

Outbound:
  Agent response → AdapterRegistry.deliver()
    → SlackAdapter.deliver()
    → deliverMessage()
      → [NEW] Thread-first: force thread_ts for channel messages
      → Stream events → stream.ts (native/legacy streaming)
      → Standard payloads → formatForPlatform('slack')
        → [NEW] splitMessage() instead of truncate
        → chat.postMessage (with thread_ts)
```

**Feature Flags/Config (Current → Proposed):**

| Field            | Current          | Proposed Change                                                               |
| ---------------- | ---------------- | ----------------------------------------------------------------------------- |
| typingIndicator  | default `'none'` | Change default to `'reaction'`                                                |
| respondMode      | N/A              | NEW: `'always' \| 'mention-only' \| 'thread-aware'`, default `'thread-aware'` |
| dmPolicy         | N/A              | NEW: `'open' \| 'allowlist'`, default `'open'`                                |
| dmAllowlist      | N/A              | NEW: `string[]`, default `[]`                                                 |
| channelOverrides | N/A              | NEW: `Record<string, { respondMode?, enabled? }>`, default `{}`               |

**Potential Blast Radius:**

- **Direct changes:** 7 files (6 in relay package, 1 in shared)
- **Refactor impact:** Telegram adapter outbound.ts (extract splitMessage to shared utility)
- **Tests to update:** 4 test files (inbound.test.ts, outbound.test.ts, slack-adapter.test.ts, stream-api.test.ts)
- **New tests needed:** Thread participation tracker, event dedup, mention gating, DM allowlist, message splitting, auth failure handling, channel overrides
- **Config migration:** None needed — all new fields have backward-compatible defaults matching current behavior (respondMode='always' equivalent via 'thread-aware' with no channels, dmPolicy='open', etc.)

## 4) Root Cause Analysis

N/A — This is a feature enhancement, not a bug fix.

## 5) Research

### Improvement 1: Thread-Aware Mention Gating

**Approach:** In-memory `ThreadParticipationTracker` — no API calls.

A `Set<channelId:threadTs>` tracks threads where the bot has posted. Populated via `markParticipating()` after every bot reply (both streaming start and standard message). The inbound handler checks `isParticipating()` before deciding whether to process or skip.

- **TTL:** 24 hours (conversations rarely span longer)
- **Max entries:** 1,000 (bounded memory, LRU eviction)
- **Edge case:** Mark the thread `ts` when posting the _root_ bot message too, so replies to it are correctly recognized
- **No API calls:** Avoids `conversations.replies` which is rate-limited to 1/min in 2026

Three modes:

- `always` — respond to every message (DM default)
- `mention-only` — only respond when explicitly @mentioned
- `thread-aware` — require @mention in main channel, respond freely in threads where bot has participated (channel default)

OpenClaw's #1 missing feature (Issue #30270, PRs in progress). We ship it as our default.

### Improvement 2: DM Access Control

**Approach:** `dmPolicy` config with `open` (default) and `allowlist` modes.

- `open`: Anyone who can DM the bot gets a response (current behavior)
- `allowlist`: Only user IDs in `dmAllowlist` array are processed; others are silently ignored
- Silent ignore is safer than rejection messages (no oracle for attackers)
- Consider auto-populating with bot installer's user ID (available from `auth.test()` response) — but this adds complexity, skip for v1

### Improvement 3: Message Splitting (Shared Utility)

**Approach:** Extract Telegram's `splitMessage()` to `packages/relay/src/lib/payload-utils.ts` and enhance with code-block-aware splitting.

- **Soft limit:** 3,500 chars (accounts for mrkdwn expansion by slackify-markdown)
- **Split priority:** `\n\n` paragraph boundary → `\n` line boundary → word boundary → hard cut
- **Code block awareness:** Count unmatched ` ``` ` fences; if a split occurs mid-code-block, append closing fence to current chunk and prepend opening fence to next
- **Inter-message delay:** 1.1s between sequential `postMessage` calls (Slack Tier 3 rate limit is ~50/min)
- **All chunks posted to same thread** as original message
- Both Telegram and Slack adapters use the shared utility; Telegram's existing inline `splitMessage` is removed

### Improvement 4: Event Deduplication

**Critical distinction:** Socket Mode does NOT use `X-Slack-Retry-Num` headers — that's HTTP Events API only. In Socket Mode, Slack retries only if the `envelope_id` acknowledgment is never received. However, bolt-js has a known bug (Issue #2188) where the same `event_id` can be delivered twice during WebSocket reconnection.

**Two-layer defense:**

1. Existing `SKIP_SUBTYPES` filter — already catches `message_changed`, `message_deleted`, etc.
2. NEW: `event_id` LRU Set with 5-minute TTL and 500-entry cap — catches the #2188 duplicate delivery bug

Implementation: Check `body.event_id` in the message handler before processing. If seen, skip silently.

### Improvement 5: Graceful Auth Failure Handling

**Seven error codes are permanently fatal and must trigger immediate `app.stop()`:**
`account_inactive`, `invalid_auth`, `token_revoked`, `not_authed`, `missing_scope`, `team_access_not_granted`, `app_uninstalled`

**Implementation:**

- `FATAL_SLACK_ERRORS = new Set([...])` checked inside `app.error()` handler
- On fatal error: set adapter status to `error` with descriptive message, call `app.stop()`
- Pre-flight `auth.test()` before `app.start()` catches configuration errors early (already implemented)
- Consider `deferInitialization: true` Bolt option to prevent auth errors from bypassing `try/catch` during constructor async init

### Improvement 6: Thread-First Responses

**Enforced behavior, no config option.** When the bot responds in a channel (not a DM), it always replies in a thread under the triggering message.

**Implementation:**

- Outbound: When no `threadTs` is present and channel is a group channel, use the inbound message's `ts` as `thread_ts`
- This is already partially implemented — `resolveThreadTs()` in outbound.ts uses `platformData.ts` when `threadTs` is absent
- Verify this works for all code paths: standard messages, streaming start, approval cards

### Improvement 7: Typing Indicator Default Change

**Change `typingIndicator` default from `'none'` to `'reaction'`.**

Users should get immediate feedback (hourglass reaction appears within ~200ms of sending a message). The reaction-based approach is already fully implemented and tested. This is just a schema default change.

### Improvement 8: Channel-Specific Overrides

**Approach:** `channelOverrides: Record<channelId, ChannelOverride>` in config.

```typescript
type ChannelOverride = {
  enabled?: boolean; // false = ignore all messages in this channel
  respondMode?: RespondMode; // override the global respondMode for this channel
};
```

- Keyed by stable channel IDs (not names — names can change)
- Zero runtime cost (hash map lookup)
- `getEffectiveChannelConfig()` merges override onto global defaults
- Example: dedicated #agent-chat channel with `respondMode: 'always'`, while #general uses the global `thread-aware` default

### Implementation Priority

| Priority | Improvement                        | Effort  | Risk                               |
| -------- | ---------------------------------- | ------- | ---------------------------------- |
| 1        | Event dedup (event_id LRU)         | Low     | None — additive filter             |
| 2        | Auth failure fast-fail             | Low     | None — error handler improvement   |
| 3        | Typing indicator default change    | Trivial | None — schema default              |
| 4        | Thread-aware mention gating        | Medium  | Low — new filter in inbound path   |
| 5        | DM allowlist                       | Low     | None — new filter in inbound path  |
| 6        | Message splitting (shared utility) | Medium  | Low — refactor Telegram, add Slack |
| 7        | Thread-first responses             | Low     | Low — verify existing code paths   |
| 8        | Channel overrides                  | Low     | None — additive config             |

### Security Considerations

- DM allowlist uses silent ignore, not rejection messages (no information leakage)
- Thread participation tracker is instance-scoped (not module-level) to prevent cross-workspace data leakage in multi-instance scenarios
- Event dedup prevents potential replay attacks via WebSocket reconnection
- Auth failure fast-fail prevents resource exhaustion from retry loops
- Channel overrides use channel IDs (not names) to prevent spoofing via channel rename

### Performance Considerations

- ThreadParticipationTracker: O(1) lookup, bounded at 1,000 entries, 24h TTL — negligible memory
- Event dedup LRU: O(1) lookup, bounded at 500 entries, 5min TTL — negligible memory
- Message splitting: Only invoked when content exceeds 3,500 chars — rare for most responses
- No new API calls introduced — all improvements are in-process logic
- Channel overrides: O(1) hash map lookup per message

### Recommendation

**Implement all 8 improvements in a single coordinated change.** They are independent features with minimal overlap, but shipping together creates a compound "wow" effect — the adapter goes from functional to world-class in one release. The total effort is approximately 4-5 hours of implementation + testing.

The thread-aware mention gating alone would make DorkOS's Slack integration better than OpenClaw's (330K GitHub stars) — they still don't have this feature despite years of community demand.

## 6) Decisions

| #   | Decision                          | Choice                       | Rationale                                                                                                                                                                        |
| --- | --------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Default respond mode for channels | `thread-aware`               | OpenClaw's #1 missing feature. Require @mention in main channel, respond freely in threads where bot has participated. Safe for shared channels, zero-friction in conversations. |
| 2   | Default DM access policy          | `open`                       | DorkOS is a developer tool — Kai installs on his own workspace. Allowlist is available but friction-by-default hurts the solo dev use case.                                      |
| 3   | Message splitting location        | Shared in `payload-utils.ts` | Extract Telegram's splitMessage to shared utility and enhance with code-block-aware splitting. DRY, consistent behavior, any future adapter gets it free.                        |
| 4   | Thread-first response policy      | Enforced default, no config  | Universal best practice — every major Slack bot threads responses. No reason to pollute main channels. Simpler config surface (less is more).                                    |
