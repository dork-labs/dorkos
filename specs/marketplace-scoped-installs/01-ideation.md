---
slug: marketplace-scoped-installs
number: 241
created: 2026-04-12
status: ideation
---

# Marketplace Scoped Installs & Skills-First Agent Toolkit

**Slug:** marketplace-scoped-installs
**Author:** Claude Code
**Date:** 2026-04-12
**Branch:** preflight/marketplace-scoped-installs

---

## 1) Intent & Assumptions

- **Task brief:** Fill architectural gaps in the marketplace installation system. Add per-agent package scoping (global vs agent-local), a skills-first "Toolkit" tab in the agent hub showing what an agent can do, and enhanced global install visibility in the existing marketplace view.
- **Assumptions:**
  - The existing `projectPath` server primitive is the foundation for agent-scoped installs
  - Agent workspaces can live anywhere on disk (not just `~/.dork/agents/<name>/`) — the storage model must be path-agnostic
  - Skills (SKILL.md files from skill-packs) are the primary user-facing concept, not packages
  - The additive cascade model (global + agent-local, local wins on conflict) is the right scoping model
  - The agent hub's current 2-tab structure (Sessions, Config) can accommodate a 3rd tab
- **Out of scope:**
  - Marketplace source management UI changes
  - Package authoring/publishing flow
  - Template type distinction (separate concern)
  - Per-skill enable/disable within a skill-pack (v2 — see exclusion mechanism)

## 2) Pre-reading Log

- `apps/server/src/services/marketplace/marketplace-installer.ts`: Main orchestrator — `dispatchFlow()` routes to type-specific install flows. Already accepts `projectPath` in install options.
- `apps/server/src/services/marketplace/installed-scanner.ts`: `scanInstalledPackages()` walks `${dorkHome}/plugins/` and `${dorkHome}/agents/` only — blind to project-local installs.
- `apps/server/src/services/marketplace/flows/install-plugin.ts`: Plugin flow computes install root from `projectPath` — line 89: `if (projectPath) return path.join(projectPath, '.dork', 'plugins', name)`.
- `apps/server/src/services/marketplace/flows/install-skill-pack.ts`: Same `projectPath` pattern at line 82.
- `apps/server/src/services/marketplace/flows/install-agent.ts`: Agent flow does NOT support agent-local scoping — always installs to `${dorkHome}/agents/<name>/`.
- `apps/server/src/services/marketplace/flows/install-adapter.ts`: Adapter flow hardcodes `${dorkHome}/plugins/<name>` — no `projectPath` support.
- `apps/server/src/services/marketplace/conflict-detector.ts`: Scope-aware but uses one scope at a time — doesn't cross-check global vs project-local.
- `apps/client/src/layers/entities/marketplace/api/query-keys.ts`: Line 18-22 comment: "installed is intentionally global today — when project-scoped install listing is added, this key must gain a `projectPath` dimension."
- `apps/client/src/layers/shared/lib/transport/marketplace-methods.ts`: `installMarketplacePackage()` accepts `InstallOptions` with `projectPath` — client never passes it.
- `apps/client/src/layers/features/agent-hub/model/agent-hub-store.ts`: 2 tabs only: `sessions` and `config`.
- `apps/client/src/layers/features/agent-hub/ui/tabs/ConfigTab.tsx`: Config tab has accordion sections: metadata, Tools & MCP, Channels, Advanced. Tools & MCP wraps `AgentToolsTab`.
- `apps/client/src/layers/features/agent-hub/ui/AgentHub.tsx`: Shell resolves agent path from hub store or `selectedCwd`, fetches manifest via `useCurrentAgent()`.
- `apps/client/src/layers/features/marketplace/ui/InstalledPackagesView.tsx`: Shows global installs with update/uninstall actions. No scope awareness.
- `apps/server/src/services/core/agent-creator.ts`: Agent directory path resolved from `opts.directory` or default `~/.dork/agents/<name>/`. Agents can live anywhere.
- `packages/shared/src/mesh-schemas.ts`: `AgentManifestSchema` has `enabledToolGroups` but no `plugins`, `skills`, or `extensions` fields.
- `apps/server/src/services/extensions/extension-discovery.ts`: Scans global (`${dorkHome}/extensions/`) and local (`${cwd}/.dork/extensions/`) — local overrides global by ID. Established pattern to follow.
- `packages/shared/src/config-schema.ts`: `defaultDirectory: z.string().default('~/.dork/agents')` — the default agent home.
- `packages/shared/src/manifest.ts`: `MANIFEST_DIR = '.dork'`, `MANIFEST_FILE = 'agent.json'` — every agent workspace has `.dork/agent.json`.

## 3) Codebase Map

**Primary components/modules:**

