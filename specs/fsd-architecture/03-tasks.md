# Tasks: FSD Client Architecture Migration

**Spec:** specs/fsd-architecture/02-specification.md
**Generated:** 2026-02-15

---

## Phase 1: Shared Layer

### Task 1.1 — Move UI components to `layers/shared/ui/`

Move all shadcn/ui primitive components from `components/ui/` to `layers/shared/ui/`. Create barrel export.

**Files to move** (all paths relative to `apps/client/src/`):

| Current Path                                 | New Path                                        |
| -------------------------------------------- | ----------------------------------------------- |
| `components/ui/badge.tsx`                    | `layers/shared/ui/badge.tsx`                    |
| `components/ui/dialog.tsx`                   | `layers/shared/ui/dialog.tsx`                   |
| `components/ui/drawer.tsx`                   | `layers/shared/ui/drawer.tsx`                   |
| `components/ui/dropdown-menu.tsx`            | `layers/shared/ui/dropdown-menu.tsx`            |
| `components/ui/hover-card.tsx`               | `layers/shared/ui/hover-card.tsx`               |
| `components/ui/kbd.tsx`                      | `layers/shared/ui/kbd.tsx`                      |
| `components/ui/label.tsx`                    | `layers/shared/ui/label.tsx`                    |
| `components/ui/path-breadcrumb.tsx`          | `layers/shared/ui/path-breadcrumb.tsx`          |
| `components/ui/responsive-dialog.tsx`        | `layers/shared/ui/responsive-dialog.tsx`        |
| `components/ui/responsive-dropdown-menu.tsx` | `layers/shared/ui/responsive-dropdown-menu.tsx` |
| `components/ui/select.tsx`                   | `layers/shared/ui/select.tsx`                   |
| `components/ui/separator.tsx`                | `layers/shared/ui/separator.tsx`                |
| `components/ui/switch.tsx`                   | `layers/shared/ui/switch.tsx`                   |
| `components/ui/tabs.tsx`                     | `layers/shared/ui/tabs.tsx`                     |
| `components/ui/__tests__/kbd.test.tsx`       | `layers/shared/ui/__tests__/kbd.test.tsx`       |

**Create barrel** at `layers/shared/ui/index.ts`:

```typescript
export { Badge, badgeVariants } from './badge';
export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './dialog';
export {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from './drawer';
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu';
export { HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card';
export { Kbd } from './kbd';
export { Label } from './label';
export { PathBreadcrumb } from './path-breadcrumb';
export { ResponsiveDialog } from './responsive-dialog';
export { ResponsiveDropdownMenu } from './responsive-dropdown-menu';
export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
export { Separator } from './separator';
export { Switch } from './switch';
export { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
```

**Import updates**: Within the moved UI files, update any relative `../lib/utils` imports to `@/layers/shared/lib` (once Task 1.2 completes). For now, internal cross-references within `components/ui/` become relative sibling imports.

---

### Task 1.2 — Move lib utilities to `layers/shared/lib/`

Move all `lib/` files (utilities, transport, celebrations) to `layers/shared/lib/`.

**Files to move** (all paths relative to `apps/client/src/`):

