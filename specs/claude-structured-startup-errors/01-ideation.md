---
slug: claude-structured-startup-errors
id: 260922-223209
created: 2026-09-22
status: ideation
---

# Explain Claude Code startup and API failures in plain words

**Author:** Claude Code (from the 0.3.268 → 0.3.280 SDK upgrade triage)
**Research:** [`research/runtime-upgrades/claude-agent-sdk/0.3.268-to-0.3.280/impact-assessment.md`](../../research/runtime-upgrades/claude-agent-sdk/0.3.268-to-0.3.280/impact-assessment.md) (MEDIUM: `startup_failure_reason`), [`triage-decisions.md`](../../research/runtime-upgrades/claude-agent-sdk/0.3.268-to-0.3.280/triage-decisions.md)
**Blocked by:** the claude-agent-sdk 0.3.280 bump (field needs SDK 0.3.274+)

## Problem

When the Claude Code runtime refuses to start a run, DorkOS shows generic error text. SDK 0.3.274 adds `startup_failure_reason` (`SDKStartupFailureReason`, 16 values such as `cwd_unavailable`, `shell_tool_missing`, `cli_version_too_old`, `bypass_root`, `session_held_by_background`) on the zeroed `error_during_execution` result written before exit. Several have a fix a person can act on ("the folder this agent works in was moved or deleted"). `bypass_root` matters directly: DorkOS always launches with the bypass capability (ADR-0261), which a root-run server or container can trip.

The carried-forward `api_error_status` (SDK 0.3.218/0.3.223, ADR-0143) is still unadopted after three bumps and belongs to the same error-mapping surface (`sdk/sdk-error-mapping.ts`).

## Suggested approach

- Add a startup-failure branch to the result mapping keyed on `startup_failure_reason`, with one plain sentence per reason (writing-for-humans) and a generic fallback for unknown values (the set is open).
- Decide whether to set `CLAUDE_CODE_STARTUP_FAILURE_RESULTS` so the reasons that need it are emitted at all.
- Read `api_error_status` beside it so rate-limit, overload and auth failures get their own category instead of text matching.
- Tests per reason family; one live check with a deleted cwd.

## Open questions

- Which reasons deserve a one-click action (pick a new folder, update the CLI) versus a sentence only.
