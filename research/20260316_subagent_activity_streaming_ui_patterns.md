---
title: 'Subagent Activity & Streaming UI Patterns — Inline Display, Collapsible Blocks, Tool Summaries'
date: 2026-03-16
type: external-best-practices
status: active
tags:
  [
    subagent,
    streaming,
    tool-calls,
    collapsible,
    aria,
    animation,
    chat-ui,
    agent-activity,
    task-tool,
  ]
searches_performed: 14
sources_count: 28
---

# Subagent Activity & Streaming UI Patterns

## Research Summary

This report covers four concrete questions: (1) how Claude Code CLI visually surfaces subagent/Task tool activity in the terminal, (2) how Devin, GitHub Copilot, and other tools display parallel/nested agent execution, (3) best practices for collapsible inline blocks in streaming chat UIs with full accessibility and animation coverage, and (4) patterns for extracting and summarizing tool usage into human-readable activity digests. The SDK's event stream contains all necessary signals — `tool_use` blocks named `"Agent"` (previously `"Task"`) and `parent_tool_use_id` on subagent messages. The industry has converged on a small set of patterns: a collapsible disclosure widget (collapsed by default once done, expanded while live), a status line with elapsed time, and a compact activity summary badge. CSS `grid-template-rows: 0fr → 1fr` is the dominant no-JS-height trick for streaming collapsibles. The ARIA contract is `button[aria-expanded] + div[role=region][id=X]`.

---

## Key Findings

### 1. Claude Code CLI — What the User Sees for Subagents

**The terminal display during Task tool / Agent tool invocation:**

Claude Code's CLI renders subagent activity as indented output under the invoking context. The community tool `claude-esp` (which intercepts Claude Code's hidden output) confirms the visual hierarchy: a session-level tree with `Main` and `Agent` nodes, using tree-drawing characters (`├──`, `└──`) for nesting.

The official SDK documentation reveals the exact event stream signals:

```
tool_use block  →  name: "Agent" (current) or "Task" (legacy, pre v2.1.63)
                   input.subagent_type: "general-purpose" | "code-reviewer" | etc.
                   input.description: the task description
                   id: "toolu_01..."

Messages from within a subagent context include:
  parent_tool_use_id: "toolu_01..." (links back to the Agent tool_use block)
```

**Background task display format** (from DEV.to analysis):

```
Background Tasks:
  ⏳ ac88940: Research Laravel packages (running, 18 min)
  ✓  ac88941: Run test suite (completed, 3 min ago)
```

The ID, description, status (`running`/`completed`), and elapsed time are the four data points shown. There is no live streaming of subagent token output to the parent terminal — users only see the final result when the subagent completes.

