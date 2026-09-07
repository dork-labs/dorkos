# UI/UX Audit — Findings

**Scope:** `apps/client/src` (940 component files) · **Date:** 2026-09-03 · **Charter:** [`00-charter.md`](00-charter.md)
**Method:** twelve code-reading lenses + four live-browser passes + operator-confirmed bugs. Raw per-lens reports live in [`raw/`](raw/).
**Layout:** this file is the index. The 20 batches live in [`batches/`](batches/) and later records in [`notes/`](notes/) — before adding anything, read [Where new material goes](#where-new-material-goes).

---

## Executive summary

The DorkOS client is well built and, in places, better than the industry norm — the session status line, the sidebar's bottom-slot arbiter, the message layer's motion, and the roving-focus sidebar are all reference-quality. The gaps are concentrated in three places: the shared primitives everything else is built from, the general app chrome that never got the attention the chat surfaces did, and long strings that escape their containers on small screens. Four defects are visibly broken to a new user today: a filesystem path runs off the Workspaces card and off the phone screen, the Schedules empty state renders clipped behind its own header, every marketplace card truncates its author and source to single unreadable characters, and the marketplace grid collapses to 78px cards whenever a side panel is docked. Two accessibility failures matter more than their size suggests: the sort-direction toggle in the shared filter bar cannot be reached by keyboard at all, and schedule template cards read their entire prompt aloud as the button's name. A CSS rule written outside any cascade layer silently repaints every coloured border in the app as plain grey across 69 files, so error, warning and selection cues that authors intended simply are not there. The base `Button` — the most-used primitive in the codebase — has no press feedback, which is why fifteen call sites invented nine different press values of their own. Copy is the largest single lens: one concept carries three names (session, conversation, chat), an accepted ADR's retired vocabulary is still on screen, and the app's default error voice is "Failed to…" with the raw server message pasted in front of the authored sentence. The `shared/ui` directory was fenced off from the repo's own TSDoc and file-size rules on a "vendored shadcn" premise that stopped being true dozens of hand-written primitives ago, and findings across four lenses trace back to that one exemption. Nothing in this report asks for more decoration: the large majority of recommendations delete code, merge two things into one, retime existing motion, or shorten a sentence.

---

## Stats

**189 raw findings → 167 after dedup and verification.** Two findings were dropped and one narrowed (see [Dropped](#dropped-and-narrowed)); 20 were merged where two or more lenses saw the same underlying defect.

| Lens                      |     P1 |     P2 |     P3 |   Total |
| ------------------------- | -----: | -----: | -----: | ------: |
| 1 · Tokens & consistency  |      2 |      4 |      3 |       9 |
| 2 · Composition & CVA     |      2 |     12 |      2 |      16 |
| 3 · DRY                   |      0 |      2 |      3 |       5 |
| 4 · Organization & naming |      0 |      5 |      2 |       7 |
| 5 · DX                    |      1 |     12 |      7 |      20 |
| 6 · Playground            |      0 |      6 |      4 |      10 |
| 7 · Copy (ELI5)           |      2 |     16 |      8 |      26 |
| 8 · Responsiveness        |      7 |      9 |      3 |      19 |
| 9 · UI states             |      4 |      8 |      3 |      15 |
| 10 · Motion               |      1 |      9 |     12 |      22 |
| 11 · Clutter & disclosure |      0 |      9 |      3 |      12 |
| 12 · Componentization     |      0 |      5 |      1 |       6 |
| **Total**                 | **19** | **97** | **51** | **167** |

**Effort mix:** 121 S · 39 M · 7 L.

### Batches at a glance

| #   | Batch                                                                                          | Pri | Findings | Effort       |
| --- | ---------------------------------------------------------------------------------------------- | --- | -------: | ------------ |
| 1   | [Overflow containment](batches/01-overflow-containment.md)                                     | P1  |        7 | 6S · 1M      |
| 2   | [Clipped layouts and console errors on load](batches/02-clipped-layouts-and-console-errors.md) | P1  |        5 | 2S · 3M      |
| 3   | [Keyboard and screen-reader gaps](batches/03-keyboard-and-screen-reader-gaps.md)               | P1  |        5 | 4S · 1M      |
| 4   | [Tokens that don't paint](batches/04-tokens-that-dont-paint.md)                                | P1  |        9 | 5S · 2M · 2L |
| 5   | [Press, hover and focus in the shared primitives](batches/05-press-hover-and-focus.md)         | P1  |       10 | 9S · 1M      |
| 6   | [Rows and cards missing their own states](batches/06-rows-and-cards-missing-states.md)         | P2  |        8 | 8S           |
| 7   | [Touch targets and hover-only affordances](batches/07-touch-targets-and-hover-only.md)         | P1  |        8 | 4S · 4M      |
| 8   | [Copy: honesty and settled vocabulary](batches/08-copy-honesty-and-vocabulary.md)              | P1  |        7 | 4S · 2M · 1L |
| 9   | [Copy: register, casing and the error voice](batches/09-copy-register-casing-error-voice.md)   | P2  |        9 | 4S · 5M      |
| 10  | [Copy: typography and stragglers](batches/10-copy-typography-and-stragglers.md)                | P3  |        7 | 5S · 2M      |
| 11  | [No wall of text](batches/11-no-wall-of-text.md)                                               | P2  |        4 | 3S · 1M      |
| 12  | [Settings information architecture](batches/12-settings-information-architecture.md)           | P2  |        6 | 5S · 1M      |
| 13  | [The session surface: fewer things competing](batches/13-session-surface.md)                   | P2  |        5 | 1S · 4M      |
| 14  | [Shared primitives: composition debt](batches/14-shared-primitives-composition-debt.md)        | P2  |       13 | 8S · 3M · 2L |
| 15  | [`shared/ui` library hygiene](batches/15-shared-ui-library-hygiene.md)                         | P1  |       14 | 6S · 7M · 1L |
| 16  | [Docs and discoverability](batches/16-docs-and-discoverability.md)                             | P2  |        7 | 4S · 3M      |
| 17  | [Componentization: extract what's been copied](batches/17-componentization.md)                 | P2  |       12 | 5S · 7M      |
| 18  | [Motion: back inside the timing system](batches/18-motion-timing-system.md)                    | P2  |       14 | 11S · 3M     |
| 19  | [FSD placement and naming](batches/19-fsd-placement-and-naming.md)                             | P2  |        7 | 5S · 2M      |
| 20  | [Dev Playground: organization and coverage](batches/20-dev-playground-organization.md)         | P2  |       10 | 7S · 3M      |

### Dropped and narrowed

- **Dropped — "Dev server fails to boot the client on every route"** (`raw/browser-playground.md`). An environment failure (two Vite optimize-deps chunks 404ing from a running dev server), not an application defect; the auditor states plainly that no `file:line` fix applies. Charter rule 1. **Consequence: the playground was never audited in a live browser** — every lens-6 finding below is source-read only, and a browser pass over `/dev`'s 24 pages remains an open coverage gap.

  > **The browser pass has since run (DOR-1816).** All 24 pages driven live; see [the lens-6 browser pass](notes/260907-143000-dor-1816-browser-pass-and-deferred-coverage.md#the-lens-6-browser-pass-page-by-page) for what it found (F2, F3, F4 and one dev-only fix) and what it still did not look at.

- **Dropped, re-filed, and FIXED — "`/session` with no id resolves to a deleted session, producing two 404s"** (`raw/browser-desktop.md` #11). Real observed behaviour, but the auditor records "route `/session` — not directly inspected", so it carried no `file:line`. Re-filed as **DOR-1836** on the trace below, and fixed in **#1651**.

  > **Still reproducible — trace complete, ready to re-file (DOR-1817, checked 2026-09-06).** Loading `http://localhost:6241/session` with no query params redirected to `?session=152e3ae8-1361-48fd-976e-a1a53f935741` and produced the same two 404s and the same two `[dorkos:query-error]` breadcrumbs the auditor saw, before the same clean empty state. It is two separate defects wearing one symptom, and the second is not about a deleted session at all:
  >
  > 1. **The list and the detail disagree.** `GET /api/sessions?cwd=…/dorkos/apps` returns that exact id, and `GET /api/sessions/<id>?cwd=…/dorkos/apps` answers 404 `SESSION_NOT_FOUND` (`apps/server/src/routes/sessions.ts:384`) — verified with two `curl`s against the same running server, same directory, seconds apart. The client is asking honestly and the server contradicts its own listing; whether that id was deleted or never persisted is not established here, and the re-filed ticket should settle it. The request is issued by `useSessionDetail` (`apps/client/src/layers/entities/session/model/query/use-session-detail.ts:67-73`), mounted for the tab title at `apps/client/src/AppShell.tsx:464` and for the status line at `apps/client/src/layers/entities/session/model/settings/use-session-status.ts:98`.
  > 2. **The redirect drops the directory.** `sessionRouteLoader` (`apps/client/src/router.tsx:361-418`) picks the id via `resolveSessionForCwd` (`apps/client/src/layers/entities/session/lib/resolve-session-for-cwd.ts:108-118`) and redirects with `dir` still `undefined`, because none arrived. `useSessionHistory` (`apps/client/src/layers/features/chat/model/use-session-history.ts:70-78`) then calls `GET /api/sessions/<id>/messages` with no `cwd` and gets 404 `SESSION_CWD_REQUIRED` (`apps/server/src/routes/sessions.ts:463-471`). The same request WITH `?cwd=` answers `200 {"messages":[]}` — so this 404 is caused entirely by the directory the redirect threw away.
  >
  > P3 stands: the UI still recovers into "Start a conversation". This is the `file:line` pointer the finding originally lacked; it wants a ticket under UI/UX Audit 2026-09, not a fix here.
  >
  > **Answered and fixed (DOR-1836, #1651).** Point 1's open question — deleted or never persisted — is **neither**: that session is on disk, and it is the same `152e3ae8…` this trace names. It lives at `…/dorkos/apps/desktop/.temp/.dork/agents/dorkbot`, which is _inside_ the `…/dorkos/apps` the list was asked about. A project's session list covers the project's whole SUBTREE (DOR-1550), so a conversation held further down appears in the list carrying its **own** directory in its row, and every per-session read is addressed by id **and** directory. `GET /api/sessions/152e3ae8…/messages?cwd=…/dorkos/apps` proves it, answering `200 {"messages":[]}` — an empty transcript for a session with real messages, which is the misaddressing rather than a disagreement. So points 1 and 2 are **one defect, not two**: `resolveSessionForCwd` answered with the id alone and discarded the row's directory, leaving the redirect nothing to say about where the conversation lives.
  >
  > Fixed by carrying that directory through (`apps/client/src/layers/entities/session/lib/resolve-session-for-cwd.ts`, `apps/client/src/router.tsx`): a `dir` the person named still wins, and a bare `/session` now fills the blank with the resolved conversation's own directory. Browser-verified on a **cold load** of bare `/session` — zero 404s and zero `[dorkos:query-error]` breadcrumbs where the same load made two of each. That is the measured claim and the whole of it: an in-app navigation arriving with a `selectedCwd` already set can still race one detail read against the redirect, which was neither reproduced nor ruled out. **The empty-transcript symptom also survives on every agent-switch surface** (`SidebarChrome`, the command palette, `useDirectoryState`, `switchAgentCwd`): each navigates with the directory it was given, which is the right thing for picking an agent, and the reason the remaining half is a server-side fix — addressing a session by id alone.

- **Narrowed — "Two dead exports in `shared/ui`"** (`raw/organization.md`). `SettingsPanel` is genuinely dead (barrel + its own test only, verified). `NavigationLayoutSectionHeader` is **not** dead — it is rendered at `shared/ui/tabbed-dialog.tsx:195`. That half is removed; the finding survives as `SettingsPanel` alone.

### Verification

28 findings were spot-verified by opening the cited files: `WorkspacesPage.tsx`, `PackageCard.tsx`, `TaskTemplateCard.tsx`, `RoomRow.tsx`, `button.tsx`, `FilterBarSort.tsx`, `eslint.config.js`, `collapsible.tsx`, `index.css` (border rule, `card-interactive`, dead keyframes), `badge.tsx`, `sheet.tsx`, `MobileTabBar.tsx`, `ActivityRow.tsx`, `trust-dial.tsx`, `QueuePanel.tsx`, `tasks/TaskRow.tsx`, `ActivityPage.tsx`, `TeamPage.tsx`, `input-otp.tsx`, `switch.tsx`, `link-safety-modal.tsx`, `CollapsibleCard.tsx`, `ConnectionStatusBanner.tsx` (relay shim), `settings/ToolsTab.tsx`, `widgets/tasks/TasksPage.tsx`, `TeamRosterToolbar.tsx`, plus counted greps for `border-<colour>` (69 files), `text-[Npx]` (203 hits / 76 files at `10px`), and `size-[--size-icon-*]` (2 files). All held except the one narrowed above.

---

## Where new material goes

This ledger is written by many sessions at once, so it is split into files that
different sessions can write at the same time. Three PRs collided on the single
file this used to be in one week, and taking either side of that conflict
silently deletes somebody's findings (DOR-1838). Pick the right file and the
collision cannot happen:

| You are recording…                                                        | Write it here                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| what happened to a finding — fixed, not reproducible, deferred, re-scoped | in that finding's own **batch file**, as a `>` block right under it       |
| anything that is not one of the 20 batches' findings                      | a **new file** in [`notes/`](notes/) — never an append to an existing one |
| raw per-lens auditor output                                               | [`raw/`](raw/), as the audit already does                                 |

Two rules make it work:

1. **Never append to a file another session is likely to be appending to.** A
   `notes/` file is named `<YYMMDD-HHMMSS>-<slug>.md` (`.claude/scripts/id.ts`
   prints the id) and belongs to the session that created it, exactly the way
   `changelog/unreleased/` fragments do. Two sessions writing on the same day
   write two files.
2. **Do not add a status column to "Batches at a glance".** Per-batch status
   belongs in the batch file. Prettier re-pads a whole markdown table when any
   cell's width changes, so a status column turns every batch PR into an edit
   of every row — the collision this split exists to remove, rebuilt.

The executive summary, the stats and the appendix describe the audit as it was
taken, and are not an append target. A one-line status edit in the appendix is
fine; anything longer is a `notes/` file.

---

## Records added after the audit

Everything found or settled after the 20 batches were written, newest last.

- [The lens-6 browser pass and the deferred verification](notes/260907-143000-dor-1816-browser-pass-and-deferred-coverage.md) (DOR-1816) — findings F1-F4, the map from four deferred verifications to the specs that now hold them, and the page-by-page playground pass the audit had recorded as never run.

---

## Appendix — coverage and honest gaps

What each lens actually covered, and what it did not, so the gaps are visible rather than implied.

**Read in full by multiple lenses:** `contributing/design-system.md` (all 1270 lines), `contributing/animations.md`, `.claude/rules/{fsd-layers,components,conventions}.md`, `.claude/skills/maintaining-dev-playground/SKILL.md`, `AGENTS.md`, `apps/client/src/index.css`, and `apps/client/eslint.config.js`. ADRs checked before flagging: 0097, 0224, 0230, 0255, 0310, `260726-193526`, `260804-021140`, `260819-210153`, `260819-234827..30`, `260822-083228`, `260822-083229`, `260728-022013`.

**Well covered.** `layers/shared/ui/` was read by four lenses independently (CVA read 78 of 96 files line by line; DX read 37 plus a scripted sweep of all ~90; motion grepped all 96 and read 30; DRY listed all ~90 and read the primitive families). `apps/client/src/index.css` was read exhaustively for tokens and for all 40 keyframes. Main-surface desktop (1440×900) and phone (390×844) were both driven live across ten routes each.

**Sampled, not exhaustive.** The 60 `features/` and 17 `widgets/` slices: the code lenses grepped the whole tree for their specific patterns (so a hit anywhere surfaces) and then read only a representative subset end to end — roughly 15 slices deeply for DRY, ~16 components for CVA, ~15 for componentization. Copy read Settings, onboarding, errors and `shared/ui` in full and sampled the rest by grep-then-read. Findings are pattern-seeded, so defects expressed with structurally different markup are under-represented; this is a sample, not an exhaustive AST diff.

**Known gaps, in priority order for a follow-up pass.**

1. **The Dev Playground has now been seen in a browser, partly** (DOR-1816 — see [the lens-6 browser pass](notes/260907-143000-dor-1816-browser-pass-and-deferred-coverage.md#the-lens-6-browser-pass-page-by-page)). All 24 pages were loaded and checked for thrown showcases and console errors, which produced findings F2, F3 and F4 and one dev-only fix. Hover states, showcase-vs-real drift and the mobile spot-check are still unaudited.
2. **Loading and skeleton states were never observed.** The local dev server answered fast enough that no skeleton frame was caught on any of five pages. A CPU/network-throttled pass (via CDP) is needed to verify them; 6.5 was found by reading source, not by watching it.
3. **Tablet width (768–1023px) got a five-page sample only,** and it produced two P1s (2.2, 2.3). It deserves a full pass — the docked-right-panel configuration is materially different from both phone and desktop and was clearly never tested. **Partly closed** (DOR-1816): the overflow guard now sweeps all eight routes at 768px on every run, which found F1 — but that is containment only, and a design pass at tablet width is still owed.
4. **The live account had small data** — two team members, one channel, one agent — so a large roster, a busy multi-session queue, an active turn in progress, a long inbox and a populated topology were not observable. Several findings (18.5's uncapped stagger, 1.4's sparse grid) predict behaviour at scale from source rather than from a screenshot.
5. **Not audited at all:** Team's Table/Topology/Denied/Access views; eleven of the thirteen Settings tabs at the browser level; package-detail and room-detail sub-pages; `/marketplace/sources`; `/feedback-requests` beyond its empty state; the Obsidian embed as its own surface; `gen-ui` motion (deliberately out of bounds — it has its own spec'd vocabulary); `apps/site`, `apps/desktop`, `apps/obsidian-plugin` (out of charter scope).
6. **Icon-sizing adoption** was counted for the documented token (2 files, verified) but the ~700 raw `size-N` occurrences were not individually traced to separate icons from status dots, avatars and spacing — so 4.3's defect rate is a lower bound on the _convention_ gap, not a precise count of mis-sized icons.
