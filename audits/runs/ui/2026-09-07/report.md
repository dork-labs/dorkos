# UI audit — 2026-09-07 — `lens:tokens`

|                                            |                                                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Mode**                                   | `lens:tokens` — one lens, whole tree (`apps/client/src`)                                                                                                                                                                 |
| **Date**                                   | 2026-09-07                                                                                                                                                                                                               |
| **Commit**                                 | `222e41788`                                                                                                                                                                                                              |
| **Cost estimate, printed before spawning** | 1 lens × roughly 0.5M–1M subagent tokens. Actual: **230k**. A scoped run has no consent moment, so the estimate is recorded here instead.                                                                                |
| **Browser leg**                            | **Ran**, partially degraded (see Coverage gaps)                                                                                                                                                                          |
| **Lenses that did NOT run**                | `cva`, `dry`, `organization`, `dx`, `playground`, `copy`, `responsive`, `states`, `motion`, `clutter`, `componentize` — **eleven of twelve**. This report is a verdict on the app's design tokens, not on its interface. |

## Executive summary

The app's token system is in good shape and getting better. The two most serious problems the
September 2026 audit found are **fixed**: dead `border-<colour>` utilities (the cascade-layer
bug, DOR-1750) and the hand-typed tiny-text sweep, down from roughly 250 hand-written sizes to
one. A third — a bracket spelling of the icon-size tokens that produced no size at all — is gone
too, and the correct spelling is now in 150 places across 62 files. Five prior findings closed;
none reopened.

What is left is one shape repeated in different clothes: **a value the design system already
defines, spelled a second way by hand.** A shadow scale built to change between light and dark
that no overlay surface actually uses. A radius the app owns for one class name and rents from
Tailwind for the other five. A grey defined twice, once as HSL and once as hex. A status-colour
map copy-pasted into a second file. Eighty-nine files painting status with raw palette colours
and hand-written `dark:` pairs instead of the tokens that are already tuned for both themes.

**No P1.** That is a result rather than a gap, and it was tested rather than assumed: the one
candidate the previous run nominated for promotion to P1 was driven in a real browser and
**refuted** — the cascade defect is real, but on this platform it reserves no space and paints
nothing.

**Simplify-first scorecard: nine of eleven findings delete, merge, or correct a document.** Two
add something (one CSS token line, one radius ramp), and both of those retire hand-typed
literals in exchange. Nothing here proposes a new component or a new visual treatment.

## Stats

| Lens     | P1  | P2  | P3  | Total  |
| -------- | --- | --- | --- | ------ |
| `tokens` | 0   | 6   | 5   | **11** |

Effort mix: 2×M · 1×L · 8×S.

Findings before dedup: 11. After: 11 — a single-lens run has no cross-lens overlap to resolve,
so step 1 of synthesis was vacuous and this report was synthesized inline by the runner rather
than by a spawned synthesizer (skill §4).

## Verification note

**All 11 findings' citations were opened and checked** (the charter requires all of them at or
below twenty findings). Ten hold exactly as cited. One narrow correction:

- **F9** cited `use-session-border-state.ts:24-46` and `use-agent-hottest-status.ts:14-22`. The
  files and the duplication are exactly as described, but the line spans were off: the map lives
  at `:36-42` and `:15-21` respectively, with `:24-35` being the header comment the finding
  quotes. Narrowed in the raw file; the finding stands unchanged in substance.

One arithmetic error was corrected in the raw file's own summary line: it read "2×M, 9×S" for a
finding set containing an L. The per-finding severities were right; the total was not.

