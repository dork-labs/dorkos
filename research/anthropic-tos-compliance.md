---
title: 'Anthropic ToS Compliance Research'
date: 2026-02-15
type: strategic
status: active
tags: [anthropic, tos, compliance, oauth, api-usage, policy]
---

# Anthropic ToS Compliance Research

**Date**: 2026-02-15
**Status**: Re-verified 2026-06-25 (DOR-158) — verdict below. Active; monitor for policy changes.

---

## 2026-06-25 Re-verification (DOR-158) — Verdict: PROCEED with the compliant scope (LOW risk)

Re-verified for the `connect-claude-code-account` project (spec #260, Linear DOR-157 / gate DOR-158). The primary-source **policy text was fetched live and confirmed verbatim on 2026-06-25**; the enforcement _timeline_ below is from secondary reporting (medium confidence). **This update supersedes the 2026-02-15 analysis where they differ.**

### Verified primary-source policy (live, 2026-06-25)

Anthropic has codified the Jan-2026 enforcement into written policy. From **[Legal and compliance — Claude Code Docs](https://code.claude.com/docs/en/legal-and-compliance)** → "Authentication and credential use" (confirmed verbatim):

> - **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.
> - **Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. **Anthropic does not permit third-party developers to offer Claude.ai login or to route requests through Free, Pro, or Max plan credentials on behalf of their users.**
>
> Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice.

Also confirmed: _"Advertised usage limits for Pro and Max plans assume **ordinary, individual usage** of Claude Code and the Agent SDK."_ And the Agent SDK overview Note (verbatim, unchanged from the Feb baseline): _"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Please use the API key authentication methods described in this document instead."_

### Enforcement timeline since 2026-02-15 (secondary sources — medium confidence)

- **2026-02-19/20** — Jan enforcement codified into the legal page above (The Register).
- **2026-04-04** — Second, broader block extended to all third-party agents using subscription credentials (~135k OpenClaw instances cut off); one-time credit offered.
- **2026-05-14** — Anthropic announced third-party agents would be re-permitted to use subscription credentials from 2026-06-15 under a new metered-credit model.
- **2026-06-15** — Anthropic **paused** that billing change ("Pricing for the Claude Agent SDK isn't changing for the time being … we'll share advance notice before any future change"). Current state: subscription credentials work via the SDK as before; **the written prohibition above is unchanged**.

**Takeaway:** the policy _text_ — not the fluctuating billing/enforcement — governs compliance. It still prohibits exactly two behaviors: (1) offering claude.ai login, and (2) routing requests through Pro/Max credentials on behalf of users.

### Per-question verdicts (DOR-158)

| #   | Question                                                                                                    | Verdict              | Basis                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Read host `~/.claude/.credentials.json` / Keychain **read-only** for status + delegate to host `claude`     | **LOW — proceed**    | Policy is silent on local same-user reads; it prohibits _routing requests through_ creds, not _reading the file to show status_. Delegating to the official binary (it authenticates itself via `pathToClaudeCodeExecutable`) is "ordinary use of Claude Code," not third-party routing.                        |
| 2   | `setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` injected into the SDK env                                         | **MEDIUM — exclude** | Extracting the subscription token to drive the SDK _is_ "route requests through Pro/Max credentials" in product code. Untargeted by enforcement for true single-operator use, but the text doesn't carve it out. **Excluded by design** (IDEATE Decision #6: no `subscription` authType; host creds read-only). |
| 3   | Overall posture: read-only detect + delegate **(a)** + API key **(b)** + gateway **(c)**; no OAuth re-drive | **LOW — proceed**    | (b) API key and (c) gateway/Bedrock/Vertex are the explicitly intended methods; (a) is the compliant delegation pattern. Avoids every behavior the crackdowns targeted.                                                                                                                                         |

### Hard lines (never cross)

1. **Extract** the subscription token from `.credentials.json`/Keychain and pass it to the SDK/API (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN`) — the exact blocked pattern.
2. **Re-drive a claude.ai browser-OAuth** flow from within DorkOS.
3. **Multiplex / distribute** one subscription across many users (a hosted multi-tenant DorkOS) — where "ordinary, individual usage" / "on behalf of their users" turns leg (a) non-compliant.
4. **Advertise** "claude.ai login" or "Max rate limits" as a DorkOS feature.

### Decision

**PROCEED with the compliant scope** (read-only host-login detection + delegation, API key, gateway). Keep **API key as the recommended/default** connect method (the explicitly-intended path). The design's exclusion of a `subscription` authType (Decision #6) keeps the MEDIUM/HIGH paths out by construction. **Residual constraint:** the self-hosted, single-operator framing is what keeps leg (a) defensible — re-open this gate if DorkOS moves toward a hosted multi-tenant model that routes multiple users' subscription access.

_Not legal advice — facts surfaced for the owner's risk call. Final go/no-go: Dorian._

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

| Tool                            | What it did                               | Outcome             |
| ------------------------------- | ----------------------------------------- | ------------------- |
| OpenCode (formerly opencode-ai) | Used Claude Max subscription OAuth tokens | Blocked server-side |
| Cline                           | Routed through subscription auth          | Blocked             |
| Roo Code                        | Routed through subscription auth          | Blocked             |
| aider                           | Similar pattern                           | Affected            |

Some users reported temporary account suspensions that were later reversed.

## Official Anthropic Statements

- **Thariq Shihipar** (Head of Product) confirmed on X that blocking was intentional
- **Catherine Wu** posted on GitHub issues clarifying Anthropic's position
- **Dario Amodei** (CEO) acknowledged the enforcement

## The Three Authentication Models

| Model                          | Auth method                | Billing             | Programmatic use allowed?            |
| ------------------------------ | -------------------------- | ------------------- | ------------------------------------ |
| Claude API                     | `ANTHROPIC_API_KEY`        | Pay-per-token       | Yes — this is the intended use       |
| Claude Code CLI (subscription) | OAuth / subscription token | $100-200/month flat | For direct CLI use only              |
| Claude Agent SDK               | `ANTHROPIC_API_KEY`        | Pay-per-token       | Yes — official SDK for building apps |

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

| Aspect            | DorkOS                      | Banned tools (OpenCode, etc.) |
| ----------------- | --------------------------- | ----------------------------- |
| SDK used          | Official Agent SDK          | Intercepted CLI OAuth tokens  |
| Auth method       | Delegates to local CLI      | Used subscription OAuth       |
| Distribution      | Self-hosted, wraps own CLI  | Distributed products          |
| Who authenticates | User's own CLI installation | The third-party tool          |

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
