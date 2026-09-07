# Lens 1 — Tokens & consistency (`tokens`)

Run: 2026-09-07 · scope `lens:tokens`, whole tree (`apps/client/src`) · commit `222e41788`
· **browser leg ran** (own client on :6251, Chromium/macOS, 1440x900 and 390x844).

## Coverage

### Source of truth, read in full

- `apps/client/src/index.css` — all 2113 lines: the cascade-layer pin and its 33-line
  postmortem, `@theme inline`, the `:root`/`.light` and `.dark` palettes, every `@utility`,
  all ~40 keyframes, the desktop shell block, the touch-chip block, the reduced-motion resets
  and the Obsidian bridge.
- `contributing/design-system.md` §Color, §Typography, §Spacing (both spatial modes),
  §Scrollbars, §Icon Size Convention, §Mobile Sizing (Apple HIG), §The-three-geometry-tokens;
  `audits/ui.md`, `audits/README.md`; `.agents/skills/auditing-ui/SKILL.md` §3.
- Tailwind 4.3.3's own `dist/lib.js` to confirm which `scrollbar-*` utilities exist.

### Prior runs read (validity rule 7)

Two, both read before any sweep:

1. **`plans/ui-ux-audit-202609/raw/tokens.md`** — the September 2026 run.
2. **The 2026-09-07 uncommitted validation (dry) run**, at
   `scratchpad/phase3-dryrun/raw-tokens.md`. It was a dry run against an earlier commit of
   `main`, never committed; 8 findings (0 P1 / 5 P2 / 3 P3).

**Closed since those runs, verified by sweep or by browser:**

