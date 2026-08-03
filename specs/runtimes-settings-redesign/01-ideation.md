---
slug: runtimes-settings-redesign
id: 260803-181550
created: 2026-08-03
status: ideation
tracker: DOR-888
design-session: .dork/visual-companion/9035-1785779428
---

# Runtimes settings redesign — per-runtime cards, default as a state, runtime-declared settings

**Slug:** runtimes-settings-redesign
**Author:** orchestrator + operator (Dorian)
**Date:** 2026-08-03

---

## 1) Intent & Assumptions

- **Task brief:** Restructure Settings → Runtimes around two operator-stated
  principles: (1) every setting that belongs to a runtime lives on that
  runtime's card — including the default-runtime choice, which becomes a state
  of a card (accent pill + "Make default"), not a dropdown; (2) runtime
  settings options are declared by the runtime through the shared interface,
  not hardcoded per-runtime in the client. Full approved design:
  [04-design-decisions.md](04-design-decisions.md) (operator signed off on the
  composite, including mobile behavior).
- **Assumptions:**
  - The approved design is fixed; SPECIFY resolves _how_, not _whether_.
  - Config file shape (`runtimes.claudeCode` / `codex` / `opencode` sections)
    stays as-is — this is a UI + declaration-layer redesign, not a config
    migration. No conf migration expected.
  - Existing semantics survive unchanged: trust-stop meaning, autonomy consent
    (ack + stop in one request), account resolution, connect flows, exceptions
    strip behavior.
  - Playground parity is a hard requirement (design decision §7): new
    components are props-first with showcases for every state.
- **Out of scope:**
  - New runtime backends; changes to session-time model/effort pickers
    (status-bar popover) beyond consuming the same data.
  - Config schema migrations or renames of `runtimes.*` leaves.
  - The Agent Hub Config tab (per-agent overrides) — only the settings tab
    changes; the exceptions strip keeps linking there.
  - The P5 flow-engine / tracker work; marketplace surfaces.

## 2) Pre-reading Log

- `specs/runtimes-settings-redesign/04-design-decisions.md` — the approved
  design; §2 defines the card skeleton + declared sections, §7 the playground
  requirement.
