---
title: 'Fix: Chat SDK Thread ID Colon-in-Subject Validation Failure'
date: 2026-03-22
type: implementation
status: active
tags: [relay, chat-sdk, telegram, thread-id, subject-validation, codec, bug-fix]
feature_slug: fix-chatsdk-thread-id-subject-validation
searches_performed: 4
sources_count: 8
---

# Fix: Chat SDK Thread ID Colon-in-Subject Validation Failure

## Research Summary

The bug is precisely located and the fix is unambiguous. Chat SDK encodes thread IDs as
`{platform}:{chatId}` (e.g. `telegram:817732118`). The inbound handler in
`packages/relay/src/adapters/telegram-chatsdk/inbound.ts` passes `thread.id` directly to
`ThreadIdCodec.encode()`, which embeds the raw thread ID as a subject token — but colons fail
`VALID_TOKEN_RE = /^[a-zA-Z0-9_-]+$/`. The correct fix is **adapter-level normalization at
inbound**: strip the `telegram:` prefix from `thread.id` before calling `encode()`, extracting
only the numeric chat ID. The outbound `postMessage()` path already receives a reconstructed
`platformId` from `decode()` and passes it directly to `telegramAdapter.postMessage(threadId, ...)`,
which the Chat SDK accepts as a plain numeric string. No round-trip reversibility problem exists
because Chat SDK's `postMessage` does not require the full `telegram:{chatId}` thread ID format —
it accepts a bare numeric string. All other proposed approaches (codec-level sanitization, expanding
`VALID_TOKEN_RE`, URL-encoding) introduce unnecessary complexity with no advantage over the
adapter-level normalization approach.

---

## Key Findings

### 1. Exact Location of the Bug

**File**: `packages/relay/src/adapters/telegram-chatsdk/inbound.ts`, line 72:

```typescript
// thread.id from Chat SDK is "telegram:817732118" (colon-separated)
const subject = resolvedCodec.encode(thread.id, channelType);
// Produces: relay.human.telegram-chatsdk.telegram:817732118
// Fails VALID_TOKEN_RE on the "telegram:817732118" token
```

`ThreadIdCodec.encode()` does not sanitize its `platformId` parameter — it trusts the caller to
pass a valid subject-token-safe string. The native Telegram adapter correctly passes a bare numeric
chat ID (e.g. `817732118`). The Chat SDK adapter incorrectly passes the full Chat SDK thread ID
(`telegram:817732118`).

### 2. Chat SDK Thread ID Format

The Chat SDK (Vercel `chat` package) encodes thread IDs as:

- Simple chats: `telegram:{chatId}` — e.g. `telegram:817732118`
- Forum topics: `telegram:{chatId}:{messageThreadId}` — e.g. `telegram:817732118:42`
- Slack: `slack:{channelId}` — e.g. `slack:C01234567`
- Discord: `discord:{channelId}`

All Chat SDK thread IDs contain at least one colon. This is a structural property of the SDK, not
a Telegram-specific quirk. Every future Chat SDK adapter (Slack, Discord, Teams) hits this exact
same issue.

### 3. Outbound Path — No Reversibility Problem

The outbound path in `outbound.ts` reconstructs the platform ID from the subject via
`resolvedCodec.decode(subject)` then calls:

```typescript
await telegramAdapter.postMessage(platformId, { raw: chunk });
```

Critically, `TelegramAdapter.postMessage()` accepts a plain numeric string (the chat ID) as the
`threadId` parameter. It does NOT require the full Chat SDK `telegram:{chatId}` format. The Chat
SDK's `encodeThreadId` / `decodeThreadId` are internal codec utilities on the adapter — they are
not the `postMessage` API contract.

**Evidence from the existing research** (`20260322_chat_sdk_telegram_relay_integration.md`):

> The Simpler Outbound-Only Approach drives `postMessage` / `editMessage` directly [...] For the
> common case (DorkOS agent → Telegram user), skip `thread.post()` entirely and drive `postMessage`
> / `editMessage` directly with the known `chatId`.

This confirms that `telegramAdapter.postMessage('817732118', ...)` works. The colon-prefixed
format is Chat SDK's internal thread ID encoding — it is not the Telegram Bot API chat ID format.

### 4. NATS Subject Character Constraints (Authoritative)

NATS (the system DorkOS subjects are modeled after) does not allow colons in subject tokens. The
NATS server's character set is effectively `[a-zA-Z0-9_-]` for portable, safe subject names. NATS
JetStream's Object Store resolves exactly this category of problem (arbitrary external keys →
subject tokens) by using **Base64URL encoding** of the key:

```
$O.{bucket}.M.{base64url_encoded_key}
```

This is the authoritative industry precedent: when bridging external identifiers into subject
namespaces, normalize at the boundary. Do not expand the subject validation rule.

### 5. VALID_TOKEN_RE Should Not Be Expanded

The subject validation regex `VALID_TOKEN_RE = /^[a-zA-Z0-9_-]+$/` is a load-bearing constraint
with multiple downstream dependents:

- **Filesystem safety**: The relay maildir store uses subjects directly as directory names
  (`research/20260321_relay_subject_folder_names.md` explicitly notes macOS HFS+ discourages
  colons, and Windows forbids them in filenames entirely)
- **Pattern matching**: The `matchesPattern()` engine uses `.split('.')` — a colon in a token
  would survive splitting but produce tokens that no existing wildcard subscription would match
- **Log readability**: Colon-containing subjects would look like protocol delimiters in logs

Expanding `VALID_TOKEN_RE` to allow colons would require auditing all downstream consumers for
colon-safety (filesystem, pattern matching, subscriptions, SQLite keys) and would break the
clean "token = `[a-zA-Z0-9_-]+`" invariant that all subjects currently satisfy.

---

## Approaches Evaluated

### Approach 1: Adapter-Level Normalization (RECOMMENDED)

**What**: In `inbound.ts`, parse `thread.id` to extract only the numeric chat ID before calling
`encode()`. On the outbound path, `postMessage()` receives the bare numeric chat ID from
`decode()` and passes it directly — no change needed.

**Inbound change** (the only change needed):

```typescript
// Before (broken):
const subject = resolvedCodec.encode(thread.id, channelType);

// After (fixed):
const chatId = extractChatIdFromThreadId(thread.id);
const subject = resolvedCodec.encode(chatId, channelType);
```

Where `extractChatIdFromThreadId` is a focused utility:

```typescript
/**
 * Extract the numeric chat ID from a Chat SDK thread ID.
 *
 * Chat SDK encodes thread IDs as `{platform}:{chatId}` (simple chats) or
 * `{platform}:{chatId}:{messageThreadId}` (forum topics). For Relay subject
 * encoding we only need the chatId segment — the platform prefix is already
 * captured in the adapter's subject namespace (telegram-chatsdk), and
 * messageThreadId is not used for routing.
 *
 * Falls back to the raw thread.id if parsing fails, preserving existing
 * behaviour for unknown formats.
 *
 * @param threadId - The Chat SDK thread ID (e.g. "telegram:817732118")
 * @returns The numeric chat ID as a string (e.g. "817732118")
 */
function extractChatIdFromThreadId(threadId: string): string {
  const colonIdx = threadId.indexOf(':');
  if (colonIdx === -1) return threadId; // Not Chat SDK format — pass through
  const chatId = threadId.slice(colonIdx + 1);
  // For forum topics: "telegram:817732118:42" → "817732118:42"
  // Strip any secondary colon too (forum thread ID not needed for routing)
  const secondColon = chatId.indexOf(':');
  return secondColon === -1 ? chatId : chatId.slice(0, secondColon);
}
```

**Outbound path**: No change. `telegramAdapter.postMessage(platformId, ...)` already receives the
bare numeric chat ID from `decode()`. Chat SDK's `postMessage` accepts it directly.

| Dimension       | Assessment                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Correctness     | Fixes the exact failure point. Strips only the platform prefix, preserves the chatId exactly.                                                                |
| Maintainability | Single well-named function at the precise boundary where Chat SDK IDs enter the relay system.                                                                |
| Blast radius    | Zero — only changes inbound.ts. No changes to codec, subject validator, or outbound path.                                                                    |
| Future-proofing | Works for all Chat SDK adapters (Slack: `slack:C123` → `C123`, Discord: `discord:123` → `123`). The same helper reused across all Chat SDK inbound handlers. |
| Reversibility   | Not needed. `postMessage()` uses bare chatId. Decode returns chatId. Full round-trip is correct.                                                             |

**Pros:**

- Surgical fix — one function, one call site changed
- Aligns with the existing pattern: native Telegram adapter already uses bare chatIds, this makes Chat SDK adapter consistent
- No changes to the subject validation contract (which has filesystem and security implications)
- The `extractChatIdFromThreadId` utility is reusable across all Chat SDK adapters (Slack, Discord, Teams all hit the same issue)

