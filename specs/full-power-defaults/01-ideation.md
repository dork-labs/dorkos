---
slug: full-power-defaults
id: 260822-235213
created: 2026-08-22
status: ideation
design-session: .dork/visual-companion/63891-1787441390
tracker: DOR-1431
project: Full Power by Default
---

# Full Power by Default

**Slug:** full-power-defaults
**Author:** Claude (delegated by Dorian, 2026-08-22)
**Date:** 2026-08-22
**Umbrella:** DOR-1431 - Make full power the default — one-door consent, open mesh, Control Center, green-unlocked UI

---

## 1) Intent & Assumptions

- **Task brief:** DorkOS currently ships every default at its most restrictive stop. Flip the product so the default path leads to full power: full autonomy as the default trust level, agents talking to each other across projects, approvals that stick, warm agents, unattended surfaces at the operator's chosen power level — all entered through one plain-language consent door (an onboarding stage for new users, a modal for existing users), surfaced in a new Control Center, and styled so full autonomy reads as unlocked (green), not dangerous (red).
- **Operator mandate:** Scope was validated interactively with Dorian (visual companion session `.dork/visual-companion/63891-1787441390`; all six flips selected). Remaining design decisions were explicitly delegated; the delegated choices are recorded in `design-decisions.md` beside this file.
- **Assumptions:**
  - The governing invariant, adopted as **A1 — nothing consent-gated flips silently**: "full power by default" means the recommended, pre-selected, one-click path leads to full power. The server-enforced consent gate (`428 AUTONOMY_ACK_REQUIRED`, `apps/server/src/services/core/approvals/autonomy-consent.ts`) is untouched. A config file never mutates behind a user's back; the door's accept writes the flips.
  - Safety-neutral flips (`runtimes.claudeCode.persistentSession`, `scheduler.maxConcurrentRuns`) may change as plain defaults — the repo's own safe-defaults registry (`apps/server/src/services/core/safe-defaults/default-verdicts.ts`) classifies the former as capability-neutral, and the latter is a resource throttle shipping at the floor of its own allowed range.
  - The existing Trust Dial substrate (3 stops, `PermissionModeDescriptor` semantics, `needsConsentRitual`, durable `ui.autonomyAcknowledgedAt`) is the foundation, not something to replace.
- **Out of scope (deliberately kept locked — the wall between "powerful" and "owned"):**
  - Extension code execution approval (`extensions.approvedToRun`, `extension-load-policy.ts`) — marketplace/agent-written code runs with server privileges, no sandbox.
  - MCP/A2A auth and network exposure guards (`mcp-auth.ts`, `exposure-guard.ts`, `DORKOS_ALLOW_INSECURE_BIND`); `a2a.enabled` stays an experiment.
  - The marketplace/content schedule permission clamp (`schedule-permission-clamp.ts`) — downloaded content can never introduce `bypassPermissions`. Power belongs to the operator, not to installed packages.
  - Task `permissionMode` stays `operator-only` in the write policy (`task-write-policy.ts`) — agents cannot raise their own power.
  - Telemetry channel defaults (privacy posture unchanged; only its consent _surface_ moves from banner to modal).
  - `mesh.scanRoots`, approval TTL ceiling, `ManagedMcpServerSchema.enabled` — deliberate walls that cost users nothing day-to-day.
  - Runtime `permissionModes.default` capability declarations stay as-is (the ladder above them changes, not the runtime profiles).

## 2) Pre-reading Log

