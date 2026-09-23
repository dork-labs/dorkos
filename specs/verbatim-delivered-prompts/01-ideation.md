---
slug: verbatim-delivered-prompts
id: 260922-223210
created: 2026-09-22
status: ideation
---

# Deliver room, relay and scheduled text verbatim to Claude Code

**Author:** Claude Code (from the 0.3.268 → 0.3.280 SDK upgrade triage)
**Research:** [`research/runtime-upgrades/claude-agent-sdk/0.3.268-to-0.3.280/impact-assessment.md`](../../research/runtime-upgrades/claude-agent-sdk/0.3.268-to-0.3.280/impact-assessment.md) (MEDIUM: `verbatimPrompts` / `client_composed`)
**Blocked by:** the claude-agent-sdk 0.3.280 bump (`SDKUserMessage.client_composed`, needs Claude Code 2.1.248+)

## Problem

DorkOS hands the CLI text no person typed into that session: relay deliveries, room turns, scheduled-task prompts, agent-to-agent messages. The CLI runs `@path` expansion and slash-command dispatch on all of it, so a room message containing `/something` or `@~/.ssh/config` is interpreted, not delivered. That is both a correctness problem and a security one.

## Suggested approach

- Set per-message `client_composed: true` on deliveries DorkOS composed, never the global `Options.verbatimPrompts` (the operator's own typed prompts need both features).
- Weigh the real cost first: on current CLIs `client_composed` also skips the turn-start attachment pass (nested `CLAUDE.md`, rules files, skill and tool listings), which then arrives only after the first tool call. That changes agent behavior on exactly the turns rooms care about. Measure it with an eval before deciding per delivery kind.
- Tests: a room message with `/cmd` and `@path` reaches the model as literal text.

## Open questions

- Which delivery kinds get the flag (all runtime-origin text, or rooms and relay only)?
- Does the attachment-pass cost justify a per-kind split?
