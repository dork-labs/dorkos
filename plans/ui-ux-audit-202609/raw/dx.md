# Lens 5 — DX (developer experience of `shared/ui` and entity public APIs)

Auditor brief: is each shared primitive easy to use correctly and hard to misuse? Missing/wrong TSDoc,
unclear prop names, required props that could default, missing ref/`className` passthrough, inconsistent
size/variant vocabulary, confusing barrel exports, error messages.

## Coverage

**Read in full or in the parts that carry the public API (37 files in `apps/client/src/layers/shared/ui/`):**
`index.ts`, `button.tsx`, `badge.tsx`, `input.tsx`, `label.tsx`, `textarea.tsx`, `checkbox.tsx`,
`radio-group.tsx`, `switch.tsx`, `select.tsx`, `separator.tsx`, `skeleton.tsx`, `kbd.tsx`,
`inline-code.tsx`, `card.tsx`, `tooltip.tsx`, `scroll-area.tsx`, `dialog.tsx` (head),
`responsive-dialog.tsx` (head), `responsive-popover.tsx` (head), `field-card.tsx`, `setting-row.tsx`,
`page-container.tsx`, `copy-button.tsx`, `option-row.tsx`, `compact-result-row.tsx`,
`truncated-output.tsx`, `data-table.tsx`, `settings-panel.tsx`, `feed.tsx`, `filter-bar/index.ts`,
`touch-target.ts`, `banner.tsx`, `PromptSuggestionChips.tsx`, `identity-avatar.tsx` (variant block),
`sidebar-row.tsx` (prop block), `sidebar-menu-node.tsx` (prop block).

**Mechanically swept across all ~90 `shared/ui` files** (scripted, results cited in findings): empty TSDoc
blocks; undocumented public exports; `data-slot` presence; `forwardRef`/`displayName` generation; `*Props`
types missing from the barrel; components with no `className` prop; `cn` import spelling; bare `<button>`
without `type`; dangling `{@link}` targets; files not reachable from the barrel; file sizes.

**Entity layer (honest sample):** all 26 `entities/*/index.ts` module headers; `entities/session/index.ts`
(161 lines) read in full; `entities/room`, `agent`, `config`, `attention`, `runtime` headers skimmed. A
repo-wide sweep for undocumented `export const`/`export function` found only 7 in `entities/` and 7 in
`features/` — the entity layer's TSDoc discipline is genuinely strong and is **not** a finding.

**Ground truth read:** `plans/ui-ux-audit-202609/00-charter.md`, `contributing/design-system.md`
(§Components, §Responsive Components, §Identity, §Sidebar), `.claude/rules/fsd-layers.md`,
`.claude/rules/components.md`, `.claude/rules/conventions.md`, `AGENTS.md`, `packages/eslint-config/base.js`,
`apps/client/eslint.config.js`, ADR-0008, ADR-0097.

**Skipped / not examined:** `features/**` and `widgets/**` internal APIs (out of lens); the dev playground
(lens 6); runtime behaviour, visuals, copy wording, a11y semantics (lenses 1, 7–11); `shared/model`
and `shared/lib` beyond their barrels; the Obsidian `DirectTransport` surface; `apps/e2e` helpers.

**Import-frequency basis for "most-used" (JSX occurrence counts across `apps/client/src`):** Button 296,
Skeleton 112, Label 109, IdentityAvatar 88, Badge 88, FieldCard 56, Tooltip 52, SidebarRow 39,
SectionHeader 37, TrustDial 35, Select 34, ResponsiveDialogContent 33, Switch 29, Kbd 28, SettingRow 27,
PageContainer 25, DropdownMenuItem 25, MarkdownContent 23, Dialog 20, CommandItem 20, Collapsible 18,
Banner 17, Separator 16, FilterBar 16, Table 14, ScrollArea 14, MentionPill 13, CopyButton 13, Sheet 10,
Popover 9, PasswordInput 9, InlineCode 7, Checkbox 7, Input 6, DataTable 5.

---

## Findings

### [P1/M] `shared/ui` is exempted from Hard Rule 4 and from `max-lines` on a premise that stopped being true

**Files:** `apps/client/eslint.config.js:22-30`

**Current state.** The client's ESLint config turns off `jsdoc/require-jsdoc`, `jsdoc/require-description`
and `max-lines` for **every file under `src/layers/shared/ui/`**:

```js
// apps/client/eslint.config.js:22
  // Shadcn vendored components — exempt from max-lines and JSDoc rules
  {
    files: ['src/layers/shared/ui/**/*.{ts,tsx}'],
    rules: {
      'max-lines': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-description': 'off',
    },
  },
```

