# Agent Personality & Convention Files

**Spec #159** | Created: 2026-03-21 | Status: brief

## Problem

DorkOS agents currently have no personality layer, no safety boundary configuration, and no way to create new agent workspaces from the UI. The broader AI agent ecosystem is converging on markdown convention files (SOUL.md, NOPE.md, AGENTS.md) as standards for agent personality, safety, and operational rules. DorkOS should adopt the conventions that are becoming standards while they're still early, giving users a familiar and portable agent configuration experience.

## Goals

1. **Support convention files** — Adopt `SOUL.md` (personality) and `NOPE.md` (safety boundaries) as first-class agent configuration files in DorkOS.
2. **Personality sliders** — Let users tune agent personality traits via sliders (5 levels each), stored as structured data in `agent.json`, rendered into natural language at injection time.
3. **Agent creation** — Allow users to create new agent workspaces from the DorkOS UI, with scaffolded convention files.
4. **Optional and toggleable** — Convention files can be enabled/disabled per agent. Users who don't want them aren't affected.

## Non-Goals

- Adopting `AGENTS.md` as a DorkOS convention file (Claude Code already reads `CLAUDE.md`; wait for native `AGENTS.md` support).
- Adopting `IDENTITY.md` (covered by `agent.json` structured data).
- Adopting `MEMORY.md` (Claude Code's `.claude/memory/` already serves this purpose).
- Two-way sync between sliders and prose (they compose as layers, not mirror each other).

## Key Decisions & Constraints

### Convention Files to Adopt

| File      | Purpose                                               | Standard Origin                           |
| --------- | ----------------------------------------------------- | ----------------------------------------- |
| `SOUL.md` | Agent personality, values, tone, behavioral style     | OpenClaw / standalone open-source project |
| `NOPE.md` | Hard safety boundaries — what the agent must never do | `nope-md.vercel.app` open standard        |

### File Location

Convention files live in the agent's `.dork/` directory alongside `agent.json`:

```
{agent-root}/.dork/
├── agent.json       # Structured config (traits, toggles, metadata)
├── SOUL.md          # Personality (trait-rendered + hand-written prose)
└── NOPE.md          # Safety boundaries
```

**Open question:** Should filenames be uppercase (`SOUL.md`, `NOPE.md`) or lowercase (`soul.md`, `nope.md`)? The upstream standards use uppercase. Keeping uppercase maintains ecosystem compatibility and makes the files visually distinct from regular project documentation. **Recommendation: uppercase**, matching the upstream conventions and consistent with `CLAUDE.md`.

### Agent Default Location

New agents created from the DorkOS UI default to `~/.dork/agents/{agent-name}/`. However, users can choose any directory — the UI should allow manual path selection during creation. Project-scoped agents continue to live in their project directory.

**Open question for future consideration:** If the agent root is `~/.dork/agents/my-agent/`, the convention files would be at `~/.dork/agents/my-agent/.dork/SOUL.md`. This nested `.dork` pattern is consistent with project-scoped agents but may feel redundant for the global agents directory. Acceptable for consistency.

### Injection Strategy

Convention file content is injected into the agent's system prompt at session start. **The agent runtime is responsible for injection** — not the client, not a middleware layer. This is critical for multi-runtime support:

- Claude Code runtime: uses Agent SDK `system` parameter (or equivalent)
- Future runtimes (OpenCode, Codex, etc.): each runtime implements its own injection path
- The `AgentRuntime` interface should define a convention-file injection contract

This ensures each runtime can handle injection in whatever way its SDK supports, without DorkOS assuming a single injection mechanism.

### Per-Agent Toggles & Editing

All convention files and personality settings are managed through the **agent settings dialog** in the DorkOS UI. Users can, at any time:

- **Toggle injection on/off** per file (SOUL.md, NOPE.md) — the file stays on disk but isn't injected when disabled
- **View and edit file contents** inline — a markdown editor for each convention file, directly in the settings dialog
- **Adjust personality sliders** — changes take effect on the next session (no restart required)

```jsonc
// agent.json
{
  "name": "shipping-agent",
  "conventions": {
    "soul": true, // inject SOUL.md into system prompt
    "nope": true, // inject NOPE.md into system prompt
  },
}
```

`false` = file exists on disk but is not injected. Users can draft/preview files without them going live, then flip the toggle when ready.

### Personality Sliders

**5 levels per trait**, stored as integers 1-5 in `agent.json`:

```jsonc
// agent.json
{
  "traits": {
    "humor": 3, // 1-5 scale
    "formality": 2,
    "verbosity": 3,
    "autonomy": 4,
    "risk": 2,
  },
}
```

**Trait level descriptions (example — humor):**

| Level | Label    | Rendered Directive                                                                                       |
| ----- | -------- | -------------------------------------------------------------------------------------------------------- |
| 1     | None     | "Never tell jokes. You have no sense of humor. All communication is dead serious."                       |
| 2     | Minimal  | "Keep humor rare. The occasional dry observation is fine, but default to straightforward communication." |
| 3     | Balanced | "Use humor when it fits naturally. Be personable but don't force it."                                    |
| 4     | Frequent | "Be witty and playful. Use humor to make interactions engaging and memorable."                           |
| 5     | Maximum  | "You're beyond unserious. Everything is a joke. Life is comedy and you are the comedian."                |

**Rendering approach:** Template-based, no LLM calls. Each trait has 5 pre-written directives. The trait renderer concatenates applicable directives into a personality block, which is prepended to any custom `SOUL.md` prose.

**Composition model:** Sliders set the baseline personality. Custom `SOUL.md` prose adds specifics. They don't conflict because they operate at different levels of abstraction:

- Sliders → "how" the agent communicates
- SOUL.md prose → "who" the agent is and what it cares about

### Proposed Traits

| Trait     | Low (1)           | High (5)            | Controls                                         |
| --------- | ----------------- | ------------------- | ------------------------------------------------ |
| Humor     | Dead serious      | Everything's a joke | Playfulness, wit, levity                         |
| Formality | Very casual       | Very formal         | Language register, contractions, emoji           |
| Verbosity | Terse             | Expansive           | Response length, detail level, explanation depth |
| Autonomy  | Ask everything    | Act independently   | Decision-making style, confirmation frequency    |
| Risk      | Very conservative | Very bold           | Willingness to try unconventional approaches     |

**Open question:** Are these 5 the right traits? Other candidates: creativity, directness/diplomacy, emoji usage, technical depth. Keeping the set small (5-7) prevents decision fatigue.

## UI: Agent Settings Dialog

The agent settings dialog is the single surface for all personality and convention file management. Everything is editable at any time — no need to leave the dialog or edit files on disk manually.

### Layout

```
┌──────────────────────────────────────────────────┐
│  Agent Settings: shipping-agent            [Save] │
│                                                   │
│  ┌─ Personality Traits ────────────────────────┐  │
│  │                                             │  │
│  │  Humor       ──●──────────── 2/5  Minimal   │  │
│  │  Formality   ────●────────── 3/5  Balanced  │  │
│  │  Verbosity   ──●──────────── 2/5  Minimal   │  │
│  │  Autonomy    ──────────●──── 4/5  Frequent  │  │
│  │  Risk        ────●────────── 3/5  Balanced  │  │
│  │                                             │  │
│  └─────────────────────────────────────────────┘  │
│                                                   │
│  ┌─ Custom Instructions (SOUL.md) ───── [✓ On] ┐  │
│  │ ┌─────────────────────────────────────────┐ │  │
│  │ │ You are a shipping-focused              │ │  │
│  │ │ engineering agent. You care             │ │  │
│  │ │ deeply about getting features           │ │  │
│  │ │ out the door...                         │ │  │
│  │ │                                         │ │  │
│  │ └─────────────────────────────────────────┘ │  │
│  └─────────────────────────────────────────────┘  │
│                                                   │
│  ┌─ Safety Boundaries (NOPE.md) ──────── [✓ On] ┐  │
│  │ ┌─────────────────────────────────────────┐ │  │
│  │ │ Never push to main without              │ │  │
│  │ │ explicit approval. Never delete         │ │  │
│  │ │ production data...                      │ │  │
│  │ │                                         │ │  │
│  │ └─────────────────────────────────────────┘ │  │
│  └─────────────────────────────────────────────┘  │
│                                                   │
│  [Preview injected prompt ▾]                      │
└───────────────────────────────────────────────────┘
```

### Behaviors

- **Sliders** update `agent.json` traits on save. Each slider shows the current level label (None / Minimal / Balanced / Frequent / Maximum) beside the value.
- **Convention file editors** are inline markdown text areas. Edits save to the actual `.dork/SOUL.md` and `.dork/NOPE.md` files on disk.
- **Toggle switches** (`[✓ On]` / `[○ Off]`) control whether each file is injected. When off, the editor remains visible (for drafting) but the content is not sent to the agent. The toggle maps to `conventions.soul` / `conventions.nope` in `agent.json`.
- **Preview injected prompt** expands to show the fully rendered system prompt injection — trait directives + custom SOUL.md prose + NOPE.md safety block. Full transparency for Priya.
- **All changes take effect on the next session** — no agent restart required. Existing sessions continue with their original prompt until a new session starts.

## Injection Pipeline

```
agent.json (traits 1-5) ──→ trait renderer ──→ personality directives
                                                       │
SOUL.md (custom prose) ────────────────────────────────┤
                                                       ▼
                                              combined personality block
                                                       │
NOPE.md (safety rules) ──→ safety block ───────────────┤
                                                       ▼
                                          AgentRuntime.injectConventions()
                                                       │
                                                       ▼
                                              system prompt injection
                                          (runtime-specific implementation)
```

## Multi-Runtime Consideration

DorkOS will support multiple agent runtimes (Claude Code first, then OpenCode, Codex, etc.). The convention file system must be runtime-agnostic:

- Convention files are read by DorkOS core, not by the runtime SDK
- The `AgentRuntime` interface defines how personality/safety content gets injected
- Each runtime adapter translates the convention content into its SDK's injection mechanism
- The trait rendering and file reading happen once, upstream of the runtime layer

## Research

- [OpenClaw and AI Convention Files](../../research/20260321_openclaw_ai_convention_markdown_files.md) — comprehensive analysis of the convention file landscape
- [NOPE.md](https://nope-md.vercel.app/) — open-standard security boundary framework
- [SOUL.md](https://github.com/aaronjmars/soul.md) — standalone personality definition standard
- [AGENTS.md](https://agents.md/) — cross-tool universal standard (Linux Foundation)

## Phasing (Suggested)

1. **Phase 1: Agent creation + folder scaffolding** — Create agent workspaces from UI, scaffold `agent.json` + convention files
2. **Phase 2: Convention file injection** — Runtime reads and injects SOUL.md/NOPE.md at session start, with per-agent toggles
3. **Phase 3: Personality sliders** — Trait UI, template rendering, composition with custom prose
