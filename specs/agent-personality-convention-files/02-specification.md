# Agent Personality & Convention Files

**Spec #159** | Status: Draft | Author: Claude Code | Date: 2026-03-21

---

## 1. Overview

Add SOUL.md (personality) and NOPE.md (safety boundaries) convention files to DorkOS agents, replacing the existing bare `persona` text field with a structured, toggleable, multi-layer personality system. Users configure agents through 5 trait sliders (Tone, Autonomy, Caution, Communication, Creativity), inline markdown editors for SOUL.md and NOPE.md, and a live injection preview — all from a single "Personality" tab in the agent settings dialog.

Convention files live in `.dork/` alongside `agent.json`, are read from disk on every `sendMessage`, and injected into the system prompt via a runtime-agnostic interface. Existing agents with a `persona` field are auto-migrated to SOUL.md on first access.

## 2. Background / Problem Statement

DorkOS agents currently have a bare `persona` text field with no structure, no safety boundary configuration, and no quick-tune controls. The broader AI agent ecosystem is converging on markdown convention files as standards — SOUL.md for personality (from the OpenClaw ecosystem and `aaronjmars/soul.md`), NOPE.md for safety boundaries (`nope-md.vercel.app`), and AGENTS.md as a cross-tool universal standard (Linux Foundation). DorkOS should adopt the conventions that matter while they're still early, giving users a familiar and portable agent configuration experience.

### Current State

- `agent.json` has `persona` (string, max 4000 chars) and `personaEnabled` (boolean)
- `buildAgentBlock()` in `context-builder.ts` reads the manifest and injects `<agent_persona>` via `systemPrompt.append`
- The `PersonaTab` in the agent settings dialog is a single textarea with an enable toggle
- No safety boundary mechanism exists
- No trait sliders or structured personality controls exist
- The `AgentRuntime` interface has `MessageOpts.systemPromptAppend?: string` but no convention file awareness

## 3. Goals

- Support SOUL.md and NOPE.md as first-class agent configuration files in `.dork/`
- Provide 5 personality trait sliders (Tone, Autonomy, Caution, Communication, Creativity) with 5 discrete levels each
- Replace the existing `persona` field with SOUL.md (deprecate, not coexist)
- Allow inline editing and toggling of convention files from the agent settings dialog
- Scaffold pre-filled SOUL.md and NOPE.md on agent creation
- Auto-migrate existing agents with `persona` text to SOUL.md on first access
- Build a runtime-agnostic injection interface (`applyPersona`) for multi-runtime support
- Provide a live injection preview showing exactly what the agent receives

## 4. Non-Goals