**Why it falls short.** The premise in the comment — "Shadcn vendored components" — describes maybe 30 of
the ~90 files in that directory. The rest are the client's largest hand-written public API: `SidebarRow`,
`SidebarMenuNodes`, `IdentityAvatar`, `TrustDial`, `BottomSlot`, `SettingRow`, `PageContainer`, `FieldCard`,
`SectionHeader`, `DataTable`, `TabbedDialog`, `NavigationLayout`, `PromptSuggestionChips`, `Feed`,
`FilterBar`, `TruncatedOutput`, `BoundedNumberInput`, `PathInput`, `TrustTone`, the five `Responsive*`
wrappers — none of them vendored, all of them authored here. AGENTS.md Hard Rule 4 ("TSDoc on exports…
every jsdoc rule is `error`") and `.claude/rules/conventions.md` ("Required on… public APIs re-exported from
barrel `index.ts` files") are therefore switched off over precisely the most-imported public API in
`apps/client`. The measurable consequences are findings 2, 3 and the file sizes below:

- 63 public exports with no TSDoc at all (finding 2)
- 16 placeholder `/**\n *\n */` blocks that would fail `jsdoc/require-description` anywhere else (finding 3)
- five files past the 500-line "must split" bar that `max-lines: warn` would have flagged:
  `sidebar-menu-node.tsx` (1005), `sidebar.tsx` (753), `sidebar-row.tsx` (747), `navigation-layout.tsx`
  (644), `identity-avatar.tsx` (563)

**Recommendation.** Narrow the carve-out to the files that are genuinely upstream shadcn and are kept
diff-able against it — list them explicitly rather than globbing the directory, e.g.
`files: ['src/layers/shared/ui/{alert-dialog,dialog,drawer,dropdown-menu,context-menu,select,tabs,table,command,sheet,popover,hover-card,collapsible,sidebar,input-otp}.tsx']`
— and let Hard Rule 4 apply to everything else. Land it with the backfill in findings 2 and 3 so the rule
change and the green build arrive together. Keep `max-lines` off only for the vendored list; the five
oversized bespoke files then surface as `warn`, which is the intended signal, not a build break.

---

### [P2/M] 63 public `shared/ui` exports carry no TSDoc — the entire overlay and menu family

**Files:** `apps/client/src/layers/shared/ui/dialog.tsx` (10 exports: `:6,7,8,9,11,26,72,84` + header/footer),
`alert-dialog.tsx:6,7,8,10,25,65,77,89,97`, `drawer.tsx:5,13,14,15,17,78,90`,
`dropdown-menu.tsx:6,7,8,9,11,33,45,57,80,105,125,147,149`,
`context-menu.tsx:7,11,17,25,29,35,59,75,93,116,142,166,183`, `select.tsx:6,7,8,16,37,73`,
`tabs.tsx:5,11,26,44`, `switch.tsx:44`, `copy-button.tsx:37`, `sidebar.tsx:44`

**Current state.** A scripted sweep of every symbol re-exported from `shared/ui/index.ts` found 63 whose
declaration has no preceding doc comment. `dialog.tsx` — 20 JSX call sites for `<Dialog>` alone — has no
module header and not one component doc. Hovering `<DialogContent>` in an editor shows the raw Radix type
and nothing about DorkOS's own additions (the close button it injects, the `bg-black/80` overlay, the
portal it opens inside). Same for `<SelectTrigger>`, `<DropdownMenuItem>` (25 call sites),
`<TabsList>`, `<Switch>`.

**Why it falls short.** AGENTS.md's Quality Standard: "API surfaces are clean, types precise… internals must
survive the scrutiny of an architect who reads source code before adopting tools." Priya reads the source;
Kai reads the hover. Neither gets an answer today. The gap is not random — it maps exactly onto the older
generation of files (finding 4), which is what makes it fixable in one sweep rather than one file at a time.

**Recommendation.** One PR per family (dialog+alert-dialog+drawer; dropdown+context-menu; select+tabs+switch),
each adding a `@module` header plus a one-line description per export, following the voice already used in
`tooltip.tsx:6,20,25,30` and `card.tsx:4,18,25,36,47,54` — a sentence about what the part is _for_, not a
restatement of its name. Where DorkOS deviates from upstream shadcn (Select's `responsive` prop, Dialog's
injected close button), say so in the doc: that deviation is the only thing a reader cannot get from the
shadcn docs.

---

### [P2/S] Sixteen placeholder TSDoc blocks in `shared/ui` say nothing

**Files:** `apps/client/src/layers/shared/ui/label.tsx:6-8`, `checkbox.tsx:9-11`, `separator.tsx:8-10`,
`radio-group.tsx:7-9` and `:23-25`, `slider.tsx:6-8`, `field.tsx:8,25,48,85,104,117,135,151,169,202`
(one more outside the lens: `shared/lib/celebrations/celebration-engine.ts:19`)

**Current state.** Each is literally:

```tsx
// label.tsx:6
/**
 *
 */
function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
```

`Label` has 109 JSX call sites. `Field` — ten of the sixteen — is the substrate `SettingRow` is built on
and the one every settings surface composes.

**Why it falls short.** An empty doc block is worse than none: it occupies the slot a reader's editor shows,
it defeats a grep for undocumented exports, and it signals that the doc requirement is a box to tick. It also
reads as a fossil of a lint run that no longer applies (finding 1) — nobody wrote these on purpose.

**Recommendation.** Delete all sixteen and write the real sentence, or delete them and let finding 1's
un-exempted lint rule demand one. `Field`'s ten deserve real prose: it is a compound API
(`Field`/`FieldContent`/`FieldLabel`/`FieldDescription`/`FieldError`/`FieldGroup`/`FieldLegend`/`FieldSet`/
`FieldSeparator`/`FieldTitle`) and which piece goes where is not guessable from the names.

---

### [P2/L] `shared/ui` ships two shadcn generations side by side, and half the library has no `data-slot`

**Files:** old generation (`React.forwardRef` + `displayName`, no `data-slot`) —
`alert-dialog.tsx`, `dialog.tsx`, `drawer.tsx`, `dropdown-menu.tsx`, `hover-card.tsx`, `select.tsx`,
`switch.tsx`, `tabs.tsx`. New generation (plain function + `data-slot`) — `button.tsx:80`, `input.tsx:14`,
`tooltip.tsx:13,22,27,40`, `scroll-area.tsx:19,25,48,59`, `card.tsx:8,21,29,41,50,58`, `checkbox.tsx:15`,
`label.tsx:12`, `separator.tsx:19`, `skeleton.tsx:7`, `radio-group.tsx:16,32,40`, `textarea.tsx:9`.
42 files carry no `data-slot` anywhere, including `badge.tsx`, `dialog.tsx`, `dropdown-menu.tsx`,
`select.tsx`, `switch.tsx`, `tabs.tsx`, `drawer.tsx`, `sonner.tsx`, `section-header.tsx`, `setting-row.tsx`.

