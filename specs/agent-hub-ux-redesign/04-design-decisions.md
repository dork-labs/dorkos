# Design Decisions

Visual companion session: `.dork/visual-companion/7057-1776029581/`

## 1. Overall Layout Structure

**Screen:** `current-vs-proposed.html`
**Options:**
A) Current — left-nav sidebar with 6 tabs inside right panel (panel-within-a-panel)
B) Proposed — identity hero header + 3 horizontal tabs + full-width scrollable content

**Chosen:** B — The current left-nav layout violates NNGroup's explicit warning against vertical tabs in narrow panels. The proposed layout eliminates the panel-within-a-panel anti-pattern, gives content the full panel width, and follows the industry standard (VS Code, Linear, Figma).

## 2. Config Tab Design Direction

**Screen:** `config-tab-design.html`
**Options:**
A) System Prompt First — system instructions expanded by default, personality sliders collapsed, 6 accordion sections
B) Visual Personality + System Prompt — radar chart personality fingerprint at top, system prompt below, 5 accordion sections

**Chosen:** B — The radar chart makes personality tangible and visually distinctive. System prompts are important but secondary to the visual personality controls.

## 3. Config Tab Delight Level

**Screen:** `config-tab-delightful.html`
**Options:**
A) Presets + Radar + Fine-tune — preset cards in a 2x2 grid, radar chart, sliders for fine-tuning
B) Personality Theater — animated breathing radar chart, named archetypes with gradient text and taglines, horizontal preset pills, live response preview bubble

**Chosen:** B (Personality Theater) — User directive: "We want to make our system very easy to use, and feel cool. You could even take it a step further. Let's think about opportunities to delight and surprise users." System prompts should be "secondary or even advanced." Presets should be "fast and easy" with "fun" names.

## 4. Profile Tab Content

**Screen:** `profile-tab-v2.html`
**Changes from initial mockup:**

1. Hero header shows agent runtime (`claude-code`) instead of LLM model (`claude-3.5-sonnet`)
2. "Agent Runtime" dropdown selector replaces "Model" picker — runtime manages its own model internally
3. New "Directory" field showing agent CWD with folder icon, monospace font, tilde-shortened path

**Rationale:** User specified: "users should select the agent that they want to use, and not the model" and "we should show the folder/directory the agent is in."

## 5. Personality Preset Names

**Screen:** `full-agent-hub-experience.html` (preset showcase at bottom)
**Final set:**

- Balanced (default) — The default. Steady, reliable, explains when it matters.
- The Hotshot — Ship fast, explain later. Turns caffeine into commits.
- The Sage — Teaches as it works. Every answer is a lesson.
- The Sentinel — Measure twice, cut once. Asks before every action.
- The Phantom — You'll barely know it's there. Pure silent execution.
- Mad Scientist — Wild ideas, unexpected solutions. Thrives on chaos.

**Chosen:** All six approved. User wanted "fun" preset names that make configuration "fast and easy."

## Final Design Summary

### Three-Zone Architecture

**Zone 1: Identity Hero Header** (non-scrolling)

- 52px avatar with status ring (green = online)
- Agent name, runtime label, status
- 7-day activity sparkline with session count

**Zone 2: Horizontal Tab Bar** (3 tabs)

- Profile | Sessions | Config
- Active tab has purple underline indicator

**Zone 3: Scrollable Content** (per-tab)

### Profile Tab

- Display name (inline-editable)
- Description (textarea, inline-editable)
- Agent Runtime (dropdown: claude-code, openai-assistant, etc.)
- Directory (monospace path, tilde-shortened)
- Tags (pill chips + add)
- Stats row (sessions, channels, tasks run)

### Sessions Tab

- Scheduled tasks at top with time badges
- Active sessions with green dot + LIVE badge
- Past sessions grouped by time period
- Tasks and sessions unified in one view

### Config Tab (Personality Theater)

- Animated breathing radar chart (5 personality axes)
- Named archetype in gradient text with tagline
- Preset pill selector (6 presets + Custom)
- "How this agent talks" — response preview bubble
- Collapsed accordion sections: Tools & MCP, Channels, Advanced (SOUL.md, NOPE.md, limits)
