# Specification: FSD Client Architecture Migration

**Status:** Draft
**Authors:** Claude Code
**Date:** 2026-02-15
**Spec:** specs/fsd-architecture/02-specification.md
**Ideation:** specs/fsd-architecture/01-ideation.md

---

## 1. Overview

Migrate the DorkOS client app (`apps/client/src/`) from its current flat domain-grouped structure to Feature-Sliced Design (FSD) layer architecture. This is a pure file reorganization — no new features, no behavior changes. Every file under `src/` (except `App.tsx`, `main.tsx`, `index.css`, `vite-env.d.ts`) moves into `src/layers/`.

---

## 2. Background / Problem Statement

The client currently uses an ad-hoc domain-grouped structure (`components/{domain}/`, `hooks/`, `stores/`, `lib/`, `contexts/`). As the team grows from 1 to 10 developers and the codebase doubles or triples, this structure creates problems:

- **No import discipline** — any file can import from any other file, making dependency direction unclear
- **Unclear ownership** — hooks used by a single feature live in a global `hooks/` directory
- **No public API boundaries** — internal implementation details are freely imported across domains
- **Difficult onboarding** — new developers can't infer where new code should go

FSD provides strict unidirectional layer dependencies (`shared < entities < features < widgets`) and co-location of related code, solving all four problems.

---

## 3. Goals

- All client source files live under `src/layers/` (except entry points)
- All imports updated to use `@/layers/` paths
- Every FSD module has an `index.ts` barrel export defining its public API
- No layer violations (lower layers never import from higher)
- Zero behavior changes — app works identically before and after
- All builds, tests, and type checks pass

---

## 4. Non-Goals

- No new features or UI changes
- No server changes (stays flat `routes/` + `services/`)
- No changes to `packages/shared`, `packages/cli`, `packages/test-utils`, `packages/typescript-config`
- No changes to `apps/obsidian-plugin`
- No ESLint boundary enforcement (future follow-up)
- No splitting of Zustand store (stays monolithic in `shared/lib/`)

---

## 5. Technical Dependencies

- **No new libraries required** — this is purely a file reorganization
- **Existing tooling**: Vite 6 (path alias `@/*`), TypeScript (path mapping), Vitest (test runner)
- **Reference project**: `/Users/doriancollier/Keep/144/next_starter` — FSD patterns adapted from here

---

## 6. Detailed Design

### 6.1 Target Directory Structure

