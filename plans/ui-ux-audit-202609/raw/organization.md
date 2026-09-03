# Lens 4 — Organization & Naming

Auditor scope: FSD placement and naming across `apps/client/src/layers`, plus the
Dev Playground (`apps/client/src/dev`) where it imports layer code.

## Coverage

**Read in full before auditing:** `.claude/rules/fsd-layers.md`, `.claude/rules/components.md`,
`contributing/project-structure.md` (File Naming sections), `contributing/design-system.md`
(§Sidebar, §Identity, first 540 lines), the FSD layer ESLint enforcement in
`apps/client/eslint.config.js`.

**Full coverage:**

- `layers/shared/ui/` — all ~90 files read by name/content, every barrel export (126
  named exports in `index.ts`) checked for outside-layer usage via a full-repo
  identifier scan (`layers/shared/ui/index.ts` cross-referenced against every
  identifier appearing in `layers/entities`, `layers/features`, `layers/widgets`,
  `dev`). Zero-hit candidates were hand-verified individually (not knip) before
  being reported as dead.
- Every deep (non-barrel) import of `features/*/ui|model|api|lib|config/*` and
  `widgets/*/ui|model|api|lib|config/*` from _inside_ `layers/` was enumerated
  (two hits total, both reported below). The same enumeration was run for
  `entities/*` internal paths and for sibling-widget internal paths — zero hits,
  confirming the ESLint DAG/barrel rule that covers `entities/` is doing its job
  and the gap is specifically in the unenforced `features`/`widgets` territory.
- File-count census of every entity/feature/widget slice (all 17 widgets, 60
  features, 26 entities) to find merge/split candidates.
- All non-barrel imports from `dev/showcases/**` into `layers/features/chat/**`
  were enumerated and cross-checked against `features/chat/index.ts`'s own
  barrel to see which reached-into symbols were already exported.

**Sampled, not exhaustive:**

- `entities/`, `features/`, `widgets/` UI file naming was spot-checked in
  `entities/session/ui`, `features/chat/ui`, `widgets/app-layout/ui` (all
  PascalCase, matching documented convention) rather than read file-by-file
  across all 60 feature slices.
- Slice-merge candidates: every slice with ≤3 files was listed and a sample
  (8-10) opened to check for a documented rationale before flagging; most carry
  an explicit "why this is its own slice" paragraph in their `index.ts` module
  doc, which this audit treats as a settled decision per Charter Rule 4 and does
  not relitigate.
- The non-barrel-import scan into `features/chat` was not repeated symbol-by-symbol
  for every other feature slice `dev/showcases/` touches (relay, mesh, settings,
  dashboard-sidebar, room-management, tasks) — those are named as likely-affected
  in the pattern finding below but not individually cited line-by-line.
- Dead-export scan covered `shared/ui` only (the highest-leverage barrel, and the
  one Charter §4 names explicitly); `entities/`, `features/`, `widgets/` barrels
  were not swept the same way.

---

### [P2/M] `shared/ui` documents one naming convention and ships a second one, undocumented

**Files:**

- `.claude/rules/components.md:107` and `contributing/project-structure.md:416` —
  both state the file-naming rule as a flat table: "Component file → PascalCase
  (`UserCard.tsx`)". Neither table carves out `shared/ui/`.
