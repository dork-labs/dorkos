[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Found after the batches — ready to file

Defects the audit's own follow-up work surfaced, recorded here rather than fixed
where they were found, so a coverage PR does not quietly carry a product change.

### F1 — Home's bar overflows its own row by ~4px at exactly 768px

**P3 · S · lens 8** — found by the tablet sweep added in DOR-1816, on its first
run.
`apps/client/src/AppShell.tsx:745`, `apps/client/src/layers/widgets/one-bar/ui/OneBar.tsx:65-95`,
`apps/client/src/layers/widgets/one-bar/ui/HomeSurfaceBar.tsx:62-100`,
`apps/client/src/layers/widgets/one-bar/ui/RoomRunState.tsx`,
`apps/client/src/layers/shared/ui/bar-tab-strip.tsx:168`

**Evidence.** Measured in Chromium at 768×1024 on `/`: the shell's cross-fade
wrapper (`flex min-w-0 flex-1 items-center gap-2 self-stretch`) is 293.0px wide
and its children want 297.3px, so the health dot — last in the row — paints
4.3px past it. Nothing in the row will yield the difference, and every refusal
is deliberate: `BarTabStrip` is at the `min-w-28` floor finding 2.3 gave it
(112.0px), the chips zone is `shrink-0` (153.3px), and `RoomRunState` reserves
its ~70px whether or not anything is running, which is its own documented
"reserved-space mechanism (I3)" — an agent picking work up must not move the
row.

768px is the first width at which this is reachable, which is why no earlier
pass saw it: `RoomRunState` draws nothing below the mobile breakpoint by
design, so the width it reserves appears for the first time at exactly the
width the new sweep added.

**Not visible today**, which is why it is P3 and not P1: the 4.3px lands in the
header's own 8px gap and overlaps nothing. It is a latent overlap — the moment
the chips grow (a longer room name, a three-digit working count) it becomes the
health dot sitting under the ⌘K trigger.

**Recommendation.** A product decision about which chip yields on Home's bar at
tablet width, not a containment patch — which is why it was filed rather than
fixed inside `apps/e2e`. The guard records it in `EXPECTED_ESCAPES`
(`apps/e2e/tests/responsive/no-horizontal-scroll.spec.ts`) so the sweep stays
green and still reports every OTHER escape on that page; that entry also fails
the test if the escape ever stops happening, so fixing this forces the entry's
deletion.

### F2 — `TaskTemplateCard`'s toggle variant nests a button inside a button

**P3 · S · lens 6** — found by the browser pass added in DOR-1816.
`apps/client/src/layers/features/tasks/ui/TaskTemplateCard.tsx:70-90`

**Evidence.** With `variant="toggle"` the card is a `<button>` and renders a
`Switch` — itself a `<button>` — inside it. React reports it twice on every
load of `/dev/features` ("In HTML, `<button>` cannot be a descendant of
`<button>`" and "`<button>` cannot contain a nested `<button>`"), which is two
of the three console errors the whole playground logs.

**Not user-facing today**, which is why it is P3: `TaskTemplateGallery` — the
only production consumer — renders `variant="selectable"`, so the `toggle`
branch is reached by the playground and its unit tests and nothing else. It is
still invalid HTML in a shipped component, and it makes the switch unreachable
as its own control for anyone who gets there.

**Recommendation.** Take the card off `<button>` in the toggle variant (a
`div` with the switch as the only control), or drop the variant if nothing is
going to use it. `apps/e2e/tests/dev-playground/pulse-attention.spec.ts`
records the two messages in `KNOWN_CONSOLE_ERRORS` and fails when they stop
appearing, so fixing this forces that entry's deletion.

### F3 — `RoomRow`'s wake latch still calls `flushSync` mid-render in the playground

**P3 · S · lens 6** — found by the browser pass added in DOR-1816.
`apps/client/src/layers/features/dashboard-sidebar/ui/rooms/RoomRow.tsx:205-210`

**Evidence.** `/dev/conversation` and `/dev/rooms` each log React's "flushSync
was called from inside a lifecycle method" warning several times per load —
six to eleven, depending on the page. This is the same warning finding 2.4
fixed for the app by deferring `RoomRow`'s FOCUS path into a microtask; the
remaining trigger is a different one and only the playground reaches it, so
2.4's fix is not wrong, just incomplete for this call site.

**Recommendation.** Find which showcase wakes a row during render and either
defer that path the way `onMenuIntent` defers focus, or make `wake()` fall back
to a plain `setAwake(true)` when a flush is illegal. Not urgent — the app's own
surfaces are quiet.

### F4 — A conversation showcase revokes a blob URL before the browser reads it

**P3 · S · lens 6** — found by the browser pass added in DOR-1816.
`apps/client/src/dev/` (attachment/preview showcases on `/dev/conversation`)

**Evidence.** `/dev/conversation` logs two `net::ERR_FILE_NOT_FOUND` failures
on every load, both for `blob:` URLs the page minted itself. A showcase creates
an object URL for a preview and revokes it (or lets its effect clean up) before
the image request resolves. Playground-only and invisible on screen; it is
noise in the console a reader has to learn to ignore, which is the thing batch
20's I3 was about.

**Recommendation.** Hold the object URL for the life of the showcase rather
than for the life of the effect that created it.

---

## Deferred verification — now permanent coverage

The batches deferred four pieces of verification into PR bodies, where the next
audit would have had to re-derive them. They are code now, and this is the map
(DOR-1816).

| Deferred by               | What was owed                                                                   | Where it lives now                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Batch 07 / #1530 (nit N4) | `touchHeight`-based specs for the terminal, canvas and background-task surfaces | `apps/e2e/tests/responsive/touch-reach.spec.ts` — measures reach AND border box, at 390×844                       |
| Batch 01 / #1524 (nit 5)  | A 768px route sweep in the overflow guard                                       | `apps/e2e/tests/responsive/no-horizontal-scroll.spec.ts` — 8 routes × 2 widths                                    |
| Batch 02 / #1522 (nit 3)  | A real assertion behind the tab strip's `min-w-28` floor                        | `apps/e2e/tests/one-bar/bar-tab-strip-floor.spec.ts` — rendered geometry in the 236px showcase                    |
| Batch 20 / #1527 (I4)     | A populated attention-signals showcase                                          | `apps/client/src/dev/showcases/PulsePanelShowcases.tsx` + `apps/e2e/tests/dev-playground/pulse-attention.spec.ts` |

Two of the four found something on their first run: the tablet sweep found F1,
and the browser pass behind the fourth found F2, F3, F4 and the playground
router defect below.

### The playground was claiming to be Home

Fixed in place rather than filed, because it is dev-only and it was hiding a
showcase. `DevPlayground`'s memory router had a root route and nothing else, so
every path it was given resolved to `/` and `useSafePathname()` answered `/` on
all 24 pages. `PulseAttentionSection` draws NOTHING on `/` at desktop width (it
would duplicate Home's own triage header), so batch 20's `PulsePanel` showcase
was rendering one section and silently omitting the other — including its
all-clear line. The router now lands on a route of its own
(`PLAYGROUND_ROUTER_PATH`), so a showcase that asks which route it is on is not
told it is standing on Home.

### The lens-6 browser pass, page by page

All 24 pages driven at 1280×720 against a live dev server (DOR-1816), which is
the pass [Dropped](../01-findings.md#dropped-and-narrowed) says never happened. **No showcase on
any page falls into its error boundary**, and 21 of 24 pages log nothing at all.
The three that do are F2 (`/dev/features`), F3 (`/dev/conversation`,
`/dev/rooms`) and F4 (`/dev/conversation`).

**Still unchecked, and deliberately so.** The pass looked for thrown showcases
and console errors on load. It did NOT check hover states, per-showcase visual
drift against the real component, or the playground at phone width — the other
three things the Dropped note lists. `/dev/simulator` renders no
`section[id]` at all, which is either by design or a 25th finding; it was not
traced.
