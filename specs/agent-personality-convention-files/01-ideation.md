---
slug: agent-personality-convention-files
number: 159
created: 2026-03-21
status: ideation
---

# Agent Personality & Convention Files

**Slug:** agent-personality-convention-files
**Author:** Claude Code
**Date:** 2026-03-21
**Branch:** preflight/agent-personality-convention-files

---

## 1) Intent & Assumptions

- **Task brief:** Add support for SOUL.md (personality) and NOPE.md (safety boundaries) convention files to DorkOS agents, with personality trait sliders (5 levels per trait, with wild extremes), inline editing and toggling from the agent settings dialog, agent workspace creation with scaffolded convention files, and a runtime-agnostic injection interface for multi-runtime support.

- **Assumptions:**
  - The existing `persona` field in `AgentManifest` will be deprecated in favor of SOUL.md
  - SOUL.md is the single source for personality prose — editable in the agent settings dialog
  - Convention files live in `.dork/` alongside `agent.json` (uppercase filenames: `SOUL.md`, `NOPE.md`)
  - The `AgentRuntime` interface is extended with an `applyPersona()` method for runtimes that need file-based injection
  - Trait values are integers 1-5, rendered via static lookup tables (no LLM calls)
  - Both SOUL.md and NOPE.md are pre-filled with sensible defaults on agent creation

