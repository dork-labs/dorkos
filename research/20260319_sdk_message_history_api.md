---
title: 'Claude Agent SDK — Message History & Session Listing API'
date: 2026-03-19
type: implementation
status: active
tags:
  [
    claude-agent-sdk,
    message-history,
    session-management,
    listSessions,
    getSessionMessages,
    jsonl,
    transcript,
  ]
searches_performed: 3
sources_count: 4
---

# Claude Agent SDK — Message History & Session Listing API

**Research date:** 2026-03-19
**Package:** `@anthropic-ai/claude-agent-sdk`
**Research depth:** Focused
**Sources fetched:** Official Anthropic sessions doc, TypeScript SDK reference, GitHub feature request issue #14

---

## Research Summary

The Claude Agent SDK **does** provide official APIs for reading message history — `listSessions()` and `getSessionMessages()` — both of which were **added after the initial SDK release** (they are NOT documented in older research from 2026-02). These functions read the on-disk JSONL transcripts without requiring you to parse them manually. They return structured `SDKSessionInfo` and `SessionMessage` objects. However, they are **read-only utilities for past sessions**, not a way to stream historical messages into an active `query()` call — that gap is the subject of GitHub issue #14 which remains open.

---

## Key Findings

### 1. `listSessions()` — Official API

```typescript
function listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]>;
```

**Parameters:**

| Parameter                  | Type      | Default     | Description                                                                        |
| :------------------------- | :-------- | :---------- | :--------------------------------------------------------------------------------- |
| `options.dir`              | `string`  | `undefined` | Directory to list sessions for. When omitted, returns sessions across all projects |
| `options.limit`            | `number`  | `undefined` | Maximum number of sessions to return                                               |
| `options.includeWorktrees` | `boolean` | `true`      | When `dir` is inside a git repo, include sessions from all worktree paths          |

**Return type: `SDKSessionInfo[]`**

| Property       | Type                  | Description                                                          |
| :------------- | :-------------------- | :------------------------------------------------------------------- |
| `sessionId`    | `string`              | Unique session identifier (UUID)                                     |
| `summary`      | `string`              | Display title: custom title, auto-generated summary, or first prompt |
| `lastModified` | `number`              | Last modified time in milliseconds since epoch                       |
| `fileSize`     | `number`              | Session file size in bytes                                           |
| `customTitle`  | `string \| undefined` | User-set session title (via `/rename`)                               |
| `firstPrompt`  | `string \| undefined` | First meaningful user prompt in the session                          |
| `gitBranch`    | `string \| undefined` | Git branch at the end of the session                                 |
| `cwd`          | `string \| undefined` | Working directory for the session                                    |

Results are **sorted by `lastModified` descending** (newest first).

**Example:**

```typescript
import { listSessions } from '@anthropic-ai/claude-agent-sdk';

const sessions = await listSessions({ dir: '/path/to/project', limit: 10 });

for (const session of sessions) {
  console.log(`${session.summary} (${session.sessionId})`);
}
```

---

### 2. `getSessionMessages()` — Official API

```typescript
function getSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions
): Promise<SessionMessage[]>;
```

**Parameters:**

| Parameter        | Type     | Default     | Description                                                                   |
| :--------------- | :------- | :---------- | :---------------------------------------------------------------------------- |
| `sessionId`      | `string` | required    | Session UUID to read (from `listSessions()`)                                  |
| `options.dir`    | `string` | `undefined` | Project directory to find the session in. When omitted, searches all projects |
| `options.limit`  | `number` | `undefined` | Maximum number of messages to return                                          |
| `options.offset` | `number` | `undefined` | Number of messages to skip from the start                                     |

**Return type: `SessionMessage[]`**

| Property             | Type                    | Description                             |
| :------------------- | :---------------------- | :-------------------------------------- |
| `type`               | `"user" \| "assistant"` | Message role                            |
| `uuid`               | `string`                | Unique message identifier               |
| `session_id`         | `string`                | Session this message belongs to         |
| `message`            | `unknown`               | Raw message payload from the transcript |
| `parent_tool_use_id` | `null`                  | Reserved                                |

**Example:**

```typescript
import { listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

const [latest] = await listSessions({ dir: '/path/to/project', limit: 1 });

if (latest) {
  const messages = await getSessionMessages(latest.sessionId, {
    dir: '/path/to/project',
    limit: 20,
  });

  for (const msg of messages) {
    console.log(`[${msg.type}] ${msg.uuid}`);
  }
}
```

---

### 3. What `getSessionMessages()` Does NOT Provide

The `SessionMessage.message` field is typed as `unknown` — it is the **raw JSONL payload**, not a structured type. To access content like tool calls, text blocks, or tool results, you still need to cast/parse the `message` field yourself.

The return type is **only `"user" | "assistant"` messages**. System messages (init, result, compact_boundary, etc.) are NOT included in `getSessionMessages()` output — it filters to conversation-level messages only.

---

### 4. The Gap: No Historical Message Replay in `query()` (GitHub Issue #14)