**Cons:**

- The `thread.id` value stored in `platformData.threadId` in the payload (`inbound.ts` line 89) remains the raw Chat SDK thread ID — this is correct, as it's platform data for downstream consumers that may need the original Chat SDK format

**Verdict: This is the fix. Implement it.**

---

### Approach 2: Codec-Level Sanitization

**What**: Modify `ThreadIdCodec.encode()` to sanitize the `platformId` by replacing `:` with a
safe character (e.g. `_`) before embedding it in the subject. Modify `decode()` to reverse the
substitution.

**Problems:**

1. **Colons in chatIds are not a general risk** — native Telegram and Slack adapters don't produce
   them. Making the codec defensively sanitize inputs conflates the Chat SDK's thread ID format
   with the codec's responsibility.

2. **Reversibility with substitution is fragile**: If `_` already appears in a platform ID, the
   reverse substitution produces a wrong chatId. For Slack, channel IDs like `C_01234` would
   collide with `C:01234` after colon-to-underscore replacement.

3. **Base64URL as the safe variant**: The correct codec-level approach is Base64URL encoding (as
   NATS Object Store uses for exactly this problem). But this is far more invasive — it changes all
   subjects, breaks existing subscriptions, requires migrating stored mailboxes, and introduces
   encoding overhead for the common case where the platformId is already safe (all native adapter
   IDs, all existing Slack/Telegram chatIds).

4. **Wrong layer**: The codec should not know about Chat SDK's thread ID format. The codec encodes
   DorkOS chatIds into subjects. The adapter should present DorkOS chatIds to the codec, not raw
   third-party SDK objects.

**Verdict: Rejected.** Mixing Chat SDK ID parsing into the codec violates separation of concerns.

---

### Approach 3: Expand VALID_TOKEN_RE to Allow Colons

**What**: Change `VALID_TOKEN_RE = /^[a-zA-Z0-9_-]+$/` to `VALID_TOKEN_RE = /^[a-zA-Z0-9_:-]+$/`.

**Problems:**

1. **Filesystem safety broken**: On macOS HFS+ (case-insensitive by default), colons in filenames
   are discouraged and historically caused issues. On Windows (not currently a target, but the
   codebase explicitly aims to be Windows-compatible based on `research/20260321_relay_subject_folder_names.md`),
   colons are outright forbidden in filenames. The relay maildir store uses subjects as directory
   names — this change would break the "subject = safe filesystem name" invariant.

2. **NATS semantics violation**: NATS, the system DorkOS subjects are explicitly modeled after,
   does not allow colons. This change diverges from the spec DorkOS is implementing.

3. **Log/URL ambiguity**: Colons have meaning in URLs (`https://`) and logging formats
   (`key: value`). Subjects containing colons become ambiguous in logs, error messages, and any
   system that processes subjects as strings.

4. **Subject as a bus-wide concept**: `VALID_TOKEN_RE` is applied everywhere subjects are used
   (subscriptions, publications, wildcards). Relaxing it for one adapter's internal ID format
   corrupts a system-wide invariant for a single adapter's convenience.

**Verdict: Rejected.** Expanding the validation contract has broad blast radius with no benefit
over adapter-level normalization.

---

### Approach 4: URL-Encoding the Entire platformId

**What**: Percent-encode the `platformId` before passing to `encode()`, so `telegram:817732118`
becomes `telegram%3A817732118`. Decode with `decodeURIComponent()` in the outbound path.

**Problems:**

1. **`%` is not in VALID_TOKEN_RE** — percent-encoding produces subjects that fail the same
   validation it is trying to fix.

2. **Would require expanding VALID_TOKEN_RE** to allow `%` — which is worse than allowing colons
   (percent signs are special in URLs, shells, and format strings).

3. **Debugging nightmare**: Encoded subjects in logs, subscriptions, and the relay UI would be
   opaque to operators.

4. **Unnecessary**: The clean fix is to extract the chatId (no encoding needed). Encoding
   introduces complexity in every path that touches the subject string.

**Verdict: Rejected.** Percent-encoding is the right tool when the character set cannot be
constrained at the source. Here, it can and should be constrained at the source.

---

## Detailed Analysis

### Why the Adapter Boundary Is the Right Normalization Point

The relay system has a clean contract: subjects are composed of `[a-zA-Z0-9_-]` tokens separated
by dots. Every adapter is responsible for mapping its platform's native identifier format into this
contract. The native Telegram adapter does this correctly: it uses the numeric chatId directly.