```
apps/client/src/
├── layers/
│   ├── shared/                          # Layer 1: Domain-agnostic primitives
│   │   ├── ui/                          # Shadcn UI components
│   │   │   ├── badge.tsx
│   │   │   ├── dialog.tsx
│   │   │   ├── drawer.tsx
│   │   │   ├── dropdown-menu.tsx
│   │   │   ├── hover-card.tsx
│   │   │   ├── kbd.tsx
│   │   │   ├── label.tsx
│   │   │   ├── path-breadcrumb.tsx
│   │   │   ├── responsive-dialog.tsx
│   │   │   ├── responsive-dropdown-menu.tsx
│   │   │   ├── select.tsx
│   │   │   ├── separator.tsx
│   │   │   ├── switch.tsx
│   │   │   ├── tabs.tsx
│   │   │   ├── __tests__/
│   │   │   │   └── kbd.test.tsx
│   │   │   └── index.ts
│   │   └── lib/                         # Utilities, Transport, stores
│   │       ├── utils.ts
│   │       ├── platform.ts
│   │       ├── fuzzy-match.ts
│   │       ├── http-transport.ts
│   │       ├── direct-transport.ts
│   │       ├── TransportContext.tsx
│   │       ├── app-store.ts
│   │       ├── font-config.ts
│   │       ├── font-loader.ts
│   │       ├── favicon-utils.ts
│   │       ├── notification-sound.ts
│   │       ├── session-utils.ts
│   │       ├── tool-labels.ts
│   │       ├── tool-arguments-formatter.tsx
│   │       ├── celebrations/
│   │       │   ├── celebration-engine.ts
│   │       │   ├── effects.ts
│   │       │   └── __tests__/
│   │       │       ├── celebration-engine.test.ts
│   │       │       └── effects.test.ts
│   │       ├── __tests__/
│   │       │   ├── favicon-utils.test.ts
│   │       │   ├── font-config.test.ts
│   │       │   ├── font-loader.test.ts
│   │       │   ├── fuzzy-match.test.ts
│   │       │   ├── notification-sound.test.ts
│   │       │   ├── platform.test.ts
│   │       │   ├── session-utils.test.ts
│   │       │   ├── tool-arguments-formatter.test.tsx
│   │       │   ├── tool-labels.test.ts
│   │       │   └── app-store.test.ts
│   │       └── index.ts
│   │
│   ├── entities/                        # Layer 2: Business domain objects
│   │   ├── session/
│   │   │   ├── model/
│   │   │   │   ├── use-sessions.ts
│   │   │   │   ├── use-session-id.ts
│   │   │   │   ├── use-session-status.ts
│   │   │   │   ├── use-default-cwd.ts
│   │   │   │   ├── use-directory-state.ts
│   │   │   │   └── __tests__/
│   │   │   │       ├── use-sessions.test.tsx
│   │   │   │       └── use-directory-state.test.tsx
│   │   │   └── index.ts
│   │   └── command/
│   │       ├── model/
│   │       │   └── use-commands.ts
│   │       └── index.ts
│   │
│   ├── features/                        # Layer 3: User-facing features
│   │   ├── chat/
│   │   │   ├── ui/
│   │   │   │   ├── ChatPanel.tsx
│   │   │   │   ├── MessageList.tsx
│   │   │   │   ├── MessageItem.tsx
│   │   │   │   ├── ChatInput.tsx
│   │   │   │   ├── ToolCallCard.tsx
│   │   │   │   ├── ToolApproval.tsx
│   │   │   │   ├── QuestionPrompt.tsx
│   │   │   │   ├── StreamingText.tsx
│   │   │   │   ├── CelebrationOverlay.tsx
│   │   │   │   ├── InferenceIndicator.tsx
│   │   │   │   ├── DragHandle.tsx
│   │   │   │   ├── ShortcutChips.tsx
│   │   │   │   ├── TaskListPanel.tsx
│   │   │   │   └── __tests__/
│   │   │   │       ├── ChatPanel.test.tsx
│   │   │   │       ├── ChatInput.test.tsx
│   │   │   │       ├── MessageList.test.tsx
│   │   │   │       ├── MessageItem.test.tsx
│   │   │   │       ├── ToolCallCard.test.tsx
│   │   │   │       ├── ToolApproval.test.tsx
│   │   │   │       ├── QuestionPrompt.test.tsx
│   │   │   │       ├── StreamingText.test.tsx
│   │   │   │       ├── CelebrationOverlay.test.tsx
│   │   │   │       ├── InferenceIndicator.test.tsx
│   │   │   │       ├── DragHandle.test.tsx
│   │   │   │       ├── ShortcutChips.test.tsx
│   │   │   │       └── TaskListPanel.test.tsx
│   │   │   ├── model/
│   │   │   │   ├── use-chat-session.ts
│   │   │   │   ├── use-task-state.ts
│   │   │   │   ├── use-celebrations.ts
│   │   │   │   ├── use-rotating-verb.ts
│   │   │   │   ├── inference-verbs.ts
│   │   │   │   ├── inference-themes.ts
│   │   │   │   └── __tests__/
│   │   │   │       ├── use-chat-session.test.tsx
│   │   │   │       └── use-rotating-verb.test.ts
│   │   │   └── index.ts
│   │   │
│   │   ├── commands/
│   │   │   ├── ui/
│   │   │   │   ├── CommandPalette.tsx
│   │   │   │   └── __tests__/
│   │   │   │       └── CommandPalette.test.tsx
│   │   │   └── index.ts
│   │   │
│   │   ├── session-list/
│   │   │   ├── ui/
│   │   │   │   ├── SessionSidebar.tsx
│   │   │   │   ├── SessionItem.tsx
│   │   │   │   ├── DirectoryPicker.tsx
│   │   │   │   └── __tests__/
│   │   │   │       ├── SessionSidebar.test.tsx
│   │   │   │       └── SessionItem.test.tsx
│   │   │   └── index.ts
│   │   │
│   │   ├── settings/
│   │   │   ├── ui/
│   │   │   │   ├── SettingsDialog.tsx
│   │   │   │   └── __tests__/
│   │   │   │       └── SettingsDialog.test.tsx
│   │   │   └── index.ts
│   │   │
│   │   ├── files/
│   │   │   ├── ui/
│   │   │   │   └── FilePalette.tsx
│   │   │   ├── model/
│   │   │   │   └── use-files.ts
│   │   │   └── index.ts
│   │   │
│   │   └── status/
│   │       ├── ui/
│   │       │   ├── StatusLine.tsx
│   │       │   ├── ContextItem.tsx
│   │       │   ├── CostItem.tsx
│   │       │   ├── CwdItem.tsx
│   │       │   ├── GitStatusItem.tsx
│   │       │   ├── ModelItem.tsx
│   │       │   ├── NotificationSoundItem.tsx
│   │       │   ├── PermissionModeItem.tsx
│   │       │   └── __tests__/
│   │       │       ├── GitStatusItem.test.tsx
│   │       │       └── NotificationSoundItem.test.tsx
│   │       ├── model/
│   │       │   ├── use-git-status.ts
│   │       │   └── __tests__/
│   │       │       └── use-git-status.test.tsx
│   │       └── index.ts
│   │
│   └── widgets/                         # Layer 4: Compositions of features
│       └── app-layout/
│           ├── ui/
│           │   ├── PermissionBanner.tsx
│           │   └── __tests__/
│           │       └── PermissionBanner.test.tsx
│           └── index.ts
│
├── App.tsx                              # App entry (stays at root)
├── main.tsx                             # Vite entry (stays at root)
├── index.css                            # Global styles (stays at root)
└── vite-env.d.ts                        # Vite types (stays at root)
```

