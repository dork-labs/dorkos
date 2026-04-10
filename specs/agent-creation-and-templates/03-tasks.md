# Agent Creation & Workspace Templates — Task Breakdown

**Spec:** [02-specification.md](./02-specification.md)
**Generated:** 2026-03-23
**Mode:** Full

---

## Phase 1: Core Creation Pipeline (6 tasks)

Foundation layer: schemas, transport rename, creation pipeline, directory creation, and knowledge toggle.

| ID  | Task                                                                            | Size   | Priority | Dependencies | Parallel |
| --- | ------------------------------------------------------------------------------- | ------ | -------- | ------------ | -------- |
| 1.1 | Add shared name validation utility and CreateAgentOptions schema                | Medium | High     | —            | 1.2, 1.3 |
| 1.2 | Rename transport.createAgent to transport.initAgent across all callers          | Medium | High     | —            | 1.1, 1.3 |
| 1.3 | Add config.agents.defaultDirectory and dorkosKnowledge convention toggle        | Medium | High     | —            | 1.1, 1.2 |
| 1.4 | Implement POST /api/directory endpoint and transport.createDirectory            | Medium | High     | 1.1          | 1.5      |
| 1.5 | Implement full creation pipeline in POST /api/agents with transport.createAgent | Large  | High     | 1.1, 1.2     | 1.4      |
| 1.6 | Implement DirectoryPicker "New Folder" button                                   | Medium | Medium   | 1.4          | —        |

**Parallel opportunities:** Tasks 1.1, 1.2, and 1.3 can all run in parallel (no shared dependencies). Tasks 1.4 and 1.5 can run in parallel once their dependencies complete.

### 1.1 — Add shared name validation utility and CreateAgentOptions schema

Create `packages/shared/src/validation.ts` with `AGENT_NAME_REGEX` and `validateAgentName()`. Add `CreateAgentOptionsSchema` and `ConventionsSchema` (with `dorkosKnowledge` field) to `mesh-schemas.ts`. Tests cover valid names (a, my-agent, agent-123, 64-char), invalid names (empty, uppercase, underscores, traversal, dot-prefix, dash-prefix), and schema validation.

### 1.2 — Rename transport.createAgent to transport.initAgent

Mechanical rename across 10+ files: Transport interface, HttpTransport, DirectTransport, mesh-methods, use-create-agent hook (→ useInitAgent), NoAgentsFound component, mock-factories, agents route, and all related tests. Frees the `createAgent` name for the new full pipeline.

### 1.3 — Add config.agents.defaultDirectory and dorkosKnowledge convention toggle

Add `agents.defaultDirectory` (default `~/.dork/agents`) to `UserConfigSchema`. Add `meet-dorkbot` to `ONBOARDING_STEPS`. Implement `buildDorkosContextBlock()` in context builder — injected by default, omitted when `dorkosKnowledge: false`.

### 1.4 — Implement POST /api/directory and transport.createDirectory

New endpoint for creating directories from within the app. Validates kebab-case folder name, boundary-checks parent path, returns 409 on collision. Transport method added to interface and both adapters. Used by DirectoryPicker "New Folder".

### 1.5 — Implement full creation pipeline in POST /api/agents

The core 13-step pipeline: parse → resolve directory → boundary check → collision check → mkdir → template (deferred to P4) → .dork/ → agent.json → SOUL.md → NOPE.md → AGENTS.md (DorkBot only) → mesh sync → return 201. Full rollback on failure. Also creates `dorkbot-templates.ts` with `dorkbotClaudeMdTemplate()`.

### 1.6 — Implement DirectoryPicker "New Folder" button

Add "New Folder" button to DirectoryPicker toolbar. Inline text input with real-time kebab-case validation, Enter to create, Escape to cancel. Success auto-refreshes listing and selects new folder.

---

## Phase 2: DorkBot & Onboarding (4 tasks)

DorkBot personality system, onboarding step, and the magic transition animation.