**Key limitation (GitHub issue #27916):** There is currently no persistent active-subagent counter in the CLI status line. The community has explicitly requested this. The feature request asks for something like `[2 subagents active]` alongside the existing context window metrics.

**The `⎿` character** appears in Claude Code's terminal output as the "return" indicator for nested tool results — it's the U+23BF (HELM SYMBOL) used to show the result coming back from a tool call indented under the tool invocation.

**What the event stream gives a custom UI** (from the Anthropic SDK docs):

```typescript
// Detecting subagent invocation in the stream
for await (const message of query({ ... })) {
  const msg = message as any;

  // Parent sees this when spawning a subagent:
  for (const block of msg.message?.content ?? []) {
    if (block.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task')) {
      // Subagent spawned:
      // block.id          = tool use ID (link back-ref for subagent messages)
      // block.input.description = human-readable task description
      // block.input.subagent_type = agent name/type
    }
  }

  // Messages FROM within a subagent have:
  if (msg.parent_tool_use_id) {
    // This message comes from inside a subagent context
    // msg.parent_tool_use_id links to the Agent tool_use block.id above
  }
}
```

**The result comes back as a tool_result block** in the parent's next turn, containing the subagent's final message verbatim (or summarized if the parent chose to summarize).

---

### 2. How Competing Tools Display Parallel/Nested Agent Activity

#### GitHub Copilot — `/fleet` Command + Mission Control

The `/fleet` command in GitHub Copilot CLI is the most direct parallel to DorkOS's multi-subagent scenarios:

- The orchestrator agent analyzes the prompt, decomposes it into subtasks, and determines parallelism based on dependencies
- **Mission Control UI**: Shows "which agent tasks are running, review their progress, intervene when they stall, and approve the resulting PRs without switching between dozens of tabs"
- **Chat view session list**: Shows status, progress, and file change statistics at a glance, with archive/unarchive for long-running work
- VS Code 1.107 (Nov 2025) introduced multi-agent orchestration with a session list showing: agent name, status badge, progress indicator, file change count

**Key visual elements confirmed:**

- Each subagent gets its own expandable session entry
- Status is live-updated (running / stalled / complete)
- File change count is surfaced as a "cost" metric
- PRs are surfaced inline for review without leaving the agent view

#### Devin 2.0

- Each Devin instance runs in its own isolated cloud VM
- The **parallel Devins panel** shows N simultaneous instances, each with their own IDE view
- Live architectural diagrams update as the agent works
- The UI model is tabs/cards — each agent is a card you can click into for full live detail
- No "collapsed summary" pattern — Devin goes the opposite direction with maximum transparency (every agent gets its own full-screen IDE)

#### Claude.ai Extended Thinking

The "thinking" block in Claude.ai is the closest existing precedent for DorkOS's needs:

- **During streaming**: A "Thinking..." header with a live timer appears (e.g., "Thinking for 12s")
- **After completion**: The header changes to "Thought for 12s" and becomes clickable
- **Collapsed by default** once thinking is done — the user can expand to read the reasoning
- **Progressive disclosure**: The summary header remains always visible; full content is behind expand

This is exactly the pattern for subagent blocks in a chat UI.

#### Perplexity AI Deep Research

Perplexity uses a sidebar progress panel for multi-step research, showing:

- Stage label: "Interpreting query" → "Searching" → "Synthesizing"
- Live count: "Searched 47 sources"
- Elapsed time per stage
- The final report collapses the progress panel automatically

**Summary format** that surfaces the aggregate: "Searched 47 sources · 2m 14s"

#### ChatGPT Deep Research

- Real-time progress updates inline in the conversation
- Live stage updates ("Reading...", "Analyzing...", "Writing report...")
- Users can interrupt mid-research to refine focus
- Final report format includes footnotes + clickable citations + a collapsible source list

---

### 3. Collapsible Inline Blocks — Accessibility + Animation + Performance

#### The ARIA Contract

The correct semantic structure for a collapsible activity block:

```html
<!-- The trigger button -->
<button
  aria-expanded="false"
  aria-controls="subagent-block-toolu_01"
  type="button"
  class="..."
>
  <span>code-reviewer</span>
  <span aria-hidden="true">▶</span>  <!-- chevron icon -->
</button>

<!-- The controlled region -->
<div
  id="subagent-block-toolu_01"
  role="region"
  aria-label="code-reviewer subagent activity"
  hidden  <!-- use hidden attr when collapsed, not just CSS; remove when expanded -->
>
  <!-- activity content -->
</div>
```

**Critical rules from W3C WAI-ARIA:**

- `aria-expanded` lives on the **button** (the control), NOT on the region
- `aria-controls` on the button points to the `id` of the region
- `role="region"` on the region requires an accessible name (`aria-label` or `aria-labelledby`)
- Screen readers announce state changes when `aria-expanded` toggles
- Using `hidden` attribute (not just `display:none`) is the most reliable cross-reader approach; the `hidden` attribute maps to `aria-hidden` semantically and prevents all AT access

**Keyboard behavior requirements:**

- `Enter` or `Space` on the button triggers expand/collapse
- Focus must not be trapped inside the region — only on the button
- The region itself is not focusable; its contents are (normal tab order)

#### Animation: The CSS Grid Rows Trick (Recommended)

Height animation is the hardest part of collapsible streaming content because:

1. `height: auto` is not animatable with CSS transitions directly
2. Animating `height: Xpx` requires measuring DOM height (JavaScript)
3. Content is **growing dynamically** during streaming — any height measurement is stale instantly

**The grid rows trick (no JS needed, GPU-composited):**

```css
/* Wrapper element */
.collapsible-wrapper {
  display: grid;
  grid-template-rows: 0fr; /* collapsed: 0 height */
  transition: grid-template-rows 280ms cubic-bezier(0.4, 0, 0.2, 1);
}

.collapsible-wrapper.is-open {
  grid-template-rows: 1fr; /* expanded: full auto height */
}

/* Inner element must have overflow: hidden */
.collapsible-inner {
  overflow: hidden;
  /* min-height: 0 required in some browsers */
  min-height: 0;
}
```

**Why this works for streaming content:**

- `1fr` resolves to the _current_ content height at any point in time
- As streaming text is appended, `1fr` auto-expands — no re-measurement needed
- `grid-template-rows` is GPU-composited (uses FLIP internally in modern browsers)
- No layout thrash because the transition is on the **row sizing**, not on `height`
- Browser support: Chrome 107+, Firefox 116+, Safari 16+ (all modern browsers)

**With motion.dev for DorkOS's existing animation system:**

```tsx
// In motion.dev, use the `layout` prop — it handles height changes via FLIP
<motion.div
  initial={false}
  animate={{ height: isOpen ? 'auto' : 0 }}
  transition={{ type: 'spring', stiffness: 280, damping: 32 }}
  style={{ overflow: 'hidden' }}
>
  {/* streaming content */}
</motion.div>
```

Or using the `layout` prop approach which avoids measuring:

```tsx
// Parent uses layout prop to adapt to content size changes
<motion.div layout style={{ overflow: 'hidden' }}>
  {isOpen && <SubagentContent />}
</motion.div>
```

**Caveat**: `height: auto` animation in motion.dev (and CSS) works for collapse-then-expand. The challenge is **streaming into an already-open block** — as new tokens arrive, the block grows naturally (no animation needed on growth, just on the open/close transition).

#### Performance: Streaming Into a Collapsed Region

The specific problem: if a subagent is streaming tokens while the block is collapsed, appending to `display:none` or `visibility:hidden` content is fine (no layout), but measuring height for animation is expensive.

**Recommendation: Never animate height during streaming — only on user-triggered expand/collapse:**

```tsx
// State:
// isStreaming: boolean — subagent is still running
// isExpanded: boolean — user has toggled it open
// hasEverStreamed: boolean — at least one token has arrived

// Behavior:
// - While streaming: block is OPEN (auto-expanded), no animation
// - User collapses while streaming: allowed, but use instant snap (no animation)
// - After streaming complete: user can collapse/expand with full animation
// - Default state after completion: collapsed (shows summary only)

const shouldAnimate = !isStreaming;
const collapseTransition = shouldAnimate
  ? { type: 'spring', stiffness: 280, damping: 32 }
  : { duration: 0 }; // instant snap during active streaming
```

**The "render into hidden region" problem:**

When streaming tokens are appended to a `hidden` region (collapsed), the browser still runs layout for those DOM updates — it just doesn't paint them. This is fine for text content. The risk is if you have expensive components (charts, images) streaming into a hidden region that trigger heavy layout work.

For plain text streaming (the DorkOS case), this is a non-issue — text rendering is cheap even when not visible.

#### The Scroll Lock Problem (From assistant-ui's ReasoningGroup)

When a long collapsible block collapses, the page may scroll unexpectedly because the DOM height shrinks suddenly. `assistant-ui` explicitly implements "scroll lock" in their `ReasoningGroup` component to prevent this.

**The pattern:**

```typescript
// Before collapsing, record the distance from the bottom of the viewport
const scrollLock = () => {
  const scrollBottom = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;

  return () => {
    // After animation, restore the bottom-relative scroll position
    window.scrollTo({
      top: document.documentElement.scrollHeight - window.innerHeight - scrollBottom,
      behavior: 'instant',
    });
  };
};

// In collapse handler:
const restoreScroll = scrollLock();
setIsOpen(false);
requestAnimationFrame(restoreScroll);
```

This is a critical pattern for chat UIs where the user is typically scrolled to the bottom.

---

### 4. Extracting and Summarizing Tool Usage from a Content Block Stream

#### The Signal: What the SDK Emits

Every tool call in the SDK event stream emits two blocks:

```typescript
// 1. Tool invocation (when Claude calls a tool):
{ type: 'tool_use', id: 'toolu_01...', name: 'Read', input: { file_path: '/src/foo.ts' } }

// 2. Tool result (when the tool returns):
{ type: 'tool_result', tool_use_id: 'toolu_01...', content: '...file content...' }
```

For the DorkOS JSONL stream, the relevant tool names are the standard Claude Code tools:
`Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, `Agent` (subagent invocation), and DorkOS MCP tools (`mcp__dorkos__*`).

#### Bucketing Strategy for Summary Generation

Group by semantic category, not by tool name:

```typescript
type ToolCategory =
  | 'files_read' // Read, Glob, Grep
  | 'files_written' // Write, Edit
  | 'commands_run' // Bash
  | 'searches' // WebSearch, Grep (web)
  | 'web_fetches' // WebFetch
  | 'subagents_spawned' // Agent / Task
  | 'mcp_calls'; // mcp__dorkos__*

function categorizeToolCall(name: string): ToolCategory | null {
  if (['Read', 'Glob'].includes(name)) return 'files_read';
  if (name === 'Grep') return 'files_read'; // file grep
  if (['Write', 'Edit'].includes(name)) return 'files_written';
  if (name === 'Bash') return 'commands_run';
  if (name === 'WebSearch') return 'searches';
  if (name === 'WebFetch') return 'web_fetches';
  if (name === 'Agent' || name === 'Task') return 'subagents_spawned';
  if (name.startsWith('mcp__dorkos__')) return 'mcp_calls';
  return null;
}
```

#### Summary Format: Two Tiers

**Tier 1 — Inline badge (always visible when collapsed):**

```
Read 12 files · Ran 3 searches · 1 subagent
```

Rules:

- Only show categories with count > 0
- File reads and writes separate: "Read 12, wrote 3" — users care about mutations
- "1 subagent" vs "3 subagents" — concise, no verb needed for subagents
- Separator is `·` (middle dot)
- Max 3–4 categories; if more, truncate to top-3 by count + "and more"

**Tier 2 — Expanded detail (inside the collapsible):**

```
Files read (12)
  ├ src/components/MessageItem.tsx
  ├ src/components/SessionItem.tsx
  └ +10 more

Bash commands (2)
  ├ pnpm test --run
  └ pnpm typecheck

Subagents (1)
  └ code-reviewer — "Review authentication module" [completed 12s]
```

Show filenames for the first 2–3 items; "+N more" for the rest.

#### Building the Summary Incrementally

Since DorkOS streams content blocks in real time, the summary must be built incrementally without a final "pass":

```typescript
interface ToolCallAccumulator {
  counts: Record<ToolCategory, number>;
  // Per-category samples (first 3 items only — rest are counted but not stored)
  samples: Record<ToolCategory, string[]>;
  subagents: Array<{
    id: string;
    description: string;
    status: 'running' | 'completed' | 'failed';
    elapsedMs: number;
    startedAt: number;
  }>;
}

function formatSummaryBadge(acc: ToolCallAccumulator): string {
  const parts: string[] = [];

  const filesRead = acc.counts.files_read ?? 0;
  const filesWritten = acc.counts.files_written ?? 0;
  const commands = acc.counts.commands_run ?? 0;
  const searches = acc.counts.searches ?? 0;
  const webFetches = acc.counts.web_fetches ?? 0;
  const subagents = acc.counts.subagents_spawned ?? 0;

  if (filesRead > 0) parts.push(`Read ${filesRead} file${filesRead === 1 ? '' : 's'}`);
  if (filesWritten > 0) parts.push(`Wrote ${filesWritten} file${filesWritten === 1 ? '' : 's'}`);
  if (commands > 0) parts.push(`Ran ${commands} command${commands === 1 ? '' : 's'}`);
  if (searches > 0) parts.push(`${searches} search${searches === 1 ? '' : 'es'}`);
  if (webFetches > 0) parts.push(`Fetched ${webFetches} URL${webFetches === 1 ? '' : 's'}`);
  if (subagents > 0) parts.push(`${subagents} subagent${subagents === 1 ? '' : 's'}`);

  return parts.slice(0, 3).join(' · ') + (parts.length > 3 ? ' · and more' : '');
}
```

**Live updating during streaming:**

The badge re-renders on every new `tool_use` block — this is fine because React's reconciler will only update the text node that changed. No special memoization needed; the accumulator is a lightweight object.

#### Subagent-Specific Summary Fields

Subagents need richer treatment in the summary because they have lifecycle:

```typescript
// When Agent tool_use block arrives (subagent spawned):
acc.subagents.push({
  id: block.id,
  description: block.input.description ?? block.input.subagent_type ?? 'subagent',
  status: 'running',
  startedAt: Date.now(),
  elapsedMs: 0,
});

// Every tick while subagent messages have parent_tool_use_id === block.id:
// Update elapsedMs for the matching subagent entry

// When tool_result arrives with matching tool_use_id:
const subagent = acc.subagents.find((s) => s.id === block.tool_use_id);
if (subagent) {
  subagent.status = 'completed';
  subagent.elapsedMs = Date.now() - subagent.startedAt;
}
```

---

## Detailed Analysis

### The Full Subagent Block Component Design

Combining all findings, here is the concrete component shape for DorkOS:

```
┌─────────────────────────────────────────────────────────┐
│ ▶ code-reviewer · running                              ⏱ 8s │  ← collapsed header, animated spinner
└─────────────────────────────────────────────────────────┘
```

While streaming (expanded, no animation — just opens):

```
┌─────────────────────────────────────────────────────────┐
│ ▼ code-reviewer · running                              ⏱ 8s │
├─────────────────────────────────────────────────────────┤
│  Read 7 files · 2 Grep searches                         │
│                                                         │
│  Reading src/auth/session.ts...                         │  ← live streaming text
│  ▋                                                      │  ← blinking cursor
└─────────────────────────────────────────────────────────┘
```

After completion (collapsed back to summary):

```
┌─────────────────────────────────────────────────────────┐
│ ▶ code-reviewer · completed                           14s │
│   Read 12 files · Ran 1 command                         │  ← summary badge
└─────────────────────────────────────────────────────────┘
```

User expands after completion:

```
┌─────────────────────────────────────────────────────────┐
│ ▼ code-reviewer · completed                           14s │
├─────────────────────────────────────────────────────────┤
│  Files read (12)                                        │
│    src/auth/session.ts                                  │
│    src/auth/tokens.ts                                   │
│    +10 more                                             │
│                                                         │
│  Commands (1)                                           │
│    pnpm audit                                           │
│                                                         │
│  Result:                                                │
│  Found 2 potential SQL injection vectors in session.ts  │
│  lines 47 and 89. Recommend parameterized queries.      │
└─────────────────────────────────────────────────────────┘
```

### Auto-Expand / Auto-Collapse State Machine

```
State:
  IDLE          → no subagent activity
  SPAWNED       → Agent tool_use block arrived; block opens immediately
  RUNNING       → parent_tool_use_id messages arriving; content streaming
  COMPLETED     → tool_result block arrived; auto-collapses after 1.5s delay
  USER_EXPANDED → user clicked to re-expand after completion; stays open

Transitions:
  IDLE → SPAWNED:   expand immediately (no animation — instant)
  SPAWNED → RUNNING: content streams in (natural growth)
  RUNNING → COMPLETED: auto-collapse after 1.5s delay
  COMPLETED → USER_EXPANDED: animated expand
  USER_EXPANDED → COMPLETED: animated collapse (user clicks chevron)
```

The 1.5s delay before auto-collapse gives the user time to see the completion status before it collapses. Claude.ai uses a similar brief pause on its thinking blocks.

### Multiple Concurrent Subagents

When multiple subagents run in parallel, they should render as a stacked list of blocks, each in their own SPAWNED/RUNNING/COMPLETED state independently:

```
┌─────────────────────────────────────────────────────────┐
│ ▼ style-checker · running                             ⏱ 4s │
├──────────────────────────────────────────────────────── │
│  Read 3 files...  ▋                                     │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│ ▼ security-scanner · running                          ⏱ 4s │
├──────────────────────────────────────────────────────── │
│  Running pnpm audit...  ▋                               │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│ ▶ test-coverage · completed                           6s │
│   Read 8 files · Ran 1 command                          │
└─────────────────────────────────────────────────────────┘
```

Parent conversation text resumes below all subagent blocks after all complete.

### The Parent-Level Activity Badge

For the parent message that _spawned_ subagents, show an aggregate badge before the subagent blocks:

```
Delegating to 3 subagents...
```

Or after completion:

```
3 subagents · 14s total
```

This is the "running 3 agents in parallel" indicator that GitHub Copilot's Mission Control provides.

---

## Implementation Notes for DorkOS

### Reading the Event Stream

DorkOS's current `claude-code-runtime.ts` processes SDK messages. To detect subagents:

```typescript
// In the message processing loop, look for:

// 1. Subagent spawn event (parent context)
if (block.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task')) {
  emit({
    type: 'subagent_spawned',
    toolUseId: block.id,
    description: block.input.description,
    agentType: block.input.subagent_type,
  });
}

// 2. Subagent activity (messages with parent_tool_use_id)
if (msg.parent_tool_use_id) {
  emit({
    type: 'subagent_message',
    parentToolUseId: msg.parent_tool_use_id,
    content: msg.message.content,
  });
}

// 3. Subagent completion (tool result back in parent)
if (block.type === 'tool_result' && isSubagentToolUseId(block.tool_use_id)) {
  emit({ type: 'subagent_completed', toolUseId: block.tool_use_id, result: block.content });
}
```

These three events give the full lifecycle for rendering subagent activity blocks.

### Subagent Events in the SSE Stream

DorkOS's server-to-client SSE stream currently emits `text_delta`, `tool_use`, `tool_result` etc. Subagent activity requires these to be tagged with the context level:

```typescript
// Proposed SSE event additions:
{
  type: ('subagent_start', toolUseId, agentType, description);
}
{
  type: ('subagent_activity', toolUseId, content);
} // forwarded subagent tool_use events
{
  type: ('subagent_end', toolUseId, result, durationMs);
}
```

Or more simply: tag existing events with `parentToolUseId` so the client can bucket them.

### Component Architecture (FSD Layer)

Given DorkOS's FSD layers:

- **`shared`**: `SubagentBlockState` type, `ToolCallAccumulator` interface, `formatSummaryBadge()` utility
- **`entities/message`**: `SubagentBlock` entity component (pure rendering of a single subagent's state)
- **`features/chat`**: `useSubagentTracker` hook that subscribes to the SSE stream and maintains the `Map<toolUseId, SubagentBlockState>` accumulator
- **`widgets`**: The `ChatPanel` or `MessageItem` renders `<SubagentBlock>` for each tracked subagent

---

## Accessibility Summary

**Minimum viable ARIA contract for a subagent block:**

```tsx
<div className="subagent-block">
  <button
    type="button"
    aria-expanded={isExpanded}
    aria-controls={`subagent-detail-${toolUseId}`}
    onClick={() => setIsExpanded((v) => !v)}
    className="..."
  >
    <ChevronIcon aria-hidden="true" />
    <span>{agentType}</span>
    <StatusBadge status={status} />
    <ElapsedTime ms={elapsedMs} aria-label={`${elapsedMs / 1000} seconds`} />
  </button>

  {/* Activity summary — always visible even when collapsed */}
  <div className="activity-summary" aria-live="polite">
    {formatSummaryBadge(accumulator)}
  </div>

  <div
    id={`subagent-detail-${toolUseId}`}
    role="region"
    aria-label={`${agentType} activity detail`}
    hidden={!isExpanded}
  >
    {/* Full detail content */}
  </div>
</div>
```

**`aria-live="polite"` on the summary badge**: Screen readers will announce badge updates (e.g., "Read 5 files, ran 1 command") without interrupting current speech. Use `polite` not `assertive` — subagent updates are informational, not urgent.

**Live region for streaming text inside the expanded block**: The streaming text area should NOT have `aria-live` — it would announce every token. Instead, announce only completion: add `aria-live="polite"` to a visually-hidden status element that announces "code-reviewer completed" when status changes to done.

---

## Sources & Evidence

- [Subagents in the SDK — Anthropic Platform Docs](https://platform.claude.com/docs/en/agent-sdk/subagents) — Primary source for event stream shape, `parent_tool_use_id`, `block.name === "Agent"` detection pattern, and the Agent/Task rename history
- [The Task Tool: Claude Code's Agent Orchestration System — DEV Community](https://dev.to/bhaidar/the-task-tool-claude-codes-agent-orchestration-system-4bf2) — Background task display format (ID, description, status, elapsed time)
- [Feature request: Display active subagent count in CLI status line — GitHub Issues #27916](https://github.com/anthropics/claude-code/issues/27916) — Confirms the current CLI gap and community expectation for "N subagents active"
- [claude-esp — Stream Claude Code's hidden output — GitHub](https://github.com/phiat/claude-esp) — Confirms hierarchical tree view with Main/Agent nodes, ⏳/✓ status symbols, Bubbletea/Lipgloss rendering
- [Running tasks in parallel with the /fleet command — GitHub Docs](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/fleet) — GitHub Copilot's parallel subagent orchestration UX model
- [VS Code 1.107 Multi-Agent Orchestration — Visual Studio Magazine](https://visualstudiomagazine.com/articles/2025/12/12/vs-code-1-107-november-2025-update-expands-multi-agent-orchestration-model-management.aspx) — Session list with status, progress, file change stats
- [Devin 2.0 Technical Design — Medium](https://medium.com/@takafumi.endo/agent-native-development-a-deep-dive-into-devin-2-0s-technical-design-3451587d23c0) — Each parallel Devin has its own cloud IDE; card-per-agent model
- [Using Claude's extended thinking — Anthropic News](https://www.anthropic.com/news/visible-extended-thinking) — Thinking indicator with timer, collapsible after completion
- [Introducing deep research — OpenAI](https://openai.com/index/introducing-deep-research/) — Real-time progress updates, interrupt/refine pattern
- [ToolGroup — assistant-ui docs](https://www.assistant-ui.com/docs/ui/ToolGroup) — Collapsible container for consecutive tool calls, auto-expand during streaming
- [Reasoning — assistant-ui docs](https://www.assistant-ui.com/docs/ui/Reasoning) — Shimmer effect while streaming, scroll lock, auto-group ReasoningGroup
- [CSS Grid Can Do Auto Height Transitions — CSS-Tricks](https://css-tricks.com/css-grid-can-do-auto-height-transitions/) — `grid-template-rows: 0fr → 1fr` technique
- [How to animate height with CSS grid — Stefan Judis](https://www.stefanjudis.com/snippets/how-to-animate-height-with-css-grid/) — Implementation details, browser support
- [Using the WAI-ARIA aria-expanded state — W3C WAI-GL](https://www.w3.org/WAI/GL/wiki/Using_the_WAI-ARIA_aria-expanded_state_to_mark_expandable_and_collapsible_regions) — Canonical ARIA contract for expandable regions
- [ARIA: aria-expanded attribute — MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-expanded) — attribute placement rules (on button, not region)
- [Practical Guide on Implementing aria-expanded — A11Y Collective](https://www.a11y-collective.com/blog/aria-expanded/) — Button + aria-controls + role=region pattern
- [The tool-call render pattern — Stackademic](https://stackademic.com/blog/the-tool-call-render-pattern-turning-your-ai-from-a-chatty-bot-into-a-doer) — Tool call chaining as UI dashboard of AI actions
- [Design Patterns for AI Interfaces — Smashing Magazine](https://www.smashingmagazine.com/2025/07/design-patterns-ai-interfaces/) — The shift away from chat-centric AI UI toward task-oriented transparency

---

## Research Gaps & Limitations

- **Claude Code CLI exact visual format for subagents while running**: The CLI does not stream subagent token output to the parent terminal. There is no publicly documented exact format for what the parent terminal shows _while_ a subagent is running (spinner? silence?). The task list display format (ID + status + elapsed) is confirmed for background tasks specifically.
- **Claude.ai thinking block collapse timing**: The exact delay before auto-collapse on Claude.ai's thinking blocks is not documented. The 1.5s recommendation is inferred from UX best practice, not measured.
- **assistant-ui ToolGroup source code**: The fetch of the assistant-ui docs returned 404 for some pages. The behavior description (auto-expand during streaming, collapsible after) is from search result snippets, not direct source inspection.
- **`grid-template-rows` + motion.dev interaction**: When using motion.dev's `layout` prop alongside the CSS grid trick, there may be conflicts where both try to manage height. Testing required to confirm the cleanest approach for DorkOS's existing `motion.dev` usage.
- **`parent_tool_use_id` on SSE stream**: DorkOS's current SSE event format may not forward the `parent_tool_use_id` field from SDK messages. The server-side stream translation layer (`claude-code-runtime.ts`) needs to be audited to confirm this field is preserved.

---

## Contradictions & Disputes

- **Auto-expand vs auto-collapse default for running subagents**: The Devin model (maximum transparency, everything open) contradicts the Claude.ai model (collapsed once done, with user-opt-in to expand). For DorkOS's developer audience (Kai), the Claude.ai model is more appropriate — developers want to see the headline result and dig in optionally, not be flooded with subagent token streams by default.
- **Live streaming into the subagent block vs final-result-only**: Some implementations only show the final result from a subagent (the SDK's default behavior — only the final message returns to the parent). DorkOS has visibility into subagent messages via `parent_tool_use_id` only if it's running the SDK directly. If the SDK summarizes or truncates subagent output before returning to the parent, the live-streaming-into-block pattern may not be achievable for all subagents.

---

## Search Methodology

- Searches performed: 14
- Most productive terms: "Claude Code Task tool subagent display terminal", "GitHub Copilot fleet parallel tasks UI", "assistant-ui ToolGroup Reasoning collapsible streaming", "CSS grid rows animate height auto", "aria-expanded collapsible region best practices"
- Primary source categories: Anthropic SDK official docs (highest value), GitHub issues for real-world behavior confirmation, CSS-Tricks/MDN for implementation patterns, assistant-ui docs for React component precedent
- Key codebase reference: `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — the site where SDK message processing occurs and where subagent detection hooks should be added