**Nothing was dropped.** No finding lacked a citation, relitigated a settled ADR, or fought the
design language. Three findings explicitly declined to relitigate settled decisions and said so:
the inline hex in `app-crash-fallback.tsx` (deliberate — it renders when CSS may not have
loaded), the RGB literals in `use-session-border-state.ts` (Motion cannot interpolate custom
properties, and the header explains it), and `responsive-dropdown-menu.tsx`'s `text-[13px]`
(sanctioned by name in `design-system.md:1088-1091`, which is why the F4 count came down from
the previous run's 12 to 11).

## What the browser leg settled

Four things no amount of code reading could have decided, and one of them reverses the previous
run:

1. **`scrollbar-none` does not work, and it is still not a P1.** The live chat transcript
   computes `scrollbar-width: thin` while asking for `none`, and a stylesheet walk names the
   mechanism. But measured reserved width for `auto`/`thin`/`none` on macOS Chromium is
   0px/0px/0px — overlay scrollbars, nothing paints at rest. The consequence is real and
   platform-conditional (the shipped Windows alpha and Linux reserve a gutter). **P2.**
2. **The elevation finding exists only because a browser ran.** Stock `shadow-*` is identical in
   both themes; the app's `--elevation-*` scale goes 0.04 → 0.5 alpha. Every overlay uses the
   theme-blind one.
3. **The phone type-ramp inversion is measured, not derived**: `text-2xs` renders 13.75px while
   `text-[13px]` stays 13px.
4. **`rounded` computes 8px, not 4px** — correcting the previous run's table and re-shaping that
   finding around what is actually wrong.

## Coverage gaps

Stated so no reader mistakes this for a complete picture:

- **Eleven of twelve lenses did not run.** This is a tokens verdict only.
- **The browser leg was partially degraded.** The client booted on its own port and every
  measurement here is `getComputedStyle` against the app's own stylesheet, which loads fully —
  but the operator's server rejected `http://localhost:6251` by CORS, so API-backed content was
  sparse and a "That didn't work" toast sat on every page. **Nothing that needed populated
  surfaces was audited at render time**; per-component palette use at runtime fell back to
  source sweeps.
- **Per-file severity for the 89 raw-palette files** was not established. The file and
  occurrence counts are exact; twenty files were opened.
- **`dev/showcases/*` was not audited** as a source of violations — fixtures, and lens 6 owns
  them.
- **A cold worktree does not boot the client on `@dorkos/shared` alone.** `@dorkos/marketplace`,
  `@dorkos/skills`, `@dorkos/extension-api` and `@dorkos/icons` dists are needed too. Recorded
  because the next browser leg will hit it.

## Batches

Grouped so two batches worked in parallel touch disjoint files. `apps/client/src/index.css` and
`contributing/design-system.md` are the collision hubs — most findings touch one or both — so the
first three batches are a **chain**, and the last two are parallel-safe against everything.

On a scoped run collision class beats batch size (skill §4), which is why B3 and B5 are
one-finding batches rather than being padded into their neighbours.

### B1 — Cascade, tokens, and the docs that describe them · **P2** · 6 findings · 1×M + 5×S

One PR over `index.css` and `contributing/design-system.md`, plus two single-line call sites.
Every finding here is a value or a rule that is written twice, or a doc that describes behavior
the app has never had.

|     | Finding                                                                                                                                                                                                                                                    | Sev/Eff |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| F1  | The unlayered `*` rule defeats `scrollbar-none` on the chat transcript; 65 unlayered blocks remain after DOR-1750 fixed one, and `[data-landed]` eats every `rounded-*` the same way. Fix layers the block **and deletes** the `bar-tab-strip` workaround. | P2/M    |
| F5  | Dark `--foreground` is 87% while `--sidebar-foreground` is 93% and the doc says 93% — chrome brighter than content.                                                                                                                                        | P2/S    |
| F6  | `rounded` and `rounded-lg` both paint 8px across 327 sites; `--radius` governs one rung and Tailwind's stock governs the other five.                                                                                                                       | P2/S    |
| F7  | `--nebula-edge` is `#e8e8e8` = `hsl(0 0% 91%)` = `--surface`, spelled twice.                                                                                                                                                                               | P3/S    |
| F8  | The one `scrollbar-gutter` site writes an arbitrary property where the doc names a first-party utility whose adoption is zero.                                                                                                                             | P3/S    |
| F11 | `design-system.md:131` states "all spacing values are multiples of 4px" against 1119 half-step utilities — fix the doc, not the code.                                                                                                                      | P3/S    |

**Files:** `apps/client/src/index.css`, `contributing/design-system.md`,
`layers/entities/agent/ui/PersonalityRadar.tsx`, `layers/shared/ui/page-container.tsx`.

### B2 — The two untokenised sizes on a sidebar row · **P2** · 2 findings · 2×S · **follows B1**

|     | Finding                                                                                                                                                               | Sev/Eff |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| F4  | `text-[13px]` in 11 shipped files: on a phone the label renders _smaller_ than the metadata beside it, and Settings → Appearance does not reach it. Add `--text-ctl`. | P2/S    |
| F10 | `size-[18px]` at 7 sites is the untokenised middle term of the sidebar's own documented `20 + 18 + 8 = 46` arithmetic. Add `--sidebar-glyph`.                         | P3/S    |

**Why it follows B1:** both add a token to the same `index.css` block B1 rewrites, and both edit
`design-system.md`. **Files:** `index.css`, `contributing/design-system.md`,
`layers/shared/ui/sidebar-row.tsx`, `sidebar.tsx`, `identity-avatar.tsx`, plus the
`dashboard-sidebar`, `inbox`, `feature-promos`, `slash-commands`, `inbox-bell` and `agent` call
sites.

### B3 — One elevation vocabulary, not two · **P2** · 1 finding · 1×M · **follows B2**

F2. A pure rename with zero geometry change — `shadow-sm/md/lg/xl` → `shadow-soft` /
`shadow-elevated` / `shadow-floating` / `shadow-modal` — starting with the eight overlay
primitives, then a lint rule so the two vocabularies cannot re-diverge.

**Why it follows B2:** both edit `layers/shared/ui/sidebar.tsx`. **Files:** ~24 primitives under
`layers/shared/ui/`.

### B4 — Status colour off the raw palette · **P2** · 1 finding · 1×L · **parallel-safe**

F3. 204 raw palette colours across 89 files and 136 hand-written `dark:` variants across 70,
sequenced by leverage: delete `category-colors.ts`, collapse the copy-pasted amber callouts into
the existing `Banner`, re-point `activity-types.ts` and `status-dot.ts`, and only then add the
lint rule. Wants its own spec — L.

**Files:** `layers/features/**` (relay, settings, marketplace, extensions),
`layers/entities/activity/model/activity-types.ts`, `layers/shared/ui/status-dot.ts`,
`layers/shared/ui/banner.tsx`. Disjoint from B1–B3.

### B5 — One copy of the session status colour map · **P3** · 1 finding · 1×S · **parallel-safe**

F9. The raw-RGB map is copy-pasted verbatim into `use-agent-hottest-status.ts` with none of the
reasoning that makes the original defensible. Export it once from the file that already owns the
type, delete the copy.

**Files:** `layers/entities/session/model/status/`. Disjoint from everything above.

## The promotion decision the operator now owes

Five batches were emitted to Linear as fenced work items, each `blockedBy` the run's
promotion-decision meta item. Nothing can be dispatched until that fence comes down. Per batch,
choose:

- **workflow path** — remove the blocking edge; the item enters the normal lifecycle and the
  audit never touches it again.
- **audit path** — `/ui-audit:execute` works the item while it stays blocked, and closes it on
  merge.

Close the meta item once every batch in this run is promoted or closed; otherwise it becomes the
stale ledger groom sweeps at.

## Emission record

Emitted to Linear team `DOR` through the `/flow` plugin's `linear-adapter` skill (`cli`
transport, `dorkos` account). Every item carries `source/audit` as provenance. **No `agent/*`
label was written.**