| ID  | Task                                                                      | Size   | Priority | Dependencies | Parallel |
| --- | ------------------------------------------------------------------------- | ------ | -------- | ------------ | -------- |
| 2.1 | Create DorkBot templates and trait preview system                         | Medium | High     | 1.5          | 2.2      |
| 2.2 | Add meet-dorkbot to onboarding flow and update post-onboarding navigation | Medium | High     | 1.3          | 2.1      |
| 2.3 | Create MeetDorkBotStep component with name input and personality sliders  | Large  | High     | 1.5, 2.1     | —        |
| 2.4 | Implement magic transition from onboarding to chat                        | Medium | Medium   | 2.2, 2.3     | —        |

**Parallel opportunities:** Tasks 2.1 and 2.2 can run in parallel.

### 2.1 — DorkBot templates and trait preview system

Extend `dorkbot-templates.ts` with `generateFirstMessage(traits)` (tone-based message selection). Create trait preview lookup table (5 traits x 5 levels = 25 entries) with `getPreviewText()` and `hashPreviewText()` for AnimatePresence keying.

### 2.2 — Wire meet-dorkbot into onboarding flow

Insert "Meet DorkBot" as first step after Welcome. Update step sequence, completion tracking, and post-onboarding navigation to land in chat with DorkBot at `/session?dir={dorkbotPath}`.

### 2.3 — MeetDorkBotStep component

Two-phase component: Phase 1 (name input + template accordion), Phase 2 (5 Radix sliders with live preview). AnimatePresence crossfade on preview text, CSS-only breathing avatar animation, useDeferredValue for scrub debouncing. Creates DorkBot via transport.createAgent on confirmation.

### 2.4 — Magic transition

LayoutGroup + layoutId animation morphing the personality preview bubble into DorkBot's first chat message. Wraps onboarding and chat views in shared LayoutGroup. First message generated from traits via `generateFirstMessage()`.

---

## Phase 3: Creation UI Surfaces (3 tasks)

Dialog component, entry points (agents page + command palette), and template picker UI.

| ID  | Task                                                                         | Size   | Priority | Dependencies | Parallel |
| --- | ---------------------------------------------------------------------------- | ------ | -------- | ------------ | -------- |
| 3.1 | Create useAgentCreationStore and CreateAgentDialog component                 | Large  | High     | 1.5          | 3.2      |
| 3.2 | Add "New Agent" button to AgentsHeader and "Create Agent" to command palette | Small  | High     | 3.1          | —        |
| 3.3 | Implement TemplatePicker grid with category filtering and custom GitHub URL  | Medium | Medium   | 3.1          | 3.2      |

**Parallel opportunities:** Tasks 3.2 and 3.3 can run in parallel once 3.1 is complete.

### 3.1 — CreateAgentDialog and Zustand store

Full FSD feature module at `layers/features/agent-creation/` with CreateAgentDialog, NameInput, PersonalitySection, ProgressOverlay sub-components. Zustand store (`useAgentCreationStore`) for global open/close control. Mounted in AppShell.tsx. TanStack mutation hook (`useCreateAgent`).

### 3.2 — Entry points: AgentsHeader and command palette

"New Agent" button (variant="default") in AgentsHeader. "Create Agent" action in command palette actions list. Both call `useAgentCreationStore.getState().open()`.

### 3.3 — TemplatePicker grid

Category filter tabs (All/Frontend/Backend/Library/Tooling), template card grid with selection highlight and checkmark, custom GitHub URL input below. URL and grid selection mutually exclusive. Uses `useTemplateCatalog` hook (or DEFAULT_TEMPLATES fallback until P4).

---

## Phase 4: Template System (5 tasks)

Download engine, catalog persistence, server endpoints, pipeline integration, client hook.

| ID  | Task                                                                             | Size   | Priority | Dependencies | Parallel |
| --- | -------------------------------------------------------------------------------- | ------ | -------- | ------------ | -------- |
| 4.1 | Add giget dependency and implement template-downloader service                   | Large  | High     | —            | 4.2      |
| 4.2 | Create default template catalog and schema                                       | Small  | High     | —            | 4.1      |
| 4.3 | Add template CRUD server endpoints                                               | Medium | High     | 4.2          | 4.4      |
| 4.4 | Wire template downloader into creation pipeline with post-install hook detection | Medium | High     | 1.5, 4.1     | 4.3      |
| 4.5 | Add use-template-catalog TanStack Query hook                                     | Small  | Medium   | 4.3          | —        |

