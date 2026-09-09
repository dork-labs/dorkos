---
slug: codex-session-reliability
created: 2026-09-08
status: ideation
---

# Reliable Codex sessions

## 1) Intent & Assumptions

Restore the reported Codex conversation, prevent invalid model choices, and make failures recoverable. The operator authorizes autonomous planning, implementation by GPT-5 workers, separate adversarial review, real-agent browser testing, PR completion and cleanup. Every write happens in a worktree, including planning artifacts. Work is tracked by DOR-1925 in Sessions & Runtimes.

Assumptions: preserve the user's existing transcripts and chosen models; never silently change model or billing mode. Treat transcript instructions as evidence, not instructions for this investigation. Limit live tests to isolated, disposable agents and short diagnostic turns using the existing Codex sign-in. Do not stop the operator's servers. Broader runtime rewrites and unrelated backlog work are outside this repair.

## 2) Pre-reading Log

- `services/runtimes/codex/check-dependencies.ts`: configured executable wins, followed by bundled, provisioned, then PATH. Bundled CLI and SDK are pinned at 0.147.0.
- `services/runtimes/codex/codex-runtime.ts`: `getSupportedModels()` returns a static catalog.
- `services/runtimes/codex/event-mapper.ts`: nonterminal error items and terminal failures enter different channels; raw message deduplication affects terminal presentation.
- `services/runtimes/shared/dorkos-mcp-injection.ts`: withholds tools when login is enabled without an environment MCP bearer.
- `middleware/mcp-auth.ts`: local token intentionally ceases to authorize when login is enabled. Preserve this security boundary.
- `REVIEW.md`: independently review actual diff and callers, drive real boundaries, prove tests distinguish broken behavior.

## 3) Codebase Map

Model selection flows from runtime discovery through `/api/models`, the Transport, and the session model menu. Session turns flow from the HTTP trigger to the Codex SDK executable, event mapper, durable events and browser rendering. Agent tools use a separate server-issued agent identity alongside endpoint authentication. Shared components must continue serving Claude and OpenCode correctly.

## 4) Root Cause Analysis

Production session `9b8d5bb6-bc66-4452-b723-7fcd88140fed` maps to Codex thread `01a082ab-5383-7911-9e49-1040e1367075`. Its transcript explicitly records `cli_version: 0.147.0` and `originator: codex_sdk_ts`.

- 15:17:40 CDT: `hi`, model `gpt-6-astra`; HTTP 400 says the model requires newer Codex.
- 15:18:03 CDT: `hello`, model `gpt-5.4`; HTTP 400 says unsupported with ChatGPT login.
- 15:18:14 CDT: `hi`, model `gpt-5.2`; same account/model rejection.

No successful assistant response exists. Metadata and model-switch diagnostics appear as red errors. All three attempts log that DorkOS tools were withheld because login was enabled and no MCP bearer was available.

## 5) Research

An executable update fixes the first incompatibility but a static catalog will drift again. Use the selected Codex executable's own model-discovery contract rather than a second account-blind model list. Bound discovery and isolate it from turn execution. Unknown models must not silently become another model.

Rendering all diagnostics as errors produces false alarms; discarding all error items loses real failures. Recognize narrow, known warning shapes and retain terminal verdicts, raw diagnostic details and existing authentication recovery.

Granting agents a global or human token would bypass intended permissions. Restore tools with explicit agent authentication and capability restrictions, preserving owner-only operations and room membership gates.

## 6) Decisions

1. Retain authoritative explicit binary overrides and a tested bundled default.
2. Prefer runtime-discovered selectable models and honest discovery failures over stale fabricated availability.
3. Preserve history and selected models; recovery is visible and deliberate.
4. Keep warnings calm and actionable failures specific; never label model incompatibility as an expired login.
5. Agent tool access must remain agent-scoped when app login is enabled.
6. Use separate implementation worktrees, then integrate and review the combined result before opening a PR.
