---
slug: agent-creation-and-templates
number: 168
created: 2026-03-23
status: specified
---

# Agent Creation & Workspace Templates

**Status:** Specified
**Author:** Claude Code
**Date:** 2026-03-23
**Ideation:** [01-ideation.md](./01-ideation.md)
**Brief:** [00-brief.md](./00-brief.md)

---

## Overview

Build a complete agent creation pipeline that lets users create new agents from four surfaces — onboarding, `/agents` page, command palette, and MCP — with workspace scaffolding on disk, starter templates from GitHub repos, and a default "DorkBot" agent created during onboarding with personality sliders. This is DorkOS's most important new-user feature: it turns the dead-end "no agents found" state into a guided agent birth experience.

The spec also introduces a two-layer DorkOS knowledge architecture (system prompt injection + compact AGENTS.md), DirectoryPicker "New Folder" capability, a template catalog with git+giget download engine, DorkBot recreation in settings, and sound design for the personality slider experience.

## Background / Problem Statement

Creating a new agent in DorkOS requires the user to already have a directory on disk, navigate to it via DirectoryPicker, and fill out a registration form. There is no way to create a new project folder from within the app. A user who installs DorkOS for the first time with no existing Claude Code projects hits a dead end.

The app also has no concept of a default agent — a general-purpose agent that's always available for asking questions, running ad-hoc tasks, or just getting started. Every other developer tool with an agent layer provides this out of the box.

## Goals

- Users can create agents from any surface (onboarding, agents page, command palette, MCP) through a unified creation pipeline
- Creating an agent also creates its workspace directory, scaffolds config files, and optionally seeds from a template
- DorkBot is created during onboarding as the user's first agent, with a memorable personality-tuning experience
- All agents get DorkOS knowledge injected via system prompt (toggleable per agent)
- DirectoryPicker gains a "New Folder" button for creating directories without leaving the app
- Templates download from GitHub repos with real progress tracking

## Non-Goals

- Template authoring tools, marketplace, or registry service
- Agent cloning or duplication
- Automatic `git init` in new workspaces
- Multi-runtime template variants
- Settings UI for GitHub token management (v1)
- MCP tool for searching DorkOS documentation (future enhancement)

## Technical Dependencies

| Dependency               | Version  | Purpose                              |
| ------------------------ | -------- | ------------------------------------ |
| `giget`                  | latest   | Template download fallback (tarball) |
| `motion`                 | existing | AnimatePresence, layoutId animations |
| `@radix-ui/react-slider` | existing | Personality trait sliders            |
| `zod`                    | existing | Schema validation                    |
| `@tanstack/react-query`  | existing | Server state, mutations              |

No new major dependencies beyond `giget`. The `git` CLI is used as the primary template engine but is not an npm dependency.

## Detailed Design

### 1. Agent Lifecycle Naming Convention

The current `transport.createAgent()` only writes config to an existing directory (like `git init`). The new pipeline needs a higher-level operation. Establish a 3-tier hierarchy:

| Operation    | Transport Method        | Server Endpoint           | Hook                 | What It Does                                                   |
| ------------ | ----------------------- | ------------------------- | -------------------- | -------------------------------------------------------------- |
| **Create**   | `createAgent(opts)`     | `POST /api/agents`        | `useCreateAgent()`   | Full pipeline: mkdir + scaffold + optional template + register |
| **Init**     | `initAgent(path, opts)` | `PUT /api/agents/current` | `useInitAgent()`     | Write config to existing directory (current behavior, renamed) |
| **Register** | `registerAgent(path)`   | `POST /api/mesh/agents`   | `useRegisterAgent()` | Add to mesh DB cache only                                      |

**Migration:** Rename existing `transport.createAgent()` → `transport.initAgent()`. All callers (including `HttpTransport`, `DirectTransport`, and `useCreateAgent` hook) update accordingly. The new `createAgent()` wraps the full pipeline.

#### Transport Interface Changes

```typescript
// packages/shared/src/transport.ts

// NEW: Full creation pipeline
createAgent(opts: CreateAgentOptions): Promise<AgentManifest>;

// RENAMED from createAgent:
initAgent(
  path: string,
  name?: string,
  description?: string,
  runtime?: string
): Promise<AgentManifest>;

// NEW: Directory creation
createDirectory(parentPath: string, folderName: string): Promise<{ path: string }>;
```

```typescript
// packages/shared/src/mesh-schemas.ts — new schema

export const CreateAgentOptionsSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}[a-z0-9]$|^[a-z]$/, 'Kebab-case required'),
  directory: z.string().optional(), // Default: ~/.dork/agents/{name}/
  template: z.string().optional(), // Template ID or GitHub URL
  description: z.string().optional(),
  runtime: AgentRuntimeSchema.optional(), // Default: claude-code
  traits: TraitsSchema.optional(), // Default: all level 3
  conventions: z
    .object({
      soul: z.boolean().optional(), // Default: true
      nope: z.boolean().optional(), // Default: true
      dorkosKnowledge: z.boolean().optional(), // Default: true
    })
    .optional(),
});

export type CreateAgentOptions = z.infer<typeof CreateAgentOptionsSchema>;
```

