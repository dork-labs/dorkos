# Claude Agent SDK Upgrade: 0.3.177 → 0.3.224

## Problem Statement

We are running `@anthropic-ai/claude-agent-sdk` at 0.3.177. Version 0.3.224 is
available — 41 stable releases ahead, with 14 breaking changes (all verified
zero compile-level exposure for us), 3 deprecations (zero usage), and 46 new
features, 11 of which are high/medium relevance to DorkOS.

## Research

- Changelog: `research/runtime-upgrades/claude-agent-sdk/0.3.177-to-0.3.224/changelog.md`
- Impact assessment: `research/runtime-upgrades/claude-agent-sdk/0.3.177-to-0.3.224/impact-assessment.md`
- Triage decisions: `research/runtime-upgrades/claude-agent-sdk/0.3.177-to-0.3.224/triage-decisions.md`

## Scope

### Must Do

- Bump 0.3.177 → 0.3.224 in root `package.json` (pnpm override), `apps/desktop`, `apps/server`, `packages/cli` (exact pin, consistent everywhere)
- Verify `resolveClaudeCliPath` (`sdk-utils.ts`) against the new package — native-binary packaging is version-sensitive
- Re-verify the `mcp-revocation.ts` empirical anchor: it reasons about SDK internals as of 0.3.177 and its fixture-pinned test (`__tests__/fixtures/mcp-server-status-401.observed.json`) will pass even when stale; 0.3.221 changed the MCP connect timing it depends on. Re-observe against 0.3.224 and refresh the fixture + binary-symbol citations
- Confirm the two behavioral changes are acceptable: subagent nest depth 5→1 with a 20-concurrent cap (0.3.217; env escape `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`), and background agents forwarding permission prompts to `canUseTool` instead of auto-denying (0.3.186 — check `messaging/interactive-handlers.ts`)
- Run the claude-code runtime conformance suite: `pnpm vitest run apps/server/src/services/runtimes/claude-code`
- One live smoke turn

### Should Do

- Note in the PR that `sdk-event-mapper.ts`'s logging `default:` branch absorbs the 6 new `SDKMessage` members silently — decide per member whether to map or intentionally ignore

### Nice to Have (trivial in-bump adoptions)

- `ModelInfo.resolvedModel` — match persisted model id to alias row in `runtime-cache.ts`
- ~~`SDKAssistantMessage.aborted`~~ — moved to `specs/runtime-interrupt-receipts/` during
  execution (2026-08-07): an honest truncation mark needs a new StreamEvent, a client
  renderer, and a transcript-reader change (ADR-0310 JSONL re-read), which is over the
  in-bump bar — a mark that vanishes on reload would be a dishonest half-feature

## Out of Scope (separate specs, blocked by this one)

- `specs/runtime-interrupt-receipts/` — interrupt receipt + `cancel_queued`
- `specs/runtime-prompt-redelivery/` — `Query.reinitialize()`
- `specs/verified-message-origin/` — `SDKMessageOrigin.verifiedPeerPid`
- `specs/background-task-level-state/` — `background_tasks_changed`

## Risk Assessment

Low-Medium. Type surface is purely additive (`Options` 63→64 fields, nothing
removed, peer deps unchanged). The medium is entirely the two behavioral changes
no compiler catches plus the stale `mcp-revocation.ts` fixture. Rollback: revert
the version pin; no migration is one-way.