| Prior finding                                                   | Status now                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sept F1 — `border-<colour>` dead on 63 files                    | **Closed.** `index.css:814-818` is layered (`border-defaults`); DOR-1750/DOR-1024.                                                                                                                                                                                          |
| Sept F2 — `text-[10px]`/`[11px]` on ~150 files                  | **Closed.** Sweep now finds **1** `text-[10px]` and **0** `text-[11px]` outside `dev/`.                                                                                                                                                                                     |
| Sept F3 — `size-[--size-icon-*]` unadopted (2 files)            | **Closed, and it was worse than "unadopted".** The v3 bracket spelling produced _no size at all_ (I measured `size-[--size-icon-sm]` → the host's 400px, vs `size-(--size-icon-sm)` → 16px). Zero bracket sites remain; the paren form is now **150 uses across 62 files**. |
| Sept F6 — terminal hardcodes its font stack                     | **Closed.** `TerminalInstance.tsx:135` reads `readTerminalFontFamily(container)`.                                                                                                                                                                                           |
| Sept F9 — `text-[12px]` in `NewMenu.tsx`                        | **Closed.** Zero `text-[12px]` outside `dev/`.                                                                                                                                                                                                                              |
| Dry-run F2 — `text-[13px]` in 12 files                          | **Open, re-measured** → F4 below.                                                                                                                                                                                                                                           |
| Dry-run F3 — 90 files on raw palette                            | **Open, re-measured** → F3 below.                                                                                                                                                                                                                                           |
| Dry-run F4 — dark `--foreground` drift                          | **Open, confirmed at runtime** → F5 below.                                                                                                                                                                                                                                  |
| Dry-run F5 — `--radius` "resolves to itself, generates nothing" | **Open but its mechanism is REFUTED by measurement** → F6 below.                                                                                                                                                                                                            |
| Dry-run F1 — unlayered `*` scrollbar rule                       | **Open, adjudicated in the browser** → F1 below.                                                                                                                                                                                                                            |

### The browser leg

Booted `@dorkos/client` on `:6251` proxying `/api` to the operator's server on `:6242`
(`:6241`/`:6242`/`:4242` untouched; my process stopped by PID at the end). The dev server
needed `@dorkos/marketplace`, `@dorkos/skills`, `@dorkos/extension-api` and `@dorkos/icons`
dists built before it would serve — worth recording, since a cold worktree does not boot a
client on `@dorkos/shared` alone.

Driven by a standalone Playwright script (four passes), screenshots at 1440x900 and 390x844
read back. Six routes visited (`/`, `/activity`, `/team`, `/tasks`, `/marketplace`,
`/connections`), no mutating clicks. **Partial degradation, stated plainly:** the operator's
server rejects `http://localhost:6251` by CORS, so API-backed content is sparse and a
"That didn't work" toast sits on every page. This does not touch this lens — every
measurement below is `getComputedStyle` on the app's own stylesheet, which loads and applies
fully. What it does cost is any finding that needed _populated_ surfaces, so I did not audit
per-component palette use at render time and relied on source sweeps for that (F3).

What the browser settled, and could not have been settled any other way:

- `scrollbar-none` computes `thin` on the live chat transcript — F1, and **the P1 upgrade the
  dry run predicted is refuted**, with the measurement that refutes it.
- Stock `shadow-*` is byte-identical in both themes while the app's `--elevation-*` scale is
  theme-split 0.04 → 0.5 — F2, entirely new, and the class of thing only a browser adjudicates.
- On a phone, `text-2xs` renders 13.75px while `text-[13px]` stays 13px — the ramp inversion
  in F4 is now measured, not arithmetic.
- `rounded` computes **8px**, not the 0.25rem the dry run's table asserted — F6 corrected.

### Scripted sweeps run to exhaustion (all `*.tsx`/`*.ts` under `apps/client/src`, excluding `__tests__`, `*.test.*`, `dev/`)

Arbitrary-bracket utilities by prefix (24 distinct prefixes, ranked); `text-[Npx]` histogram;
raw 6-digit hex (33 files, then by file); `hsl(`/`rgb(` numeric literals; raw Tailwind palette
colour utilities across 20 hues × 14 utility prefixes; hand-written `dark:` variants;
`rounded-*` histogram; `shadow-*` histogram; half-step spacing utilities; `fontFamily` in JS;
`size-icon` adoption; every `scrollbar-*` utility; `[--var]` bracket references. Every sweep's
hits were opened at the hit lines.

Files opened at their hit lines: `index.css`, `Timeline.tsx`, `page-container.tsx`,
`status-dot.ts`, `category-colors.ts`, `ServerTab.tsx`, `DeadLetterSection.tsx`,
`activity-types.ts`, `sidebar-row.tsx`, `sidebar.tsx`, `identity-avatar.tsx`,
`responsive-dropdown-menu.tsx`, `SidebarSearchPill.tsx`, `SidebarHeaderBlock.tsx`,
`SidebarFooterMenu.tsx`, `TodayZone.tsx`, `SessionSwitcher.tsx`, `AllClearBeat.tsx`,
`PromoCard.tsx`, `InboxRow.tsx`, `InboxBell.tsx`, `AgentIdentity.tsx`, `SlashCommandList.tsx`,
`PersonalityRadar.tsx`, `app-crash-fallback.tsx`, `use-session-border-state.ts`,
`use-agent-hottest-status.ts`, plus the 24 `shared/ui` primitives the shadow sweep surfaced.

**Prior art checked so nothing is relitigated:** `decisions/` and `research/` grepped for
cascade layers, elevation, radius and scrollbars — nothing settles any finding here.
`research/20260310_hide_scrollbars_when_idle.md` and
`research/20260323_css_library_compatibility_vite_tailwind_v4.md` read for relevance.
`changelog/unreleased/260903-204940-b04-tokens-that-dont-paint.md` read (the DOR-1750 batch).

### Explicitly skipped

- **`dev/showcases/*` as a source of violations.** Fixtures, not shipped surfaces. Lens 6 owns
  it. (Two of the 14 `text-[13px]` hits and one `text-[10px]` hit live there and are excluded
  from every count below.)
- **Per-file severity for the 89 raw-palette files.** Counted exactly; twenty opened. F3's
  file and occurrence counts are exact; its per-file severity is not.
- **`app-crash-fallback.tsx`'s 10 raw hex values.** Read and deliberately not filed: it is the
  fallback rendered when the app's own CSS may not have loaded, so inline literals are the
  point.
- **`use-session-border-state.ts`'s choice of RGB literals over tokens.** Its header explains
  that Motion cannot interpolate custom properties. Not relitigated; only the _duplication_ is
  filed (F9).
- **`apps/site` and `apps/obsidian-plugin`** — out of charter scope. The Obsidian bridge block
  inside `index.css` is in scope and is clean.

---

### [P2/M] The unlayered `*` scrollbar rule still defeats `scrollbar-none` — confirmed in the browser, and it stays P2 because the platform this ran on reserves no space for it

**Files.** `apps/client/src/index.css:34` (the layer pin), `:834-837` (the `*` rule),
`:861-866` (a workaround for it), `:1843-1846` (`[data-landed]`), `:1860-1927`
(`.msg-assistant`); `layers/features/conversation/ui/Timeline.tsx:519`;
`contributing/design-system.md:320-323`.

**Evidence — measured, not inferred.** On the live app at 1440x900, the chat transcript
element `.chat-scroll-area h-full scrollbar-none overflow-y-auto` (`Timeline.tsx:519`), with
`scrollHeight 1456 > clientHeight 658` so genuinely scrolling, computes:

```
scrollbar-width: thin
scrollbar-color: rgb(64, 64, 64) rgba(0, 0, 0, 0)
```

A walk of `document.styleSheets` names the mechanism exactly: `.scrollbar-none {
scrollbar-width: none }` sits in `@layer utilities`, and `* { scrollbar-width: … }` is
`(unlayered)`. An unlayered rule outranks every layer, so the utility loses. This is the same
defect DOR-1750 wrote 33 lines of postmortem about at the top of this file; that fix moved one
rule into a layer and left the rest. **65 unlayered top-level blocks remain**, and two of them
demonstrably eat a utility: this one, and `[data-landed='true']` at `:1843`, which sets
`border-radius: var(--radius)` unlayered so no `rounded-*` class can change a landed row's
corner.

The workaround is already spreading rather than the cause being fixed — `index.css:854` says
of the rule below it: _"Declared here rather than as a utility class on the element because
the `*` rule above is unlayered and would win against one."_

`design-system.md:322-323` calls `scrollbar-none` "the sanctioned surface" and tells authors
to "reach for `scrollbar-thin` only to re-thin something after overriding". Neither sentence is
true today: there is exactly **one** `scrollbar-none` site in the tree and it does not work,
and there are **zero** `scrollbar-thin` sites, because nothing has ever successfully overridden
the global.

**Why it stays P2 — the dry run predicted P1 and I am refuting it.** The dry run said this
"would earn P1 if a browser leg confirms a scrollbar painting in the chat transcript." The
browser confirms the _cascade_ but not the _paint_. I measured reserved scrollbar width on this
platform for a forced-scroll probe: `auto` 0px, `thin` 0px, `none` 0px, `thin` + explicit
`scrollbar-color` 0px. macOS Chromium uses overlay scrollbars, so `thin` costs no layout and
shows no bar at rest — the desktop screenshot shows a clean transcript edge. The consequence is
real but platform-conditional: on classic-scrollbar platforms (the **shipped Windows alpha**,
Linux) `thin` reserves a permanent gutter where `none` reserves nothing, and the transcript's
own `scrollbar-color` paints a thumb. That is a quality gap a Priya-grade engineer flags, not
something visibly broken to a new user on the platform I could observe. P2.

**Recommendation.** Wrap the unlayered property-declaring blocks below line 820 in one
`@layer base { … }` — `html`, `body`, `*`, `[data-landed]` and the `.msg-assistant` group —
leaving `border-defaults` exactly where it is. Then **delete** the `[data-slot='bar-tab-strip']`
workaround at `:861-866`, because the strip's own class starts working; that deletion is the
simplification this buys. Fix `design-system.md:323` in the same edit, since it currently
describes behaviour the app has never had. Guard it the way DOR-1750 was guarded: one assertion
that a `scrollbar-none` element computes `scrollbar-width: none`.

---

### [P2/M] The app has two elevation vocabularies with identical geometry, and the one every overlay surface actually uses is the one that does not change between light and dark

**Files.** `apps/client/src/index.css:454-461` (light `--elevation-*`), `:576-580` (dark),
`:617-651` (the four `@utility` wrappers); `layers/shared/ui/dialog.tsx:111`,
`alert-dialog.tsx:82`, `sheet.tsx:70`, `popover.tsx:30`, `hover-card.tsx:45`,
`dropdown-menu.tsx:65,225`, `select.tsx:59,85`, `context-menu.tsx:101,124`,
`sidebar.tsx:243,309`, `input.tsx:31`, `textarea.tsx:19`, `button.tsx:36`, `checkbox.tsx:43`,
`radio-group.tsx:51`, `slider.tsx:57`, `switch.tsx:85,87`, `path-input.tsx:52`.

**Evidence — measured in both themes on the running app.** The app defines a four-step
elevation scale and splits it per theme on purpose; `index.css:456-457` says why: _"Light mode
uses low-alpha shadows so panels lift gently against the near-white background"_, and the dark
block re-states it as _"stronger alpha so shadows read on the near-black surfaces."_ The
sibling comment at `:478-482` puts the principle plainly: _"a shadow is light falling on a
surface, and the same black that reads as a soft edge on a light panel disappears entirely on
a dark one."_

Read back from the browser, light → dark:

| class             | light                        | dark                        | theme-aware? |
| ----------------- | ---------------------------- | --------------------------- | ------------ |
| `shadow-soft`     | `rgba(0,0,0,0.04) 0 1px 3px` | `rgba(0,0,0,0.5) 0 1px 3px` | yes          |
| `shadow-elevated` | `0.05 · 0 4px 6px`           | `0.5 · 0 4px 6px`           | yes          |
| `shadow-floating` | `0.06 · 0 10px 15px`         | `0.5 · 0 10px 15px`         | yes          |
| `shadow-modal`    | `0.07 · 0 20px 25px`         | `0.5 · 0 20px 25px`         | yes          |
| `shadow-sm`       | `0.1 · 0 1px 3px`            | `0.1 · 0 1px 3px`           | **no**       |
| `shadow-md`       | `0.1 · 0 4px 6px`            | `0.1 · 0 4px 6px`           | **no**       |
| `shadow-lg`       | `0.1 · 0 10px 15px`          | `0.1 · 0 10px 15px`         | **no**       |
| `shadow-xl`       | `0.1 · 0 20px 25px`          | `0.1 · 0 20px 25px`         | **no**       |

Two things fall out. First, **the geometry is pairwise identical** — `sm`≡`soft`,
`md`≡`elevated`, `lg`≡`floating`, `xl`≡`modal`, offset for offset and blur for blur — so the
app's scale is Tailwind's stock geometry with the alpha made theme-aware. Second, the split by
usage is backwards: **75 stock hits against 31 app-token hits**, and _every_ overlay
surface — dialog, alert dialog, sheet, popover, hover card, dropdown, select, context menu — is
on the stock side. `shadow-modal` has exactly **one** call site in the tree and it is not the
dialog.

The visible result, in the dark screenshot: the modal on `/` is separated from a `0 0% 4%`
page by its 1px border and nothing else. A `rgba(0,0,0,0.1)` shadow on a near-black background
is not a shadow.

**Why it falls short.** This is light-and-dark drift, lens 1's own clause, in the exact shape
the file's own comments predict and warn about. It is also two vocabularies for one idea,
which the Quality Standard rules out on its own.

**Recommendation.** A pure rename with **zero geometry change**, which is why this is M and not
L: `shadow-xs`/`shadow-sm` → `shadow-soft`, `shadow-md` → `shadow-elevated`, `shadow-lg` →
`shadow-floating`, `shadow-xl` → `shadow-modal`. Start with the eight overlay primitives in
`shared/ui`, which is where the dark-mode loss is visible and where one edit reaches every
consumer. Then delete Tailwind's stock shadow scale from reach with a lint rule, so the two
vocabularies cannot re-diverge. (`shadow-xs` maps to `soft` rather than getting a fifth step:
one fewer rung is the better answer.)

---

### [P2/L] 204 raw Tailwind palette colours across 89 files, and 136 hand-written `dark:` variants across 70, re-derive by hand what `--status-*` and `--package-*` already calibrate for both themes and for Obsidian

**Files.** Worst first, all opened at their hit lines:
`layers/features/settings/ui/ServerTab.tsx:59-63,73-81,295-303` (11 hits, 11 `dark:`);
`layers/features/relay/ui/DeadLetterSection.tsx:36,62-64,171-172` (8 / 7);
`layers/entities/activity/model/activity-types.ts:41-44,74` (7);
`layers/features/relay/ui/AdapterEventLog.tsx` (6 / 6);
`layers/features/marketplace/ui/MarketplaceSidebar.tsx` (6);
`layers/shared/ui/status-dot.ts` (5, in `shared/ui` itself);
`layers/features/relay/lib/category-colors.ts:3-6` (4 / 4);
`layers/features/relay/ui/wizard/TestStep.tsx`, `layers/features/extensions/ui/ExtensionCard.tsx` (5 each).
Tokens at `index.css:260-297` (light), `:515-541` (dark), `:299-332` and `:543-567`
(`--package-*`), `:2064-2108` (the Obsidian bridge).

**Evidence.** Re-measured against the dry run's 90 files: **89 files, 204 occurrences**,
essentially unmoved, plus **136 `dark:` variants across 70 files** which the dry run did not
count. The leading spellings: `text-amber-400` (28), `text-amber-500` (24), `text-amber-700`
(19), `text-amber-600` (16), `text-green-500` (14), `text-red-500` (13), `bg-amber-500` (13),
`text-emerald-500` (10) — green and emerald still both in service for one meaning.

`ServerTab.tsx:59` is
`border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30`, with
`text-amber-800 dark:text-amber-200` on the label and `text-amber-700 dark:text-amber-300` on
the body: five hand-picked steps and four hand-written `dark:` variants reproducing exactly
what `--status-warning-bg` / `-border` / `-fg` already are, in one class each, already tuned
per theme, and already bridged into Obsidian at `index.css:2072-2075` — where the raw-palette
version simply does not follow. The identical block is copy-pasted at `:73` and `:295`.

`category-colors.ts` is the clearest single fix in the set, and the cheapest:

```ts
messaging:  'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
automation: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
internal:   'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200',
custom:     'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
```

That is a "which KIND of thing is this" map — precisely what `--package-*` was created for.
`index.css:299-309` even writes the rationale for not doing what this file does: _"Written down
here rather than as `bg-blue-500/10` at the call site because a 10%-alpha blue over a
near-white page and over a near-black one are two different colours, and only one of them was
ever chosen."_

`status-dot.ts` is the codebase's own record of the bug — _"four spellings of one fact"_ — and
it still carries five raw palette hits itself.

**Why it falls short.** `design-system.md` §Separation-by-tint is explicit that status colour
stays on the semantic tokens. A hand-written `dark:` pair is a second, undocumented theme
definition nobody re-checks when the palette moves, and it never reaches the Obsidian bridge.

**Recommendation.** A sweep, hence L, sequenced by leverage: **(a)** delete
`category-colors.ts` outright and point adapter badges at `--package-*` — four lines and four
`dark:` pairs gone in one edit; **(b)** collapse the three copy-pasted amber callouts in
`ServerTab.tsx` into the existing `shared/ui/banner.tsx` primitive, and do the same for
`DeadLetterSection.tsx:62,171` — every hand-written `dark:` variant in both files disappears as
a side effect; **(c)** re-point `activity-types.ts` and `status-dot.ts`'s own five hits at the
token families; **(d)** only once the count is near zero, add the ESLint rule banning raw
palette colour utilities outside `dev/`. Step (d) before (a)–(c) buys 89 disable comments.

---

### [P2/S] `text-[13px]` is a hand-typed literal in 11 shipped files, and on a phone it renders _smaller_ than the metadata beside it — measured

**Files.** `layers/shared/ui/sidebar-row.tsx:145`;
`layers/features/dashboard-sidebar/ui/SidebarSearchPill.tsx:38`, `SidebarFooterMenu.tsx:54`,
`SidebarHeaderBlock.tsx:153`, `AllClearBeat.tsx:23`, `SessionSwitcher.tsx:322`,
`TodayZone.tsx:182`; `layers/features/feature-promos/ui/PromoCard.tsx:87`;
`layers/features/slash-commands/ui/SlashCommandList.tsx:104`;
`layers/widgets/inbox-bell/ui/InboxBell.tsx:448`; `layers/entities/agent/ui/AgentIdentity.tsx:43`.
Tokens at `index.css:113-121`; the doc's own claim at `contributing/design-system.md:140`.

**Evidence.** Measured on the running app at 390x844, where `--_st` is `1.25`:

| class         | desktop | phone       |
| ------------- | ------- | ----------- |
| `text-3xs`    | 10px    | **12.5px**  |
| `text-2xs`    | 11px    | **13.75px** |
| `text-xs`     | 12px    | **15px**    |
| `text-[13px]` | 13px    | **13px**    |

Two consequences, now observed rather than derived. **The ramp inverts on a phone:** a
sidebar row's _label_ (`sidebar-row.tsx:145`, the row every channel, DM and agent draws
through) renders at 13px while `text-2xs` metadata beside it renders at 13.75px. And
**Settings → Appearance stops working on these labels** — `--user-font-scale` multiplies every
token-sized string and none of these. On the desktop home screen the live DOM carries 16
elements with this class.