### 2. Server Creation Pipeline

**`POST /api/agents`** — Full creation pipeline:

```
1. Parse & validate CreateAgentOptionsSchema
2. Resolve directory:
   - If opts.directory provided: use it
   - Else: join(config.agents.defaultDirectory || '~/.dork/agents', opts.name)
3. Boundary-validate resolved path (PathValidator)
4. Check collision: stat(resolvedPath) → if exists, return 409
5. mkdir(resolvedPath, { recursive: false })
   - mkdir parent with recursive: true first if needed
6. If opts.template:
   a. Try git clone --depth 1 <template-url> <resolvedPath> --progress
   b. Remove .git/ directory
   c. On git failure: fall back to giget
   d. On total failure: rollback (rm -rf resolvedPath), return 500
7. Create .dork/ subdirectory (skip if template provided one)
8. Scaffold agent.json:
   - id: ulid()
   - name: opts.name
   - description: opts.description || ''
   - runtime: opts.runtime || 'claude-code'
   - traits: opts.traits || DEFAULT_TRAITS
   - conventions: { soul: true, nope: true, dorkosKnowledge: true, ...opts.conventions }
   - registeredAt: new Date().toISOString()
   - registeredBy: 'dorkos-ui'
   - personaEnabled: true
   - enabledToolGroups: {}
9. Scaffold SOUL.md (renderTraits + defaultSoulTemplate)
10. Scaffold NOPE.md (defaultNopeTemplate)
11. If DorkBot: scaffold AGENTS.md (dorkbotClaudeMdTemplate)
12. meshCore?.syncFromDisk(resolvedPath) — best-effort
13. Return 201 + AgentManifest

ROLLBACK: If any step 7-12 fails after step 5 succeeded:
  - rm -rf resolvedPath
  - Return 500 with error details
```

#### Template Download Service

New file: `apps/server/src/services/core/template-downloader.ts`

```typescript
export interface TemplateDownloadResult {
  success: boolean;
  method: 'git' | 'giget';
  error?: string;
}

export async function downloadTemplate(
  source: string,
  targetPath: string,
  auth?: string
): Promise<TemplateDownloadResult> {
  // 1. Try git clone --depth 1
  try {
    const gitUrl = resolveGitUrl(source); // github:org/repo → https://github.com/org/repo.git
    await execGitClone(gitUrl, targetPath, auth);
    await fs.rm(path.join(targetPath, '.git'), { recursive: true, force: true });
    return { success: true, method: 'git' };
  } catch {
    // 2. Fall back to giget
    try {
      await Promise.race([
        downloadTemplate(source, { dir: targetPath, auth }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 30_000)),
      ]);
      return { success: true, method: 'giget' };
    } catch (err) {
      return { success: false, method: 'giget', error: classifyGigetError(err) };
    }
  }
}
```

**Git progress parsing** — parse stderr lines matching `Receiving objects: XX% (N/M)`:

```typescript
function execGitClone(url: string, target: string, auth?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = auth ? { ...process.env, GIT_ASKPASS: 'echo', GIT_TOKEN: auth } : process.env;
    const child = spawn('git', ['clone', '--depth', '1', '--progress', url, target], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk) => {
      const line = chunk.toString();
      const match = line.match(/Receiving objects:\s+(\d+)%/);
      if (match) {
        /* emit progress event */
      }
    });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git exit ${code}`))));
  });
}
```

**giget error classification:**

```typescript
function classifyGigetError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('TIMEOUT')) return 'TIMEOUT';
  if (msg.includes('404') || msg.includes('not found')) return 'NOT_FOUND';
  if (msg.includes('401') || msg.includes('403')) return 'AUTH_ERROR';
  if (msg.includes('ENOSPC')) return 'DISK_FULL';
  if (msg.includes('EEXIST')) return 'DIRECTORY_EXISTS';
  if (msg.includes('ENOTFOUND') || msg.includes('fetch')) return 'NETWORK_ERROR';
  return 'UNKNOWN';
}
```

**Auth resolution:**

```typescript
async function resolveGitAuth(): Promise<string | undefined> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const { stdout } = await execAsync('gh auth token');
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
```

### 3. DorkOS Knowledge Architecture (Two-Layer)

#### Layer 1: System Prompt Injection (Primary)

Add `dorkosKnowledge` to the conventions system. When enabled, the context builder injects a `<dorkos_context>` block into the system prompt alongside existing `<agent_persona>` and `<agent_safety_boundaries>` blocks.

**Convention toggle in agent.json:**

```json
{
  "conventions": {
    "soul": true,
    "nope": true,
    "dorkosKnowledge": true
  }
}
```

**Context builder injection** (`context-builder.ts`):

```typescript
// After existing SOUL.md and NOPE.md injection:
if (manifest.conventions?.dorkosKnowledge !== false) {
  blocks.push(buildDorkosContextBlock());
}