- `apps/client/src/layers/features/settings/ui/tabs/RuntimesTab.tsx` — current
  five-component stack; the TSDoc records _why_ accounts are a sibling card
  (entities can't reach config hooks — D7 of spec `claude-code-accounts`).
- `apps/client/src/layers/entities/runtime/ui/RuntimeSetupDialog.tsx` —
  `RuntimeSetupPanel`/`RuntimeSection` are props-first and playground-friendly;
  the ready-reconnect ("Fix sign-in"/"Change") and provision flows live here
  and must survive intact inside the new card.
- `apps/client/src/layers/features/settings/ui/execution-defaults/ExecutionDefaultsCard.tsx`
  — the capability hole: model/effort rows exist only for the currently-default
  runtime; also holds the autonomy-consent write pattern (ack + stop in ONE
  `PATCH /api/config`).
- `apps/client/src/layers/features/settings/ui/ClaudeAccountsCard.tsx` — the
  whole accounts feature to be relocated into the Claude card; add-account
  validation (absolute path, duplicates) and remove-releases-active rule.
- `apps/server/src/services/session/resolve-session-defaults.ts:149-153` —
  server `CONFIG_SECTION_BY_RUNTIME`, the authority the client map mirrors;
  `describeExecutionDefaults()` (:317-348) builds the `executionDefaults`
  projection returned by `GET /api/config`.
- `apps/client/src/layers/entities/config/lib/runtime-config-section.ts` — the
  client's hand-duplicated copy of that map (doc comment admits it).
- `packages/shared/src/constants.ts:65-88` — `runtimeSupportsEffort()` /
  `RUNTIMES_WITHOUT_EFFORT = ['opencode']`, hardcoded outside capabilities.
- `packages/shared/src/agent-runtime.ts:413-491` — `RuntimeCapabilities`:
  structured `permissionModes` precedent, `features` bag (ADR-0256, declared
  by two adapters, consumed by zero client code).
- `packages/test-utils/src/runtime-conformance.ts:665-777` — capability
  conformance assertions every runtime must pass; new declarations need
  assertions here + a row in `contributing/adding-a-runtime.md`.
- `decisions/0256-runtime-capabilities-shape-booleans-plus-structured-plus-features.md`
  — booleans flat, materially-different structures structured, `features` only
  for what doesn't merit first-class shape (with a curation warning).

## 3) Codebase Map

- **Client (FSD):**
  - `entities/runtime` — descriptors (icon/label/accent), capabilities hook
    (`['capabilities']`, `staleTime: Infinity`), requirements/readiness hook
    (refetched), `RuntimeSetupPanel`/`RuntimeSection` (props-first),
    provision hook.
  - `features/settings` — `RuntimesTab`, `ExecutionDefaultsCard` (+
    `DefaultTrustStopSection`), `ExecutionExceptionsStrip`,
    `ClaudeAccountsCard`.
  - `features/runtime-connect` — `renderRuntimeConnect` slot renderer keyed by
    runtime-declared connect kind (`login` / `provider-picker`) — the pattern
    to extend for settings sections.
  - `features/status/model/use-make-default-stop.ts` — second consumer of
    `configSectionForRuntime`; must move to the new declaration too.
  - `entities/config` — `useConfig`/`useUpdateConfig` (untyped PATCH),
    autonomy acknowledgement hook.
- **Server:**
  - `routes/capabilities.ts` → `runtimeRegistry.getAllCapabilities()` —
    static per-adapter constants from each `services/runtimes/*/runtime-constants.ts`.
  - `routes/config.ts` → `describeExecutionDefaults()` +
    `describeClaudeCodeAccounts()` (claude-config-dir.ts:235-251).
  - `routes/models.ts` → per-runtime `getSupportedModels()` (claude: SDK-fed
    cache, per-model `supportsEffort`; codex: static list, all `true`;
    opencode: live provider catalog, no effort).
  - `routes/system.ts` → `RuntimeReadiness` incl. `provider` (opencode) — the
    _refetchable_ surface, unlike capabilities.
  - `services/runtimes/connect/credentials.ts` — provider persistence.
- **Data flow:** config file (`conf`) → `GET /api/config`
  (`executionDefaults` + `claudeCode` projections) → TanStack Query
  `['config']` → settings UI → `PATCH /api/config` (`runtimes.*` patches) →
  invalidate `['config']` prefix. Capabilities: adapter constants →
  `GET /api/capabilities` → `['capabilities']` cached forever. Models:
  `GET /api/models?runtime=…` per card.
- **Potential blast radius:** settings tab (recomposed), status-bar
  make-default-stop hook, runtime conformance suite (+ every runtime's
  constants), `contributing/adding-a-runtime.md`, playground pages/sections,
  e2e selectors touching `default-runtime-select` / accounts testids,
  `specs/execution-defaults` + `claude-code-accounts` docs (superseded UI
  claims), shared constants (`runtimeSupportsEffort` callers).

## 4) Root Cause Analysis

Omitted — not a bug fix. (The one defect-shaped finding: per-runtime
model/effort defaults are uneditable for non-default runtimes purely because
the UI renders only the chosen runtime's rows; `executionDefaults.perRuntime[]`
already carries all runtimes.)

## 5) Research

- **Potential solutions for the declaration mechanism (principle 2):**
  1. **First-class structured capability field** (like `permissionModes`):
     `RuntimeCapabilities.settings` declaring `configSection` and the ordered
     settings sections (`kind: 'accounts' | 'power-source' | …`) the client
     renders via feature-injected renderers keyed on `kind`.
     - Pros: typed, conformance-testable, collapses the duplicated
       config-section maps, matches ADR-0256's bar ("materially different per
       runtime → structured"); the `renderConnect` pattern already proves the
       slot approach.
     - Cons: interface change touches all four adapters + conformance suite.
  2. **`features` bag entries** (`features.settingsSections`).
     - Pros: no interface change.
     - Cons: untyped, every consumer must validate, and ADR-0256 explicitly
       warns against absorbing first-class concerns; settings sections are a
       first-class concern.
  3. **Server-side composition only** (a new `/api/runtime-settings`
     endpoint).
     - Pros: no capability change.
     - Cons: invents a parallel channel for what is naturally a capability;
       still needs client renderers; more surface.
- **Dynamic-vs-static split (the report's key flag):** capabilities are static
  and cached forever (`staleTime: Infinity`); _which sections exist_ is static
  per runtime and belongs there. _Section state_ (account list, current
  provider, readiness) is dynamic and already rides refetched surfaces
  (`config`, `requirements`) — the declaration must carry no dynamic state.
- **Effort support:** fold `runtimeSupportsEffort()` into the declaration
  (runtime-level static fact) while per-model `supportsEffort` stays on
  `ModelOption` (model-level dynamic fact) — the two-level rule the current
  `ExecutionDefaultsCard` already implements.
- **Recommendation:** Option 1 — first-class `RuntimeCapabilities.settings`,
  slot renderers in `features/runtime-connect`-style client features, dynamic
  state on existing surfaces.

## 6) Decisions

Design decisions 1–7 are operator-resolved in
[04-design-decisions.md](04-design-decisions.md) (structure, card anatomy,
global trust row option A, all-collapsed disclosure option A, edge states,
mobile inline expansion, playground parity). Technical decisions made here:

| #   | Decision                  | Choice                                                                                                                            | Rationale                                                                                                               |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | Declaration mechanism     | First-class structured `RuntimeCapabilities.settings` (config section + ordered section descriptors)                              | ADR-0256 bar; typed + conformance-testable; kills both hand-kept maps; `features` bag is the wrong tier                 |
| 2   | Static vs dynamic split   | Declaration = static (which sections, config section, effort support); state = existing refetched surfaces                        | Capabilities cached with `staleTime: Infinity`; readiness/config already refetch                                        |
| 3   | Section rendering         | Feature-injected slot renderers keyed by declared section `kind`, same pattern as `renderConnect`                                 | Proven pattern; keeps entities props-only and bespoke UI in features; unknown kinds render nothing (forward-compatible) |
| 4   | `runtimeSupportsEffort()` | Retire the shared hardcoded list in favor of the declaration                                                                      | Third hand-kept map; a new runtime should declare it next to its other capabilities                                     |
| 5   | Config shape              | Unchanged (`runtimes.*` leaves as-is); no conf migration                                                                          | UI/declaration redesign only; keeps diff reviewable and rollback trivial                                                |
| 6   | Component architecture    | Presentational `RuntimeCard` (+ subcomponents) in entities/features per FSD, thin hook-wired container, showcases for every state | Playground parity requirement; mirrors why `RuntimeSetupPanel` is showcaseable today                                    |

**Recommended next step:** SPECIFY — the design is frozen; the spec pins the
interface shape, FSD placement (which layer owns the card given entities
cannot import config hooks — the D7 constraint that shaped today's layout),
component/file plan, test plan, and retirement list.