**Current state.** `.claude/rules/components.md` §Required Patterns is unambiguous: shadcn primitives get
`data-slot="component-name"` on the root and, for refs, "React 19 refs: `ref` is a regular prop — new
components take `ref` in props, no `forwardRef`. Existing `forwardRef` in `ui/` is fine; don't add more."
So the rule already anticipates the split and freezes it. What it does not say is that the split is also a
`data-slot` split, which is the half that has downstream consequences: `data-slot` is the stable hook that
CSS descendant selectors and Playwright locators use, and a contributor adding one to a new component
cannot tell whether the sibling they are matching has one.

**Why it falls short.** "Consistency is a feature; diverging needs justification" (AGENTS.md). Two idioms in
one 90-file directory means every new primitive starts with a coin flip, and the answer differs depending on
which neighbour the author opened first. The `forwardRef` half is also the undocumented half (finding 2) and
the un-`data-slot`ted half, so the three defects compound into one "old wing of the building".

**Recommendation.** Treat it as one migration with a definition of done, not an open-ended preference.
Phase 1 (S, safe): add `data-slot` to the eight old-generation files — additive, no behaviour change, and it
is what lets a future selector rewrite happen at all. Phase 2 (M): drop `forwardRef`/`displayName` from those
eight, since React 19 passes `ref` through props and every one of them spreads `...props` into a Radix
primitive that forwards it; keep `displayName` only where a test asserts it. Phase 3: amend
`.claude/rules/components.md` to state the finished shape once, and delete the "existing `forwardRef` is
fine" grandfather clause when nothing is left to grandfather. Do **not** restyle anything — this is a
mechanics change, and Calm Tech is untouched by it.

---

### [P2/M] Four incompatible size vocabularies across the primitives, with the same word meaning different sizes

**Files:** `apps/client/src/layers/shared/ui/button.tsx:23-32` and `:41-42`, `switch.tsx:5,13-25`,
`identity-avatar.tsx:111-119,158-162`, `copy-button.tsx:12,44`, `PromptSuggestionChips.tsx:17,20-22`

**Current state.**

| Primitive               | Vocabulary                                                      | Default   | Notes                                                                  |
| ----------------------- | --------------------------------------------------------------- | --------- | ---------------------------------------------------------------------- |
| `Button`                | `xs · sm · default · lg` + `icon · icon-xs · icon-sm · icon-lg` | `default` | `button.tsx:41`                                                        |
| `Switch`                | `sm · default · md · lg`                                        | `default` | `md` (h-6) is **larger** than `default` (h-5) — `switch.tsx:13-18`     |
| `IdentityAvatar`        | `xs · sm · md · lg`                                             | `sm`      | no `default` token at all — `identity-avatar.tsx:116-119,159`          |
| `CopyButton`            | `sm · md`                                                       | `sm`      | `copy-button.tsx:12`                                                   |
| `PromptSuggestionChips` | `compact · comfortable`                                         | `compact` | a deliberate, documented third axis — `PromptSuggestionChips.tsx:8-17` |

So `md` names "one step above the default" on `Switch`, "the middle of four" on `IdentityAvatar`, and "the
big one" on `CopyButton`; `default` exists on two primitives and not on the other three; and `IdentityAvatar`
silently makes `sm` mean what `default` means everywhere else.

**Why it falls short.** A caller writing `<Switch size="md">` next to `<Button size="default">` gets two
controls that do not line up, and nothing in either type tells them why. This is the textbook "easy to use
incorrectly" shape the lens exists to catch. `PromptSuggestionChips` is the counter-example and should be
read as the model: it uses a _different_ word pair precisely because its axis is a different question, and
its TSDoc says so.

**Recommendation.** Settle one ordinal scale — `xs · sm · md · lg` — and make `md` the default everywhere,
retiring the token literally named `default`. Concretely: rename `Button`'s `default` → `md` and
`icon` → `icon-md` (keeping `default`/`icon` as deprecated aliases for one release so 296 call sites do not
have to change in one PR); rename `Switch`'s `default` → `md` and its current `md` → `lg`, its `lg` → `xl`;
leave `IdentityAvatar` alone (it already speaks the target vocabulary) but change its
`defaultVariants.size` comment to say `sm` is deliberate for the sidebar's 18px slot; give `CopyButton` the
full `xs|sm|md` set derived from `Button`'s icon sizes instead of a private two-value union. Where a
primitive's axis genuinely is not "how big", keep a named pair like `compact|comfortable` and document why,
as `PromptSuggestionChips` does. No visual change ships with the rename — this is vocabulary only.

---

### [P2/S] `responsive` is one prop name with two behaviours, and it is missing from half the form controls

**Files:** `apps/client/src/layers/shared/ui/switch.tsx:36-46`, `button.tsx:64,73,85`, `input.tsx:6,17`,
`select.tsx:13,24` and `:70,81`; absent from `checkbox.tsx`, `radio-group.tsx`, `textarea.tsx`, `slider.tsx`

**Current state.** On `Button`, `Input` and `Select`, `responsive` composes with `size`:
`button.tsx:85` applies `RESPONSIVE_SIZE_CLASSES[size ?? 'default']` on top of whatever size was chosen.
On `Switch` it does the opposite — `switch.tsx:46` reads
`const isResponsive = responsive && size === undefined;` — so `<Switch size="sm" responsive />` silently
does nothing at all. The prop's own TSDoc (`switch.tsx:36-41`) does say "When true and no explicit size is
given", which is honest, but the shape is still a prop that is a no-op under a condition the caller has to
remember. Meanwhile `Checkbox` (`size-4`, 7 call sites), `RadioGroupItem` (`size-4`) and `Textarea` have no
`responsive` prop, so a form built from `TextField` + `CheckboxField` + `SwitchField` grows its inputs on a
phone and leaves its checkboxes at 16px.

**Why it falls short.** The lens test is "hard to misuse". A boolean that is honoured on three primitives,
conditionally ignored on a fourth, and unrecognised on three more is a coin flip at every call site, and the
failure is invisible — nothing warns, the control is just small.

