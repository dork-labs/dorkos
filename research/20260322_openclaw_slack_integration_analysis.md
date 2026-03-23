---
title: 'OpenClaw Slack Integration: Comprehensive Analysis'
date: 2026-03-22
type: external-best-practices
status: active
tags: [openclaw, slack, slack-bot, ai-agent, messaging, relay-adapter, security, rate-limiting]
searches_performed: 10
sources_count: 35
---

## Research Summary

OpenClaw is a massively popular open-source personal AI agent (330K+ GitHub stars) that supports 20+ messaging channels including Slack. Its Slack integration is one of the most feature-rich AI-agent-to-Slack bridges available, offering Socket Mode and HTTP Events API connectivity, granular DM/channel access policies, configurable mention gating, Block Kit interactive controls, native text streaming, and deep threading support. However, the integration suffers from significant security concerns (prompt injection, data leakage), UX friction (binary mention gating, no user lookup by name/email), operational fragility (gateway hangs on invalid bots), and the broader challenge of managing an autonomous agent with messaging authority. The community has filed numerous feature requests around thread-aware mention behavior, human-in-the-loop approval for outbound messages, OAuth cross-workspace support, and file/image upload capabilities. This report also covers the broader AI Slack bot landscape and best practices relevant to building a DorkOS Slack relay adapter.

---

## Key Findings

1. **OpenClaw is a general-purpose personal AI agent, not a Slack-specific tool**: Created by Peter Steinberger in November 2025 (originally "Clawdbot"/"MoltBot"), now stewarded by an open-source foundation. 330K GitHub stars, 21K+ commits, Node.js/TypeScript, runs locally via a Gateway architecture (WebSocket on `127.0.0.1:18789`). Supports 20+ messaging channels (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, Teams, Matrix, etc.).

2. **Slack integration is production-grade but complex**: Uses Slack's Bolt framework under the hood. Two connection modes (Socket Mode default, HTTP Events API alternative). Granular access control for DMs (pairing/allowlist/open/disabled) and channels (open/allowlist/disabled). Configurable mention gating, threading, streaming, and interactive Block Kit controls.

3. **Security is the dominant concern**: CVE-2026-25253 (CVSS 8.8) allowed remote code execution via prompt injection. Kaspersky, Cisco, Microsoft, and Giskard have all published security advisories. 42K+ publicly exposed instances found. The ClawHub skill marketplace had up to 20% malicious payloads. Any Slack user who can message the bot can potentially trigger tool calls.

4. **UX pain points are well-documented**: Binary mention gating (no thread-aware mode), no user lookup by name/email for DMs, no file/image upload support, CLI manifest has breaking characters, and the pairing flow for DMs adds friction.

5. **Operational fragility**: Gateway hangs indefinitely when a Slack bot is removed from workspace but still configured. Missing dedup on message edits can retrigger logic. Rate limiting is a systemic concern with autonomous agents.

6. **Human-in-the-loop is a solved problem in OpenClaw**: Issue #2023 was implemented, providing gateway-level tool call interception with approve/reject buttons sent to a configured channel before outbound messages execute.

---

## Detailed Analysis

### OpenClaw Slack Integration Architecture

OpenClaw's Slack channel runs through its Gateway process, which maintains a persistent connection to Slack via either:

- **Socket Mode** (default): WebSocket connection, requires an App Token (`xapp-...` with `connections:write`) and Bot Token (`xoxb-...`). No inbound HTTP endpoint needed. Up to 10 concurrent WebSocket connections.
- **HTTP Events API**: Webhook-based, requires Bot Token and Signing Secret. Each account needs a distinct `webhookPath` to avoid registration collisions.

Bot events subscribed: `app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`.

### DM and Channel Access Control

**DM Policies:**
| Mode | Behavior |
|------|----------|
| `pairing` (default) | Unknown senders must be approved via `openclaw pairing approve slack <code>` |
| `allowlist` | Only pre-approved user IDs can DM |
| `open` | Anyone can DM the bot |
| `disabled` | DMs turned off entirely |

Group DMs (MPIMs) are disabled by default.

**Channel Policies:**
| Mode | Behavior |
|------|----------|
| `open` | Bot responds in any channel it's invited to |
| `allowlist` | Only responds in specific channel IDs |
| `disabled` | Channel messages ignored |

Channel messages are **mention-gated by default** -- the bot only responds when explicitly `@mentioned`, matched by a regex pattern, or when someone replies in a thread the bot started.

