---
slug: codex-session-reliability
created: 2026-09-08
status: specified
---

# Reliable Codex sessions

**Status:** Approved for autonomous implementation by the operator
**Date:** 2026-09-08

## Overview

Restore Codex conversations with a compatible executable, runtime-owned model discovery, useful recovery messages and securely authenticated DorkOS tools. Parent: DOR-1925 - Restore reliable Codex sessions, model choices, and actionable recovery.

## Background / Problem Statement

The reported session failed three greetings with no assistant response. Its actual SDK executable was 0.147.0. Astra required a newer version; GPT-5.4 and GPT-5.2 were rejected for the ChatGPT login. A read-only probe found 0.147.0 cannot parse the current model cache (`missing field supports_parallel_tool_calls`), while stable 0.153.4 lists Astra as the account's default. The UI rendered metadata/model-switch warnings as failures and exposed raw JSON for actual failures. App login also caused registered agents to lose all DorkOS tools without an explicit global MCP key.

## Goals

- Start and resume a real Codex agent from the browser with the available default model.
- Populate model choices from the executable and account context used for execution.
- Explain model/version failures in plain language with a useful recovery path and raw details available.
- Keep nonterminal warnings distinct from failed turns, including history replay.
- Preserve a newly created agent’s runtime through its first session and wait for ownership checks before spending the one-shot greeting.
- Restore agent-scoped tools with app login enabled while preserving all public authentication and private-data boundaries.
- Show current context use from Codex-owned measurements and preserve it through durable replay; keep collapsed structured results visibly expandable.

## Non-Goals

No migration from the SDK to app-server turn execution. No automatic model substitution, account changes, billing changes or forced binary override. No weakening public `/mcp`, `/a2a`, room membership or owner-only access. No changes to the operator's active servers during implementation.

## Technical Dependencies

Upgrade `@openai/codex` and `@openai/codex-sdk` together to 0.153.4 in server, CLI, desktop platform packages and provisioner. Use the installed app-server's newline-delimited JSON protocol only for discovery. Preserve SDK confinement. Node 24.14.1 matches the worktrees' installed SQLite native module.

## Detailed Design

### Executable and model discovery

Preserve config > bundled > provisioned > PATH resolution. Query the same resolved executable and Codex home used by the runtime with `app-server`: initialize with `clientInfo`, send `initialized`, then `model/list` with `limit:100, includeHidden:false`. Handle pagination. Map IDs, display names, defaults, known reasoning levels and supported input modalities to the shared model option contract. Do not fabricate support for unknown effort values.

Bound process duration and output, coalesce concurrent requests, terminate only the subprocess started by the request and clean listeners/timers on every outcome. Cache briefly by executable and identity context, invalidating on authentication changes. Retain no raw credential content. Empty/unavailable discovery must not reintroduce stale hardcoded models or claim another account's availability. Existing explicitly chosen session models survive discovery failures and are not silently replaced.

### Context measurements

Enrich confirmed model rows only with fresh, same-version Codex-owned effective window metadata. Optional metadata must never block model choices. For completed turns, read only the exact native thread’s bounded rollout tail and use the latest current-turn `token_count.info.last_token_usage.total_tokens` with `model_context_window`. SDK input usage accumulates across requests and is never a current-context measurement. Missing, stale, malformed, oversized or slow native metadata leaves context unknown or preserves the last valid reading; SDK output/cache counters remain available. Persist the measured pair through the existing status event and prove it survives replay. DorkOS keeps its existing tokens/window percentage calculation; it does not claim to reproduce Codex TUI’s additional display-baseline adjustment.

### Error and diagnostic presentation

Recognize the exact reported nested 400 model-version and account/model rejection envelopes. Produce short actionable copy; preserve vendor text under Details. Model rejection is not an authentication failure and should not start sign-in recovery. Recognize narrow, known nonfatal metadata/model-switch/transport warnings as status messages. Unknown errors remain errors. A terminal failure after an identical nonterminal diagnostic still ends the turn and remains visible. Apply equivalent classification on persisted-history replay without rewriting the user's stored transcript.