**Recommendation.** Make `responsive` mean one thing: "grow this control's touch target below `md`",
composing with `size` on every primitive that has it. On `Switch` that means picking the next size up rather
than substituting a fixed pair — `TRACK_SIZES[nextUp(resolvedSize)]` below `md:`. Add the prop to
`Checkbox`, `RadioGroupItem` and `Textarea` with the same default (`true`) so the form-field family behaves
as one. If a primitive genuinely cannot grow, say so in its TSDoc instead of omitting the prop, so absence
reads as a decision rather than an oversight.

---

### [P2/M] The 44px touch floor is expressed two ways, and the primitives use the one that is not the shared constant

**Files:** `apps/client/src/layers/shared/ui/touch-target.ts:24`, `button.tsx:44-59`, `input.tsx:17`,
`select.tsx:24,81`, `switch.tsx:28-32`; consumers of the constant —
`sidebar-row.tsx:34,124`, `sidebar-menu-node.tsx:38,214`, `bottom-slot.tsx:24,50`,
`features/dashboard-sidebar/ui/{NewMenu.tsx:397,SidebarSearchPill.tsx:40,SidebarHeaderBlock.tsx:154,TodayZone.tsx:183,SidebarFooterMenu.tsx:55}`

**Current state.** `touch-target.ts` exists precisely to spell the floor once — its own doc says "One
constant because the bar is one number… A shared name is what makes the next such control obvious in a
diff" — and eight call sites use it. The four primitives that most need it do not: `Button` hardcodes
`h-11 md:h-9` / `size-11 md:size-9` in a private `RESPONSIVE_SIZE_CLASSES` map, `Input` hardcodes
`h-11 md:h-9`, `SelectTrigger` the same, `Switch` a third private table. The two mechanisms also gate
differently: the constant is applied behind the JS `useIsMobile()` hook at its call sites, the primitives
behind the CSS `md:` variant. `button.tsx:47-52` explains why _it_ chose CSS, which is a good comment — but
it is a comment on one file, not a rule anyone can find from `touch-target.ts`.

**Why it falls short.** Two expressions of one number is exactly the drift the constant was created to
prevent, and a contributor adding a new primitive has to read four files to learn which one is canonical.

**Recommendation.** Keep both mechanisms (they answer different questions) but make the relationship
explicit and derive one from the other. Publish a second constant beside `TOUCH_TARGET_MIN_H` —
`TOUCH_TARGET_RESPONSIVE_H = 'h-11 md:h-9'` and its `size-` sibling — and have `Button`, `Input`,
`SelectTrigger` and `Switch` compose from it instead of from private literals. Extend
`touch-target.ts`'s module doc to state the rule in one place: the CSS `md:` form is for a primitive whose
height is decided in CSS, the `isMobile &&` form is for a surface that already has the hook in hand, and
both spend 44px. No pixel moves.

---

### [P2/S] `CopyButton`'s documentation is attached to the wrong function

**Files:** `apps/client/src/layers/shared/ui/copy-button.tsx:15-22,37`

**Current state.** The file has two doc blocks and they are one function apart:

```tsx
// copy-button.tsx:15
/**
 * Icon button that copies a string to the clipboard with timed inline feedback.
 * ...
 */
/** The button's icon: a check on success, an X on failure, the bare glyph otherwise. */
function CopyButtonIcon({ ... }) { ... }
...
// copy-button.tsx:37 — the exported component, no doc block
export function CopyButton({ value, label = 'Copy to clipboard', className, size = 'sm' }: CopyButtonProps) {
```

Two consecutive comments sit above `CopyButtonIcon`; the second wins in an editor, and the exported
`CopyButton` (13 call sites) documents nothing.

**Why it falls short.** The one paragraph that explains the component — including the non-obvious fact that
its defaults are tuned for Settings dialogs — is invisible at every call site and misattached at the one
place it does show.

**Recommendation.** Move the `:15-21` block down onto `CopyButton` at `:37`, leave the icon's own one-liner
where it is, and export `CopyButtonProps` from the barrel (finding 9). While in the file: `CopyButton`
renders a bare `<button>` with no `type` (`:46`), so it would submit any form it lands in — add
`type="button"`.

---

### [P2/M] ~25 components' `*Props` types never reach the barrel, and four `{@link}`s point at nothing

**Files (props types declared but not exported from `shared/ui/index.ts`):**
`responsive-dialog.tsx:45` (`ResponsiveDialogProps` — 33 `ResponsiveDialogContent` call sites),
`responsive-popover.tsx:33`, `responsive-sheet.tsx`, `responsive-dropdown-menu.tsx:27` (+3 sub-props),
`responsive-context-menu.tsx:38` (+2), `navigation-layout.tsx` (all nine `NavigationLayout*Props`),
`copy-button.tsx:4`, `option-row.tsx:3`, `compact-result-row.tsx:1`, `truncated-output.tsx:7`,
`feed.tsx:10`, `linkified-text.tsx:223`, `markdown-content.tsx`, `markdown-link.tsx`,
`path-breadcrumb.tsx:3`, `progress.tsx`, `bar-tab-strip.tsx`, `sidebar-menu-node.tsx:540,880`,
`sonner.tsx`, `DirectoryPicker.tsx:50`, `FeatureDisabledState.tsx:4`, `ScanLine.tsx:3`,
`ConnectionStatusBanner.tsx`, `markdown-error-boundary.tsx:3`.
**Dangling `{@link}` targets:** `sidebar-row.tsx:257` → `SidebarMenuSurfaceProps` (declared un-exported at
`sidebar-menu-node.tsx:558`), `sidebar-row.tsx:95` → `SIDEBAR_MENU_GUTTER`, `sidebar-row.tsx:722` →
`SIDEBAR_MENU_ITEM_ATTRS`, `feed.tsx:33` → `FeedBeyondRenderedHandler` (it is on `shared/model`, not
`shared/ui`, which the link does not say).

