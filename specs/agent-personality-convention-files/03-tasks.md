# Task Breakdown: Agent Personality & Convention Files

Generated: 2026-03-22
Source: specs/agent-personality-convention-files/02-specification.md
Last Decompose: 2026-03-22

## Overview

Add SOUL.md (personality) and NOPE.md (safety boundaries) convention files to DorkOS agents. Replace the existing bare `persona` text field with a structured, toggleable, multi-layer personality system. Users configure agents through 5 trait sliders (Tone, Autonomy, Caution, Communication, Creativity), inline markdown editors for SOUL.md and NOPE.md, and a live injection preview -- all from a single "Personality" tab in the agent settings dialog.

Convention files live in `.dork/` alongside `agent.json`, are read from disk on every `sendMessage`, and injected into the system prompt via the existing context builder. Existing agents with a `persona` field are auto-migrated to SOUL.md on first access.

## Phase 1: Foundation

### Task 1.1: Add TraitsSchema, ConventionsSchema, and updated request schemas to mesh-schemas.ts

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2, 1.3, 1.4, 1.5

**Technical Requirements**:

- Add `TraitsSchema` (5 integer fields, 1-5, default 3) and `ConventionsSchema` (2 boolean fields, default true) to `packages/shared/src/mesh-schemas.ts`
- Extend `AgentManifestSchema` with optional `traits` and `conventions` fields
- Extend `UpdateAgentRequestSchema` pick list to include `traits` and `conventions`
- Create `UpdateAgentConventionsSchema` for convention file content in PATCH requests

**Acceptance Criteria**:

- [ ] Schemas validate correctly with OpenAPI metadata
- [ ] Types exported: `Traits`, `Conventions`, `UpdateAgentConventions`
- [ ] Existing manifests without new fields still parse (optional fields)
- [ ] `pnpm typecheck` passes

---

### Task 1.2: Create trait-renderer.ts with static lookup table and renderTraits()

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.3, 1.4, 1.5

**Technical Requirements**:

- Create `packages/shared/src/trait-renderer.ts` with 5x5 static lookup table (25 entries)
- Export `TRAIT_LEVELS`, `DEFAULT_TRAITS`, `TRAIT_ORDER`, `renderTraits()`, types
- Add subpath export `./trait-renderer` to `packages/shared/package.json`
- Pure module, no external dependencies, deterministic output

**Acceptance Criteria**:

- [ ] All 25 trait/level entries have non-empty `label` and `directive`
- [ ] `renderTraits()` produces correct markdown bullet list
- [ ] Missing traits default to level 3
- [ ] Unit tests pass (all combinations, edge cases)

---

### Task 1.3: Create convention-files.ts with read/write helpers and templates

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2, 1.4, 1.5

**Technical Requirements**:

- Create `packages/shared/src/convention-files.ts` with read/write helpers, SOUL.md builder, prose extractor, default templates
- Character limits: SOUL_MAX_CHARS = 4000, NOPE_MAX_CHARS = 2000
- Trait section markers: `<!-- TRAITS:START -->` / `<!-- TRAITS:END -->`
- Add subpath export `./convention-files` to `packages/shared/package.json`

**Acceptance Criteria**:

- [ ] `readConventionFile()` reads from `.dork/`, returns null on not found
- [ ] `writeConventionFile()` writes to `.dork/`
- [ ] `buildSoulContent()` creates correct structure with markers
- [ ] `extractCustomProse()` correctly extracts text after markers
- [ ] Default templates include expected content
- [ ] Unit tests pass

---

### Task 1.4: Add traits_json and conventions_json columns to DB schema

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2, 1.3, 1.5

**Technical Requirements**:

- Add `traitsJson` (nullable text) and `conventionsJson` (nullable text) columns to `agents` table in `packages/db/src/schema/mesh.ts`
- These are derived cache columns (file is canonical per ADR-0043)

**Acceptance Criteria**:

- [ ] Both columns added as nullable text
- [ ] Existing columns unchanged
- [ ] `pnpm typecheck` passes

---

### Task 1.5: Add optional applyConventions method to AgentRuntime interface

**Size**: Small
**Priority**: Medium
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2, 1.3, 1.4

**Technical Requirements**:

- Add optional `applyConventions?(persona, safetyBoundaries, agentPath)` to `AgentRuntime` interface in `packages/shared/src/agent-runtime.ts`
- Method is for future multi-runtime support; Claude Code uses context builder directly

**Acceptance Criteria**:

- [ ] Optional method added with TSDoc
- [ ] Existing implementations not broken
- [ ] `pnpm typecheck` passes

---

## Phase 2: Server Integration

### Task 2.1: Extend buildAgentBlock() to read convention files and render traits

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, 1.2, 1.3
**Can run parallel with**: Task 2.2

**Technical Requirements**:

- Modify `buildAgentBlock()` in `apps/server/src/services/runtimes/claude-code/context-builder.ts`
- Read SOUL.md, regenerate trait section with current values, inject as `<agent_persona>`
- Read NOPE.md, inject as `<agent_safety_boundaries>`
- Respect convention toggles (`conventions.soul`, `conventions.nope`)
- Fall back to legacy `persona` field when no SOUL.md exists
- Injection order: identity -> persona -> safety boundaries

**Acceptance Criteria**:

- [ ] SOUL.md injected as `<agent_persona>` with regenerated trait section
- [ ] NOPE.md injected as `<agent_safety_boundaries>`
- [ ] Convention toggles suppress injection when false
- [ ] Legacy persona fallback works
- [ ] Integration tests pass
- [ ] Existing context builder tests still pass

---

### Task 2.2: Extend agent routes for convention file CRUD and migration

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1, 1.2, 1.3
**Can run parallel with**: Task 2.1

**Technical Requirements**:

- POST (create agent): scaffold SOUL.md and NOPE.md with default templates
- GET: return `soulContent` and `nopeContent` alongside manifest
- PATCH: accept and write `soulContent`, `nopeContent`, `traits`, `conventions`
- New migration endpoint: POST `/api/agents/current/migrate-persona`

**Acceptance Criteria**:

- [ ] Agent creation scaffolds both convention files
- [ ] GET returns convention file contents
- [ ] PATCH writes convention files and manifest fields
- [ ] Migration converts persona to SOUL.md, scaffolds NOPE.md
- [ ] Integration tests pass
- [ ] Existing route tests still pass

---

## Phase 3: Client UI

### Task 3.1: Create PersonalitySliders component

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, 1.2
**Can run parallel with**: Task 3.2, 3.3

**Technical Requirements**:

- 5 discrete Radix UI sliders (min=1, max=5, step=1) in `agent-settings` feature
- Each shows trait name, current level label (e.g., "3/5 Balanced")
- Uses shared `Slider` and `Label` components

**Acceptance Criteria**:

- [ ] 5 sliders with correct labels and accessible aria-labels
- [ ] Level labels update on slider change
- [ ] `onChange` called with updated traits object
- [ ] Component tests pass

---

### Task 3.2: Create ConventionFileEditor component

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 3.1, 3.3

**Technical Requirements**:

- Reusable markdown textarea editor with toggle switch, character count, optional disclaimer
- Used for both SOUL.md and NOPE.md
- When toggled off: visually dimmed but still editable

**Acceptance Criteria**:

- [ ] Toggle, textarea, character count render correctly
- [ ] Dimmed when disabled
- [ ] NOPE.md variant shows disclaimer
- [ ] Component tests pass

---

### Task 3.3: Create InjectionPreview component

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, 1.2, 1.3
**Can run parallel with**: Task 3.1, 3.2

**Technical Requirements**:

- Expandable/collapsible monospace preview of rendered system prompt injection
- Shows identity + SOUL.md + NOPE.md with XML block markers
- Respects toggle states, updates live on trait/content changes

**Acceptance Criteria**:

- [ ] Collapsed by default with expand/collapse toggle
- [ ] Shows combined XML output when expanded
- [ ] Respects convention toggles
- [ ] `aria-expanded` attribute for accessibility
- [ ] Component tests pass

---

### Task 3.4: Rewrite PersonaTab as PersonalityTab composing sliders, editors, and preview

**Size**: Large
**Priority**: High
**Dependencies**: Task 3.1, 3.2, 3.3
**Can run parallel with**: None

**Technical Requirements**:

- New `PersonalityTab.tsx` composing PersonalitySliders, ConventionFileEditor (x2), InjectionPreview
- Trait changes regenerate trait section in SOUL.md content
- Debounced text updates (500ms), immediate toggle updates
- Migration trigger for legacy agents (persona field, no SOUL.md)
- Delete old `PersonaTab.tsx` and `PersonaTab.test.tsx`

**Acceptance Criteria**:

- [ ] Four sections render in correct order
- [ ] Slider -> SOUL.md regeneration works
- [ ] Debounced saves for text, immediate for toggles
- [ ] Legacy migration triggers onMigrate callback
- [ ] Component tests pass

---

### Task 3.5: Update AgentDialog to use PersonalityTab and pass convention data

**Size**: Medium
**Priority**: High
**Dependencies**: Task 3.4, 2.2
**Can run parallel with**: None

**Technical Requirements**:

- Rename "Persona" tab to "Personality" in sidebar and panel header
- Import `PersonalityTab` instead of `PersonaTab`
- Pass `soulContent`/`nopeContent` from server response to PersonalityTab
- Wire up migration callback to migrate-persona endpoint
- Update barrel exports, delete old files

**Acceptance Criteria**:

- [ ] Sidebar shows "Personality" with Sparkles icon
- [ ] Convention data flows from server to PersonalityTab
- [ ] Update callback sends convention content to server
- [ ] Old PersonaTab files deleted
- [ ] Tests updated and passing
- [ ] `pnpm typecheck` passes

---

## Phase 4: Verification

### Task 4.1: End-to-end validation of full personality workflow

**Size**: Large
**Priority**: High
**Dependencies**: Task 3.5, 2.1, 2.2
**Can run parallel with**: None

**Technical Requirements**:

- Verify complete creation -> configuration -> injection workflow
- Verify legacy agent migration preserves persona text
- Verify `buildAgentBlock` overhead < 5ms
- Non-regression: all existing tests pass, typecheck, lint

**Acceptance Criteria**:

- [ ] Full workflow works end-to-end
- [ ] Trait changes reflected in SOUL.md and preview
- [ ] Convention files saved/loaded correctly
- [ ] Toggle states control injection
- [ ] Legacy migration works
- [ ] Performance under budget
- [ ] `pnpm test -- --run` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