The dry run counted 12 files. **`responsive-dropdown-menu.tsx:28` comes off the list**:
`design-system.md:1088-1091` sanctions it by name as the Apple-HIG pair (`text-[17px]` label /
`text-[13px]` footnote), and it is the only site of the two that is documented. Eleven remain,
none of which carries a comment.

`design-system.md:140` is the root cause: its control-surface column reads "**13px label**,
`text-2xs` (11px) metadata" — one cell names a token, the other names a number. A documented
size with no token is a size that keeps getting typed by hand.

**Why it falls short.** The design system advertises a responsive type contract and a user
font-scale setting, and the app's densest, most-repeated label size is the one rung exempt from
both.

**Recommendation.** One CSS line and a mechanical replace: add
`--text-ctl: calc(0.8125rem * var(--_st) * var(--user-font-scale, 1))` beside its siblings at
`index.css:113`, sweep the eleven sites to `text-ctl`, and change `design-system.md:140` to
name the token instead of the number. Start with `sidebar-row.tsx` — it propagates to every
row in the panel. Leave `responsive-dropdown-menu.tsx` alone; it is the documented exception
and should stay one.

---

### [P2/S] In dark mode the chrome is brighter than the content it frames, and neither value matches the documented one

**Files.** `apps/client/src/index.css:494` (`--foreground: 0 0% 87%`), `:590`
(`--sidebar-foreground: 0 0% 93%`), `:496,498,502,506` (`--card-foreground`,
`--popover-foreground`, `--secondary-foreground`, `--accent-foreground`, all 87%);
`contributing/design-system.md:64`.