| Batch | Item                                                                     | Fence                |
| ----- | ------------------------------------------------------------------------ | -------------------- |
| —     | **DOR-1860** · `type/meta` · promotion decision for audit run 2026-09-07 | the blocker          |
| B1    | **DOR-1861** · cascade, tokens, and the docs that describe them          | `blockedBy` DOR-1860 |
| B2    | **DOR-1862** · the two untokenised sizes on a sidebar row                | `blockedBy` DOR-1860 |
| B3    | **DOR-1863** · one elevation vocabulary, not two                         | `blockedBy` DOR-1860 |
| B4    | **DOR-1864** · status colour off the raw palette                         | `blockedBy` DOR-1860 |
| B5    | **DOR-1865** · one copy of the session status colour map                 | `blockedBy` DOR-1860 |

**Fence verified by re-query**, in both directions: each batch item reports
`blockedBy DOR-1860` with DOR-1860 open, and DOR-1860 reports `blocks` all five.

## Gaps this run found in the audit's own texts

Recorded because the texts are meant to be followed exactly, and these three points are where
following them exactly was not possible.

1. **A missing profile blocks a real tracker emission, and the fallback hides it.**
   `/ui-audit:run` contract 2 says to proceed on the conservative fallback when `profile.md` is
   missing — which means _no tracker_, so the run would have silently written a markdown ledger
   instead of emitting to Linear, and _no browser leg_, which is what settled four findings here.
   Since the team and project "come from the profile, not from this file" (skill §5), a first run
   that is meant to emit for real must capture the profile first. This run wrote
   `audits/runs/ui/profile.md` by inferring from the repo, per `/ui-audit:init` contract 3.
   **Suggested text fix:** in `run.md` contract 2, add that a run intended to emit to a tracker
   captures the profile first rather than degrading to the ledger.

2. **`audit/claimed` is unconstructible on this tracker.** Skill §5 names it as the in-progress
   label, chosen specifically to avoid borrowing `agent/*`. But Linear enforces **team-wide**
   label-name uniqueness, and `claimed` already exists as `agent/claimed`, so
   `issueLabelCreate` refuses: _"Label 'claimed' already exists in team DorkOS."_ The same rule
   makes a leaf named `audit` and a group named `audit` mutually exclusive, so `source/audit` and
   an `audit/*` group cannot both exist either. **Resolved** by keeping `source/audit` exactly as
   the contract names it (it is the label this emission references) and creating
   **`ui-audit/in-progress`** for the execute-time signal. **Suggested text fix:** name the
   in-progress label `ui-audit/in-progress` in skill §5, and note the uniqueness rule beside the
   "create the labels first" bullet.

3. **The skill's Composio note needs one more trap.** `LINEAR_RUN_QUERY_OR_MUTATION`'s parameter
   is `query_or_mutation`, not `query` — passing `query` fails validation. Worth adding to the
   adapter's verified-schema list, which documents several traps of exactly this shape.