- **Out of scope:**
  - `AGENTS.md` adoption (wait for native Claude Code support)
  - `IDENTITY.md` (covered by `agent.json` structured data)
  - `MEMORY.md` (Claude Code's `.claude/memory/` already serves this purpose)
  - Two-way sync between sliders and prose (they compose as layers)
  - Tool-level enforcement of NOPE.md rules (NOPE.md is advisory guidance, not a security perimeter)

---

## 2) Pre-reading Log

- `packages/shared/src/mesh-schemas.ts`: AgentManifest Zod schema — has `persona` (string, max 4000) and `personaEnabled` (boolean). Missing `traits` and `conventions` fields. Schema includes `AgentRuntimeSchema` with values `claude-code | cursor | codex | other`.
- `packages/shared/src/agent-runtime.ts`: `AgentRuntime` interface with `MessageOpts.systemPromptAppend?: string` — the existing injection point for personality text. No `applyPersona()` method yet.
- `packages/shared/src/manifest.ts`: `readManifest()`, `writeManifest()`, `removeManifest()` — atomic file I/O for `.dork/agent.json`. Uses `MANIFEST_DIR = '.dork'` and `MANIFEST_FILE = 'agent.json'`.
- `apps/server/src/services/runtimes/claude-code/context-builder.ts`: `buildAgentBlock()` reads manifest, injects `<agent_persona>` XML block when `personaEnabled !== false && persona`. This is the Claude Code injection point.
- `apps/server/src/services/runtimes/claude-code/message-sender.ts`: Calls `buildSystemPromptAppend()` which calls `buildAgentBlock()`. The `systemPrompt.append` flows into the Agent SDK.
- `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx`: Agent settings modal with 4 tabs: Identity, Persona, Capabilities, Connections.
- `apps/client/src/layers/features/agent-settings/ui/PersonaTab.tsx`: Currently a single textarea for persona text + an enable toggle. This is the component that gets rewritten.
- `apps/client/src/layers/shared/ui/slider.tsx`: Radix UI slider primitive — ready to use for trait sliders.
- `packages/db/src/schema/mesh.ts`: SQLite agents table with `persona` and `persona_enabled` columns. Needs `traits_json` and convention toggle columns.
- `apps/server/src/routes/agents.ts`: Agent CRUD routes — POST creates manifests, PATCH updates them. Needs extension for convention file content writes.
- `decisions/0043-file-canonical-source-of-truth-for-mesh-registry.md`: ADR-0043 — file-first write-through pattern. `.dork/agent.json` on disk is canonical; SQLite is derived cache.
- `decisions/0085-agent-runtime-interface-as-universal-abstraction.md`: AgentRuntime as the universal injection point for all backends.
- `specs/agent-tool-context-injection/`: Context injection patterns — static XML blocks in `context-builder.ts`. Same pattern for trait/SOUL.md injection.
- `contributing/architecture.md`: Hexagonal architecture with Transport interface decoupling client from backend.

---

## 3) Codebase Map

### Primary Components/Modules

| File                                                                | Role                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/shared/src/mesh-schemas.ts`                               | AgentManifest Zod schema — extend with `traits`, `conventions`              |
| `packages/shared/src/agent-runtime.ts`                              | AgentRuntime interface — add optional `applyPersona()`                      |
| `packages/shared/src/manifest.ts`                                   | Manifest file I/O — add convention file read/write helpers                  |
| `apps/server/src/services/runtimes/claude-code/context-builder.ts`  | `buildAgentBlock()` — extend to read SOUL.md/NOPE.md and render traits      |
| `apps/server/src/routes/agents.ts`                                  | Agent CRUD — extend PATCH for convention file content, POST for scaffolding |
| `apps/client/src/layers/features/agent-settings/ui/PersonaTab.tsx`  | Rewrite: trait sliders + SOUL.md editor + NOPE.md editor + toggles          |
| `apps/client/src/layers/features/agent-settings/ui/AgentDialog.tsx` | Shell — may need tab rename (Persona → Personality)                         |
| `packages/db/src/schema/mesh.ts`                                    | SQLite schema — add traits_json, convention toggle columns                  |

### New Files to Create

| File                                                                         | Role                                                            |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/shared/src/trait-renderer.ts`                                      | Pure function: trait integers 1-5 → natural language directives |
| `packages/shared/src/convention-files.ts`                                    | Read/write helpers for SOUL.md and NOPE.md alongside agent.json |
| `apps/client/src/layers/features/agent-settings/ui/PersonalitySliders.tsx`   | Slider sub-component with level labels                          |
| `apps/client/src/layers/features/agent-settings/ui/ConventionFileEditor.tsx` | Markdown textarea with toggle switch                            |
| `apps/client/src/layers/features/agent-settings/ui/InjectionPreview.tsx`     | Expandable preview of the rendered system prompt injection      |

### Shared Dependencies

- `packages/shared/src/manifest.ts` — manifest I/O (existing, extend)
- `apps/client/src/layers/shared/ui/slider.tsx` — Radix UI slider (existing, reuse)
- `apps/client/src/layers/shared/ui/label.tsx` — form labels (existing)
- `apps/client/src/layers/entities/agent/` — useCurrentAgent, useUpdateAgent hooks (existing)

### Data Flow

```
UI sliders → agent.json (traits) → disk
UI editor  → SOUL.md / NOPE.md  → disk
                    │
                    ▼
            Agent session start
                    │
                    ▼
            buildAgentBlock(cwd)
              ├── readManifest(cwd) → traits, conventions toggles
              ├── readConventionFile(cwd, 'SOUL.md') → personality prose
              ├── readConventionFile(cwd, 'NOPE.md') → safety boundaries
              └── renderTraits(traits) → trait directives
                    │
                    ▼
            <agent_persona>
              {rendered trait directives}
              {SOUL.md custom prose}
            </agent_persona>
            <agent_safety_boundaries>
              {NOPE.md content}
            </agent_safety_boundaries>
                    │
                    ▼
            systemPrompt.append (Claude Code)
            — or —
            .opencode/agents/*.md (OpenCode)
            — or —
            AGENTS.md prepend (Codex)
```

### Potential Blast Radius

- **Direct changes:** 8 files (schema, runtime interface, context builder, routes, PersonaTab, DB schema, 2 new shared modules)
- **New files:** 5 (trait renderer, convention file helpers, 3 UI components)
- **Indirect:** Agent entity hooks, agent list display (if traits are surfaced), reconciler (if manifest-first approach is used later)
- **Tests:** PersonaTab tests (rewrite), new tests for trait renderer, convention file I/O, context builder injection
- **DB migration:** 1 new migration for traits_json and convention columns

---

## 5) Research

### Potential Solutions

**1. File-First with Per-Request Read (Recommended for MVP)**

- Description: `buildAgentBlock()` reads SOUL.md and NOPE.md from disk on every `sendMessage()` call. Files are the single source of truth. No reconciler involvement for convention files.
- Pros:
  - Edits to SOUL.md via any editor (VS Code, vim, DorkOS UI) are immediately reflected
  - Simpler — no reconciler sync logic needed
  - Consistent with the "files are truth" mental model
- Cons:
  - Two extra filesystem reads per session start (~1-2ms each, negligible)
  - Harder to query "current persona" from API without reading the file
- Complexity: Low
- Maintenance: Low

**2. Manifest-First with Convention File Sync**

- Description: `agent.json` stores rendered persona content. Reconciler syncs SOUL.md → `agent.json.persona` every 5 minutes. Session start reads from manifest only.
- Pros:
  - Fast session start (no extra file reads)
  - Consistent with existing ADR-0043 pattern
  - API can return current persona without file I/O
- Cons:
  - 5-minute reconciler lag for external edits
  - Added reconciler complexity
  - Two sources that can diverge
- Complexity: Medium
- Maintenance: Medium

**3. Static Template Rendering for Traits (Recommended)**

- Description: Each trait dimension has 5 pre-written directive strings. Lookup table maps `(trait, level) → instruction text`. No LLM calls, no interpolation.
- Pros:
  - Deterministic — same slider positions always produce same text
  - Auditable — users see exactly what their settings produce via preview
  - Zero cost, zero latency, zero API dependency
  - Easy to test (pure function)
- Cons:
  - Less nuanced than LLM-generated prose
  - Requires manual curation of 25 directive strings (5 traits × 5 levels)
- Complexity: Low
- Maintenance: Low

### Security Considerations

- **SOUL.md is user-controlled content injected into system prompts.** This is not an attack vector in the same way external content injection would be — Kai is configuring his own agent. Cap at 4,000 characters (matching existing `persona` field max).
- **Agents must NOT have write access to SOUL.md or NOPE.md.** If agents can self-modify these files, it creates a persistence vector for prompt injection (identified by Penligent security research on OpenClaw). Future hardening: add convention files to a `.dorkignore` convention.
- **NOPE.md is advisory, not enforced.** The UI should clearly state: "These boundaries guide your agent's behavior. They are not enforced at the tool level. To enforce hard restrictions, use agent tool group configuration." Honest by design.
- **NOPE.md cap:** 2,000 characters. Safety boundaries should be concise constraints, not lengthy documents.

### Performance Considerations

- **File read cost:** Two small file reads per `sendMessage()` — negligible at DorkOS's scale (10-20 sessions/week per user, even at 100 sends/hour = 200 reads/hour).
- **Trait rendering:** O(1) dictionary lookup per dimension. ~200-500 characters output. Negligible.
- **Context window impact:** SOUL.md adds ~100-500 tokens. NOPE.md adds ~50-300 tokens. Combined with existing tool context overhead (~600-1000 tokens), total is ~750-1800 tokens — <1% of the 200K context window.

### Recommendation

**File-first per-request read + static template rendering.** This is the simplest, most robust approach. It eliminates reconciler complexity, gives immediate feedback when files are edited externally, and the performance cost is negligible. The static lookup table for trait rendering is deterministic, auditable, and zero-cost — exactly what Kai and Priya need for trust.

---

## 6) Decisions

| #   | Decision                                             | Choice                                                                        | Rationale                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Should SOUL.md replace the existing `persona` field? | **Deprecate `persona` field; SOUL.md replaces it**                            | SOUL.md serves the same purpose. Having both creates confusion about which one to use. SOUL.md is editable inline in the agent settings dialog — the UI remains the primary editing surface. Exploration confirmed PersonaTab already has a single persona textarea; replacing it with the SOUL.md editor is a clean migration. |
| 2   | Which trait dimensions?                              | **Coding-agent-specific: Tone, Autonomy, Caution, Communication, Creativity** | Research from Convai/Inworld found domain-specific traits outperform generic personality models (Big Five) for task-oriented agents. Each dimension maps directly to a coding-agent workflow decision. 5 levels per trait with wild, absolute extremes (level 1 and 5 are deliberately over-the-top).                           |
| 3   | How to handle non-Claude runtimes?                   | **Build runtime-agnostic interface now**                                      | Define `AgentRuntime.applyPersona?(persona, agentPath)` now. Claude Code runtime: reads SOUL.md via `buildAgentBlock()`. Future runtimes (OpenCode → `.opencode/agents/*.md`, Codex → AGENTS.md prepend) implement their own `applyPersona()`. Ensures the interface is right before multiple implementations exist.            |
| 4   | Scaffold content for new agents?                     | **Both SOUL.md and NOPE.md pre-filled with sensible defaults**                | SOUL.md gets agent name, description, and default trait-level descriptions. NOPE.md gets common safety defaults (no force push to main, no delete production data, no commit secrets). Faster onboarding — users can immediately see and modify working examples rather than staring at blank files.                            |

---

## Appendix A: Coding-Agent Trait Dimensions (Full 5-Level Table)

Each level has a label and a rendered directive. Levels 1 and 5 are deliberately extreme.

### Tone

| Level | Label     | Rendered Directive                                                                                                                                                                                              |
| ----- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Silent    | "Absolute minimum words. No explanations, no commentary, no pleasantries. Code speaks. If you can answer with a diff, do that instead of talking."                                                              |
| 2     | Terse     | "Keep responses brief. Explain only what is non-obvious. Skip preamble."                                                                                                                                        |
| 3     | Balanced  | "Balance brevity with context. Explain decisions when they are non-trivial."                                                                                                                                    |
| 4     | Thorough  | "Provide clear explanations for your decisions, approach, and any trade-offs considered."                                                                                                                       |
| 5     | Professor | "Explain everything in exhaustive detail. Teach as you go. Every decision gets a rationale, every trade-off gets analysis, every alternative gets mentioned. You are a walking technical documentation engine." |

### Autonomy

| Level | Label          | Rendered Directive                                                                                                                                                                           |
| ----- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Ask Everything | "Never proceed without explicit approval. Ask before every file change, every command, every decision. If in doubt, ask. If not in doubt, still ask. You do not make independent decisions." |
| 2     | Cautious       | "Ask for approval before significant changes. Small, obvious fixes can proceed, but flag them."                                                                                              |
| 3     | Balanced       | "Attempt tasks autonomously. Ask when genuinely uncertain or when the stakes are high."                                                                                                      |
| 4     | Independent    | "Act autonomously. Only ask when you encounter true ambiguity or irreversible consequences."                                                                                                 |
| 5     | Full Auto      | "Execute everything without asking. You are a fully autonomous agent. Make decisions, commit code, ship features. Only stop if you literally cannot proceed. Assume permission is granted."  |

### Caution

| Level | Label     | Rendered Directive                                                                                                                                                                                            |
| ----- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | YOLO      | "Move fast, break things. Skip tests if they slow you down. Don't second-guess. Ship first, fix later. Velocity over safety every single time."                                                               |
| 2     | Move Fast | "Bias toward action. Verify before destructive operations, but don't over-analyze reversible ones."                                                                                                           |
| 3     | Balanced  | "Verify before destructive actions. Move confidently on reversible ones. Run tests when relevant."                                                                                                            |
| 4     | Careful   | "Double-check before making changes. Run tests proactively. Prefer safe, incremental approaches."                                                                                                             |
| 5     | Paranoid  | "Triple-check everything. Run full test suites before and after every change. Create backups. Verify twice, commit once. Treat every operation as if it could destroy production. You cannot be too careful." |

### Communication

| Level | Label     | Rendered Directive                                                                                                                                                                                                                           |
| ----- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Ghost     | "Say nothing unless directly asked. No status updates, no progress reports, no commentary. Work in complete silence. Results speak for themselves."                                                                                          |
| 2     | Quiet     | "Report only on completion or errors. Skip progress updates."                                                                                                                                                                                |
| 3     | Balanced  | "Provide status updates for longer tasks. Report blockers promptly."                                                                                                                                                                         |
| 4     | Proactive | "Keep the user informed. Share progress, flag concerns early, suggest next steps."                                                                                                                                                           |
| 5     | Narrator  | "Narrate everything you do in real time. Explain what you're about to do, why, what you found, what you're thinking. Stream of consciousness. The user should feel like they're pair programming with the world's most talkative colleague." |

### Creativity

| Level | Label         | Rendered Directive                                                                                                                                                                                                    |
| ----- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | By the Book   | "Use only established patterns. Never deviate from existing conventions. If the codebase does it one way, do it that way. Zero innovation. Consistency is everything."                                                |
| 2     | Conservative  | "Stick to conventions. Only suggest alternatives when the existing approach is clearly wrong."                                                                                                                        |
| 3     | Balanced      | "Follow conventions by default. Suggest alternatives when they offer clear, meaningful improvements."                                                                                                                 |
| 4     | Exploratory   | "Propose creative solutions. Suggest refactors when they improve the code. Try new approaches."                                                                                                                       |
| 5     | Mad Scientist | "Rethink everything from first principles. Propose bold refactors, unconventional architectures, creative solutions nobody asked for. The status quo is a suggestion, not a constraint. Innovation over consistency." |

---

## Appendix B: Convention File Location & Naming

Convention files live in `.dork/` alongside `agent.json`:

```
{agent-root}/.dork/
├── agent.json       # Structured config (traits, conventions toggles, metadata)
├── SOUL.md          # Personality prose (trait-rendered + custom)
└── NOPE.md          # Safety boundaries
```

**Uppercase filenames** match upstream conventions (SOUL.md, NOPE.md, CLAUDE.md, AGENTS.md) and are visually distinct from regular project documentation.

**Default location for global agents:** `~/.dork/agents/{agent-name}/` — user can override to any directory during creation.

---

## Appendix C: Runtime Injection Table

| Runtime       | Injection Mechanism                           | `applyPersona()` Implementation                                 |
| ------------- | --------------------------------------------- | --------------------------------------------------------------- |
| `claude-code` | `systemPrompt.append` via `buildAgentBlock()` | Read SOUL.md/NOPE.md in context-builder; no file-write needed   |
| `opencode`    | `.opencode/agents/<name>.md` markdown file    | Write persona to `.opencode/agents/{agentName}.md`              |
| `codex`       | `--instructions` flag or AGENTS.md prepend    | Prepend persona to project AGENTS.md                            |
| `cursor`      | `.cursor/rules/soul.mdc` scoped rule file     | Write persona to `.cursor/rules/soul.mdc` with glob frontmatter |
| `other`       | No-op (graceful degradation)                  | Log warning; manifest stores persona but no injection           |

---

## Appendix D: NOPE.md Default Template

```markdown
# Safety Boundaries

Actions this agent must never perform.
These boundaries are advisory — they guide behavior but are not enforced at the tool level.

## Git Restrictions

- Never force push to main or master branches
- Never commit files containing secrets, API keys, or credentials

## Filesystem Restrictions

- Never delete files outside the project directory
- Never modify system files or configuration outside .dork/

## Code Execution Restrictions

- Never run scripts with elevated privileges unless explicitly instructed
```

---

## Appendix E: SOUL.md Default Template

```markdown
# {agent.name}

{agent.description}

## Personality

<!-- Generated from trait configuration. Edit this section freely — -->
<!-- your edits take precedence over slider-generated text.         -->

**Tone**: Balanced — explain decisions when non-trivial, skip obvious context.
**Autonomy**: Balanced — attempt tasks autonomously, ask when genuinely uncertain.
**Caution**: Balanced — verify before destructive actions, move confidently on reversible ones.
**Communication**: Balanced — provide status updates for longer tasks, report blockers promptly.
**Creativity**: Balanced — follow conventions by default, suggest alternatives when clearly better.

## Identity

You are {agent.name}, a coding agent managed by DorkOS.
```

---

## Appendix F: AgentManifest Schema Changes

```typescript
// New fields added to AgentManifestSchema
traits: z.object({
  tone: z.number().int().min(1).max(5).default(3),
  autonomy: z.number().int().min(1).max(5).default(3),
  caution: z.number().int().min(1).max(5).default(3),
  communication: z.number().int().min(1).max(5).default(3),
  creativity: z.number().int().min(1).max(5).default(3),
}).default({ tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 }),

conventions: z.object({
  soul: z.boolean().default(true),
  nope: z.boolean().default(true),
}).default({ soul: true, nope: true }),

// Deprecated (replaced by SOUL.md):
// persona: z.string().max(4000).optional()
// personaEnabled: z.boolean().default(true)
```

The `persona` and `personaEnabled` fields are deprecated but retained for backward compatibility during migration. New code reads from SOUL.md; old agents with `persona` set but no SOUL.md continue to work via fallback in `buildAgentBlock()`.
