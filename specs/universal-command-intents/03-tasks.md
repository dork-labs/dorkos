# Tasks — Universal Command Intents (compact / clear / context)

**Spec:** `specs/universal-command-intents/02-specification.md` · **Slug:**
`universal-command-intents` · **Tracker:** DOR-109 (project: Universal Command
Interface) · **Mode:** full · **Generated:** 2026-07-16

16 tasks across 4 phases. **Phase 1 is the compile gate:** `RuntimeCapabilities.commandIntents`
and `AgentRuntime.executeCommandIntent` are REQUIRED members, so adding them
breaks compilation everywhere until every producer/implementor is updated. Phase 1
lands the shared surface plus every implementor (with honest placeholders) so the
workspace always compiles. **Phase 2 (server) and Phase 3 (client) run fully in
parallel after Phase 1.** Phase 4 is cross-cutting verification only. Tests live in
the phase that verifies them (`__tests__/` alongside source), never bunched at the end.

## Dependency graph

```
Phase 1 (gate):  1.1 → 1.2 → 1.3 → 1.5
                  1.1 → 1.4                 (1.4 ∥ 1.2/1.3)
                  gate complete = {1.4, 1.5}

after gate:      2.1 ∥ 2.2 ∥ 2.3 ∥ 2.4  →  2.5←{2.1,2.2,2.3,2.4}     (Phase 2)
                                    ∥
                 3.1 → 3.2   and   3.3 → 3.4                          (Phase 3)

Phase 2 ∥ Phase 3.
Phase 4:         4.1 ← {2.5, 3.2, 3.4};   4.2 ← 3.4
```

Compact form: `1.1→1.2→1.3→1.5; 1.1→1.4; gate={1.4,1.5}; then (2.1∥2.2∥2.3∥2.4)→2.5 ∥ (3.1→3.2, 3.3→3.4); 4.1←{2.5,3.2,3.4}; 4.2←3.4`.

**Mutually independent (parallelizable):** within Phase 1, `1.4 ∥ {1.2,1.3}`. Within
Phase 2, `2.1 ∥ 2.2 ∥ 2.3 ∥ 2.4` (the four adapter/route tasks). Within Phase 3, the
two chains `3.1→3.2` and `3.3→3.4` are independent of each other. **All of Phase 2 ∥
all of Phase 3.** No task reaches `xl`, so none is promoted to its own sub-issue
(threshold `xl`).

---

## Phase 1 — Shared foundation (compile gate)

### Task 1.1: Shared command-intent registry + resolver + subpath export + tests

New `packages/shared/src/command-intents.ts` (pure): `CommandIntentId`,
`CommandIntentFulfillment`, `RuntimeCommandIntentId`, `CommandIntentDescriptor`,
`COMMAND_INTENTS` (the three intents + their cross-agent aliases),
`resolveCommandIntent`, `commandIntentTokens`. Add the `./command-intents` subpath to
`packages/shared/package.json` and re-export from the types barrel. Unit tests cover
every canonical + alias (case-insensitive, with/without `/`), unknown/near-miss →
null, and per-descriptor `fulfillment`.

- size: sm · priority: high · deps: none · cites spec §Detailed Design 1

### Task 1.2: `RuntimeCapabilities.commandIntents` (required) across every producer — atomic

Add `CommandIntentSupport` + required `commandIntents` to `RuntimeCapabilities`
(sibling of `permissionModes`, ADR-0256). **Same task** adds the field to all four
caps constants (placeholder `{ compact: { supported: false } }`) and to
`FakeAgentRuntime.getCapabilities` (`{ compact: { supported: true } }`) so the
workspace never sits red. No paired Zod schema exists (verified 2026-07-16) → no
OpenAPI edit.

- size: sm · priority: high · deps: 1.1 · cites spec §Detailed Design 2

### Task 1.3: `AgentRuntime.executeCommandIntent` (required) + all five implementations — atomic

Add the required `executeCommandIntent(sessionId, intent, opts?)` async generator to
`AgentRuntime`. `FakeAgentRuntime` gets its FINAL synthetic-`compact_boundary` body;
the four production runtimes get compile-safe throwing placeholders (consistent with
`supported:false` from 1.2 — nothing calls them until the Phase 2 route). Phase 2
fills the real claude/opencode/test-mode bodies; codex's throw becomes its final form.

