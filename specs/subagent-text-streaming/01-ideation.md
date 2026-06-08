---
slug: subagent-text-streaming
number: 251
created: 2026-06-08
status: ideation
---

# Subagent Text Streaming via `forwardSubagentText`

**Slug:** subagent-text-streaming
**Author:** Claude Code
**Date:** 2026-06-08
**Branch:** feat/subagent-text-streaming

---

## 1) Intent & Assumptions

- **Task brief:** Adopt the SDK `forwardSubagentText` option (added in 0.2.119) to stream a subagent's text deltas to the DorkOS console, instead of only showing background-task progress summaries. Today we surface subagent work as `background_task_started` / `background_task_progress` / `background_task_done` events (`sdk-event-mapper.ts:68-117`) and discover subagents via `supportedAgents()` (`message-sender.ts:347-362`). This spec adds live subagent text so the operator can watch what a subagent is actually doing — directly serving Kai, who runs many agents and wants visibility, not just a spinner.

- **Assumptions:**
  - `forwardSubagentText: true` causes the SDK to emit subagent text deltas through the same query stream, tagged so we can attribute them to the originating background task / subagent session.
  - The existing background-task UI is the right home for the forwarded text (expand a task chip to reveal streamed text), rather than interleaving subagent text into the main assistant stream.
  - Forwarded deltas carry a correlation id (subagent session id or `tool_use_id`) we can map to an active `background_task_*`.

- **Out of scope:**
  - The SDK version bump itself (handled by `claude-agent-sdk-upgrade-0.3.168`).
  - Subagent _tool-call_ rendering inside the subagent stream (text only for v1).
  - Persisting forwarded subagent text beyond the live session view.

- **Dependencies:**
  - **Blocked by:** `claude-agent-sdk-upgrade-0.3.168` (#250) — `forwardSubagentText` only available ≥ 0.2.119; we adopt it as part of the 0.3.168 upgrade.

## 2) Pre-reading Log

### Related Artifacts

- `research/runtime-upgrades/claude-agent-sdk/0.2.112-to-0.3.168/changelog.md` — 0.2.119: "Added `forwardSubagentText` option to stream subagent text deltas to SDK consumers."
- `research/runtime-upgrades/claude-agent-sdk/0.2.112-to-0.3.168/impact-assessment.md` — "Recommended Feature Adoptions → forwardSubagentText (Medium)".
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — existing `background_task_*` mapping and `stream_event` text-delta handling.
- `apps/server/src/services/runtimes/claude-code/message-sender.ts` — `sdkOptions` construction and subagent discovery.

## 3) Scope

### Server

- Set `sdkOptions.forwardSubagentText = true` in `message-sender.ts`.
- Map the forwarded subagent text deltas in `sdk-event-mapper.ts` into a new `StreamEvent` (e.g. `subagent_text_delta`) carrying the correlation id + text. Reuse existing tool/background-task correlation state where possible.
- Extend the shared `StreamEvent` type (`@dorkos/shared/types`).

### Client

- Render streamed subagent text inside the corresponding background-task affordance (expandable). Follow the Calm Tech design language; responsive across surfaces.
- Handle ordering / interleaving with progress events; ensure the main assistant stream is unaffected.

### Tests

- Tier-1 SDK scenario for forwarded subagent text (`sdk-scenarios.ts`).
- Mapper test asserting `subagent_text_delta` emission + correlation.
- Client component test for the expandable subagent-text view.

## 4) Out of Scope

- Subagent tool-call/result rendering, persistence, and non-Claude-Code runtimes.

## 5) Risk Assessment

- **Overall risk: Low–Medium.** Additive option + new event type; the real work is UI correlation and avoiding visual noise in the main stream. No ADR implications (stays within `services/runtimes/claude-code/` for the server side; client follows FSD).
- **Rollback criteria:** if forwarded text can't be reliably correlated to a background task, gate the option behind a config flag or revert to summaries-only.

## Dependencies

- **Blocked by:** `claude-agent-sdk-upgrade-0.3.168` (must upgrade first).