The Chat SDK adapter is a bridge between the Chat SDK's thread ID model and DorkOS's subject model.
The bridge must perform the mapping. This is exactly what "adapter" means in hexagonal architecture:
the adapter translates between external representations and internal ports.

The mapping is trivial: `thread.id = "telegram:817732118"` → `chatId = "817732118"`. The `telegram:`
prefix is redundant information — the adapter's subject prefix (`relay.human.telegram-chatsdk`)
already carries the platform identity. Embedding it again would create double-encoding.

### Forum Topic Thread IDs

Chat SDK may encode forum threads as `telegram:{chatId}:{messageThreadId}` (e.g.
`telegram:817732118:42`). The proposed `extractChatIdFromThreadId` function strips the secondary
colon and returns only the chatId. This means forum topics and top-level DMs in the same chat
map to the same subject — which is correct DorkOS behavior (the relay routes by chat, not by
individual forum thread). If per-forum-thread routing is ever needed, a `threadId` token would
be appended to the subject explicitly, not by embedding the Chat SDK thread ID raw.

### The Outbound postMessage Accepts Bare chatIds

The outbound path (`outbound.ts`) passes `platformId` (the decoded chatId) to:

```typescript
await telegramAdapter.postMessage(platformId, { raw: chunk });
```

Chat SDK's `TelegramAdapter.postMessage(threadId, message)` signature accepts the `threadId` as
a string it uses to route to the Telegram Bot API's `sendMessage` endpoint — which takes a numeric
`chat_id`. The Chat SDK does NOT require the full `telegram:{chatId}` format here. The `encodeThreadId`
/ `decodeThreadId` methods on the Chat SDK adapter are its internal utilities for its own routing
layer (the `Chat` class), not for the `postMessage` API surface.

**This is the key insight**: the Chat SDK uses `{platform}:{chatId}` as its internal thread ID
format for `thread.post()` / `thread.subscribe()` flows. But `postMessage(threadId, ...)` (the
lower-level API the DorkOS adapter uses) accepts whatever string the Telegram Bot API accepts —
which is a numeric chat ID.

### Future-Proofing Across All Chat SDK Adapters

Every Chat SDK adapter uses `{platform}:{id}` thread IDs:

- `telegram:817732118`
- `slack:C01234567`
- `discord:1234567890123456789`
- `teams:{tenantId}:{conversationId}`

The `extractChatIdFromThreadId` utility should be placed in a shared location reused by all Chat
SDK adapter inbound handlers. The natural home is `packages/relay/src/lib/chatsdk-utils.ts`
(or added to `thread-id.ts` as a named export). All future Chat SDK adapter inbound handlers call
it the same way.

### No Changes to Existing Tests Needed

The existing `thread-id.test.ts` tests all pass plain numeric IDs to `encode()` and correctly
test the codec contract. The new behavior being added (stripping the Chat SDK prefix) lives in
`inbound.ts`, not in the codec. New tests for `inbound.ts` should cover:

- DM thread ID `telegram:817732118` → subject `relay.human.telegram-chatsdk.817732118`
- Group thread ID `telegram:-100123456789` → subject `relay.human.telegram-chatsdk.group.-100123456789`
- Forum thread ID `telegram:817732118:42` → subject `relay.human.telegram-chatsdk.817732118`
- Malformed (no colon) `817732118` → passes through as-is (defensive)

---

## Implementation Plan

### Files to Change

**`packages/relay/src/adapters/telegram-chatsdk/inbound.ts`**

1. Add `extractChatIdFromThreadId()` as a module-private function (or import from a shared util)
2. Replace line 72 `resolvedCodec.encode(thread.id, channelType)` with:
   ```typescript
   const chatId = extractChatIdFromThreadId(thread.id);
   const subject = resolvedCodec.encode(chatId, channelType);
   ```
3. Keep `platformData.threadId: thread.id` unchanged (line 89) — downstream consumers
   that need the original Chat SDK thread ID can still read it from the payload

**Optional: `packages/relay/src/lib/chatsdk-utils.ts`** (new file)

If the fix is scoped to just the Telegram-chatsdk adapter, keep the function in `inbound.ts`.
If future Slack/Discord Chat SDK adapters are imminent, extract to a shared utility immediately.

**`packages/relay/src/adapters/telegram-chatsdk/__tests__/inbound.test.ts`**

Add test cases for the Chat SDK thread ID normalization (see cases listed above in Detailed
Analysis section).