| Current Path                                            | New Path                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `lib/utils.ts`                                          | `layers/shared/lib/utils.ts`                                          |
| `lib/platform.ts`                                       | `layers/shared/lib/platform.ts`                                       |
| `lib/fuzzy-match.ts`                                    | `layers/shared/lib/fuzzy-match.ts`                                    |
| `lib/http-transport.ts`                                 | `layers/shared/lib/http-transport.ts`                                 |
| `lib/direct-transport.ts`                               | `layers/shared/lib/direct-transport.ts`                               |
| `lib/font-config.ts`                                    | `layers/shared/lib/font-config.ts`                                    |
| `lib/font-loader.ts`                                    | `layers/shared/lib/font-loader.ts`                                    |
| `lib/favicon-utils.ts`                                  | `layers/shared/lib/favicon-utils.ts`                                  |
| `lib/notification-sound.ts`                             | `layers/shared/lib/notification-sound.ts`                             |
| `lib/session-utils.ts`                                  | `layers/shared/lib/session-utils.ts`                                  |
| `lib/tool-labels.ts`                                    | `layers/shared/lib/tool-labels.ts`                                    |
| `lib/tool-arguments-formatter.tsx`                      | `layers/shared/lib/tool-arguments-formatter.tsx`                      |
| `lib/celebrations/celebration-engine.ts`                | `layers/shared/lib/celebrations/celebration-engine.ts`                |
| `lib/celebrations/effects.ts`                           | `layers/shared/lib/celebrations/effects.ts`                           |
| `lib/celebrations/__tests__/celebration-engine.test.ts` | `layers/shared/lib/celebrations/__tests__/celebration-engine.test.ts` |
| `lib/celebrations/__tests__/effects.test.ts`            | `layers/shared/lib/celebrations/__tests__/effects.test.ts`            |
| `lib/__tests__/favicon-utils.test.ts`                   | `layers/shared/lib/__tests__/favicon-utils.test.ts`                   |
| `lib/__tests__/font-config.test.ts`                     | `layers/shared/lib/__tests__/font-config.test.ts`                     |
| `lib/__tests__/font-loader.test.ts`                     | `layers/shared/lib/__tests__/font-loader.test.ts`                     |
| `lib/__tests__/fuzzy-match.test.ts`                     | `layers/shared/lib/__tests__/fuzzy-match.test.ts`                     |
| `lib/__tests__/notification-sound.test.ts`              | `layers/shared/lib/__tests__/notification-sound.test.ts`              |
| `lib/__tests__/platform.test.ts`                        | `layers/shared/lib/__tests__/platform.test.ts`                        |
| `lib/__tests__/session-utils.test.ts`                   | `layers/shared/lib/__tests__/session-utils.test.ts`                   |
| `lib/__tests__/tool-arguments-formatter.test.tsx`       | `layers/shared/lib/__tests__/tool-arguments-formatter.test.tsx`       |
| `lib/__tests__/tool-labels.test.ts`                     | `layers/shared/lib/__tests__/tool-labels.test.ts`                     |

**Import updates within moved files**: Update any relative imports between lib files to use new relative paths. Test files update their imports from `../utils` to `../utils` (unchanged since relative).

---

### Task 1.3 — Move contexts, stores, and generic hooks to `layers/shared/lib/`

Move `TransportContext`, `app-store`, and all domain-agnostic hooks into `layers/shared/lib/`.

**Files to move** (all paths relative to `apps/client/src/`):

| Current Path                                        | New Path                                                        |
| --------------------------------------------------- | --------------------------------------------------------------- |
| `contexts/TransportContext.tsx`                     | `layers/shared/lib/TransportContext.tsx`                        |
| `stores/app-store.ts`                               | `layers/shared/lib/app-store.ts`                                |
| `stores/__tests__/app-store.test.ts`                | `layers/shared/lib/__tests__/app-store.test.ts`                 |
| `hooks/use-theme.ts`                                | `layers/shared/lib/use-theme.ts`                                |
| `hooks/use-is-mobile.ts`                            | `layers/shared/lib/use-is-mobile.ts`                            |
| `hooks/use-favicon.ts`                              | `layers/shared/lib/use-favicon.ts`                              |
| `hooks/use-document-title.ts`                       | `layers/shared/lib/use-document-title.ts`                       |
| `hooks/use-elapsed-time.ts`                         | `layers/shared/lib/use-elapsed-time.ts`                         |
| `hooks/use-idle-detector.ts`                        | `layers/shared/lib/use-idle-detector.ts`                        |
| `hooks/use-interactive-shortcuts.ts`                | `layers/shared/lib/use-interactive-shortcuts.ts`                |
| `hooks/use-long-press.ts`                           | `layers/shared/lib/use-long-press.ts`                           |
| `hooks/__tests__/use-document-title.test.ts`        | `layers/shared/lib/__tests__/use-document-title.test.ts`        |
| `hooks/__tests__/use-elapsed-time.test.ts`          | `layers/shared/lib/__tests__/use-elapsed-time.test.ts`          |
| `hooks/__tests__/use-favicon.test.ts`               | `layers/shared/lib/__tests__/use-favicon.test.ts`               |
| `hooks/__tests__/use-idle-detector.test.ts`         | `layers/shared/lib/__tests__/use-idle-detector.test.ts`         |
| `hooks/__tests__/use-interactive-shortcuts.test.ts` | `layers/shared/lib/__tests__/use-interactive-shortcuts.test.ts` |

**Import updates within moved files**: Update imports like `@/lib/utils` to `./utils`, `@/stores/app-store` to `./app-store`, `@/contexts/TransportContext` to `./TransportContext` (now all siblings).

**Create barrel** at `layers/shared/lib/index.ts`:

