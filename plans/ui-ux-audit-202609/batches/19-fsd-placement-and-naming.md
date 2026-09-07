[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 19 — FSD placement and naming

**Priority P2 · 7 findings · 5S · 2M**
**Scope:** layer hygiene. Five are one-line or one-file moves; the playground sweep and the rename are larger. `apps/client/eslint.config.js` blocks `features/ → widgets/` and enforces barrel-only inside `entities/`, but nothing stops one feature importing another feature's internals — 19.1 stands in that gap.

### 19.1 — A feature reaches past a sibling feature's barrel into its private model

**P2 · S · lens 4**
`apps/client/src/layers/features/settings/ui/ToolsTab.tsx:9`, `apps/client/src/layers/features/agent-settings/model/use-agent-context-config.ts:26`, `apps/client/src/layers/features/agent-settings/index.ts`

**Evidence.** Verified in source: `import { useAgentContextConfig } from '@/layers/features/agent-settings/model/use-agent-context-config';`. The `agent-settings` barrel does not export that hook at all — its docstring says its tabs are exported "for reuse in sibling feature UI" as _components_ (`IdentityTab`, `IntegrationsTab`, `ToolsTab`); the hook was never meant to leave the slice. `.claude/rules/fsd-layers.md:34` states the rule: "Model/hook cross-imports: FORBIDDEN. A feature's model/hooks must never import from another feature's model/hooks," with the worked example ending "WRONG — lift to entities or shared." `ToolsTab.tsx` is a UI file rather than a model file, but the substance is identical, and lint does not catch it.

**Recommendation.** `useAgentContextConfig` reads config both `agent-settings` and `settings` need — the textbook "lift it" case the rule's own example describes. Move it to `entities/agent` (or `entities/config`, whichever already owns the underlying config shape) so both features consume it through an entity barrel, sibling-safe by construction.

### 19.2 — A widget deep-imports a feature component its barrel already exports

**P2 · S · lens 4**
`apps/client/src/layers/widgets/tasks/ui/TasksPage.tsx:12`, `apps/client/src/layers/features/tasks/index.ts:14`

**Evidence.** Verified: `import { TasksList } from '@/layers/features/tasks/ui/TasksList';` while `features/tasks/index.ts:14` already has `export { TasksList } from './ui/TasksList';`. `widgets/ → features/` is an allowed direction, so this is hygiene rather than a layer violation — but it defeats the barrel's purpose (hiding the feature's internal file layout from consumers) for no reason, since the same symbol is one import away. `fsd-layers.md:103-111` gives "Always Import from index.ts" as a hard convention with a worked WRONG example of exactly this shape.

**Recommendation.** Change the one import to `from '@/layers/features/tasks'`. One line, no behaviour change.

### 19.3 — `ConnectionStatusBanner` lives in `shared/ui` with one consumer, reached through a pointless shim

**P2 · S · lens 4**
`apps/client/src/layers/shared/ui/ConnectionStatusBanner.tsx` (89 lines), `apps/client/src/layers/features/relay/ui/ConnectionStatusBanner.tsx`, `apps/client/src/layers/features/relay/index.ts:13`

**Evidence.** Verified: `features/relay/ui/ConnectionStatusBanner.tsx` is a single line — `export { ConnectionStatusBanner } from '@/layers/shared/ui';` — and `features/relay/index.ts:13` re-exports it a second time. A full scan of consumers outside the definition file found only `features/relay` (via those two shim layers) and the playground's `RelayShowcases.tsx`, which already imports from the relay barrel. The component's own docstring says it is specifically the relay panel's banner, distinct from the per-session connection UI elsewhere — it is feature-specific by its own description. Placing it in `shared/ui` forces `features/relay` to grow a one-line pass-through purely because the component is in the wrong layer.

**Recommendation.** Move `ConnectionStatusBanner.tsx` into `features/relay/ui/`, delete the pass-through file, and export it once from `features/relay/index.ts`. `shared/ui`'s barrel loses one export; no other consumer is affected. Do it in the same PR as 14.7, which rewrites the component to compose `Banner`.

### 19.4 — The Dev Playground routinely bypasses barrels that already export what it needs

**P2 · M · lens 4**
All under `apps/client/src/dev/showcases/`: `MiscShowcases.tsx:2` (`CelebrationOverlay`, barrel `features/chat/index.ts:23`), `ToolShowcases.tsx:4` and `StatusShowcases.tsx:12` (`ErrorMessageBlock`, `:33`), `StatusShowcases.tsx:14` (`TaskListPanel`, `:40`), `BackgroundTaskShowcases.tsx:2` (`BackgroundTaskBar`, `:41`), `ComposerShowcases.tsx:24` (`QueuePanel`, `:42`), `MessageShowcases.tsx:2-4` (`UserMessageContent`, `AssistantMessageContent`, `MessageProvider`, `:32-37`), `StatusShowcases.tsx:11` (`StreamingText`, `:36`)

