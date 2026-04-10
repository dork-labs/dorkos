---
title: 'Agent Personality Convention Files — Implementation Research'
date: 2026-03-21
type: implementation
status: active
tags:
  [
    SOUL.md,
    NOPE.md,
    personality-traits,
    system-prompt,
    agent-runtime,
    workspace-scaffolding,
    context-injection,
    trait-sliders,
  ]
feature_slug: agent-personality-convention-files
searches_performed: 16
sources_count: 32
---

## Research Summary

This report covers implementation-specific research for the agent-personality-convention-files feature: how different agent SDKs handle system prompt injection, how existing products model personality traits, approaches for rendering structured trait values into natural language, and agent workspace scaffolding patterns. The existing `research/20260321_openclaw_ai_convention_markdown_files.md` covers the SOUL.md / NOPE.md convention landscape and is not repeated here.

Key findings: (1) the Claude Agent SDK's `systemPrompt.append` via `context-builder.ts` is the right injection point and is already wired — SOUL.md content should flow through `buildAgentBlock`; (2) OpenCode and Codex CLI both use markdown file injection (not programmatic system prompt APIs), making file-first the cross-runtime-compatible approach; (3) static template-based trait rendering (5 levels × N dimensions = lookup table) is the correct approach for DorkOS — predictable, auditable, zero LLM calls; (4) workspace scaffolding should produce pre-filled SOUL.md, empty NOPE.md with safety categories marked, and leave AGENTS.md alone.

---

## Key Findings

### 1. System Prompt Injection — Claude Agent SDK (Already Solved)

The existing `context-builder.ts` in `apps/server/src/services/runtimes/claude-code/` is the definitive injection point. From `buildAgentBlock()`:

```typescript
async function buildAgentBlock(cwd: string): Promise<string> {
  const manifest = await readManifest(cwd);
  if (!manifest) return '';
  const { persona, personaEnabled } = manifest as { ... };
  // ...
  if (personaEnabled !== false && persona) {
    blocks.push(`<agent_persona>\n${persona}\n</agent_persona>`);
  }
  return blocks.join('\n\n');
}
```

SOUL.md content should be read from the filesystem and merged into `persona`. The `<agent_persona>` block is already injected on every session. NOPE.md content should be injected as a separate `<agent_safety_boundaries>` block in the same function.

The injection path is: `buildSystemPromptAppend()` → `buildAgentBlock()` → `systemPrompt: { type: 'preset', preset: 'claude_code', append: result }`.

No new injection mechanism is needed. The existing `persona` field in `AgentManifest` is the right home for rendered SOUL.md content. NOPE.md adds a parallel `nopeMd` / `nopeMdEnabled` field.

### 2. System Prompt Injection — Other Runtimes

#### OpenCode (Go CLI, currently Cursor/OpenAI focus)

OpenCode assembles system prompts through its `packages/opencode/src/session/prompt.ts` orchestrator:

1. Provider-specific base prompt (e.g., `anthropic.txt` for Claude, `beast.txt` for GPT)
2. AGENTS.md files discovered by walking up from cwd
3. AGENTS.md at project root and `~/.claude/AGENTS.md`
4. Agent-specific prompt (from `.opencode/agents/*.md` or `opencode.json` `agent.*.prompt`)

**No programmatic API for system prompt injection exists in OpenCode.** Custom agent system prompts are injected via markdown files in `.opencode/agents/`. For SOUL.md-style personality, the content would be written into a per-agent `.opencode/agents/<name>.md` file. There is no equivalent to Claude Agent SDK's `systemPrompt.append`.