```typescript
export { cn } from './utils';
export { getPlatform, setPlatformAdapter, type PlatformAdapter } from './platform';
export { fuzzyMatch } from './fuzzy-match';
export { HttpTransport } from './http-transport';
export { DirectTransport } from './direct-transport';
export { TransportProvider, useTransport } from './TransportContext';
export { useAppStore, type ContextFile, type RecentCwd } from './app-store';
export { getToolLabel, isToolDangerous } from './tool-labels';
export { ToolArgumentsDisplay } from './tool-arguments-formatter';
export { updateFavicon } from './favicon-utils';
export { playNotificationSound } from './notification-sound';
export { groupSessionsByTime, shortenHomePath, formatRelativeTime } from './session-utils';
export {
  type FontFamilyKey,
  type FontConfig,
  DEFAULT_FONT,
  getFontConfig,
  isValidFontKey,
  FONT_FAMILIES,
} from './font-config';
export { loadGoogleFont, removeGoogleFont, applyFontCSS, removeFontCSS } from './font-loader';
export { CelebrationEngine } from './celebrations/celebration-engine';
export { useTheme, type Theme } from './use-theme';
export { useIsMobile } from './use-is-mobile';
export { useFavicon } from './use-favicon';
export { useDocumentTitle } from './use-document-title';
export { useElapsedTime } from './use-elapsed-time';
export { useIdleDetector } from './use-idle-detector';
export { useInteractiveShortcuts } from './use-interactive-shortcuts';
export { useLongPress } from './use-long-press';
```

---

### Task 1.4 — Update all imports referencing shared layer files

Update every file in `apps/client/src/` that imports from the old `@/lib/`, `@/components/ui/`, `@/contexts/`, `@/stores/`, or domain-agnostic `@/hooks/use-theme`, `@/hooks/use-is-mobile`, etc. paths to use the new barrel imports.

**Import replacement patterns:**

| Old Import Pattern                         | New Import            |
| ------------------------------------------ | --------------------- |
| `@/components/ui/badge`                    | `@/layers/shared/ui`  |
| `@/components/ui/dialog`                   | `@/layers/shared/ui`  |
| `@/components/ui/drawer`                   | `@/layers/shared/ui`  |
| `@/components/ui/dropdown-menu`            | `@/layers/shared/ui`  |
| `@/components/ui/hover-card`               | `@/layers/shared/ui`  |
| `@/components/ui/kbd`                      | `@/layers/shared/ui`  |
| `@/components/ui/label`                    | `@/layers/shared/ui`  |
| `@/components/ui/path-breadcrumb`          | `@/layers/shared/ui`  |
| `@/components/ui/responsive-dialog`        | `@/layers/shared/ui`  |
| `@/components/ui/responsive-dropdown-menu` | `@/layers/shared/ui`  |
| `@/components/ui/select`                   | `@/layers/shared/ui`  |
| `@/components/ui/separator`                | `@/layers/shared/ui`  |
| `@/components/ui/switch`                   | `@/layers/shared/ui`  |
| `@/components/ui/tabs`                     | `@/layers/shared/ui`  |
| `@/lib/utils`                              | `@/layers/shared/lib` |
| `@/lib/platform`                           | `@/layers/shared/lib` |
| `@/lib/fuzzy-match`                        | `@/layers/shared/lib` |
| `@/lib/http-transport`                     | `@/layers/shared/lib` |
| `@/lib/direct-transport`                   | `@/layers/shared/lib` |
| `@/lib/font-config`                        | `@/layers/shared/lib` |
| `@/lib/font-loader`                        | `@/layers/shared/lib` |
| `@/lib/favicon-utils`                      | `@/layers/shared/lib` |
| `@/lib/notification-sound`                 | `@/layers/shared/lib` |
| `@/lib/session-utils`                      | `@/layers/shared/lib` |
| `@/lib/tool-labels`                        | `@/layers/shared/lib` |
| `@/lib/tool-arguments-formatter`           | `@/layers/shared/lib` |
| `@/lib/celebrations/celebration-engine`    | `@/layers/shared/lib` |
| `@/contexts/TransportContext`              | `@/layers/shared/lib` |
| `@/stores/app-store`                       | `@/layers/shared/lib` |
| `@/hooks/use-theme`                        | `@/layers/shared/lib` |
| `@/hooks/use-is-mobile`                    | `@/layers/shared/lib` |
| `@/hooks/use-favicon`                      | `@/layers/shared/lib` |
| `@/hooks/use-document-title`               | `@/layers/shared/lib` |
| `@/hooks/use-elapsed-time`                 | `@/layers/shared/lib` |
| `@/hooks/use-idle-detector`                | `@/layers/shared/lib` |
| `@/hooks/use-interactive-shortcuts`        | `@/layers/shared/lib` |
| `@/hooks/use-long-press`                   | `@/layers/shared/lib` |

