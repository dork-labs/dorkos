# Agent Creation & Workspace Templates

**Spec #168** | Created: 2026-03-23 | Status: brief

## Problem

Creating a new agent in DorkOS requires the user to already have a directory on disk, navigate to it via the DirectoryPicker, and fill out a registration form. There's no way to create a new project folder from within the app. This means every new agent starts with a context switch — open a terminal, `mkdir`, come back. Worse, the first-time user experience asks users to discover existing agents on their machine, which assumes they already have projects set up. A user who installs DorkOS for the first time and has no existing Claude Code projects hits a dead end.

The app also has no concept of a **default agent** — a general-purpose agent that's always available for asking questions about DorkOS, running ad-hoc tasks, or just getting started. Every other developer tool with an agent layer (Cursor, Windsurf, Codex) provides this out of the box.

## Goals

1. **Agent creation from anywhere** — Users can create new agents from onboarding, the `/agents` page, the command palette, and via MCP tools. Each surface calls the same creation pipeline.
2. **Workspace scaffolding** — Creating an agent also creates its directory on disk, scaffolds `agent.json`, convention files (SOUL.md, NOPE.md), and optionally seeds from a project template.
3. **Default agent directory** — New agents are created in `~/.dork/agents/{agent-name}/` by default. This is configurable via settings.
4. **Starter templates** — Users can seed a new agent workspace from a curated template catalog or any GitHub URL they have access to. Templates provide a project structure, AGENTS.md, and relevant boilerplate.
5. **Template catalog config** — A `~/.dork/agent-templates.json` config file stores the built-in template catalog and any user-added template URLs.
6. **DorkBot — the default agent** — The onboarding flow creates DorkBot, a default agent that serves as the user's general-purpose assistant. DorkBot knows about DorkOS and is always available. Users personalize DorkBot during onboarding via personality sliders, then land directly in a chat with their new agent.
7. **New Folder in DirectoryPicker** — The directory browser gains a "New Folder" button for creating subdirectories without leaving the app.
8. **Onboarding personality experience** — During first run, users tune their agent's personality with sliders in a polished, memorable interaction. This is the moment the agent "comes alive" — it should feel special.

## Non-Goals