- `apps/server/src/services/marketplace/` — Install orchestrator, flows, scanner, conflict detector, resolver, fetcher
- `apps/server/src/services/extensions/` — Extension discovery with global+local pattern (reference model)
- `apps/server/src/services/core/agent-creator.ts` — Agent workspace creation and path resolution
- `apps/client/src/layers/features/agent-hub/` — Agent hub shell, tabs, store, context
- `apps/client/src/layers/features/marketplace/` — Marketplace browse, install dialog, installed view
- `apps/client/src/layers/entities/marketplace/` — TanStack Query hooks, query keys, transport calls
- `packages/shared/src/marketplace-schemas.ts` — `InstallOptions`, `InstalledPackage` types
- `packages/shared/src/mesh-schemas.ts` — Agent manifest schema, `EnabledToolGroups`

**Shared dependencies:**

- `@dorkos/shared` — Schemas, types, manifest utilities
- `@dorkos/marketplace` — Package types, manifest schema, validator
- TanStack Query — All data fetching on client
- Zustand — Agent hub store, marketplace store

**Data flow:**

- Install: UI → transport.installMarketplacePackage(name, opts) → POST /api/marketplace/packages/:name/install → MarketplaceInstaller.install() → type-specific flow → filesystem write
- List installed: UI → transport.listInstalledPackages() → GET /api/marketplace/installed → scanInstalledPackages(dorkHome) → filesystem walk → response
- Agent hub: AgentHub → useCurrentAgent(agentPath) → GET /api/agents/:path → .dork/agent.json read

**Potential blast radius:**

- Server: installed-scanner (add projectPath param), marketplace routes (add query param), conflict-detector (cross-scope)
- Client: agent-hub store (add tab type), AgentHubTabBar (add tab), new ToolkitTab component, query-keys (add projectPath dimension), transport methods (pass projectPath), InstalledPackagesView (scope badges), install confirmation dialog (scope selector)
- Shared: marketplace-schemas (extend InstalledPackage with scope field), mesh-schemas (add excludedPackages to agent manifest for v2)

## 4) Research

### Scoped Installation Patterns

Research covered npm, VS Code, mise/asdf, pip/conda, Homebrew, Obsidian, Codex CLI, and several agent platforms.

**Best analogues for DorkOS:**

1. **Codex CLI** (High applicability) — Additive multi-scope discovery with name-first deduplication. Skills from all scopes collected and merged; same-name conflicts resolved by higher-precedence scope. Filesystem-native, no database.
2. **mise/asdf** (High applicability) — Filesystem walk with nearest-wins. `--global` / no-flag convention maps to "Install for all agents" / "Install for this agent."
3. **VS Code Extensions** (Medium) — Dual-layer with workspace overlay. Visual "modified from default" indicator for scope overrides.

**Anti-patterns:**

- Obsidian (per-vault isolation with no global sharing) — storage duplication, update fatigue
- pip/conda (full environment isolation) — no inheritance, redundant installs

### Agent Skills UX Patterns

Research covered OpenAI Custom GPTs, Anthropic Claude, Microsoft Copilot Studio, Google Vertex AI, LangGraph Studio, CrewAI, AutoGen Studio, Relevance AI, Codex CLI, and GitHub Copilot/VS Code.

**Key findings:**

1. **"Skills" is winning as the user-facing term** — industry convergence around SKILL.md as an open standard (agentskills.io). Even Microsoft now uses "Agent Skills."
2. **Multiple platforms have a dedicated skills section per agent** — Copilot Studio (Tools page), VS Code (Skills tab in Chat Customizations), AutoGen Studio (Skills library panel).
3. **The best pattern (Copilot Studio):** Full-width list within agent context, each item shows icon + name + type badge + description + enabled/disabled status, "Add a tool" CTA prominent at top, click-through to detail page.
4. **Skills vs Tools distinction:** Skills = installable behavioral context (SKILL.md). Tools = runtime callable functions (MCP/platform). DorkOS should surface both but keep them visually grouped.

**Recommendation:** "Skills" as the primary user-facing concept. The "Toolkit" tab combines skills + tool groups + MCP under one "what can my agent do?" umbrella.

## 5) Decisions