**Scope**: All files still in `components/`, `hooks/`, `App.tsx`, `main.tsx`. Files that have already moved (shared layer files) should use relative imports for siblings.

**Approach**: For each file, consolidate multiple imports from the same old directory into a single barrel import. For example:

```typescript
// Before
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';
import { useTransport } from '@/contexts/TransportContext';

// After
import { cn, useAppStore, useTransport } from '@/layers/shared/lib';
```

---

### Task 1.5 — Validate Phase 1

Run full validation suite:

```bash
cd /Users/doriancollier/Keep/144/webui && turbo typecheck && turbo test && turbo build
```

Verify:

- All TypeScript types resolve
- All tests pass
- Vite build completes
- No remaining imports to old `@/lib/`, `@/components/ui/`, `@/contexts/`, or `@/stores/` paths (except from files not yet moved in later phases)

---

## Phase 2: Entities Layer

### Task 2.1 — Create session entity

Move session-related hooks to `layers/entities/session/model/`.

**Files to move** (all paths relative to `apps/client/src/`):

| Current Path                                   | New Path                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `hooks/use-sessions.ts`                        | `layers/entities/session/model/use-sessions.ts`                        |
| `hooks/use-session-id.ts`                      | `layers/entities/session/model/use-session-id.ts`                      |
| `hooks/use-session-status.ts`                  | `layers/entities/session/model/use-session-status.ts`                  |
| `hooks/use-default-cwd.ts`                     | `layers/entities/session/model/use-default-cwd.ts`                     |
| `hooks/use-directory-state.ts`                 | `layers/entities/session/model/use-directory-state.ts`                 |
| `hooks/__tests__/use-sessions.test.tsx`        | `layers/entities/session/model/__tests__/use-sessions.test.tsx`        |
| `hooks/__tests__/use-directory-state.test.tsx` | `layers/entities/session/model/__tests__/use-directory-state.test.tsx` |

**Create barrel** at `layers/entities/session/index.ts`:

```typescript
export { useSessions } from './model/use-sessions';
export { useSessionId } from './model/use-session-id';
export { useSessionStatus, type SessionStatusData } from './model/use-session-status';
export { useDefaultCwd } from './model/use-default-cwd';
export { useDirectoryState } from './model/use-directory-state';
```

**Import updates within moved files**: Update `@/lib/*` imports to `@/layers/shared/lib`, `@/stores/app-store` to `@/layers/shared/lib`, `@/contexts/TransportContext` to `@/layers/shared/lib`.

---

### Task 2.2 — Create command entity

Move command hook to `layers/entities/command/model/`.

**Files to move** (all paths relative to `apps/client/src/`):

| Current Path            | New Path                                        |
| ----------------------- | ----------------------------------------------- |
| `hooks/use-commands.ts` | `layers/entities/command/model/use-commands.ts` |

**Create barrel** at `layers/entities/command/index.ts`:

```typescript
export { useCommands } from './model/use-commands';
```

**Import updates within moved file**: Update `@/contexts/TransportContext` to `@/layers/shared/lib`.

---

### Task 2.3 — Update imports for entity consumers

Update all files that import session or command hooks to use entity barrel imports.

**Import replacement patterns:**

| Old Import                    | New Import                  |
| ----------------------------- | --------------------------- |
| `@/hooks/use-sessions`        | `@/layers/entities/session` |
| `@/hooks/use-session-id`      | `@/layers/entities/session` |
| `@/hooks/use-session-status`  | `@/layers/entities/session` |
| `@/hooks/use-default-cwd`     | `@/layers/entities/session` |
| `@/hooks/use-directory-state` | `@/layers/entities/session` |
| `@/hooks/use-commands`        | `@/layers/entities/command` |

**Files likely affected**: `App.tsx`, `components/chat/ChatPanel.tsx`, `components/sessions/SessionSidebar.tsx`, `components/status/StatusLine.tsx`, and any other consumer of these hooks.

---

### Task 2.4 — Validate Phase 2

Run full validation suite:

```bash
cd /Users/doriancollier/Keep/144/webui && turbo typecheck && turbo test && turbo build
```

Verify no remaining imports to `@/hooks/use-sessions`, `@/hooks/use-session-id`, `@/hooks/use-session-status`, `@/hooks/use-default-cwd`, `@/hooks/use-directory-state`, or `@/hooks/use-commands`.

