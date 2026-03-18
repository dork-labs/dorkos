---
title: "Slack Interactive Tool Approval — Block Kit Buttons, app.action(), and Relay-Based Response Routing"
date: 2026-03-17
type: implementation
status: active
tags: [slack, bolt, block-kit, block_actions, tool-approval, interactivity, socket-mode, relay, correlation-id, security]
feature_slug: slack-tool-approval
searches_performed: 14
sources_count: 28
---

# Slack Interactive Tool Approval — Block Kit Buttons, app.action(), and Relay-Based Response Routing

**Date:** 2026-03-17
**Research Depth:** Deep
**Context:** The DorkOS Slack adapter currently handles messages and mentions only. This research covers adding interactive tool approval — posting a Block Kit card with Approve/Deny buttons when an agent requests permission to use a tool, routing the button response back through the relay, and resolving the pending `canUseTool` callback.

**Prior research incorporated:**
- `research/20260314_slack_bolt_socket_mode_best_practices.md` — rate limits, logging, streaming
- `research/20260313_slack_bot_adapter_best_practices.md` — Bolt setup, Socket Mode, scopes
- `research/20260315_agent_runtime_permission_modes.md` — `canUseTool`, permission modes, binding config
- `research/20260316_tool_approval_timeout_visibility_ux.md` — 10-minute timeout, countdown UX

---

## Research Summary

Socket Mode in Slack Bolt fully supports `block_actions` payloads without a public HTTP endpoint. The only requirements are: (1) add `interactivity: { is_enabled: true }` to the Slack app manifest (no `request_url` needed), and (2) register `app.action()` handlers. The canonical pattern for approval UX is to encode the `toolCallId` (correlation ID) in the button `value` field (max 2000 chars — JSON is safe), post the card on `approval_required`, and in the action handler update the original message via `client.chat.update()` using `body.message.ts`. The response is routed back through a `Map<toolCallId, { resolve, reject }>` registry — a pub/sub alternative that avoids relay round-trip complexity. Security in Socket Mode relies on Bolt's built-in WebSocket authentication (no HMAC replay-attack window exists since there is no HTTP endpoint); the remaining threat is workspace member authorization (who is allowed to click Approve).

---

## Key Findings

### 1. Socket Mode Fully Supports block_actions — No Public URL Required

Socket Mode delivers `block_actions` payloads over the same WebSocket connection as events. From Slack's official documentation:

> "When using Socket Mode, your app does not have to expose a public HTTP request URL. When you toggle Socket Mode on, you'll only receive events and interactive payloads over your WebSocket connections — not over HTTP."

Bolt routes these payloads to `app.action()` handlers automatically. No change is needed to the WebSocket setup. The only required change is to the **Slack app manifest**: add `interactivity: { is_enabled: true }` under `settings`. Without this, Slack will not dispatch button payloads. The `request_url` field is explicitly optional (and forbidden) in Socket Mode.

**Manifest addition:**
```yaml
settings:
  socket_mode_enabled: true
  interactivity:
    is_enabled: true
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - app_mention
```

**Current SLACK_APP_MANIFEST_YAML in `slack-adapter.ts` is missing `interactivity: { is_enabled: true }`** — this is the single manifest change needed.

### 2. app.action() Handler Pattern in Bolt TypeScript

```typescript
import { BlockButtonAction } from '@slack/bolt';

// In _start(), after the existing app.message() and app.event() registrations:
app.action<BlockButtonAction>('tool_approve', async ({ ack, body, client }) => {
  await ack(); // MUST be called within 3 seconds — call first, always
  // ... route approval response
});

app.action<BlockButtonAction>('tool_deny', async ({ ack, body, client }) => {
  await ack();
  // ... route denial response
});
```

The `ack()` function must be called within **3 seconds** of Slack dispatching the payload. Call it before any async work (agent notification, DB writes). Bolt handles the acknowledgment envelope automatically over the WebSocket.