function buildDorkosContextBlock(): string {
  return `<dorkos_context>
DorkOS is the operating system for autonomous AI agents.
Subsystems: Console (chat), Pulse (scheduling), Relay (messaging), Mesh (discovery).
Documentation: https://dorkos.ai/llms.txt
Full docs: https://dorkos.ai/docs
</dorkos_context>`;
}
```

Default: ON for all agents. Toggleable per agent in settings. Ships with the server — updates when DorkOS upgrades, never goes stale.

**Schema update** (`mesh-schemas.ts`):

```typescript
export const ConventionsSchema = z.object({
  soul: z.boolean().default(true),
  nope: z.boolean().default(true),
  dorkosKnowledge: z.boolean().default(true), // NEW
});
```

#### Layer 2: DorkBot's AGENTS.md (CLI Fallback)

Only scaffolded for DorkBot (not other agents). Compact ~15 lines:

```typescript
// packages/shared/src/dorkbot-templates.ts

export function dorkbotClaudeMdTemplate(): string {
  return `# DorkBot — DorkOS Default Agent

You are DorkBot, the default agent for DorkOS.
DorkOS is the operating system for autonomous AI agents.

## Your Role

- Help users learn DorkOS concepts and workflows
- Run ad-hoc tasks and experiments
- Answer questions about DorkOS subsystems (Pulse, Relay, Mesh, Console)

## Documentation

For up-to-date DorkOS documentation, fetch:

- https://dorkos.ai/llms.txt (LLM-optimized summary)
- https://dorkos.ai/docs (full documentation)
`;
}
```

### 4. Config Schema Changes

```typescript
// packages/shared/src/config-schema.ts

// Add 'meet-dorkbot' to onboarding steps
export const ONBOARDING_STEPS = ['meet-dorkbot', 'discovery', 'pulse', 'adapters'] as const;

// Add agents config section
export const UserConfigSchema = z.object({
  // ... existing fields ...
  agents: z
    .object({
      defaultDirectory: z.string().default('~/.dork/agents'),
      defaultAgent: z.string().default('dorkbot'), // Name of the primary/default agent
    })
    .default({}),
  // ... existing fields ...
});
```

### 5. Template Catalog

**File:** `~/.dork/agent-templates.json` — created on first access if missing.

```typescript
// packages/shared/src/template-catalog.ts

export const TemplateCatalogSchema = z.object({
  version: z.literal(1),
  templates: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string(),
      source: z.string().min(1), // github:org/repo or full URL
      category: z.enum(['general', 'frontend', 'backend', 'library', 'tooling', 'custom']),
      builtin: z.boolean().default(false),
    })
  ),
});

export type TemplateCatalog = z.infer<typeof TemplateCatalogSchema>;
export type TemplateEntry = TemplateCatalog['templates'][number];

export const DEFAULT_TEMPLATES: TemplateEntry[] = [
  {
    id: 'blank',
    name: 'Blank Workspace',
    description: 'Empty workspace with AGENTS.md and .claude/rules/',
    source: 'github:dorkos/templates/blank',
    category: 'general',
    builtin: true,
  },
  {
    id: 'nextjs',
    name: 'Next.js App',
    description: 'Next.js 16 + Tailwind CSS 4 + TypeScript',
    source: 'github:ixartz/Next-js-Boilerplate',
    category: 'frontend',
    builtin: true,
  },
  {
    id: 'vite-react',
    name: 'Vite + React SPA',
    description: 'React 19 + Vite 6 + TanStack Router + Tailwind',
    source: 'github:RicardoValdovinos/vite-react-boilerplate',
    category: 'frontend',
    builtin: true,
  },
  {
    id: 'express-api',
    name: 'Express REST API',
    description: 'Express + TypeScript + Zod + Vitest + Swagger',
    source: 'github:edwinhern/express-typescript',
    category: 'backend',
    builtin: true,
  },
  {
    id: 'fastapi',
    name: 'FastAPI Python API',
    description: 'FastAPI + PostgreSQL + Docker + SQLModel',
    source: 'github:fastapi/full-stack-fastapi-template',
    category: 'backend',
    builtin: true,
  },
  {
    id: 'ts-library',
    name: 'TypeScript Library',
    description: 'TypeScript + tsup + Vitest + dual ESM/CJS',
    source: 'github:jasonsturges/tsup-npm-package',
    category: 'library',
    builtin: true,
  },
  {
    id: 'cli-tool',
    name: 'Node.js CLI Tool',
    description: 'TypeScript + commander + tsup + Vitest',
    source: 'github:kucherenko/cli-typescript-starter',
    category: 'tooling',
    builtin: true,
  },
];
```

**Server endpoint for catalog:**

```typescript
// GET /api/templates — returns merged catalog (builtin + user)
// POST /api/templates — adds user template entry
// DELETE /api/templates/:id — removes user template (builtin=false only)
```

**Post-install hook handling:** After template download, check for `package.json` with `scripts.postinstall` or `scripts.setup`. If found, return a flag in the creation response. The client shows a prompt: "This template has a setup script. Run it?" No auto-execution.

### 6. DirectoryPicker "New Folder"

**Server endpoint:**

```typescript
// POST /api/directory
// Body: { parentPath: string, folderName: string }
// Returns: { path: string } (full path of created directory)
// Validates: boundary check on parentPath, kebab-case on folderName
// Error: 409 if exists, 400 if invalid name, 403 if outside boundary
```

**Client changes to `DirectoryPicker.tsx`:**

Add a "New Folder" button to the browse view toolbar (next to "Show hidden folders" toggle). When clicked:

1. Show an inline text input at the top of the directory listing with focus
2. Input validates kebab-case in real-time (red border + error text on invalid)
3. Enter key or checkmark icon creates the directory via `transport.createDirectory()`
4. Escape key or X icon cancels
5. On success: directory listing refreshes, new folder is auto-selected
6. On failure: toast error (conflict, boundary violation, etc.)

```typescript
// New transport method
createDirectory(parentPath: string, folderName: string): Promise<{ path: string }>;
```

**DirectTransport (Obsidian):** Uses `app.vault.createFolder()` for in-process creation.

### 7. Onboarding: Meet DorkBot

Insert "Meet DorkBot" as the first step after Welcome in the onboarding flow.

**Updated flow:**

```
Welcome (step -1)
  ↓ "Get Started"
