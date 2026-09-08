---
slug: harness-sync-status
number: 260908-084301
created: 2026-09-08
status: ideation
---

# Harness Sync status — one status model, a real Skills page, and the drift banner

**Slug:** harness-sync-status
**Author:** specifier-1852 (DOR-1852)
**Date:** 2026-09-08

---

## 1) Intent & Assumptions

**Task brief.** Harness Sync has been shipping for months and has no screen. Everything a person can learn
about what DorkOS shares with which agent tool, they learn by running `dorkos harness sync --check` in a
terminal. The one surface that touches the same subject — the agent profile's **Skills** page — lists
marketplace `skill-pack` packages only, so a person with 31 authored skills, 13 of them in `.claude/skills`,
is told **"No skills installed."** That sentence is measured on this repository's own tree, not imagined.

This work builds the missing half:

1. **One read-only call** — `GET /api/harness/status?projectPath=…` — that answers, for every artifact and
   every enabled harness, which of eight states it is in.
2. **A real Skills page** on the agent profile, listing every skill (authored, installed, harness-native)
   with a chip per enabled harness, and the honest drop list as a **"Not shared with `<harness>`"** panel
   carrying each reason.
3. **A drift banner** with one action — `POST /api/harness/sync` — that disappears when the tree is clean.

It re-scopes the canceled DOR-144, which asked for two surfaces at once: a global settings matrix (per-harness
projection defaults, the `harness.autoSync` switch) and a per-repo status view. Only the second half is here.
The first half is a settings feature about config defaults; this is a status feature about one project, and
carrying both made DOR-144 too big to start for fourteen months.

**Assumptions.**

- The engine already computes almost all of this. `project()` gives the plan, `checkPlan()` gives the drift,
  `planWithConsent()` gives what consent withheld, `inventorySourceTree()` gives every authored artifact.
  Nothing here re-derives a harness's behaviour; it assembles four existing answers into one.
- The CLI is the reference renderer. Whatever the page says about an artifact, `dorkos harness sync --check`
  must be able to say the same thing about the same artifact. One model, two renderers — or the two drift and
  a person cannot tell which lied.
- **Adopt is report-only in v1** (contract §16 D3). The page shows a skill that lives where only some agents
  look; it offers no button that moves it. DOR-1853 owns the move, and D3 says the status surface must exist
  before the flag does.
- A projection is the person's business, not an agent's. The read is available to anyone who may see the
  project; the write is the person's.
- DOR-1851 (`notEnabled`, detection re-runs) and DOR-1854 (the project lock) are in review, not on `main`.
  This is written against them landing.

**Out of scope.**

- Adopt-by-move, and the `harness.autoAdopt` flag (DOR-1853).
- Global scope — `~/.dork/plugins`, `~/.claude/skills`, Claude Code's own `enabledPlugins` (DOR-1857).
- The DOR-144 global-settings half: a per-harness projection default, the `harness.autoSync` toggle, a
  target-selection matrix in Settings.
