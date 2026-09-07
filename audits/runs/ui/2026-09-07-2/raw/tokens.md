# `tokens` — diff-scoped — 2026-09-07 (run 2) pulse

Lens 1, **Tokens & consistency**. Surface-local, so this run is **diff-scoped** per its own
stamp: `222e41788..e849895e4`.

## Coverage

**Prior run read:** `audits/runs/ui/2026-09-07/raw/tokens.md` and its `report.md` (charter
validity rule 7). That run was `lens:tokens` whole-tree at `222e41788`, and its eleven findings
are filed as DOR-1861..DOR-1865. Nothing here restates them; they are **re-measured** below.

**Diff base:** `222e41788` (this lens's own `lastAuditedCommit`), not a global stamp.

**What changed:** 4 commits, of which one touches `apps/client/src` — `48113d455`
(DOR-924, the link-safety seam). 15 non-test client files, +810/-38 across the whole commit.
Every one was read: one new shared primitive (`external-link-anchor.tsx`), one new shared lib
export (`internalRoutePath`), and eleven call sites swapping a bare `<a target="_blank">` for the
new primitive. The other three commits are `chore(release)` and two `docs(audits)`; they touch no
client source.

**Sweeps run over the changed files:** arbitrary px/rem values, raw hex, `rgb(`/`hsl(`
literals, and hand-written `dark:` pairs. One sweep was then widened to the whole tree to size
F12 honestly (see its note) rather than reporting a count true only of the diff.

**Browser leg: ran, partially degraded.** Client booted on `:6251` from this worktree per the
profile. `getComputedStyle` measurement is sound (the app's own stylesheet loads fully) and is
what settled F12. But the operator's server on `:6242` refuses this origin —
`[WSConnection] the server refused this stream with 403 … Origin not trusted` plus 500s on the
extension bundles — so API-backed content was sparse again, exactly as the 2026-09-07 run
recorded. **Nothing needing populated surfaces was audited at render time.** This is the same
known degrade, not a new one.

**Not reached:** `dev/showcases/*` as a source of violations (fixtures; lens 6 owns them).
Per-file severity for the raw-palette sites in the changed files was not re-established — they
are DOR-1864's, and are refreshed rather than re-audited.

## Aging the filed findings (pulse contract 4)

Every citation behind DOR-1861..DOR-1865 was re-checked against `e849895e4`. **Nothing moved,
nothing disappeared, no item is a closure candidate.** Re-measured counts:

| Item     | Cited                                                                                                                    | Now                                                                                                           | Verdict          |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------- |
| DOR-1861 | `index.css` unlayered blocks, `[data-slot='bar-tab-strip']`, `--nebula-edge`, dark `--foreground`/`--sidebar-foreground` | all present: `index.css:861`, `:464`, `:494`, `:590`                                                          | holds unchanged  |
| DOR-1862 | `text-[13px]` in 11 shipped files; `size-[18px]` at 7 sites                                                              | 14 files total = 11 shipped + 2 showcase fixtures + 1 sanctioned; `size-[18px]` = 13 sites, 7 of them shipped | **counts exact** |
| DOR-1863 | `shadow-sm/md/lg/xl` across the shared primitives                                                                        | 11 files in `layers/shared/ui/` still on the stock scale                                                      | holds unchanged  |
| DOR-1864 | 89 files on the raw palette                                                                                              | `relay/lib/category-colors.ts`, `activity-types.ts`, `status-dot.ts` all present                              | holds, see below |
| DOR-1865 | duplicate status map in `entities/session/model/status/`                                                                 | both files present                                                                                            | holds unchanged  |

**One refresh worth writing back to the tracker.** DOR-924 edited three files inside DOR-1864's
stated scope — `features/relay/ui/wizard/ConfigureStep.tsx`,
`features/marketplace/ui/PackageDetailSheet.tsx`, `entities/agent/ui/McpSigninBody.tsx` — but
touched only their imports and their anchor elements. The raw-palette lines survive verbatim
(`ConfigureStep.tsx:70` `border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800
dark:bg-blue-950 dark:text-blue-200`; `PackageDetailSheet.tsx:172` amber, `:258` emerald;
`McpSigninBody.tsx:85` green). DOR-1864's L-sized sweep will now rebase over DOR-924, and its
file list is unchanged.

DOR-1862's re-measure is the one that could have looked like drift and is not: the previous
run's "11 shipped files" and "7 sites" are both still exactly right, and `git grep` at
`222e41788` returns the identical `size-[18px]` distribution. Reported so the next pulse does not
re-derive it.

## Findings

### F12 — 44px is spelled twice, in the file that says it is spelled once

- **lens:** `tokens`
- **severity:** P3
- **effort:** S
- **files:**
  - `apps/client/src/layers/shared/ui/touch-target.ts:26` (the constant, `min-h-11`)
  - `apps/client/src/layers/features/activity-feed-page/ui/ActivityRow.tsx:137`
  - `apps/client/src/layers/shared/ui/responsive-dropdown-menu.tsx:279`
  - `apps/client/src/layers/shared/ui/responsive-dropdown-menu.tsx:346`
  - `apps/client/src/layers/shared/ui/responsive-context-menu.tsx:290`
  - `apps/client/src/layers/shared/ui/navigation-layout.tsx:336`
  - `apps/client/src/layers/features/chat/ui/message/MemoryRecallBlock.tsx:132`
  - `apps/client/src/layers/features/chat/ui/message/MemoryRecallBlock.tsx:151`
  - `contributing/design-system.md:1156`
  - `contributing/design-system.md:1088`

- **evidence:** `touch-target.ts` exports `TOUCH_TARGET_MIN_H = 'min-h-11'`, and its own TSDoc
  states the rule as _"The smallest a control may be under a thumb, **spelled once**."_ It is not
  spelled once. Seven shipped sites write the arbitrary `min-h-[44px]` instead, and **four of
  those seven are inside `layers/shared/ui/` itself** — the directory that owns the constant.
  Ten files import `TOUCH_TARGET_MIN_H`; the sidebar slice uses it and the menu primitives do
  not, so two sibling primitives express one number two ways.

  **Measured in a real browser, both widths:** `min-h-[44px]` and `min-h-11` compute
  `min-height: 44px` at 1440×900 and at 390×844. There is **zero** behavioral difference — this
  is duplication with no cost and no excuse, which is what makes the collapse mechanical and
  safe rather than a rendering risk.

  `design-system.md` is why it drifted, and is half the fix: line 1088 lists `min-h-[44px]` as
  _the_ touch-target spelling, and line 1156 blesses **both** — _"rows use `min-h-11` /
  `min-h-[44px]`"_. A doc that offers two spellings of one value is a doc that guarantees two
  spellings in the tree. This is the same shape the 2026-09-07 report named as the run's single
  theme ("a value the design system already defines, spelled a second way by hand") and the same
  shape as its F6 (`rounded`/`rounded-lg`) and F11 (fix the doc, not the code) — but a different
  value, a different doc line, and different call sites, so it is not covered by DOR-1861 or
  DOR-1862.

- **recommendation:** Replace all seven shipped `min-h-[44px]` with `TOUCH_TARGET_MIN_H`, then
  correct `design-system.md:1088` and `:1156` to name the constant as the one spelling. Deletes
  a second vocabulary rather than adding anything. Leave the `dev/showcases/*` occurrences and
  the `MemoryRecallBlock` test assertion to follow their source. Simplify-first: **removes**.

- **scope note, stated because it matters:** the finding was surfaced from `ActivityRow.tsx:137`,
  which **is** inside this pulse's diff, and then sized by a whole-tree ripgrep so the count is
  honest. The 2026-09-07 whole-tree tokens run did not file it. Reporting it sized to one site
  would have been the misleading choice.

## Summary

**1 new finding** (P3/S). **5 filed items refreshed**, none aged out, zero stale citations. No
P1 and no P2 in a four-commit diff whose only client change is a security seam — that is the
expected shape of a healthy pulse, not a coverage gap.
