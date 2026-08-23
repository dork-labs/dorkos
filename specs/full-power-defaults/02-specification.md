---
slug: full-power-defaults
id: 260822-235213
created: 2026-08-22
status: specified
design-session: .dork/visual-companion/63891-1787441390
tracker: DOR-1431
project: Full Power by Default
---

# Full Power by Default

**Status:** Approved (execution authority delegated by Dorian, 2026-08-22)
**Author:** Claude (delegated)
**Date:** 2026-08-22

## Overview

Flip DorkOS so the default path leads to full power. One consent door — rendered as a dedicated onboarding stage for new users and a one-time modal for existing users — turns on, atomically: full autonomy as the default trust level, open mesh (agents talk across projects), standing grants, and unattended surfaces at the operator's power level, with `canInitiate` pre-selected for new bindings. Two safety-neutral defaults (warm agents, scheduler concurrency) flip as plain defaults. A generalized **moments rail** carries the door for existing users and absorbs telemetry consent (banner retired). A global **Control Center** flyout exposes the dial, the power switches, and an overrides ledger. The color story inverts: green celebrates full power; red is reserved for genuine alarms.

## Background / Problem Statement

Every DorkOS install ships at the most careful stop of every axis: `runtimes.defaultTrustStop` is `null` at all tiers (→ each runtime's ask-first mode), the mesh denies cross-project agent messaging, "always allow" answers don't persist, agents cold-start per message, the scheduler runs one task at a time, and full autonomy is dressed in red warnings. The product thesis is coordination and operator leverage; the defaults contradict it. The Trust Dial program (specs/trust-dial/, 2026-08-01) already built the hard part — a server-enforced consent door (`428 AUTONOMY_ACK_REQUIRED`) with a durable acknowledgment — and explicitly permitted autonomy as a default. This program moves that door to the front of the product and flips what the default path recommends.

**Governing invariant (A1): nothing consent-gated flips silently.** The recommended, pre-selected, one-click path leads to full power; the flips are written by the door's accept. The server gate is untouched. Decline is first-class, recorded, and never re-asked.

## Goals

- New users choose their power level during onboarding, with **Full power** recommended and one click away.
- Existing users get the same choice once, in a modal, on a new reusable moments rail.
- Accepting writes every consent-gated flip through existing gated paths; declining changes nothing and is remembered.
- Telemetry consent becomes a modal moment; the banner retires.
- A Control Center gives one obvious top-level place to see and change the power posture, including every override.
- Full autonomy looks like the unlocked, powerful state (green), not the dangerous one (red).
- Warm agents + scheduler concurrency improve for everyone (safety-neutral).

## Non-Goals

- No change to: extension execution approval, MCP/A2A auth or exposure guards, `a2a.enabled`, the marketplace/content schedule permission clamp, task `permissionMode` operator-only write policy, telemetry channel defaults, `mesh.scanRoots`, approval TTL ceiling, `ManagedMcpServerSchema.enabled`, runtime capability profiles (`permissionModes.default`).
- No weakening of the `428 AUTONOMY_ACK_REQUIRED` contract on `PATCH /api/sessions/:id` or `PATCH /api/config`.
- No CLI full-power parity command in this program (follow-up issue; `dorkos config acknowledge-autonomy` continues to cover the trust flip).
- No Obsidian-embed door changes (DirectTransport keeps its per-session dialog with `canRemember=false`).
- No renaming of the three Trust Dial stops.

## Technical Dependencies

None new. Everything builds on: Zod config schema + `conf` migrations, the Trust Dial semantics substrate (`@dorkos/shared/permission-semantics`), the banner-slot/dialog-registry client rails, TanStack Query + Zustand, shadcn Dialog/Popover, Drizzle (mesh rules table, read-only here).

## Detailed Design

### D1. Config schema (`packages/shared/src/config-schema.ts`)

New fields (each declared per-field AND in the section's object-literal default — the two-declaration rule):

- `ui.fullPowerDecidedAt: string | null`, default `null` — ISO timestamp when the person answered the door (either answer). The single "answered" signal for both onboarding and the modal.
- `ui.fullPowerChoice: 'full' | 'supervised' | null`, default `null` — what they chose. `'supervised'` + later acceptance via Control Center is fine; the door itself never re-asks once `fullPowerDecidedAt` is set.
- `onboarding` steps: add `'power'` to `ONBOARDING_STEPS` (:114). Completion semantics mirror existing steps; the authoritative "answered" signal remains `ui.fullPowerDecidedAt` (steps track flow progress, not consent).

Changed defaults (safety-neutral only):

- `runtimes.claudeCode.persistentSession`: `false` → `true`, **graduating out of the experiments registry** (`apps/server/src/services/core/config/experiments-registry.ts` entry removed; the registry test enforces experiments default false, so graduation = removal). Its user-facing switch moves to the Control Center.
- `scheduler.maxConcurrentRuns`: default `1` → `4` (bounds unchanged, 1–10).

Safe-defaults registry (`default-verdicts.ts`): classify `ui.fullPowerDecidedAt` / `ui.fullPowerChoice` as `no-risk` (records of an answer); move `runtimes.claudeCode.persistentSession` and `scheduler.maxConcurrentRuns` verdicts to `permissive` with reasoning. Update `operator/config-disclosure.ts` + `config-write-policy.ts` classifications for the new fields.

### D2. Config migration (key `0.66.0`, append-only)

- Seed `ui.fullPowerDecidedAt: null`, `ui.fullPowerChoice: null` when absent.
- Bump `scheduler.maxConcurrentRuns` `1 → 4` and `runtimes.claudeCode.persistentSession` `false → true`. These are indistinguishable from an explicit user choice of the old default (both shipped at that value); the migration comment records this deliberately, the changelog fragment names it, and the Control Center makes both discoverable/revertible. No consent-gated value is touched by migration (A1).
- Migration body follows the additive/idempotent contract; hashes/tests per `contributing/configuration.md` + the `adding-config-fields` skill.

### D3. The door (shared consent component + accept/decline writes)

One client component (feature `full-power-door`, FSD features layer) renders the door's content in two hosts: the onboarding stage and the existing-user moment. Content per `design-decisions.md` §3: title "DorkOS runs at full power", plain-language list (runs without asking · agents message each other across projects · approvals stick · scheduled runs at your power level), primary green **"Unlock full power"**, secondary **"Keep asking me first"**, tertiary link **"Customize…"** (opens the Control Center after recording the decision as `supervised`), honest scope note (existing `permission-mode-scope-note` component), link to Settings.

**Accept** performs, in order (all through existing surfaces; server contracts unchanged):

1. `PATCH /api/config` — one atomic write: `ui.autonomyAcknowledgedAt` (the standing ack; satisfies the config-write autonomy gate exactly as `useTrustStopWrites` does today), `ui.fullPowerDecidedAt`, `ui.fullPowerChoice: 'full'`, `runtimes.defaultTrustStop: 'autonomy'`, `approvals.standingGrants: true`.
2. `PUT /api/mesh/topology/access` `{ sourceNamespace: '*', targetNamespace: '*', action: 'allow' }` (the OpenMeshSwitch path). Mesh write failure does not roll back step 1; the door reports partial success plainly and the Control Center shows the true mesh state.

**Decline** writes only `ui.fullPowerDecidedAt` + `ui.fullPowerChoice: 'supervised'`. **Deferral** (modal X / "decide later" in onboarding = skip) writes nothing; the moment re-arbitrates next launch, the onboarding step records `skippedSteps` per existing semantics.

### D4. Onboarding power stage

`ONBOARDING_STAGES` gains `'power'` between `'requirements'` and `'conversation'` (`onboarding-stage.ts:15`); URL-synced like the others. The stage hosts the door component (onboarding voice: "Choose your power level"). Answering (either way) calls `completeStep('power')` and advances; skipping calls `skipStep('power')`. New-user path therefore never sees the modal (`fullPowerDecidedAt` set, or they deferred and the moment predicate picks them up post-onboarding like any existing user).

### D5. The moments rail (`apps/client/src/layers/widgets/moments/`)

A widget mirroring the app-banner arbitration pattern, for one-time modals:

- `MomentDescriptor { id, priority, render }`; a `useMoments()` collector enumerates descriptor hooks (same "append here, no other wiring" convention as `use-app-banners.tsx`). Eligibility lives in each descriptor hook, exactly as `BannerDescriptor` does it: an ineligible moment's hook returns `null`; there is no `shouldShow` method on the object.
- `MomentHost` mounts in `AppShell` beside `DialogHost`. Arbitration: highest-priority eligible moment; **at most one moment shown per app launch** (session flag in the Zustand app-store, not persisted); never while the onboarding overlay is mounted, never while onboarding is incomplete-and-undismissed.
- Persistence is each moment's own concern via real state fields (exactly like banner descriptors) — no parallel "shownMoments" store to drift.
- Moment 1 — **full-power door** (priority high): eligible when config loaded ∧ onboarding over (`completedAt ?? dismissedAt`) ∧ `ui.fullPowerDecidedAt === null`; otherwise its hook returns `null`.
- Moment 2 — **telemetry consent** (priority low): eligible when `!telemetry.userHasDecided`; otherwise its hook returns `null`. Renders the existing banner's copy/buttons as a modal (writes unchanged: the three Tier-1 booleans + `userHasDecided`, `lastPromptedVersion` stamped as the consent surfaces already do). `TelemetryConsentBanner` and its banner-slot descriptor are **removed** (no dead code).

### D6. Unattended surfaces follow the operator's level

- New helper in `apps/server/src/services/session/resolve-session-defaults.ts`: `resolveUnattendedDefaultStop()` → the configured global `defaultTrustStop` (per-runtime override respected where a runtime is known), else `null`.
- **Tasks:** `CreateTaskRequestSchema`'s hardcoded `.default('acceptEdits')` (schemas.ts:3953) is removed; the route/service resolves an omitted `permissionMode` via the ladder: operator's stop mapped through the runtime capability profile (`resolveTrustStops`), falling back to `'acceptEdits'` when unset (byte-for-byte today's behavior when the door was never accepted). Scheduler fallback (task-scheduler-service.ts:661) uses the same helper. The schedule-permission clamp for file/marketplace-sourced schedules is untouched.
- **Bindings:** `AdapterBinding.permissionMode` schema default `'default'` stays (wire safety); the binding creation UI defaults its TrustDial to the operator's stop. `canInitiate`: schema default stays `false`; the binding form pre-selects it `true` when `ui.fullPowerChoice === 'full'`.
- **Client forms** (`TaskFormInner.tsx`, binding dialog): initial TrustDial selection = operator's stop (from config), not hardcoded `'acceptEdits'`. The per-instance `UnattendedAutonomyDialog` confirm at creation **stays** (one honest click on the truly unattended surface).

### D7. Control Center (`apps/client/src/layers/widgets/control-center/`)

- Entry: persistent glyph (⚡) in the app chrome (sidebar header row; exact anchor finalized against the live layout during implementation), plus command-palette entry and a keyboard shortcut.
- Flyout (Popover on desktop / Sheet on small viewports) contents, in order:
  1. Global Trust Dial (shared `trust-dial` component) writing through `useTrustStopWrites` (consent door fires automatically when needed — existing behavior).
  2. Power switches: open mesh (`useSetOpenMesh`), standing grants, warm agents (`persistentSession`), schedule concurrency (bounded stepper) — all `PATCH /api/config` / existing hooks.
  3. **Overrides ledger:** per-runtime `defaultTrustStop` overrides (config), live sessions whose bound mode's stop ≠ global stop (sessions query), tasks and bindings with their modes (existing queries) — each row deep-links to its owning surface. Composed client-side from existing TanStack queries; **no new server endpoint**.
  4. Standing line when `isUnattendedAutonomy` drivers are live (same collector as the unattended banner).
- The flyout states plainly that the global dial applies to **new** sessions (bound rows never touched).

### D8. Color & language flip

Semantics-derived only (no mode-id checks — the substrate rule):

- `trust-dial.tsx` `captionTone`: autonomy stop → positive green (`text-emerald-600 dark:text-emerald-400` or the design system's success token); divergence stays amber; ask stays muted.
- `PermissionModeItem.tsx`: `warnTier === 'danger'` red replaced by stop-derived tint — autonomy → green; ask → muted with lock affordance ("Limited" framing in the popover, not the strip word).
- `AutonomyConfirmDialog` / `UnattendedAutonomyDialog`: `ShieldOff`-red becomes ⚡-green presentation with confident copy; the honest fact lines stay verbatim in tone-neutral styling; confirm buttons use primary/green, never `bg-red-600`.
- `GlobalTrustRow` standing note: red → green, copy "New sessions run at full power — change".
- `UnattendedAutonomyBanner`: variant `warning` → `info`, copy reframed matter-of-fact ("Running unattended at full power: {names}"), still non-dismissible.
- Red remains for: quarantine/unreadable-rules, errors, destructive confirmations elsewhere. All copy passes `writing-for-humans`.

## User Experience

- **New user:** welcome → requirements → **Choose your power level** (Full power recommended, one click; Supervised equally respectable; skip allowed) → DorkBot conversation. No modal later if answered.
- **Existing user:** next app launch after upgrade → the door modal, once. Accept = everything on, green confirmation; Decline = nothing changes, never asked again; X = asked again next launch. Telemetry modal arrives on a subsequent launch if still undecided.
- **Everyone:** ⚡ glyph always visible → Control Center: see the posture, flip a switch, spot every override, jump to its source. Full autonomy reads green/unlocked everywhere; nothing shames Supervised.

## Testing Strategy

- **Unit:** config migration 0.66.0 (fresh + upgrade paths, both default declarations agree — guard test); safe-defaults drift test updates; `resolveUnattendedDefaultStop` ladder (set/unset/per-runtime, never-accepted fallback byte-for-byte); moments arbitration (priority, one-per-launch, onboarding suppression); door accept/decline write sets (mock Transport — assert atomic config PATCH shape incl. ack, mesh PUT, partial-failure reporting); telemetry moment writes ≡ old banner writes; task-create route resolves omitted mode via ladder; clamp untouched (regression: file-sourced schedule still clamps).
- **Integration (server):** `PATCH /api/config` one-shot accept payload passes the autonomy gate; without ack still 428s (regression).
- **E2E/browser (apps/e2e):** onboarding power stage renders + both choices persist; existing-user modal appears once and never after answer; Control Center opens, dial + switches write, overrides rows deep-link. Radix-menu focus race memory applies: browser-verify menu→dialog flows.
- **Mocking:** client tests via `TransportProvider` fake; server via `FakeAgentRuntime` where sessions are touched.

## Performance Considerations

Warm agents raise idle memory (bounded: max 12 warm, ~1GB each worst-case) — flagged in changelog; revertible in Control Center. Scheduler 4-way concurrency is within existing bounds. Moments/Control Center compose existing queries; no new polling.

## Security Considerations

The 428 consent gates are untouched and regression-tested. Consent-gated capabilities flip only via the door's accept (A1). The stay-locked list (Non-Goals) is explicitly out of scope; a reviewer finding any of those loosened should treat it as a defect. Marketplace/content clamp regression-tested. `canInitiate` stays schema-false; only the operator-facing form pre-selects it post-acceptance.

## Documentation

- `docs/` guides touching permissions/onboarding/telemetry updated (writing-for-humans).
- `contributing/configuration.md` untouched (process followed, not changed); new fields documented per `adding-config-fields`.
- Changelog fragment per PR (covers: blocks); release notes highlight the door.
- ADRs: see Related ADRs.

## Implementation Phases

Seven PRs, each worktree-isolated, adversarially reviewed pre-PR (REVIEW.md), merged via the queue:

- **PR-1 `spec`** — this spec + design-decisions + ideation + draft ADRs + manifest (docs-only).
- **PR-2 `moments-rail`** — D5 rail + telemetry moment + banner retirement. _(independent)_
- **PR-3 `defaults-flips`** — D1 (changed defaults + new fields) + D2 migration + safe-defaults/disclosure/write-policy + D6 server-side (task/scheduler resolution helper). _(independent)_
- **PR-4 `door`** — D3 component + existing-user moment on the rail + accept/decline writes. _(needs PR-2, PR-3)_
- **PR-5 `onboarding-power-stage`** — D4. _(needs PR-4)_
- **PR-6 `control-center`** — D7 + D6 client form defaults (task/binding dial + canInitiate pre-select). _(needs PR-3; overrides ledger independent of door)_
- **PR-7 `green-flip`** — D8. _(independent)_

Wave plan: wave 1 = PR-2, PR-3, PR-7 in parallel; wave 2 = PR-4, PR-6; wave 3 = PR-5.

## Open Questions

~~1. Should ask-first be styled red per the literal brief? **(RESOLVED)** Answer: no — neutral + lock affordance; red reserved for alarms. Rationale: no-dark-patterns filter; alarm-economy lesson already encoded in the codebase; recorded as an overrulable deviation (design-decisions.md §6).~~

~~2. Should open mesh flip via Drizzle data migration for existing installs? **(RESOLVED)** Answer: no — door-accept writes it through the existing mesh access API. Rationale: A1; a data migration is a silent flip.~~

~~3. Do task/binding per-instance unattended confirms survive? **(RESOLVED)** Answer: yes — forms default to the operator's level, the one-click confirm at creation stays. Rationale: unattended is the one surface where a moment of explicit confirmation still earns its place.~~

## Related ADRs

To be seeded as drafts from this spec (extractedFrom: full-power-defaults): (a) A1 — consent-led default flipping; (b) the moments rail as the one-time-modal system; (c) the color economy (green = power, red = alarms); (d) unattended surfaces follow the operator's level. Standing constraints: ADR 260727-181825 (safe defaults), ADR 0043 (agent storage), trust-dial decision records (specs/trust-dial/04-design-decisions.md).

## References

- DOR-1431 (umbrella) · project "Full Power by Default"
- `specs/full-power-defaults/design-decisions.md` (decision record + visual companion session)
- `specs/trust-dial/04-design-decisions.md` (substrate)
- Exploration reports (2026-08-22, four parallel sweeps; file:line findings folded into 01-ideation.md §2–3)
