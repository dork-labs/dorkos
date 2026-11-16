---
slug: runtimes-settings-redesign
id: 260803-181550
created: 2026-08-03
status: specified
tracker: DOR-888
design-session: .dork/visual-companion/9035-1785779428
---

# Runtimes settings redesign — per-runtime cards, default as a state, runtime-declared settings

**Status:** Approved (design operator-approved 2026-08-03; technical direction resolved in 01-ideation.md)
**Author:** orchestrator + operator (Dorian)
**Date:** 2026-08-03

## Overview

Rebuild Settings → Runtimes as one card per runtime. Each card carries the
runtime's full identity (accent-tinted logo, name, subtitle), its
readiness/connect state, the default marker, and — expanded — its default
model, effort, trust override, its runtime-declared bespoke sections (Claude
billing accounts, OpenCode power source), and setup details. Below the cards:
one global "Where agents stop for you" row, then the unchanged read-only
exceptions strip. All cards rest collapsed behind one-line "Starts with …"
summaries. The declaration layer moves into the shared runtime interface:
`RuntimeCapabilities.settings` declares each runtime's config section, effort
support, and bespoke sections, retiring three hand-kept maps.

Design ground truth: [04-design-decisions.md](04-design-decisions.md) (§1–§7).
Ideation + discovery: [01-ideation.md](01-ideation.md).

## Background / Problem Statement

- The tab is five visually unrelated stacked components; Claude settings are
  split across three of them (readiness card at top, model/effort mid-page,
  accounts at the bottom).
- **Capability hole:** `executionDefaults.perRuntime[]` stores model/effort
  for every runtime, but the UI renders rows only for the current default —
  setting Codex's model requires first making Codex the default.
- **Three hand-kept maps** encode what runtimes should declare:
  server `CONFIG_SECTION_BY_RUNTIME`
  (`apps/server/src/services/session/resolve-session-defaults.ts:149`), its
  admitted client mirror `configSectionForRuntime`
  (`apps/client/src/layers/entities/config/lib/runtime-config-section.ts`),
  and `RUNTIMES_WITHOUT_EFFORT` (`packages/shared/src/constants.ts:65-88`).
  Only comments keep them aligned.
- The Claude accounts card is a runtime-specific feature bolted onto the tab —
  the pattern a fourth runtime would have to copy.

## Goals

- Every runtime-owned setting lives on that runtime's card; the default
  runtime is a card state (accent pill + "Make default"), not a dropdown.
- Per-runtime model/effort editable for **every** runtime at all times.
- Runtime-declared settings: one structured capability replaces the three
  hand-kept maps; a new runtime declares once, next to its other capabilities.
- Calm-tech disclosure: collapsed cards whose summary line answers "what will
  a new conversation start with?" with zero clicks.
- Playground parity: every new component props-first with showcases for every
  state (closing today's `ExecutionDefaultsCard` / `ExecutionExceptionsStrip`
  coverage gaps).

## Non-Goals

- No config-file shape change, no conf migration (`runtimes.*` leaves as-is).
- No new runtime backends; no changes to session-time pickers beyond shared
  data; no Agent Hub Config tab changes.
- No change to trust-stop semantics, autonomy consent contract, account
  resolution, connect/provision flows, or exceptions-strip behavior.
- `RuntimeSetupDialog`/`RuntimeSetupPanel` (status-bar picker, onboarding,
  session-launch surfaces) keep working unchanged; this spec only recomposes
  the settings tab.

## Technical Dependencies

None new. Existing: React 19, TanStack Query, Radix/shadcn, motion,
Zod (shared schemas), conf-backed config, Vitest + RTL.

## Detailed Design

### A. Shared interface (`packages/shared/src/agent-runtime.ts`)

Add a **required** structured capability (compile-time forcing, per the
`commandIntents` precedent):

```ts
/** One bespoke settings section a runtime's settings card renders. */
export interface RuntimeSettingsSection {
  /**
   * Renderer key, e.g. 'claude-accounts', 'opencode-power-source'. The client
   * maps known kinds to feature-supplied renderers (same slot pattern as the
   * connect flows); unknown kinds render nothing (forward-compatible).
   */
  kind: string;
}

/** Static settings declaration for a runtime (see ADR extracted from this spec). */
export interface RuntimeSettingsCapability {
  /**
   * Key of this runtime's section under `runtimes.*` in user config
   * ('claudeCode' | 'codex' | 'opencode' today), or null when the runtime has
   * no config section (test-mode). Replaces the duplicated
   * CONFIG_SECTION_BY_RUNTIME maps. Typed `string | null` in shared (the
   * config schema is host-side); the server validates it against the real
   * config shape with a type guard and skips unknown sections.
   */
  configSection: string | null;
  /**
   * Whether this runtime takes an effort setting at all — the runtime-level
   * static fact (replaces shared `runtimeSupportsEffort()` /
   * RUNTIMES_WITHOUT_EFFORT). Per-model effort support remains
   * `ModelOption.supportsEffort` / `supportedEffortLevels`; both gates apply,
   * exactly as ExecutionDefaultsCard implements today.
   */
  supportsEffort: boolean;
  /** Ordered bespoke sections for the settings card. Empty for most runtimes. */
  sections: RuntimeSettingsSection[];
}

export interface RuntimeCapabilities {
  // … existing fields …
  /** Required — every adapter declares its settings surface. */
  settings: RuntimeSettingsCapability;
}
```