---

## Phase 3: Features Layer

### Task 3.1 — Create chat feature

Move chat components and hooks to `layers/features/chat/`.

**UI files to move** (all paths relative to `apps/client/src/`):

| Current Path                                            | New Path                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| `components/chat/ChatPanel.tsx`                         | `layers/features/chat/ui/ChatPanel.tsx`                         |
| `components/chat/MessageList.tsx`                       | `layers/features/chat/ui/MessageList.tsx`                       |
| `components/chat/MessageItem.tsx`                       | `layers/features/chat/ui/MessageItem.tsx`                       |
| `components/chat/ChatInput.tsx`                         | `layers/features/chat/ui/ChatInput.tsx`                         |
| `components/chat/ToolCallCard.tsx`                      | `layers/features/chat/ui/ToolCallCard.tsx`                      |
| `components/chat/ToolApproval.tsx`                      | `layers/features/chat/ui/ToolApproval.tsx`                      |
| `components/chat/QuestionPrompt.tsx`                    | `layers/features/chat/ui/QuestionPrompt.tsx`                    |
| `components/chat/StreamingText.tsx`                     | `layers/features/chat/ui/StreamingText.tsx`                     |
| `components/chat/CelebrationOverlay.tsx`                | `layers/features/chat/ui/CelebrationOverlay.tsx`                |
| `components/chat/InferenceIndicator.tsx`                | `layers/features/chat/ui/InferenceIndicator.tsx`                |
| `components/chat/DragHandle.tsx`                        | `layers/features/chat/ui/DragHandle.tsx`                        |
| `components/chat/ShortcutChips.tsx`                     | `layers/features/chat/ui/ShortcutChips.tsx`                     |
| `components/chat/TaskListPanel.tsx`                     | `layers/features/chat/ui/TaskListPanel.tsx`                     |
| `components/chat/__tests__/ChatPanel.test.tsx`          | `layers/features/chat/ui/__tests__/ChatPanel.test.tsx`          |
| `components/chat/__tests__/ChatInput.test.tsx`          | `layers/features/chat/ui/__tests__/ChatInput.test.tsx`          |
| `components/chat/__tests__/MessageList.test.tsx`        | `layers/features/chat/ui/__tests__/MessageList.test.tsx`        |
| `components/chat/__tests__/MessageItem.test.tsx`        | `layers/features/chat/ui/__tests__/MessageItem.test.tsx`        |
| `components/chat/__tests__/ToolCallCard.test.tsx`       | `layers/features/chat/ui/__tests__/ToolCallCard.test.tsx`       |
| `components/chat/__tests__/ToolApproval.test.tsx`       | `layers/features/chat/ui/__tests__/ToolApproval.test.tsx`       |
| `components/chat/__tests__/QuestionPrompt.test.tsx`     | `layers/features/chat/ui/__tests__/QuestionPrompt.test.tsx`     |
| `components/chat/__tests__/StreamingText.test.tsx`      | `layers/features/chat/ui/__tests__/StreamingText.test.tsx`      |
| `components/chat/__tests__/CelebrationOverlay.test.tsx` | `layers/features/chat/ui/__tests__/CelebrationOverlay.test.tsx` |
| `components/chat/__tests__/InferenceIndicator.test.tsx` | `layers/features/chat/ui/__tests__/InferenceIndicator.test.tsx` |
| `components/chat/__tests__/DragHandle.test.tsx`         | `layers/features/chat/ui/__tests__/DragHandle.test.tsx`         |
| `components/chat/__tests__/ShortcutChips.test.tsx`      | `layers/features/chat/ui/__tests__/ShortcutChips.test.tsx`      |
| `components/chat/__tests__/TaskListPanel.test.tsx`      | `layers/features/chat/ui/__tests__/TaskListPanel.test.tsx`      |

**Model files to move:**

| Current Path                                | New Path                                                         |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `components/chat/inference-verbs.ts`        | `layers/features/chat/model/inference-verbs.ts`                  |
| `components/chat/inference-themes.ts`       | `layers/features/chat/model/inference-themes.ts`                 |
| `hooks/use-chat-session.ts`                 | `layers/features/chat/model/use-chat-session.ts`                 |
| `hooks/use-task-state.ts`                   | `layers/features/chat/model/use-task-state.ts`                   |
| `hooks/use-celebrations.ts`                 | `layers/features/chat/model/use-celebrations.ts`                 |
| `hooks/use-rotating-verb.ts`                | `layers/features/chat/model/use-rotating-verb.ts`                |
| `hooks/__tests__/use-chat-session.test.tsx` | `layers/features/chat/model/__tests__/use-chat-session.test.tsx` |
| `hooks/__tests__/use-rotating-verb.test.ts` | `layers/features/chat/model/__tests__/use-rotating-verb.test.ts` |