### 6.2 File Migration Map

Complete mapping of every file from current location to FSD location.

#### Shared Layer — UI Segment

| Current Path | FSD Path |
|---|---|
| `components/ui/badge.tsx` | `layers/shared/ui/badge.tsx` |
| `components/ui/dialog.tsx` | `layers/shared/ui/dialog.tsx` |
| `components/ui/drawer.tsx` | `layers/shared/ui/drawer.tsx` |
| `components/ui/dropdown-menu.tsx` | `layers/shared/ui/dropdown-menu.tsx` |
| `components/ui/hover-card.tsx` | `layers/shared/ui/hover-card.tsx` |
| `components/ui/kbd.tsx` | `layers/shared/ui/kbd.tsx` |
| `components/ui/label.tsx` | `layers/shared/ui/label.tsx` |
| `components/ui/path-breadcrumb.tsx` | `layers/shared/ui/path-breadcrumb.tsx` |
| `components/ui/responsive-dialog.tsx` | `layers/shared/ui/responsive-dialog.tsx` |
| `components/ui/responsive-dropdown-menu.tsx` | `layers/shared/ui/responsive-dropdown-menu.tsx` |
| `components/ui/select.tsx` | `layers/shared/ui/select.tsx` |
| `components/ui/separator.tsx` | `layers/shared/ui/separator.tsx` |
| `components/ui/switch.tsx` | `layers/shared/ui/switch.tsx` |
| `components/ui/tabs.tsx` | `layers/shared/ui/tabs.tsx` |
| `components/ui/__tests__/kbd.test.tsx` | `layers/shared/ui/__tests__/kbd.test.tsx` |

#### Shared Layer — Lib Segment

