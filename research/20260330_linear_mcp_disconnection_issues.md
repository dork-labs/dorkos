---
title: 'Linear MCP Disconnection and Reliability Issues in Claude Code'
date: 2026-03-30
type: external-best-practices
status: active
tags: [linear, mcp, claude-code, reliability, disconnection, oauth, troubleshooting]
searches_performed: 9
sources_count: 18
---

## Research Summary

Linear MCP disconnection in Claude Code is a real, multi-layered problem with three distinct root causes: (1) a documented Claude Code bug where OAuth refresh tokens are stored but never used, requiring manual re-authentication whenever access tokens expire; (2) a VS Code extension-specific startup race condition where MCP servers silently fail to connect if the handshake doesn't complete within the startup timeout window; and (3) a broader Claude Code issue where SSE-based MCP servers can crash the entire session rather than gracefully degrade on network failure. Using a Linear API key with Bearer auth instead of OAuth is the most reliable long-term workaround.

## Key Findings

1. **OAuth refresh token bug (most critical)** — Claude Code stores MCP OAuth refresh tokens but never uses them to refresh expired access tokens (issue #21333). Linear's access tokens have a 24-hour TTL; when they expire, Claude Code fails with auth errors instead of transparently refreshing. This is the most likely cause of "Linear MCP stopped working" reports. The issue was closed as a duplicate of #5706 (open since July 2025) with no fix as of March 2026.

2. **VS Code extension silent startup failure** — The Claude Code VS Code extension fails to connect MCP servers without any error or notification when the MCP handshake doesn't complete within the startup timeout (issue #25751, closed as duplicate of #24770). The workaround is "Developer: Reload Window" before each session — the second handshake succeeds because the server process is already warm from the first attempt. This does not affect the CLI.

3. **Linear-specific VS Code regression (Oct 2025)** — Issue #9362 documents Linear MCP working in the CLI but completely failing in the VS Code extension starting ~Oct 9, 2025. Multiple users confirmed through December 2025. Closed as NOT_PLANNED after 60 days of inactivity with no root cause identified.

4. **No auto-reconnect capability** — When any MCP server disconnects mid-session (idle timeout, crash, network interruption), Claude Code has no automatic reconnection. Users must restart the entire session, losing all conversation context. Feature request #36308 (March 2026) was closed as duplicate of three related issues (#15758, #27142, #22366) — indicating widespread acknowledgment with no implementation yet.

5. **SSE transport crash vs. graceful degradation** — Issue #18557 documents that when an SSE MCP server's network connection fails catastrophically (TCP break, service killed), Claude Code crashes and exits silently instead of marking the server as unavailable and continuing. Closed as NOT_PLANNED (Feb 2026). Note: SSE transport is deprecated in the MCP specification; Streamable HTTP is the replacement.

6. **MCP timeout settings ignored** — Issue #20335 documents Claude Code ignoring `MCP_TIMEOUT` and `MCP_TOOL_TIMEOUT` settings in `~/.claude/settings.json`, causing SSE streams to disconnect after ~5 minutes regardless of configuration. Closed as NOT_PLANNED (March 2026, marked as regression). This affects any remote MCP server with slower responses.

7. **Security advisory on mcp-remote** — CVE-2025-6514 was a critical command injection vulnerability in `mcp-remote` versions 0.0.5 through 0.1.15. The package forwarded OAuth URLs without sanitization. Fixed in version 0.1.16. If using the `mcp-remote` bridge (older setups), ensure it is updated.

## Detailed Analysis

### Root Cause Tree

```
"Linear MCP tools not available in Claude Code"
├── OAuth token expired → refresh bug (most common)
│   └── Fix: Use API key auth instead of OAuth
├── VS Code extension startup race condition
│   └── Fix: Reload Window before session
├── Linear VS Code regression (Oct 2025)
│   └── Status: No fix, closed NOT_PLANNED
├── Mid-session disconnect with no auto-reconnect
│   └── Fix: Restart session or use /mcp reconnect
└── SSE timeout/crash (remote MCP)
    └── Fix: Use Streamable HTTP transport
```

### The OAuth Refresh Token Bug (Issue #21333)

This is the most impactful ongoing issue. The MCP Authorization spec explicitly states servers "SHOULD issue short-lived access tokens." Linear's OAuth endpoint advertises support for the `refresh_token` grant type:

```json
"grant_types_supported": ["authorization_code", "refresh_token"]
```

Claude Code correctly stores refresh tokens but never implements the refresh flow. When the 24-hour access token expires:

- Linear-specific: "basically unusable after 24h"
- Atlassian Rovo: "unusable after ~5 minutes" (60-90 min TTL)
- The `/mcp reconnect` command does NOT refresh expired tokens
- Manual `/mcp auth` or full re-authentication is required

**Impact**: Affects Linear, Sentry, Supabase, Atlassian Rovo, and any other OAuth MCP. Related to 20+ fragmented issues.

### The VS Code Extension Race Condition (Issue #25751)

The extension attempts MCP handshake during startup. If the MCP server process takes more time than the extension's timeout window to initialize, the connection is silently abandoned. No error is shown. CLI works fine because it manages the process lifecycle differently.

Observable pattern: "It works sometimes but not others" — success rate improves on warm subsequent reloads.

**Workaround**: `Ctrl+Shift+P` → "Developer: Reload Window" before each session. This is the most commonly recommended fix in the community.

### Linear-Specific VS Code Bug (Issue #9362)

A regression introduced around Oct 9, 2025 (version 2.0.14) specifically broke Linear MCP in the VS Code extension while leaving CLI functionality intact. Three users confirmed through December 2025. The issue was auto-closed after 60 days of inactivity and locked. No official root cause analysis or fix was provided by Anthropic.

Related duplicates identified by the bot:

- #8403: VSCode Extension: MCP Access Failure Despite Terminal Functionality
- #8460: MCP server authorization prompt doesn't appear in VSCode integrated mode
- #9133: Atlassian MCP Server Tools not available despite successful connection

### Mid-Session Disconnection (No Auto-Reconnect)

MCP servers can disconnect mid-session due to:

- Idle timeouts (child process exits after inactivity)
- Network interruptions
- Crashes on bad config or unhandled exceptions
- OS process management (memory pressure kills background processes)

Once disconnected, there is no recovery path that preserves session context. `/mcp` menu → Reconnect option exists but is unreliable. The direct `/mcp reconnect <server>` command reportedly never works; the interactive menu version sometimes requires two attempts.

### Official Workarounds Published

**From Linear docs** (`rm -rf ~/.mcp-auth` for "Internal Server Error"):

```bash
rm -rf ~/.mcp-auth
```

Then retry. Also: update to a newer Node.js version.

**From Claude Code troubleshooting docs** (for "Not logged in" / token expired):

```bash
/login
```

Check system clock accuracy (token validation depends on correct timestamps).

**For MCP auth specifically**:

```
/mcp auth
```

Triggers re-authentication flow without restarting the session.

## Known Workarounds (Ranked by Reliability)

### 1. Use API Key Auth Instead of OAuth (Most Reliable)

Bypasses the OAuth refresh token bug entirely. Linear API keys do not expire.

Generate a key at: Linear Settings > Account > Security & Access > Personal API Keys

```json
{
  "mcpServers": {
    "linear": {
      "url": "https://mcp.linear.app/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_LINEAR_API_KEY>"
      }
    }
  }
}
```

Or via Claude Code CLI:

```bash
claude mcp add --transport http linear-server https://mcp.linear.app/mcp \
  --header "Authorization: Bearer ${LINEAR_API_KEY}"
```

### 2. Reload VS Code Window Before Each Session

For the startup race condition issue:

- `Ctrl+Shift+P` → "Developer: Reload Window"
- Reliable fix, just requires a manual step each session

### 3. Clear MCP Auth Cache

For authentication corruption or "Internal Server Error" from Linear:

```bash
rm -rf ~/.mcp-auth
```

### 4. Use CLI Instead of VS Code Extension

The CLI does not exhibit the VS Code startup race condition. If Linear MCP works in the terminal but not in the IDE extension, migrate your workflow to the CLI.

### 5. Manual Re-Authentication on Expiry

```
/mcp auth
```

Triggers the OAuth re-authentication flow without restarting. Use when you get auth errors mid-session.

### 6. Update mcp-remote (If Using Bridge Mode)

If using the `mcp-remote` npm bridge for older setups, update to at least 0.1.16 to patch CVE-2025-6514:

```bash
npx -y mcp-remote@latest https://mcp.linear.app/mcp
```

## Official Documentation Status

**Linear docs** (`linear.app/docs/mcp`) — covers setup and two narrow troubleshooting cases (Internal Server Error → `rm ~/.mcp-auth`, WSL → SSE-only flag). No guidance on token expiry, disconnection, or the VS Code extension issue.

**Claude Code troubleshooting docs** — covers general OAuth token expiry (`/login` to refresh) and system clock accuracy. No MCP-specific disconnection guidance. Does not acknowledge the OAuth refresh token bug.

**Anthropic's official position** — Most of these issues were closed as NOT_PLANNED or DUPLICATE with no committed fix timeline. The OAuth refresh token issue (#5706, open since July 2025) is the highest-priority open item.

## Sources & Evidence

- [Bug: VS Code Extension: Failed Connection to Linear MCP Service #9362](https://github.com/anthropics/claude-code/issues/9362) — Linear-specific VS Code regression, Oct 2025, closed NOT_PLANNED
- [BUG: MCP OAuth refresh tokens stored but never used #21333](https://github.com/anthropics/claude-code/issues/21333) — Root cause of most auth expiry disconnects, closed as duplicate
- [MCP servers should auto-reconnect when disconnected #36308](https://github.com/anthropics/claude-code/issues/36308) — March 2026, closed as duplicate
- [BUG: MCP server connection fails silently on VS Code extension startup #25751](https://github.com/anthropics/claude-code/issues/25751) — Startup race condition, closed as duplicate of #24770
- [BUG: SSE MCP server disconnection crashes session #18557](https://github.com/anthropics/claude-code/issues/18557) — Session crash on TCP break, closed NOT_PLANNED
- [BUG: MCP Server Timeout Configuration Ignored #20335](https://github.com/anthropics/claude-code/issues/20335) — Timeout settings ignored, closed NOT_PLANNED (March 2026)
- [BUG: MCP servers fail to connect in Claude Code despite correct configuration #1611](https://github.com/anthropics/claude-code/issues/1611) — General connection failure, closed then reopened
- [MCP server – Linear Docs](https://linear.app/docs/mcp) — Official setup and limited troubleshooting
- [Troubleshooting – Claude Code Docs](https://code.claude.com/docs/en/troubleshooting) — Official Anthropic troubleshooting (minimal MCP coverage)
- [Remote MCP support in Claude Code](https://claude.com/blog/claude-code-remote-mcp) — Anthropic announcement of native remote MCP support
- [MCP Authentication in Claude Code 2026 Guide](https://www.truefoundry.com/blog/mcp-authentication-in-claude-code) — Community guide
- [CVE-2025-6514 mcp-remote command injection](https://www.truefoundry.com/blog/mcp-authentication-in-claude-code) — Security advisory for mcp-remote < 0.1.16

## Research Gaps & Limitations

- Issue #5706 (the original OAuth refresh token feature request, open since July 2025) was not directly fetched — it is the canonical tracking issue for the refresh token bug.
- The exact Claude Code version that introduced the VS Code/Linear regression (around v2.0.14, Oct 2025) was not confirmed.
- It is unclear whether the Linear VS Code regression was ever independently fixed or if it was absorbed by the broader startup race condition fix (if any).
- No community forums (Reddit, Discord) were searched — additional workarounds may exist there.

## Search Methodology

- Searches performed: 9
- Most productive terms: "linear MCP disconnected claude code github issue", "MCP OAuth refresh tokens stored never used", "MCP servers auto-reconnect claude code"
- Primary sources: github.com/anthropics/claude-code issues, linear.app/docs, code.claude.com/docs
