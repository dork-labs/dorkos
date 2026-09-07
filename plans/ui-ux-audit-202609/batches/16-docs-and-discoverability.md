[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 16 — Docs and discoverability

**Priority P2 · 7 findings · 4S · 3M**
**Scope:** documentation only, no code renders differently. These are the reasons contributors keep making the mistakes the other batches clean up: the ground-truth docs teach a dead import path, contradict each other on reduced motion, and describe a naming convention the directory does not follow.

### 16.1 — A live contributing guide teaches the wrong pattern and a non-existent import path

**P2 · S · lens 5**
`contributing/styling-theming.md:381-395`, `contributing/design-system.md:1071`

**Evidence.** `styling-theming.md` presents this as the ✅ pattern:

```tsx
// ❌ Don't modify Shadcn component source files
// ✅ Use className prop or create wrapper
import { Button as BaseButton } from '@/components/ui/button';
```

`@/components/ui/button` has not existed since the FSD migration — `apps/client/src/components/` is not a directory — so an agent copying that line writes an import that fails both `tsc` and the FSD lint rule. Worse, the advice contradicts the repo's actual practice and its own rules: `.claude/rules/components.md` §Required Patterns says to follow the existing files and add `cva` variants, and `button.tsx:19-20` carries a bespoke `brand` variant while `:41-59` carries a bespoke `responsive` system — the file has been modified heavily and on purpose. `design-system.md:1071` has the same stale path ("See `components/ui/responsive-dialog.tsx`"). These two files are the ground truth an agent reads before touching a primitive; teaching "wrap, don't modify" is how a `BaseButton`-wrapper layer gets born on top of a design system built to be extended in place.

**Recommendation.** Rewrite `styling-theming.md:381-395`: shadcn files here are **owned**, not vendored; extend them with a new `cva` variant and keep the caller `className` escape hatch for one-offs; never fork a primitive into a wrapper. Fix both stale paths to `apps/client/src/layers/shared/ui/…`. Add a grep for `@/components/` to the docs check so a dead path cannot come back.

### 16.2 — `shared/ui` documents one naming convention and ships a second one, undocumented

**P2 · M · lens 4**
`.claude/rules/components.md:107`, `contributing/project-structure.md:416`; outliers `apps/client/src/layers/shared/ui/{ConnectionStatusBanner,DirectoryPicker,FeatureDisabledState,PromptSuggestionChips,ScanLine}.tsx`, plus `shared/ui/filter-bar/` (8 files) and `shared/ui/form-fields/` (7 files), all PascalCase

**Evidence.** Both docs state the file-naming rule as a flat table — "Component file → PascalCase (`UserCard.tsx`)" — and neither carves out `shared/ui/`. The real barrel is the opposite: 85 of 90 files are kebab-case (`button.tsx`, `data-table.tsx`, `mention-pill.tsx`, `sidebar-row.tsx`, `trust-dial.tsx` — none of these are shadcn scaffolding, they are hand-built DorkOS components, kebab-cased anyway). Five top-level files and two whole subdirectories break it. The drift is live, not legacy: all five top-level outliers were added in the last five weeks (four on 2026-07-29 in PR #606, one on 2026-08-08 in PR #880) by whoever reached for the documented rule in good faith. `shared/ui/tour-spotlight/` gets it right by the shared/ui norm — component files PascalCase, hook files kebab — proving the split convention is achievable and was achieved once.

**Recommendation.** Pick one and write it down. The cheap fix is documenting what is already true: one line in `.claude/rules/components.md`'s File Naming table — "`shared/ui/` is the exception: files are kebab-case regardless of shadcn-vs-custom origin." That alone stops the bleeding on new files. Renaming the seven existing outliers is optional cleanup on top, and cheap — no runtime behaviour changes, only the barrel's `from './…'` paths move with the files.

### 16.3 — One usage example in ninety primitives

**P3 · M · lens 5**
`apps/client/src/layers/shared/ui/filter-bar/index.ts:4-14` (the only `@example` in `shared/ui`; seven in the whole client)

**Evidence.** `FilterBar`'s barrel opens with a compact, complete example showing the compound shape in ten lines. Nothing else in the library has one — not `NavigationLayout` (nine sub-components), not `TabbedDialog`, not `SidebarMenuNodes`, not `ResponsiveDialog`, not the `Field` family. For a compound API the example _is_ the documentation: prose describing `Field`/`FieldContent`/`FieldLabel`/`FieldDescription` nesting is strictly worse than four lines of JSX, and the example is what both an editor hover and an agent's context window surface.

**Recommendation.** Add one `@example` to each compound primitive's root export — `NavigationLayout`, `TabbedDialog`, `Field`, `Card`, `ResponsiveDialog`, `SidebarMenuNodes`, `DataTable`, `Feed`. Keep each to the shortest thing that compiles; a long example rots. Pairs naturally with batch 20 — the playground showcase and the `@example` should show the same shape.

### 16.4 — Two of the five responsive wrappers are undocumented

**P3 · S · lens 5**
`contributing/design-system.md:1005-1075`; undocumented: `apps/client/src/layers/shared/ui/responsive-sheet.tsx` (14 call sites), `responsive-context-menu.tsx`

**Evidence.** The section is good where it exists: `:1011` gives the choose-this-not-that rule for `ResponsiveDropdownMenu` ("Use instead of plain `DropdownMenu` when the menu appears in a touch-accessible area… Plain `DropdownMenu` is fine for desktop-only contexts") and `:1075` does the same for `ResponsivePopover`. `ResponsiveSheet` and `ResponsiveContextMenu` get no entry, so the only way to learn they exist is to read the barrel.

**Recommendation.** Add the two missing subsections in the same shape as the existing three — a one-line "use instead of X when…" plus the desktop/mobile mapping table — and fix the stale path at `:1071` (16.1). While there, put the one-line rule in each wrapper's own TSDoc with an `@see` back to the plain primitive, so the choice is answerable from the editor as well as the guide.

### 16.5 — Ninety exports and no map

**P3 · M · lens 5**
`apps/client/src/layers/shared/ui/index.ts` (389 lines, 90 modules); the families it exposes — overlays (`dialog`/`responsive-dialog`, `popover`/`responsive-popover`, `dropdown-menu`/`responsive-dropdown-menu`, `context-menu`/`responsive-context-menu`, `sheet`/`responsive-sheet`/`drawer`) and rows (`sidebar-row`, `setting-row`, `option-row`, `compact-result-row`, `sidebar-menu-node`, plus `entities/session`'s `SessionRow`/`SessionRowSidebar`)

**Evidence.** There is no `README.md` anywhere under `apps/client/src/layers/`. The barrel is the only index, it is not alphabetised (`Progress` and `PromptSuggestionChips` land between `Collapsible` and `Input`), and its section comments cover four of ninety modules. `design-system.md` answers the overlay question for three of five pairs and does not touch the row family at all — so a contributor asking "which row do I use for a settings toggle vs a sidebar entry vs a decided prompt option?" has seven candidates and no guide. Discoverability is the first DX property: a library you cannot navigate gets re-implemented instead of imported, which is the upstream cause of most of batch 17.

**Recommendation.** Add `apps/client/src/layers/shared/ui/README.md` — one page, three tables (overlays, rows, form controls), each row _"want X → use Y; not Z, because…"_ — and link it from `contributing/design-system.md` and `.claude/rules/components.md`. Then group the barrel with section comments matching the README's sections and alphabetise within each group. Documentation and ordering only.

### 16.6 — Two composition idioms for compound components

**P3 · S · lens 5**
`apps/client/src/layers/shared/ui/filter-bar/index.ts:27-34` (namespace via `Object.assign`) vs `card.tsx:65`, `dialog.tsx`, `field.tsx`, `navigation-layout.tsx`, `sidebar.tsx`, `table.tsx` (flat sibling exports)

**Evidence.** `FilterBar` is reached as `<FilterBar.Search>`, `<FilterBar.Sort>`; every other multi-part primitive is reached as `<CardHeader>`, `<DialogContent>`, `<FieldLabel>`. `FilterBar` is the sole `Object.assign` compound in `layers/`. Not wrong — the namespace form is arguably nicer and tree-shakes fine — but a contributor building the next compound has no default, and a reader scanning imports sees one name for `FilterBar` and seven for `Card`.

**Recommendation.** Pick the flat sibling form as the house style (it is the shadcn convention the other 89 files follow), write the choice down in one sentence in `.claude/rules/components.md`, and leave `FilterBar` as it is with a note that it predates the rule — churning 16 call sites to win consistency alone is not worth it. Revisit only if a second namespace compound appears.

### 16.7 — The two ground-truth docs give opposite instructions on reduced motion for `motion/react`

**P3 · S · lens 10**
`contributing/animations.md:621-635,765-767` versus `contributing/design-system.md:609`

**Evidence.** `animations.md` says reduced motion "is handled globally — no per-component work required… **No per-component `useReducedMotion` calls are needed**". `design-system.md:609` says "The one thing the reset does not reach is `motion/react`, which writes inline styles from JS: **any `motion.*` component must call `useReducedMotion()` and branch off**." The codebase splits accordingly: ~60 files call the hook, ~150 rely on `MotionConfig reducedMotion="user"` alone. Both are half right, and the half nobody wrote down is the one that matters: `MotionConfig reducedMotion="user"` suppresses **transform and layout** animations but not **opacity or colour**. So an infinite opacity or colour loop written in `motion/react` keeps running under `prefers-reduced-motion` regardless of the global config. The app currently gets this right by convention (`use-session-border-state.ts:147-168` gates its infinite `borderLeftColor` pulse; `LaneContent.tsx:503-505` gates its infinite sweep) — but an author following `animations.md` literally would not. This is the doc half of 18.14.

**Recommendation.** Reconcile into one sentence with the actual mechanism: _transform and layout animations are handled by `MotionConfig`; opacity, colour and any `repeat: Infinity` animation need an explicit `useReducedMotion()` gate, and the gate belongs in a pure function that also reports itself as a `data-` attribute_ (the `shouldAnimateRoster()` shape, `design-system.md:624`). Doc-only; no code moves.