**Evidence.** Nine symbols imported from deep `features/chat/ui/...` paths that `features/chat/index.ts` already exports at the barrel. `StreamingText` is the sharpest case: its own module doc at `features/chat/index.ts:27-30` explains it is exported specifically for a _second consumer_ — and the playground reaches past that intended entry point too. The same directory also deep-imports `features/relay`, `features/mesh`, `features/dashboard-sidebar`, `features/settings` and `features/room-management` internals (`AdapterWizardShowcases.tsx:7-11`, `topology-relay-flow-pulse.tsx:4-5`, `MobileTabsShowcases.tsx:26-28`, `SettingsShowcases.tsx:25-33`, `RoomsShowcases.tsx:35-36`); not all of those symbols are barrel-exported, so they were not individually verified as "available but bypassed", but the pattern is the directory's dominant import style. The playground is the part of the codebase most likely to be read by a new contributor learning the patterns — that is its stated purpose — and `maintaining-dev-playground/SKILL.md:181` models the convention correctly in its own worked example.

**Recommendation.** For the nine already-exported `features/chat` symbols, mechanical find-and-replace to `@/layers/features/chat`. For genuinely-internal symbols the playground needs (`ToolCallCard`, `SubagentBlock`, `ThinkingBlock`), the real decision is upstream: either add them to the barrel — the same logic `StreamingText`'s docstring already applies — or accept that the playground is a deliberate exception to barrel-only and say so once in the skill, rather than leaving it silently inconsistent file by file.

### 19.5 — `SettingsPanel` is a dead export

**P3 · S · lens 4**
`apps/client/src/layers/shared/ui/settings-panel.tsx:22`, re-exported at `shared/ui/index.ts:138-139`

**Evidence.** Verified: `grep -rn "SettingsPanel"` across the client returns only the barrel's two export lines and its own `__tests__/settings-panel.test.tsx`. (The unrelated `ManifestSettingsPanel` in `features/extensions` matches the substring but is a different component.) Its docstring says it is "for use inside a bare `NavigationLayout` (without `TabbedDialog`)", and there is no bare-`NavigationLayout` caller anywhere — the one consumer of `NavigationLayoutPanel` outside `shared/ui` is `features/settings/ui/tabs/PreferencesTab.tsx`, which is rendered _inside_ `TabbedDialog`, precisely the case the docstring says makes `SettingsPanel` unnecessary. Added 2026-07-29 (PR #606); never adopted. AGENTS.md §Quality Standard: "no dead code."

**Recommendation.** Delete the component, its props type and the two barrel lines. If a future settings surface needs the bare-`NavigationLayout` shorthand it is cheap to re-add with a real caller attached. **Note:** the raw organization report paired this with `NavigationLayoutSectionHeader`; that half was **verified false** — it is rendered at `shared/ui/tabbed-dialog.tsx:195` and must not be deleted.

### 19.6 — `features/commands` and `features/command-palette` are two different things with one name

**P3 · S · lens 4**
`apps/client/src/layers/features/commands/index.ts` and `ui/CommandPalette.tsx:12`; `apps/client/src/layers/features/command-palette/index.ts` and `ui/CommandPaletteDialog.tsx`

**Evidence.** Both slices describe themselves with the same two words. `features/commands` is "Commands feature — slash command palette with fuzzy search" and exports one component, `CommandPalette` — the dropdown that appears under the composer when a message starts with `/`. `features/command-palette` is "Command palette — global Cmd+K agent switching and feature access", ~40 files, exporting `CommandPaletteDialog`. The smaller slice's component is literally named `CommandPalette`, the name a reader reaches for first when looking for ⌘K, and `grep -rn CommandPalette` returns hits from both.

**Recommendation.** Rename the smaller slice to match what it draws — it is a slash-command dropdown, not a palette dialog. `features/commands` → `features/slash-commands`, and its `CommandPalette` → `SlashCommandList`. Low risk: the component has exactly two consumers (`widgets/session/ui/SessionComposer.tsx`, `dev/showcases/ComposerShowcases.tsx`).

### 19.7 — `CockpitLocation` puts a retired word on a public barrel

**P3 · M · lens 5**
`apps/client/src/layers/entities/session/index.ts:18`, `entities/session/lib/session-navigation-intent.ts:43,60,84,111`, `entities/session/lib/switch-agent-cwd.ts:4,29`; 615 case-insensitive occurrences of "cockpit" across `apps/client/src`

**Evidence.** `export type { CockpitLocation }` sits on the `entities/session` barrel. AGENTS.md §Vision retires "cockpit" from _user-facing prose_, and the guard (`scripts/check-banned-words.sh`) correctly ignores identifiers — so this is **not** a rule violation. But 615 occurrences in client source, including this exported identifier and comments like `touch-target.ts:12`'s "every surface in the phone cockpit", mean the retired word is still what the codebase teaches a new contributor, and a barrel export is the most visible place it survives. A contributor who reads `CockpitLocation` will use "cockpit" in the next comment, the next commit message, and eventually the next UI string, where it _is_ a violation.

**Recommendation.** Rename `CockpitLocation` → `AppLocation` (7 references, one commit) and sweep comments opportunistically — when a file is touched for another reason, replace "cockpit" with "the app" in its prose. Do **not** run a 615-site find-and-replace: it would touch nearly every file in the client, collide with every open worktree, and buy nothing an opportunistic sweep does not. Note the boundary in AGENTS.md §Vision in one clause so the next auditor knows identifiers were considered and deliberately handled this way.