Meet DorkBot (step 0) ← NEW
  ↓ "Create DorkBot"
Discovery (step 1)
  ↓ "Next"
Pulse (step 2)
  ↓ "Complete"
Chat with DorkBot ← lands here after all steps
```

#### 7.1 Meet DorkBot Step Component

New file: `apps/client/src/layers/features/onboarding/ui/MeetDorkBotStep.tsx`

**Phase 1 — Name & Setup (~5 seconds):**

- Agent name input pre-filled with "dorkbot" (editable, kebab-case validated)
- Directory path shown as muted secondary text: `~/.dork/agents/{name}/`
- Template picker: collapsed "Choose a starter template" accordion. Default: Blank (no template). Most users skip this.
- "Next: Personality" button advances to Phase 2

**Phase 2 — Personality (the experience):**

Five trait sliders, each with 5 discrete stops:

| Trait      | Level 1      | Level 3  | Level 5   |
| ---------- | ------------ | -------- | --------- |
| Tone       | Serious      | Balanced | Playful   |
| Autonomy   | Ask first    | Balanced | Act alone |
| Caution    | Conservative | Balanced | Bold      |
| Detail     | Terse        | Balanced | Thorough  |
| Creativity | By the book  | Balanced | Inventive |

All default to level 3 (Balanced).

**Live personality preview:** A speech-bubble element above the sliders shows how DorkBot would introduce itself at current settings. Each trait × level has a pre-written preview string in the static lookup table (`trait-renderer.ts`). As the user moves any slider, the preview text crossfades:

```tsx
// AnimatePresence crossfade pattern
const previewText = useDeferredValue(getPreviewText(traits));
const previewKey = useMemo(() => hashPreviewText(previewText), [previewText]);

<AnimatePresence mode="wait">
  <motion.p
    key={previewKey}
    initial={{ opacity: 0, y: 4 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -4 }}
    transition={{ duration: 0.2 }}
  >
    {previewText}
  </motion.p>
</AnimatePresence>;
```

`useDeferredValue` debounces rapid slider scrubbing so the crossfade doesn't fire on every pixel of drag.

**Avatar breathing animation (CSS-only):**

```css
@keyframes breathe {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.9;
  }
  50% {
    transform: scale(1.03);
    opacity: 1;
  }
}

.dorkbot-avatar {
  animation: breathe 3s ease-in-out infinite;
}
.dorkbot-avatar.reacting {
  animation-duration: 0.8s;
}
```

The `.reacting` class is applied while any slider is being dragged (`onPointerDown` → add, `onPointerUp` → remove after 600ms delay).

**Sound design:**

- Slider tick: soft click sound on each discrete stop change (uses Web Audio API `OscillatorNode` — 4ms sine wave at 800Hz, gain 0.05). Only plays if notification sounds are enabled in settings.
- Creation celebration: short ascending chime (3-note, 100ms total) when "Create DorkBot" is pressed.

```typescript
// apps/client/src/layers/shared/lib/sound.ts
export function playSliderTick(): void {
  if (!getSoundEnabled()) return;
  const ctx = getAudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 800;
  gain.gain.value = 0.05;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.004);
}