**Parallel opportunities:** Tasks 4.1 and 4.2 have no dependencies and can start immediately. Tasks 4.3 and 4.4 can run in parallel.

### 4.1 — Template downloader service

`template-downloader.ts` with git clone --depth 1 (primary), giget tarball (fallback, 30s timeout). Git progress parsing from stderr (`Receiving objects: XX%`). Error classification (TIMEOUT, NOT_FOUND, AUTH_ERROR, DISK_FULL, etc.). Auth resolution (GITHUB_TOKEN → gh auth token). Removes .git/ after clone.

### 4.2 — Template catalog schema and defaults

`packages/shared/src/template-catalog.ts` with `TemplateCatalogSchema`, `TemplateEntry` type, and `DEFAULT_TEMPLATES` constant (7 entries: blank, Next.js, Vite+React, Express, FastAPI, TS Library, CLI Tool). Category enum includes 'custom' for user additions.

### 4.3 — Template CRUD endpoints

GET /api/templates (merged builtin + user), POST /api/templates (add user template), DELETE /api/templates/:id (remove user template, 403 for builtin). User catalog persists at ~/.dork/agent-templates.json.

### 4.4 — Pipeline integration + post-install hooks

Wire `downloadTemplate()` into POST /api/agents step 6. Failed download triggers full rollback. Detect `package.json` `scripts.postinstall` or `scripts.setup` — return `_meta.hasPostInstall` flag. No auto-execution (security).

### 4.5 — Template catalog hook

`useTemplateCatalog()` TanStack Query hook with 5-minute staleTime. Fetches from GET /api/templates. Updates TemplatePicker to use live data instead of DEFAULT_TEMPLATES fallback.

---

## Phase 5: MCP Tool & DorkBot Recreation (3 tasks)

External agent integration, settings recreation flow, and sound design.

| ID  | Task                                              | Size   | Priority | Dependencies | Parallel |
| --- | ------------------------------------------------- | ------ | -------- | ------------ | -------- |
| 5.1 | Add create_agent MCP tool definition and handler  | Medium | High     | 1.5          | 5.2, 5.3 |
| 5.2 | Implement DorkBot recreation in Settings          | Medium | Medium   | 1.5, 3.1     | 5.1, 5.3 |
| 5.3 | Implement sound design for slider and celebration | Small  | Low      | —            | 5.1, 5.2 |

**Parallel opportunities:** All three tasks can run in parallel.

### 5.1 — create_agent MCP tool

Add tool definition to MCP tool registry with name, directory, template, description, runtime parameters. Handler calls same creation service as POST /api/agents. Returns AgentManifest JSON on success, isError on failure. Protected by existing MCP API key auth.

### 5.2 — DorkBot recreation

Settings page detects dorkbot absence. "Recreate DorkBot" card appears with dashed border. Opens simplified dialog with personality sliders only (no name/template). Creates via same pipeline. Toast on success/failure. No auto-recreation.

### 5.3 — Sound design

`layers/shared/lib/sound.ts` with `playSliderTick()` (800Hz sine, 4ms, gain 0.05) and `playCelebration()` (C5-E5-G5 ascending chime, 100ms). Lazy AudioContext, respects sound settings. Integrated into MeetDorkBotStep slider onChange and create button.

---

## Summary

| Phase                             | Tasks  | Sizes                               |
| --------------------------------- | ------ | ----------------------------------- |
| P1: Core Creation Pipeline        | 6      | 4 medium, 1 large, 1 medium         |
| P2: DorkBot & Onboarding          | 4      | 2 medium, 1 large, 1 medium         |
| P3: Creation UI Surfaces          | 3      | 1 large, 1 small, 1 medium          |
| P4: Template System               | 5      | 1 large, 1 small, 2 medium, 1 small |
| P5: MCP Tool & DorkBot Recreation | 3      | 1 medium, 1 medium, 1 small         |
| **Total**                         | **21** |                                     |

**Critical path:** 1.1 → 1.5 → 2.1 → 2.3 → 2.4 (longest dependency chain through DorkBot onboarding)

**Maximum parallelism:** Phase 1 starts 3 tasks in parallel (1.1, 1.2, 1.3). Phase 4 starts 2 tasks with no dependencies (4.1, 4.2). Phase 5 can run all 3 tasks in parallel.