| Current Path | FSD Path |
|---|---|
| `lib/utils.ts` | `layers/shared/lib/utils.ts` |
| `lib/platform.ts` | `layers/shared/lib/platform.ts` |
| `lib/fuzzy-match.ts` | `layers/shared/lib/fuzzy-match.ts` |
| `lib/http-transport.ts` | `layers/shared/lib/http-transport.ts` |
| `lib/direct-transport.ts` | `layers/shared/lib/direct-transport.ts` |
| `contexts/TransportContext.tsx` | `layers/shared/lib/TransportContext.tsx` |
| `stores/app-store.ts` | `layers/shared/lib/app-store.ts` |
| `lib/font-config.ts` | `layers/shared/lib/font-config.ts` |
| `lib/font-loader.ts` | `layers/shared/lib/font-loader.ts` |
| `lib/favicon-utils.ts` | `layers/shared/lib/favicon-utils.ts` |
| `lib/notification-sound.ts` | `layers/shared/lib/notification-sound.ts` |
| `lib/session-utils.ts` | `layers/shared/lib/session-utils.ts` |
| `lib/tool-labels.ts` | `layers/shared/lib/tool-labels.ts` |
| `lib/tool-arguments-formatter.tsx` | `layers/shared/lib/tool-arguments-formatter.tsx` |
| `lib/celebrations/celebration-engine.ts` | `layers/shared/lib/celebrations/celebration-engine.ts` |
| `lib/celebrations/effects.ts` | `layers/shared/lib/celebrations/effects.ts` |
| `lib/celebrations/__tests__/celebration-engine.test.ts` | `layers/shared/lib/celebrations/__tests__/celebration-engine.test.ts` |
| `lib/celebrations/__tests__/effects.test.ts` | `layers/shared/lib/celebrations/__tests__/effects.test.ts` |
| `lib/__tests__/favicon-utils.test.ts` | `layers/shared/lib/__tests__/favicon-utils.test.ts` |
| `lib/__tests__/font-config.test.ts` | `layers/shared/lib/__tests__/font-config.test.ts` |
| `lib/__tests__/font-loader.test.ts` | `layers/shared/lib/__tests__/font-loader.test.ts` |
| `lib/__tests__/fuzzy-match.test.ts` | `layers/shared/lib/__tests__/fuzzy-match.test.ts` |
| `lib/__tests__/notification-sound.test.ts` | `layers/shared/lib/__tests__/notification-sound.test.ts` |
| `lib/__tests__/platform.test.ts` | `layers/shared/lib/__tests__/platform.test.ts` |
| `lib/__tests__/session-utils.test.ts` | `layers/shared/lib/__tests__/session-utils.test.ts` |
| `lib/__tests__/tool-arguments-formatter.test.tsx` | `layers/shared/lib/__tests__/tool-arguments-formatter.test.tsx` |
| `lib/__tests__/tool-labels.test.ts` | `layers/shared/lib/__tests__/tool-labels.test.ts` |
| `stores/__tests__/app-store.test.ts` | `layers/shared/lib/__tests__/app-store.test.ts` |

#### Entities Layer

| Current Path | FSD Path |
|---|---|
| `hooks/use-sessions.ts` | `layers/entities/session/model/use-sessions.ts` |
| `hooks/use-session-id.ts` | `layers/entities/session/model/use-session-id.ts` |
| `hooks/use-session-status.ts` | `layers/entities/session/model/use-session-status.ts` |
| `hooks/use-default-cwd.ts` | `layers/entities/session/model/use-default-cwd.ts` |
| `hooks/use-directory-state.ts` | `layers/entities/session/model/use-directory-state.ts` |
| `hooks/__tests__/use-sessions.test.tsx` | `layers/entities/session/model/__tests__/use-sessions.test.tsx` |
| `hooks/__tests__/use-directory-state.test.tsx` | `layers/entities/session/model/__tests__/use-directory-state.test.tsx` |
| `hooks/use-commands.ts` | `layers/entities/command/model/use-commands.ts` |

#### Features Layer — Chat

| Current Path | FSD Path |
|---|---|
| `components/chat/ChatPanel.tsx` | `layers/features/chat/ui/ChatPanel.tsx` |
| `components/chat/MessageList.tsx` | `layers/features/chat/ui/MessageList.tsx` |
| `components/chat/MessageItem.tsx` | `layers/features/chat/ui/MessageItem.tsx` |
| `components/chat/ChatInput.tsx` | `layers/features/chat/ui/ChatInput.tsx` |
| `components/chat/ToolCallCard.tsx` | `layers/features/chat/ui/ToolCallCard.tsx` |
| `components/chat/ToolApproval.tsx` | `layers/features/chat/ui/ToolApproval.tsx` |
| `components/chat/QuestionPrompt.tsx` | `layers/features/chat/ui/QuestionPrompt.tsx` |
| `components/chat/StreamingText.tsx` | `layers/features/chat/ui/StreamingText.tsx` |
| `components/chat/CelebrationOverlay.tsx` | `layers/features/chat/ui/CelebrationOverlay.tsx` |
| `components/chat/InferenceIndicator.tsx` | `layers/features/chat/ui/InferenceIndicator.tsx` |
| `components/chat/DragHandle.tsx` | `layers/features/chat/ui/DragHandle.tsx` |
| `components/chat/ShortcutChips.tsx` | `layers/features/chat/ui/ShortcutChips.tsx` |
| `components/chat/TaskListPanel.tsx` | `layers/features/chat/ui/TaskListPanel.tsx` |
| `components/chat/__tests__/*` | `layers/features/chat/ui/__tests__/*` |
| `components/chat/inference-verbs.ts` | `layers/features/chat/model/inference-verbs.ts` |
| `components/chat/inference-themes.ts` | `layers/features/chat/model/inference-themes.ts` |
| `hooks/use-chat-session.ts` | `layers/features/chat/model/use-chat-session.ts` |
| `hooks/use-task-state.ts` | `layers/features/chat/model/use-task-state.ts` |
| `hooks/use-celebrations.ts` | `layers/features/chat/model/use-celebrations.ts` |
| `hooks/use-rotating-verb.ts` | `layers/features/chat/model/use-rotating-verb.ts` |
| `hooks/__tests__/use-chat-session.test.tsx` | `layers/features/chat/model/__tests__/use-chat-session.test.tsx` |
| `hooks/__tests__/use-rotating-verb.test.ts` | `layers/features/chat/model/__tests__/use-rotating-verb.test.ts` |