- Seeing and revoking `harness.approvedHooks` from the app (VC-05's app half). The CLI has
  `dorkos harness hooks --list|--revoke`; the app does not, and this does not add it.
- Turning a harness on from the app (`--enable`). The manifest is a committed, team-shared file and its
  write path stays the CLI's.
- Making the CLI read the new status model. The direction is recorded; the work is a follow-up.

## 2) Pre-reading Log

- `meta/harness-sync-capabilities.md` §11 (VC-01…VC-09), §10 (TR-08), §12 (J-01…J-15), §16 D3/D6 — the
  contract. VC-01 is the eight-state model and its verdict today is _"nothing assembles the eight into one
  answer"_. TR-08 ("a person asks from the app") is `not built`. D6 is the shape this spec implements.
- `plans/harness-sync-test-plan.md` §9 (T7) and §11 line 9 — the browser tier and this PR's place in the
  order. Line 10 (adopt) comes after line 9 _on purpose_: "a move with no screen to show it on is the
  strongest objection to adopt".
- `specs/harness-sync/02-specification.md` §"The Harnesses UI surface (DOR-137)" — the original promise: a
  `/harnesses` route, target toggles, a per-artifact status table, a drift banner, a "Not projected" panel
  ("Priya's honesty gate"). None of it shipped.
- DOR-144 (canceled) — the 2026-07-07 two-surface direction, and the reason this ticket only takes one.
- `packages/harness/src/plan/types.ts` — `ProjectionAction`, `ProjectionPlan`, `ProjectionWarning`,
  `DriftResult`. **`DriftResult` has five fields, not three**: `drifted`, `blocked`, `orphans`, `leftAlone`,
  `clean`.
- `packages/harness/src/apply/apply.ts` — `applyPlan` (returns `applied`, `conflicts`, `swept`, `leftAlone`)
  and `checkPlan`.
- `packages/harness/src/inventory/` — `inventorySourceTree`, `SourceInventory`, `SkillInventoryEntry.root`
  (`.agents/skills` | `.claude/skills`). The inventory deliberately excludes the engine's own output.
- `packages/harness/src/plan/source-artifacts.ts` — `planClaudeSkillsDirSkill`. Since DOR-1845 the plan
  **already** names every real skill directory in `.claude/skills`, per harness, asking `vendor-facts` which
  harnesses read that directory. This changed the design: `unmanaged` does not need a second reader.
- `apps/server/src/services/harness/project-with-consent.ts` — `planWithConsent` (read-only) and
  `projectWithConsent` (writes), the one seam; `__tests__/project-seam-guard.test.ts` holds the line.
- `apps/server/src/services/harness/hook-approval.ts` / `hook-consent.ts` / `auto-project.ts` — the card, the
  store, and the asking half of the install trigger.
- `packages/cli/src/harness-sync-command.ts` — `reportCheck` / `reportFix`: what the terminal prints today,
  which is the list the page has to be able to reproduce.
- `apps/client/src/layers/features/profile/ui/pages/SkillsPage.tsx` and
  `apps/client/src/layers/entities/marketplace/ui/SkillPacksList.tsx` — the page that exists and the list
  that says "No skills installed".
- `apps/client/src/layers/features/profile/model/use-managed-agent-facts.ts` — where the profile row's
  skill count comes from, and why it is read at the profile root.
- `apps/server/src/lib/boundary.ts` — `validateBoundary` vs `validateBoundaryOrDorkHome`, and the stated
  rule for choosing.
- `apps/server/src/routes/marketplace.ts` — `refuseUntrustedSourceWrite`, the person-only write pattern.
- `contributing/design-system.md` §Banners; `contributing/state-management.md`; `.claude/rules/fsd-layers.md`.
- `apps/e2e/tests/profile/profile-pushin.spec.ts` and `apps/e2e/pages/RightPanelPage.ts` — the fixture shape
  for driving a profile page.

## 3) Codebase Map

- **Primary modules.**
  - `packages/harness/` — the pure engine. Read, never changed by this work except for one copy fix.
  - `apps/server/src/services/harness/` — the seam (`project-with-consent.ts`), consent (`hook-consent.ts`),
    the card (`hook-approval.ts`), the install trigger (`auto-project.ts`). **The new status model lives
    here**, beside the seam.
  - `apps/server/src/routes/` — the new `harness.ts` router.
  - `packages/shared/src/` — the Zod response schema and the `Transport` methods.
  - `apps/client/src/layers/entities/harness/` — the new entity slice (hooks + presentational components).
  - `apps/client/src/layers/features/profile/ui/pages/SkillsPage.tsx` — the page that composes them.
- **Shared dependencies.** TanStack Query for the read and the mutation; shadcn/ui primitives; the
  `--status-*` design tokens; `HARNESS_LABELS` for every harness name a person reads.
- **Data flow.** disk → `planWithConsent` + `checkPlan` + `inventorySourceTree` → `buildHarnessStatus` →
  Zod-validated JSON → `Transport.getHarnessStatus` → TanStack Query → the Skills page.
- **Feature flags / config.** None new. `harness.autoSync` and `harness.approvedHooks` / `refusedHooks` are
  read, never written by the read path.
- **Blast radius.** The profile's Skills page and its row count; one deleted entity component; one new
  router; two new `Transport` methods (so the embedded Obsidian stub and the mock factory both grow one);
  `packages/shared`'s export map; `packages/harness/src/manifest/schema.ts` becomes a re-export of the
  harness vocabulary that moves into `@dorkos/shared`.

## 4) Root Cause Analysis

Not a bug fix. The closest thing to a root cause is a **process** one worth recording, because it is the
reason the gap survived fourteen months:

DOR-144 bundled a settings surface and a status surface into one ticket. The settings half needs config
migrations, a new `harness.targets` section and a Settings tab rename; the status half needs a read-only
route and a list. Neither could start without the other being designed, so neither started, and the spec's
"Priya's honesty gate" shipped as a paragraph. The lesson is in the scope cut, not in the code.

## 5) Research

### Where the eight states can come from

| State              | Source available today                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native`           | `plan.actions` with `kind: 'native'`                                                                                                                |
| `projected`        | `plan.actions` with `kind` in `symlink` / `scaffold` / `generate` / `merge`                                                                         |
| `drifted`          | `checkPlan().drifted`                                                                                                                               |
| `dropped`          | `plan.drops` (carries the reason)                                                                                                                   |
| `warned`           | `plan.warnings` (carries the reason)                                                                                                                |
| `conflict`         | `checkPlan().blocked`, and `applyPlan().conflicts` after a write                                                                                    |
| `pending-approval` | `planWithConsent().withheld`                                                                                                                        |
| `unmanaged`        | `inventorySourceTree().skills` where `root === '.claude/skills'`, minus what the manifest declares and minus what the canonical layer already holds |

Every one exists. Nothing assembles them, which is exactly VC-01's verdict.

### Three ways to assemble them, and why one wins

1. **In `packages/harness`, beside `checkPlan`.** The obvious home, and wrong. Two of the eight states —
   `pending-approval` and, after a write, `conflict` — need consent, and `hook-approval.ts` states the reason
   the engine may not have it: _"That package is a pure projection engine with no approval primitive and no
   config store, and dragging both into it for one call site would be an architectural regression."_
2. **In the route.** Cheapest to write, and it guarantees the CLI can never share it — which is the exact
   failure the contract's VC-01 row describes, arriving a second time.
3. **In `apps/server/src/services/harness/status.ts`, beside the consent seam.** It can read consent, it is
   not the engine, and it is a plain function over an options bag, so the CLI can call it later by passing
   the decisions it reads off disk. **Chosen.**

### One page or two

The original spec wanted a `/harnesses` route with target toggles. The ticket puts the status on the agent
profile's existing Skills page instead. That is the better call and not only a scope cut: a person asks
"what can this agent do?" about **an agent**, and the profile is where they already are. A `/harnesses`
route would be a second place to look for the same fact, and the target toggles that justified a page of its
own are the DOR-144 half being cut.

### What the drift banner may promise

`POST /api/harness/sync` fixes drift and orphans. It does **not** fix a conflict (a file DorkOS does not
own is in the way) and it does **not** fix an adoptable skill (D3 says report-only). A single banner that
always offers "Sync now" would therefore promise a fix it cannot deliver two times out of three. The banner
has to pick its message from the condition and show the action only when the action changes something.

## 6) Decisions

Resolved during ideation; the specification's §Decisions carries the ones the design itself surfaced.

| #   | Decision                                   | Choice                                                                 | Rationale                                                                                                                                                     |
| --- | ------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Which half of DOR-144 to build             | The per-repo status half only                                          | The settings half needs config work with its own migration and blast radius; bundling them is why nothing shipped.                                            |
| 2   | Where the status is shown                  | The agent profile's existing Skills page, not a new `/harnesses` route | People ask this question about an agent, and the profile is where they already are. A second place to look for the same fact is a cost, not a feature.        |
| 3   | Where the model is assembled               | `apps/server/src/services/harness/status.ts`                           | Two of the eight states need consent, which the engine deliberately has no primitive for; the route would fork the model on the day the CLI wants it.         |
| 4   | Whether adopt gets a button                | No — report only                                                       | Contract §16 D3. A move is one-way and unrevocable, and DOR-1853 owns it after this ships.                                                                    |
| 5   | Whether the banner always offers an action | No — the action appears only when a sync would change something        | Drift and orphans are fixable by the button; conflicts and adoptable skills are not. Offering the button anyway is a lie the person discovers by clicking it. |
| 6   | Who may trigger a sync                     | A person, not an agent                                                 | It writes into the person's project, including a sweep. Agents already get projection automatically on install; nothing they need is behind this button.      |
