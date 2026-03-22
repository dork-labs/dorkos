---
slug: fix-chatsdk-thread-id-subject-validation
number: 164
created: 2026-03-22
status: ideation
---

# Fix Chat SDK Thread ID Subject Validation

**Slug:** fix-chatsdk-thread-id-subject-validation
**Author:** Claude Code
**Date:** 2026-03-22
**Branch:** preflight/fix-chatsdk-thread-id-subject-validation

---

## 1) Intent & Assumptions

- **Task brief:** Chat SDK adapters use `{platform}:{chatId}` format for thread IDs (e.g. `telegram:817732118`), which contains colons rejected by relay subject validation (`VALID_TOKEN_RE = /^[a-zA-Z0-9_-]+$/`). This breaks all inbound message routing for Chat SDK-based adapters. The adapter layer should normalize platform-specific thread ID formats before encoding into relay subjects.

- **Assumptions:**
  - The Chat SDK's `{platform}:{chatId}` format is a structural property of the SDK, not a per-platform quirk
  - `telegramAdapter.postMessage(threadId, ...)` accepts bare numeric chat IDs (does not require `telegram:{chatId}` format)
  - Forum topic thread IDs (`telegram:{chatId}:{messageThreadId}`) are not needed for routing — chat-level routing is sufficient
  - `VALID_TOKEN_RE` is a load-bearing constraint with filesystem, pattern-matching, and NATS-compatibility implications and should not be expanded
  - The outbound path already works with bare numeric chat IDs from `codec.decode()`