export function playCelebration(): void {
  if (!getSoundEnabled()) return;
  const ctx = getAudioContext();
  const notes = [523, 659, 784]; // C5, E5, G5
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + i * 0.033);
    osc.stop(ctx.currentTime + i * 0.033 + 0.05);
  });
}
```

**"Create DorkBot" button:**

1. Plays celebration sound
2. Calls `transport.createAgent({ name, traits, conventions: { soul: true, nope: true, dorkosKnowledge: true } })`
3. On success: marks "meet-dorkbot" step complete, advances to next step
4. On failure: shows inline error, enables retry

#### 7.2 The Magic Transition

After all onboarding steps complete, the user lands in a chat session with DorkBot. The personality preview bubble from the Meet DorkBot step morphs into DorkBot's first chat message.

**Implementation:**

```tsx
// Wrap both onboarding and chat in a shared LayoutGroup
<LayoutGroup id="onboarding-to-chat">
  {showOnboarding ? (
    <MeetDorkBotStep>
      {/* Preview bubble with layoutId */}
      <motion.div layoutId="dorkbot-first-message" className="...">
        {previewText}
      </motion.div>
    </MeetDorkBotStep>
  ) : (
    <ChatPanel>
      {/* First message inherits layoutId */}
      <motion.div layoutId="dorkbot-first-message" className="...">
        {firstMessage}
      </motion.div>
    </ChatPanel>
  )}
</LayoutGroup>
```

The `LayoutGroup` must wrap both components so Motion can animate between them. When onboarding completes and the chat panel mounts, the bubble smoothly morphs position and size from the onboarding preview to the chat message position.

**DorkBot's first message:** Generated server-side using the configured personality traits. The first message is a personality-appropriate welcome that references DorkOS capabilities and invites the user to ask questions. This is rendered via `renderTraits()` — not an LLM call. The content is a pre-written template keyed by the dominant trait levels:

```typescript
export function generateFirstMessage(traits: TraitsMap): string {
  const tone = traits.tone;
  if (tone >= 4) {
    return "Hey! I'm DorkBot — your personal agent running on DorkOS. I can help you schedule tasks with Pulse, send messages through Relay, discover other agents via Mesh, or just chat. What would you like to explore first?";
  }
  if (tone <= 2) {
    return "DorkBot online. I'm your default DorkOS agent. Available subsystems: Pulse (scheduling), Relay (messaging), Mesh (discovery). How can I assist?";
  }
  return "Hi, I'm DorkBot — your default agent in DorkOS. I can help you explore the platform, schedule tasks, send messages between agents, or answer questions. What interests you?";
}
```

### 8. Creation UI Surfaces

#### 8.1 CreateAgentDialog

New shared component used by the agents page and command palette.

**FSD location:** `apps/client/src/layers/features/agent-creation/`

```
layers/features/agent-creation/
├── ui/
│   ├── CreateAgentDialog.tsx      # Main dialog
│   ├── NameInput.tsx              # Kebab-case validated name field
│   ├── TemplatePicker.tsx         # Template grid with category tabs
│   ├── PersonalitySection.tsx     # Collapsible trait sliders
│   └── ProgressOverlay.tsx        # Download progress (git) / spinner (giget)
├── model/
│   ├── use-create-agent.ts        # NEW full pipeline mutation
│   ├── use-template-catalog.ts    # TanStack Query for template list
│   └── schemas.ts                 # Validation schemas
└── index.ts                       # Barrel exports
```

**CreateAgentDialog layout:**

```
┌──────────────────────────────────────────────┐
│  Create Agent                          [X]   │
│                                              │
│  Name                                        │
│  ┌──────────────────────────────────────┐    │
│  │ my-new-agent                         │    │
│  └──────────────────────────────────────┘    │
│  ~/.dork/agents/my-new-agent/                │
│  [Change directory...]                       │
│                                              │
│  Template (optional)                         │
│  ┌────────┐ ┌────────┐ ┌────────┐           │
│  │ Blank  │ │Next.js │ │Express │  ...       │
│  │  ✓     │ │        │ │        │           │
│  └────────┘ └────────┘ └────────┘           │
│  Or enter GitHub URL: [                ]     │
│                                              │
│  ▸ Personality (optional)                    │
│                                              │
│                    [Cancel]  [Create Agent]   │
└──────────────────────────────────────────────┘
```

**Dialog behavior:**

- Name input auto-generates directory path as user types
- Real-time kebab-case validation (inline error if invalid)
- Pre-check for naming collision (debounced check via `HEAD /api/agents?path=...`)
- Template grid shows built-in templates; custom GitHub URL input below
- Personality section collapsed by default (chevron toggle)
- "Create Agent" button disabled while creating; shows progress overlay
- On success: closes dialog, invalidates agent queries, navigates to chat session

#### 8.2 Agents Page Integration

In `AgentsHeader.tsx`, add a "New Agent" button next to "Scan for Agents":

```tsx
<Button variant="default" onClick={() => setCreateDialogOpen(true)}>
  <Plus className="size-4" />
  New Agent
</Button>
<CreateAgentDialog
  open={createDialogOpen}
  onOpenChange={setCreateDialogOpen}