- `apps/client/src/layers/shared/ui/index.ts` — the real barrel: 85 of 90 files
  are kebab-case (`button.tsx`, `data-table.tsx`, `mention-pill.tsx`,
  `sidebar-row.tsx`, `trust-dial.tsx` — none of these are shadcn scaffolding,
  they're hand-built DorkOS components, kebab-cased anyway).
- Five top-level outliers break the shared/ui norm: `ConnectionStatusBanner.tsx`,
  `DirectoryPicker.tsx`, `FeatureDisabledState.tsx`, `PromptSuggestionChips.tsx`,
  `ScanLine.tsx`.
- Two entire subdirectories break it wholesale: `shared/ui/filter-bar/` (8 files,
  all PascalCase — `FilterBar.tsx`, `FilterBarActiveFilters.tsx`,
  `FilterBarAddFilter.tsx`, `FilterBarContext.tsx`, `FilterBarPrimary.tsx`,
  `FilterBarResultCount.tsx`, `FilterBarSearch.tsx`, `FilterBarSort.tsx`) and
  `shared/ui/form-fields/` (7 files, all PascalCase —
  `CheckboxField.tsx`, `PasswordField.tsx`, `SelectField.tsx`, `SubmitButton.tsx`,
  `SwitchField.tsx`, `TextField.tsx`, `TextareaField.tsx`).
- `shared/ui/tour-spotlight/` gets it right by the shared/ui norm: component
  files PascalCase (`TourCaption.tsx`, `TourSpotlight.tsx`), hook files kebab
  (`use-anchor-resolver.ts`, `use-focus-trap.ts`,
  `use-prefers-reduced-motion.ts`) — proof the split convention is achievable
  and was achieved once.

**Evidence the drift is live, not legacy debt:** all five top-level outliers
were added in the last five weeks (`ConnectionStatusBanner.tsx`,
`DirectoryPicker.tsx`, `FeatureDisabledState.tsx`, `ScanLine.tsx` — 2026-07-29,
PR #606; `PromptSuggestionChips.tsx` — 2026-08-08, PR #880), not inherited from
an old shadcn scaffold. The drift is happening now, by whoever is fastest to
reach for the documented "components are PascalCase" rule instead of the
observed shared/ui norm.

**Why it falls short:** the documented rule (`components.md`, `project-structure.md`)
and the observed reality (`shared/ui`'s own 90 files) disagree, and neither
document says shared/ui is the exception. A contributor who reads the docs
before writing code — Priya's habit, and the one AGENTS.md asks every
contributor to have — will write `ScanLine.tsx`-style names in good faith,
because that is what the table tells them to do. The real convention (kebab-case
is the shared/ui norm, full stop, no shadcn-vs-custom distinction) is only
recoverable by reading the directory, not by reading the docs.

**Recommendation:** pick one and write it down. The cheap fix is documenting
what's already true: add one line to `.claude/rules/components.md`'s File
Naming table — "`shared/ui/` is the exception: files are kebab-case regardless
of shadcn-vs-custom origin (see the directory for the pattern)." That alone
stops the bleeding on new files. Renaming the seven existing outliers
(`ConnectionStatusBanner.tsx` → `connection-status-banner.tsx`, the `filter-bar/`
and `form-fields/` subdirectories) is optional cleanup on top, and cheap — no
runtime behavior changes, only the barrel's `from './...'` paths move with the
files.

---

### [P2/S] A feature reaches past a sibling feature's barrel into its private model — the exact coupling `fsd-layers.md` forbids

**Files:**

- `apps/client/src/layers/features/settings/ui/ToolsTab.tsx:9` —
  `import { useAgentContextConfig } from '@/layers/features/agent-settings/model/use-agent-context-config';`
- `apps/client/src/layers/features/agent-settings/model/use-agent-context-config.ts:26` —
  the hook, defined inside `agent-settings`'s own `model/` folder.
- `apps/client/src/layers/features/agent-settings/index.ts` — the barrel. It
  does not export `useAgentContextConfig` at all: the barrel's docstring says
  its tabs are exported "for reuse in sibling feature UI" as _components_
  (`IdentityTab`, `IntegrationsTab`, `ToolsTab`) — the hook was never meant to
  leave the slice.

**Why it falls short:** `.claude/rules/fsd-layers.md:34` states the rule
directly: "Model/hook cross-imports: FORBIDDEN. A feature's model/hooks must
never import from another feature's model/hooks. This prevents circular
business logic dependencies," with the worked example ending "WRONG — lift to
entities or shared." `features/settings/ui/ToolsTab.tsx` is a UI file, not a
model file, but the substance is identical: it reaches straight into a sibling
feature's private hook, bypassing the barrel that deliberately does not export
it. This is not caught by lint — `apps/client/eslint.config.js` only blocks
`features/ → widgets/` (line 179-195) and enforces barrel-only imports inside
`entities/` (line 99-131); there is no rule stopping one feature from importing
another feature's internals at all. This file is standing in that exact gap.

**Recommendation:** `useAgentContextConfig` reads config both `agent-settings`
and `settings` need — that's the textbook "lift it" case the rule's own example
describes. Move it to `entities/agent` (or `entities/config`, whichever already
owns the underlying config shape) so both features consume it the sanctioned
way — through an entity barrel, sibling-safe by construction.

---

### [P2/S] A widget deep-imports a feature component its barrel already exports

**Files:**

- `apps/client/src/layers/widgets/tasks/ui/TasksPage.tsx:12` —
  `import { TasksList } from '@/layers/features/tasks/ui/TasksList';`
- `apps/client/src/layers/features/tasks/index.ts:14` —
  `export { TasksList } from './ui/TasksList';` — the exact same component,
  already public.

**Why it falls short:** `contributing/project-structure.md`'s Import Patterns
section and `.claude/rules/fsd-layers.md:103-111` both give "Always Import from
index.ts" as a hard convention with a worked WRONG example that is this exact
shape (`import { SessionBadge } from '@/layers/entities/session/ui/SessionBadge'`).
`widgets/` → `features/` is an allowed layer direction, so this is not a layer
violation, just a hygiene one — but it defeats the point of the barrel
(hiding `features/tasks`'s internal file layout from consumers) for no reason:
the same symbol is available one import away.

**Recommendation:** change the one import to
`import { TasksList } from '@/layers/features/tasks';`. One-line fix, no
behavior change.

---

### [P2/M] Dev Playground routinely bypasses barrels that already export the exact symbol it needs

**Files (all under `apps/client/src/dev/showcases/`, all importing from
`@/layers/features/chat/ui/...` when `features/chat/index.ts` exports the same
name at the barrel):**

- `MiscShowcases.tsx:2` — `CelebrationOverlay` from
  `.../ui/CelebrationOverlay` (barrel: `features/chat/index.ts:23`)
- `ToolShowcases.tsx:4` and `StatusShowcases.tsx:12` — `ErrorMessageBlock` from
  `.../ui/message/ErrorMessageBlock` (barrel: `index.ts:33`)
- `StatusShowcases.tsx:14` — `TaskListPanel` from `.../ui/tasks/TaskListPanel`
  (barrel: `index.ts:40`)
- `BackgroundTaskShowcases.tsx:2` — `BackgroundTaskBar` from
  `.../ui/tasks/BackgroundTaskBar` (barrel: `index.ts:41`)
- `ComposerShowcases.tsx:24` — `QueuePanel` from `.../ui/input/QueuePanel`
  (barrel: `index.ts:42`)
- `MessageShowcases.tsx:2-4` — `UserMessageContent`, `AssistantMessageContent`,
  `MessageProvider` from `.../ui/message/*` (all three at barrel: `index.ts:32-37`)
- `StatusShowcases.tsx:11` — `StreamingText` from `.../ui/message/StreamingText`
  (barrel: `index.ts:36`, and its own module doc at `features/chat/index.ts:27-30`
  explains it's exported specifically for a _second consumer_ — the playground
  reaches past that intended entry point too)

The same `dev/showcases/` directory also deep-imports `features/relay`,
`features/mesh`, `features/dashboard-sidebar`, `features/settings`, and
`features/room-management` internals (see e.g. `AdapterWizardShowcases.tsx:7-11`,
`topology-relay-flow-pulse.tsx:4-5`, `MobileTabsShowcases.tsx:26-28`,
`SettingsShowcases.tsx:25-33`, `RoomsShowcases.tsx:35-36`) — not all of those
symbols are barrel-exported, so those cases weren't individually verified as
"available but bypassed" the way the `features/chat` set above was, but the
pattern (playground reaches straight into `ui/`, `model/`, `lib/` subpaths) is
the dominant import style in the directory.

**Why it falls short:** `contributing/project-structure.md` and
`.claude/rules/fsd-layers.md` both state barrel-only as the convention, and
`.claude/skills/maintaining-dev-playground/SKILL.md:181` models the convention
correctly in its own worked example
(`import { TunnelContent } from '@/layers/features/settings';`). The playground
is the part of the codebase most likely to be read by a new contributor
learning the patterns (that's its whole purpose per the `maintaining-dev-playground`
skill) — a reference surface that itself doesn't follow the barrel convention
teaches the wrong lesson by example, in the one place that's supposed to be the
model.

**Recommendation:** for the nine `features/chat` symbols cited above (already
barrel-exported), it's a mechanical find-and-replace: swap the deep import path
for `@/layers/features/chat`. For genuinely-internal symbols the playground
needs that aren't barrel-exported (`ToolCallCard`, `SubagentBlock`,
`ThinkingBlock`, and similar), the real decision is upstream: either add them
to the barrel (if a showcase is a legitimate second consumer, the same logic
`StreamingText`'s own docstring already applies) or accept that the playground
is a documented, deliberate exception to barrel-only and say so once in the
`maintaining-dev-playground` skill rather than leaving it silently
inconsistent file-by-file.

---

### [P2/S] `ConnectionStatusBanner` lives in `shared/ui` but has exactly one consumer, reached through a pointless re-export shim

**Files:**

- `apps/client/src/layers/shared/ui/ConnectionStatusBanner.tsx` — the full
  89-line component (own doc comment: "this banner rides the relay panel's
  unified `/events` SSE stream" — it already names its one caller in its own
  docs).
- `apps/client/src/layers/features/relay/ui/ConnectionStatusBanner.tsx` — the
  entire file is one line: `export { ConnectionStatusBanner } from '@/layers/shared/ui';`
- `apps/client/src/layers/features/relay/index.ts:13` — re-exports it a second
  time: `export { ConnectionStatusBanner } from './ui/ConnectionStatusBanner';`

A full-repo scan of every consumer of `ConnectionStatusBanner` outside its own
definition file found only `features/relay` (via the two re-export layers
above) and the Dev Playground's `RelayShowcases.tsx` (which already imports it
from `@/layers/features/relay`, the correct barrel).

**Why it falls short:** the component's own docstring says it's specifically
the relay panel's banner, distinct from the per-session connection UI
elsewhere — it is feature-specific by its own description, not a generic
shared primitive. Placing it in `shared/ui` forces `features/relay` to grow a
one-line pass-through file just to re-export it under its own barrel — pure
indirection that exists only because the component is in the wrong layer. This
is the "shared code used by one feature only" pattern the audit brief calls
out directly, plus a bonus: an empty re-export file that any FSD purist would
flag on sight.

**Recommendation:** move `ConnectionStatusBanner.tsx` into
`features/relay/ui/`, delete the pass-through file, and export it once from
`features/relay/index.ts` directly. `shared/ui`'s barrel loses one export; no
other consumer is affected.

---

### [P3/S] Two dead exports in `shared/ui`'s public barrel

**Files:**

- `apps/client/src/layers/shared/ui/settings-panel.tsx:22` — `SettingsPanel`
  (+ `SettingsPanelProps` type), re-exported at `shared/ui/index.ts:138-139`.
  Its own docstring says it's "for use inside a bare `NavigationLayout` (without
  `TabbedDialog`)" — but a full scan of every consumer of `NavigationLayoutPanel`
  outside `shared/ui` finds exactly one caller, `features/settings/ui/tabs/PreferencesTab.tsx`,
  and that file is rendered _inside_ `TabbedDialog` (its own comment says so:
  `<NavigationLayoutPanel value="preferences">` is what "the dialog shell"
  wraps it in) — precisely the case `SettingsPanel`'s own docstring says makes
  it unnecessary. There is no bare-`NavigationLayout` caller anywhere in the
  codebase. Added 2026-07-29 (PR #606); never adopted.
- `apps/client/src/layers/shared/ui/navigation-layout.tsx:274` —
  `NavigationLayoutSectionHeader`, exported from the file (`navigation-layout.tsx:637`)
  and re-exported at `shared/ui/index.ts:158`. It is never rendered anywhere,
  including inside its own defining file.

**Why it falls short:** AGENTS.md §Quality Standard: "no dead code... when
something is superseded, remove it." Both are real, documented, exported
components — not stubs — that never found a caller.

**Recommendation:** delete both (component + type + barrel export lines). If a
future settings surface genuinely needs the bare-`NavigationLayout` shorthand,
it's cheap to re-add with a real caller attached; carrying it unused in the
meantime is the thing the standard asks not to do. (Not a knip run — each was
hand-verified against every `.ts`/`.tsx` file in `layers/` and `dev/` before
being listed here, per the charter's "spot-check, do not run knip" instruction.)

---

### [P3/S] `features/commands` and `features/command-palette` are two different things with confusingly close names

**Files:**

- `apps/client/src/layers/features/commands/index.ts` — "Commands feature —
  slash command palette with fuzzy search," exports one component,
  `CommandPalette` (`ui/CommandPalette.tsx:12`), the dropdown list that appears
  under the composer when a message starts with `/`.
- `apps/client/src/layers/features/command-palette/index.ts` — "Command palette
  — global Cmd+K agent switching and feature access," ~40 files, exports
  `CommandPaletteDialog` (`ui/CommandPaletteDialog.tsx`), the ⌘K dialog.

**Why it falls short:** both slices describe themselves with the same two
words ("command palette") for genuinely different surfaces — a composer's
inline `/`-command dropdown vs. the app-wide ⌘K launcher — and the smaller
slice's own component is literally named `CommandPalette`, the same name a
reader would reach for first when looking for the ⌘K feature. A contributor
searching the codebase for "the command palette" has to open both slices to
find out which one is meant; `grep -rn CommandPalette` returns hits from both.

**Recommendation:** rename the smaller slice's concept to match what it draws
— it's a slash-command dropdown, not a palette dialog. `features/commands` →
`features/slash-commands` (or similar), and its `CommandPalette` component to
`SlashCommandList` (or similar or comparable to `CommandPaletteDialog`'s own
naming). Low-risk rename: the component has exactly two consumers
(`widgets/session/ui/SessionComposer.tsx`, `dev/showcases/ComposerShowcases.tsx`),
both already found by this audit's search.