Key fields available in `body` for `block_actions`:
- `body.user.id` — Slack user ID of who clicked
- `body.user.name` — display name
- `body.channel.id` — channel where the message lives
- `body.message.ts` — timestamp of the original message (for `chat.update`)
- `body.actions[0].action_id` — which button was clicked (`'tool_approve'` or `'tool_deny'`)
- `body.actions[0].value` — the string encoded in the button at message-send time
- `body.response_url` — short-lived webhook (usable up to 5 times in 30 minutes); alternative to `client.chat.update` but less reliable long-term

### 3. Encoding toolCallId in the Button Value Field

The button `value` field is a plain string with a **2000-character maximum**. The correct pattern for approval routing is to embed the `toolCallId` (and any other needed context) as a JSON string:

```typescript
// When building the approval card blocks:
const approveValue = JSON.stringify({
  toolCallId,
  sessionId,
  action: 'approve',
});

const denyValue = JSON.stringify({
  toolCallId,
  sessionId,
  action: 'deny',
});
```

In the action handler:
```typescript
const parsed = JSON.parse(body.actions[0].value) as {
  toolCallId: string;
  sessionId: string;
  action: 'approve' | 'deny';
};
```

**Size analysis:** A typical value object `{ toolCallId: uuid, sessionId: uuid, action: 'approve' }` is ~80 characters — well within the 2000-char limit. Do not encode tool parameters in the button value (they may be large). Store them server-side in the pending approval registry and look them up by `toolCallId`.

**Alternative: `action_id` as the discriminant, `value` as the key.** Use distinct `action_id` values (`'tool_approve'` vs `'tool_deny'`) and put only the `toolCallId` (and optionally `sessionId`) in `value`. This is cleaner and allows Bolt to route `tool_approve` and `tool_deny` to separate handlers:

```typescript
// Button elements:
{ action_id: 'tool_approve', value: JSON.stringify({ toolCallId, sessionId }) }
{ action_id: 'tool_deny',    value: JSON.stringify({ toolCallId, sessionId }) }

// Handlers:
app.action<BlockButtonAction>('tool_approve', ...) // only fires for approve
app.action<BlockButtonAction>('tool_deny', ...)    // only fires for deny
```

**Recommended:** Use the dual-handler pattern (separate `action_id` per button, `value` carries only IDs). This is simpler and more readable.

### 4. Block Kit Card Structure for Tool Approval

The approval card should follow the compact but information-dense layout that Slack's own approval bots use. Relevant blocks:

```typescript
function buildApprovalCard(opts: {
  toolName: string;
  toolInput: string; // JSON.stringify(input), truncated
  sessionId: string;
  toolCallId: string;
  agentName: string;
  timeoutMinutes: number;
}): KnownBlock[] {
  const approveValue = JSON.stringify({ toolCallId: opts.toolCallId, sessionId: opts.sessionId });
  const denyValue = JSON.stringify({ toolCallId: opts.toolCallId, sessionId: opts.sessionId });

  const truncatedInput = opts.toolInput.length > 300
    ? opts.toolInput.slice(0, 300) + '…'
    : opts.toolInput;

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Tool Approval Required', emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Tool:*\n\`${opts.toolName}\`` },
        { type: 'mrkdwn', text: `*Agent:*\n${opts.agentName}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Parameters:*\n\`\`\`${truncatedInput}\`\`\`` },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `:clock1: Expires in ${opts.timeoutMinutes} minutes — auto-denied if no response`,
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve', emoji: true },
          style: 'primary',
          action_id: 'tool_approve',
          value: approveValue,
          confirm: {
            title: { type: 'plain_text', text: 'Confirm Approval' },
            text: {
              type: 'mrkdwn',
              text: `Allow *${opts.toolName}* to run with these parameters?`,
            },
            confirm: { type: 'plain_text', text: 'Yes, approve' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny', emoji: true },
          style: 'danger',
          action_id: 'tool_deny',
          value: denyValue,
        },
      ],
    },
  ];
}
```

**Design rationale:**
- `header` block: immediately identifies the card type
- `section.fields`: two-column layout for tool name and agent name — compact
- `section.text`: code block for parameters — monospaced, shows JSON cleanly
- `context` block: timeout warning in subdued gray text — honest but unobtrusive
- `confirm` dialog on Approve: prevents accidental approvals; no confirm on Deny (less risky)
- `style: 'primary'` = green button; `style: 'danger'` = red button — Slack's standard approve/deny visual language

**Maximum Block Kit blocks per message:** 50. The approval card uses 5 — no concern.

**`text` fallback is mandatory** (for notifications and accessibility):
```typescript
await client.chat.postMessage({
  channel: channelId,
  thread_ts: threadTs,
  text: `Tool approval required: ${toolName}`, // fallback for push notifications
  blocks: buildApprovalCard(...),
});
```

### 5. Updating the Message After a Button Click

The canonical pattern is `client.chat.update` with the `body.message.ts` as the `ts` parameter:

```typescript
app.action<BlockButtonAction>('tool_approve', async ({ ack, body, client }) => {
  await ack();

  const { toolCallId, sessionId } = JSON.parse(body.actions[0].value);

  // 1. Route response to pending resolver
  resolveApproval(toolCallId, 'approve', body.user.id);

  // 2. Replace the interactive buttons with a result card
  if (body.message && body.channel) {
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: `Tool approved by <@${body.user.id}>`,
      blocks: buildApprovalResultCard({
        toolCallId,
        result: 'approved',
        approvedBy: body.user.id,
        toolName: /* retrieved from registry */,
      }),
    });
  }
});
```

**Why `client.chat.update` over `respond()`:**
- `respond()` uses the `response_url` webhook, which is valid for 5 uses and 30 minutes
- `client.chat.update` uses the bot token — persistent, reliable, no timeout
- `client.chat.update` is the correct choice for a production adapter

**Result card blocks (replaces the interactive card):**
```typescript
function buildApprovalResultCard(opts: {
  result: 'approved' | 'denied' | 'timeout';
  approvedBy?: string;
  toolName: string;
}): KnownBlock[] {
  const isApproved = opts.result === 'approved';
  const emoji = isApproved ? ':white_check_mark:' : opts.result === 'timeout' ? ':timer_clock:' : ':x:';
  const label = isApproved
    ? `Approved by <@${opts.approvedBy}>`
    : opts.result === 'timeout'
    ? 'Auto-denied — timed out'
    : `Denied by <@${opts.approvedBy ?? 'system'}>`;

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *${opts.toolName}* — ${label}`,
      },
    },
  ];
}
```

The interactive Actions block is deliberately absent from the result card — this removes the buttons, preventing double-click.

### 6. Architecture: Relay-Based Approval Routing

The approval flow must bridge two contexts: the Slack event handler (`app.action()`) and the agent runtime's `canUseTool` callback (which holds an open promise). The cleanest pattern is a **local pending-approval registry** (an in-memory `Map`) rather than a relay pub/sub round-trip.

**Why avoid relay pub/sub for approval responses:**
- Relay round-trips introduce latency and require subject design for response routing
- The `canUseTool` callback is already an in-process deferred promise in the server
- The Slack adapter and the server runtime live in the same process (relay package is imported directly)
- A local `Map` is simpler, testable, and zero-latency

**Pending approval registry:**
```typescript
type ApprovalDecision = 'approve' | 'deny';

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  reject: (reason: Error) => void;
  toolName: string;
  toolInput: string;
  sessionId: string;
  channelId: string;
  threadTs: string | undefined;
  messageTs: string;         // ts of the approval card message (for update)
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// In SlackAdapter (or a shared singleton for the Slack adapter instance):
private pendingApprovals = new Map<string, PendingApproval>();
```

**Approval request flow:**

```
Agent calls canUseTool(toolName, input)
  → SlackAdapter.requestApproval(toolCallId, toolName, input, sessionId, channelId, threadTs)
  → Build approval card blocks
  → client.chat.postMessage() → capture messageTs
  → Store PendingApproval in Map<toolCallId, ...> with setTimeout(10min, auto-deny)
  → Return Promise<'approve'|'deny'>  ← waits here

User clicks Approve/Deny button in Slack
  → Bolt dispatches block_actions to app.action('tool_approve' | 'tool_deny')
  → Parse toolCallId from body.actions[0].value
  → Look up PendingApproval in Map
  → clearTimeout(pending.timeoutHandle)
  → pending.resolve('approve') or pending.resolve('deny')
  → client.chat.update() with result card (remove buttons)
  → Map.delete(toolCallId)

canUseTool Promise resolves with 'approve' or 'deny'
  → Agent runtime proceeds or blocks the tool
```

**Integration point with the existing server architecture:**

The `ClaudeCodeAdapter` in the relay package already handles `approval_required` events from the agent runtime. The Slack adapter needs to intercept these and redirect them to Slack. Two options:

**Option A: Relay subject** — publish `relay.agent.approval.{toolCallId}` to Slack; adapter subscribes and posts the card. Response published back to `relay.agent.approval.{toolCallId}.response`. Requires relay round-trip but preserves loose coupling.

**Option B: Direct method injection** — pass an `onApprovalRequired` callback to the Slack adapter during initialization; the server wires this callback to call `slackAdapter.requestApproval(...)`.

**Option C: Event-based via the existing relay event system** — the server already emits `approval_required` events on sessions. Add a Slack-specific event handler in the adapter SDK layer that posts to Slack.

**Recommendation: Option C aligned with the existing `ClaudeCodeAdapter` pattern.** The existing `claude-code/agent-handler.ts` pattern handles tool approvals in-process. Extend this with a "remote approval" strategy: when the approval binding has an active Slack channel, post the card and await the response. This keeps the approval resolution local (no relay round-trip for the response) while using the existing `approval_required` event path for detection.

### 7. Handling Stale/Expired Button Clicks

When the 10-minute timeout fires before the user clicks:

**Server side:**
```typescript
const timeoutHandle = setTimeout(() => {
  const pending = this.pendingApprovals.get(toolCallId);
  if (!pending) return;
  this.pendingApprovals.delete(toolCallId);
  pending.resolve('deny'); // auto-deny on timeout

  // Update the Slack message to show "timed out"
  void this.app?.client.chat.update({
    channel: pending.channelId,
    ts: pending.messageTs,
    text: `Tool approval timed out — auto-denied`,
    blocks: buildApprovalResultCard({ result: 'timeout', toolName: pending.toolName }),
  }).catch(() => {});
}, INTERACTION_TIMEOUT_MS);
```

**When the user clicks an expired button (race condition — server timed out, user just clicked):**

The `app.action()` handler runs but `Map.get(toolCallId)` returns `undefined`. Handle gracefully:

```typescript
app.action<BlockButtonAction>('tool_approve', async ({ ack, body, client }) => {
  await ack(); // Always ack first

  const { toolCallId } = JSON.parse(body.actions[0].value);
  const pending = this.pendingApprovals.get(toolCallId);

  if (!pending) {
    // Already resolved (timeout fired, or another client clicked first)
    // Ephemeral message — only visible to the user who clicked
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: body.user.id,
      text: 'This approval has already been resolved (timed out or acted upon by another user).',
    });
    return;
  }

  // ... normal resolution path
});
```

**Slack UX note:** Once `chat.update` has removed the buttons (replaced with the result card), subsequent button clicks are impossible — the buttons no longer exist. The only stale-click scenario is the race window between the timeout firing and Slack reflecting the updated message to the user.

### 8. Security Considerations

#### Socket Mode Eliminates Replay Attack Surface

In HTTP mode, Slack sends a signed `X-Slack-Signature` header and a 5-minute timestamp window prevents replays. In Socket Mode, there is **no inbound HTTP endpoint** — all payloads arrive over an authenticated TLS WebSocket. The replay attack surface does not exist. Bolt handles the WebSocket authentication (via `xapp-...` token) automatically.

#### Who Can Approve — User Authorization

The `block_actions` payload includes `body.user.id` — the Slack user who clicked. Authorization options:

**Option A: Anyone in the workspace (no restriction)** — simplest, appropriate for small trusted teams. The risk is that any workspace member with channel access can approve tool executions.

**Option B: Restrict to original requester** — only the user who sent the triggering message can approve. Encode the `requestorUserId` in the button value:
```typescript
// In button value:
{ toolCallId, sessionId, allowedUserId: triggeringUserId }

// In action handler:
if (parsed.allowedUserId && body.user.id !== parsed.allowedUserId) {
  await client.chat.postEphemeral({
    channel: body.channel.id,
    user: body.user.id,
    text: 'Only the user who triggered this agent can approve tool requests.',
  });
  return;
}
```

**Option C: Restrict to an admin role list** — maintained server-side; check `body.user.id` against a configured allow-list.

**Recommendation:** Start with Option B (requestor-only). It maps to the intuitive mental model ("I asked the agent to do something, I decide if its tool is allowed") and prevents social engineering (another workspace member approving on behalf of the requestor). The `allowedUserId` in the button value is not a security mechanism by itself (values can be inspected by curious users) — the server-side check in the action handler is the enforcement point.

#### Sensitive Data in Button Values

Button values are transmitted as part of the `block_actions` payload and are visible to anyone with API access to the workspace. **Do not encode tool parameters in button values** — parameters may contain file paths, credentials, or command arguments. Store them server-side in the pending approval registry and retrieve them by `toolCallId`. The `toolCallId` itself (a UUID) is safe to encode.

#### Rate Limiting

Each tool approval posts one `chat.postMessage` (card) and one `chat.update` (result). These are low-frequency events — no rate limit concern. The pending approval registry bounds the number of concurrent open approvals.

### 9. Alternatives Compared

| Approach | Complexity | UX Quality | Reliability | Verdict |
|---|---|---|---|---|
| **Block Kit buttons (recommended)** | Medium | Excellent | High | Ship this |
| Text-based ("reply 'approve' or 'deny'") | Low | Poor — easy to mistype, no context shown | Medium | Fallback only |
| Emoji reaction-based | Low | Poor — confusing, no confirmation | Low | Do not use |
| Slack slash commands (`/approve toolCallId`) | Low | Poor — requires knowing the toolCallId | Low | Do not use |
| Slack modals | High | Good — full form UI | High | Overkill for approve/deny |

**Text-based fallback scenario:** If Block Kit interactivity cannot be enabled (e.g., workspace restriction), a text parser in the `app.message()` handler can look for replies in the tool approval thread containing "approve" or "deny". Less reliable but zero additional setup.

**Why not emoji reactions:**
- No reliable delivery guarantee
- The `reaction_added` event can be missed
- No confirmation dialog — accidental reactions are common
- No user feedback after reaction

---

## Detailed Analysis

### Manifest Changes Required

The existing `SLACK_APP_MANIFEST_YAML` in `slack-adapter.ts` needs two additions:

```yaml
settings:
  socket_mode_enabled: true
  interactivity:
    is_enabled: true    # ← NEW: enables block_actions dispatch
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - app_mention
```

No additional OAuth scopes are required. `chat:write` (already in the manifest) covers `chat.update` and `chat.postEphemeral`. The `chat.postEphemeral` method uses `chat:write` scope.

The `SLACK_CREATE_APP_URL` is generated from the manifest YAML — updating the YAML automatically updates the one-click setup URL.

### Adapter Code Architecture

The `SlackAdapter._start()` method currently registers two handlers:
```typescript
app.message(...)
app.event('app_mention', ...)
```

The approval feature adds:
```typescript
app.action<BlockButtonAction>('tool_approve', ...)
app.action<BlockButtonAction>('tool_deny', ...)
```

These handlers need access to `this.pendingApprovals` (the registry map). Since they are registered inside `_start()`, they close over `this` naturally.

The `requestApproval()` public method (called by the server-side adapter layer) posts the card and returns a promise:

```typescript
/**
 * Post a tool approval request card to Slack and await the user's decision.
 *
 * @param opts.toolCallId - Unique ID for this approval request (correlation key)
 * @param opts.toolName - Human-readable tool name for display
 * @param opts.toolInput - JSON-stringified tool parameters (truncated for display)
 * @param opts.sessionId - Agent session ID for context
 * @param opts.channelId - Slack channel to post in
 * @param opts.threadTs - Thread to reply under (for threading)
 * @param opts.agentName - Display name of the requesting agent
 * @param opts.timeoutMs - Milliseconds before auto-deny (default: INTERACTION_TIMEOUT_MS)
 */
async requestApproval(opts: {
  toolCallId: string;
  toolName: string;
  toolInput: string;
  sessionId: string;
  channelId: string;
  threadTs?: string;
  agentName: string;
  timeoutMs?: number;
}): Promise<'approve' | 'deny'> {
  if (!this.app) throw new Error('SlackAdapter not started');

  const timeoutMs = opts.timeoutMs ?? INTERACTION_TIMEOUT_MS;

  return new Promise<'approve' | 'deny'>((resolve, reject) => {
    const blocks = buildApprovalCard({
      toolName: opts.toolName,
      toolInput: opts.toolInput,
      sessionId: opts.sessionId,
      toolCallId: opts.toolCallId,
      agentName: opts.agentName,
      timeoutMinutes: Math.round(timeoutMs / 60_000),
    });

    this.app!.client.chat.postMessage({
      channel: opts.channelId,
      thread_ts: opts.threadTs,
      text: `Tool approval required: ${opts.toolName}`,
      blocks,
    }).then((result) => {
      const messageTs = (result as { ts?: string }).ts ?? '';

      const timeoutHandle = setTimeout(() => {
        if (!this.pendingApprovals.has(opts.toolCallId)) return;
        this.pendingApprovals.delete(opts.toolCallId);
        resolve('deny');

        // Fire-and-forget: update the message to show timeout
        void this.app?.client.chat.update({
          channel: opts.channelId,
          ts: messageTs,
          text: 'Tool approval timed out — auto-denied',
          blocks: buildApprovalResultCard({
            result: 'timeout',
            toolName: opts.toolName,
          }),
        }).catch(() => {});
      }, timeoutMs);

      this.pendingApprovals.set(opts.toolCallId, {
        resolve,
        reject,
        toolName: opts.toolName,
        toolInput: opts.toolInput,
        sessionId: opts.sessionId,
        channelId: opts.channelId,
        threadTs: opts.threadTs,
        messageTs,
        timeoutHandle,
      });
    }).catch(reject);
  });
}
```

And the action handlers complete the loop:
```typescript
// Registered in _start():
app.action<BlockButtonAction>('tool_approve', async ({ ack, body, client }) => {
  await ack();
  await this.handleApprovalAction(body, client, 'approve');
});

app.action<BlockButtonAction>('tool_deny', async ({ ack, body, client }) => {
  await ack();
  await this.handleApprovalAction(body, client, 'deny');
});
```

```typescript
private async handleApprovalAction(
  body: BlockButtonAction['body'],  // approximate — use proper Bolt types
  client: WebClient,
  decision: 'approve' | 'deny',
): Promise<void> {
  const parsed = JSON.parse(body.actions[0].value) as {
    toolCallId: string;
    sessionId: string;
    allowedUserId?: string;
  };

  const pending = this.pendingApprovals.get(parsed.toolCallId);

  if (!pending) {
    // Already resolved — inform user via ephemeral message
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: body.user.id,
      text: 'This approval has already been resolved.',
    }).catch(() => {});
    return;
  }

  // Authorization check (if requestor-only mode)
  if (parsed.allowedUserId && body.user.id !== parsed.allowedUserId) {
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: body.user.id,
      text: 'Only the user who triggered this request can approve or deny it.',
    }).catch(() => {});
    return;
  }

  // Clean up registry and cancel timeout
  this.pendingApprovals.delete(parsed.toolCallId);
  clearTimeout(pending.timeoutHandle);

  // Resolve the promise (unblocks canUseTool)
  pending.resolve(decision);

  // Update the Slack message to remove buttons and show result
  await client.chat.update({
    channel: pending.channelId,
    ts: pending.messageTs,
    text: `Tool ${decision === 'approve' ? 'approved' : 'denied'} by <@${body.user.id}>`,
    blocks: buildApprovalResultCard({
      result: decision,
      approvedBy: body.user.id,
      toolName: pending.toolName,
    }),
  }).catch((err) => {
    this.recordError(err);
  });
}
```

### How the Slack Adapter Receives approval_required Events

The DorkOS architecture has the agent runtime emitting `approval_required` SSE events through the session event queue. The relay's `ClaudeCodeAdapter` in `agent-handler.ts` listens for these events. The Slack adapter needs to be wired into this approval path.

The cleanest integration point is in `claude-code-adapter.ts` (the relay-side adapter, not the server runtime). When processing a session's events and encountering `approval_required`, the adapter checks whether the triggering message came from a Slack adapter context. If so, it calls `slackAdapter.requestApproval()` and passes the result back to the runtime via `runtime.approveTool(toolCallId, decision)`.

This integration requires the `ClaudeCodeAdapter` to have a reference to the `SlackAdapter` instance — which is achieved either through dependency injection at startup or a shared registry.

### Multiple Pending Approvals

The `Map<toolCallId, PendingApproval>` registry handles concurrent approvals naturally — each tool call has a unique UUID key. Multiple approvals can be pending simultaneously in different threads/channels.

**Visual concern:** If an agent generates multiple tool approval requests in rapid succession within the same thread, the user sees multiple approval cards stacked in the thread. This is honest — each card represents a distinct pending decision. Do not coalesce them (the agent genuinely needs separate decisions).

### Cleanup on Adapter Stop

When `_stop()` is called, all pending approvals should be auto-denied:

```typescript
protected async _stop(): Promise<void> {
  // Auto-deny all pending approvals on shutdown
  for (const [toolCallId, pending] of this.pendingApprovals) {
    clearTimeout(pending.timeoutHandle);
    pending.resolve('deny');
  }
  this.pendingApprovals.clear();

  // ... existing stop logic
}
```

---

## Sources & Evidence

- [Using Socket Mode | Slack Developer Docs](https://docs.slack.dev/apis/events-api/using-socket-mode/) — "your app does not need a Request URL to use the Events API"; block_actions delivered over WebSocket
- [Handling user interaction | Slack Developer Docs](https://docs.slack.dev/interactivity/handling-user-interaction/) — `response_url`, `ack()` 3-second requirement, ephemeral messages
- [Listening & responding to actions | Bolt for JS](https://docs.slack.dev/tools/bolt-js/concepts/actions/) — `app.action()`, `ack()`, `body.message.ts`, `respond()` with `replace_original`
- [block_actions payload reference | Slack](https://docs.slack.dev/reference/interaction-payloads/block_actions-payload) — full payload structure: `actions[].action_id`, `actions[].value`, `message.ts`, `channel.id`, `user.id`, `response_url`
- [Actions block | Slack Developer Docs](https://docs.slack.dev/reference/block-kit/blocks/actions-block/) — button element structure, `action_id` (max 255 chars), `value` (max 2000 chars), `style: 'primary' | 'danger'`, `confirm` object
- [App manifest reference | Slack Developer Docs](https://docs.slack.dev/reference/app-manifest/) — `settings.interactivity.is_enabled`, `request_url` optional in Socket Mode
- [Block Kit | Slack Developer Docs](https://docs.slack.dev/block-kit/) — block types, layout patterns, `header`, `section.fields`, `context`, `actions`
- [Creating interactive Slack apps with Bolt | Knock](https://knock.app/blog/creating-interactive-slack-apps-with-bolt-and-nodejs) — `app.action()` with Socket Mode, button value patterns
- [Announcement approvals template | slackapi/template-announcement-approvals](https://github.com/slackapi/template-announcement-approvals) — official Slack approval workflow architecture: button value encodes context, message update pattern after decision
- [Six UX Challenges Building Slack Apps | Cloverpop](https://www.cloverpop.com/blog/six-ux-challenges-when-building-slack-apps-and-how-we-fixed-them) — ephemeral messages for single-user feedback, "let Slack be Slack", avoid button re-click
- [Verifying requests from Slack | Slack Developer Docs](https://docs.slack.dev/authentication/verifying-requests-from-slack/) — Socket Mode replaces HMAC signature verification (no HTTP endpoint)
- [Developing approval workflows | Slack](https://api.slack.com/best-practices/blueprints/approval-workflows) — canonical approval workflow architecture, DM-based routing
- [bolt-js TypeScript example](https://github.com/slackapi/bolt-js/blob/main/examples/getting-started-typescript/src/app.ts) — `app.action<BlockButtonAction>()` TypeScript generics
- [chat.update method | Slack](https://api.slack.com/methods/chat.update) — requires `channel` + `ts`; omitting `blocks` removes them; `chat:write` scope
- [chat.postEphemeral | Slack WebClient](https://api.slack.com/methods/chat.postEphemeral) — user-only message; uses `chat:write` scope
- DorkOS source: `packages/relay/src/adapters/slack/slack-adapter.ts` — current adapter, missing `app.action()` handlers and `interactivity` manifest section
- DorkOS source: `packages/relay/src/adapters/slack/inbound.ts` — `handleInboundMessage`, `StandardPayload`, `platformData.ts` (Slack message timestamp)
- DorkOS source: `packages/relay/src/adapters/slack/outbound.ts` — `wrapSlackCall`, `ActiveStream`, `client.chat.update` usage patterns
- DorkOS research: `20260315_agent_runtime_permission_modes.md` — `canUseTool` callback, `PendingApproval` deferred promise pattern
- DorkOS research: `20260316_tool_approval_timeout_visibility_ux.md` — 10-minute timeout constant, auto-deny on timeout, cross-client resolution
- DorkOS research: `20260314_slack_bolt_socket_mode_best_practices.md` — `wrapSlackCall` pattern, rate limits, `chat.update` throttling

---

## Research Gaps & Limitations

- The exact TypeScript type for `body` in a `BlockButtonAction` handler was not confirmed from source — the `BlockButtonAction` type from `@slack/bolt` should be verified at implementation time. Bolt's TypeScript support is functional but documented as incomplete.
- Whether `chat.postEphemeral` (for stale-click feedback) requires a bot being in the channel was not confirmed. In DMs the bot is always present; in channels it must be `/invite`-ed. The ephemeral message failure is non-critical (best-effort UX) — the approval resolution itself doesn't depend on it.
- The `confirm` dialog on the Approve button was not confirmed to work in Socket Mode on all Slack client versions. On mobile Slack, confirmation dialogs have historically had rendering issues. This is low risk — the `confirm` is UX polish, not a security mechanism.
- The exact `ClaudeCodeAdapter` integration point (how `approval_required` events are detected at the relay layer and routed to `slackAdapter.requestApproval()`) was not fully traced in the source. The `agent-handler.ts` file was not read; that integration requires a follow-up codebase analysis.
- The `chat.postEphemeral` scope requirement was assumed to be `chat:write` — should be confirmed; some Slack plans may require `chat:write.public` for ephemeral messages in public channels.

---

## Contradictions & Disputes

- **`respond()` vs `client.chat.update`**: The Slack Bolt docs show `respond()` as the primary action response method. In practice, `respond()` uses the `response_url` webhook (valid 5 uses, 30 min), making it fragile for production. `client.chat.update` with `body.message.ts` is the more reliable pattern — confirmed by multiple third-party sources and the `template-announcement-approvals` repo.
- **`interactivity.is_enabled` manifest requirement**: The Slack docs are inconsistent about whether this field is strictly required for Socket Mode. Some sources say "interactivity features just work in Socket Mode." The manifest reference explicitly lists `is_enabled` as the gating field. Safest path: include it in the manifest.

---

## Search Methodology

- Searches performed: 14
- Most productive search terms: "Slack bolt app.action block_actions Socket Mode interactivity 2025", "Slack block kit approve deny buttons action_id value correlation ID", "Slack block_actions update message after button click ack respond replace", "Slack interactivity socket mode manifest is_enabled request_url optional"
- Primary sources: docs.slack.dev, github.com/slackapi/bolt-js, github.com/slackapi/template-announcement-approvals, DorkOS codebase
- DorkOS codebase was the most important input — the existing `slack-adapter.ts`, `inbound.ts`, `outbound.ts`, and prior research reports provided 60% of the context needed
