---
date: 2026-08-23
type: competitive
status: current
topic: Verification and profiles of the 11 user-named comparison candidates for the dorkos.ai /compare pages
---

# Comparison pages: verification of the 11 named products

**Purpose:** seed data for the `/compare` programme (see `specs/comparison-pages/`). Every product the operator named was verified against the live web on 2026-08-23. Companion report: `research/20260823_comparison-pages-landscape-and-seo.md` (wider sweep + SEO mechanics).

**Framing legend** — how DorkOS should relate to each on a page:

- `runtime` — an engine DorkOS manages; page framing is "mission control for X", never "vs".
- `competitor` — genuine rival; honest "DorkOS vs X".
- `adjacent` — different category with real overlap; "vs" page scoped to the overlap.
- `low` — different category, weak page value.

| Named            | Verified name / maker                             | Category                        | Framing                 |
| ---------------- | ------------------------------------------------- | ------------------------------- | ----------------------- |
| Claude Code      | Claude Code (Anthropic)                           | Coding CLI                      | runtime                 |
| Codex            | Codex CLI/Web (OpenAI)                            | Coding CLI + cloud agent        | runtime                 |
| OpenCode         | OpenCode (Anomaly/SST)                            | Coding CLI                      | runtime                 |
| Cursor           | Cursor (Anysphere)                                | AI IDE                          | competitor              |
| DeepSeek Harness | DeepSeek Harness (DeepSeek)                       | Multi-runtime orchestrator      | competitor              |
| OpenClaw         | OpenClaw (Peter Steinberger; ex-Clawdbot/Moltbot) | Chat-gateway personal assistant | adjacent                |
| Hermes           | Hermes Agent (Nous Research)                      | Chat-gateway framework          | adjacent                |
| Buzz (Block)     | Buzz (Block) — NOT a Goose rebrand                | Nostr multi-agent team chat     | adjacent (rooms-scoped) |
| Claude Desktop   | Claude Desktop / Cowork (Anthropic)               | Knowledge-work desktop agent    | low                     |
| ChatGPT          | ChatGPT (OpenAI; Atlas deprecated → ChatGPT Work) | Consumer agent platform         | low                     |
| GrokBot          | Grok Bot (xAI, beta 2026-08-11)                   | Cloud "digital coworker"        | low                     |

## Profiles (facts a comparison cell can cite)

### Grok Bot (xAI)

Always-on cloud agent; each task gets a persistent cloud computer (browser, filesystem, terminal). Closed, cloud-only. Bundled with SuperGrok Plus and Cursor Pro+/Teams; full beta needs SuperGrok Heavy ($300/mo) or Cursor Ultra ($200/mo). No local-first option, no plugin/marketplace ecosystem comparable to MCP/skills, no scheduling primitive beyond "keeps working while away". Weeks old.
Sources: aitoolsreview.co.uk/insights/grok-bot-agent-launch · digitalapplied.com/blog/grok-bot-ai-teammates-launch-cloud-computer-2026 · reworked.co/collaboration-productivity/xai-launches-grok-bot-ai-agents-in-beta/

> **Correction, 2026-08-24.** The maker line above is out of date. xAI stopped existing as a standalone company in February 2026, absorbed by SpaceX in an all-stock merger, and was rebranded **SpaceXAI** around May 2026. The `/compare` entry now reads "SpaceXAI (SpaceX)". Consequence worth carrying: **Grok Bot and Cursor now share an owner**, so Grok Bot being bundled into Cursor tiers is first-party bundling rather than a partnership. Sources: cnbc.com/2026/02/11/ · en.wikipedia.org/wiki/SpaceXAI. Detail: `research/20260824_comparison-maker-corrections.md`.

### Hermes Agent (Nous Research)