When you call `query({ options: { resume: sessionId } })`, the SDK only **streams new messages** generated after resumption — it does NOT re-emit historical messages. This is the subject of [GitHub issue #14](https://github.com/anthropics/claude-agent-sdk-typescript/issues/14).

Example of the gap:

```typescript
const sessionQuery = query({
  prompt: '',
  options: {
    resume: '34e94925-f4cc-4685-8869-83c77062ad14',
    maxTurns: 0,
  },
});

// Only streams 3 messages: system, assistant, result
// Does NOT stream: 63 turns of historical conversation
for await (const message of sessionQuery) {
  console.log(message.type); // "system", "assistant", "result"
}
```

**Proposed solutions from the issue (not yet implemented):**

Option A — An `includeHistory` parameter on `query()`:

```typescript
query({
  prompt: '',
  options: {
    resume: sessionId,
    includeHistory: true, // proposed, not yet implemented
  },
});
```

Option B — A dedicated `getSessionHistory()` function:

```typescript
import { getSessionHistory } from '@anthropic-ai/claude-agent-sdk';
const history = await getSessionHistory(sessionId);
```

**The current workaround:** Use `getSessionMessages()` to read history separately, then display it alongside any new `query()` output. This is exactly what a session management dashboard (like DorkOS) would do.

---

### 5. Key Types from the SDK Relevant to History

**`SDKUserMessageReplay`** — Already in the SDK type system (suggesting replay was designed for):

```typescript
type SDKUserMessageReplay = {
  type: 'user';
  uuid: UUID;
  session_id: string;
  message: MessageParam;
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  tool_use_result?: unknown;
  isReplay: true; // Distinguishes replayed from new messages
};
```

This type exists in the SDK already, indicating the replay capability was designed for but not yet exposed via the `query()` API.

**`BaseHookInput.transcript_path`** — Every hook callback receives the path to the JSONL transcript:

```typescript
type BaseHookInput = {
  session_id: string;
  transcript_path: string; // Path to ~/.claude/projects/{slug}/{session-id}.jsonl
  cwd: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
};
```

---

### 6. Session Storage Location

Sessions are stored at:

```
~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
```

Where `<encoded-cwd>` is the absolute working directory with every non-alphanumeric character replaced by `-`. Example: `/Users/me/proj` → `-Users-me-proj`.

**Cross-host resume:** The SDK does NOT support remote session storage. To resume across machines, copy the JSONL file to the same path on the new host. Or use `getSessionMessages()` to capture conversation content and pass it as a fresh prompt.

---

## Implications for DorkOS

### What This Means for `transcript-reader.ts`

DorkOS currently parses JSONL transcripts manually in `transcript-reader.ts`. With `listSessions()` and `getSessionMessages()`, there is now an official SDK alternative that:

- Abstracts the JSONL parsing
- Handles the `encoded-cwd` path derivation automatically
- Supports pagination via `limit` and `offset`
- Returns sessions sorted by recency out of the box

**However**, the `SessionMessage.message` field is `unknown` — DorkOS's custom JSONL parsing likely already has typed schemas for the specific fields needed (content blocks, tool calls, etc.) that the SDK doesn't expose. The official API is higher-level but less typed than a custom parser.

### Recommended Approach for Session History in DorkOS

1. **Use `listSessions()`** to replace the custom session enumeration logic (directory scanning, JSONL file listing)
2. **Use `getSessionMessages()`** for basic session history display
3. **Continue custom JSONL parsing** for deep access to tool results, cost data, and typed content blocks not exposed by the SDK's `message: unknown` field
4. **Watch GitHub issue #14** for `includeHistory` parameter — when it lands, DorkOS can stream historical messages directly into the session view without a separate read call

---

## Sources & Evidence

- [Work with sessions — Claude API Docs](https://platform.claude.com/docs/en/agent-sdk/sessions) — Official sessions guide, `listSessions()` and `getSessionMessages()` documented under "Resume across hosts"
- [Agent SDK reference — TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript) — Full function signatures, `SDKSessionInfo`, `SessionMessage` return types
- [Feature Request: API to retrieve historical messages when resuming a session — GitHub Issue #14](https://github.com/anthropics/claude-agent-sdk-typescript/issues/14) — Documents the `query()` gap and proposed solutions

## Research Gaps & Limitations

- The exact shape of `SessionMessage.message` (the `unknown` field) is not typed in the official docs; it mirrors the raw JSONL record structure
- Whether `getSessionMessages()` includes tool use messages (tool_use blocks in assistant messages, tool_result blocks in user messages) or only top-level user/assistant turns is not 100% confirmed — the `type: "user" | "assistant"` suggests it includes both since tool results come back as user messages in the Anthropic message format
- The `includeWorktrees: true` default behavior and exactly which worktrees are included is not documented in detail
- GitHub issue #14 has no confirmed Anthropic response or ETA for `includeHistory`

## Search Methodology

- Searches performed: 1 web search + 2 WebFetch calls
- Most productive search terms: `@anthropic-ai/claude-agent-sdk read message history session conversation API 2026`
- Primary information sources: `platform.claude.com/docs/en/agent-sdk/sessions`, `platform.claude.com/docs/en/agent-sdk/typescript`, `github.com/anthropics/claude-agent-sdk-typescript/issues/14`