| #   | Decision                            | Choice                                                          | Rationale                                                                                                                                                               |
| --- | ----------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Agent-local storage location        | `{agent.projectPath}/.dork/plugins/<pkg>/`                      | Works uniformly for agents anywhere on disk; follows established `.dork/extensions/` convention; every agent workspace already has `.dork/`                             |
| 2   | Agent hub UI for per-agent installs | New "Toolkit" tab (3rd tab) combining Skills + Tools & MCP      | Skills deserve first-class visibility; tools answer the same "what can my agent do?" question; research shows dedicated skills section is the emerging industry pattern |
| 3   | Global installs view                | Enhance existing InstalledPackagesView in marketplace feature   | Already exists and works; natural home for system-wide package management; avoids creating a redundant UI surface                                                       |
| 4   | Install scoping UX                  | Context-aware default with override                             | Marketplace browse → global default; Toolkit tab → agent-local default; confirmation dialog always shows scope selector for override                                    |
| 5   | Exclusion mechanism                 | Toggle in Toolkit tab, deferred to v2                           | Design the schema now (`excludedPackages: string[]` in agent manifest); implement after core scoping is validated                                                       |
| 6   | Scoping model                       | Additive cascade — global + agent-local, local wins on conflict | Matches Codex CLI and mise patterns; global packages auto-available to all agents, agent-local supplements or overrides                                                 |
| 7   | Terminology                         | "Skills" as primary user-facing term; "Toolkit" as tab name     | Industry convergence on skills; toolkit is a good metaphor for the combined skills + tools view                                                                         |

## 6) Proposed Architecture

### Storage Model

```
~/.dork/
├── plugins/                          # Global scope (all agents)
│   ├── typescript-expert/            # skill-pack
│   │   └── .dork/manifest.json
│   └── github-adapter/              # adapter
│       └── .dork/manifest.json
└── agents/
    └── backend-bot/                  # Agent workspace (default location)
        └── .dork/
            ├── agent.json
            ├── plugins/              # Agent-local scope
            │   └── api-testing/      # skill-pack local to this agent
            │       └── .dork/manifest.json
            └── ...

~/projects/my-app/                    # Agent workspace (custom location)
└── .dork/
    ├── agent.json
    ├── plugins/                      # Agent-local scope
    │   └── react-patterns/           # skill-pack local to this agent
    │       └── .dork/manifest.json
    └── ...
```

### Resolution Algorithm (per-agent effective package set)

1. Collect all packages from `~/.dork/plugins/` (global scope)
2. Collect all packages from `{agent.projectPath}/.dork/plugins/` (agent-local scope)
3. Merge: agent-local packages supplement the global set
4. Same package name at both scopes → agent-local version wins (version override)
5. (v2) Packages in `agent.excludedPackages[]` removed from effective set

### Server Changes

1. **`scanInstalledPackages(dorkHome, projectPath?)`** — accept optional `projectPath`, scan both global and agent-local directories, return packages with a `scope: 'global' | 'agent-local'` field
2. **`GET /api/marketplace/installed?projectPath=`** — add optional query param for scoped listing
3. **Conflict detector** — cross-scope conflict detection (warn when same package exists at both scopes)
4. **Install flows** — client passes `projectPath` to install agent-locally

### Client Changes

1. **Agent hub store** — add `'toolkit'` to `AgentHubTab` union
2. **AgentHubTabBar** — add Toolkit tab
3. **AgentHubTabContent** — lazy-load new `ToolkitTab` component
4. **ToolkitTab** — two sections:
   - **Skills section**: lists effective skills (global + agent-local merged), grouped by source skill-pack, with scope badges (Global/Local/Override)
   - **Tools & MCP section**: existing `AgentToolsTab` content (tool group toggles + MCP)
5. **Config tab** — remove "Tools & MCP" accordion (moved to Toolkit tab)
6. **Query keys** — `marketplaceKeys.installed(projectPath?)` gains projectPath dimension
7. **Install confirmation dialog** — add scope selector: "Install for: [All agents] / [Agent Name]"
8. **InstalledPackagesView** — add scope badges, filtering by scope

### Scope Badges (Visual Design)

| Badge      | Style                  | Meaning                                                  |
| ---------- | ---------------------- | -------------------------------------------------------- |
| `Global`   | Muted/grey pill        | Installed globally, inherited by this agent              |
| `Local`    | Blue pill              | Installed specifically for this agent                    |
| `Override` | Amber pill             | Same package exists globally; agent-local version active |
| `Excluded` | Red strikethrough (v2) | Globally installed but suppressed for this agent         |

### Toolkit Tab Layout

```
[Sessions]  [Config]  [Toolkit]
                        │
                        ├── Skills
                        │   ├── From: TypeScript Expert (global)
                        │   │   ├── ts-refactor          [Global] [Auto]
                        │   │   └── ts-test-generator     [Global] [Auto]
                        │   ├── From: API Testing (local)
                        │   │   └── api-contract-test     [Local]  [User-only]
                        │   ├── Available globally (not yet in use)
                        │   │   └── + Add skills from "React Patterns"
                        │   └── [Browse skill-packs]
                        │
                        └── Tools & MCP
                            ├── Tool Groups
                            │   ├── Tasks      [on/off]
                            │   ├── Relay      [on/off]
                            │   ├── Mesh       [on/off]
                            │   └── Adapter    [on/off]
                            └── MCP Servers
                                └── (existing MCP config)
```