**Evidence.** Read back off the live document in both themes:

|                        | light (measured) | dark (measured) | documented dark |
| ---------------------- | ---------------- | --------------- | --------------- |
| `--foreground`         | `0 0% 9%`        | `0 0% 87%`      | `0 0% 93%`      |
| `--sidebar-foreground` | `0 0% 9%`        | `0 0% 93%`      | —               |

In light mode both are 9% and the two surfaces agree exactly. In dark mode they diverge by 6
points, in the direction that makes the sidebar read brighter than the transcript — backwards
for a product whose stated philosophy is content over chrome, and visible in the dark
screenshot. Both values clear WCAG AA against their backgrounds, so this is consistency and
doc drift, not accessibility. No ADR, spec or changelog fragment records 87% as a decision.

**Why it falls short.** `design-system.md` is the stated source of truth for these tokens and
disagrees with the file it points at, so a reader building to the doc builds the wrong grey.

**Recommendation.** Raise `--foreground` and its four 87% `-foreground` siblings to
`0 0% 93%`, matching both the doc and the sidebar. One edit, no doc change. If 87% was
deliberate, the fix is the opposite edit plus one sentence in `design-system.md` saying why
chrome outranks content in dark mode — but nothing in the repo currently says that.

---

### [P2/S] `rounded` and `rounded-lg` paint the identical 8px corner under two names across 327 call sites, and only one rung of the ramp is the app's own