**Create barrel** at `layers/features/chat/index.ts`:

```typescript
export { ChatPanel } from './ui/ChatPanel';
export {
  useChatSession,
  type ChatMessage,
  type ToolCallState,
  type MessageGrouping,
  type GroupPosition,
} from './model/use-chat-session';
export { useTaskState, type TaskState } from './model/use-task-state';
```

**Import updates within moved files**:

- `@/components/ui/*` -> `@/layers/shared/ui`
- `@/lib/*` -> `@/layers/shared/lib`
- `@/hooks/use-sessions` -> `@/layers/entities/session`
- `@/hooks/use-session-id` -> `@/layers/entities/session`
- `@/hooks/use-commands` -> `@/layers/entities/command`
- Sibling imports (e.g., `./MessageItem`) remain relative within `ui/`
- Model file imports from `../model/use-chat-session` use relative paths within the feature

---

### Task 3.2 — Create commands feature

Move command palette to `layers/features/commands/`.

**Files to move** (all paths relative to `apps/client/src/`):

| Current Path                                            | New Path                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| `components/commands/CommandPalette.tsx`                | `layers/features/commands/ui/CommandPalette.tsx`                |
| `components/commands/__tests__/CommandPalette.test.tsx` | `layers/features/commands/ui/__tests__/CommandPalette.test.tsx` |

**Create barrel** at `layers/features/commands/index.ts`:

```typescript
export { CommandPalette } from './ui/CommandPalette';
```

**Import updates within moved files**: Update `@/hooks/use-commands` to `@/layers/entities/command`, `@/lib/*` to `@/layers/shared/lib`, `@/components/ui/*` to `@/layers/shared/ui`.

---

### Task 3.3 — Create session-list feature

Move session sidebar components to `layers/features/session-list/`.

**Files to move** (all paths relative to `apps/client/src/`):

| Current Path                                            | New Path                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `components/sessions/SessionSidebar.tsx`                | `layers/features/session-list/ui/SessionSidebar.tsx`                |
| `components/sessions/SessionItem.tsx`                   | `layers/features/session-list/ui/SessionItem.tsx`                   |
| `components/sessions/DirectoryPicker.tsx`               | `layers/features/session-list/ui/DirectoryPicker.tsx`               |
| `components/sessions/__tests__/SessionSidebar.test.tsx` | `layers/features/session-list/ui/__tests__/SessionSidebar.test.tsx` |
| `components/sessions/__tests__/SessionItem.test.tsx`    | `layers/features/session-list/ui/__tests__/SessionItem.test.tsx`    |

**Create barrel** at `layers/features/session-list/index.ts`:

```typescript
export { SessionSidebar } from './ui/SessionSidebar';
```

**Import updates within moved files**: Update `@/hooks/use-sessions` to `@/layers/entities/session`, `@/lib/*` to `@/layers/shared/lib`, `@/components/ui/*` to `@/layers/shared/ui`.

---

### Task 3.4 — Create settings feature

Move settings dialog to `layers/features/settings/`.

**Files to move** (all paths relative to `apps/client/src/`):

| Current Path                                            | New Path                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| `components/settings/SettingsDialog.tsx`                | `layers/features/settings/ui/SettingsDialog.tsx`                |
| `components/settings/__tests__/SettingsDialog.test.tsx` | `layers/features/settings/ui/__tests__/SettingsDialog.test.tsx` |

**Create barrel** at `layers/features/settings/index.ts`:

```typescript
export { SettingsDialog } from './ui/SettingsDialog';
```

**Import updates within moved files**: Update `@/lib/*` to `@/layers/shared/lib`, `@/components/ui/*` to `@/layers/shared/ui`, `@/stores/app-store` to `@/layers/shared/lib`.

---

### Task 3.5 — Create files feature

Move file palette to `layers/features/files/`.

**Files to move** (all paths relative to `apps/client/src/`):

| Current Path                       | New Path                                   |
| ---------------------------------- | ------------------------------------------ |
| `components/files/FilePalette.tsx` | `layers/features/files/ui/FilePalette.tsx` |
| `hooks/use-files.ts`               | `layers/features/files/model/use-files.ts` |