#### Features Layer — Other Features

| Current Path | FSD Path |
|---|---|
| `components/commands/CommandPalette.tsx` | `layers/features/commands/ui/CommandPalette.tsx` |
| `components/commands/__tests__/CommandPalette.test.tsx` | `layers/features/commands/ui/__tests__/CommandPalette.test.tsx` |
| `components/sessions/SessionSidebar.tsx` | `layers/features/session-list/ui/SessionSidebar.tsx` |
| `components/sessions/SessionItem.tsx` | `layers/features/session-list/ui/SessionItem.tsx` |
| `components/sessions/DirectoryPicker.tsx` | `layers/features/session-list/ui/DirectoryPicker.tsx` |
| `components/sessions/__tests__/SessionSidebar.test.tsx` | `layers/features/session-list/ui/__tests__/SessionSidebar.test.tsx` |
| `components/sessions/__tests__/SessionItem.test.tsx` | `layers/features/session-list/ui/__tests__/SessionItem.test.tsx` |
| `components/settings/SettingsDialog.tsx` | `layers/features/settings/ui/SettingsDialog.tsx` |
| `components/settings/__tests__/SettingsDialog.test.tsx` | `layers/features/settings/ui/__tests__/SettingsDialog.test.tsx` |
| `components/files/FilePalette.tsx` | `layers/features/files/ui/FilePalette.tsx` |
| `hooks/use-files.ts` | `layers/features/files/model/use-files.ts` |
| `components/status/StatusLine.tsx` | `layers/features/status/ui/StatusLine.tsx` |
| `components/status/ContextItem.tsx` | `layers/features/status/ui/ContextItem.tsx` |
| `components/status/CostItem.tsx` | `layers/features/status/ui/CostItem.tsx` |
| `components/status/CwdItem.tsx` | `layers/features/status/ui/CwdItem.tsx` |
| `components/status/GitStatusItem.tsx` | `layers/features/status/ui/GitStatusItem.tsx` |
| `components/status/ModelItem.tsx` | `layers/features/status/ui/ModelItem.tsx` |
| `components/status/NotificationSoundItem.tsx` | `layers/features/status/ui/NotificationSoundItem.tsx` |
| `components/status/PermissionModeItem.tsx` | `layers/features/status/ui/PermissionModeItem.tsx` |
| `components/status/__tests__/GitStatusItem.test.tsx` | `layers/features/status/ui/__tests__/GitStatusItem.test.tsx` |
| `components/status/__tests__/NotificationSoundItem.test.tsx` | `layers/features/status/ui/__tests__/NotificationSoundItem.test.tsx` |
| `hooks/use-git-status.ts` | `layers/features/status/model/use-git-status.ts` |
| `hooks/__tests__/use-git-status.test.tsx` | `layers/features/status/model/__tests__/use-git-status.test.tsx` |

#### Widgets Layer

| Current Path | FSD Path |
|---|---|
| `components/layout/PermissionBanner.tsx` | `layers/widgets/app-layout/ui/PermissionBanner.tsx` |
| `components/layout/__tests__/PermissionBanner.test.tsx` | `layers/widgets/app-layout/ui/__tests__/PermissionBanner.test.tsx` |

#### Hooks that stay in Shared (UI-only, no domain)