- Template authoring tools (users create templates as normal GitHub repos)
- Template marketplace or registry service (templates are GitHub URLs, not a hosted catalog)
- Agent cloning or duplication (copy an existing agent to a new directory)
- Automatic git init in new workspaces (users can do this themselves; some templates include `.gitignore`)
- Multi-runtime template variants (templates are runtime-agnostic; the agent's runtime is chosen separately)

## Key Decisions & Constraints

### Naming Conventions

#### Product Naming

| Concept                 | Name                      | Rationale                                                                              |
| ----------------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| The framework           | **DorkOS**                | The operating system for autonomous AI agents                                          |
| The default agent       | **DorkBot**               | DorkOS is the framework; DorkBot is the agent within it. Clear separation of concerns. |
| Default agent directory | `~/.dork/agents/dorkbot/` | Lowercase kebab-case, matching the agent name convention                               |

#### Code Naming — Agent Lifecycle Methods

The current codebase has overlapping names for different operations. This spec establishes a clean three-tier naming convention based on what each operation actually does:

| Operation    | Transport Method        | Server Endpoint           | Hook                 | What It Does                                                                                                                                                                  |
| ------------ | ----------------------- | ------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Create**   | `createAgent(opts)`     | `POST /api/agents`        | `useCreateAgent()`   | Full pipeline: mkdir + scaffold agent.json + SOUL.md + NOPE.md + optional template download + register in mesh. This is the primary user-facing operation.                    |
| **Init**     | `initAgent(path, opts)` | `PUT /api/agents/current` | `useInitAgent()`     | Write agent.json + convention files to an **existing** directory. Like `git init` — the directory exists, you're adding the agent identity layer. Lower-level building block. |
| **Register** | `registerAgent(path)`   | `POST /api/mesh/agents`   | `useRegisterAgent()` | Add an existing agent directory to the mesh DB cache. No files written. Already exists in mesh entity.                                                                        |

**Why this naming:**

- **`create`** = make something new that didn't exist (directory + all files). Users think "create an agent." This is the verb they'll encounter in UI.
- **`init`** = initialize config in a place that already exists (like `git init`, `npm init`). Developers understand this instantly. This is what the current `createAgent()` actually does — it should have been called `initAgent` from the start.
- **`register`** = add to a registry/index. Already named correctly in mesh.

**Migration:** The existing `transport.createAgent()` is renamed to `transport.initAgent()`. The new `transport.createAgent()` takes an options object and handles the full pipeline. `createAgent` internally calls `initAgent`, which may call `registerAgent`. The hierarchy is clear: create > init > register.

#### File & Directory Naming

| Concept                 | Name                           | Rationale                                                                             |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| Feature slug            | `agent-creation-and-templates` | Describes both the creation flow and the template system                              |
| Default agent root      | `~/.dork/agents/`              | Consistent with `~/.dork/mesh/`, `~/.dork/relay/`, etc.                               |
| Individual agent dir    | `~/.dork/agents/{agent-name}/` | Kebab-case name becomes directory name                                                |
| Template catalog file   | `~/.dork/agent-templates.json` | Disambiguated from other template/preset types (Pulse presets, adapter configs, etc.) |
| Server endpoint (mkdir) | `POST /api/directory`          | Creates a directory on disk. Restricted to filesystem boundary.                       |
| MCP tool                | `create_agent`                 | Exposed via external MCP server for other agents/tools                                |

### Default Agent Directory

`~/.dork/agents/` is the default root for new agents. Each agent gets its own subdirectory:

```
~/.dork/agents/
├── dorkbot/               # Default agent (created during onboarding)
│   └── .dork/
│       ├── agent.json
│       ├── SOUL.md
│       └── NOPE.md
├── my-api/
│   └── .dork/
│       ├── agent.json
│       ├── SOUL.md
│       └── NOPE.md
└── frontend-app/
    ├── .dork/
    │   ├── agent.json
    │   ├── SOUL.md
    │   └── NOPE.md
    ├── src/
    ├── package.json
    └── AGENTS.md          # From template
```

The default directory is configurable in `~/.dork/config.json`:

```jsonc
{
  "agents": {
    "defaultDirectory": "~/.dork/agents", // Can be changed to e.g. "~/projects"
  },
}
```

### DorkBot — The Default Agent

Created during onboarding as the user's first agent. DorkOS is the OS; DorkBot is the agent.

**Purpose:**

- General-purpose assistant — ask questions about DorkOS, run ad-hoc tasks, experiment
- Always available as a fallback when no project-specific agent is selected
- Ships with a pre-written SOUL.md that gives it knowledge about DorkOS concepts
- Ships with a AGENTS.md that includes DorkOS documentation pointers
- Personality tuned by the user during onboarding (sliders set initial trait values)

**Not special at the system level** — DorkBot is a normal agent that happens to be created first and pre-configured. Users can rename it, change its personality, or delete it. The "default" designation is purely a UX convenience during onboarding.

**Recreatable** — If deleted, a "Recreate DorkBot" option in settings lets users restore it. But it won't auto-recreate — that would be presumptuous.

### Onboarding: Meet DorkBot

The onboarding personality step is the signature moment of the DorkOS first-run experience. This is where the product stops being a tool and starts being _your_ tool. It should be the most polished, most memorable interaction in the entire app.

**Flow:**

```
Welcome → Meet DorkBot → Discover Existing → Pulse Presets → Chat with DorkBot
```

**Step: "Meet DorkBot"**

The step has two phases that flow as one continuous interaction:

**Phase 1 — Name & Template (quick, functional)**

- Pre-fills name as `dorkbot` (editable)
- Directory shown but not emphasized (`~/.dork/agents/dorkbot/`)
- Template picker: Blank (default) or choose a starter. Collapsed by default — most users skip this on first run.
- This phase takes ~5 seconds for most users

**Phase 2 — Personality (the experience)**

This is the moment DorkBot comes alive. The user tunes 5 personality sliders and sees the effect in real time:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│           ┌─────────────────────────────────────┐           │
│           │                                     │           │
│           │   "Hey! I'm DorkBot. I'll be your   │           │
│           │   first agent — here to help you     │           │
│           │   ship faster. Adjust the sliders    │           │
│           │   to make me yours."                 │           │
│           │                                     │           │
│           └─────────────────────────────────────┘           │
│                                                             │
│  Personality                                                │
│                                                             │
│  Tone        Serious ──────────●──── Playful    Balanced    │
│  Autonomy    Ask first ────────●──── Act alone   Balanced   │
│  Caution     Conservative ──●─────── Bold        Cautious   │
│  Detail      Terse ────────────●──── Thorough    Balanced   │
│  Creativity  By the book ──────●──── Inventive   Balanced   │
│                                                             │
│                                                             │
│                    [ Create DorkBot → ]                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**What makes this special:**

1. **Live personality preview** — As the user adjusts each slider, a preview bubble shows how DorkBot would introduce itself at that setting. The text morphs smoothly (crossfade) between personality levels. Moving "Tone" from Serious to Playful changes the greeting from "I'm ready to assist with your engineering tasks." to "Let's build something awesome! I'm DorkBot and I'm unreasonably excited to help."

2. **Ambient animation** — The DorkBot avatar (or a stylized bot icon) has subtle idle animation — gentle breathing/pulsing that intensifies slightly as sliders are adjusted, like it's reacting to being shaped.

3. **Sound design** (optional, if notification sounds are enabled) — Subtle, satisfying slider tick sounds. A small celebratory sound when "Create DorkBot" is pressed.

4. **The transition** — After creation, the onboarding doesn't just end. The personality preview bubble smoothly transforms into the first message in a real chat session. DorkBot's first message uses the personality the user just configured. The user is now _in conversation_ with an agent they just brought to life. This transition should feel seamless — the agent was born in the onboarding step and the chat is its first breath.

**After onboarding completes:**

The remaining onboarding steps (Discover Existing, Pulse Presets) still run. But after the final step, the user lands in a chat session with DorkBot — not on the dashboard, not on an empty screen. They're talking to their agent. First message from DorkBot: a personality-appropriate welcome that references what DorkOS can do and invites the user to ask questions or start building.

### Template Catalog

Templates are GitHub repositories downloaded via `giget` (UnJS). The catalog lives in `~/.dork/agent-templates.json`:

```jsonc
{
  "version": 1,
  "templates": [
    {
      "id": "blank",
      "name": "Blank Workspace",
      "description": "Empty workspace with AGENTS.md and .claude/rules/",
      "source": "github:dorkos/templates/blank",
      "category": "general",
      "builtin": true,
    },
    {
      "id": "nextjs",
      "name": "Next.js App",
      "description": "Next.js 16 + Tailwind CSS 4 + TypeScript",
      "source": "github:ixartz/Next-js-Boilerplate",
      "category": "frontend",
      "builtin": true,
    },
    {
      "id": "vite-react",
      "name": "Vite + React SPA",
      "description": "React 19 + Vite 6 + TanStack Router + Tailwind",
      "source": "github:RicardoValdovinos/vite-react-boilerplate",
      "category": "frontend",
      "builtin": true,
    },
    {
      "id": "express-api",
      "name": "Express REST API",
      "description": "Express + TypeScript + Zod + Vitest + Swagger",
      "source": "github:edwinhern/express-typescript",
      "category": "backend",
      "builtin": true,
    },
    {
      "id": "fastapi",
      "name": "FastAPI Python API",
      "description": "FastAPI + PostgreSQL + Docker + SQLModel",
      "source": "github:fastapi/full-stack-fastapi-template",
      "category": "backend",
      "builtin": true,
    },
    {
      "id": "ts-library",
      "name": "TypeScript Library",
      "description": "TypeScript + tsup + Vitest + dual ESM/CJS",
      "source": "github:jasonsturges/tsup-npm-package",
      "category": "library",
      "builtin": true,
    },
    {
      "id": "cli-tool",
      "name": "Node.js CLI Tool",
      "description": "TypeScript + commander + tsup + Vitest",
      "source": "github:kucherenko/cli-typescript-starter",
      "category": "tooling",
      "builtin": true,
    },
  ],
}
```

Users can add their own templates:

```jsonc
{
  "id": "my-monorepo",
  "name": "My Monorepo Starter",
  "description": "Company monorepo with shared packages",
  "source": "github:myorg/monorepo-template",
  "category": "custom",
  "builtin": false,
}
```

**Template download:** Uses `giget` (3M+ weekly npm downloads, powers Nuxt's `nuxi init`). Supports GitHub/GitLab/Bitbucket, private repos via `GITHUB_TOKEN`, and has a clean async API:

```typescript
import { downloadTemplate } from 'giget';

await downloadTemplate('github:ixartz/Next-js-Boilerplate', {
  dir: targetPath,
  auth: process.env.GITHUB_TOKEN,
});
```

**Why giget over alternatives:**

- `degit` is abandoned (last release 2020)
- GitHub Template API requires OAuth `repo` scope and creates a remote repo — too invasive
- `giget` is actively maintained, handles auth, and works as a pure local download

### Creation Surfaces

**1. Onboarding (first run):**

See "Onboarding: Meet DorkBot" section above. Creates DorkBot with personality tuning, then drops the user into a chat session.

**2. Agents page (`/agents`):**

"New Agent" button in the header (alongside existing "Scan for Agents"). Opens a creation dialog with:

- Agent name input (auto-generates directory path as `~/.dork/agents/{name}/`)
- Directory override (change from default via DirectoryPicker)
- Template picker (optional)
- Custom GitHub URL input (optional)
- Personality sliders (optional — collapsed by default, unlike onboarding where they're the hero)

**3. Command palette:**

"Create Agent" action. Opens the same creation dialog used by the Agents page.

**4. MCP tool:**

`create_agent` tool exposed via the external MCP server:

```typescript
{
  name: 'create_agent',
  description: 'Create a new DorkOS agent workspace with scaffolded config files',
  inputSchema: {
    name: { type: 'string', description: 'Agent name (kebab-case)' },
    directory: { type: 'string', description: 'Optional directory path. Defaults to ~/.dork/agents/{name}/' },
    template: { type: 'string', description: 'Optional template ID or GitHub URL' },
    description: { type: 'string', description: 'Optional agent description' },
    runtime: { type: 'string', description: 'Agent runtime (default: claude-code)' },
  }
}
```

### DirectoryPicker: New Folder

The DirectoryPicker gains a "New Folder" button in the browse view toolbar:

- Clicking it shows an inline text input at the top of the directory listing
- User types a folder name, presses Enter
- Server creates the subdirectory inside the currently browsed path via `POST /api/directory`
- Picker refreshes to show the new folder
- New folder is auto-selected

This requires a new transport method: `createDirectory(parentPath: string, folderName: string)`.

## Creation Pipeline (Server)

The full creation pipeline when `POST /api/agents` is called:

```
1. Validate inputs (name format, directory path, template ID/URL)
2. Check for naming collision (directory already exists → 409 Conflict)
3. Create target directory (mkdir -p)
4. If template specified:
   a. Download template via giget to target directory
   b. Preserve any .dork/ files from template (don't overwrite with scaffolded versions)
5. Create .dork/ subdirectory (if not from template)
6. Scaffold agent.json (name, runtime, traits, conventions enabled)
7. Scaffold SOUL.md (trait-rendered + any template-specific content)
8. Scaffold NOPE.md (default safety boundaries)
9. Register agent in Mesh DB cache (best-effort)
10. Return created agent manifest
```

## Research

- [Agent Personality & Convention Files](../agent-personality-convention-files/00-brief.md) — SOUL.md/NOPE.md scaffolding, already implemented
- [Agents Page Fleet Management UX](../../research/20260322_agents_page_fleet_management_ux_deep_dive.md) — empty state with `+ Add directory`
- [Agent Workspace Starter Templates](../../research/20260323_agent_workspace_starter_templates.md) — template research, giget recommendation
- [OpenClaw Convention Files](../../research/20260321_openclaw_ai_convention_markdown_files.md) — convention file landscape

## Resolved Decisions

1. **Template catalog hosting:** Built-in templates point to external GitHub repos directly. No DorkOS-owned monorepo for now — it adds maintenance burden without enough benefit at this stage. If template quality becomes an issue, we can fork into a `dorkos/templates` monorepo later.

2. **Private repo auth:** Read `GITHUB_TOKEN` from environment first, fall back to `gh auth token` if GitHub CLI is installed. No settings UI for token management in v1.

3. **Template post-install hooks:** No auto-run. If a template contains a setup script (e.g., `postinstall` in `package.json`), show a prompt: "This template has a setup script. Run it?" The user decides. Security over convenience.

4. **Naming collision handling:** 409 Conflict with a clear error message. No auto-suffixing, no silent overwrite. Explicit is better. The UI should pre-validate and show an inline error before the user hits "Create."

5. **DorkBot's AGENTS.md content:** Comprehensive product knowledge baked in. DorkBot should feel knowledgeable out of the box — it knows DorkOS concepts, subsystem names, common workflows, and where to find documentation. This is baked at scaffold time, not dynamically generated.

6. **Personality preview in onboarding:** Static templates for each slider level. Each trait has 5 pre-written preview strings that swap instantly on slider change. No LLM calls during onboarding — instant feedback is more important than authenticity. The first _real_ message happens in the chat session after onboarding completes.

## Open Questions

None remaining — all decisions resolved.

## Phasing (Suggested)

1. **Phase 1: Core creation pipeline** — Rename `createAgent` → `initAgent`, new `createAgent` full pipeline, `POST /api/agents` endpoint, `POST /api/directory` endpoint, `createDirectory` transport method, DirectoryPicker "New Folder" button
2. **Phase 2: DorkBot & onboarding** — DorkBot SOUL.md/AGENTS.md content, "Meet DorkBot" onboarding step with personality sliders and live preview, post-onboarding chat session transition
3. **Phase 3: Creation UI surfaces** — CreateAgentDialog shared component, Agents page "New Agent" button, command palette action
4. **Phase 4: Template system** — `giget` integration, `agent-templates.json` config, template picker UI, custom GitHub URL input
5. **Phase 5: MCP tool** — `create_agent` MCP tool, template support via MCP