- size: md · priority: high · deps: 1.2 (same files) · parallelWith: 1.4 · cites spec §Detailed Design 3

### Task 1.4: `Transport.runCommandIntent` + HttpTransport + DirectTransport

Add `runCommandIntent(sessionId, intent)` to `Transport`. `HttpTransport` POSTs
`/api/sessions/:id/command-intents/:intent` (route lands Phase 2; 404 until then is
fine — unit tests mock the transport). `DirectTransport` gets a throwing placeholder
wired for real in 2.4 (modeled on `embedded-turn-trigger.ts`).

- size: sm · priority: high · deps: 1.1 · parallelWith: 1.3 · cites spec §Detailed Design 4

### Task 1.5: Extend the runtime conformance suite for command intents

`runtime-conformance.ts` asserts `commandIntents` shape (every
`RuntimeCommandIntentId` → `{ supported: boolean }`), and behaviorally: supported →
`executeCommandIntent` yields a boundary/terminal event; unsupported → throws. Green
in Phase 1 (production runtimes unsupported+throwing, Fake supported+real); the SAME
suite re-verifies the production runtimes once Phase 2 flips them — no Phase 2 edit.

- size: sm · priority: high · deps: 1.2, 1.5 needs 1.3 · cites spec §Testing (conformance)

---

## Phase 2 — Server fulfillment (∥ Phase 3, after the gate)

### Task 2.1: claude-code `executeCommandIntent('compact')` real body + enable cap

Send bare `/compact` through the existing SDK send path (reuses DOR-107
bare-passthrough + `getKnownCommands`), yield the turn's events; flip
`CLAUDE_CODE_CAPABILITIES.commandIntents.compact` to `{ supported: true }`.
`trigger-turn.ts` and the DOR-107 guard stay untouched.

- size: md · priority: high · deps: 1.4, 1.5 · parallelWith: 2.2, 2.3, 2.4, 3.1, 3.3 · cites spec §Detailed Design 3

### Task 2.2: opencode `executeCommandIntent('compact')` via `session.summarize` + enable cap

Resolve the `ses_*` id, call `client.session.summarize({ path: { id } })` (SDK
confined); the boundary arrives out-of-band via the shipped `event-mapper.ts:239`
(`session.compacted` → `compact_boundary`), so the generator yields nothing/an ack.
Flip `OPENCODE_CAPABILITIES` to supported.

- size: md · priority: high · deps: 1.4, 1.5 · parallelWith: 2.1, 2.3, 2.4, 3.1, 3.3 · cites spec §Detailed Design 3

### Task 2.3: Finalize codex (honest-disabled throw) + test-mode (synthetic boundary)

codex: final typed unsupported throw, cap stays `{ supported: false }` (no Codex-SDK
compaction API). test-mode: real synthetic `compact_boundary` body, cap flips to
`{ supported: true }` (backs e2e).

- size: sm · priority: high · deps: 1.4, 1.5 · parallelWith: 2.1, 2.2, 2.4, 3.1, 3.3 · cites spec §Detailed Design 3, §2 matrix

### Task 2.4: `POST /command-intents/:intent` route + `triggerCommandIntent` projector + OpenAPI + DirectTransport

Thin route: Zod-validate `:intent` (unknown → 422), resolve runtime via
`runtimeRegistry`, gate on `commandIntents[intent].supported` (unsupported →
409/422, adapter not called), else drive `executeCommandIntent` through the durable
projector + session lock and return 202. Add a thin `triggerCommandIntent` sibling of
`triggerTurn`; register in the route table + OpenAPI registry. Wire the real
`DirectTransport.runCommandIntent` (in-process) here.

- size: md · priority: high · deps: 1.4, 1.5 · parallelWith: 2.1, 2.2, 2.3 · cites spec §Detailed Design 3+4, ADR-0264

### Task 2.5: Server route tests

`routes/__tests__/command-intents.test.ts`: supported → 202 + events reach the
projector (`collectDurableEvents`); unsupported → honest error, adapter not called;
unknown `:intent` → 422.