OpenCode has an open feature request ([Issue #7351](https://github.com/anomalyco/opencode/issues/7351)) to add a `systemPrompt` option to the SDK like Claude Agent SDK.

**DorkOS implication**: An `OpenCodeRuntime` adapter would implement `setPersona()` (or equivalent) by writing/updating `.opencode/agents/<agent-name>.md` and triggering a session restart, rather than injecting into a running session.

#### OpenAI Codex CLI

Codex uses AGENTS.md files (hierarchical: global → repo root → subdirectory). Custom prompts were deprecated in favor of Skills. There is no API for programmatic system prompt injection in the published Codex CLI documentation. The closest analog is the `--instructions` flag for per-run appending, or prefixing AGENTS.md with personality text.

**DorkOS implication**: For a Codex-backed agent, SOUL.md personality content would be prepended to the project's AGENTS.md file or stored in a separate `SOUL.md` that Codex ignores natively — DorkOS would need to manage merging SOUL.md into AGENTS.md when Codex is the runtime.

#### Aider

Aider has no official `--system-prompt` flag. Community workarounds use `chat-language` config injection (unsupported/fragile). A `--system-prompt-extras <file>` feature was proposed in 2025 but not yet shipped as of the research date. The conventional approach is `AGENTS.md` or `.aiderignore`-adjacent convention files.

**DorkOS implication**: Aider support would require writing SOUL.md content to an AGENTS.md or similar file that Aider reads, not programmatic injection.

#### Continue.dev

Continue supports "system prompt" per-model configuration in `~/.continue/config.json`. This is static per-user, not per-agent. Per-project customization uses `.continue/rules/*.md` files (similar to Cursor's scoped rules pattern).

### 3. AgentRuntime Interface — `setPersona()` vs `systemPromptAppend`

The existing `MessageOpts.systemPromptAppend?: string` in `agent-runtime.ts` is the runtime-agnostic injection point. The flow:

```
AgentManifest.persona (rendered trait text) → MessageOpts.systemPromptAppend → runtime.sendMessage()
```

For Claude Code: `systemPromptAppend` flows into `buildSystemPromptAppend()` (already wired).
For OpenCode: the adapter would write a `.opencode/agents/*.md` file pre-session.
For Codex: the adapter would prepend to AGENTS.md or use the `--instructions` flag.

This means the interface already supports multi-runtime personality injection correctly — each runtime adapter translates `systemPromptAppend` or the manifest's `persona` field into its native injection mechanism.

The key addition needed: a `setPersona(persona: string, enabled: boolean): Promise<void>` optional method on `AgentRuntime` for runtimes that need to write files (rather than injecting per-session). For Claude Code, this is a no-op (file write to `agent.json` is sufficient). For OpenCode, this writes to `.opencode/agents/`.

---

## Detailed Analysis

### Topic 1: Personality Trait Systems in AI Products

#### Character.AI

Character.AI uses a **slider-based UI** where creators adjust dimensions of behavior. The personality is not directly editable prose — the sliders generate the behavioral framing automatically. Key dimensions include creativity, politeness, verbosity, and emotional expression. The underlying prompts are hidden from creators. This is user-friendly but **not auditable or predictable** — creators don't know what prompt was generated.

**Assessment**: Wrong model for DorkOS. Kai needs to know exactly what instructions his agent is following.

#### Inworld AI

Inworld uses a more elaborate system: 10 sliders + freeform trait text + emotional fluidity control. The five core Big Five (OCEAN) dimensions each map to a 0-4 scale. Implementation uses "Emotional Fluidity" (0.0-1.0) as a separate axis controlling expressiveness. The platform targets game NPC developers, not coding agent operators. Their implementation likely generates system prompts internally.

**Assessment**: The OCEAN model (Big Five) is too psychology-centric for coding agents. "Agreeableness" and "Neuroticism" are irrelevant to an agent's utility for Kai. Purpose-built dimensions are better.

#### OpenAI Custom GPTs

GPT-5 custom GPTs configure personality through: (1) freeform "Instructions" text, (2) preset personality archetypes (Professional, Efficient, Fact-Based, Exploratory), and (3) "Characteristics" for response-style fine-tuning (brevity, warmth, emoji frequency). The preset system maps to concrete instruction text that OpenAI pre-writes — the user picks a preset, not the resulting prompt.

OpenAI's four archetypes (Professional, Efficient, Fact-Based, Exploratory) map to paired instruction sets covering tone, format, scope, and what NOT to do. This is the closest production analog to DorkOS trait sliders.

**Assessment**: OpenAI's preset-based approach is the right model at high level — named levels that map to curated instruction text. DorkOS should adapt this with dimensions relevant to coding agents.

#### CrewAI

CrewAI agents define personality through three prose fields: **Role**, **Goal**, and **Backstory**. These compose directly into the LLM system prompt via template substitution. There are no sliders — everything is freeform prose written by the operator.

```yaml
agent:
  role: 'Technical Writer'
  goal: 'Simplify complex concepts for junior developers'
  backstory: 'Former software engineer who discovered a passion for clear communication...'
```

The backstory text is injected directly into the system prompt. This is flexible but requires writing skill from users and produces inconsistent results.

**Assessment**: Pure prose is wrong for DorkOS. Kai doesn't want to write character backstories — he wants to dial knobs. But prose fields as a complement to sliders (for customizing beyond what sliders can express) is valuable.

#### Poe Bots

Poe bot personality is configured through a freeform "Prompt" text field plus example conversation pairs. No sliders. The persona is whatever prose the creator writes. This matches Claude Projects' custom instructions approach.

#### Academic Research — Big Five Personality Mapping

A 2025 arxiv paper (Sequential Adaptive Steering) demonstrates that Big Five trait values can be injected into LLMs at inference time via activation steering vectors with high fidelity (Spearman's ρ ≥ 0.90). However, this is a model-internals approach incompatible with DorkOS's architecture (we call external CLIs/APIs, not internal model weights).

A separate research line (2023, "Personality Traits in Large Language Models") uses prompt-level Likert qualifiers: "extremely extraverted," "somewhat introverted," "highly conscientious." These work but the Big Five model is psychologically-oriented, not tool-oriented.

---

### Topic 2: Coding-Agent-Specific Trait Dimensions

Based on the product analysis and DorkOS's primary persona (Kai — senior dev running 10-20 agents/week), the following trait dimensions are purpose-built for coding agents:

| Dimension         | Level 1 (label)      | Level 3 (label) | Level 5 (label)      |
| ----------------- | -------------------- | --------------- | -------------------- |
| **Tone**          | Terse                | Balanced        | Thorough             |
| **Autonomy**      | Ask frequently       | Balanced        | Act autonomously     |
| **Caution**       | Move fast            | Balanced        | Verify carefully     |
| **Communication** | Silent worker        | Balanced        | Proactive updater    |
| **Creativity**    | Stick to conventions | Balanced        | Explore alternatives |

These five dimensions map directly to decisions that affect Kai's workflow:

- **Tone** affects how much the agent explains its work
- **Autonomy** affects how often it interrupts for approval
- **Caution** affects whether it triple-checks before destructive actions
- **Communication** affects whether it sends relay messages unprompted
- **Creativity** affects whether it proposes refactors vs. minimal changes

Each level maps to one or two concrete instruction sentences — the "trait template" approach.

---

### Topic 3: Trait Rendering Approaches

Three approaches exist for converting structured trait values (1-5 per dimension) into natural language for `<agent_persona>`:

#### Approach A: Static Template Lookup Table

```typescript
const TONE_TEMPLATES: Record<number, string> = {
  1: 'Be terse. One-line answers when possible. Skip explanations unless asked.',
  2: 'Keep responses brief. Explain only what is non-obvious.',
  3: 'Balance brevity with context. Explain decisions when they are non-trivial.',
  4: 'Provide clear explanations for your decisions and approach.',
  5: 'Be thorough. Explain your reasoning, alternatives considered, and any caveats.',
};
```

**Pros**: Deterministic, auditable, fast (no LLM call), no API cost, user knows exactly what they're getting, easy to test, consistent across sessions.

**Cons**: Less nuanced than human-written prose; the operator cannot go "between" levels; maintaining the table as understanding evolves requires code changes.

**Assessment**: Correct for DorkOS MVP. The predictability advantage is decisive — Kai will trust this, and Priya will want to read the resulting prompt. Both require auditability.

#### Approach B: LLM-Generated at Save Time

When the user saves their trait configuration, call an LLM to generate the persona prose from the trait values. Store the result in `agent.json`. Re-generate when traits change.

**Pros**: More natural language; can produce nuanced combinations of traits.

**Cons**: Non-deterministic (same trait values produce different text each save); requires an API call; adds latency to save; generated text is opaque to users; adds API cost; the "generated by AI" prose is harder for Kai to trust or audit.

**Assessment**: Wrong for DorkOS. The non-determinism violates the "honest by design" principle. Users should be able to see exactly what instructions their trait settings produce.

#### Approach C: Interpolation (Parameterized Templates)

```typescript
const TONE_TEMPLATE = (level: number) =>
  `Be ${['extremely terse', 'brief', 'balanced', 'thorough', 'extremely thorough'][level - 1]} in your responses.`;
```

This is a simplified variant of Approach A — linear interpolation rather than distinct behavioral descriptions per level.

**Cons**: The behavioral jump from level 3 to level 4 or 1 to 2 is less meaningful when it's just an adjective change vs. a different set of behavioral rules.

**Assessment**: Weaker than Approach A. Named templates per level with distinct behavioral instructions are more valuable than parameterized adjective strings.

#### Recommendation: Approach A with a "Preview" feature

Use the static lookup table. Add a **live preview** in the trait slider UI — as the user moves sliders, the UI renders the resulting `<agent_persona>` text in real time. This shows users exactly what the agent will receive. This is the "honest by design" principle applied directly. The lookup table IS the preview — no hidden transformation.

---

### Topic 4: SOUL.md and NOPE.md Architecture in DorkOS

#### SOUL.md — The Personality File

SOUL.md in the DorkOS context is a markdown file at `<projectPath>/SOUL.md`. Its purpose:

1. Contains the rendered personality description (either freeform prose or the output of the trait slider system)
2. Is read by `buildAgentBlock()` and injected as `<agent_persona>`
3. Can be edited inline in the agent settings dialog OR auto-generated from trait sliders

**Relationship to `agent.json`**: The `persona` field in `AgentManifest` stores the current rendered content. SOUL.md is the "human-editable source" — on save, SOUL.md is written to disk and its content is also written to `agent.json.persona`. On session start, `buildAgentBlock()` reads from `agent.json.persona` (fast, already loaded) rather than re-reading SOUL.md.

This follows the file-first write-through pattern (ADR-0043): disk is truth, DB/manifest is derived.

**Why not read SOUL.md directly at session start?** Performance. `agent.json` is already read by `readManifest()`. Adding a second filesystem read for SOUL.md on every session start adds latency. The manifest is the fast-path.

**When SOUL.md diverges from agent.json**: The reconciler (runs every 5 minutes) should sync SOUL.md → `agent.json.persona` if the file is newer. This mirrors the existing file-first pattern.

#### NOPE.md — The Safety Boundaries File

NOPE.md defines what the agent must never do. Unlike SOUL.md, NOPE.md should be:

1. **Empty by default** — safety boundaries are opt-in restrictions, not defaults
2. **Structured with clear categories** — pre-filled with section headers but empty bodies
3. **Injected as a distinct XML block** — `<agent_safety_boundaries>` separate from `<agent_persona>`

The distinction matters: `<agent_persona>` describes style/behavior; `<agent_safety_boundaries>` is a constraint layer. Claude treats these differently in practice — safety-style instructions in a dedicated XML block are attended to differently than persona descriptions.

**NOPE.md template (scaffolded content)**:

```markdown
# Safety Boundaries

This file defines actions this agent must never perform.
Leave a section empty to impose no restriction in that area.

## Filesystem Restrictions

<!-- Example: Never delete files outside of /tmp -->

## Network Restrictions

<!-- Example: Never make requests to external APIs without approval -->

## Code Execution Restrictions

<!-- Example: Never run scripts with --no-sandbox or as root -->

## Data Access Restrictions

<!-- Example: Never read files containing "secret" or "password" in their name -->

## Communication Restrictions

<!-- Example: Never send relay messages to relay.human.* without explicit instruction -->
```

**Injection when NOPE.md is empty**: Do not inject the block at all. Zero content = zero overhead.

**Injection order**: `<agent_identity>` → `<agent_persona>` → `<agent_safety_boundaries>`. Safety boundaries come last so they are closest to the agent's action-taking context (they override any permissive framing in the persona).

#### The Convention File Injection Pipeline (Updated)

```typescript
async function buildAgentBlock(cwd: string): Promise<string> {
  const manifest = await readManifest(cwd);
  if (!manifest) return '';

  // Read convention files (SOUL.md and NOPE.md) in parallel
  const [soulContent, nopeContent] = await Promise.allSettled([
    readConventionFile(cwd, 'SOUL.md'),
    readConventionFile(cwd, 'NOPE.md'),
  ]);

  const identityLines = [ ... ]; // existing
  const blocks = [`<agent_identity>\n${identityLines.join('\n')}\n</agent_identity>`];

  // Persona: SOUL.md content > agent.json persona > nothing
  const personaText =
    (soulContent.status === 'fulfilled' && soulContent.value)
      ? soulContent.value
      : manifest.persona;

  if (manifest.personaEnabled !== false && personaText) {
    blocks.push(`<agent_persona>\n${personaText}\n</agent_persona>`);
  }

  // Safety boundaries: only inject when NOPE.md has non-comment content
  const nopeText = nopeContent.status === 'fulfilled' ? nopeContent.value : null;
  if (nopeText && hasSubstantiveContent(nopeText)) {
    blocks.push(`<agent_safety_boundaries>\n${nopeText}\n</agent_safety_boundaries>`);
  }

  return blocks.join('\n\n');
}
```

Note: This reads SOUL.md/NOPE.md at session start on each `sendMessage()`. The cost is two small file reads per session (~1ms each). Acceptable. Caching would add complexity without meaningful benefit for typical agent session frequency.

---

### Topic 5: Agent Workspace Scaffolding

#### What Existing Tools Scaffold

Tools like `agentmd init`, `npx @webbywisp/create-ai-agent`, and OpenClaw's workspace initializer scaffold the following patterns:

- **agentmd** (`agentmd init`): Creates AGENTS.md with section headers for Commands, Testing, Code Style, Git Workflow, and Boundaries
- **create-ai-agent** (`npx @webbywisp/create-ai-agent`): Creates SOUL.md, USER.md, OPS.md, MEMORY.md with pre-filled templates
- **OpenClaw**: The minimal viable workspace is SOUL.md + AGENTS.md + TOOLS.md — bootstrapped via a UI wizard or the `openclaw init` command

#### What DorkOS Should Scaffold

The DorkOS "Create Agent Workspace" flow should produce:

```
<projectPath>/
├── SOUL.md          # Pre-filled with name-based template + trait defaults
├── NOPE.md          # Pre-filled with section headers, empty bodies
└── .dork/
    └── agent.json   # Full manifest including persona derived from SOUL.md
```

DorkOS should NOT scaffold `AGENTS.md` — it belongs to Claude Code, not to DorkOS. If the user wants to create a AGENTS.md they can add it manually. Similarly, `AGENTS.md` is for coding conventions and is out of scope for the agent personality feature.

#### SOUL.md Scaffold Template

```markdown
# {{agent.name}}

{{agent.description}}

## Personality

<!-- Generated from trait configuration. Edit freely. -->

**Tone**: Balanced — explain decisions when non-trivial, skip obvious context.
**Autonomy**: Balanced — attempt tasks autonomously, ask when genuinely uncertain.
**Caution**: Balanced — verify before destructive actions, move confidently on reversible ones.
**Communication**: Silent worker — complete tasks without unprompted status updates.
**Creativity**: Stick to conventions — use established patterns unless the existing approach is clearly wrong.

## Identity

You are {{agent.name}}, a coding agent managed by DorkOS.
{{#if agent.description}}
{{agent.description}}
{{/if}}
```

The template shows both the machine-rendered trait section AND the agent identity, making it clear to users how both pieces compose.

#### What Should Be Pre-Filled vs Empty

| File             | Pre-fill                                | Rationale                                                     |
| ---------------- | --------------------------------------- | ------------------------------------------------------------- |
| SOUL.md          | Agent name, description, trait defaults | Zero-config starting point; user can edit                     |
| NOPE.md          | Section headers with comment hints only | Safety boundaries are opt-in; empty sections = no restriction |
| .dork/agent.json | Full manifest                           | Required for DorkOS to function                               |
| AGENTS.md        | Never                                   | Not DorkOS's domain                                           |
| AGENTS.md        | Never                                   | Not DorkOS's domain; coding conventions ≠ personality         |

---

### Topic 6: Inline Editing and Toggle UX

The agent settings dialog should support:

1. **Trait sliders** → read `manifest.traits` (new field) → render to SOUL.md content → update `manifest.persona`
2. **Raw edit mode** → direct CodeMirror/textarea edit of SOUL.md content
3. **NOPE.md tab** → direct text edit of NOPE.md content with a "has content" indicator
4. **Enable/Disable toggle** → maps to `manifest.personaEnabled` for persona, `manifest.nopeEnabled` for safety boundaries

The **preview pane** shows the assembled `<agent_persona>` XML that will be injected. This is the "honest by design" principle — Kai sees exactly what his agent receives.

For switching between "slider mode" and "raw edit mode": when the user enters raw edit mode, the slider values become undefined (the raw text is the authority). When the user returns to slider mode, sliders reset to neutral unless the raw text can be round-tripped (which it generally cannot).

The simpler UX: **sliders generate a starting point; the textarea is always editable.** Editing the textarea "breaks" the slider sync — a notice says "Sliders inactive — you're using custom persona text." A "Reset to sliders" button regenerates from current slider values.

---

### Topic 7: Multi-Runtime Consideration

The `AgentManifest` is runtime-agnostic. The `persona` field works for all runtimes. The convention files (SOUL.md, NOPE.md) are also runtime-agnostic in concept — they're markdown files that DorkOS manages.

The runtime-specific part is **how persona text is delivered to the model**:

| Runtime       | Injection Mechanism                                  | Notes                |
| ------------- | ---------------------------------------------------- | -------------------- |
| `claude-code` | `systemPrompt.append` via `buildAgentBlock()`        | Already wired        |
| `opencode`    | Write `.opencode/agents/<name>.md` with persona text | File-based injection |
| `codex`       | Prepend to AGENTS.md or use `--instructions` flag    | File-based injection |
| `cursor`      | Write `.cursor/rules/soul.mdc` with persona content  | File-based injection |
| `other`       | No-op (manifests are recorded but no injection)      | Graceful degradation |

The `AgentRuntime` interface should add an optional method:

```typescript
/**
 * Write persona text to the runtime's native configuration format.
 * Called when persona is updated in the agent settings dialog.
 * For Claude Code, this is a no-op (manifest handles it).
 * For other runtimes, this writes a persona file in the runtime's format.
 */
applyPersona?(persona: string | null, agentPath: string): Promise<void>;
```

This is optional — runtimes that don't implement it fall back to the `systemPromptAppend` approach in `MessageOpts`.

---

## Potential Solutions

### Solution 1: Manifest-First with Convention File Sync (Recommended)

**Architecture:**

- `agent.json` manifest stores rendered persona (existing `persona` field) and a new `nope` field for NOPE.md content
- SOUL.md and NOPE.md are human-editable "source of truth" files on disk
- Reconciler syncs SOUL.md → `agent.json.persona` and NOPE.md → `agent.json.nope` (same 5-minute cycle as existing reconciler)
- `buildAgentBlock()` reads from the manifest (fast path); the manifest is always fresh after reconciler runs
- Session-start injection reads manifest, not the files directly

**Pros**: Fast session start (no extra file reads), consistent with existing ADR-0043 pattern, works when filesystem is slow or unavailable, enables atomic updates

**Cons**: 5-minute reconciler lag means edits to SOUL.md via a text editor aren't reflected until next reconciler run. Mitigated by immediate sync when the DorkOS UI edits the files.

### Solution 2: File-First with Per-Request Read

**Architecture:**

- `buildAgentBlock()` reads SOUL.md and NOPE.md on every `sendMessage()` call
- No reconciler involvement for persona
- Files are the single source of truth; manifest.persona is removed or kept only as fallback

**Pros**: Edits to SOUL.md via any editor are immediately reflected in next session; simpler — no reconciler sync logic needed

**Cons**: Two extra filesystem reads per session (minimal cost ~1-2ms each); session start is slightly slower; harder to query "what is this agent's current persona?" from the API without reading the file

### Solution 3: Hybrid (Both Sync and Read)

The DorkOS UI writes both the file AND the manifest atomically. External editors update only the file — reconciler syncs to manifest. Session start reads from manifest. This is Solution 1 with a more deliberate file-write path.

**Recommendation**: **Solution 2 for MVP** (simpler, more robust), **Solution 1 for scale** (consistent with existing patterns). Given that DorkOS currently reads `agent.json` via `readManifest()` already in `buildAgentBlock()`, adding two more file reads for SOUL.md and NOPE.md is negligible. Solution 2 eliminates the reconciler complexity and gives Kai the immediate feedback he expects when editing files in his editor.

---

## Security Considerations

### 1. Prompt Injection via Convention Files

SOUL.md and NOPE.md are user-controlled files injected into system prompts. A malicious SOUL.md could attempt to override safety instructions or inject adversarial instructions.

**Mitigations:**

- DorkOS injects these files as the user's own configuration — this is not an attack vector in the same way that injecting external content would be. Kai is configuring his own agent.
- The distinction between `<agent_persona>` (guidance) and `<agent_safety_boundaries>` (constraint) should be maintained. NOPE.md should NEVER be editable by agents themselves — only by the human operator through the DorkOS UI.
- Cap SOUL.md at 4,000 characters (same as current `persona` field max) and NOPE.md at 2,000 characters to prevent context window abuse.
- OpenClaw explicitly limits their bootstrap content to 150,000 characters total (20,000 per file). DorkOS's 4,000-character cap for persona is already conservative.

### 2. SOUL.md as a Persistence Attack Vector

The OpenClaw security research identified that if an agent can write to SOUL.md, it creates a persistence mechanism for prompt injection attacks — injected instructions survive restarts.

**DorkOS mitigation**: Agents MUST NOT have write access to SOUL.md or NOPE.md. These files should be out of scope for agent file operations. Consider adding both files to a `.dorkignore` convention (similar to `.gitignore`) that the DorkOS tool permission system enforces. This is a future hardening measure; for MVP, document the risk clearly.

### 3. NOPE.md Safety Semantics

NOPE.md is advisory, not enforced. Like OpenClaw's own documentation acknowledges: "safety guardrails in the system prompt guide model behavior but do not enforce policy." Hard safety enforcement requires tool-level permissions, not prompt-level text.

**DorkOS should be honest about this**: The NOPE.md UI should include a clear note: "These boundaries guide your agent's behavior. They are not enforced at the tool level. To enforce hard restrictions, use agent tool group configuration." This prevents Kai from thinking NOPE.md is a security perimeter when it is advisory guidance.

---

## Performance Considerations

### Convention File Read Cost

At current session volume (10-20 sessions/week for primary persona Kai), reading two additional files per `sendMessage()` is negligible. Even at 100 sends/hour, the cost is ~200 file reads/hour — file I/O at this scale is microseconds.

At scale (enterprise, 1,000 concurrent agents each sending messages every 30 seconds): ~2,000 extra file reads/minute. Still not a bottleneck — filesystem is local, files are small.

**No caching needed for MVP.** If profiling ever shows file reads as a bottleneck, the manifest-first approach (Solution 1) eliminates the reads entirely.

### Trait Rendering Cost

The static lookup table approach is O(1) — a dictionary lookup per dimension. No LLM call, no async work. The rendered text is ~200-500 characters. Negligible.

### Context Window Impact

SOUL.md adds ~100-500 tokens (the existing `persona` field already supports up to 4,000 chars). NOPE.md adds ~50-300 tokens when populated. Both fit comfortably within the existing token budget analysis from `20260303_agent_tool_context_injection.md` — the total tool context overhead was ~600-1000 tokens; adding persona files brings this to ~700-1500 tokens, still <1% of the 200K token window.

---

## Recommendation

### Phase 1: SOUL.md Integration (Immediate)

1. Extend `buildAgentBlock()` to also read `SOUL.md` from the agent's `cwd` alongside the manifest
2. `SOUL.md` content takes precedence over `agent.json.persona` when present
3. `NOPE.md` content (if non-empty) is injected as `<agent_safety_boundaries>` block
4. No reconciler changes needed for MVP (file-first per-request read)

### Phase 2: Trait Slider UI

5. Add `traits` object to `AgentManifest` (five dimensions, 1-5 values)
6. Slider UI in agent settings dialog → renders to SOUL.md content via static lookup table
7. Live preview pane shows the `<agent_persona>` XML
8. "Edit directly" mode: textarea with full SOUL.md content; sliders become inactive
9. Toggle buttons for persona and NOPE.md enable/disable

### Phase 3: Workspace Scaffolding

10. "Create Agent Workspace" action in DorkOS generates SOUL.md and NOPE.md in the agent's project directory
11. SOUL.md is pre-filled with agent name and default trait-level descriptions
12. NOPE.md is pre-filled with section headers only

### Phase 4: Multi-Runtime Extension (Future)

13. Add optional `applyPersona?(persona, agentPath): Promise<void>` to `AgentRuntime` interface
14. Implement for OpenCode (writes `.opencode/agents/*.md`)
15. Implement for Codex (prepends to project AGENTS.md)

---

## Research Gaps & Limitations

- **OpenCode runtime specifics**: The exact file format for `.opencode/agents/*.md` and how the frontmatter schema interacts with DorkOS persona injection was not fully verified against the latest OpenCode source.
- **NOPE.md official spec**: The `nope-md.vercel.app` project's exact file format and whether it defines a machine-readable schema (e.g., YAML frontmatter with structured categories) was not fetched — the prior research confirmed it exists but did not document its internal format.
- **Claude Agent SDK SOUL.md awareness**: Claude Code does not natively read SOUL.md. The DorkOS injection is programmatic via `systemPrompt.append`. This is correct for DorkOS's architecture but means SOUL.md would be ignored if a user runs Claude Code directly (not through DorkOS) in the same project directory.
- **Trait dimension validation**: The five proposed coding-agent-specific dimensions (Tone, Autonomy, Caution, Communication, Creativity) have not been user-tested with Kai-persona users. They are informed by product intuition, not user research.

---

## Contradictions & Disputes

- **File-read per session vs manifest cache**: This report recommends per-request SOUL.md reads for MVP simplicity, while ADR-0043 and the existing codebase favor manifest-as-fast-path. The tension resolves because SOUL.md is a new concept that doesn't yet have manifest representation for its raw content — using the manifest fast-path requires the reconciler to sync SOUL.md → manifest, which adds complexity. For MVP, the file read is simpler and still performant.

- **Trait sliders vs freeform prose**: OpenAI moved from freeform to presets; CrewAI uses freeform prose. DorkOS chooses a hybrid (sliders generate prose; prose is always directly editable). This is the correct resolution for a technical audience — Kai wants knobs, Priya wants to see and edit the resulting text.

---

## Sources & Evidence

- [OpenCode agents docs](https://opencode.ai/docs/agents/) — OpenCode agent prompt configuration via markdown files and opencode.json
- [OpenCode system prompt pipeline gist](https://gist.github.com/rmk40/cde7a98c1c90614a27478216cc01551f) — Detailed reverse-engineering of OpenCode's `prompt.ts` assembly pipeline
- [Codex CLI custom prompts (deprecated)](https://developers.openai.com/codex/custom-prompts) — History of Codex custom prompt system; AGENTS.md as current mechanism
- [Codex CLI features](https://developers.openai.com/codex/cli/features) — Codex instruction injection patterns
- [Aider system prompt issues #1258](https://github.com/Aider-AI/aider/issues/1258) — No official system prompt injection; community workarounds
- [Aider system-prompt-extras proposal #4817](https://github.com/Aider-AI/aider/issues/4817) — Proposed `--system-prompt-extras` flag
- [Convai personality trait docs](https://docs.convai.com/api-docs/convai-playground/character-customization/personality-traits) — 5 Big Five dimensions, 0-4 slider scale
- [Inworld AI personality docs](https://docs.inworld.ai/docs/tutorial-basics/personality-emotion/) — 10 sliders, freeform trait text, emotional fluidity control
- [OpenAI prompt personalities cookbook](https://developers.openai.com/cookbook/examples/gpt-5/prompt_personalities) — Four personality archetypes (Professional, Efficient, Fact-Based, Exploratory) mapped to paired instruction sets
- [OpenAI ChatGPT personalization](https://help.openai.com/en/articles/11899719-customizing-your-chatgpt-personality) — Preset + Characteristics system for GPT-5
- [CrewAI agents docs](https://docs.crewai.com/en/concepts/agents) — Role/Goal/Backstory persona model
- [OpenClaw system prompt docs](https://docs.openclaw.ai/concepts/system-prompt) — Bootstrap file injection order; advisory safety semantics
- [Penligent SOUL.md security research](https://www.penligent.ai/hackinglabs/the-openclaw-prompt-injection-problem-persistence-tool-hijack-and-the-security-boundary-that-doesnt-exist/) — SOUL.md persistence attack vector via agent self-modification
- [Sequential Adaptive Steering arxiv 2603.03326](https://arxiv.org/html/2603.03326) — Controllable Big Five personality sliders at inference time via activation steering
- [agentmd PyPI](https://pypi.org/project/agentmd/) — `agentmd init` scaffolding tool for AGENTS.md
- [create-ai-agent DEV article](https://dev.to/webbywisp/how-i-structure-my-ai-agent-workspace-and-why-it-matters-j13) — SOUL.md, USER.md, OPS.md, MEMORY.md workspace file set
- Prior research: `research/20260218_agent-sdk-context-injection.md` — Claude Agent SDK `systemPrompt.append` mechanism and `settingSources`
- Prior research: `research/20260303_agent_tool_context_injection.md` — Static XML blocks in `context-builder.ts`, token budget, static vs dynamic injection decision
- Prior research: `research/20260321_openclaw_ai_convention_markdown_files.md` — SOUL.md / NOPE.md landscape, convention file formats
- Codebase: `apps/server/src/services/runtimes/claude-code/context-builder.ts` — Current `buildAgentBlock()` implementation
- Codebase: `packages/shared/src/mesh-schemas.ts` — `AgentManifestSchema` with `persona` and `personaEnabled` fields
- Codebase: `packages/shared/src/agent-runtime.ts` — `MessageOpts.systemPromptAppend` and `AgentRuntime` interface

---

## Search Methodology

- Searches performed: 16
- Most productive search terms: "OpenCode agents system prompt markdown file", "OpenAI prompt personalities cookbook", "Convai personality traits slider dimensions", "agent workspace scaffolding SOUL.md AGENTS.md generator", "SOUL.md NOPE.md system prompt injection runtime"
- Primary information sources: opencode.ai docs, developers.openai.com, docs.convai.com, docs.inworld.ai, docs.openclaw.ai, arxiv.org, GitHub issues
- Prior research consulted: 3 existing reports — all highly relevant, narrowed search to gaps only