**Files.** `apps/client/src/index.css:158` (`--radius: var(--radius);` inside `@theme inline`),
`:256` (`--radius: 0.5rem`), `:411`, `:1844`; `contributing/design-system.md:245,248,252`.

**Evidence — and this corrects the dry run.** The dry run called `index.css:158` circular and
said it "generates nothing", with a table asserting `rounded` resolves to Tailwind's 0.25rem.
Measured on the running app, that is wrong:

| class          | measured | source                  | sites |
| -------------- | -------- | ----------------------- | ----- |
| `rounded-md`   | 6px      | Tailwind stock          | 301   |
| `rounded-full` | —        | —                       | 184   |
| `rounded-lg`   | **8px**  | Tailwind stock (0.5rem) | 179   |
| `rounded`      | **8px**  | the app's `--radius`    | 148   |
| `rounded-sm`   | 4px      | Tailwind stock          | 72    |
| `rounded-xl`   | 12px     | Tailwind stock          | 51    |
| `rounded-2xl`  | 16px     | Tailwind stock          | 3     |

So line 158 _does_ do something: it is the single reason bare `rounded` is 8px rather than
Tailwind's 4px. The real defect is different and worse-shaped than the dry run described.
**The app's `--radius` governs exactly one rung; the other five come from Tailwind**, and by
coincidence rather than design `--radius` (0.5rem) equals Tailwind's stock `--radius-lg`
(0.5rem). The result is 148 + 179 = **327 call sites painting one corner size under two class
names**, with nothing recording that they are the same thing, and `design-system.md` defining
no radius scale at all — it names 3px for inline code and 8px for blocks and tool cards, in
prose, at three separate places.

