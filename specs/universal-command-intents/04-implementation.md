# Implementation Summary: Universal command intents (compact / clear / context)

**Created:** 2026-07-16
**Last Updated:** 2026-07-16
**Spec:** specs/universal-command-intents/02-specification.md
**Tracker:** DOR-109

## Progress

**Status:** Implemented
**Tasks Completed:** 16 / 16 (Phases 1–4)

## Session

- **Worktree:** `/Users/doriancollier/.dork/workspaces/dorkos/feat-dor-109-universal-command-intents` (branch `feat/dor-109-universal-command-intents`)
- **Orchestration:** phase-batched, one commit per task (`(DOR-109 task N.M)` + Co-Authored-By trailer). Executed against `origin/main`.

## Phases Completed

### Phase 1 — Shared foundation (compile gate)

- 1.1 — `packages/shared/src/command-intents.ts`: the pure alias→intent registry (`COMMAND_INTENTS`, `resolveCommandIntent`, `commandIntentTokens`), `./command-intents` subpath export, types barrel re-export, unit tests.
- 1.2 — required `RuntimeCapabilities.commandIntents` + `CommandIntentSupport` across all four caps constants + `FakeAgentRuntime` (compile-safety atomic).
- 1.3 — `AgentRuntime.executeCommandIntent` on the interface + all five runtimes (`FakeAgentRuntime` yields a synthetic `compact_boundary`; production runtimes carry compile-safe placeholders).
- 1.4 — `Transport.runCommandIntent` + `HttpTransport` (POST) + `DirectTransport` placeholder.
- 1.5 — runtime conformance suite extended for the command-intent surface (supported → boundary; unsupported → throws).

### Phase 2 — Server fulfillment

- 2.1 — claude-code `executeCommandIntent('compact')` via bare `/compact`; caps flipped supported.
- 2.2 — opencode `executeCommandIntent('compact')` via `client.session.summarize`; caps flipped supported.
- 2.3 — codex final honest-disabled throw (caps stay `false`); test-mode synthetic boundary (caps flipped supported).
- 2.4 — `POST /api/sessions/:id/command-intents/:intent` route + `triggerCommandIntent` projector wiring + OpenAPI registration + `DirectTransport` wiring.
- 2.5 — route tests: supported → 202 + events on the durable stream; unsupported → honest error, adapter not called; unknown intent → 422.

### Phase 3 — Client

- 3.1 — inline palette intent rows via `buildPaletteCommands`; dedupe by canonical token AND alias; alias-hint reuse.
- 3.2 — honest disabled "Not supported by {runtime}" palette row; keyboard nav skips it.
- 3.3 — `clear` + `context` native executors (`startFreshSession`, `focusUsageSurface` via `useUsageReveal` + `UsageRevealPopover`); honest empty state.
- 3.4 — `compact` recognition in the shared send funnel → `transport.runCommandIntent`; honest unsupported toast that keeps the composer text.

### Phase 4 — Verification

- 4.1 — Playwright e2e (chromium-mock, test-mode runtime): palette dedupe (one row per intent), alias-hint match, enabled compact gating. **3 passed.**
- 4.2 — docs microcopy pass (`docs/guides/slash-commands.mdx` universal-intents section), #133 (`sdk-command-discovery`) 04-doc reconciliation, changelog consolidation, this summary.

## Deviations

- **e2e home:** task 4.1 shipped as a describe block appended to `apps/e2e/tests/chat-mock.spec.ts` rather than a new spec file. The `chromium-mock` Playwright project only matches `**/chat-mock.spec.ts`, and the config explicitly warns a second mock-spec file races the shared `POST /api/test/reset`. Adding to `chat-mock.spec.ts` is the correct, documented home for a test-mode-backed suite.
- **e2e disabled-row (codex) gap:** the "Not supported by {runtime}" disabled row is **not reachable** in the test-mode e2e environment — the test-mode server registers only `test-mode` + `test-mode-b` (both declare compact supported), codex is not a registered runtime there, and `buildPaletteCommands` renders an undefined caps map as enabled. That gate branch (VC3 negative) is covered by the Phase 3 unit tests (`features/chat/model/__tests__/build-palette-commands.test.ts` + the `features/commands` CommandPalette gating tests), which mock caps to `supported: false`. The e2e asserts the positive gate (compact enabled on test-mode).
- **Changelog:** DOR-109 is represented by a single consolidated, user-facing fragment (`changelog/unreleased/260717-003414-command-intent-registry-resolver-dor-109.md`). The four auto-generated Phase 3 task-title stubs were stripped as housekeeping.

## Verification

- e2e: `pnpm --filter @dorkos/e2e exec playwright test --project=chromium-mock --grep "Command Intents"` → 3 passed (25.9s).
- Types: `@dorkos/client` + `@dorkos/server` typecheck green; `@dorkos/e2e` typecheck green.
- Full changed-test run at Phase 4 close (see task 4.2 verification).