**Current state.** `.claude/rules/fsd-layers.md` mandates barrel-only imports and a deep import is an
ESLint `error`, so a consumer who wants to write `function MyDialog(props: ResponsiveDialogProps)`, memoize a
`CopyButton`, or build a typed `DataTableGrouping` factory has exactly two options: redeclare the shape by
hand, or reach for `React.ComponentProps<typeof X>` and hope the component is not destructuring away the
props it does not forward. Meanwhile `sidebar-row.tsx:257` cheerfully writes
`{@link SidebarMenuSurfaceProps.onMenuIntent}` — a link that resolves to nothing for anyone outside the
directory.

**Why it falls short.** A public component whose props type is private is a public API you cannot compose
with. The library is inconsistent about it too: `ButtonProps`, `InputProps`, `SwitchProps`, `BannerProps`,
`PageContainerProps`, `SettingRowProps`, `DataTableProps`, `SidebarRowProps` and ~15 others **are** on the
barrel, so the omissions read as accidents rather than as encapsulation.

**Recommendation.** Add the missing `export type` lines to `shared/ui/index.ts` — it is a mechanical,
zero-risk change. Export `DataTableGrouping` alongside `DataTableProps` (it is the type of a public prop) and
`SidebarMenuSurfaceProps` alongside `SidebarMenuSurface`. Then fix the four dangling links: two by exporting
their targets, `feed.tsx:33` by qualifying it (`{@link FeedBeyondRenderedHandler}` from
`@/layers/shared/model`). Consider a small lint or vitest guard that fails when a barrel-exported component's
`*Props` interface is not also exported, so the class of defect cannot regrow.

---

### [P2/S] Six visual leaves accept no `className`, and two siblings extracted in the same change disagree about it

**Files:** `apps/client/src/layers/shared/ui/compact-result-row.tsx:1-12` and `:24`,
`option-row.tsx:3-14`, `path-breadcrumb.tsx:3`, `settings-panel.tsx:4-12`, `FeatureDisabledState.tsx:4`,
`trust-dial.tsx:169`. Contrast: `truncated-output.tsx:12`

**Current state.** `.claude/rules/components.md` states the rule — "`cn()` … for all conditional/merged
classes; caller `className` goes last so it can override" — and it holds across most of the library.
It does not hold for these six. The sharpest evidence is a pair extracted in the same change and exported
from adjacent lines of the barrel (`index.ts:385-388`):

```tsx
// truncated-output.tsx:12 — documents the contract
  /** Chrome for the wrapper — margins, borders. The caller owns it. */
  className?: string;

// compact-result-row.tsx:24 — same family, no className, chrome hardcoded
    <div className="bg-muted/50 rounded-msg-tool shadow-msg-tool border px-3 py-1 text-sm transition-all duration-150">
```