**Why it falls short.** "Change the app's roundness" is currently a 327-site edit that would
also silently desynchronise the moment `--radius` moved off 0.5rem. Two spellings of one value
is the duplication the Quality Standard rules out.

**Recommendation.** Two steps, no visual change. Define the ramp explicitly in `@theme inline`
in terms of `--radius` — `--radius-sm: calc(var(--radius) - 4px); --radius-md:
calc(var(--radius) - 2px); --radius-lg: var(--radius); --radius-xl: calc(var(--radius) +
4px);` — values chosen to land on today's rendered sizes so nothing moves, and the collision
becomes deliberate instead of accidental. Then sweep the 148 bare `rounded` sites to
`rounded-lg` (the odd one out; every other rung is named) and write the four-step ramp into
`design-system.md` beside the spacing table, replacing the three scattered prose numbers.

---

### [P3/S] `--nebula-edge` is a raw hex restatement of `--surface`, in a theme where no other structural colour is a hex

**Files.** `apps/client/src/index.css:464` (`--nebula-edge: #e8e8e8`), `:583` (`#1a1a1a`),
`:467` / `:586` (`--surface: 0 0% 91%` / `0 0% 10%`);
`layers/entities/agent/ui/PersonalityRadar.tsx:352,359` (its only two consumers).