- `specs/trust-dial/04-design-decisions.md`: the shipped Trust Dial program (2026-08-01, PRs #668–#695). Full autonomy is already a _permitted_ default; set-time is consent-time; the shipped default remained Ask first. This program revisits exactly that last sentence.
- `packages/shared/src/permission-semantics.ts`: `needsConsentRitual` (autonomy stop OR never-asks beyond read) is the door predicate; `warnTier`, `isDivergent`, `isUnattendedAutonomy` drive all styling — no mode-id tables anywhere.
- `apps/server/src/services/session/resolve-session-defaults.ts`: the four-tier ladder (agent manifest → per-runtime `defaultTrustStop` → global `defaultTrustStop` → runtime's own default). All config tiers ship `null`.
- `apps/server/src/services/core/approvals/autonomy-consent.ts`: standing ack `ui.autonomyAcknowledgedAt`; `demoteAutonomyDefaultsOnAckClear` (reset means reset).
- `packages/mesh/src/default-access-rules.ts` + `packages/mesh/src/topology.ts`: cross-namespace deny at priority 10; `openMesh` is a derived `* → *` row in SQLite (`meshNamespaceRules`), not a config field.
- `apps/client/src/layers/features/onboarding/`: stages `welcome → requirements → conversation`; steps tracked in `onboarding.completedSteps`; `use-profile-prompt.ts` is the proven existing-user re-ask idiom (nullable timestamp + "onboarding already over" gate).
- `apps/client/src/layers/widgets/app-banner/`: priority-ranked single-winner banner slot; telemetry consent is one descriptor; `UnattendedAutonomyBanner` is another.
- `apps/client/src/layers/widgets/app-layout/ui/DialogHost.tsx` + `layers/shared/model/extension-registry.ts`: declarative dialog slot registry — the rails the moments system builds on.
- `apps/server/src/services/core/config-manager.ts`: append-only semver-keyed `CONFIG_MIGRATIONS`; `0.64.0` and `0.65.0` already merged; **next open key is `0.66.0`**. conf's defaults-merge is shallow; per-field + object-literal defaults both required.
- `apps/server/src/services/core/safe-defaults/default-verdicts.ts`: every config leaf must be classified; build fails on drift.
- Four parallel exploration reports (2026-08-22, in-session): permission modes, onboarding/telemetry, agent-to-agent, restrictive-defaults sweep. Findings folded in below.

## 3) Codebase Map

- **Trust ladder & consent:** `packages/shared/src/config-schema.ts` (`DefaultTrustStopSchema` :1165, `runtimes.*.defaultTrustStop` :1926–2037, `ui.autonomyAcknowledgedAt`), `apps/server/src/routes/sessions.ts` (PATCH gate :580–593), `apps/server/src/services/core/operator/config-write.ts` (:308 config-side gate), `packages/cli/src/config-write.ts` (CLI ritual).
- **Mesh/relay:** `packages/mesh/src/{default-access-rules,topology,namespace-rule-store}.ts`, `packages/relay/src/{access-control,relay-publish}.ts`, `apps/client/src/layers/entities/mesh/ui/OpenMeshSwitch.tsx`, `PUT /api/mesh/topology/access` (`apps/server/src/routes/mesh.ts:376`).
- **Approvals:** `packages/shared/src/config-schema.ts` `approvals.standingGrants` :2074, `apps/server/src/services/core/approvals/approval-service.ts`.
- **Scheduler/tasks/bindings:** `packages/shared/src/schemas.ts` `CreateTaskRequestSchema` :3953 (`acceptEdits` default), `task-scheduler-service.ts:661`, `relay-adapter-schemas.ts:611` (binding `permissionMode` default) + `:621` (`canInitiate` default false), `apps/client/src/layers/features/tasks/ui/TaskFormInner.tsx:106,117`.
- **Onboarding:** `apps/client/src/layers/features/onboarding/**`, `packages/shared/src/config-schema.ts` `ONBOARDING_STEPS` :114, `OnboardingStateSchema` :119.
- **Banner/dialog rails:** `apps/client/src/layers/widgets/app-banner/**`, `apps/client/src/layers/widgets/app-layout/ui/DialogHost.tsx`, `apps/client/src/layers/shared/model/extension-registry.ts` (SLOT_IDS.DIALOG), `app-store-panels.ts`.
- **Styling/color:** `apps/client/src/layers/shared/ui/trust-dial.tsx` (captionTone :365), `PermissionModeItem.tsx` (:163 red), `AutonomyConfirmDialog.tsx` (ShieldOff, red/amber), `UnattendedAutonomyDialog.tsx` (:120 red button), `GlobalTrustRow.tsx` (:151–176 red standing note), `UnattendedAutonomyBanner.tsx` (warning variant), `apps/client/src/index.css` status tokens.
- **Telemetry consent:** `apps/client/src/layers/features/telemetry-consent/ui/TelemetryConsentBanner.tsx`, `packages/shared/src/telemetry-consent.ts`, `telemetry.lastPromptedVersion` (designed-but-unwired re-prompt anchor).
- **Blast radius:** config schema + migrations, safe-defaults registry, operator config-write policy/disclosure, session routes, mesh routes + a Drizzle data migration, onboarding flow, app shell (DialogHost/moments), settings Runtimes tab, status strip, CLI copy, docs (`docs/`), marketplace disclosure copy untouched.

## 4) Root Cause Analysis

Not a bug fix — omitted.

## 5) Research

Summarized options considered and resolution; full option analysis lives in `design-decisions.md`.

1. **Silent default flip vs consent-led flip** — silent flip rejected: violates ADR 260727-181825 ("absence is not consent"), the server literally 428s, and it would be a dark pattern. **Consent-led flip chosen** (invariant A1).
2. **Consent shape: one door vs checklist vs staged** — one door chosen; checklist relocates to the Control Center behind "Customize…"; staged doors nag.
3. **Where consent lives for new users** — dedicated onboarding stage chosen over a DorkBot conversation beat (conversation steps are skippable and buried) and over folding into welcome (dilutes both).
4. **Modal system** — a generalized "moments" rail chosen over another one-off dialog; telemetry banner migrates onto it, satisfying the standing intent of `telemetry.lastPromptedVersion` and Dorian's explicit ask ("do we have a good system? If not, build one").
5. **Control Center placement** — global flyout from persistent app-chrome glyph chosen; command palette + shortcut as secondary entries.
6. **Color economy** — green = full power; red reserved for genuine alarms; deliberate deviation from the literal brief ("not autonomous = red") recorded with reasoning in `design-decisions.md` §6.

## 6) Decisions

| #   | Decision                     | Choice                                                                                                                            | Rationale                                                                                                                |
| --- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Program scope                | All six flips (autonomy default, open mesh, standing grants, warm agents + concurrency, unattended surfaces, canInitiate)         | Dorian selected all six in the visual companion (screen 01, events recorded)                                             |
| 2   | Flip mechanism               | A1: consent-gated flips written by the door's accept; only safety-neutral flips change as schema defaults                         | Server 428 gate + safe-defaults ADR; honesty by design                                                                   |
| 3   | Consent shape                | One door + "Customize…" → Control Center                                                                                          | Delegated decision; fastest to yes without losing granularity                                                            |
| 4   | New users                    | Dedicated onboarding "power" stage                                                                                                | Unmissable, auditable, skip-safe (skip = supervised start)                                                               |
| 5   | Existing users               | Same door as a modal, once, on a new moments rail                                                                                 | Dorian: modal, not banner                                                                                                |
| 6   | Telemetry surface            | Second moment on the same rail; banner retired                                                                                    | Dorian: modal, not banner; rail generalizes                                                                              |
| 7   | Control Center               | Global flyout, persistent glyph, overrides list with deep links, "applies to new sessions" honesty                                | Delegated decision                                                                                                       |
| 8   | Colors                       | Green = unlocked/full power; ask = neutral with lock affordance; amber = divergence info; red = genuine alarms only               | Delegated; deviation from literal "red = not autonomous" recorded in design-decisions.md §6 — no shaming the safe choice |
| 9   | Config migration key         | `0.66.0` (next open key; `0.64.0`/`0.65.0` merged)                                                                                | Append-only migration rule                                                                                               |
| 10  | Open mesh for existing users | Flipped by door accept via the existing `PUT /api/mesh/topology/access` path (server-side equivalent), not a blanket Drizzle seed | A1: a data migration that opens every existing install's mesh without consent would be a silent flip                     |

**Recommended next step:** SPECIFY — freeze the behavior contract per flip (who writes what, when, for whom), the moments rail contract, the Control Center content list, and the color-token map; seed draft ADRs (one-door consent posture; moments rail; color economy).
