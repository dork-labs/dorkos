# Anthropic ToS Compliance Research

**Date**: 2026-02-15
**Status**: Active research — monitor for policy changes

---

## Background

In January 2026, Anthropic cracked down on third-party tools (OpenCode, Cline, Roo Code, aider) that routed requests through Claude Max subscription OAuth tokens. They deployed server-side blocks and temporarily suspended some accounts.

## What Violates the ToS

### Consumer ToS, Section 3

Prohibits accessing Anthropic services via "automated or non-human means" except through the official API.

### Economic rationale

- **Claude Max subscription**: ~$200/month for heavy usage
- **Equivalent API usage**: Often $1,000+/month at per-token rates

Third-party tools were letting users get API-tier programmatic access at subscription prices — a massive arbitrage Anthropic considers abuse.

### What Anthropic specifically prohibits

From the Claude Agent SDK documentation:

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK.

The SDK is designed for **API key authentication only** (pay-per-token via `ANTHROPIC_API_KEY`).

## Affected Tools

| Tool | What it did | Outcome |
|------|-------------|---------|
| OpenCode (formerly opencode-ai) | Used Claude Max subscription OAuth tokens | Blocked server-side |
| Cline | Routed through subscription auth | Blocked |
| Roo Code | Routed through subscription auth | Blocked |
| aider | Similar pattern | Affected |

Some users reported temporary account suspensions that were later reversed.

## Official Anthropic Statements

- **Thariq Shihipar** (Head of Product) confirmed on X that blocking was intentional
- **Catherine Wu** posted on GitHub issues clarifying Anthropic's position
- **Dario Amodei** (CEO) acknowledged the enforcement

## The Three Authentication Models

| Model | Auth method | Billing | Programmatic use allowed? |
|-------|-------------|---------|---------------------------|
| Claude API | `ANTHROPIC_API_KEY` | Pay-per-token | Yes — this is the intended use |
| Claude Code CLI (subscription) | OAuth / subscription token | $100-200/month flat | For direct CLI use only |
| Claude Agent SDK | `ANTHROPIC_API_KEY` | Pay-per-token | Yes — official SDK for building apps |

## The Claude Agent SDK

The official path for building applications on top of Claude Code capabilities.

- **Package**: `@anthropic-ai/claude-agent-sdk`
- **Auth**: API key only (`ANTHROPIC_API_KEY`, or Bedrock/Vertex/Azure credentials)
- **Purpose**: Provides the same capabilities as Claude Code in library form
- **Key constraint**: Must not offer `claude.ai` login or subscription rate limits in products

---

## DorkOS Compliance Analysis

### How DorkOS works

DorkOS uses the **official Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). The data flow:

```
User → React Client (HTTP/SSE)
  → Express Server (gateway)
    → AgentManager.sendMessage()
      → SDK.query() → spawns Claude Code CLI
        → Claude Code CLI → Anthropic API
```

Authentication is delegated to the locally installed Claude Code CLI via `pathToClaudeCodeExecutable`.

### Comparison with banned tools

| Aspect | DorkOS | Banned tools (OpenCode, etc.) |
|--------|--------|-------------------------------|
| SDK used | Official Agent SDK | Intercepted CLI OAuth tokens |
| Auth method | Delegates to local CLI | Used subscription OAuth |
| Distribution | Self-hosted, wraps own CLI | Distributed products |
| Who authenticates | User's own CLI installation | The third-party tool |

### Risk assessment: LOW but not zero

**Compliant factors:**
1. Uses the **official Agent SDK** (not reverse-engineered OAuth)
2. **Self-hosted** — wraps your own local CLI, not offering a product with "claude.ai login"
3. The SDK itself ships with `pathToClaudeCodeExecutable` support, suggesting this use case is contemplated by Anthropic

**Risk factors:**
1. If a user's CLI is authenticated via Claude Max subscription (not API key), DorkOS effectively wraps subscription-authenticated access — the same pattern Anthropic blocked elsewhere
2. Anthropic's enforcement has been broad and sometimes caught legitimate use cases

### Recommendations

1. **Recommended auth**: Users should authenticate with `ANTHROPIC_API_KEY` (API billing) rather than relying on subscription-authenticated CLI
2. **Documentation**: Add a note that API key auth is the recommended and fully compliant method
3. **Consider**: Adding a startup check or warning if no `ANTHROPIC_API_KEY` is set
4. **Monitor**: Anthropic's ToS and SDK documentation for policy changes

---

## Sources

- [Agent SDK Overview — Official Documentation](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Anthropic cracks down on unauthorized Claude usage — VentureBeat](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses)
- [Hacker News: Anthropic blocks third-party use of Claude Code subscriptions](https://news.ycombinator.com/item?id=46549823)
- [Anthropic's Walled Garden: The Claude Code Crackdown](https://paddo.dev/blog/anthropic-walled-garden-crackdown/)
- [SDK Quick Start requires API key but Claude Code uses subscription auth (Issue #5891)](https://github.com/anthropics/claude-code/issues/5891)
- [Using opencode with Anthropic OAuth violates ToS (Issue #6930)](https://github.com/anomalyco/opencode/issues/6930)
- [Anthropic Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms)
- [OpenCode Claude Access Limited — NxCode](https://www.nxcode.io/resources/news/opencode-blocked-anthropic-2026)
- [Anthropic Blocks Claude Max in OpenCode — ByteIota](https://byteiota.com/anthropic-blocks-claude-max-in-opencode-devs-cancel-200-month-plans/)
- [Building agents with the Claude Agent SDK — Anthropic Engineering](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