- **Out of scope:**
  - Per-forum-thread routing (would need a subject schema change)
  - Slack/Discord Chat SDK adapter inbound handlers (same pattern applies but those adapters don't exist yet)
  - Changes to `VALID_TOKEN_RE` or the `ThreadIdCodec` contract
  - Changes to the outbound delivery path

## 2) Pre-reading Log

- `packages/relay/src/adapters/telegram-chatsdk/inbound.ts`: Bug location at line 72 — `thread.id` passed raw to `resolvedCodec.encode()`. The colon in `telegram:817732118` fails subject validation.
- `packages/relay/src/adapters/telegram-chatsdk/outbound.ts`: Outbound path passes decoded `platformId` (bare chatId) to `telegramAdapter.postMessage()`. No change needed.
- `packages/relay/src/adapters/telegram-chatsdk/adapter.ts`: Adapter constructs `ChatSdkTelegramThreadIdCodec` with instance ID. Wires up inbound/outbound handlers.
- `packages/relay/src/lib/thread-id.ts`: `ChatSdkTelegramThreadIdCodec.encode()` appends platformId to prefix. Trusts caller to pass subject-safe string.
- `packages/relay/src/subject-matcher.ts`: `VALID_TOKEN_RE = /^[a-zA-Z0-9_-]+$/` at line 28. Validation at lines 114-121 produces the error.
- `apps/server/.temp/.dork/relay/adapters.json`: Adapter ID is `telegram-chatsdk` (valid, no colon). Confirms the issue is `thread.id`, not adapter ID.
- `research/20260322_chat_sdk_telegram_relay_integration.md`: Documents Chat SDK thread ID format and `postMessage` API contract.
- `research/20260321_relay_subject_folder_names.md`: Subjects used as filesystem directory names. Colons forbidden on Windows, discouraged on macOS HFS+.
- `research/20260322_fix_chatsdk_thread_id_subject_validation.md`: Full research report evaluating 4 approaches.
- `specs/adapter-binding-improvements/02-specification.md`: Recently implemented spec that added instance-aware subjects and `parseSubject()`.
- `specs/chat-sdk-relay-adapter-refactor/02-specification.md`: Spec that created the Chat SDK adapter — the original source of this bug.

## 3) Codebase Map

**Primary components/modules:**

- `packages/relay/src/adapters/telegram-chatsdk/inbound.ts` — Inbound message handler (THE BUG — line 72)
- `packages/relay/src/adapters/telegram-chatsdk/outbound.ts` — Outbound delivery (no changes needed)
- `packages/relay/src/adapters/telegram-chatsdk/adapter.ts` — Adapter class wiring
- `packages/relay/src/lib/thread-id.ts` — `ChatSdkTelegramThreadIdCodec` (no changes needed)
- `packages/relay/src/subject-matcher.ts` — Subject validation with `VALID_TOKEN_RE` (no changes needed)

**Shared dependencies:**

- `@dorkos/shared/relay-schemas` — `StandardPayload`, `RelayEnvelope` types
- `chat` — Chat SDK `Message`, `Thread` types
- `@chat-adapter/telegram` — `TelegramAdapter` class
- `packages/relay/src/types.ts` — `RelayPublisher`, `AdapterInboundCallbacks`, `RelayLogger`

**Data flow:**

```
Telegram user → Chat SDK TelegramAdapter.onMessage()
  → thread.id = "telegram:817732118"  ← Platform-specific format
  → inbound.ts handleInboundMessage()
    → codec.encode(thread.id, channelType)  ← BUG: passes raw thread.id
    → relay.publish(subject, payload)  ← Fails VALID_TOKEN_RE
```

**Feature flags/config:** None.

**Potential blast radius:**

- Direct: 1 file (`inbound.ts`) — add `extractChatIdFromThreadId` helper, change line 72
- Indirect: 0 files — outbound, codec, and subject-matcher are unaffected
- Tests: 1 file — `inbound.test.ts` needs new test cases for thread ID normalization

## 4) Root Cause Analysis

- **Repro steps:**
  1. Bind a Chat SDK Telegram adapter to an agent
  2. Send a message from Telegram to the adapter
  3. Observe error: `Invalid subject: Token "telegram:817732118" contains invalid characters`

- **Observed vs Expected:**
  - **Observed:** `relay.publish()` rejects the subject because the token `telegram:817732118` contains a colon
  - **Expected:** The adapter should strip the `telegram:` prefix before encoding, producing a valid subject like `relay.human.telegram-chatsdk.817732118`

- **Evidence:** Error message in dev server logs, code at `inbound.ts:72` passes `thread.id` (Chat SDK format with colon) directly to `codec.encode()` without normalization

- **Root-cause hypotheses:**
  1. **Missing adapter normalization (100% confidence):** The Chat SDK adapter's inbound handler passes the raw Chat SDK thread ID to the codec. The native Telegram adapter uses bare numeric chat IDs. The Chat SDK adapter omitted this translation step.
  2. ~~The codec should sanitize inputs~~ — Wrong layer. The codec's contract is "encode a subject-safe platformId". The adapter's job is to provide a subject-safe platformId.
  3. ~~`VALID_TOKEN_RE` is too restrictive~~ — No. The regex correctly models NATS subject constraints and filesystem safety.

- **Decision:** Hypothesis 1 — adapter-level normalization. The fix is a single helper function at the adapter boundary.

## 5) Research

See `research/20260322_fix_chatsdk_thread_id_subject_validation.md` for the full research report.

- **Potential solutions:**
  1. **Adapter-level normalization** — Strip `{platform}:` prefix from `thread.id` in `inbound.ts` before passing to `encode()`. Single function, single call site, zero blast radius. Reusable across all future Chat SDK adapters.
     - Pros: Surgical fix, aligns with hexagonal architecture (adapter translates), follows NATS Object Store precedent of normalizing at the boundary
     - Cons: None identified

  2. **Codec-level sanitization** — Modify `ThreadIdCodec.encode()` to replace `:` with `_`.
     - Pros: Defensive
     - Cons: Wrong layer (codec shouldn't know about Chat SDK formats), `_`/`:` collision risk for Slack channel IDs, breaks separation of concerns

  3. **Expand VALID_TOKEN_RE** — Allow colons in subject tokens.
     - Pros: No adapter changes needed
     - Cons: Breaks filesystem safety (Windows forbids colons), violates NATS spec, affects all subjects system-wide

  4. **URL-encode platformId** — Percent-encode to `telegram%3A817732118`.
     - Pros: Reversible
     - Cons: `%` also fails `VALID_TOKEN_RE`, debugging nightmare, unnecessary complexity

- **Recommendation:** Approach 1 — Adapter-level normalization. Single function, minimal change, correct architectural boundary.

## 6) Decisions

| #   | Decision                            | Choice                          | Rationale                                                                                                                                  |
| --- | ----------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Where to normalize thread IDs       | Adapter boundary (`inbound.ts`) | Hexagonal architecture: adapters translate between external and internal representations. The codec's contract is subject-safe platformIds |
| 2   | Whether to expand `VALID_TOKEN_RE`  | No                              | Colons break filesystem safety (Windows), violate NATS spec, and would require auditing all downstream subject consumers                   |
| 3   | Whether outbound path needs changes | No                              | `postMessage(platformId, ...)` already receives bare numeric chatId from `decode()`. Chat SDK accepts it directly                          |
| 4   | Shared utility vs inline in inbound | Inline in `inbound.ts` for now  | Only one Chat SDK adapter exists. Extract to shared util when Slack/Discord Chat SDK adapters are added (YAGNI)                            |
| 5   | Forum topic handling                | Strip to chatId only            | Per-forum-thread routing is out of scope. Chat-level routing is sufficient. Forum thread ID not needed for relay routing                   |