/>
```

#### 8.3 Command Palette Integration

Add "Create Agent" action to `use-palette-actions.ts`:

```typescript
{
  id: 'create-agent',
  title: 'Create Agent',
  description: 'Create a new agent workspace',
  icon: Plus,
  shortcut: undefined,
  handler: () => {
    closePalette();
    // Open CreateAgentDialog via a global store setter
    useAgentCreationStore.getState().open();
  },
}
```

The `CreateAgentDialog` needs a global Zustand store (`useAgentCreationStore`) so the command palette can trigger it without prop drilling:

```typescript
// layers/features/agent-creation/model/store.ts
export const useAgentCreationStore = create<{
  isOpen: boolean;
  open: () => void;
  close: () => void;
}>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
```

Mount the dialog in `AppShell.tsx` (app-level, always available).

### 9. MCP Tool

Add `create_agent` to the external MCP server tool registry.

```typescript
// apps/server/src/services/runtimes/claude-code/mcp-tools.ts

{
  name: 'create_agent',
  description: 'Create a new DorkOS agent workspace with scaffolded config files',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Agent name (kebab-case, e.g. "my-agent")' },
      directory: { type: 'string', description: 'Optional. Defaults to ~/.dork/agents/{name}/' },
      template: { type: 'string', description: 'Optional template ID or GitHub URL' },
      description: { type: 'string', description: 'Optional agent description' },
      runtime: { type: 'string', description: 'Agent runtime. Default: claude-code' },
    },
    required: ['name'],
  },
}
```

**Handler:** Calls the same creation pipeline as `POST /api/agents`. Returns the created `AgentManifest` as JSON text content.

### 10. DorkBot Recreation

If DorkBot is deleted, a "Recreate DorkBot" button appears in Settings → Agents section.

**Detection:** On the settings page, check if an agent named "dorkbot" exists in the mesh registry. If not, show the recreation affordance.

**Recreation flow:**

1. User clicks "Recreate DorkBot" in settings
2. Opens a simplified version of the personality step (sliders only, no name/template)
3. All traits default to level 3 (Balanced)
4. User can adjust sliders or accept defaults
5. "Recreate" button calls `transport.createAgent({ name: 'dorkbot', traits })` with the same pipeline
6. On success: toast "DorkBot recreated", invalidate queries

**Key principle:** DorkBot won't auto-recreate if deleted. That would be presumptuous. The user made a deliberate choice; we respect it and provide a manual restoration path.

### 10.5 Default/Primary Agent

The system tracks which agent is the "default" or "primary" agent via `config.agents.defaultAgent` (default: `'dorkbot'`). This is the agent that:

- Is opened after onboarding completes (post-onboarding navigation uses this, not hardcoded 'dorkbot')
- Could be used as the default session target for quick actions

**Changing the default agent:**

In Settings → Agents section, a "Default Agent" dropdown allows the user to select any registered agent as the primary. On the `/agents` page, each agent card has a "Set as Default" action in its context menu (or a star/pin icon).

```typescript
// Transport method
setDefaultAgent(agentName: string): Promise<void>;

// Server endpoint
PUT /api/config/agents/defaultAgent
Body: { value: "my-other-agent" }
```

When an agent is created via `createAgent()`, if it's the first agent ever (no default set), it becomes the default automatically.

**Post-onboarding navigation update:**

```typescript
// Uses config, not hardcoded 'dorkbot'
const defaultAgent = config.agents?.defaultAgent || 'dorkbot';
const agentPath = path.join(config.agents.defaultDirectory, defaultAgent);
navigate({ to: '/session', search: { dir: agentPath } });
```

### 11. Name Validation

All agent name validation uses a shared function:

```typescript
// packages/shared/src/validation.ts

export const AGENT_NAME_REGEX = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$|^[a-z]$/;

