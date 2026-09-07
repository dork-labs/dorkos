[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 15 — `shared/ui` library hygiene

**Priority P1 · 14 findings · 6S · 7M · 1L**
**Scope:** the developer-facing contract of the client's most-imported public API. **15.1 is the root cause of 15.2, 15.3 and the oversized files** — land it with the backfill so the rule change and a green build arrive together. Nothing here changes a pixel.

### 15.1 — `shared/ui` is exempted from Hard Rule 4 and `max-lines` on a premise that stopped being true

**P1 · M · lens 5**
`apps/client/eslint.config.js:22-30`

**Evidence.** Verified in source:

```js
// Shadcn vendored components — exempt from max-lines and JSDoc rules
{
  files: ['src/layers/shared/ui/**/*.{ts,tsx}'],
  rules: { 'max-lines': 'off', 'jsdoc/require-jsdoc': 'off', 'jsdoc/require-description': 'off' },
},
```

The premise in the comment describes maybe 30 of the ~90 files in that directory. The rest are the client's largest hand-written public API: `SidebarRow`, `SidebarMenuNodes`, `IdentityAvatar`, `TrustDial`, `BottomSlot`, `SettingRow`, `PageContainer`, `FieldCard`, `SectionHeader`, `DataTable`, `TabbedDialog`, `NavigationLayout`, `PromptSuggestionChips`, `Feed`, `FilterBar`, `TruncatedOutput`, `BoundedNumberInput`, `PathInput`, `TrustTone`, the five `Responsive*` wrappers — none vendored, all authored here. So Hard Rule 4 ("TSDoc on exports… every jsdoc rule is `error`") and `.claude/rules/conventions.md` ("Required on… public APIs re-exported from barrel `index.ts` files") are switched off over precisely the most-imported public API in `apps/client`. The measurable consequences are 15.2, 15.3, and five files past the 500-line "must split" bar that `max-lines: warn` would have flagged: `sidebar-menu-node.tsx` (1005), `sidebar.tsx` (753), `sidebar-row.tsx` (747), `navigation-layout.tsx` (644), `identity-avatar.tsx` (563).

**Recommendation.** Narrow the carve-out to the files that are genuinely upstream shadcn and kept diff-able against it — list them explicitly rather than globbing the directory (`alert-dialog`, `dialog`, `drawer`, `dropdown-menu`, `context-menu`, `select`, `tabs`, `table`, `command`, `sheet`, `popover`, `hover-card`, `collapsible`, `sidebar`, `input-otp`) — and let Hard Rule 4 apply to everything else. Keep `max-lines` off only for the vendored list; the five oversized bespoke files then surface as `warn`, which is the intended signal, not a build break.

### 15.2 — 63 public `shared/ui` exports carry no TSDoc — the entire overlay and menu family

**P2 · M · lens 5**
`dialog.tsx` (10 exports), `alert-dialog.tsx:6,7,8,10,25,65,77,89,97`, `drawer.tsx:5,13,14,15,17,78,90`, `dropdown-menu.tsx:6,7,8,9,11,33,45,57,80,105,125,147,149`, `context-menu.tsx:7,11,17,25,29,35,59,75,93,116,142,166,183`, `select.tsx:6,7,8,16,37,73`, `tabs.tsx:5,11,26,44`, `switch.tsx:44`, `copy-button.tsx:37`, `sidebar.tsx:44`

**Evidence.** A scripted sweep of every symbol re-exported from `shared/ui/index.ts` found 63 whose declaration has no preceding doc comment. `dialog.tsx` — 20 JSX call sites for `<Dialog>` alone — has no module header and not one component doc, so hovering `<DialogContent>` shows the raw Radix type and nothing about DorkOS's own additions (the close button it injects, the `bg-black/80` overlay, the portal it opens inside). Same for `<SelectTrigger>`, `<DropdownMenuItem>` (25 call sites), `<TabsList>`, `<Switch>`. Priya reads the source; Kai reads the hover; neither gets an answer. The gap maps exactly onto the older generation of files (15.4), which is what makes it fixable in one sweep.

**Recommendation.** One PR per family (dialog + alert-dialog + drawer; dropdown + context-menu; select + tabs + switch), each adding a `@module` header plus a one-line description per export, in the voice `tooltip.tsx:6,20,25,30` and `card.tsx:4,18,25,36,47,54` already use — a sentence about what the part is _for_, not a restatement of its name. Where DorkOS deviates from upstream (Select's `responsive` prop, Dialog's injected close button), say so: that deviation is the only thing a reader cannot get from the shadcn docs.

### 15.3 — Sixteen placeholder TSDoc blocks say nothing

**P2 · S · lens 5**
`label.tsx:6-8`, `checkbox.tsx:9-11`, `separator.tsx:8-10`, `radio-group.tsx:7-9,23-25`, `slider.tsx:6-8`, `field.tsx:8,25,48,85,104,117,135,151,169,202`

**Evidence.** Each is literally `/**\n *\n */` above the declaration. `Label` has 109 JSX call sites. `Field` — ten of the sixteen — is the substrate `SettingRow` is built on and the one every settings surface composes. An empty doc block is worse than none: it occupies the slot a reader's editor shows, it defeats a grep for undocumented exports, and it reads as a fossil of a lint run that no longer applies.

**Recommendation.** Delete all sixteen and write the real sentence, or delete them and let 15.1's un-exempted rule demand one. `Field`'s ten deserve real prose: it is a compound API (`Field`/`FieldContent`/`FieldLabel`/`FieldDescription`/`FieldError`/`FieldGroup`/`FieldLegend`/`FieldSet`/`FieldSeparator`/`FieldTitle`) and which piece goes where is not guessable from the names.

### 15.4 — The library is frozen mid-migration: eight `forwardRef` files, ~20 primitives with no `data-slot`

**P2 · L · lenses 2 + 5**
Old dialect (`React.forwardRef` + `displayName`, no `data-slot`): `alert-dialog.tsx`, `dialog.tsx`, `drawer.tsx`, `dropdown-menu.tsx`, `hover-card.tsx`, `select.tsx`, `switch.tsx`, `tabs.tsx`. New dialect: `button.tsx`, `input.tsx`, `tooltip.tsx`, `scroll-area.tsx`, `card.tsx`, `checkbox.tsx`, `label.tsx`, `separator.tsx`, `skeleton.tsx`, `radio-group.tsx`, `textarea.tsx`, `sheet.tsx`, `popover.tsx`, `collapsible.tsx`, `table.tsx`, `slider.tsx`. Missing `data-slot` on the root: 42 files including `badge.tsx:28`, `setting-row.tsx:41`, `section-header.tsx:277`, `copy-button.tsx:46`, `option-row.tsx:25`, `compact-result-row.tsx:23`, `path-breadcrumb.tsx:33`, `provenance-chip.tsx:83`, `trust-dial.tsx:310`, `feed.tsx:70`, `PromptSuggestionChips.tsx:78`, `ConnectionStatusBanner.tsx:34`, `FeatureDisabledState.tsx:19`, `link-safety-modal.tsx:53`

**Evidence.** Roughly a 30/70 split. `.claude/rules/components.md` tolerates the old dialect ("Existing `forwardRef` in `ui/` is fine; don't add more") but the folder is not converging — it is frozen mid-migration, which AGENTS.md §Quality Standard names directly ("no half-finished migrations"). `data-slot` is not cosmetic: it is the styling and testing seam the newer half is built on. `field.tsx:17,56,70-71,126` selects on `has-[>[data-slot=checkbox-group]]` and `[&>[data-slot=field-label]]`; `sidebar-row.tsx:623` and the sidebar browser tests address `[data-slot="sidebar-row-title"]`; `bar-tab-strip.tsx:164`'s scrollbar hiding is implemented in `index.css` **by `data-slot` selector** because a utility class could not beat the unlayered global (the same rule as 4.1). A primitive without the attribute cannot participate in any of that, and a contributor cannot tell by looking whether the seam exists. The practical cost of the ref split is visible too: `hover-card.tsx:20-26` needed a `forwardRef` for a real reason and had to write a docblock explaining why it differs from _its own file's_ other wrappers — a comment that exists only because the baseline is ambiguous.

**Recommendation.** One migration with a definition of done. Phase 1 (S, additive, no behaviour change): add `data-slot="<kebab-name>"` to each root, and to the sub-parts of `dialog`, `drawer`, `dropdown-menu`, `select` and `tabs`, the four families where every other overlay family already has them. Phase 2 (M): drop `forwardRef`/`displayName` from the eight, since React 19 passes `ref` through props and every one spreads `...props` into a Radix primitive that forwards it; keep `displayName` only where a test asserts it. Phase 3: amend `.claude/rules/components.md` to state the finished shape once and delete the grandfather clause when nothing is left to grandfather. Do not restyle anything.

### 15.5 — Four incompatible size vocabularies, with the same word meaning three different sizes

**P2 · M · lens 5**
`button.tsx:23-32,41-42`, `switch.tsx:5,13-25`, `identity-avatar.tsx:111-119,158-162`, `copy-button.tsx:12,44`, `PromptSuggestionChips.tsx:17,20-22`

**Evidence.** Verified in source:

| Primitive               | Vocabulary                                                      | Default   | Note                                                    |
| ----------------------- | --------------------------------------------------------------- | --------- | ------------------------------------------------------- |
| `Button`                | `xs · sm · default · lg` + `icon · icon-xs · icon-sm · icon-lg` | `default` |                                                         |
| `Switch`                | `sm · default · md · lg`                                        | `default` | `md` (h-6) is **larger** than `default` (h-5)           |
| `IdentityAvatar`        | `xs · sm · md · lg`                                             | `sm`      | no `default` token at all                               |
| `CopyButton`            | `sm · md`                                                       | `sm`      |                                                         |
| `PromptSuggestionChips` | `compact · comfortable`                                         | `compact` | a deliberate, documented third axis — the correct model |

So `md` means "one step above the default" on `Switch`, "the middle of four" on `IdentityAvatar`, and "the big one" on `CopyButton`; `default` exists on two primitives and not the other three; and `IdentityAvatar` silently makes `sm` mean what `default` means everywhere else. A caller writing `<Switch size="md">` next to `<Button size="default">` gets two controls that do not line up, and nothing in either type says why.

**Recommendation.** Settle one ordinal scale — `xs · sm · md · lg` — and make `md` the default everywhere, retiring the token literally named `default`. Rename `Button`'s `default` → `md` and `icon` → `icon-md`, keeping `default`/`icon` as deprecated aliases for one release so 296 call sites do not move in one PR; rename `Switch`'s `default` → `md`, its `md` → `lg`, its `lg` → `xl`; leave `IdentityAvatar` alone (it already speaks the target vocabulary) but say in its `defaultVariants` comment that `sm` is deliberate for the sidebar's 18px slot; give `CopyButton` the full `xs|sm|md` set derived from `Button`'s icon sizes. Where a primitive's axis genuinely is not "how big", keep a named pair like `compact|comfortable` and document why, as `PromptSuggestionChips` does. No visual change ships with the rename.

### 15.6 — `responsive` is one prop name with three behaviours, and the 44px floor is spelled five ways

**P2 · M · lenses 2 + 5**
`button.tsx:44-59,64,73,85`, `input.tsx:5-6,17`, `select.tsx:10-14,24,67-71,81`, `tabs.tsx:7-9,17`, `switch.tsx:28-32,36-46`; absent from `checkbox.tsx`, `radio-group.tsx`, `textarea.tsx`, `slider.tsx`; the shared constant at `touch-target.ts:24`, consumed by `sidebar-row.tsx:34,124`, `sidebar-menu-node.tsx:38,214`, `bottom-slot.tsx:24,50`, `dashboard-sidebar/ui/{NewMenu.tsx:397,SidebarSearchPill.tsx:40,SidebarHeaderBlock.tsx:154,TodayZone.tsx:183,SidebarFooterMenu.tsx:55}`

**Evidence.** Three problems in one prop. (1) **Composition differs.** On `Button`, `Input` and `Select`, `responsive` composes with `size` (`RESPONSIVE_SIZE_CLASSES[size ?? 'default']` applied on top). On `Switch` it does the opposite — `const isResponsive = responsive && size === undefined;` — so `<Switch size="sm" responsive />` silently does nothing. The TSDoc is honest about it, but a prop that is a no-op under a condition the caller must remember is a coin flip with an invisible failure. (2) **Coverage is partial.** `Checkbox` (`size-4`), `RadioGroupItem` (`size-4`) and `Textarea` have no `responsive` prop at all, so a form built from `TextField` + `CheckboxField` + `SwitchField` grows its inputs on a phone and leaves its checkboxes at 16px. (3) **The floor has five spellings.** `touch-target.ts` exists precisely to spell it once — its doc says "One constant because the bar is one number… A shared name is what makes the next such control obvious in a diff" — and eight call sites use it, while the four primitives that most need it hardcode `h-11 md:h-9` / `size-11 md:size-9` in private tables, and `SIDEBAR_ROW_HEIGHT`/`SECTION_HEADER_HEIGHT` answer the same question a third way with a `{ fine, coarse }` record. `SelectItem`'s 44px equivalent is expressed as _padding_ while `SelectTrigger`'s is a _height_, so a compact select is compact in one half and not the other. `button.tsx:47-52` explains why it chose the CSS `md:` gate, which is a good comment — but it is a comment on one file, not a rule anyone can find from `touch-target.ts`.

**Recommendation.** Make `responsive` mean one thing everywhere: "grow this control's touch target below `md`", composing with `size` on every primitive that has it. On `Switch` that means picking the next size up (`TRACK_SIZES[nextUp(resolvedSize)]` below `md:`) rather than substituting a fixed pair. Add the prop to `Checkbox`, `RadioGroupItem` and `Textarea` with the same default so the form-field family behaves as one; where a primitive genuinely cannot grow, say so in its TSDoc so absence reads as a decision. Publish `TOUCH_TARGET_RESPONSIVE_H = 'h-11 md:h-9'` and its `size-` sibling beside `TOUCH_TARGET_MIN_H`, have the four primitives compose from it, and extend `touch-target.ts`'s module doc to state the rule once: the CSS `md:` form is for a primitive whose height is decided in CSS, the `isMobile &&` form is for a surface that already has the hook in hand, and both spend 44px. Consider renaming the axis `density: 'touch' | 'compact'` — `responsive={false}` appears six times in `filter-bar/` alone, always meaning "this is chrome, not a target", which is a named density, not a negation. No pixel moves.

### 15.7 — ~25 components' `*Props` types never reach the barrel, and four `{@link}`s point at nothing

**P2 · M · lens 5**
Unexported props types: `responsive-dialog.tsx:45` (33 call sites), `responsive-popover.tsx:33`, `responsive-sheet.tsx`, `responsive-dropdown-menu.tsx:27` (+3), `responsive-context-menu.tsx:38` (+2), `navigation-layout.tsx` (all nine), `copy-button.tsx:4`, `option-row.tsx:3`, `compact-result-row.tsx:1`, `truncated-output.tsx:7`, `feed.tsx:10`, `linkified-text.tsx:223`, `markdown-content.tsx`, `markdown-link.tsx`, `path-breadcrumb.tsx:3`, `progress.tsx`, `bar-tab-strip.tsx`, `sidebar-menu-node.tsx:540,880`, `sonner.tsx`, `DirectoryPicker.tsx:50`, `FeatureDisabledState.tsx:4`, `ScanLine.tsx:3`, `ConnectionStatusBanner.tsx`, `markdown-error-boundary.tsx:3`. Dangling links: `sidebar-row.tsx:257` → `SidebarMenuSurfaceProps`, `:95` → `SIDEBAR_MENU_GUTTER`, `:722` → `SIDEBAR_MENU_ITEM_ATTRS`, `feed.tsx:33` → `FeedBeyondRenderedHandler`

**Evidence.** `.claude/rules/fsd-layers.md` mandates barrel-only imports and a deep import is an ESLint `error`, so a consumer who wants `function MyDialog(props: ResponsiveDialogProps)`, or a typed `DataTableGrouping` factory, has two options: redeclare the shape by hand, or reach for `React.ComponentProps<typeof X>` and hope the component is not destructuring away props it does not forward. The library is inconsistent about it — `ButtonProps`, `InputProps`, `SwitchProps`, `BannerProps`, `PageContainerProps`, `SettingRowProps`, `DataTableProps`, `SidebarRowProps` and ~15 others _are_ on the barrel — so the omissions read as accidents rather than encapsulation. Meanwhile `sidebar-row.tsx:257` writes `{@link SidebarMenuSurfaceProps.onMenuIntent}`, a link that resolves to nothing outside the directory.

**Recommendation.** Add the missing `export type` lines to `shared/ui/index.ts` — mechanical and zero-risk. Export `DataTableGrouping` alongside `DataTableProps` (it is the type of a public prop) and `SidebarMenuSurfaceProps` alongside `SidebarMenuSurface`. Fix the four dangling links: two by exporting their targets, `feed.tsx:33` by qualifying it as coming from `shared/model`. Consider a small vitest guard that fails when a barrel-exported component's `*Props` interface is not also exported, so the class cannot regrow.

### 15.8 — Six visual leaves accept no `className`, and two siblings extracted in the same change disagree about it

**P2 · S · lenses 2 + 5**
`compact-result-row.tsx:1-12,23-26`, `option-row.tsx:3-14,25-31`, `path-breadcrumb.tsx:3-12,33`, `settings-panel.tsx:4-12`, `FeatureDisabledState.tsx:4`, `trust-dial.tsx:169`; contrast `truncated-output.tsx:12`

**Evidence.** `.claude/rules/components.md` states the rule — "`cn()` … for all conditional/merged classes; caller `className` goes last so it can override" — and it holds across most of the library. The sharpest evidence is a pair extracted in the same change and exported from adjacent barrel lines (`index.ts:385-388`): `truncated-output.tsx:12` documents the contract (`/** Chrome for the wrapper — margins, borders. The caller owns it. */`), while `compact-result-row.tsx:24` hardcodes its whole surface (`bg-muted/50 rounded-msg-tool shadow-msg-tool border px-3 py-1 …`) and works around the omission with an index-signature hack (``[key: `data-${string}`]: string | undefined``) so that _only_ data attributes get through. `OptionRow` takes `isSelected`, `isFocused`, `control`, `children` and a `'data-selected'?: boolean` — nothing else, so the caller cannot pass a margin, a `data-testid`, a ref or an `id`, and `isSelected` + `data-selected` is the same fact taken twice. `PathBreadcrumb` has neither `className` nor a spread and builds its classes with template literals, so `cn()`/tailwind-merge never runs. Both `CompactResultRow` and `OptionRow` are drawn by two different surfaces (the transcript and the Ask card, per the barrel's own comment), and neither surface can give them a margin. A shared leaf that cannot be positioned by its host is the leaf the next host copy-pastes instead of importing.

**Recommendation.** Give all six `React.ComponentProps<'div'>` (or `'span'`) with `className` last in the `cn()` and `{...props}` on the root. Delete `CompactResultRow`'s index-signature workaround and `OptionRow`'s duplicate `data-selected` (derive it from `isSelected`); replace `PathBreadcrumb`'s template literals with `cn()`. `SettingsPanel` should forward it too — it is a `NavigationLayoutPanel` wrapper and the panel takes one. Copy `TruncatedOutput`'s one-line prop doc as the wording.

### 15.9 — `cn` is imported three ways, and the mandated spelling drags the transport into a leaf primitive

**P2 · M · lens 5**
`@/layers/shared/lib/utils` in 30 files, `../lib/utils` in 24 (including `badge.tsx:3`, `card.tsx:2`, `switch.tsx:3`, `select.tsx:4`, `dialog.tsx:4` — verified), `@/layers/shared/lib` (the barrel) in 27; supporting evidence at `apps/client/src/layers/shared/lib/index.ts:287-291`

**Evidence.** `.claude/rules/fsd-layers.md` §Import Conventions says two things — always the `@/` alias, always the module's `index.ts` — and only 27 of 81 files obey both. But obeying both has a cost the barrel itself documents: `shared/lib/index.ts:287` explains that `overnightBoundary` is deliberately _not_ re-exported because one of its callers "a source-level contract forbids from value-importing this barrel at all (it pulls in the transport, the sound player and a dozen other side effects)". The barrel is 298 lines re-exporting ~150 symbols from ~60 modules, including `HttpTransport`, `playCelebration`, `CelebrationEngine` and `queryClient`. So `import { cn } from '@/layers/shared/lib'` inside a 20-line `OptionRow` pulls a module graph that has nothing to do with class merging — very likely why 24 files quietly reach for `../lib/utils`. Three spellings of the most-imported helper in the client is a coin flip on every new file, and the "correct" one per the written rule is the one with a side-effect cost the same codebase elsewhere treats as disqualifying.

**Recommendation.** Decide once and enforce once. The defensible answer for `shared/ui` internals is the **leaf module path** — `@/layers/shared/lib/utils` — because it is side-effect-free, still the `@/` alias, and already the plurality. Normalise all 81 files, then amend `.claude/rules/fsd-layers.md` with the carve-out in one sentence: _within `shared/`, import leaf modules directly; the barrel is the contract for consumers in `entities/`, `features/` and `widgets/`._ A `no-restricted-imports` rule scoped to `src/layers/shared/**` can hold it. Splitting `shared/lib`'s barrel so a value import does not reach the transport is worth doing, but it is its own spec.

### 15.10 — `CopyButton`'s documentation is attached to the wrong function, and its `<button>` has no `type`

**P2 · S · lens 5**
`apps/client/src/layers/shared/ui/copy-button.tsx:15-22,37,46`

**Evidence.** The file has two doc blocks one function apart: the paragraph explaining the component ("Icon button that copies a string to the clipboard with timed inline feedback…", including the non-obvious fact that its defaults are tuned for Settings dialogs) sits above `CopyButtonIcon`, immediately followed by the icon's own one-liner — which wins in an editor. The exported `CopyButton` (13 call sites) documents nothing. Separately, `:46` renders a bare `<button>` with no `type`, so it would submit any form it lands in.

**Recommendation.** Move the `:15-21` block down onto `CopyButton` at `:37`, leave the icon's one-liner where it is, add `type="button"`, and export `CopyButtonProps` from the barrel (15.7).

### 15.11 — `input-otp.tsx` is dead code with a live dependency

**P2 · S · lens 5**
`apps/client/src/layers/shared/ui/input-otp.tsx`, `apps/client/package.json:74`

**Evidence.** Verified: it is the only file in `shared/ui` not re-exported from `index.ts`, a repo-wide grep for `InputOTP`/`input-otp` outside the file itself returns nothing, and `input-otp@^1.5.0` is still a runtime dependency. AGENTS.md §Quality Standard: "no dead code… when something is superseded, remove it." It is also a trap — the one file whose only importable path is a deep import, which ESLint rejects, so the next contributor who finds it must modify the barrel before using it and cannot tell whether the omission was deliberate.

**Recommendation.** Delete the file and drop the dependency. If OTP entry lands on the roadmap, the shadcn generator re-adds it in one command when a caller exists.

### 15.12 — The `entities/session` barrel publishes two hooks that share a name upstream

**P2 · S · lens 5**
`apps/client/src/layers/entities/session/index.ts:38-39,65-76`

**Evidence.** `export { useSessionStatus } from './model/use-session-status';` at `:38`, and inside the session-chat-store block at `:69`, `useSessionStatus as useSessionChatStatus`. Two different hooks, both named `useSessionStatus` in their own modules, both on one barrel, distinguished only by an alias — and nothing on the barrel says what the difference is (one reads the session's server-side status, the other the per-session chat store's). Autocomplete offers both with identical prefixes. This barrel is otherwise exemplary, carrying a genuine comment for nearly every non-obvious export; the one place a reader is most likely to pick the wrong symbol is the one place with no note.

**Recommendation.** Add a two-line comment above the alias saying which question each hook answers, in the voice the rest of the file uses. Better still, rename at the source — `useSessionChatStatus` in `session-chat-store.ts` and `useSessionServerStatus` in `use-session-status.ts` — so the alias disappears and the barrel is a straight re-export.

### 15.13 — `Button` and ~20 bare `<button>`s in `shared/ui` do not default `type="button"`

**P3 · S · lens 5**
`apps/client/src/layers/shared/ui/button.tsx:76-89`; bare elements with no `type`: `copy-button.tsx:46`, `truncated-output.tsx:48`, `path-breadcrumb.tsx:59`, `link-safety-modal.tsx:93`, `navigation-layout.tsx:343`, `responsive-dropdown-menu.tsx:262,334`, `route-error-fallback.tsx:65`, `app-crash-fallback.tsx:87,105`, `DirectoryPicker.tsx` (11 sites)

**Evidence.** `Button` renders `<Comp data-slot="button" …>` with no default `type`, so an HTML `<button>` inside a `<form>` defaults to `type="submit"`. A scripted check found **no** current instance of a `Button` inside a `<form>` without an explicit type — 15 call sites write `type="submit"` deliberately and the 39 `<form>` elements are clean — so nothing is broken today. It is "hard to misuse" failing preventively: the next `<Button onClick={…}>` added inside a form submits it silently, and the bug presents as "the dialog closes when I click Cancel".

**Recommendation.** Default `type` in `Button` when it renders a real `<button>`: `{...(asChild ? {} : { type: props.type ?? 'button' })}`, leaving `asChild` alone (the slotted child owns its element). Add `type="button"` to the bare elements listed. Keep the 15 explicit `type="submit"` call sites exactly as they are — they mean it.

### 15.14 — The public "work is happening" animation is named after an unrelated product surface

**P3 · M · lens 5**
`apps/client/src/index.css:841-875` (`@keyframes tasks`, `@utility animate-tasks`), `apps/client/src/layers/shared/ui/skeleton.tsx:8`

**Evidence.** `Skeleton` — 112 JSX call sites, the client's second most-used primitive — is `cn('bg-accent animate-tasks rounded-md', className)`. The CSS comment calls it "The 'work is happening' breath, worn by ~20 call sites (ThinkingBlock, MemoryRecallBlock, loading skeletons, connection dots)" and explains at length why it is opacity-only. The name says none of that, and "tasks" is already the name of a product surface (`/tasks`, `entities/tasks`, Pulse schedules), so a reader of `skeleton.tsx:8` reasonably concludes the skeleton is task-related. A class name is API; this one is used across three layers and actively misleads about both what it does and what domain it belongs to.

**Recommendation.** Rename the keyframe and utility to `breath`/`animate-breath` — it is already described as "a faster, quieter cousin of `breathe`" — move the explanatory comment with it, and update the ~20 call sites in one mechanical PR. Keep `animate-tasks` as an alias for one release only if an e2e selector depends on the class string; otherwise delete it.