**Evidence.** Read back from the live document: light `--nebula-edge: #e8e8e8` against
`--surface: 0 0% 91%` — `hsl(0 0% 91%)` _is_ `#e8e8e8`. Dark `#1a1a1a` against
`--surface: 0 0% 10%` — `hsl(0 0% 10.2%)`, to within a rounding step. So the token is the
app's existing surface grey spelled a second way, in the one notation this file otherwise uses
only for the Obsidian bridge (where it is required, because Obsidian ships raw values). Its own
comment says "gradient edge fades to the panel background", which is `--surface`'s description.
Both consumers are SVG `<stop>` elements; browsers interpolate SVG gradients non-premultiplied,
so the colour affects the blend even at `stopOpacity={0}` — not dead, just duplicated.

**Why it falls short.** `design-system.md` §Color: "Use the Tailwind semantic class names in
components, not raw hex values." A structural colour defined twice will eventually be changed
once.

**Recommendation.** Delete both `--nebula-edge` declarations and use `hsl(var(--surface))` at
the two `PersonalityRadar` stops. Two deletions, one substitution, one fewer name for one
colour.

---

### [P3/S] The one scrollbar-gutter site uses an arbitrary-property escape hatch where the doc names a first-party utility that exists

**Files.** `layers/shared/ui/page-container.tsx:79`; `contributing/design-system.md:324`;
Tailwind 4.3.3's `dist/lib.js`.

**Evidence.** `design-system.md:324` names `scrollbar-gutter-stable` as the sanctioned way to
"reserve gutter space on conditionally-scrolling dialog/panel bodies", and Tailwind 4.3.3 ships
`scrollbar-gutter-auto`, `scrollbar-gutter-stable` and `scrollbar-gutter-both`. Adoption of the
sanctioned form is **zero**. The single site writes it as an arbitrary property instead:

```tsx
<div className="h-full [scrollbar-gutter:stable_both-edges] overflow-y-auto">
```

Measured on the running app, this reserves **22px** (11px per edge) on `/activity`, `/team`,
`/marketplace` and `/connections` — every route that goes through `PageContainer` — on a
platform where the overlay scrollbar would reserve nothing. That is the intended behaviour, so
this is not a layout bug; it is the same class of finding as F1's sibling, an author reaching
past a sanctioned utility for a raw value.

**Why it falls short.** Lens 1's core question: an arbitrary value where a first-party utility
exists, and a doc claiming an adoption that is zero.

**Recommendation.** Replace with `scrollbar-gutter-stable scrollbar-gutter-both`. One line, one
fewer arbitrary value, and the doc's claim becomes true.

---

### [P3/S] Two files carry a verbatim copy of the same raw-RGB status colour map, and neither changes between light and dark

**Files.** `layers/entities/session/model/status/use-session-border-state.ts:24-35` (the
header) and `:36-42` (the map); `layers/entities/session/model/status/use-agent-hottest-status.ts:15-21`;
`index.css:268-288` and `:515-532` (the theme-split values it shadows).

**Evidence.** `use-session-border-state.ts:24-35` explains, correctly and at length, why these
have to be literals: Motion cannot interpolate CSS custom properties, so a border colour that
pulses needs a concrete RGB value. That reasoning is settled and I am not relitigating it. What
is not explained is that the map is then **copy-pasted whole** into
`use-agent-hottest-status.ts:14-22` — `green: 'rgb(34, 197, 94)'`, `greenDim`, `amber:
'rgb(245, 158, 11)'`, `amberDim`, `idle`, byte for byte — with no comment at all, in a file
that already imports `SessionBorderKind` from its twin. The consequence is that the app's
"working" green and "waiting on you" amber are identical in light and dark, where
`--status-success` moves 152 69% 24% → 55% and `--status-warning` 38 92% 50% → 60% precisely
because one value cannot serve a near-white and a near-black surface.