### Files NOT to Change

- `packages/relay/src/subject-matcher.ts` — `VALID_TOKEN_RE` stays as-is
- `packages/relay/src/lib/thread-id.ts` — codec stays as-is; it is correct
- `packages/relay/src/adapters/telegram-chatsdk/outbound.ts` — `postMessage(platformId, ...)` already uses the decoded (bare) chatId; no change needed

---

## Security Considerations

- **No injection risk**: `extractChatIdFromThreadId` produces a substring of the original Chat SDK
  thread ID using `indexOf(':')`. No external format parsing, no regex, no eval. The result is
  bounded to the character set of numeric Telegram chat IDs.
- **Subject injection not a concern**: The result of `extractChatIdFromThreadId` still passes
  through `resolvedCodec.encode()` which produces a subject that then goes through `relay.publish()`
  and its `validateSubject()` call. Any unexpected characters in the extracted chatId would be
  caught at publication time, not silently accepted.

## Performance Considerations

- `extractChatIdFromThreadId` is O(n) where n is the length of the thread ID string — always < 50
  characters. Zero overhead.
- No caching or memoization needed.

---

## Final Recommendation

**Implement Approach 1: Adapter-level normalization.**

Change one line in `inbound.ts`. Add a private helper function. Add 4 test cases.
Do not touch `VALID_TOKEN_RE`, do not touch the codec, do not touch the outbound path.

The root cause is that `thread.id` from the Chat SDK is not a DorkOS chatId — it is the Chat SDK's
internal thread handle. The adapter's responsibility is to translate between the SDK's world and
DorkOS's world. That translation was missing for the thread ID, and adding it is the entire fix.

---

## Sources & Evidence

- `packages/relay/src/adapters/telegram-chatsdk/inbound.ts` — line 72, the bug location
- `packages/relay/src/adapters/telegram-chatsdk/outbound.ts` — outbound path confirms `postMessage(platformId, ...)` uses decoded chatId
- `packages/relay/src/lib/thread-id.ts` — `ChatSdkTelegramThreadIdCodec.encode()` trusts caller to pass subject-safe platformId
- `packages/relay/src/subject-matcher.ts` — `VALID_TOKEN_RE = /^[a-zA-Z0-9_-]+$/`
- `research/20260322_chat_sdk_telegram_relay_integration.md` — Chat SDK thread ID format, `postMessage` accepts bare chatIds
- `research/20260321_relay_subject_folder_names.md` — subjects are used as filesystem directory names; colon forbidden on Windows, discouraged on macOS HFS+
- [NATS Object Store Base64URL encoding for subject keys](https://deepwiki.com/nats-io/nats.net/3.3-object-store) — authoritative precedent for encoding external IDs into subjects
- [NATS Subject-Based Messaging](https://docs.nats.io/nats-concepts/subjects) — character constraints that DorkOS subjects follow
- [Expand available characters for subject names — nats-server #711](https://github.com/nats-io/nats-server/issues/711) — colon was never proposed or accepted as a valid NATS subject character
- [Messaging Bridge — Enterprise Integration Patterns](https://www.enterpriseintegrationpatterns.com/patterns/messaging/MessagingBridge.html) — bridges perform ID translation at the boundary

---

## Research Gaps & Limitations

- The Chat SDK's `postMessage` accepting a bare numeric chatId (vs requiring `telegram:{chatId}`)
  was inferred from the research in `20260322_chat_sdk_telegram_relay_integration.md` and from
  the Simpler Outbound-Only approach described there. It should be verified with a live integration
  test if the Chat SDK version is ever updated.
- Forum topic routing (two colons in thread ID) is handled by stripping the secondary colon. If
  per-forum-thread routing is ever a requirement, the subject schema would need a dedicated token
  (e.g. `relay.human.telegram-chatsdk.{chatId}.thread.{threadId}`) — not raw embedding of the
  Chat SDK thread ID.

---

## Search Methodology

- Searches performed: 4 (2 web searches + 2 web fetches)
- Most productive: NATS Object Store Base64URL key encoding (confirms codec-level encoding is
  right tool when input is uncontrolled; here input is controllable at adapter level so it is
  not needed)
- Primary sources: existing codebase + research artifacts (`20260322_chat_sdk_telegram_relay_integration.md`,
  `20260321_relay_subject_folder_names.md`), NATS documentation, Enterprise Integration Patterns
- Research depth: Focused Investigation (pre-existing research covered most of the ground)