| Current Path | FSD Path |
|---|---|
| `hooks/use-theme.ts` | `layers/shared/lib/use-theme.ts` |
| `hooks/use-is-mobile.ts` | `layers/shared/lib/use-is-mobile.ts` |
| `hooks/use-favicon.ts` | `layers/shared/lib/use-favicon.ts` |
| `hooks/use-document-title.ts` | `layers/shared/lib/use-document-title.ts` |
| `hooks/use-elapsed-time.ts` | `layers/shared/lib/use-elapsed-time.ts` |
| `hooks/use-idle-detector.ts` | `layers/shared/lib/use-idle-detector.ts` |
| `hooks/use-interactive-shortcuts.ts` | `layers/shared/lib/use-interactive-shortcuts.ts` |
| `hooks/use-long-press.ts` | `layers/shared/lib/use-long-press.ts` |
| `hooks/__tests__/use-document-title.test.ts` | `layers/shared/lib/__tests__/use-document-title.test.ts` |
| `hooks/__tests__/use-elapsed-time.test.ts` | `layers/shared/lib/__tests__/use-elapsed-time.test.ts` |
| `hooks/__tests__/use-favicon.test.ts` | `layers/shared/lib/__tests__/use-favicon.test.ts` |
| `hooks/__tests__/use-idle-detector.test.ts` | `layers/shared/lib/__tests__/use-idle-detector.test.ts` |
| `hooks/__tests__/use-interactive-shortcuts.test.ts` | `layers/shared/lib/__tests__/use-interactive-shortcuts.test.ts` |

#### Root Files (Stay in Place)

| File | Action |
|---|---|
| `App.tsx` | Stays at `src/App.tsx` — update imports to `@/layers/` |
| `main.tsx` | Stays at `src/main.tsx` — update imports to `@/layers/` |
| `index.css` | Stays at `src/index.css` — no changes |
| `vite-env.d.ts` | Stays at `src/vite-env.d.ts` — no changes |

### 6.3 Barrel Exports (index.ts)

Every FSD module gets an `index.ts` that defines its public API. Consumers must import from the barrel, never from internal paths.

#### `layers/shared/ui/index.ts`
```typescript
export { Badge, badgeVariants } from './badge'
export { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from './dialog'
export { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle, DrawerTrigger } from './drawer'
export { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './dropdown-menu'
export { HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card'
export { Kbd } from './kbd'
export { Label } from './label'
export { PathBreadcrumb } from './path-breadcrumb'
export { ResponsiveDialog } from './responsive-dialog'
export { ResponsiveDropdownMenu } from './responsive-dropdown-menu'
export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'
export { Separator } from './separator'
export { Switch } from './switch'
export { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs'
```

#### `layers/shared/lib/index.ts`
```typescript
export { cn } from './utils'
export { getPlatform, setPlatformAdapter, type PlatformAdapter } from './platform'
export { fuzzyMatch } from './fuzzy-match'
export { HttpTransport } from './http-transport'
export { DirectTransport } from './direct-transport'
export { TransportProvider, useTransport } from './TransportContext'
export { useAppStore, type ContextFile, type RecentCwd } from './app-store'
export { getToolLabel, isToolDangerous } from './tool-labels'
export { ToolArgumentsDisplay } from './tool-arguments-formatter'
export { updateFavicon } from './favicon-utils'
export { playNotificationSound } from './notification-sound'
export { groupSessionsByTime, shortenHomePath, formatRelativeTime } from './session-utils'
export { type FontFamilyKey, type FontConfig, DEFAULT_FONT, getFontConfig, isValidFontKey, FONT_FAMILIES } from './font-config'
export { loadGoogleFont, removeGoogleFont, applyFontCSS, removeFontCSS } from './font-loader'
export { CelebrationEngine } from './celebrations/celebration-engine'
export { useTheme, type Theme } from './use-theme'
export { useIsMobile } from './use-is-mobile'
export { useFavicon } from './use-favicon'
export { useDocumentTitle } from './use-document-title'
export { useElapsedTime } from './use-elapsed-time'
export { useIdleDetector } from './use-idle-detector'
export { useInteractiveShortcuts } from './use-interactive-shortcuts'
export { useLongPress } from './use-long-press'
```

#### `layers/entities/session/index.ts`
```typescript
export { useSessions } from './model/use-sessions'
export { useSessionId } from './model/use-session-id'
export { useSessionStatus, type SessionStatusData } from './model/use-session-status'
export { useDefaultCwd } from './model/use-default-cwd'
export { useDirectoryState } from './model/use-directory-state'
```

#### `layers/entities/command/index.ts`
```typescript
export { useCommands } from './model/use-commands'
```