**Why it falls short.** Two copies of one fact is the duplication the Quality Standard rules
out, and the copy carries none of the reasoning that makes the original defensible — the next
reader of the second file has no way to know the literals are deliberate.

**Recommendation.** Export the map once from `use-session-border-state.ts` (which already owns
the type the other file imports) and delete the second copy — one deletion, no behaviour
change. If the theme-blindness is worth fixing afterwards, the shape is a small resolver that
reads `--status-success` / `--status-warning` off the document once per theme change and hands
Motion concrete RGB, which keeps the constraint the header describes.

---

### [P3/S] The sidebar's 18px glyph slot is a literal in seven places while the two numbers either side of it are tokens

**Files.** `layers/shared/ui/sidebar-row.tsx:631,674,776`; `layers/shared/ui/sidebar.tsx:658`;
`layers/shared/ui/identity-avatar.tsx:124`; `layers/features/inbox/ui/InboxRow.tsx:51`;
`layers/features/feature-promos/ui/PromoCard.tsx:80`; tokens at `index.css:92,100`.

**Evidence.** `index.css:94-95` states the sidebar's geometry as arithmetic — _"Where a row's
18px glyph slot starts. The label follows at 20 + 18 + 8 = 46px, for every row type"_ — and
`:82-84` says the sum is asserted against the tokens by `sidebar-row-gutter.spec.ts` "so the
two can never drift apart unnoticed." The 18 in the middle of that sum is not a token: it is
`size-[18px]` at seven call sites (30 live elements on the home screen, counted in the DOM).
It is also off the icon ramp entirely (`--size-icon-xs` 12px, `-sm` 16px, `-md` 20px) and,
being a bracket literal, is the one part of the row that does not multiply by `--_si` on a
phone — measured at 390px: `size-[18px]` stays 18px while `size-4` and the icon tokens grow.

**Why it falls short.** Retuning `--sidebar-row-x` moves every header and row together, by
design, and then leaves the glyph they are measured around behind.

**Recommendation.** Add `--sidebar-glyph: calc(1.125rem * var(--_si))` beside the two geometry
tokens at `index.css:92-100` and replace the seven sites with `size-(--sidebar-glyph)`. Low
urgency; it wants the sidebar's next visit rather than its own PR.

---

### [P3/S] The spacing doc states an absolute rule the codebase breaks 1119 times, two sections above the paragraph that explains why

**Files.** `contributing/design-system.md:131` ("We use an **8-point grid**. All spacing values
are multiples of 4px") against `:135-141` (the control-surface density table), and a sweep of
`apps/client/src`.

**Evidence.** Re-measured against the dry run's 1063: **1119** half-step (2px) spacing
utilities outside `dev/` and tests. `gap-1.5` alone is more common than most of the documented
steps, and it is what the sidebar and every control surface is built from — which is exactly
what the doc's own "control surfaces run dense" table four lines later describes.

**Why it falls short.** Two rules in one document contradict each other, and the losing one is
stated as absolute. A new contributor either files a thousand false findings or learns to
ignore the doc — and this audit's own dry run had to spend a finding saying so.

**Recommendation.** Fix the **doc**, not the code; sweeping 1119 classes to satisfy a sentence
is the expensive wrong answer. Replace "All spacing values are multiples of 4px" with the
ladder in use (2 · 4 · 6 · 8 · 12 · 16 · 24 · 32) and say plainly that the 2px steps are the
control-surface density the next section already describes. Extend the existing token table
with the `1.5` and `2.5` rows rather than adding a second table.

---

## Counts

| Severity | Count |
| -------- | ----- |
| P1       | 0     |
| P2       | 6     |
| P3       | 5     |

Effort: 2×M, 1×L, 8×S. Nine of the eleven findings ask for a deletion, a merge, or a doc
correction rather than an addition.

**Zero P1, filed with a browser leg that ran.** That is a result, not a gap. The two P1s the
September run filed are both closed (`border-<colour>` is layered; the `text-[Npx]` sweep is
down from ~250 occurrences to 1), and the one candidate the dry run nominated for promotion —
F1 — was tested in the browser and **refuted**: the cascade defect is real and confirmed, but
this platform reserves no space for it, so nothing is visibly broken to a new user on the
surface I could observe. F2 is the finding a browser found that no amount of code reading
would have: an elevation scale built to be theme-aware, ignored by every surface that needed
it.