**Declarations** (each runtime's `runtime-constants.ts`):

| Runtime     | configSection  | supportsEffort | sections                              |
| ----------- | -------------- | -------------- | ------------------------------------- |
| claude-code | `'claudeCode'` | `true`         | `[{ kind: 'claude-accounts' }]`       |
| codex       | `'codex'`      | `true`         | `[]`                                  |
| opencode    | `'opencode'`   | `false`        | `[{ kind: 'opencode-power-source' }]` |
| test-mode   | `null`         | `false`        | `[]`                                  |

**Static/dynamic split (ideation D2):** the declaration carries no dynamic
state. Account lists, current provider, readiness all stay on the refetched
surfaces (`GET /api/config`, `GET /api/system/requirements`). Capabilities
remain safe to cache with `staleTime: Infinity`.

**Retirements:** `runtimeSupportsEffort()` + `RUNTIMES_WITHOUT_EFFORT`
(shared constants) — audit all callers and re-point to the capability;
server `CONFIG_SECTION_BY_RUNTIME`; client `configSectionForRuntime` (see D).

### B. Conformance + docs

`packages/test-utils/src/runtime-conformance.ts` capabilities block asserts:
`settings` present; `configSection` is a non-empty string or null;
`supportsEffort` boolean; `sections` an array of `{ kind: non-empty string }`
with unique kinds. `contributing/adding-a-runtime.md` gains the field's
authoring row (declare next to `permissionModes`; what each field means; that
sections require a client renderer to appear).

### C. Server

`describeExecutionDefaults()`
(`apps/server/src/services/session/resolve-session-defaults.ts`) iterates the
runtime registry's capabilities instead of `CONFIG_SECTION_BY_RUNTIME`:
for each registered runtime whose `settings.configSection` passes the
`isRuntimesConfigSection` type guard ('claudeCode' | 'codex' | 'opencode'),
read that config section for model/effort/trustStop; `supportsEffort` comes
from the capability. Runtimes with `configSection: null` don't appear in
`perRuntime[]` (test-mode today — unchanged behavior). Response shape of
`GET /api/config` is unchanged; no client contract break. Wiring: the function
gains access to capabilities via the runtime registry (already constructed in
the same composition root); pin the exact injection during EXECUTE without
creating an import cycle.

### D. Client — declaration consumption

- Retire `entities/config/lib/runtime-config-section.ts`. Its two consumers
  re-point to the capability map:
  - `features/settings` write paths: resolve section via
    `useRuntimeCapabilities()` → `capabilities[type].settings.configSection`.
  - `features/status/model/use-make-default-stop.ts`: same source (it already
    has capability access patterns nearby).
- A tiny shared selector in `entities/runtime` (e.g.
  `settingsForRuntime(capabilityMap, type)`) avoids re-spelling the lookup;
  half-loaded map → `undefined` → callers no-op (existing optional-all-the-way
  convention).

### E. Client — the new tab (FSD placement)

All new UI lives in `features/settings/ui/runtimes/` (features may import
entities + compose sibling features' UI; this sidesteps the D7 constraint that
shaped the old layout — entities never touch config hooks):

```
features/settings/ui/runtimes/
├── RuntimesTab.tsx            # recomposed tab (replaces ui/tabs/RuntimesTab.tsx)
├── RuntimeCard.tsx            # container: wires hooks, owns write paths
├── RuntimeCardView.tsx        # presentational card: header + summary + body (props-only)
├── RuntimeCardSummary.ts      # pure summary-segment builder (unit-testable)
├── rows/ModelRow.tsx          # model select (inherit = "Runtime's choice", gone-model entry)
├── rows/EffortRow.tsx         # segmented control + both unsupported states + stranded-clear
├── rows/TrustRow.tsx          # per-runtime override ("Global setting" until overridden)
├── GlobalTrustRow.tsx         # the one global dial beneath the cards
├── sections/ClaudeAccountsSection.tsx    # relocated ClaudeAccountsCard internals
├── sections/PowerSourceSection.tsx       # provider display + Change (reuses runtime-connect flow)
└── section-registry.tsx       # kind → renderer map (claude-accounts, opencode-power-source)
```

- **`RuntimeCardView`** (props-only, showcaseable): identity header (logo tile
  tinted with descriptor accent at 24px, name, subtitle, readiness, "Fix
  sign-in"/"Change" affordance, Connect action slot, Default pill or "Make
  default"), collapsed summary line, expanded body (rows + declared sections +
  setup-details disclosure). Accent ring on the default card. Expansion is
  per-card independent state; click target is the header/summary; controls
  inside stop propagation.
- **`RuntimeCard`** (container) wires: `useConfig`, `useUpdateConfig`,
  `useRuntimeCapabilities`, `useRuntimeReadiness(type)`,
  `useModels({ runtime })` **enabled only when the runtime is ready AND the
  card is expanded or has a configured model to name** (lazy; summary falls
  back to the raw model id if the catalog hasn't loaded), provision hook,
  `renderRuntimeConnect`, and the section registry.
- **Write paths** (all one `PATCH /api/config`, invalidate the `['config']`
  prefix — the existing convention):
  - Make default → `{ runtimes: { default: type } }`.
  - Model/effort → `{ runtimes: { [section]: { defaultModel | defaultEffort } } }`.
  - Per-runtime trust + global trust: carry over `changeTrustStop` /
    `trustStopPatch` and the autonomy-consent contract **verbatim** — a
    Full-autonomy default still asks via `AutonomyConfirmDialog` when no
    standing acknowledgement exists, and the ack + stop land in the SAME
    request (`ui.autonomyAcknowledgedAt` + stop patch). Extract the logic into
    `features/settings/model/use-trust-stop-writes.ts` shared by `TrustRow`
    and `GlobalTrustRow` (same-feature model sharing is allowed).
  - Accounts section keeps ClaudeAccountsCard's write semantics unchanged
    (add validation: absolute path, duplicate guard; removing the active
    account releases it).
- **Summary line contract** (design §4): segments in order — model
  (`displayName`, else raw id, else "Runtime's choice") · effort (label, only
  when the runtime takes effort) · trust ("Asks first"-style short label of the
  effective stop, marked as global-inherited vs overridden) · account/provider
  segment only when the runtime declares such a section and a value exists.
  Not-ready card: no summary; "One sign-in away." Broken-default card: warning
  line + Connect (design §5).
- **Tab composition:** one-line intro → cards (`PRIMARY_RUNTIME_TYPES` +
  registered extras, same ordering rule as `RuntimeSetupPanel`) → refresh icon
  affordance (replaces the labeled "Check again" row; still
  `requirementsQuery.refetch`) → `GlobalTrustRow` → `ExecutionExceptionsStrip`
  (unchanged import).
- **Mobile (design §6):** inline expansion (no drawer); summary compresses
  ("Ready" text drops where the pill/Connect implies it; short trust labels);
  "Make default" renders in the expanded body instead of the header below the
  `sm` breakpoint; global trust dial stacks full-width. Same components,
  responsive classes only.

### F. Retirements (no dead code, no half-migrations)

- `features/settings/ui/execution-defaults/ExecutionDefaultsCard.tsx` (+ test)
  — superseded by cards; `DefaultTrustStopSection` is split: global dial →
  `GlobalTrustRow`, per-runtime rows → `TrustRow` (reuse its resolution
  helpers; keep the TrustDial showcases working against the new components).
- `features/settings/ui/ClaudeAccountsCard.tsx` (+ test) → internals move to
  `sections/ClaudeAccountsSection.tsx`; showcase + its test move with it.
- `entities/config/lib/runtime-config-section.ts` (+ consumers re-pointed).
- Shared `runtimeSupportsEffort` / `RUNTIMES_WITHOUT_EFFORT` (+ all callers).
- Server `CONFIG_SECTION_BY_RUNTIME`.
- Old `ui/tabs/RuntimesTab.tsx` content replaced by the new composition.
- Sweep: e2e/browser tests + playground/settings-mock-data referencing
  `default-runtime-select`, `claude-account-*` testids at old locations;
  update `settings-sections.ts` / showcase registries.

### API changes

None to routes/response shapes. `GET /api/capabilities` responses grow the
`settings` field (additive; Zod schema for capabilities updated in shared).

### Data model changes

None (config file unchanged).

## User Experience

See [04-design-decisions.md](04-design-decisions.md) — §1 structure, §2 card
anatomy, §3 global trust, §4 disclosure + summary, §5 edge states ("said, not
hidden" carried forward verbatim: default-but-not-connected, model no longer
offered, stranded effort with one-tap clear), §6 mobile. The final composite
mockup is the acceptance reference
(`.dork/visual-companion/9035-1785779428/content/04-final-composite.html`).

## Testing Strategy

- **Unit (shared/test-utils):** conformance additions (B) — run per runtime
  via each adapter's existing conformance test; a deliberately-malformed
  capability object must fail (prove the check can fail).
- **Server:** `resolve-session-defaults` tests updated: capability-driven
  iteration (a fake runtime with `configSection: null` is absent from
  `perRuntime`; a declared section reads the right config leaf; supportsEffort
  flows from the capability). Config route projection shape pinned unchanged.
- **Client (RTL + mock Transport):**
  - `RuntimeCardSummary` pure-function table tests (every segment rule incl.
    inherit, gone model, no-effort runtime, provider segment, not-ready).
  - `RuntimeCardView` state tests: collapsed/expanded, default pill vs make
    default, broken-default warning, connect slot, sections rendering by kind,
    unknown kind renders nothing.
  - `RuntimeCard` container: each write path patches the right config leaf;
    autonomy consent still single-request (ack + stop together); model list
    laziness; removing active account releases it.
  - `section-registry`: known kinds resolve, unknown kinds no-op.
  - Re-pointed `use-make-default-stop` tests.
- **E2E/browser:** update selectors; one flow: expand Codex card → set model →
  make default → reload → summary reflects it.
- **Playground (hard requirement, design §7):** showcases for: collapsed trio
  (default/ready/not-ready), expanded Claude (accounts) + OpenCode (power
  source), broken-default, gone-model, stranded-effort, mobile viewport via
  `ShowcaseDemo responsive`. Registry entries in `settings-sections.ts` (or a
  new runtimes section group); replaces the ExecutionDefaultsCard /
  ExecutionExceptionsStrip gaps (strip showcase added too now that data can be
  injected — give `ExecutionExceptionsStrip` an optional exceptions prop).

## Performance Considerations

Models queries are per-runtime but lazy (ready + needed) and TanStack-cached;
capabilities/config/requirements queries are already shared. No new polling.

## Security Considerations

Unchanged enforcement: `runtimes.claudeCode` leaves and the autonomy
acknowledgement remain operator-only at the server; the UI keeps surfacing the
server's refusal wording verbatim (existing `describeWriteFailure` pattern).
No new write surfaces.

## Documentation

- `contributing/adding-a-runtime.md` — the new declaration's authoring row.
- Changelog fragment (user-facing, `writing-for-humans` voice): the Runtimes
  page now shows one card per runtime; set each runtime's model and effort;
  pick your default on the card.
- `specs/execution-defaults` + `claude-code-accounts` remain historical; this
  spec supersedes their UI claims (note added in DONE stage if needed).

## Implementation Phases

- **Phase 1 — declaration layer (PR 1, no visual change):** shared interface
  - Zod schema + four adapter declarations + conformance + docs; server
    `describeExecutionDefaults` capability-driven; retire the shared constant +
    server map; re-point the two client consumers (behavior identical);
    changelog `skip-changelog` candidate (internal) — decide at PR time.
- **Phase 2 — the new tab (PR 2):** RuntimeCard family + sections + global
  trust row + tab recomposition + retirements + tests + playground + e2e
  sweep + changelog fragment. Stacked on PR 1.

## Open Questions

~~1. Where does `RuntimeCard` live given entities cannot import config hooks?~~
**(RESOLVED)** Answer: `features/settings/ui/runtimes/` — features import
entities freely and may compose sibling features' UI (`renderRuntimeConnect`),
so the D7 constraint dissolves; entities keep only props-only pieces.
Rationale: matches FSD rules and keeps `RuntimeSetupPanel` untouched for its
other surfaces.

~~2. Does the summary need models loaded for collapsed cards?~~ **(RESOLVED)**
Answer: no — fall back to the raw model id until the catalog loads; fetch
models lazily (ready runtime, expanded or configured-model card). Rationale:
avoids three eager queries on tab open; the id is honest interim truth.

~~3. One PR or two?~~ **(RESOLVED)** Answer: two stacked PRs (declaration
layer, then UI). Rationale: PR 1 is mechanically verifiable with zero visual
risk; PR 2 carries the visual diff; each stays reviewable.

## Related ADRs

- ADR-0256 (capabilities shape: booleans + structured + features) — this spec
  adds a structured first-class field per its own bar.
- ADR-0255 (per-session runtime binding), ADR-0310 (runtime-owned session
  storage) — context, unchanged.
- Draft ADR extracted from this spec: runtime-declared settings surface
  (`RuntimeCapabilities.settings`).

## References

- DOR-888 (tracker); related DOR-885 (runtime-declared permission-mode ids).
- `specs/runtimes-settings-redesign/04-design-decisions.md` + mockup session.
- Discovery report inlined in `01-ideation.md` §2–§3 (file:line anchors).
- `specs/execution-defaults/04-design-decisions.md` (the prior card's design
  decisions this supersedes in part).