`CompactResultRow` and `OptionRow` are both drawn by two different surfaces (the transcript and the Ask
card, per the barrel's own comment at `index.ts:381-384`), and neither surface can give them a margin.

**Why it falls short.** A shared leaf that cannot be positioned by its host is a leaf the next host will
copy-paste instead of import — which is how the duplicate-component problem lens 3 hunts gets started.

**Recommendation.** Add `className?: string` merged through `cn()` as the last argument on all six.
`SettingsPanel` should also forward it (it is a `NavigationLayoutPanel` wrapper and the panel takes one).
Keep the rule visible: `TruncatedOutput`'s one-line prop doc is the wording to copy.

---

### [P2/M] `cn` is imported three different ways inside `shared/ui`, and the mandated spelling drags the transport into a leaf primitive

**Files:** `@/layers/shared/lib/utils` in 30 files (`button.tsx:5`, `input.tsx:3`, `tooltip.tsx:4`,
`scroll-area.tsx:4`, `label.tsx:4`, `separator.tsx:6`, `checkbox.tsx:7`, `radio-group.tsx:5`,
`page-container.tsx:4`, `banner.tsx:6`, …); `../lib/utils` in 24 (`badge.tsx:3`, `card.tsx:2`,
`kbd.tsx:1`, `inline-code.tsx:1`, `select.tsx:4`, `switch.tsx:3`, `dialog.tsx:4`, `dropdown-menu.tsx`,
`drawer.tsx`, `mention-pill.tsx`, `identity-avatar.tsx`, `responsive-*.tsx`, …); `@/layers/shared/lib`
(the barrel) in 27 (`field-card.tsx:3`, `setting-row.tsx:3`, `copy-button.tsx:2`, `option-row.tsx:1`,
`truncated-output.tsx:2`, `sidebar-row.tsx`, `section-header.tsx`, `trust-dial.tsx`, `data-table.tsx`, …).
Supporting evidence: `apps/client/src/layers/shared/lib/index.ts:287-291`.

**Current state.** `.claude/rules/fsd-layers.md` §Import Conventions says two things — always the `@/` alias,
always the module's `index.ts` — and only 27 of the 81 files obey both. But obeying both has a cost the
barrel itself documents:

```ts
// shared/lib/index.ts:287
// `overnightBoundary` is deliberately NOT re-exported here… one of its two callers is the
// sidebar model, which a source-level contract forbids from value-importing this barrel at
// all (it pulls in the transport, the sound player and a dozen other side effects).
```

`shared/lib/index.ts` is 298 lines re-exporting ~150 symbols from ~60 modules, including `HttpTransport`,
`playCelebration`, `CelebrationEngine` and `queryClient`. So `import { cn } from '@/layers/shared/lib'`
inside a 20-line `OptionRow` pulls a module graph that has nothing to do with class merging — which is very
likely why 24 files quietly reach for `../lib/utils` instead.

**Why it falls short.** Three spellings of the single most-imported helper in the client is a coin flip on
every new file, and the "correct" one per the written rule is the one with a side-effect cost that the same
codebase elsewhere treats as disqualifying. The rule and the practice disagree, and nobody has written down
which wins.

**Recommendation.** Decide it once and enforce it once. The defensible answer for `shared/ui` internals is
the **leaf module path** — `@/layers/shared/lib/utils` — because it is side-effect-free, it is still the
`@/` alias, and it is already the plurality (30 files). Normalise all 81 files to it, then amend
`.claude/rules/fsd-layers.md` with the carve-out in one sentence: _within `shared/`, import leaf modules
directly; the barrel is the contract for consumers in `entities/`, `features/` and `widgets/`._ An
`import/no-restricted-paths` or `no-restricted-imports` rule scoped to `src/layers/shared/**` can hold it.
Separately, consider splitting `shared/lib`'s barrel so that a value import of it does not reach the
transport — but that is its own spec, not this finding's fix.

---

### [P2/S] A live contributing guide teaches the wrong pattern and a non-existent import path

**Files:** `contributing/styling-theming.md:381-395`, `contributing/design-system.md:1071`

**Current state.** `styling-theming.md` presents this as the ✅ pattern:

```tsx
// ❌ Don't modify Shadcn component source files
// File: apps/client/src/layers/shared/ui/button.tsx
// ✅ Use className prop or create wrapper
import { Button as BaseButton } from '@/components/ui/button';
```

`@/components/ui/button` has not existed since the FSD migration — `apps/client/src/components/` is not a
directory — and an agent copying that line writes an import that fails both `tsc` and the FSD lint rule.
Worse, the advice contradicts the repo's actual practice and its own rules: `.claude/rules/components.md`
§Required Patterns tells you to follow the existing files and add `cva` variants, and `button.tsx:19-20`
carries a bespoke `brand` variant, `:41-59` a bespoke `responsive` system — the file has been modified
heavily and on purpose. `design-system.md:1071` has the same stale path
("See `components/ui/responsive-dialog.tsx`").

**Why it falls short.** These two files are the ground truth an agent reads before touching a primitive.
Teaching "wrap, don't modify" is how a `BaseButton`-wrapper layer gets born on top of a design system that
was built to be extended in place — the exact duplication the DRY lens hunts.

**Recommendation.** Rewrite `styling-theming.md:381-395`: shadcn files here are **owned**, not vendored;
extend them with a new `cva` variant (`variant`/`size`) and keep the caller `className` escape hatch for
one-offs; never fork a primitive into a wrapper. Fix both stale paths to
`apps/client/src/layers/shared/ui/…`. Add a doc-lint or a grep in the docs check for `@/components/` so a
dead path cannot come back.

---

### [P2/S] `input-otp.tsx` is dead code with a live dependency

**Files:** `apps/client/src/layers/shared/ui/input-otp.tsx`, `apps/client/package.json:74`

**Current state.** It is the only file in `shared/ui` not re-exported from `index.ts`, and a repo-wide grep
for `InputOTP` / `input-otp` outside the file itself returns nothing. `input-otp@^1.5.0` is still a runtime
dependency at `package.json:74`.

**Why it falls short.** AGENTS.md Quality Standard: "no dead code… when something is superseded, remove it."
It is also a trap — the one file whose only importable path is a deep import, which ESLint rejects, so the
next contributor who finds it has to modify the barrel before they can use it and will not know whether the
omission was deliberate.

**Recommendation.** Delete `input-otp.tsx` and drop the dependency. If OTP entry is on the roadmap, the
shadcn generator can re-add it in one command when a caller exists; a component with no caller is a
liability, not an asset.

---

### [P2/S] The `entities/session` barrel publishes two hooks that upstream share a name

**Files:** `apps/client/src/layers/entities/session/index.ts:38-39` and `:65-76`

**Current state.**

```ts
// :38
export { useSessionStatus } from './model/use-session-status';
export type { SessionStatusData } from './model/use-session-status';
...
// :69 (inside the session-chat-store block)
  useSessionStatus as useSessionChatStatus,
```

Two different hooks, both named `useSessionStatus` in their own modules, both on one barrel, distinguished
only by an alias. Nothing on the barrel says what the difference is — one reads the session's server-side
status, the other reads the per-session chat store's — and autocomplete offers both with identical
prefixes.

**Why it falls short.** This barrel is otherwise exemplary: it carries a genuine comment for nearly every
non-obvious export (`:40-42` on the query-key factory, `:43-49` on permission mode, `:52-54` on the
overrides store, `:141-143` on `SessionRowSidebar`). The one place a reader is most likely to pick the
wrong symbol is the one place with no note.

**Recommendation.** Add a two-line comment above the alias saying which question each hook answers, in the
voice the rest of the file already uses. Better still, rename at the source: `useSessionChatStatus` in
`session-chat-store.ts` and `useSessionServerStatus` (or leave `useSessionStatus`) in
`use-session-status.ts`, so the alias disappears and the barrel is a straight re-export.

---

### [P3/M] One usage example in ninety primitives

**Files:** `apps/client/src/layers/shared/ui/filter-bar/index.ts:4-14` (the only `@example` in `shared/ui`;
seven in the whole client)

**Current state.** `FilterBar`'s barrel opens with a compact, complete example that shows the compound
shape in ten lines. Nothing else in the library has one — not `NavigationLayout` (nine sub-components),
not `TabbedDialog`, not `SidebarMenuNodes`, not `ResponsiveDialog`, not the `Field` family.

**Why it falls short.** For a compound API, the example _is_ the documentation: prose describing
`Field`/`FieldContent`/`FieldLabel`/`FieldDescription` nesting is strictly worse than four lines of JSX,
and the example is what an editor hover and an agent's context window both surface.

**Recommendation.** Add one `@example` to each compound primitive's root export — `NavigationLayout`,
`TabbedDialog`, `Field`, `Card`, `ResponsiveDialog`, `SidebarMenuNodes`, `DataTable`, `FilterBar` (already
done), `Feed`. Keep them to the shortest thing that compiles; a long example rots. This pairs naturally with
the Dev Playground work in lens 6 — the playground showcase and the `@example` should show the same shape.

---

### [P3/S] Two composition idioms for compound components

**Files:** `apps/client/src/layers/shared/ui/filter-bar/index.ts:27-34` (namespace via `Object.assign`)
vs `card.tsx:65`, `dialog.tsx`, `field.tsx`, `navigation-layout.tsx`, `sidebar.tsx`, `table.tsx`
(flat sibling exports)

**Current state.** `FilterBar` is reached as `<FilterBar.Search>`, `<FilterBar.Sort>`; every other
multi-part primitive is reached as `<CardHeader>`, `<DialogContent>`, `<NavigationLayoutPanel>`,
`<FieldLabel>`. `FilterBar` is the sole `Object.assign` compound in `layers/`.

**Why it falls short.** Not wrong — the namespace form is arguably nicer and it tree-shakes fine here — but
it means a contributor building the next compound has no default, and a reader scanning imports sees one
name for `FilterBar` and seven for `Card`.

**Recommendation.** Pick the flat sibling form as the house style (it is the shadcn convention the other 89
files already follow, and it is what `.claude/rules/components.md` implies), write the choice down in one
sentence there, and leave `FilterBar` as it is with a note explaining that it predates the rule — churning
16 call sites to win consistency alone is not worth it. Revisit only if a second namespace compound appears.

---

### [P3/S] Two of the five responsive wrappers are undocumented, and one doc points at a path that does not exist

**Files:** `contributing/design-system.md:1005-1075` (§Responsive Components documents
`ResponsiveDropdownMenu` at `:1009`, `ResponsiveDialog` at `:1069`, `ResponsivePopover` at `:1073`),
`design-system.md:1071` (stale path); undocumented —
`apps/client/src/layers/shared/ui/responsive-sheet.tsx`, `responsive-context-menu.tsx`

**Current state.** The section is genuinely good where it exists: `:1011` gives the choose-this-not-that rule
("Use instead of plain `DropdownMenu` when the menu appears in a touch-accessible area… Plain `DropdownMenu`
is fine for desktop-only contexts"), and `:1075` does the same for `ResponsivePopover`. `ResponsiveSheet`
(14 call sites) and `ResponsiveContextMenu` get no entry, so the only way to learn they exist is to read
`shared/ui/index.ts`. `:1071` also tells the reader to "See `components/ui/responsive-dialog.tsx`", which is
the pre-FSD path (same defect as finding 12).

**Recommendation.** Add the two missing subsections in the same shape as the existing three — a one-line
"use instead of X when…" plus the desktop/mobile mapping table — and fix the path. While there, add the
one-line rule to each wrapper's own TSDoc with an `@see` back to the plain primitive and forward to the doc
section, so the choice is answerable from the editor as well as from the guide.

---

### [P3/M] Ninety exports and no map: several families have two-plus near-identical entry points with nothing saying which to reach for

**Files:** `apps/client/src/layers/shared/ui/index.ts` (389 lines, 90 modules), and the families it exposes:
overlays — `dialog.tsx` / `responsive-dialog.tsx`, `popover.tsx` / `responsive-popover.tsx`,
`dropdown-menu.tsx` / `responsive-dropdown-menu.tsx`, `context-menu.tsx` / `responsive-context-menu.tsx`,
`sheet.tsx` / `responsive-sheet.tsx` / `drawer.tsx`; rows — `sidebar-row.tsx`, `setting-row.tsx`
(`SettingRow` + `SwitchSettingRow`), `option-row.tsx`, `compact-result-row.tsx`, `sidebar-menu-node.tsx`,
plus `entities/session`'s `SessionRow` and `SessionRowSidebar`

**Current state.** There is no `README.md` anywhere under `apps/client/src/layers/`. The barrel itself is
the only index, it is not alphabetised (`Progress` and `PromptSuggestionChips` land between `Collapsible`
and `Input` at `index.ts:31-35`), and its section comments cover only four of the ninety modules
(`:356`, `:376-378`, `:381-384`). `design-system.md` answers the overlay question for three of five pairs
(finding 17) and does not touch the row family at all — a contributor asking "which row do I use for a
settings toggle vs a sidebar entry vs a decided prompt option?" has seven candidates and no guide.

**Why it falls short.** Discoverability is the first DX property. A library you cannot navigate gets
re-implemented instead of imported, which is the upstream cause of most of what lens 3 (DRY) will find.

**Recommendation.** Add `apps/client/src/layers/shared/ui/README.md` — one page, three tables (overlays,
rows, form controls), each row being _"want X → use Y; not Z, because…"_ — and link it from
`contributing/design-system.md` and `.claude/rules/components.md`. Then group the barrel with section
comments matching the README's sections and alphabetise within each group. This is documentation and
ordering only; nothing renders differently.

---

### [P3/M] The public "work is happening" animation is named after an unrelated feature

**Files:** `apps/client/src/index.css:860-875` (`@keyframes tasks`, `@utility animate-tasks`),
`apps/client/src/layers/shared/ui/skeleton.tsx:8`

**Current state.** `Skeleton` — 112 JSX call sites, the client's second most-used primitive — is
`cn('bg-accent animate-tasks rounded-md', className)`. The CSS comment at `index.css:841-859` calls it
"The 'work is happening' breath, worn by ~20 call sites (ThinkingBlock, MemoryRecallBlock, loading
skeletons, connection dots)" and explains at length why it is opacity-only. The name says none of that, and
"tasks" is already the name of a product surface (`/tasks`, `entities/tasks`, Pulse schedules), so a reader
of `skeleton.tsx:8` reasonably concludes the skeleton is task-related.

**Why it falls short.** A class name is API. This one is used across three layers and its name actively
misleads about both what it does and what domain it belongs to.

**Recommendation.** Rename the keyframe and utility to `breath` / `animate-breath` (it is already described
as "a faster, quieter cousin of `breathe`"), move the explanatory comment with it, and update the ~20 call
sites in one mechanical PR. Keep `animate-tasks` as an alias for exactly one release if any e2e selector
depends on the class string; otherwise delete it outright.

---

### [P3/S] `Badge` is the odd primitive out: no `data-slot`, no `asChild`, no exported props, and a `<div>` in flowing text

**Files:** `apps/client/src/layers/shared/ui/badge.tsx:3,22-29`, `apps/client/src/layers/shared/ui/index.ts:19`

**Current state.** 88 JSX call sites. The component is:

```tsx
// badge.tsx:22
/** Styled inline badge with color variant support. */
function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof badgeVariants>) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
```

No `data-slot` (finding 4), no `asChild` despite `.claude/rules/components.md` naming Radix `asChild`
composition the house pattern, no exported `BadgeProps`, `cn` imported relatively (finding 11), and a
`<div>` root — so a badge placed inside a `<p>` or a `<span>`-based label is invalid HTML, and a badge that
should be a link has to be wrapped rather than composed.

**Why it falls short.** It is the second most-used primitive after `Button` and it is the least-finished
file in the directory. `Button` right next to it has `asChild` (`button.tsx:63,76`), `data-slot`,
`data-variant`/`data-size` and an exported props type; `Badge` has none of the four.

**Recommendation.** Bring it up to `Button`'s shape in one small PR: `asChild` via `Slot.Root`, root element
`<span>` (inline by default, which is what a badge is), `data-slot="badge"` plus `data-variant`, and
`export type BadgeProps` on the barrel. Add `size` only if finding 5's vocabulary lands first, so it is
born speaking the settled scale. No visual change — `inline-flex` already makes `span` and `div` render
identically here.

---

### [P3/S] `Button` and the bare `<button>`s in `shared/ui` do not default `type="button"`

**Files:** `apps/client/src/layers/shared/ui/button.tsx:76-89`; bare elements without `type` —
`copy-button.tsx:46`, `truncated-output.tsx:48`, `path-breadcrumb.tsx:59`,
`link-safety-modal.tsx:93`, `navigation-layout.tsx:343`, `responsive-dropdown-menu.tsx:262,334`,
`route-error-fallback.tsx:65`, `app-crash-fallback.tsx:87,105`, `DirectoryPicker.tsx` (11 sites)

**Current state.** `Button` renders `<Comp data-slot="button" …>` with no default `type`, so an HTML
`<button>` inside a `<form>` defaults to `type="submit"`. A scripted check found **no** current instance of a
`Button` inside a `<form>` without an explicit type, so nothing is broken today — 15 call sites do write
`type="submit"` explicitly, and the 39 `<form>` elements are all clean.

**Why it falls short.** It is the definition of "hard to misuse" failing preventively: the next
`<Button onClick={…}>` added inside a `TanStack` form submits it, silently, and the bug presents as "the
dialog closes when I click Cancel". `shared/ui` also contains 20-odd bare `<button>`s with the same gap.

**Recommendation.** Default `type` in `Button` when it is rendering a real `<button>`:
`{...(asChild ? {} : { type: props.type ?? 'button' })}`, leaving `asChild` alone (the slotted child owns its
own element). Add `type="button"` to the bare `<button>`s listed above. Keep the 15 explicit
`type="submit"` call sites exactly as they are — they are the ones that mean it.

---

### [P3/M] The retired product word is still a public type name and 615 lines of source vocabulary

**Files:** `apps/client/src/layers/entities/session/index.ts:18`,
`entities/session/lib/session-navigation-intent.ts:43,60,84,111`,
`entities/session/lib/switch-agent-cwd.ts:4,29`; 615 case-insensitive occurrences of "cockpit" across
`apps/client/src`

**Current state.** `export type { CockpitLocation }` is on the `entities/session` barrel — a public type
named after the word AGENTS.md §Vision retired ("Never write 'mission control' or 'cockpit' in user-facing
prose… Say 'the DorkOS app', 'the app', 'one place' or 'one window'"). The ban is explicitly scoped to
user-facing prose, so this is **not** a rule violation and the vocabulary guard
(`scripts/check-banned-words.sh`) correctly ignores it. But 615 occurrences in client source — including
this exported identifier and comments in `touch-target.ts:12` ("every surface in the phone cockpit") — mean
the retired word is still what the codebase teaches a new contributor, and a barrel export is the most
visible place it survives.

**Why it falls short.** DX includes the vocabulary a public API hands you. A contributor who reads
`CockpitLocation` on a barrel will use "cockpit" in the next comment, the next commit message, and
eventually the next UI string, where it _is_ a violation. Internal and external vocabulary drifting apart is
a maintenance tax that compounds quietly.

**Recommendation.** Rename `CockpitLocation` → `AppLocation` (7 references, one commit) and sweep comments
opportunistically — when a file is touched for another reason, replace "cockpit" with "the app" in its
prose. Do **not** run a 615-site find-and-replace: it would touch nearly every file in the client, collide
with every open worktree, and buy nothing that an opportunistic sweep does not. Note the boundary in
`AGENTS.md` §Vision in one clause so the next auditor knows identifiers were considered and deliberately
handled this way.

---

## Summary

| Severity  | Count  |
| --------- | ------ |
| P1        | 1      |
| P2        | 13     |
| P3        | 8      |
| **Total** | **22** |

The single root cause is finding 1: `shared/ui` was fenced off from the repo's own documentation and
file-size rules on a "vendored shadcn" premise that stopped being true dozens of bespoke primitives ago.
Findings 2, 3 and the oversized files are its direct consequences; findings 4–7 are what happens when a
90-file library grows for two years without a rule that says "these are the words we use". None of the
recommendations changes a pixel — every one is documentation, naming, type exports, or a mechanical
attribute sweep, and Calm Tech is untouched throughout.