Prefer existing model/settings controls to new UI. Permanent incompatibility must not offer a misleading blind retry as its sole recovery. Recovery copy must describe controls that actually exist: the current Runtimes tab does not expose a custom executable picker. Preserve keyboard access, dark/mobile layout and existing authentication actions.

### First session after agent creation

The creation dialog must carry the chosen runtime into its navigation search parameters. The first-turn greeting must wait until ownership checks allow submission; a guarded no-op must not spend the greeting latch and leave the agent indefinitely “waking up”. Preserve the existing bounded retry and no-double-greeting guarantees.

### Agent tools with login enabled

Reuse the existing private loopback runtime listener and short-lived, boot-bound, turn-bound principal, which binds runtime, session, agent and working directory. Add a distinct scoped DorkOS tool projection rather than accepting agent attribution tokens as human credentials on public endpoints. Expose only tools the principal may call; reuse capability and room-membership gates. Derive identity server-side. Revoke the principal with its turn and reject forged, revoked, mismatched and forbidden calls.

Keep the public MCP/A2A authentication policy unchanged. Keep feature disable and unregistered-directory behavior explicit. Avoid duplicate injection and duplicated credentials. Codex and OpenCode share the appropriate turn scope; Claude's established in-process path remains valid.

## User Experience

The user opens a Codex session, sees choices available to their current Codex login, sends a message and receives an answer. A resumed session keeps its history. On an unavailable model, the app explains that model choice needs attention and offers the existing model control; an outdated executable message explains that the Codex DorkOS is using needs an update and offers an available model as an interim choice. Ordinary warnings stay visually quiet. Technical diagnostic detail remains available on demand.

## Testing Strategy

Use focused mapper/schema/history/client tests for recovery. Use controlled subprocess fixtures for discovery bounds, pagination, malformed JSON, exit failures, cache coalescing and identity changes; prove targeted regressions red before green. Use real HTTP integration tests for private tool discovery/calls and authentication denials. Run package typecheck/lint plus affected verification. Run browser smoke coverage of touched controls, visually inspect screenshots, and send short bounded real-agent turns in a disposable worktree data directory. Never point destructive e2e setup at production data. The real Codex browser test must also verify a populated context meter before and after reload. Independent reviewer reads actual diff, intent and REVIEW.md and re-reviews justified fixes before PR creation.

## Performance Considerations

Model discovery is coalesced and cached, never an unbounded subprocess per render. No persistent discovery daemon. Keep unrelated runtime listing responsive. Private tool routing reuses an existing listener and principal lifecycle.

## Security Considerations

Never log credentials, use shell interpolation for untrusted process arguments, or accept a turn token as a user credential. Keep owner-only data out of agent projection. Validate authority on calls, including after revocation. Tests must exercise actual HTTP middleware and tool execution, not only mocks. Live tests must not send messages to external people or spend through an API-key billing path.

## Documentation

Record version/discovery contract, limitations, regression evidence, live browser proof and reviewer outcome in `04-implementation.md`; write one curated changelog fragment for the combined delivery. Add a focused ADR only where the private tool projection changes an architectural decision; do not duplicate existing runtime/principal ADRs.

## Implementation Phases

1. Compatible executable + model discovery (DOR-1926).
2. Clear failures and calm diagnostics (DOR-1927), parallel to phase 1.
3. Private agent tool access (DOR-1928), separate worktree.
4. Integrate, verify, run browser/real-agent proof, adversarial review, PR and cleanup.

## Open Questions

None blocking. Implementation-discovered decisions are recorded with evidence; scope stays within this repair.

## Related ADRs

ADR-0316 runtime binary resolution, ADR-0317 runtime provisioning, ADR-0320 local MCP authentication, ADR-0310 runtime-owned sessions; existing connector runtime principal design constrains private tool authority.

## References

- `01-ideation.md` for exact production evidence.
- Official app-server discovery contract: https://learn.chatgpt.com/docs/app-server
- Codex 0.153.4 current-context semantics: https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/tui/src/token_usage.rs
- `REVIEW.md`, `contributing/adding-a-runtime.md`, `apps/e2e/README.md`.