**Create barrel** at `layers/features/files/index.ts`:

```typescript
export { FilePalette } from './ui/FilePalette';
export { useFiles } from './model/use-files';
```

**Import updates within moved files**: Update `@/contexts/TransportContext` to `@/layers/shared/lib`, `@/lib/*` to `@/layers/shared/lib`, `@/components/ui/*` to `@/layers/shared/ui`.

---

### Task 3.6 — Create status feature

Move status bar components and git status hook to `layers/features/status/`.

**Files to move** (all paths relative to `apps/client/src/`):

| Current Path                                                 | New Path                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------- |
| `components/status/StatusLine.tsx`                           | `layers/features/status/ui/StatusLine.tsx`                           |
| `components/status/ContextItem.tsx`                          | `layers/features/status/ui/ContextItem.tsx`                          |
| `components/status/CostItem.tsx`                             | `layers/features/status/ui/CostItem.tsx`                             |
| `components/status/CwdItem.tsx`                              | `layers/features/status/ui/CwdItem.tsx`                              |
| `components/status/GitStatusItem.tsx`                        | `layers/features/status/ui/GitStatusItem.tsx`                        |
| `components/status/ModelItem.tsx`                            | `layers/features/status/ui/ModelItem.tsx`                            |
| `components/status/NotificationSoundItem.tsx`                | `layers/features/status/ui/NotificationSoundItem.tsx`                |
| `components/status/PermissionModeItem.tsx`                   | `layers/features/status/ui/PermissionModeItem.tsx`                   |
| `components/status/__tests__/GitStatusItem.test.tsx`         | `layers/features/status/ui/__tests__/GitStatusItem.test.tsx`         |
| `components/status/__tests__/NotificationSoundItem.test.tsx` | `layers/features/status/ui/__tests__/NotificationSoundItem.test.tsx` |
| `hooks/use-git-status.ts`                                    | `layers/features/status/model/use-git-status.ts`                     |
| `hooks/__tests__/use-git-status.test.tsx`                    | `layers/features/status/model/__tests__/use-git-status.test.tsx`     |

**Create barrel** at `layers/features/status/index.ts`:

```typescript
export { StatusLine } from './ui/StatusLine';
export { useGitStatus } from './model/use-git-status';
```

**Import updates within moved files**: Update `@/hooks/use-session-status` to `@/layers/entities/session`, `@/lib/*` to `@/layers/shared/lib`, `@/components/ui/*` to `@/layers/shared/ui`.

---

### Task 3.7 — Update cross-feature imports in App.tsx and remaining consumers

Update `App.tsx` and any remaining files to import from feature barrels instead of old component paths.

**Import replacement patterns:**

| Old Import                             | New Import                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `@/components/chat/ChatPanel`          | `@/layers/features/chat`                                                          |
| `@/components/commands/CommandPalette` | `@/layers/features/commands`                                                      |
| `@/components/sessions/SessionSidebar` | `@/layers/features/session-list`                                                  |
| `@/components/settings/SettingsDialog` | `@/layers/features/settings`                                                      |
| `@/components/files/FilePalette`       | `@/layers/features/files`                                                         |
| `@/components/status/StatusLine`       | `@/layers/features/status`                                                        |
| `@/hooks/use-chat-session`             | `@/layers/features/chat`                                                          |
| `@/hooks/use-task-state`               | `@/layers/features/chat`                                                          |
| `@/hooks/use-celebrations`             | `@/layers/features/chat` (internal, not exported — only used within chat feature) |
| `@/hooks/use-files`                    | `@/layers/features/files`                                                         |
| `@/hooks/use-git-status`               | `@/layers/features/status`                                                        |

**Files likely affected**: `App.tsx`, `main.tsx`

---

### Task 3.8 — Validate Phase 3

Run full validation suite:

```bash
cd /Users/doriancollier/Keep/144/webui && turbo typecheck && turbo test && turbo build
```

Verify no remaining imports to old `@/components/chat/`, `@/components/commands/`, `@/components/sessions/`, `@/components/settings/`, `@/components/files/`, `@/components/status/`, or feature-level hooks.

---

## Phase 4: Widgets Layer + Cleanup

### Task 4.1 — Create app-layout widget

Move layout components to `layers/widgets/app-layout/`.

**Files to move** (all paths relative to `apps/client/src/`):

| Current Path                                            | New Path                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `components/layout/PermissionBanner.tsx`                | `layers/widgets/app-layout/ui/PermissionBanner.tsx`                |
| `components/layout/__tests__/PermissionBanner.test.tsx` | `layers/widgets/app-layout/ui/__tests__/PermissionBanner.test.tsx` |