- Adopting AGENTS.md (Claude Code already reads CLAUDE.md; wait for native AGENTS.md support)
- Adopting IDENTITY.md (covered by `agent.json` structured identity fields)
- Adopting MEMORY.md (Claude Code's `.claude/memory/` already serves this purpose)
- Two-way sync between sliders and prose (they compose as layers, not mirror each other)
- Enforcing NOPE.md at the tool level (advisory only — guides behavior, not hard-blocked)
- Allowing agents to write to SOUL.md or NOPE.md (persistence attack prevention)
- LLM-based trait rendering (static template lookup only)

## 5. Technical Dependencies

- **Zod** (existing) — Schema validation for traits and conventions in `mesh-schemas.ts`
- **Radix UI Slider** (existing via shadcn/ui) — Discrete 5-position sliders
- **React 19** (existing) — Client components
- **TanStack Query** (existing) — Server state for agent data
- **Express** (existing) — API routes for convention file CRUD

No new external dependencies required.

## 6. Detailed Design

### 6.1 Data Model Changes

#### `packages/shared/src/mesh-schemas.ts`

Extend `AgentManifestSchema` with traits and conventions:

```typescript
/** Personality trait levels (1-5 scale) */
export const TraitsSchema = z.object({
  tone: z.number().int().min(1).max(5).default(3),
  autonomy: z.number().int().min(1).max(5).default(3),
  caution: z.number().int().min(1).max(5).default(3),
  communication: z.number().int().min(1).max(5).default(3),
  creativity: z.number().int().min(1).max(5).default(3),
});

/** Convention file injection toggles */
export const ConventionsSchema = z.object({
  soul: z.boolean().default(true),
  nope: z.boolean().default(true),
});

// Add to AgentManifestSchema:
traits: TraitsSchema.optional(),
conventions: ConventionsSchema.optional(),

// Deprecate (keep for migration, remove in future):
persona: z.string().max(4000).optional(),
personaEnabled: z.boolean().optional(),
```

Export types:

```typescript
export type Traits = z.infer<typeof TraitsSchema>;
export type Conventions = z.infer<typeof ConventionsSchema>;
```

#### `packages/db/src/schema/mesh.ts`

Add columns to the `agents` table:

```typescript
traits_json: text('traits_json'),       // JSON string of Traits
conventions_json: text('conventions_json'), // JSON string of Conventions
```

Existing `persona` and `persona_enabled` columns remain for migration period.

### 6.2 Trait Renderer

#### New file: `packages/shared/src/trait-renderer.ts`

Pure function with a static lookup table — 5 traits x 5 levels = 25 entries. No LLM calls. Deterministic output.

```typescript
export type TraitName = 'tone' | 'autonomy' | 'caution' | 'communication' | 'creativity';

export interface TraitLevel {
  label: string;
  directive: string;
}

export const TRAIT_LEVELS: Record<TraitName, Record<number, TraitLevel>> = {
  tone: {
    1: {
      label: 'Silent',
      directive:
        'Absolute minimum words. No explanations, no commentary. Code speaks. If you can answer with a diff, do that instead of talking.',
    },
    2: {
      label: 'Terse',
      directive: 'Keep responses brief. Explain only what is non-obvious. Skip preamble.',
    },
    3: {
      label: 'Balanced',
      directive: 'Balance brevity with context. Explain decisions when they are non-trivial.',
    },
    4: {
      label: 'Thorough',
      directive:
        'Provide clear explanations for your decisions, approach, and any trade-offs considered.',
    },
    5: {
      label: 'Professor',
      directive:
        'Explain everything in exhaustive detail. Teach as you go. Every decision gets a rationale, every trade-off gets analysis. You are a walking technical documentation engine.',
    },
  },
  autonomy: {
    1: {
      label: 'Ask Everything',
      directive:
        'Never proceed without explicit approval. Ask before every file change, every command, every decision. You do not make independent decisions.',
    },
    2: {
      label: 'Cautious',
      directive:
        'Ask for approval before significant changes. Small, obvious fixes can proceed, but flag them.',
    },
    3: {
      label: 'Balanced',
      directive:
        'Attempt tasks autonomously. Ask when genuinely uncertain or when the stakes are high.',
    },
    4: {
      label: 'Independent',
      directive:
        'Act autonomously. Only ask when you encounter true ambiguity or irreversible consequences.',
    },
    5: {
      label: 'Full Auto',
      directive:
        'Execute everything without asking. You are a fully autonomous agent. Make decisions, commit code, ship features. Assume permission is granted.',
    },
  },
  caution: {
    1: {
      label: 'YOLO',
      directive:
        'Move fast, break things. Skip tests if they slow you down. Ship first, fix later. Velocity over safety every single time.',
    },
    2: {
      label: 'Move Fast',
      directive:
        "Bias toward action. Verify before destructive operations, but don't over-analyze reversible ones.",
    },
    3: {
      label: 'Balanced',
      directive:
        'Verify before destructive actions. Move confidently on reversible ones. Run tests when relevant.',
    },
    4: {
      label: 'Careful',
      directive:
        'Double-check before making changes. Run tests proactively. Prefer safe, incremental approaches.',
    },
    5: {
      label: 'Paranoid',
      directive:
        'Triple-check everything. Run full test suites before and after every change. Create backups. Treat every operation as if it could destroy production.',
    },
  },
  communication: {
    1: {
      label: 'Ghost',
      directive:
        'Say nothing unless directly asked. No status updates, no progress reports. Work in complete silence.',
    },
    2: { label: 'Quiet', directive: 'Report only on completion or errors. Skip progress updates.' },
    3: {
      label: 'Balanced',
      directive: 'Provide status updates for longer tasks. Report blockers promptly.',
    },
    4: {
      label: 'Proactive',
      directive: 'Keep the user informed. Share progress, flag concerns early, suggest next steps.',
    },
    5: {
      label: 'Narrator',
      directive:
        "Narrate everything you do in real time. Stream of consciousness. The user should feel like they are pair programming with the world's most talkative colleague.",
    },
  },
  creativity: {
    1: {
      label: 'By the Book',
      directive:
        'Use only established patterns. Never deviate from existing conventions. Zero innovation. Consistency is everything.',
    },
    2: {
      label: 'Conservative',
      directive:
        'Stick to conventions. Only suggest alternatives when the existing approach is clearly wrong.',
    },
    3: {
      label: 'Balanced',
      directive:
        'Follow conventions by default. Suggest alternatives when they offer clear, meaningful improvements.',
    },
    4: {
      label: 'Exploratory',
      directive:
        'Propose creative solutions. Suggest refactors when they improve the code. Try new approaches.',
    },
    5: {
      label: 'Mad Scientist',
      directive:
        'Rethink everything from first principles. Propose bold refactors, unconventional architectures, creative solutions nobody asked for. Innovation over consistency.',
    },
  },
};

/** Default traits — all balanced */
export const DEFAULT_TRAITS: Record<TraitName, number> = {
  tone: 3,
  autonomy: 3,
  caution: 3,
  communication: 3,
  creativity: 3,
};

/** Ordered list of trait names for consistent rendering */
export const TRAIT_ORDER: TraitName[] = [
  'tone',
  'autonomy',
  'caution',
  'communication',
  'creativity',
];

/**
 * Render trait integers into a natural language personality block.
 * Returns the "## Personality Traits" section content.
 */
export function renderTraits(traits: Record<TraitName, number>): string {
  const lines = TRAIT_ORDER.map((name) => {
    const level = traits[name] ?? 3;
    const entry = TRAIT_LEVELS[name][level];
    return `- **${capitalize(name)}** (${entry.label}): ${entry.directive}`;
  });
  return lines.join('\n');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
```

### 6.3 Convention File Helpers

#### New file: `packages/shared/src/convention-files.ts`

Read/write SOUL.md and NOPE.md alongside agent.json in `.dork/`:

```typescript
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { MANIFEST_DIR } from './manifest.js';

export const CONVENTION_FILES = {
  soul: 'SOUL.md',
  nope: 'NOPE.md',
} as const;

export const SOUL_MAX_CHARS = 4000;
export const NOPE_MAX_CHARS = 2000;

/** Marker separating auto-generated traits from custom prose */
export const TRAIT_SECTION_START = '<!-- TRAITS:START -->';
export const TRAIT_SECTION_END = '<!-- TRAITS:END -->';

/**
 * Read a convention file from disk. Returns null if not found.
 */
export async function readConventionFile(
  projectPath: string,
  filename: 'SOUL.md' | 'NOPE.md'
): Promise<string | null> {
  try {
    const filePath = join(projectPath, MANIFEST_DIR, filename);
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Write a convention file to disk.
 */
export async function writeConventionFile(
  projectPath: string,
  filename: 'SOUL.md' | 'NOPE.md',
  content: string
): Promise<void> {
  const filePath = join(projectPath, MANIFEST_DIR, filename);
  await writeFile(filePath, content, 'utf-8');
}

/**
 * Build a SOUL.md with auto-generated trait section + custom prose.
 * The trait section is delimited by HTML comments and auto-regenerated
 * on every slider change. Custom prose below is never touched.
 */
export function buildSoulContent(traitBlock: string, customProse: string): string {
  const parts = [TRAIT_SECTION_START, '## Personality Traits\n', traitBlock, TRAIT_SECTION_END];

  if (customProse.trim()) {
    parts.push('', customProse.trim());
  }

  return parts.join('\n');
}

/**
 * Extract the custom prose section from a SOUL.md file,
 * preserving everything after the TRAITS:END marker.
 */
export function extractCustomProse(soulContent: string): string {
  const endIndex = soulContent.indexOf(TRAIT_SECTION_END);
  if (endIndex === -1) {
    // No trait section — entire content is custom prose
    return soulContent;
  }
  return soulContent.slice(endIndex + TRAIT_SECTION_END.length).trim();
}

/**
 * Default SOUL.md template for new agents.
 */
export function defaultSoulTemplate(agentName: string, traitBlock: string): string {
  const customProse = [
    '## Identity',
    '',
    `You are ${agentName}, a coding assistant.`,
    '',
    '## Values',
    '',
    '- Write clean, maintainable code',
    '- Respect existing patterns and conventions',
    '- Communicate clearly about trade-offs',
  ].join('\n');

  return buildSoulContent(traitBlock, customProse);
}

/**
 * Default NOPE.md template for new agents.
 */
export function defaultNopeTemplate(): string {
  return [
    '# Safety Boundaries',
    '',
    '## Never Do',
    '',
    '- Never push to main/master without explicit approval',
    '- Never delete production data or databases',
    '- Never commit secrets, API keys, or credentials',
    '- Never run destructive commands (rm -rf, DROP TABLE) without confirmation',
    '- Never modify CI/CD pipelines without review',
    '',
    '## Always Do',
    '',
    '- Always create a new branch for changes',
    '- Always run tests before committing',
    '- Always preserve existing functionality when refactoring',
  ].join('\n');
}
```

### 6.4 Runtime Interface Changes

#### `packages/shared/src/agent-runtime.ts`

Add optional `applyPersona` method to the `AgentRuntime` interface:

```typescript
export interface AgentRuntime {
  // ... existing methods ...

  /**
   * Apply personality and safety convention content to an agent session.
   * Called by the server before session start. Each runtime implements
   * its own injection mechanism.
   *
   * @param persona - Rendered SOUL.md content (traits + custom prose), or null if disabled
   * @param safetyBoundaries - NOPE.md content, or null if disabled
   * @param agentPath - Absolute path to the agent's working directory
   */
  applyConventions?(
    persona: string | null,
    safetyBoundaries: string | null,
    agentPath: string
  ): Promise<void>;
}
```

### 6.5 Context Builder Changes

#### `apps/server/src/services/runtimes/claude-code/context-builder.ts`

Extend `buildAgentBlock()` to read SOUL.md/NOPE.md from disk, render traits, and inject as XML blocks:

```typescript
import { readManifest } from '@dorkos/shared/manifest';
import {
  readConventionFile,
  extractCustomProse,
  buildSoulContent,
  TRAIT_SECTION_START,
} from '@dorkos/shared/convention-files';
import { renderTraits, DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';

async function buildAgentBlock(cwd: string): Promise<string> {
  const manifest = await readManifest(cwd);
  if (!manifest) return '';

  const {
    name,
    role,
    model,
    persona,
    personaEnabled, // legacy fields
    traits,
    conventions, // new fields
  } = manifest as AgentManifest & {
    traits?: Record<string, number>;
    conventions?: { soul?: boolean; nope?: boolean };
  };

  // --- Identity block (unchanged) ---
  const identityLines = [
    name && `Name: ${name}`,
    role && `Role: ${role}`,
    model && `Model: ${model}`,
  ].filter(Boolean);

  const blocks: string[] = [];

  if (identityLines.length > 0) {
    blocks.push(`<agent_identity>\n${identityLines.join('\n')}\n</agent_identity>`);
  }

  // --- Persona block (SOUL.md or legacy persona) ---
  const soulEnabled = conventions?.soul !== false;

  if (soulEnabled) {
    // Try SOUL.md first
    let soulContent = await readConventionFile(cwd, 'SOUL.md');

    if (soulContent) {
      // If SOUL.md has a trait section, regenerate it with current trait values
      if (soulContent.includes(TRAIT_SECTION_START)) {
        const customProse = extractCustomProse(soulContent);
        const traitBlock = renderTraits({ ...DEFAULT_TRAITS, ...traits });
        soulContent = buildSoulContent(traitBlock, customProse);
      }
      blocks.push(`<agent_persona>\n${soulContent}\n</agent_persona>`);
    } else if (personaEnabled !== false && persona) {
      // Legacy fallback: use persona field
      blocks.push(`<agent_persona>\n${persona}\n</agent_persona>`);
    }
  }

  // --- Safety boundaries block (NOPE.md) ---
  const nopeEnabled = conventions?.nope !== false;

  if (nopeEnabled) {
    const nopeContent = await readConventionFile(cwd, 'NOPE.md');
    if (nopeContent) {
      blocks.push(`<agent_safety_boundaries>\n${nopeContent}\n</agent_safety_boundaries>`);
    }
  }

  return blocks.join('\n\n');
}
```

**Injection order:** identity -> persona (SOUL.md) -> safety boundaries (NOPE.md).

### 6.6 API Route Changes

#### `apps/server/src/routes/agents.ts`

**POST (create agent):** Scaffold SOUL.md and NOPE.md with pre-filled templates:

```typescript
// After writeManifest(agentPath, manifest):
const traitBlock = renderTraits(DEFAULT_TRAITS);
const soulContent = defaultSoulTemplate(manifest.name ?? 'agent', traitBlock);
const nopeContent = defaultNopeTemplate();

await writeConventionFile(agentPath, 'SOUL.md', soulContent);
await writeConventionFile(agentPath, 'NOPE.md', nopeContent);
```

**PATCH (update agent):** Accept `soulContent`, `nopeContent`, `traits`, and `conventions`:

```typescript
// Extend UpdateAgentRequestSchema:
soulContent: z.string().max(SOUL_MAX_CHARS).optional(),
nopeContent: z.string().max(NOPE_MAX_CHARS).optional(),
traits: TraitsSchema.optional(),
conventions: ConventionsSchema.optional(),

// In handler:
if (body.soulContent !== undefined) {
  await writeConventionFile(agentPath, 'SOUL.md', body.soulContent);
}
if (body.nopeContent !== undefined) {
  await writeConventionFile(agentPath, 'NOPE.md', body.nopeContent);
}
if (body.traits !== undefined) {
  // Write traits to agent.json
  manifest.traits = body.traits;
}
if (body.conventions !== undefined) {
  manifest.conventions = body.conventions;
}
```

**GET (read agent):** Return convention file contents alongside manifest data:

```typescript
// In GET /api/agents/:id handler:
const soulContent = await readConventionFile(agentPath, 'SOUL.md');
const nopeContent = await readConventionFile(agentPath, 'NOPE.md');

return res.json({
  ...agent,
  soulContent,
  nopeContent,
});
```

### 6.7 Persona Migration

When `buildAgentBlock` encounters an agent with a `persona` field but no SOUL.md file, it uses the legacy persona as fallback (see 6.5). The UI triggers explicit migration:

**Migration logic (in PATCH handler or client-triggered):**

```typescript
async function migratePersonaToSoul(agentPath: string, manifest: AgentManifest): Promise<void> {
  const existingSoul = await readConventionFile(agentPath, 'SOUL.md');
  if (existingSoul) return; // Already migrated

  const { persona } = manifest;
  if (!persona) return; // Nothing to migrate

  const traitBlock = renderTraits(manifest.traits ?? DEFAULT_TRAITS);
  const soulContent = buildSoulContent(traitBlock, persona);
  await writeConventionFile(agentPath, 'SOUL.md', soulContent);

  // Scaffold NOPE.md if missing
  const existingNope = await readConventionFile(agentPath, 'NOPE.md');
  if (!existingNope) {
    await writeConventionFile(agentPath, 'NOPE.md', defaultNopeTemplate());
  }
}
```

Migration is triggered when the Personality tab is first opened for an agent that has `persona` but no SOUL.md. The legacy `persona` field is preserved in `agent.json` for rollback safety.

### 6.8 Client Components

#### Rename and rewrite: `PersonaTab.tsx` -> `PersonalityTab.tsx`

Single scrollable tab with four sections in vertical order:

1. **Personality Sliders** — 5 Radix UI sliders with level labels
2. **SOUL.md Editor** — Markdown textarea with toggle switch
3. **NOPE.md Editor** — Markdown textarea with toggle switch and advisory disclaimer
4. **Injection Preview** — Expandable showing the fully rendered prompt

#### New: `PersonalitySliders.tsx`

```typescript
interface PersonalitySlidersProps {
  traits: Traits;
  onChange: (traits: Traits) => void;
}
```

5 discrete sliders (Radix UI `Slider` with `step={1}`, `min={1}`, `max={5}`). Each shows:

- Trait name (left)
- Current level label (right, e.g., "3/5 Balanced")
- The slider rail with 5 discrete positions

#### New: `ConventionFileEditor.tsx`

```typescript
interface ConventionFileEditorProps {
  title: string; // "Custom Instructions (SOUL.md)" or "Safety Boundaries (NOPE.md)"
  content: string;
  enabled: boolean;
  maxChars: number;
  disclaimer?: string; // Advisory text for NOPE.md
  onChange: (content: string) => void;
  onToggle: (enabled: boolean) => void;
}
```

Markdown textarea with:

- Toggle switch in the header (`[On]` / `[Off]`)
- Character count / max indicator
- When toggled off: editor remains visible (for drafting) but visually dimmed
- For NOPE.md: disclaimer text below the header

**NOPE.md disclaimer text:**

> These boundaries guide agent behavior but are not enforced at the tool level. They serve as strong instructions, not hard blocks.

#### New: `InjectionPreview.tsx`

Expandable/collapsible section showing the fully rendered system prompt injection. Displays the concatenation of:

1. Rendered trait directives (from current slider positions)
2. Custom SOUL.md prose (if soul toggle is on)
3. NOPE.md content (if nope toggle is on)

Rendered as read-only monospace text with XML block markers visible.

#### Update: `AgentDialog.tsx`

Rename "Persona" tab to "Personality". Import `PersonalityTab` instead of `PersonaTab`.

### 6.9 SOUL.md File Structure

A SOUL.md file has two clearly separated sections:

```markdown
<!-- TRAITS:START -->

## Personality Traits

- **Tone** (Balanced): Balance brevity with context. Explain decisions when they are non-trivial.
- **Autonomy** (Balanced): Attempt tasks autonomously. Ask when genuinely uncertain or when the stakes are high.
- **Caution** (Balanced): Verify before destructive actions. Move confidently on reversible ones. Run tests when relevant.
- **Communication** (Balanced): Provide status updates for longer tasks. Report blockers promptly.
- **Creativity** (Balanced): Follow conventions by default. Suggest alternatives when they offer clear, meaningful improvements.
<!-- TRAITS:END -->

## Identity

You are shipping-agent, a coding assistant focused on getting features out the door.

## Values

- Write clean, maintainable code
- Respect existing patterns and conventions
- Communicate clearly about trade-offs
```

The `<!-- TRAITS:START -->` / `<!-- TRAITS:END -->` markers delimit the auto-regenerated section. When sliders change, only the content between these markers is replaced. Everything below `<!-- TRAITS:END -->` is custom prose that the user writes and sliders never touch.

### 6.10 File Location

Convention files live in the agent's `.dork/` directory alongside `agent.json`:

```
{agent-root}/.dork/
├── agent.json       # Structured config (traits, conventions, metadata)
├── SOUL.md          # Personality (trait-rendered + hand-written prose)
└── NOPE.md          # Safety boundaries
```

Uppercase filenames match upstream conventions (SOUL.md, NOPE.md) and are consistent with CLAUDE.md.

## 7. User Experience

### Agent Creation Flow

1. User clicks "Create Agent" in the UI
2. User provides agent name and selects a directory (default: `~/.dork/agents/{name}/`)
3. DorkOS scaffolds `.dork/agent.json`, `.dork/SOUL.md`, `.dork/NOPE.md` with sensible defaults
4. All trait sliders start at level 3 (Balanced)
5. SOUL.md has default identity and values sections
6. NOPE.md has default safety rules (no push to main, no delete prod data, etc.)

### Personality Configuration Flow

1. User opens agent settings dialog -> "Personality" tab
2. **Sliders section**: 5 trait sliders at top. Adjust any slider -> trait section in SOUL.md auto-regenerates. Preview updates live.
3. **SOUL.md section**: Below sliders. Toggle on/off. Edit custom prose (below the trait markers). Character count shown.
4. **NOPE.md section**: Below SOUL.md. Toggle on/off. Edit safety boundaries. Advisory disclaimer visible. Character count shown.
5. **Preview section**: Expandable at bottom. Shows exactly what gets injected into the system prompt.
6. Click Save -> traits written to `agent.json`, SOUL.md/NOPE.md written to disk, conventions toggles updated.
7. Changes take effect on next session (no restart required).

### Migration Flow (Existing Agents)

1. User opens Personality tab for an agent that has a `persona` field but no SOUL.md
2. System auto-generates SOUL.md with default trait section + existing persona text as custom prose
3. System scaffolds default NOPE.md
4. User sees their existing persona text preserved in the custom prose section
5. Legacy `persona` field remains in `agent.json` for rollback safety

## 8. Injection Pipeline

```
agent.json (traits 1-5) ──→ trait renderer ──→ personality directives
                                                       │
SOUL.md (custom prose) ────────────────────────────────┤
                                                       ▼
                                              combined personality block
                                                       │
NOPE.md (safety rules) ──→ safety block ───────────────┤
                                                       ▼
                                            buildAgentBlock(cwd)
                                                       │
                                                       ▼
                                            systemPrompt.append
                                          (runtime-specific injection)
```

**Per-request read**: `buildAgentBlock` reads SOUL.md and NOPE.md from disk on every `sendMessage` call. No caching, no reconciler involvement. This ensures changes are picked up immediately on the next message.

**Injection output example:**

```xml
<agent_identity>
Name: shipping-agent
Role: Full-stack developer
Model: claude-sonnet-4-6
</agent_identity>

<agent_persona>
<!-- TRAITS:START -->
## Personality Traits

- **Tone** (Terse): Keep responses brief. Explain only what is non-obvious. Skip preamble.
- **Autonomy** (Independent): Act autonomously. Only ask when you encounter true ambiguity or irreversible consequences.
- **Caution** (Balanced): Verify before destructive actions. Move confidently on reversible ones. Run tests when relevant.
- **Communication** (Proactive): Keep the user informed. Share progress, flag concerns early, suggest next steps.
- **Creativity** (Balanced): Follow conventions by default. Suggest alternatives when they offer clear, meaningful improvements.
<!-- TRAITS:END -->

## Identity

You are shipping-agent, focused on getting features shipped fast and clean.

## Values

- Ship early, iterate often
- Clean code over clever code
</agent_persona>

<agent_safety_boundaries>
# Safety Boundaries

## Never Do

- Never push to main without explicit approval
- Never delete production data
- Never commit secrets or API keys
</agent_safety_boundaries>
```

## 9. Testing Strategy

### Unit Tests

#### `packages/shared/src/__tests__/trait-renderer.test.ts`

- Verify `renderTraits()` produces correct output for all 25 trait/level combinations
- Verify `renderTraits()` handles missing traits (falls back to level 3)
- Verify `TRAIT_ORDER` contains all 5 traits
- Verify all `TRAIT_LEVELS` entries have non-empty `label` and `directive`

#### `packages/shared/src/__tests__/convention-files.test.ts`

- Verify `buildSoulContent()` creates correct structure with trait markers
- Verify `extractCustomProse()` correctly extracts prose after `TRAITS:END`
- Verify `extractCustomProse()` returns full content when no trait markers present
- Verify `defaultSoulTemplate()` includes agent name and default values
- Verify `defaultNopeTemplate()` includes expected safety rules
- Verify character limit constants are correct (SOUL: 4000, NOPE: 2000)

### Integration Tests

#### `apps/server/src/routes/__tests__/agents-conventions.test.ts`

- POST creates agent with scaffolded SOUL.md and NOPE.md files on disk
- PATCH with `soulContent` writes SOUL.md to disk
- PATCH with `nopeContent` writes NOPE.md to disk
- PATCH with `traits` updates agent.json traits field
- PATCH with `conventions` updates toggle state
- GET returns convention file contents alongside agent data
- Migration: agent with `persona` but no SOUL.md gets auto-migrated on first access

#### `apps/server/src/services/runtimes/claude-code/__tests__/context-builder-conventions.test.ts`

- `buildAgentBlock` injects SOUL.md content as `<agent_persona>`
- `buildAgentBlock` injects NOPE.md content as `<agent_safety_boundaries>`
- `buildAgentBlock` regenerates trait section when traits change
- `buildAgentBlock` respects `conventions.soul: false` (skips persona block)
- `buildAgentBlock` respects `conventions.nope: false` (skips safety block)
- `buildAgentBlock` falls back to legacy `persona` when no SOUL.md exists
- `buildAgentBlock` returns empty string when no manifest exists (graceful fallback)
- `buildAgentBlock` overhead stays under 5ms for convention file reads

### Component Tests

#### `apps/client/src/layers/features/agent-settings/ui/__tests__/PersonalitySliders.test.tsx`

- Renders 5 sliders with correct labels
- Each slider shows current level label
- Slider change calls `onChange` with updated traits
- All sliders have 5 discrete positions (min=1, max=5, step=1)

#### `apps/client/src/layers/features/agent-settings/ui/__tests__/ConventionFileEditor.test.tsx`

- Renders title, toggle, and textarea
- Toggle on/off updates convention state
- When toggled off, editor is visually dimmed but still editable
- Character count displays correctly
- NOPE.md variant shows advisory disclaimer
- Content changes call `onChange`

#### `apps/client/src/layers/features/agent-settings/ui/__tests__/InjectionPreview.test.tsx`

- Renders expand/collapse toggle
- Shows combined output of traits + SOUL.md + NOPE.md when expanded
- Respects toggle states (omits disabled files)
- Updates live when traits or content change

#### `apps/client/src/layers/features/agent-settings/ui/__tests__/PersonalityTab.test.tsx`

- Renders all four sections in correct order
- Slider changes trigger trait section regeneration in SOUL.md preview
- Save button writes all changes (traits, conventions, file contents)
- Migration: shows existing persona content in SOUL.md editor for legacy agents

## 10. Performance Considerations

- **File reads per message**: 2 additional `readFile` calls per `sendMessage` (SOUL.md + NOPE.md). These are small files (<6KB total) read from local disk — expected overhead <2ms.
- **Trait rendering**: Pure synchronous string concatenation from a static lookup table — <0.1ms.
- **Total `buildAgentBlock` overhead**: <5ms additional (well within the existing ~10ms budget for context building).
- **No caching needed**: Files are small and disk reads are fast. Caching would add complexity for negligible benefit and risk serving stale content.

## 11. Security Considerations

- **Agents must NOT write to SOUL.md or NOPE.md**: Convention files are user-controlled configuration, not agent-writable state. This prevents persistence attacks where a compromised agent modifies its own personality or safety boundaries. The convention file write API is server-side only, gated by the agent settings PATCH endpoint.
- **NOPE.md is advisory**: Safety boundaries guide agent behavior through system prompt instructions but are not enforced at the tool/permission level. The UI includes a clear disclaimer to set correct expectations. Future work may add tool-level enforcement.
- **Character limits**: SOUL.md capped at 4,000 chars, NOPE.md at 2,000 chars. Prevents system prompt inflation.
- **File path validation**: Convention file read/write helpers use `path.join` with the agent's known project path — no user-controlled path components that could escape the `.dork/` directory.

## 12. Documentation

- Update `contributing/architecture.md` — Add section on convention files and the injection pipeline
- Update `contributing/configuration.md` — Document `traits` and `conventions` fields in agent.json
- Add inline JSDoc on all new exported functions and types

## 13. Implementation Phases

### Phase 1: Foundation (Shared Package)

1. Add `TraitsSchema` and `ConventionsSchema` to `mesh-schemas.ts`
2. Create `trait-renderer.ts` with static lookup table and `renderTraits()`
3. Create `convention-files.ts` with read/write helpers, templates, and SOUL.md builder
4. Add `applyConventions` to `AgentRuntime` interface
5. Add `traits_json` and `conventions_json` columns to DB schema
6. Unit tests for trait renderer and convention file helpers

### Phase 2: Server Integration

7. Extend `buildAgentBlock()` to read convention files and render traits
8. Extend agent routes: POST scaffolds files, PATCH writes files, GET returns contents
9. Implement persona migration logic
10. Integration tests for context builder and API routes

### Phase 3: Client UI

11. Create `PersonalitySliders` component
12. Create `ConventionFileEditor` component
13. Create `InjectionPreview` component
14. Rewrite `PersonaTab` as `PersonalityTab` composing all three components
15. Update `AgentDialog` tab name and imports
16. Component tests for all new UI components

### Phase 4: Verification

17. End-to-end validation: create agent, adjust sliders, edit files, verify injection
18. Migration testing: verify legacy agents work correctly
19. Performance validation: `buildAgentBlock` overhead under budget

## 14. Open Questions

All questions resolved during ideation and spec creation. No open questions remain.

## 15. Related ADRs

- **ADR-0043**: File-first write-through for agent storage — Convention files follow this same pattern (disk is canonical, DB is derived)
- **ADR-0085**: AgentRuntime interface as universal abstraction — The `applyConventions` method extends this interface for multi-runtime support

## 16. Acceptance Criteria

### Must Have

- Agent settings dialog has a "Personality" tab with 5 trait sliders (Tone, Autonomy, Caution, Communication, Creativity)
- Each slider shows current level label and has 5 discrete positions
- SOUL.md inline editor with toggle switch for enable/disable
- NOPE.md inline editor with toggle switch for enable/disable and advisory disclaimer
- "Preview injected prompt" expandable showing exactly what the agent receives
- Trait changes regenerate the trait section of SOUL.md; custom prose section is preserved
- `buildAgentBlock` injects SOUL.md as `<agent_persona>` and NOPE.md as `<agent_safety_boundaries>`
- Agent creation scaffolds pre-filled SOUL.md and NOPE.md in `.dork/`
- Existing agents with persona field get auto-migrated to SOUL.md on first access
- `AgentRuntime` interface has optional `applyConventions` method
- SOUL.md max 4,000 chars, NOPE.md max 2,000 chars

### Must Not

- Agents must not be able to write to SOUL.md or NOPE.md
- NOPE.md UI must not imply enforcement — include advisory disclaimer
- Trait rendering must not call an LLM
- Changes must not break existing agents that have no SOUL.md/NOPE.md (graceful fallback)

### Non-Regression

- Existing persona injection continues to work for agents that haven't been migrated
- Agent settings dialog remains functional for all existing fields (identity, capabilities, connections)
- `buildAgentBlock` performance stays under 5ms additional overhead

## 17. References

- [Ideation document](./01-ideation.md)
- [Project brief](./00-brief.md)
- [OpenClaw convention file research](../../research/20260321_openclaw_ai_convention_markdown_files.md)
- [Implementation research](../../research/20260321_agent_personality_convention_files_impl.md)
- [SOUL.md open-source project](https://github.com/aaronjmars/soul.md)
- [NOPE.md open standard](https://nope-md.vercel.app/)
- [AGENTS.md universal standard](https://agents.md/)