### Threading and Session Management

Sessions are keyed by context:

- DMs: `agent:<agentId>:slack:dm:<userId>` (default `session.dmScope=main` collapses to main session)
- Channels: `agent:<agentId>:slack:channel:<channelId>`
- Threads: Append `:thread:<threadTs>` suffix

Reply modes: `off` (default) | `first` (reply to first message only) | `all` (reply to every message in thread).

**Key limitation**: The `requireMention` setting is binary -- either all messages need a mention or none do. Thread-aware mention gating (e.g., require mention in main channel but not in threads where bot has participated) is an open feature request (Issue #30270, PRs #48978 and #50874 in progress).

**Another limitation**: Implicit mention detection only checks if the bot authored the root message of a thread (`message.parent_user_id === botUserId`), missing cases where the bot participated mid-thread (Issue #24760, closed as stale).

### Mention Handling

Three mention sources:

1. Explicit app mention (`<@botId>`)
2. Configurable regex patterns
3. Implicit reply-to-bot thread behavior (limited to root-authored threads)

Per-channel controls include `requireMention`, user allowlists, and `allowBots` flags.

### Message Formatting and Delivery

- Text chunks default to 4000 characters max
- Paragraph-first splitting via `chunkMode="newline"`
- Media attachments capped at 20MB inbound (configurable via `mediaMaxMb`)
- **No file/image upload support** for outbound messages (Issue #18426)

### Text Streaming

Four streaming modes:
| Mode | Behavior |
|------|----------|
| `off` | No live preview |
| `partial` (default) | Replace preview with latest output chunk |
| `block` | Append chunked updates |
| `progress` | Show processing status |

Native Slack streaming uses `chat.startStream`/`appendStream`/`stopStream` APIs when enabled (requires "Agents and AI Apps" toggle in Slack settings).

### Interactive Controls (Block Kit)

Agents can emit Slack-specific directives that compile into Block Kit:

- `[[slack_buttons: Approve:approve, Reject:reject]]` -- button blocks
- `[[slack_select: Choose a target | Canary:canary...]]` -- select menus

Rendering adapts by option count: up to 5 options use buttons, 6-100 use static select, 100+ use external select. Values are opaque OpenClaw-generated tokens (not raw agent-authored values) for security.

**Disabled by default** -- must be explicitly enabled.

### Acknowledgment and Typing Indicators

- `ackReaction` sends an emoji reaction while processing
- Typing reactions are temporary emoji reactions removed after completion
- Both have configurable fallback resolution chains

### Slash Commands

Native command mode is **off by default** for Slack. Enable via `channels.slack.commands.native: true`.

### Operational Events

The system maps these Slack events into system events:

- Message edits, deletes, thread broadcasts
- Reaction add/remove
- Member changes, channel renames, pin actions

### Diagnostics

- `openclaw channels status --probe` -- connection diagnostics
- `openclaw logs --follow` -- live log tailing
- `openclaw doctor` -- general health check

---

## What People Like About OpenClaw's Slack Integration

1. **Comprehensive feature set**: Most complete open-source AI-to-Slack bridge available -- DMs, channels, threads, reactions, streaming, interactive controls
2. **Granular access control**: The pairing system and allowlists provide real security for DM access
3. **Self-hosted / local-first**: No cloud dependency, data stays on your machine
4. **Multi-channel unification**: Same agent accessible via Slack, Telegram, WhatsApp, Discord, etc.
5. **Block Kit integration**: Native Slack interactive components rather than plain text
6. **Streaming support**: Real-time response delivery using Slack's native streaming APIs
7. **Human-in-the-loop**: Gateway-level tool approval before outbound messages execute

---

## What People Dislike / Common Complaints

1. **Security nightmare**: Prompt injection, data leakage, malicious skills -- extensively documented by Kaspersky, Cisco, Microsoft, Giskard
2. **Binary mention gating**: No thread-aware behavior; must choose between "always require mention" and "never require mention"
3. **No user lookup by name/email**: Must know Slack user IDs to send DMs; users fall back to email
4. **No file/image upload**: Can receive media but cannot send files/images to Slack
5. **Gateway fragility**: Invalid/removed Slack bots cause infinite retry loops and total gateway hang
6. **Complex setup**: Multiple tokens, event subscriptions, scopes -- "most guides miss critical configuration steps"
7. **Message edit retrigger**: Editing a message can retrigger bot logic without proper dedup
8. **Thread context isolation**: Threads don't carry cross-channel context; must be summarized manually
9. **CLI manifest bugs**: JSON manifest output has breaking characters preventing copy-paste
10. **Issue volume overwhelm**: ~30 new issues/hour; maintainers close feature requests as "NOT_PLANNED" to focus on stability
11. **No OAuth cross-workspace support**: Each workspace requires manual app creation and token sharing (Issue #31340)

---

## Feature Requests and Improvement Ideas

1. **Thread-aware mention gating** (Issue #30270, PRs in progress): `requireMention: true` in main channel, `requireMentionInThreads: false` for active threads
2. **Implicit mention for participated threads** (Issue #24760, closed stale): Bot should recognize threads it has participated in (not just authored)
3. **User discovery by name/email** (Issue #3430, closed NOT_PLANNED): Look up Slack users by email or display name for DMs
4. **File/image upload** (Issue #18426): Outbound file and image support
5. **OAuth 2.0 flow** (Issue #31340): Cross-workspace installation without manual token sharing
6. **Channel member listing** (Issue #5974): Ability to list members of a channel
7. **Better error messages** for permission failures
8. **Human-in-the-loop for outbound messages** (Issue #2023, COMPLETED): Gateway-level approval before sending

---

## Broader AI Slack Bot Landscape (2025-2026)

### Top AI Slack Integrations

| Tool                         | Type             | Strength                                     |
| ---------------------------- | ---------------- | -------------------------------------------- |
| Slack AI (native)            | Built-in         | Summaries, search, thread recaps             |
| Slackbot (Jan 2026 relaunch) | Native agent     | Context-aware, powered by Anthropic's Claude |
| ClearFeed                    | Support helpdesk | Slack-native ticketing with AI agents        |
| ChatGPT App                  | General AI       | Full GPT-4 in Slack sidebar                  |
| Atlassian Rovo               | Cross-app search | Jira + Confluence + Slack unified            |
| Notion AI                    | Knowledge base   | Indexes Slack channels, answers from docs    |
| Salesforce Agentforce        | CRM agent        | Autonomous agents in Slack channels          |

### What Makes a Great AI Slack Bot

Based on cross-industry analysis:

1. **Thread-native**: Responds in threads, not main channel -- avoids noise
2. **Context-aware**: Understands full thread history, not just the triggering message
3. **Action-capable**: Can create tickets, update records, trigger workflows -- not just chat
4. **Human-in-the-loop**: Escalation paths and approval gates for sensitive actions
5. **Graceful degradation**: Never responds with "I don't know" as noise; stays silent or suggests alternatives
6. **Native Slack UX**: Uses Block Kit, streaming, reactions -- feels like Slack, not a foreign embed
7. **Transparent logging**: All AI actions visible to team; audit trail
8. **Stack integration**: Connects to existing tools (helpdesk, CRM, docs)

### Common Complaints About AI Slack Bots (Industry-Wide)

1. **"Walled garden" knowledge**: Can't access information outside its configured sources
2. **Noise**: Responding with "Sorry, I couldn't find an answer" trains users to ignore the bot
3. **No specialized controls**: General AI tools lack domain-specific features (e.g., "always escalate refund questions")
4. **Per-user pricing**: Scales expensively across large teams
5. **Setup complexity**: Varies wildly by tool
6. **Response quality depends on knowledge base quality**: Garbage in, garbage out
7. **Privacy concerns**: Slack's default opt-in for AI training data caused backlash
8. **Context-switching**: AI should work within Slack, not pull users out

### What Users Want from AI Agents in Slack (2026 Trends)

1. **Autonomous task execution**: Not just Q&A -- create tickets, send messages, update systems
2. **Thread-aware intelligence**: Understand conversation flow, not just individual messages
3. **Cross-tool orchestration**: Bridge Slack with other workspace tools
4. **Voice capabilities**: Coming to native Slackbot
5. **Approval workflows**: Human checkpoints before consequential actions
6. **Configurable personality/behavior per channel**: Different behavior in #engineering vs #support
7. **Real-time streaming responses**: No more waiting for complete generation

---

## Slack API Rate Limiting Best Practices

### Current Limits (as of 2026)

- **General**: 1 request/second recommended for any given API method
- **Burst limit**: Maximum concurrent requests allowed
- **Per-minute limit**: Maximum requests in a rolling window (varies by method and tier)
- **Critical change (May 2025)**: Non-Marketplace apps limited to 1 req/min for `conversations.history` and `conversations.replies`

### Rate Limiting Lessons (from real incidents)

From Daniel Doubrovkine's detailed postmortem on AI-generated code hitting Slack rate limits:

1. **Never use blocking `sleep()` for rate limit handling** -- compounds the problem
2. **Move bulk operations to scheduled cron jobs** with slow-drain patterns
3. **Put new features behind disabled-by-default flags**
4. **Understand global vs. per-method limits** -- `conversations.close` has a global 1 req/s limit affecting ALL API operations
5. **AI-generated code handles local correctness but misses distributed system constraints**

### Best Practices for AI Slack Bots

1. **Acknowledge within 3 seconds**: Slack retries if no response in 3s. Use `waitUntil` or immediate acknowledgment + async processing
2. **Use streaming for long responses**: `chat.startStream` / `appendStream` / `stopStream` for real-time delivery
3. **Thread all responses**: Avoid polluting main channels; always reply in threads
4. **Dedup message events**: Use `event_id` to ignore duplicate deliveries and edited message retriggers
5. **Implement exponential backoff**: Not just retry-after headers
6. **Batch operations**: Don't make sequential API calls when batch alternatives exist
7. **Monitor rate limit headers**: `X-Rate-Limit-Remaining`, `Retry-After`

---

## Security Considerations for AI Slack Bots

### OpenClaw-Specific Vulnerabilities

- **CVE-2026-25253 (CVSS 8.8)**: Remote code execution via prompt injection -- patched in v2026.2.25
- **ClawJacked**: Malicious websites could hijack local OpenClaw agents via WebSocket
- **Skill marketplace compromise**: 20% of ClawHub skills contained malicious payloads
- **Environment variable leakage**: API keys loaded in "private" DM sessions were accessible to any sender
- **42K+ publicly exposed instances**: Massive attack surface

### General AI Slack Bot Security Principles

1. **Principle of least privilege**: Bot should only have scopes it absolutely needs
2. **Content injection is architectural**: Any message the bot processes (Slack messages, documents, emails) can contain hidden instructions
3. **Delegated authority is the core risk**: Anyone who can message the bot can induce tool calls within the agent's policy
4. **Structural enforcement over behavioral rules**: Agent "rules" don't prevent misuse; gateway-level controls do
5. **Audit all outbound actions**: Log every tool call, every message sent
6. **Separate read and write authorities**: Read-only mode still risks data leakage

---

## Implications for DorkOS Slack Relay Adapter

Based on this analysis, key takeaways for building a DorkOS Slack adapter:

1. **Thread-aware mention gating from day one**: OpenClaw's biggest UX complaint; implement `requireMentionInThreads` as a separate config
2. **Human-in-the-loop at the relay level**: Gateway-level approval before outbound messages, not agent-level rules
3. **Graceful degradation on auth failures**: Fail fast on `account_inactive`/`invalid_auth`/`token_revoked` -- never retry loop
4. **Socket Mode as default**: No webhook infrastructure needed, works behind firewalls
5. **Use Slack's "Agents & AI Apps" framework**: Split view, app threads, streaming, suggested prompts -- native UX
6. **Rate limit architecture**: Async processing with immediate acknowledgment; never block on AI generation
7. **Message chunking with paragraph-aware splitting**: 4000-char chunks, split on newlines
8. **Block Kit for interactive controls**: Tool approval buttons, select menus for choices
9. **Dedup on `event_id`**: Ignore retries and edit-triggered events
10. **Security-first DM policy**: Pairing or allowlist by default, never open

---

## Sources & Evidence

- [OpenClaw Slack Documentation](https://docs.openclaw.ai/channels/slack)
- [OpenClaw GitHub Repository](https://github.com/openclaw/openclaw) -- 330K stars
- [Issue #24760: Thread mention gating](https://github.com/openclaw/openclaw/issues/24760)
- [Issue #30270: Thread-aware requireMention](https://github.com/openclaw/openclaw/issues/30270)
- [Issue #3430: Slack UX Improvements](https://github.com/openclaw/openclaw/issues/3430)
- [Issue #2023: Human-in-the-loop approval](https://github.com/openclaw/openclaw/issues/2023)
- [Issue #32366: Gateway hang on invalid bot](https://github.com/openclaw/openclaw/issues/32366)
- [Issue #18426: File/image upload](https://github.com/openclaw/openclaw/issues/18426)
- [Issue #31340: OAuth cross-workspace](https://github.com/openclaw/openclaw/issues/31340)
- [Issue #5974: Channel member listing](https://github.com/openclaw/openclaw/issues/5974)
- [Issue #21275: Auto-response missing_recipient_team_id](https://github.com/openclaw/openclaw/issues/21275)
- [Issue #32493: CLI manifest breaking characters](https://github.com/openclaw/openclaw/issues/32493)
- [HN: OpenClaw Slack Tutorial](https://news.ycombinator.com/item?id=46999956)
- [Kaspersky: OpenClaw Risks](https://www.kaspersky.com/blog/moltbot-enterprise-risk-management/55317/)
- [Cisco: Personal AI Agents Security Nightmare](https://blogs.cisco.com/ai/personal-ai-agents-like-openclaw-are-a-security-nightmare)
- [Microsoft: Running OpenClaw Safely](https://www.microsoft.com/en-us/security/blog/2026/02/19/running-openclaw-safely-identity-isolation-runtime-risk/)
- [Giskard: OpenClaw Security Vulnerabilities](https://www.giskard.ai/knowledge/openclaw-security-vulnerabilities-include-data-leakage-and-prompt-injection-risks)
- [The Hacker News: ClawJacked Flaw](https://thehackernews.com/2026/02/clawjacked-flaw-lets-malicious-sites.html)
- [AI Slop: Slack Rate Limiting Disaster](https://code.dblock.org/2026/03/12/ai-slop-a-slack-api-rate-limiting-disaster.html)
- [Slack Rate Limits Documentation](https://docs.slack.dev/apis/web-api/rate-limits/)
- [Slack Rate Limit Changes May 2025](https://api.slack.com/changelog/2025-05-terms-rate-limit-update-and-faq)
- [Slack AI Apps Overview](https://docs.slack.dev/ai/)
- [Slack Agents and AI Innovations](https://slack.com/blog/news/ai-innovations-in-slack)
- [Slackbot Context-Aware AI Agent](https://slack.com/blog/news/slackbot-context-aware-ai-agent-for-work)
- [ClearFeed: 10 Best Slack AI Integration Tools](https://clearfeed.ai/blogs/slack-ai-integration-tools)
- [LumaDock: OpenClaw Slack Integration Guide](https://lumadock.com/tutorials/openclaw-slack-integration)
- [Milvus: OpenClaw Setup Tutorial](https://milvus.io/blog/stepbystep-guide-to-setting-up-openclaw-previously-clawdbotmoltbot-with-slack.md)
- [Expanso: OpenClaw Slack Integration](https://expanso.io/expanso-hearts-openclaw/slack/)
- [Medium: OpenClaw for Data Engineering](https://medium.com/@reliabledataengineering/i-tried-clawdbot-for-data-engineering-and-heres-the-honest-truth-33ea980c954f)
- [Vercel AI SDK: Slackbot Agent Guide](https://ai-sdk.dev/cookbook/guides/slackbot)
- [Stack Junkie: OpenClaw Troubleshooting](https://www.stack-junkie.com/blog/openclaw-troubleshooting-universal)

---

## Research Gaps & Limitations

- The HN thread on OpenClaw Slack had minimal discussion (only 1 comment about hosting providers)
- Reddit discussions were not found with substantial Slack-specific feedback
- No detailed performance benchmarks for OpenClaw's Slack integration under load
- Limited information on how OpenClaw handles Slack Enterprise Grid deployments
- The Wonderchat comparison article failed to load content

## Contradictions & Disputes

- OpenClaw markets itself as "safe" with built-in security features, but multiple independent security firms (Kaspersky, Cisco, Microsoft, Giskard) classify it as a significant security risk
- The human-in-the-loop feature (Issue #2023) was implemented, but Issue #3430 (UX improvements) was closed as NOT_PLANNED -- inconsistent prioritization suggests maintainer bandwidth issues rather than design philosophy
- OpenClaw's pairing system is praised for DM security but criticized for adding friction to legitimate use cases

## Search Methodology

- Searches performed: 10
- Most productive search terms: "OpenClaw Slack integration", "OpenClaw Slack bot review complaints issues", "OpenClaw Slack security risks prompt injection"
- Primary information sources: OpenClaw docs, GitHub issues, security vendor blogs, Slack developer docs
- Existing research files consulted: `openclaw-scheduler-analysis.md`, `20260321_openclaw_ai_convention_markdown_files.md`, plus 7 existing Slack research files