**Create barrel** at `layers/widgets/app-layout/index.ts`:

```typescript
export { PermissionBanner } from './ui/PermissionBanner';
```

**Import updates within moved files**: Update `@/lib/*` to `@/layers/shared/lib`, `@/components/ui/*` to `@/layers/shared/ui`.

**Update consumers**: Replace `@/components/layout/PermissionBanner` with `@/layers/widgets/app-layout` in `App.tsx`.

---

### Task 4.2 — Update App.tsx and main.tsx final imports

Ensure `App.tsx` and `main.tsx` use only `@/layers/` barrel imports. Consolidate any remaining old-style imports.

**Expected App.tsx imports** (approximately):

```typescript
import {
  useAppStore,
  useTransport,
  TransportProvider,
  HttpTransport,
  useTheme,
  useFavicon,
  useDocumentTitle,
  useInteractiveShortcuts,
} from '@/layers/shared/lib';
import {
  useSessions,
  useSessionId,
  useDirectoryState,
  useDefaultCwd,
} from '@/layers/entities/session';
import { ChatPanel, useChatSession, useTaskState } from '@/layers/features/chat';
import { CommandPalette } from '@/layers/features/commands';
import { SessionSidebar } from '@/layers/features/session-list';
import { SettingsDialog } from '@/layers/features/settings';
import { FilePalette } from '@/layers/features/files';
import { StatusLine } from '@/layers/features/status';
import { PermissionBanner } from '@/layers/widgets/app-layout';
```

**Expected main.tsx imports**:

```typescript
import { TransportProvider, HttpTransport } from '@/layers/shared/lib';
```

---

### Task 4.3 — Delete empty old directories

Remove all empty source directories after migration is complete.

**Directories to delete** (all under `apps/client/src/`):

- `components/ui/` (if empty)
- `components/chat/` (if empty)
- `components/commands/` (if empty)
- `components/sessions/` (if empty)
- `components/settings/` (if empty)
- `components/files/` (if empty)
- `components/status/` (if empty)
- `components/layout/` (if empty)
- `components/` (if empty)
- `hooks/` (if empty)
- `stores/` (if empty)
- `contexts/` (if empty)
- `lib/` (if empty)

**Verify** no files remain in these directories before deleting. Use `find apps/client/src/{components,hooks,stores,contexts,lib} -type f` to check.

---

### Task 4.4 — Final validation

Run complete validation:

```bash
cd /Users/doriancollier/Keep/144/webui && turbo typecheck && turbo test && turbo build
```

Then run `turbo dev` and perform smoke test:

- App loads in browser
- Session list renders
- Chat messaging works
- Command palette opens (Cmd+K)
- Settings dialog opens
- Status bar displays
- File palette works

Verify no imports to old paths remain:

```bash
grep -r '@/components/' apps/client/src/ --include='*.ts' --include='*.tsx' | grep -v node_modules
grep -r '@/hooks/' apps/client/src/ --include='*.ts' --include='*.tsx' | grep -v node_modules
grep -r '@/stores/' apps/client/src/ --include='*.ts' --include='*.tsx' | grep -v node_modules
grep -r '@/contexts/' apps/client/src/ --include='*.ts' --include='*.tsx' | grep -v node_modules
grep -r '@/lib/' apps/client/src/ --include='*.ts' --include='*.tsx' | grep -v node_modules
```

All should return zero results.

---

## Dependency Graph

```
Phase 1:  1.1 → 1.2 → 1.3 → 1.4 → 1.5
                                      │
Phase 2:                    2.1 ──┐   │
                            2.2 ──┤   │
                                  ├→ 2.3 → 2.4
                                            │
Phase 3:          3.1 ──┐                   │
                  3.2 ──┤                   │
                  3.3 ──┤                   │
                  3.4 ──┼→ 3.7 → 3.8       │
                  3.5 ──┤                   │
                  3.6 ──┘                   │
                                    │
Phase 4:                    4.1 → 4.2 → 4.3 → 4.4
```

- **1.5** blocks all Phase 2 tasks
- **2.4** blocks all Phase 3 tasks
- **2.1** and **2.2** can run in parallel
- **3.1** through **3.6** can all run in parallel
- **3.7** depends on 3.1-3.6 completing
- **3.8** blocks all Phase 4 tasks
- **4.1** through **4.3** are sequential
- **4.4** is the final validation gate
