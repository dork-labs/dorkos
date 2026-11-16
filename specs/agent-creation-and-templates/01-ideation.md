---
slug: agent-creation-and-templates
number: 168
created: 2026-03-23
status: ideation
---

# Agent Creation & Workspace Templates

**Slug:** agent-creation-and-templates
**Author:** Claude Code
**Date:** 2026-03-23
**Branch:** preflight/agent-creation-and-templates

---

## 1) Intent & Assumptions

- **Task brief:** Build a complete agent creation pipeline that lets users create new agents from multiple surfaces (onboarding, `/agents` page, command palette, MCP), with workspace scaffolding on disk, starter templates from GitHub repos, a default "DorkBot" agent created during onboarding with personality sliders, and a "New Folder" button in DirectoryPicker.

- **Assumptions:**
  - Convention file system (SOUL.md, NOPE.md, trait renderer) is already implemented and stable
  - The existing onboarding flow (Spec #79) is built and can be extended with a new "Meet DorkBot" step
  - Personality sliders UI components from Spec #159 are partially implemented (trait renderer in shared, server scaffolding works, but slider UI components may still be needed)
  - Users installing DorkOS for the first time likely have git installed (developer audience)
  - The `~/.dork/` directory structure is established convention (`~/.dork/mesh/`, `~/.dork/relay/`, etc.)
  - DorkBot is a normal agent — not privileged at the system level

- **Out of scope:**
  - Template authoring tools, marketplace, or registry service
  - Agent cloning/duplication
  - Automatic `git init` in new workspaces
  - Multi-runtime template variants
  - Settings UI for GitHub token management (v1)
  - MCP tool for searching DorkOS documentation (future enhancement)

## 2) Pre-reading Log

- `specs/first-time-user-experience/02-specification.md`: 844-line FTUE spec. Onboarding flow with discovery scanner, pulse presets, adapter setup, feature flag inversion. Already partially implemented. DorkBot creation step would insert before discovery.
- `specs/agents-page-10x-redesign/02-specification.md`: 1204-line agents page redesign. Fleet health bar, filter bar, view switching, ghost rows. Provides reference patterns for agent display and empty states.
- `specs/agent-personality-convention-files/02-specification.md`: 974-line personality spec. 5 trait sliders (Tone, Autonomy, Caution, Communication, Creativity) with 5 levels each. SOUL.md/NOPE.md convention files, trait renderer, context builder injection. Mostly implemented on server side.
- `apps/client/src/layers/entities/agent/model/use-create-agent.ts`: 22-line mutation hook calling `transport.createAgent(path, name, description, runtime)`. Will be renamed to `useInitAgent()`.
- `apps/server/src/routes/agents.ts`: Agent CRUD routes. POST handler scaffolds `.dork/agent.json`, SOUL.md, NOPE.md, syncs to Mesh DB. This is the existing "init" operation that needs renaming.
- `apps/client/src/layers/shared/ui/DirectoryPicker.tsx`: Directory selection with recent/browse views, agent resolution badges, localStorage persistence. No "New Folder" capability yet.
- `packages/shared/src/transport.ts`: Hexagonal transport interface. Has `createAgent()` (to be renamed `initAgent()`), `browseDirectory()`. Needs new `createAgent()` (full pipeline) and `createDirectory()`.
- `packages/shared/src/trait-renderer.ts`: Static trait lookup table — 5 traits × 5 levels = 25 entries. `renderTraits()`, `DEFAULT_TRAITS` (all level 3). Used by convention file scaffolding.
- `packages/shared/src/convention-files.ts`: Read/write SOUL.md/NOPE.md, `defaultSoulTemplate()`, `defaultNopeTemplate()`, trait section delimiters (`<!-- TRAITS:START/END -->`).
- `apps/server/src/routes/mcp.ts`: Stateless MCP server router. POST-only, fresh McpServer per request. Pattern for adding `create_agent` tool.
- `apps/client/src/layers/features/command-palette/model/use-palette-actions.ts`: Action dispatcher with agent selection, theme toggle, feature panel opening. Pattern for adding "Create Agent" action.
- `apps/client/src/layers/features/onboarding/`: 16 files — OnboardingFlow, AgentDiscoveryStep, NoAgentsFound, PulsePresetsStep, DiscoveryCelebration, ProgressCard, use-onboarding hook.
- `packages/shared/src/config-schema.ts`: Config schema with scheduler, relay, mesh toggles, onboarding state. Needs `agents.defaultDirectory` field.
- `research/20260323_agent_workspace_starter_templates.md`: Template research — 7 templates, giget recommendation, download patterns.
- `research/20260323_agent_creation_templates_deep_dive.md`: Deep dive — giget error handling (no progress callbacks, no cancellation, generic errors), AnimatePresence crossfade patterns, AGENTS.md architecture (<80 lines), mkdir security (kebab-case validation, boundary checks).
- `research/20260322_agents_page_fleet_management_ux_deep_dive.md`: Agents page UX — `+ Add directory` chip, ghost rows, empty state patterns.
- `contributing/architecture.md`: Hexagonal architecture, Transport interface, DI patterns.

## 3) Codebase Map

**Primary Components/Modules:**

| File                                                                           | Role                                                                        |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `apps/client/src/layers/entities/agent/model/use-create-agent.ts`              | Mutation hook (to be renamed `useInitAgent`)                                |
| `apps/client/src/layers/shared/ui/DirectoryPicker.tsx`                         | Directory browser (needs "New Folder" button)                               |
| `apps/client/src/layers/features/onboarding/ui/OnboardingFlow.tsx`             | Full-screen onboarding container                                            |
| `apps/client/src/layers/features/onboarding/ui/NoAgentsFound.tsx`              | Current agent creation fallback in onboarding                               |
| `apps/client/src/layers/features/command-palette/model/use-palette-actions.ts` | Command palette action dispatcher                                           |
| `apps/server/src/routes/agents.ts`                                             | Agent CRUD routes (POST = init, needs full create pipeline)                 |
| `apps/server/src/routes/directory.ts`                                          | Directory browsing (GET only, needs POST for mkdir)                         |
| `apps/server/src/routes/mcp.ts`                                                | External MCP server (needs `create_agent` tool)                             |
| `packages/shared/src/transport.ts`                                             | Transport interface (needs `createAgent` full pipeline + `createDirectory`) |
| `packages/shared/src/trait-renderer.ts`                                        | Static trait lookup (5×5 = 25 entries)                                      |
| `packages/shared/src/convention-files.ts`                                      | SOUL.md/NOPE.md read/write/templates                                        |
| `packages/shared/src/config-schema.ts`                                         | Config schema (needs `agents.defaultDirectory`)                             |
| `packages/shared/src/mesh-schemas.ts`                                          | AgentManifest, CreateAgentRequest, UpdateAgentRequest schemas               |

**Shared Dependencies:**

| Dependency              | Purpose                                | Used By                         |
| ----------------------- | -------------------------------------- | ------------------------------- |
| `@tanstack/react-query` | Server state, mutations                | Agent hooks, DirectoryPicker    |
| `motion`                | Animations (AnimatePresence, layoutId) | Onboarding, personality preview |
| `zod`                   | Schema validation                      | Server routes, shared schemas   |
| `@radix-ui/slider`      | Personality trait sliders              | PersonalitySliders component    |
| `@dorkos/shared/*`      | Cross-package types, schemas           | Client, server, packages        |

**Data Flow (Agent Creation):**

```
UI Surface (onboarding / agents page / command palette / MCP)
  ↓
CreateAgentDialog or inline form
  ↓
transport.createAgent({ name, directory?, template?, traits?, runtime? })
  ↓
POST /api/agents (full pipeline)
  ↓
1. Validate inputs (Zod schema, kebab-case name regex)
2. Resolve directory (default: ~/.dork/agents/{name}/)
3. Boundary-validate path (PathValidator)
4. Check collision (EEXIST → 409)
5. mkdir (recursive: false for agent dir, recursive: true for parent)
6. If template: git clone --depth 1 → rm .git (fallback: giget)
7. Scaffold .dork/agent.json, SOUL.md, NOPE.md
8. meshCore.syncFromDisk() (best-effort)
  ↓
Return 201 + AgentManifest
  ↓
Client: invalidate queries, navigate to chat session
```

**Feature Flags/Config:**

- `config.agents.defaultDirectory` — New config field (default: `~/.dork/agents`)
- Existing: `config.scheduler.enabled`, `config.relay.enabled`, `config.mesh.enabled`
- Existing: `config.onboarding.completedSteps` — needs new "meet-dorkbot" step ID

**Potential Blast Radius:**

- **Direct changes (new files):** CreateAgentDialog component, MeetDorkBotStep onboarding component, DorkBot AGENTS.md/SOUL.md templates, template download service, `create_agent` MCP tool
- **Direct changes (modify):** `transport.ts` (rename + new methods), `agents.ts` route (full pipeline), `directory.ts` route (POST mkdir), `DirectoryPicker.tsx` (New Folder button), `use-create-agent.ts` (rename to `useInitAgent`), `use-palette-actions.ts` (Create Agent action), `OnboardingFlow.tsx` (insert DorkBot step), `config-schema.ts` (agents.defaultDirectory), `mesh-schemas.ts` (CreateAgentRequest changes)
- **Indirect (may need updates):** All callers of `useCreateAgent()` hook (rename to `useInitAgent`), `HttpTransport` and `DirectTransport` adapters
- **Tests:** New tests for creation pipeline, directory creation, template download, DorkBot scaffolding, onboarding step

## 4) Root Cause Analysis

_Not applicable — this is a new feature, not a bug fix._

## 5) Research

### 5.1 Template Download Engine

**Approach 1: git clone --depth 1 + cleanup (Preferred)**

- Description: Use the git CLI for template downloads with shallow clone, then remove `.git/`
- Pros: Native progress events (parseable stderr), no npm dependency, developers have git, well-understood
- Cons: Requires git installed, no subdirectory support (must clone full repo), need to parse progress output
- Complexity: Low
- Maintenance: Low (git CLI is stable)

**Approach 2: giget (Fallback)**

- Description: Pure JS template downloader via tarball. Powers Nuxt's `nuxi init`
- Pros: No git dependency, subdirectory support (`github:org/repo/subdir`), built-in disk cache, pure JS
- Cons: No progress callbacks, no cancellation, generic error messages (must classify by string matching), adds npm dependency
- Complexity: Low
- Maintenance: Medium (dependency to track)

**Decision: Support both.** Try `git clone --depth 1` first (better UX with real progress). Fall back to giget if git isn't available. The git path covers 99%+ of DorkOS users (all developers). The giget fallback ensures templates work in constrained environments.

### 5.2 DorkOS Knowledge Architecture

The key design question: **who owns AGENTS.md?** The user does. They're supposed to edit it — that's how Claude Code works. Putting DorkOS knowledge there creates mixed ownership and confusion about what's safe to delete. This led to a two-layer approach.

**Decision: System prompt injection (primary) + compact AGENTS.md (fallback).**

#### Layer 1: System Prompt Injection (Primary)

A new `dorkosKnowledge` convention toggle alongside existing `soulEnabled` / `nopeEnabled`. When enabled, the context builder injects a `<dorkos_context>` block into the system prompt:

```xml
<dorkos_context>
DorkOS is the operating system for autonomous AI agents.
Subsystems: Console (chat), Pulse (scheduling), Relay (messaging), Mesh (discovery).
Documentation: https://dorkos.ai/llms.txt
Full docs: https://dorkos.ai/docs
</dorkos_context>
```

This is the durable, always-available mechanism:

- Follows the exact convention file pattern already in place (SOUL.md, NOPE.md injection)
- Can't be accidentally deleted by user editing AGENTS.md
- Toggleable per agent in settings (default: ON for all agents)
- Ships with the DorkOS server — updates when DorkOS upgrades, never goes stale
- Works for ALL agents, not just DorkBot — any agent running through DorkOS can understand "schedule this every 6 hours" or "send a relay message"

#### Layer 2: DorkBot's AGENTS.md (CLI Fallback)

DorkBot's AGENTS.md stays compact (~15 lines). It tells DorkBot what it is and provides llms.txt as a CLI fallback for when the user runs `claude` directly in DorkBot's directory (outside DorkOS runtime):

```markdown
# DorkBot — DorkOS Default Agent

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
```

AGENTS.md is the user's space — they can edit, extend, or replace it. The DorkOS knowledge injection via system prompt is the stable foundation that persists regardless.

#### Why This Over Alternatives

| Approach                 | Works in DorkOS | Works in CLI      | Durable                       | Stays Current               |
| ------------------------ | --------------- | ----------------- | ----------------------------- | --------------------------- |
| System prompt injection  | Yes             | No                | Yes (can't be deleted)        | Yes (ships with server)     |
| Inline AGENTS.md         | Yes             | Yes               | No (user may edit/delete)     | No (baked at scaffold time) |
| @-file reference         | Yes             | Yes               | Fragile (user may remove ref) | No (local file, stales)     |
| **Both layers (chosen)** | **Yes**         | **Yes (partial)** | **Yes (primary layer)**       | **Yes (primary layer)**     |

This follows Anthropic's own guidance that AGENTS.md files under 80 lines are most effective. The system prompt injection handles depth; AGENTS.md handles identity.

### 5.3 Onboarding Personality UX (Animation Patterns)

**Crossfade preview text:** `AnimatePresence mode="wait"` with a `key` prop tied to the preview text hash. Combined with `y: 4` enter / `y: -4` exit transitions for a "content updating" feel. Use `useDeferredValue` on traits state to debounce triggers during rapid slider scrubbing.

**Avatar breathing:** CSS-only animation (compositor thread, zero JS cost). 3s idle cycle that speeds to 0.8s via a `.reacting` class applied while the user drags any slider.

**Onboarding → chat transition:** Motion `layoutId` on the preview bubble. When onboarding completes, the preview bubble morphs into DorkBot's first chat message. Requires `LayoutGroup` wrapping both onboarding and chat views. This is the "magic moment" — the agent is born in onboarding and the chat is its first breath.

### 5.4 Filesystem Security

**Name validation:** Kebab-case regex `/^[a-z][a-z0-9-]{0,62}[a-z0-9]$|^[a-z]$/` applied before any filesystem operation. Rejects path traversal characters, unicode, spaces, dots.

**Path boundary:** Existing `PathValidator` class handles traversal prevention. Agent directories must resolve within the configured `agents.defaultDirectory` or an explicitly user-selected path that passes boundary validation.

**Atomicity:** If any step after mkdir fails (template download, file scaffolding), roll back by deleting the partially created directory. Clean error → user retries. No orphan directories.

### 5.5 giget Error Handling (Fallback Path)

giget throws generic `Error` objects. DorkOS must classify errors by message string matching into: `NETWORK_ERROR`, `AUTH_ERROR`, `NOT_FOUND`, `DIRECTORY_EXISTS`, `DISK_FULL`. The error wrapper should map each to a user-friendly message.

Add a 30-second `Promise.race()` timeout — giget can silently hang on large templates.

For DorkBot specifically (blank template), use `offline: true` to skip network entirely.

## 6) Decisions

| #   | Decision                      | Choice                                                           | Rationale                                                                                                                                                                                                                                              |
| --- | ----------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | DorkOS knowledge architecture | System prompt injection (primary) + compact AGENTS.md (fallback) | AGENTS.md is the user's space — DorkOS knowledge belongs in DorkOS-managed infrastructure. New `dorkosKnowledge` convention toggle (default ON for all agents) injects `<dorkos_context>` block. DorkBot's AGENTS.md stays ~15 lines for CLI fallback. |
| 2   | Template download engine      | git clone --depth 1 (preferred) + giget (fallback)               | Git gives real progress events for better download UX. Developers have git installed. Giget fallback covers edge cases where git isn't available.                                                                                                      |
| 3   | Template download UX          | Real progress bar (git) / indeterminate spinner (giget fallback) | Git's `--progress` stderr output can be parsed for % complete. When falling back to giget, show honest indeterminate spinner with 30s timeout.                                                                                                         |
| 4   | Creation failure handling     | Rollback — delete partially created directory                    | Simplest mental model. User gets a clean error and can retry. No orphan directories, no sentinel files, no "incomplete" states to manage.                                                                                                              |
| 5   | Personality preview animation | AnimatePresence mode="wait" + useDeferredValue                   | Crossfade text on slider change with debounced state. CSS-only avatar breathing. layoutId for onboarding→chat transition.                                                                                                                              |
| 6   | Template catalog hosting      | External GitHub repos (from brief)                               | No DorkOS-owned template monorepo for now. Templates point to third-party repos directly. Revisit if template quality becomes an issue.                                                                                                                |
| 7   | Private repo auth             | GITHUB_TOKEN env → gh auth token fallback (from brief)           | Standard developer workflow. No settings UI in v1.                                                                                                                                                                                                     |
| 8   | Template post-install hooks   | No auto-run, user prompt (from brief)                            | Security over convenience. "This template has a setup script. Run it?"                                                                                                                                                                                 |
| 9   | Naming collision              | 409 Conflict, no auto-suffix (from brief)                        | Explicit is better. UI pre-validates inline before creation.                                                                                                                                                                                           |
| 10  | Personality preview method    | Static templates, no LLM calls (from brief)                      | Each trait × level has a pre-written preview string. Instant feedback > authenticity.                                                                                                                                                                  |