export function validateAgentName(name: string): { valid: boolean; error?: string } {
  if (!name) return { valid: false, error: 'Name is required' };
  if (name.length > 64) return { valid: false, error: 'Name must be 64 characters or less' };
  if (!AGENT_NAME_REGEX.test(name)) {
    return {
      valid: false,
      error: 'Lowercase letters, numbers, and hyphens only. Must start with a letter.',
    };
  }
  return { valid: true };
}
```

Used in:

- `CreateAgentOptionsSchema` (server-side Zod validation)
- `NameInput.tsx` (client-side real-time validation)
- `createDirectory` endpoint (folder name validation)

### 12. Filesystem Security

- **PathValidator boundary checks:** Every path resolved by the creation pipeline passes through the existing `PathValidator` class. Agent directories must resolve within the configured `agents.defaultDirectory` or within an explicitly user-selected path that passes boundary validation.
- **No path traversal:** The kebab-case regex rejects `..`, `/`, `\`, and all special characters.
- **Rollback on failure:** If any step after `mkdir` fails, the partially created directory is deleted. Clean state, no orphans.
- **`recursive: false` for agent dir:** The agent directory itself is created with `recursive: false` to ensure we detect collisions (EEXIST). Parent directories use `recursive: true`.

## User Experience

### First-Run Flow

1. User installs DorkOS, opens the app
2. Welcome screen → "Get Started"
3. **Meet DorkBot:** Name pre-filled, personality sliders with live preview, avatar breathing
4. "Create DorkBot" → celebration sound → workspace created on disk
5. Discovery step (scan for existing agents)
6. Pulse presets step
7. Land in chat with DorkBot — first message uses configured personality

### Creating an Agent (Repeat Use)

1. User clicks "New Agent" on `/agents` or "Create Agent" in command palette
2. Dialog: name → auto-generated path → optional template → optional personality
3. "Create Agent" → progress overlay → workspace created
4. Dialog closes → agents list updates → user can navigate to new agent

### Creating via MCP

External agents (Claude Code, Cursor) call `create_agent` tool → workspace scaffolded → agent appears in DorkOS fleet.

## Testing Strategy

### Unit Tests

**Template downloader** (`template-downloader.test.ts`):

- Test git clone success path (mock `child_process.spawn`)
- Test git failure → giget fallback
- Test giget timeout (30s)
- Test error classification for each error type
- Test auth resolution (GITHUB_TOKEN → gh auth token)

**Name validation** (`validation.test.ts`):

- Valid names: "a", "my-agent", "agent-123", 64-char max
- Invalid names: "", "My Agent", "agent_name", "../traversal", ".hidden", "-starts-with-dash"

**Creation pipeline** (`agents.test.ts` additions):

- Full pipeline success (no template)
- Full pipeline with template
- 409 on collision
- Rollback on scaffold failure
- Default directory resolution
- Boundary validation

**Convention toggle** (`context-builder.test.ts` additions):

- DorkOS knowledge injected when `dorkosKnowledge: true`
- DorkOS knowledge omitted when `dorkosKnowledge: false`

**Template catalog** (`template-catalog.test.ts`):

- Schema validation for catalog entries
- Merge logic (builtin + user templates)
- CRUD operations on user templates

### Component Tests

**MeetDorkBotStep** (`MeetDorkBotStep.test.tsx`):

- Renders name input with "dorkbot" default
- Validates name in real-time
- Sliders adjust traits and update preview text
- "Create DorkBot" calls transport.createAgent with correct options

**CreateAgentDialog** (`CreateAgentDialog.test.tsx`):

- Opens/closes correctly
- Name validation shows inline errors
- Template selection updates state
- Personality section expands/collapses
- Create button disabled during mutation

**DirectoryPicker "New Folder"** (`DirectoryPicker.test.tsx` additions):

- "New Folder" button shows inline input
- Validates folder name
- Calls createDirectory on Enter
- Cancels on Escape
- Refreshes listing and selects new folder on success

### Integration Tests

**Agent creation E2E** (Playwright):

- Create agent from agents page → verify directory exists on disk
- Create DorkBot during onboarding → verify chat session starts
- Template download → verify template files present in directory

### Mocking Strategy

- `child_process.spawn` — mock for git clone tests
- `giget.downloadTemplate` — mock for fallback tests
- `fs.mkdir`, `fs.rm` — mock for rollback tests
- `Transport` — mock via `createMockTransport()` for component tests
- Sound functions — mock `AudioContext` for slider tick tests

## Performance Considerations

- **Template download:** Async with timeout. Git clone with `--depth 1` minimizes data transfer. giget uses tarball (smaller than full clone).
- **Preview text crossfade:** `useDeferredValue` prevents animation spam during rapid slider dragging. Only 25 static strings — no computation.
- **Sound:** Web Audio API oscillators are lightweight (~0.1ms per tick). No file loading.
- **Onboarding → chat transition:** `layoutId` animation is GPU-accelerated by Motion. No layout thrashing.
- **Directory collision check:** Debounced `HEAD` request (300ms delay) as user types name. Prevents rapid-fire server calls.
- **Catalog loading:** Template catalog is a small JSON file (~1KB). Loaded once, cached by TanStack Query.

## Security Considerations

- **Path traversal prevention:** All paths validated by `PathValidator`. Kebab-case regex prevents special characters.
- **Template auth:** `GITHUB_TOKEN` read from environment only (not stored in config). `gh auth token` uses the system's GitHub CLI auth.
- **Post-install hooks:** Never auto-executed. User prompt required. This prevents malicious templates from running arbitrary code.
- **MCP tool:** Protected by existing MCP API key auth (`MCP_API_KEY` env var). Same auth as all other MCP tools.
- **Rollback:** Failed creations are cleaned up (directory deleted). No orphaned directories with partial state.

## Documentation

- **Contributing guide update:** Add "Agent Creation Pipeline" section to `contributing/architecture.md` explaining the 3-tier lifecycle (create > init > register)
- **API reference update:** Document new endpoints (`POST /api/agents` full pipeline, `POST /api/directory`, template endpoints)
- **User docs:** "Creating Your First Agent" guide covering onboarding, agents page creation, and templates

## Implementation Phases

### Phase 1: Core Creation Pipeline

- Rename `transport.createAgent()` → `transport.initAgent()` across all callers
- Add new `CreateAgentOptions` schema and `transport.createAgent(opts)` method
- Implement full creation pipeline in `POST /api/agents`
- Add `POST /api/directory` endpoint
- Add `transport.createDirectory()` method
- Implement DirectoryPicker "New Folder" button
- Add `dorkosKnowledge` convention toggle to schema and context builder
- Add `config.agents.defaultDirectory` to config schema
- Update `HttpTransport` and `DirectTransport` adapters
- Tests for pipeline, directory creation, name validation

### Phase 2: DorkBot & Onboarding

- Create DorkBot AGENTS.md and SOUL.md templates
- Create `MeetDorkBotStep` component with Phase 1 (name/setup) and Phase 2 (personality)
- Implement trait slider UI with `@radix-ui/react-slider`
- Implement live personality preview with `AnimatePresence` crossfade
- Implement CSS-only avatar breathing animation
- Implement the magic transition (`LayoutGroup` + `layoutId`)
- Generate DorkBot's first message based on traits
- Add "meet-dorkbot" to `ONBOARDING_STEPS`
- Update onboarding flow to insert new step
- Update post-onboarding navigation to land in chat with DorkBot
- Tests for MeetDorkBotStep, onboarding flow integration

### Phase 3: Creation UI Surfaces

- Create `CreateAgentDialog` component with name input, template picker, personality section
- Create `useAgentCreationStore` Zustand store for global dialog control
- Mount dialog in `AppShell.tsx`
- Add "New Agent" button to `AgentsHeader`
- Add "Create Agent" action to command palette
- Implement template grid UI with category filtering
- Implement custom GitHub URL input
- Implement progress overlay (git progress bar / giget spinner)
- Tests for dialog, palette action, agents page integration

### Phase 4: Template System

- Add `giget` dependency
- Implement `template-downloader.ts` service (git primary, giget fallback)
- Implement git progress parsing (stderr → percentage)
- Implement giget error classification
- Implement auth resolution (`GITHUB_TOKEN` → `gh auth token`)
- Create default template catalog (`DEFAULT_TEMPLATES`)
- Add template CRUD endpoints (`GET/POST/DELETE /api/templates`)
- Add `use-template-catalog.ts` TanStack Query hook
- Implement post-install hook detection and user prompt
- Tests for downloader, catalog, auth resolution

### Phase 5: MCP Tool & DorkBot Recreation

- Add `create_agent` MCP tool definition and handler
- Implement DorkBot recreation in Settings → Agents section
- Add "dorkbot exists" detection query
- Implement simplified personality step for recreation
- Implement sound design (slider tick + celebration chime)
- Tests for MCP tool, recreation flow, sound utilities

## Open Questions

1. ~~**Template catalog distribution**~~ (RESOLVED)
   **Answer:** Static in server bundle
   **Rationale:** Ships with the server, works offline, no network dependency. Updated when DorkOS upgrades. Simplest implementation — just an exported constant in shared package.

2. ~~**DorkBot personality persistence**~~ (RESOLVED)
   **Answer:** One-time snapshot
   **Rationale:** The first message is baked at creation time and never changes. Personality changes affect future messages but not the historical first message. Simpler, avoids confusing history rewrites.

3. ~~**Template version pinning**~~ (RESOLVED)
   **Answer:** Latest default branch
   **Rationale:** Always gets the newest version. Templates are external repos we don't control — pinning would require manual maintenance. Users want fresh starters.

4. ~~**Custom template validation**~~ (RESOLVED)
   **Answer:** Validate on add
   **Rationale:** HEAD request to the repo when adding catches typos early. Better UX than discovering a bad URL at download time. Needs auth-aware validation for private repos.

## Related ADRs

| ADR      | Title                                                               | Relationship                                          |
| -------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| ADR-0043 | Use Filesystem as Canonical Source of Truth for Mesh Agent Registry | Agent creation writes to disk first, then syncs to DB |
| ADR-0172 | Adopt SOUL.md and NOPE.md as Agent Convention Files                 | Convention files scaffolded during creation           |
| ADR-0173 | Static Template Rendering for Personality Traits                    | 5×5 trait lookup table used for slider previews       |
| ADR-0171 | Enable Relay and Pulse by Default                                   | New agents inherit enabled-by-default subsystems      |
| ADR-0054 | Invert Feature Flags to Enabled by Default                          | Underpins FTUE assumption                             |

## References

- [Ideation document](./01-ideation.md) — Full research, codebase map, resolved decisions
- [Brief](./00-brief.md) — Problem statement, goals, key decisions
- [FTUE Spec (#79)](../first-time-user-experience/02-specification.md) — Onboarding step structure
- [Personality Spec (#159)](../agent-personality-convention-files/02-specification.md) — Convention file system
- [Agents Page Redesign (#167)](../agents-page-10x-redesign/02-specification.md) — Fleet management surface
- [giget documentation](https://github.com/unjs/giget) — Template download library
- [Motion layoutId docs](https://motion.dev/docs/layout-animations) — Shared layout animations
- Research: `research/20260323_agent_creation_templates_deep_dive.md`
- Research: `research/20260323_agent_workspace_starter_templates.md`
