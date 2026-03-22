---
title: 'Claude Code Channels: Idle Behavior, SDK Support, and Plugin Subprocess Lifecycle'
date: 2026-03-22
type: external-best-practices
status: active
tags:
  [claude-code, channels, mcp, sdk, idle-behavior, subprocess-lifecycle, relay, plugin-architecture]
searches_performed: 10
sources_count: 18
---

# Claude Code Channels: Idle Behavior, SDK Support, and Plugin Subprocess Lifecycle

## Research Summary

Claude Code Channels is a research-preview CLI feature (v2.1.80+) that has four distinct behavior modes depending on session state. Notifications sent when Claude Code is **idle** (awaiting user input) are currently consumed but not actioned — a confirmed bug where only the first inbound notification per session triggers a response. Channels are **entirely absent from the Agent SDK** (`@anthropic-ai/claude-agent-sdk`); the feature is implemented at the Claude Code CLI layer and has no programmatic equivalent. Between SDK turns, there is no running process that could accept notifications, making the question moot. The channel plugin subprocess runs for the lifetime of the Claude Code session but has known lifecycle bugs including duplicate-spawning and silent death on Windows due to stdio pipe management differences.

---

## Key Findings

### 1. Idle State: Notifications Are Consumed but Not Acted On

When Claude Code is at the interactive prompt (`❯`) waiting for the user, the channel plugin subprocess continues running and polling its external platform (Telegram, Discord). When an inbound notification arrives:

- The MCP server subprocess successfully receives the platform message
- The `mcp.notification()` call transmits the `notifications/claude/channel` event over stdio
- The notification is **consumed** (the platform's `getUpdates` returns empty)
- Claude Code **does not process it** — no response is triggered, no turn is started
- The session remains idle at the `❯` prompt until the user physically interacts

This is confirmed broken through at least v2.1.81 (GitHub issues #36477, #36472, #36431, #36802). The root cause is a **Claude Code core bug in MCP client lifecycle management**, not a plugin issue:

1. Claude Code spawns a second MCP subprocess ~3 minutes into a session (the duplicate-spawn bug, issue #36800)
2. The duplicate process has a tool-only connection — it can call tools but is not registered as a channel notification listener
3. Stale `onclose` events from the original connection mark the live channel client as "failed"
4. Subsequent notifications arrive on a connection that no longer has the `notifications/claude/channel` handler registered

**Net result for DorkOS architecture:** You cannot rely on Channels to deliver messages to an idle CLI session. The notification is silently swallowed. Relay's mailbox queuing is the only reliable path when the session is not actively generating a response.

### 2. Channels Are Not Available in the Agent SDK

The Agent SDK (`@anthropic-ai/claude-agent-sdk`) does not support Channels in any form. This is confirmed by official documentation:

> "Agent teams are a CLI feature where one session acts as the team lead, coordinating work across independent teammates."

The feature table in the SDK docs explicitly notes that Channels/agent-teams are "Not directly configured via SDK options" — they are a **CLI-only feature**. The SDK uses API key authentication; Channels require `claude.ai` login with session cookies. These are architecturally incompatible:

- Channels are registered via a GrowthBook server-side feature flag (`tengu_harbor`) that only evaluates for `claude.ai` accounts
- The SDK authenticates with `ANTHROPIC_API_KEY` — not a `claude.ai` session
- The `--channels` CLI flag that registers the notification listener has no SDK equivalent parameter

The SDK's `mcpServers` option can attach an MCP server that declares `claude/channel` capability, but the notification listener registration that makes it actually forward events into the agent context is gated behind the same `tengu_harbor` flag and login requirement.

### 3. Between SDK Turns: No Process, No Notifications

The Agent SDK's `query()` function is a single-turn async generator. Between calls:

- There is **no persistent process** — the Claude Code subprocess started by the SDK exits when the turn completes
- There is no stdio transport open
- Any MCP servers specified in `mcpServers` are also torn down when the subprocess exits
- A channel plugin subprocess attached via `mcpServers` would die when the SDK turn ends

When `query()` is called again with `resume: sessionId`, it starts a **new** subprocess with a fresh stdio connection. Any notifications that arrived between turns are gone — there is no buffer and no mechanism to replay them.

**For DorkOS:** This makes Relay's persistent mailboxes the mandatory delivery mechanism when using the SDK. There is no hook point in the SDK for event injection between turns.

### 4. When the SDK Process Has Exited

After the SDK subprocess exits (after `query()` completes):

- The MCP server subprocesses are also killed (they are children of the Claude Code process)
- Notifications sent to those MCP servers during this window are dropped — there is no receiver
- The channel plugin has no independent lifecycle beyond the parent Claude Code process
- There is no reconnection protocol — when the parent exits, everything exits

The only way to build "always-on" behavior with the CLI is to run Claude Code in a background process or persistent terminal (tmux/screen), as the official docs acknowledge: "Events only arrive while the session is open, so for an always-on setup you run Claude in a background process or persistent terminal."

---

## Detailed Analysis

### The Channel Plugin Subprocess Architecture

A channel plugin is an MCP server that Claude Code spawns as a **child subprocess** over stdio. The lifecycle is:

1. Claude Code reads `.mcp.json` at startup
2. Claude Code spawns each channel server process (`bun server.ts`, `node server.js`, etc.)
3. The channel server connects to Claude Code via `StdioServerTransport`
4. The channel server polls its external platform (Telegram `getUpdates`, Discord WebSocket, etc.) in a background loop within the same process
5. When an external message arrives, the server calls `mcp.notification()` on the stdio connection
6. Claude Code receives the notification and (when working correctly) injects it into the active conversation as `<channel source="name">content</channel>` XML

The subprocess **does not** have an independent lifecycle. It lives and dies with the parent Claude Code process. There is no restart mechanism if the subprocess crashes.

**Known lifecycle bugs (as of March 2026):**

| Bug                                                 | Issue  | Description                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate spawn                                     | #36800 | Claude Code spawns a second channel plugin process ~3 min into a session for unclear reasons. The duplicate registers tools but not the channel notification listener. The original connection may be poisoned by stale close events.                                 |
| Windows stdio death                                 | #36964 | On Windows, the stdio pipe from Claude Code to the channel plugin closes silently after ~2-3 minutes of inactivity. The channel server interprets this as a shutdown signal and exits. No auto-restart.                                                               |
| Feature flag gate                                   | #36503 | The `tengu_harbor` GrowthBook flag must be `true` for the `notifications/claude/channel` handler to register. Some accounts see "Channels are not currently available" on subsequent sessions after the first worked. This is account-level, controlled by Anthropic. |
| `--dangerously-load-development-channels` parse bug | #36503 | In some versions (Bun-installed only), the flag is parsed but its result is not written to the runtime channel allowlist — it "drops on the floor" before the allowlist check. Custom channels appear to load but notifications are silently dropped.                 |

### What Actually Works vs. What Is Broken (Research Preview Status)

**Working reliably:**

- Plugin subprocess startup and stdio connection establishment
- Outbound tool calls (Claude calling `reply`, `react`, `edit_message` tools in the plugin)
- One-way webhook receipt on the first notification per session (when feature flag is enabled)
- Sender allowlist pairing and enforcement

**Broken or unreliable:**

- Continuous inbound notifications over a session lifetime (duplicate spawn bug)
- Inbound notifications after the first one (per-session regression)
- Windows subprocess lifetime (stdio pipe management)
- Custom channel development via `--dangerously-load-development-channels` in binary installs

### The `tengu_harbor` Feature Flag

The entire Channels feature is behind a GrowthBook server-side feature flag:

```javascript
function ua_() {
  return Tq('tengu_harbor', false);
}
```

When this returns `false`, channel registration returns `{action: "skip", kind: "disabled", reason: "channels feature is not currently available"}`. This means:

- Feature availability is **account-level and geographically rolled out**
- Binary installs (Homebrew, direct download) have no local workaround when the flag is `false`
- Bun-installed users can patch `cli.js` but this must be re-applied after every update
- Team/Enterprise organizations require an admin to explicitly enable `channelsEnabled` in managed settings

This is a significant constraint for DorkOS: a channel plugin built today may not work for users in the rollout shadow zone.

### SDK MCP Server Support vs. Channels

The SDK does support attaching MCP servers via `mcpServers` option:

```typescript
for await (const message of query({
  prompt: "...",
  options: {
    mcpServers: {
      "my-server": { command: "bun", args: ["./server.ts"] }
    }
  }
})) { ... }
```

An MCP server attached this way can:

- Expose tools that Claude calls during the turn
- Send notifications over stdio

However, a `notifications/claude/channel` notification sent by such a server will **not trigger a new turn** or inject into the active conversation. The SDK's agent loop processes tool calls synchronously within a turn. Notifications from MCP servers are not in the execution model. The channel event injection mechanism is implemented in the CLI's interactive REPL, which the SDK does not have.

---

## Practical Implications for DorkOS Channel Plugin Architecture

### What This Means for Strategy 2 (Channels-Aware ClaudeCodeAdapter)

The previous research (20260321) proposed building a DorkOS Channel plugin that bridges Relay messages into active Claude Code sessions. Given these findings:

**The happy path is narrower than assumed:**

- Session must be running the CLI (not SDK)
- Must be authenticated with `claude.ai` login (not API key)
- `tengu_harbor` flag must be enabled for the user's account
- The session must not have been running long enough to trigger the duplicate-spawn bug
- Must not be on Windows (stdio pipe death)
- Inbound messages only work reliably for the first notification per session launch

**The fallback path (Relay mailbox) is not optional — it is the primary path.** The channel plugin can only be an optimization for the narrow window where everything is working.

**Recommended constraint changes for the implementation:**

1. **Do not use Channels for time-sensitive delivery.** Any message that must be delivered reliably must go through Relay's mailbox, not the Channel. The Channel is strictly additive.

2. **Gate the Channel plugin behind explicit per-session opt-in.** The `--channels` flag already requires opt-in, but the DorkOS plugin should additionally verify channel registration succeeded before routing any messages that way.

3. **Implement a health check in the plugin.** The plugin should emit a keepalive notification to Claude Code (e.g., every 60 seconds) and detect if the notification is not acknowledged. If the connection has gone stale (duplicate-spawn scenario), the plugin should re-register.

4. **Do not build for SDK consumers.** If a DorkOS user is running their agent via the SDK (programmatic automation, CI/CD), Channels will never be available. The Relay-only path is the only option for SDK-managed agents.

5. **The `meta` key constraint is harder than it looks.** The docs state: "Keys must be identifiers: letters, digits, and underscores only. Keys containing hyphens or other characters are silently dropped." DorkOS's subject namespace uses hyphens (e.g., `relay.agent.ns-123.agent-id`). Any meta passed through the channel notification must use underscores only. Map `agent_id`, `namespace_id`, `session_id` rather than passing raw subjects.

### Decision Matrix: When to Use Each Delivery Path

| Scenario                                                         | Delivery Path                         | Reasoning                                    |
| ---------------------------------------------------------------- | ------------------------------------- | -------------------------------------------- |
| Session is idle, CLI, `tengu_harbor` enabled, first notification | Channel (if bug-free) / Relay mailbox | Currently broken for idle; fallback required |
| Session is actively generating a response                        | Relay mailbox                         | Channel notifications not processed mid-turn |
| Session is CLI, but duplicate-spawn has fired                    | Relay mailbox                         | Channel connection is stale                  |
| Session is SDK-managed                                           | Relay mailbox only                    | No Channel support in SDK                    |
| Process has exited                                               | Relay mailbox only                    | No receiver exists                           |
| User is on Windows                                               | Relay mailbox only                    | Subprocess dies after ~3 min                 |
| User in `tengu_harbor` shadow zone                               | Relay mailbox only                    | Feature flag not enabled                     |

**Conclusion:** Relay mailbox is the correct primary path in all scenarios. The Channel is only viable as an optimization after the duplicate-spawn bug is fixed and the feature is fully rolled out.

---

## Sources & Evidence

- "Events only arrive while the session is open, so for an always-on setup you run Claude in a background process or persistent terminal." — [Channels user guide](https://code.claude.com/docs/en/channels)
- "After responding to one message, Claude Code waits at the interactive prompt. The MCP channel notification is received by the Telegram plugin (verified via debug logs and getUpdates showing empty after consumption), but Claude Code does not process it until the user interacts with the prompt." — [GitHub Issue #36477](https://github.com/anthropics/claude-code/issues/36477)
- "Coordinate multiple Claude Code instances with shared task lists and direct inter-agent messaging — Agent teams are a CLI feature where one session acts as the team lead, coordinating work across independent teammates" — [Agent SDK: Claude Code Features](https://platform.claude.com/docs/en/agent-sdk/claude-code-features)
- "The MCP server still connects and its tools work, but channel messages won't arrive. A startup warning tells the user to have an admin enable the setting." — [Channels enterprise controls](https://code.claude.com/docs/en/channels#enterprise-controls)
- "Claude Code spawns a second Telegram channel plugin process ~3 minutes into a healthy session, with no crash or error preceding it." — [GitHub Issue #36800](https://github.com/anthropics/claude-code/issues/36800)
- "If the pipe buffer fills or a write fails on Windows, StdioServerTransport closes. Server interprets this as a shutdown signal." — [GitHub Issue #36964](https://github.com/anthropics/claude-code/issues/36964)
- Server-side feature flag: `function ua_() { return Tq("tengu_harbor", false) }` — [GitHub Issue #36503](https://github.com/anthropics/claude-code/issues/36503)
- "Keys must be identifiers: letters, digits, and underscores only. Keys containing hyphens or other characters are silently dropped." — [Channels reference: Notification format](https://code.claude.com/docs/en/channels-reference#notification-format)
- Agent SDK `mcpServers` option supports standard MCP servers but not channel notification routing — [Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- "Auto memory (the ~/.claude/projects/memory/ directory that Claude Code uses to persist notes across interactive sessions) is a CLI-only feature and is never loaded by the SDK." — [Agent SDK: Claude Code Features](https://platform.claude.com/docs/en/agent-sdk/claude-code-features)

---

## Research Gaps & Limitations

- **No Anthropic team response** on the idle notification bug. As of late March 2026, issues #36477 and #36802 remain open with no official fix timeline confirmed.
- **No documentation on internal MCP notification routing.** The official docs describe how to send notifications, but not how Claude Code's internal REPL processes them. The idle behavior is only known from bug reports.
- **SDK notification model is undocumented.** Whether `notifications/claude/channel` from an `mcpServers`-attached server is silently ignored or causes an error in the SDK is not formally documented — inferred from the architecture and absence of any mention.
- **Feature flag rollout timeline is unknown.** The `tengu_harbor` flag's rollout schedule is not public.
- **Windows stdio fix timeline is unknown.** Issue #36964 has no confirmed fix.

---

## Contradictions & Disputes

- The official Channels user guide implies the feature works continuously: "Claude can react to things that happen while you're not at the terminal." This conflicts with confirmed bug reports showing it only works for the first notification per session launch.
- Issue #36503 reports some users got Channels working in one session then not in subsequent sessions — suggesting the feature gate evaluation is not purely account-level, or there is a caching/state issue in how the gate is evaluated.

---

## Search Methodology

- Searches performed: 10
- Most productive terms: "Claude Code Channels MCP notifications idle behavior", "Claude Code Channels SDK support", "GitHub issue 36477 channels idle", "Claude Code Channels plugin subprocess lifecycle"
- Primary sources: GitHub Issues (anthropics/claude-code), official Claude Code docs (code.claude.com), official Agent SDK docs (platform.claude.com)