#### `layers/features/chat/index.ts`
```typescript
export { ChatPanel } from './ui/ChatPanel'
export { useChatSession, type ChatMessage, type ToolCallState, type MessageGrouping, type GroupPosition } from './model/use-chat-session'
export { useTaskState, type TaskState } from './model/use-task-state'
```

#### `layers/features/commands/index.ts`
```typescript
export { CommandPalette } from './ui/CommandPalette'
```

#### `layers/features/session-list/index.ts`
```typescript
export { SessionSidebar } from './ui/SessionSidebar'
```

#### `layers/features/settings/index.ts`
```typescript
export { SettingsDialog } from './ui/SettingsDialog'
```

#### `layers/features/files/index.ts`
```typescript
export { FilePalette } from './ui/FilePalette'
export { useFiles } from './model/use-files'
```

#### `layers/features/status/index.ts`
```typescript
export { StatusLine } from './ui/StatusLine'
export { useGitStatus } from './model/use-git-status'
```

#### `layers/widgets/app-layout/index.ts`
```typescript
export { PermissionBanner } from './ui/PermissionBanner'
```

### 6.4 Import Update Rules

All internal imports must be updated. The patterns:

| Old Import | New Import |
|---|---|
| `@/components/ui/*` | `@/layers/shared/ui` (barrel) |
| `@/lib/utils` | `@/layers/shared/lib` (barrel) |
| `@/lib/*` | `@/layers/shared/lib` (barrel) |
| `@/contexts/TransportContext` | `@/layers/shared/lib` (barrel) |
| `@/stores/app-store` | `@/layers/shared/lib` (barrel) |
| `@/hooks/use-sessions` | `@/layers/entities/session` (barrel) |
| `@/hooks/use-session-id` | `@/layers/entities/session` (barrel) |
| `@/hooks/use-commands` | `@/layers/entities/command` (barrel) |
| `@/hooks/use-chat-session` | `@/layers/features/chat` (barrel) |
| `@/hooks/use-theme` | `@/layers/shared/lib` (barrel) |
| `@/hooks/use-is-mobile` | `@/layers/shared/lib` (barrel) |
| `@/components/chat/ChatPanel` | `@/layers/features/chat` (barrel) |
| `@/components/sessions/SessionSidebar` | `@/layers/features/session-list` (barrel) |

**Exception — Internal sibling imports**: Within the same FSD module, files import each other via relative paths (e.g., `./MessageItem` within `features/chat/ui/`). These do NOT go through barrels.

**Exception — Cross-package imports**: `@dorkos/shared/types`, `@dorkos/shared/transport`, `@tanstack/*`, etc. are unchanged.

### 6.5 Layer Dependency Rules

Strict unidirectional imports:

```
widgets → features → entities → shared
```

| Layer | Can Import From |
|-------|----------------|
| `shared` | External packages only (`@dorkos/shared`, `react`, etc.) |
| `entities` | `shared` + external packages |
| `features` | `entities` + `shared` + external packages |
| `widgets` | `features` + `entities` + `shared` + external packages |
| `App.tsx` (app layer) | All layers |

Cross-layer imports between peers (e.g., `features/chat` → `features/status`) are **not allowed**.

### 6.6 Vite Configuration

No vite.config.ts changes needed. The existing `@/*` → `./src/*` alias already supports `@/layers/*` paths. TypeScript `tsconfig.json` path mapping similarly needs no changes.

---

## 7. User Experience

No user-facing changes. The app looks and behaves identically after migration.

---

## 8. Testing Strategy

### Approach: Update Imports Only

Tests move alongside their source files (co-located in `__tests__/` directories). The only changes to test files are import path updates.

### Validation

After each phase:

1. `turbo typecheck` — all types resolve
2. `turbo test` — all tests pass (import paths updated)
3. `turbo build` — Vite bundles successfully

### Smoke Test

After full migration, run `turbo dev` and verify:
- App loads in browser
- Session list renders
- Chat messaging works
- Command palette opens
- Settings dialog opens
- Status bar displays

---

## 9. Performance Considerations

- **No runtime impact** — this is purely a file reorganization
- **Build performance** — Vite resolves `@/layers/*` identically to `@/components/*` (same alias mechanism). No measurable build time change.
- **Barrel exports** — Vite's tree-shaking eliminates unused re-exports in production builds. Development HMR is unaffected since individual files are still the modules.

---

## 10. Security Considerations