- size: md · priority: high · deps: 2.1, 2.2, 2.3, 2.4 · cites spec §Testing (Server — route)

---

## Phase 3 — Client (∥ Phase 2, after the gate)

### Task 3.1: Inline palette — intent entries + dedupe by token AND alias + alias-hint reuse

Extend the `ChatPanel.tsx` `allCommands` merge to project `COMMAND_INTENTS` into
`CommandEntry` rows ahead of native + runtime commands, deduping the native runtime
command by canonical token OR any alias (`commandIntentTokens()`). Aliases on each row
light up the shipped ranker + "matched /{alias}" hint. Tests: dedupe by token and by
alias; hint on alias match.

- size: md · priority: high · deps: 1.4, 1.5 · parallelWith: 3.3, 2.1, 2.2, 2.3, 2.4 · cites spec §Detailed Design 5a, VC2

### Task 3.2: Honest capability gating (disabled "Not supported by {runtime}")

Read caps via `useCapabilitiesForRuntime`; a runtime-fulfilled intent with
`supported === false` renders disabled + reason; client-native intents always enabled.
`CommandPalette.tsx` gains a disabled-row style + non-selectable keyboard state. Tests:
disabled row for unsupported runtime, keyboard nav skips it.

- size: md · priority: high · deps: 3.1 · cites spec §Detailed Design 5b, VC3

### Task 3.3: `clear` + `context` native executors + `NativeCommandContext` capabilities

Add both to the ADR-0300 native-command seam. `clear` → `startFreshSession` (new
session in the same cwd + navigate; **DECOMPOSE decision:** `continuedFrom` rides the
existing session store only if it accepts metadata — no SQLite column, per spec).
`context` → `focusUsageSurface` (reveal/pin the DOR-100 `UsageStatusItem` detail;
honest "No usage data for this session yet." empty state). Extend
`NativeCommandContext` with both capabilities, injected by `use-native-commands.ts`.
Tests: each executor runs its capability, sends no message, returns `handled+ran`.

- size: lg · priority: high · deps: 1.4, 1.5 · parallelWith: 3.1, 2.1, 2.2, 2.3, 2.4 · cites spec §Detailed Design 5c, Decision 2
- _Split seam if too large: `clear` and `context` divide cleanly along their two executors._

### Task 3.4: `compact` recognition + `runCommandIntent` dispatch + honest unsupported toast

In `executeSubmission` + `handleQueue` (the existing native-command interception
funnel), recognize a runtime-fulfilled intent via `resolveCommandIntent`. Supported →
`transport.runCommandIntent`, clear composer, no POST. Unsupported → toast "Compact
isn't supported by {runtime}" and keep the composer text (never send-as-text). Tests
with mocked caps + transport.

- size: md · priority: high · deps: 3.3 · cites spec §Detailed Design 5d, VC1

---

## Phase 4 — Verification (cross-cutting)

### Task 4.1: E2E — palette dedupe + honest gating across runtimes

Playwright (`apps/e2e`, test-mode-backed): one `/compact` row + alias hint on a
supported session; disabled "Not supported by Codex" + skipped by keyboard on a codex
session.

- size: md · priority: medium · deps: 2.5, 3.2, 3.4 · cites spec §Testing (E2E), VC2+VC3

### Task 4.2: Docs microcopy pass + #133 doc reconciliation

Optional short slash-command reference in `docs/` (writing-for-humans); confirm all
shipped microcopy reads plainly; reconcile stale
`specs/sdk-command-discovery/04-implementation.md` (#133) → superseded/implemented.

- size: sm · priority: low · deps: 3.4 · cites spec §Documentation

---

## Verification (VERIFY stage)

Per-task `Verify:` commands are targeted (`pnpm --filter <pkg> typecheck`,
`pnpm vitest run <path>`). Whole-feature close-out: `pnpm verify` (affected typecheck

- lint + test), the three validation criteria (VC1 compaction on claude + opencode;
  VC2 one deduped row per intent with alias hints; VC3 `commandIntents` gates per runtime
  with `FakeAgentRuntime`), and the invariant that `trigger-turn.ts` + the DOR-107 guard
  (`message-sender.ts:343-377`) are unchanged.