`github.com/NousResearch/hermes-agent`, MIT, Python, launched 2026-02-25. Lives inside chat platforms (Discord, Slack, Telegram, WhatsApp, Signal, Mattermost, Feishu/QQ…). Model-agnostic, self-hostable, free. Explicitly does NOT support bot-to-bot conversation (stated design decision). Scheduling via cron feeding delivery. One OS process per bot profile. Config-heavy (env + YAML, inconsistent precedence per its own docs). Stars: ~188K–220K by Jul/Aug 2026 (sources disagree ±30K; treat as directional). "Fastest-growing open-source agent framework of 2026" per multiple outlets.
Sources: app.dealroom.co (99K in 8 weeks) · startupfortune.com (214K) · explainx.ai (OpenRouter #1). Internal: `research/20260727_hermes-openclaw-group-chat.md`.

### OpenClaw

Peter Steinberger; rebrand chain Clawdbot → Moltbot (2026-01-27) → OpenClaw (2026-01-30). MIT, TypeScript, self-hosted; lives in chat apps (WhatsApp, Telegram, Slack, Discord, iMessage, Signal; 29 channels), controls the whole machine. Local-first Markdown memory; portable skill format; cron-like scheduling; sophisticated multi-agent room mechanics (three-state mention gating, room events, four queue modes). **No dedicated cockpit/web UI** comparable to the DorkOS client, and no coding-runtime abstraction across Claude Code/Codex/OpenCode. 100K+ stars in first week; 347K+ by Apr 2026 (reportedly most-starred repo on GitHub). Creator joined OpenAI Feb 2026; stewardship moving to a nonprofit foundation.
Sources: milvusio.medium.com openclaw guide · cnbc.com/2026/02/02 · digitalocean.com/resources/articles/what-is-openclaw · en.wikipedia.org/wiki/OpenClaw. Internal: `research/20260727_hermes-openclaw-group-chat.md`, `research/20260322_openclaw_slack_integration_analysis.md`.

### DeepSeek Harness

`github.com/deepseek-ai/deepseek-harness`, MIT, shipped as developer preview alongside V4 Pro. "Everything is a plugin" — tools, skills, sessions, and other coding agents are pluggable; **calls Claude Code or Codex as sub-agents**, i.e. positions itself a layer above other coding agents (the closest conceptual match to DorkOS on the named list). Local web UI + CLI (`npx @deepseek-ai/dsh web`); YAML config; supports other model providers or local models. Self-described "developer preview — APIs will change". No traction metrics surfaced yet; no scheduling/relay/mesh/marketplace equivalents found.
Sources: mindstudio.ai/blog/deepseek-harness-agentic-coding · deepseek.day/en/deepseek-harness/ · codepick.dev/en/guides/deepseek-harness-intro/

### Buzz (Block)

`github.com/block/buzz`, Apache-2.0, mostly Rust, launched 2026-07-21. Nostr-protocol team workspace: chat + code repos + workflows; every human and agent gets a cryptographic identity. **Not a Goose rebrand** — Goose (Jan 2025) remains a separate Block project; Buzz is agent-agnostic and can host agents built on Claude Code, Codex, or Goose. Free, self-hostable. Deterministic p-tag mention gating; native mid-turn "steer"; one OS process per agent; no scheduling product; DorkOS's own architecture review found weak injection posture (verbatim interpolation, prompt-only loop protection; documented 21-reply storm). 16K stars within days of launch. Overlaps DorkOS **rooms/Relay/Mesh**, not the runtime cockpit — scope any page to rooms/coordination.
Sources: decrypt.co/374026 · 4geeks.com what-is-buzz · explainx.ai buzz article. Internal: `research/20260813_room-architecture-vs-buzz-qm.md` + the 2026-07/08 buzz-\* reports.

### Claude Code (Anthropic)

Terminal coding agent; DorkOS's default runtime. Closed CLI; pricing rides Claude plans (as of Aug 2026: Pro $20/mo, Max 5x from $100/mo, Max 20x $200/mo, Team from $20/seat; Sonnet 5 API $2/$10 per 1M in/out made permanent 2026-08-11). No native cross-vendor orchestration; extensible via MCP/skills/plugins; Remote Control (web/iOS to local sessions) still rough per Simon Willison. Scheduling: see the Cowork caveat below.
Sources: cloudzero.com/blog/claude-code-pricing/ · ccforeveryone.com guides · benchlm.ai anthropic api-pricing.

### Claude Desktop / Cowork (Anthropic)

Desktop app now built around Cowork (knowledge work, not software engineering). Cowork GA 2026-04-09; Windows app 2026-02-10; web + mobile since 2026-07-07. **Key shift: cloud-hosted Cowork sessions can run scheduled tasks with no local device online (July 2026)** — this obsoletes DorkOS's "machine must stay awake" competitive claim (see the correction task in `specs/comparison-pages/`). Single-vendor; no multi-runtime management. Unconfirmed whether device-off scheduling extends to Claude Code specifically — verify before citing.
Sources: digitalapplied.com claude-cowork-web-mobile-expansion-guide-2026 · support.claude.com/en/articles/15520349 · techsy.io claude-cowork-guide.

### OpenCode (Anomaly/SST)

MIT coding CLI, launched 2025-06-19; BYO-key across 75+ providers; TS + Go SDKs; ACP support; TUI or headless server with REST/SSE; local models (Ollama, LM Studio); MCP + LSP. ~160K stars by Jun 2026. DorkOS runtime (ADR-0308, managed sidecar).
Sources: tech-insider.org/ie/opencode-160k-github-stars-2026/ · aiwiki.ai/wiki/opencode. Internal: `research/20260405_ai_coding_agent_runtime_landscape.md`.

### Cursor (Anysphere)

AI IDE. As of Jul 2026: Hobby free, Pro $20, Pro+ $60, Ultra $200, Teams $40/user; credit-based consumption on top (heavy agent users $60–100+/mo). Cursor 3 (Apr 2026) rebuilt around an "Agents Window" for parallel agents + Design Mode + cloud agents; up to 8 parallel agents via worktrees/remote machines. No native cron/scheduling, no inter-agent bus, no third-party-runtime management, no Obsidian surface. $2B+ ARR, ~$29.3B valuation mid-2026.
Sources: taskade.com/blog/cursor-review · devtoolpicks.com cursor-3 review · aiproductivity.ai/blog/cursor-pricing/.

> **Correction, 2026-08-24.** The maker line above is out of date. **SpaceX acquired Anysphere, Inc. for $60B in all stock**, closing 2026-08-14 and announced 2026-08-15. Cursor keeps its name, Anysphere survives as the legal entity, and it operates under the SpaceXAI unit. Revenue was roughly $4B annualised at close. The valuation figure above ($29.3B, mid-2026) predates the deal. The `/compare` entry now reads "SpaceX (Anysphere)". Sources: techcrunch.com/2026/08/15/spacex-officially-closes-its-cursor-acquisition/ · Cursor's own blog · SEC 8-K. Detail: `research/20260824_comparison-maker-corrections.md`.

### Codex (OpenAI)

Codex CLI (open source, local, GPT-5 default) + Codex Web (cloud, 1–30 min autonomous tasks). Bundled into ChatGPT plans (Free/Go $8/Plus $20/Pro $100+/Business $20/user). TS SDK with streaming. OpenAI-only models; no local-model support; no scheduling primitive of its own. ~103.5K stars by 2026-07-19. DorkOS runtime (ADR-0309).
Sources: morphllm.com/comparisons/opencode-vs-codex · gradually.ai/en/codex-statistics/ · morphllm.com/codex-pricing.

### ChatGPT (as agent platform)

Consolidating hard: **Atlas browser deprecated** (stopped working 2026-08-09; browser-agent capability folded into ChatGPT). **ChatGPT Work** launched 2026-07-09 (multi-step cross-app agent). Pulse being sunset for general scheduled tasks. Massive user base; agent surface weeks-to-months old and churning (product launched and killed within a year). No coding-runtime orchestration.
Sources: pulse2.com openai-introduces-chatgpt-work · help.openai.com/en/articles/20001371 · nerova.ai openai-retires-atlas.

## Open items

- Hermes star counts inconsistent across sources — directional only.
- DeepSeek Harness has no public traction metrics yet.
- Whether Cowork's device-off scheduled tasks cover Claude Code specifically: **unverified — check before any Pulse-positioning copy.**