No security impact. No new dependencies, no API changes, no data flow changes.

---

## 11. Documentation Updates

After migration completes:

| Document | Changes |
|---|---|
| `CLAUDE.md` | Update client directory structure section, add FSD layer reference |
| `guides/architecture.md` | Add FSD layer mapping, update module layout |
| `guides/01-project-structure.md` | Already created for FSD — verify accuracy post-migration |

---

## 12. Implementation Phases

### Phase 1: Shared Layer

Move foundation files that everything else depends on. This is the highest-risk phase since every other file imports from these.

**Files moved**: All `components/ui/*`, `lib/*`, `contexts/*`, `stores/*`, and domain-agnostic hooks.

**Barrel exports created**: `layers/shared/ui/index.ts`, `layers/shared/lib/index.ts`

**Imports updated in**: Every file that imports from `@/lib/`, `@/components/ui/`, `@/contexts/`, `@/stores/`, or domain-agnostic hooks.

**Validation**: `turbo typecheck && turbo test && turbo build`

### Phase 2: Entities Layer

Move session and command domain hooks.

**Files moved**: `hooks/use-sessions.ts`, `hooks/use-session-id.ts`, `hooks/use-session-status.ts`, `hooks/use-default-cwd.ts`, `hooks/use-directory-state.ts`, `hooks/use-commands.ts` (and their tests).

**Barrel exports created**: `layers/entities/session/index.ts`, `layers/entities/command/index.ts`

**Imports updated in**: `App.tsx`, `ChatPanel.tsx`, `SessionSidebar.tsx`, and other consumers of session/command hooks.

**Validation**: `turbo typecheck && turbo test && turbo build`

### Phase 3: Features Layer

Move all feature components and their co-located hooks.

**Files moved**: `components/chat/*`, `components/commands/*`, `components/sessions/*`, `components/settings/*`, `components/files/*`, `components/status/*`, plus `hooks/use-chat-session.ts`, `hooks/use-task-state.ts`, `hooks/use-celebrations.ts`, `hooks/use-rotating-verb.ts`, `hooks/use-files.ts`, `hooks/use-git-status.ts` (and all tests).

**Barrel exports created**: `layers/features/chat/index.ts`, `layers/features/commands/index.ts`, `layers/features/session-list/index.ts`, `layers/features/settings/index.ts`, `layers/features/files/index.ts`, `layers/features/status/index.ts`

**Imports updated in**: `App.tsx`, `ChatPanel.tsx` (cross-feature imports like CommandPalette, StatusLine), `SessionSidebar.tsx` (SettingsDialog).

**Validation**: `turbo typecheck && turbo test && turbo build`

### Phase 4: Widgets Layer + Cleanup

Move layout components and delete empty old directories.

**Files moved**: `components/layout/PermissionBanner.tsx` (and test).

**Barrel export created**: `layers/widgets/app-layout/index.ts`

**Cleanup**: Delete empty `components/`, `hooks/`, `stores/`, `contexts/`, `lib/` directories.

**Update App.tsx and main.tsx**: Final import updates to use `@/layers/` barrel imports.

**Final validation**: `turbo typecheck && turbo test && turbo build`

---

## 13. Open Questions

None — all decisions resolved during ideation:

| Question | Decision |
|---|---|
| Server structure | Keep flat; size-aware rules in harness |
| Layer scope | All 4 layers from day one |
| Barrel exports | Yes, all modules |
| Path alias | Keep `@/*` → `./src/*` |
| Harness | Configured for future FSD structure (already done) |

---

## 14. Rollback Strategy

Since this is a pure file move with import updates:

```bash
# Full rollback via git
git checkout -- apps/client/src/
```

If mid-migration and partially completed:
- Each phase is independently validated
- Partial migration is a valid intermediate state (some files moved, some not)
- The `@/*` alias resolves both old and new paths since both are under `src/`

---

## 15. References

- **Ideation document**: `specs/fsd-architecture/01-ideation.md`
- **FSD skill**: `.claude/skills/organizing-fsd-architecture/SKILL.md`
- **FSD layer rules**: `.claude/rules/fsd-layers.md`
- **Project structure guide**: `guides/01-project-structure.md`
- **Component rules**: `.claude/rules/components.md` (updated with FSD awareness)
- **Reference project**: `/Users/doriancollier/Keep/144/next_starter`
- **Feature-Sliced Design methodology**: https://feature-sliced.design/
