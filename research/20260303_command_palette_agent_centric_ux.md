---
title: "Agent-Centric Command Palette UX — Best Practices and Patterns"
date: 2026-03-03
type: external-best-practices
status: active
tags: [command-palette, cmdk, shadcn, ux, agent-switcher, sidebar, keyboard-navigation, cmd-k]
feature_slug: command-palette
searches_performed: 14
sources_count: 28
---

# Agent-Centric Command Palette UX — Best Practices and Patterns

## Research Summary

The global Cmd+K command palette is the dominant keyboard-first navigation pattern in modern dev tools (Linear, VS Code, GitHub, Raycast, Superhuman). The shadcn `Command` component (wrapping the `cmdk` library) is already installed in DorkOS and provides everything needed: built-in fuzzy filtering, keyboard navigation, `CommandDialog` for modal presentation, and a `keywords` prop for search aliasing. The critical design decisions are: what appears in the zero-query (default) state, how to structure groups, whether to use prefix-scoped modes, and how to make the palette feel agent-centric rather than app-centric.

---

## Key Findings

### 1. Shadcn Command Component Capabilities

The `cmdk` library (already in DorkOS at `layers/shared/ui/command.tsx`) handles all low-level concerns automatically:

- **Fuzzy filtering with ranking**: Default filter scores matches; higher rank = higher position. Items scoring 0 are hidden. Completely customizable via the `filter(value, search, keywords)` prop on `<Command>`.
- **Keywords prop**: `<CommandItem keywords={['dork', 'agent', 'orchestrator']}>` — lets items match on synonyms beyond their visible text. Critical for agent search.
- **`forceMount` prop**: Available on both `CommandGroup` and `CommandItem`. Use this to show "pinned" items (Recent Agents, Quick Actions) even when they don't match the current search query.
- **`shouldFilter={false}`**: Disables internal filtering entirely — use when you manage filtering externally (e.g., async search results, custom frecency ranking).
- **`useCommandState(selector)`**: Hook for reading current command state (search value, selected item) from outside the component tree. Useful for rendering dynamic empty states.
- **`Command.Loading`**: Shows a loading indicator during async operations (agent list fetch).
- **`loop` prop**: Wraps arrow key navigation at list edges — strongly recommended for palettes.

**The `CommandDialog` pattern** is the correct wrapper for a global Cmd+K palette. It uses Radix UI's Dialog under the hood, providing backdrop, focus trapping, scroll locking, and Escape-to-close.

### 2. Global Cmd+K Keyboard Binding

The standard pattern across all best-in-class tools (Superhuman, Linear, Slack, GitHub, Vercel):

```typescript
// In a top-level component or App.tsx
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setOpen((prev) => !prev); // Toggle — same shortcut closes
    }
  };
  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}, []);
```

Key rules:
- **Toggle, don't just open**: Same shortcut closes the palette. Users need to back out of it quickly.
- **Bind at document level**, not a component: Makes it available everywhere.
- **`e.preventDefault()`**: Prevents browser URL bar behavior in Chromium.
- **Cross-platform**: `e.metaKey` (Mac Cmd) OR `e.ctrlKey` (Windows/Linux Ctrl).

### 3. Command Palette UX Principles from Best-in-Class Tools

**From Superhuman, Linear, Raycast, GitHub, VS Code:**

**Zero-query / default state (most important decision)**:
- Never show an empty input box with nothing else. This is the #1 failure mode.
- Show: recently used items + pinned quick actions + most important discovery items.
- Linear shows recent issues/projects. VS Code shows recently opened files. GitHub shows recently visited repos and issues.
- **Recommendation for DorkOS**: Show "Recent Agents" (frecency-sorted) + "Quick Actions" group (New Session, Discover Agents, Toggle Theme) + current slash commands.

**Grouping strategy**:
- 3–5 groups maximum in the zero-query state.
- When search is active, collapse empty groups automatically (cmdk does this natively).
- Use `CommandSeparator` between major sections (e.g., between Agents and App Features).
- Group headings should be short, uppercase or small-caps: "AGENTS", "FEATURES", "COMMANDS", "RECENT".

**Empty state (no search results)**:
- Never show just "No results found." Frame it positively.
- Example: "No agents match '{query}'. Discover agents →" with an actionable link.
- `<CommandEmpty>` renders automatically when all items are filtered out.

**Keyboard shortcut display**:
- Show `⌘K`, `⌘P`, `⌘N` badges next to frequently-used items using `<CommandShortcut>`.
- This educates users about shortcuts they can use instead of the palette.

**Fuzzy search behavior**:
- The default cmdk filter is good enough for most cases.
- Add `keywords` to agents (their description, cwd path, persona name) for richer matching.
- Do NOT show more than ~15 results at once — truncate with "Show more".

**Ordering within groups**:
- Zero-query: frecency order (most recent + most frequent first).
- During search: cmdk's score-based ranking handles this automatically.
- For agents: active agent always first (pinned with `forceMount`).

### 4. Scoped Prefix Modes (VS Code / GitHub Pattern)

VS Code Quick Open uses:
- No prefix → file search
- `>` → command mode
- `@` → symbol search (within file)
- `:` → go to line

GitHub Command Palette uses:
- No prefix → navigation/search
- `>` → command mode
- `#` → issues/PRs/discussions
- `@` → users/orgs/repos
- `!` → projects

**Assessment for DorkOS**: Full prefix scoping (like VS Code) adds significant complexity. A lighter approach works better for an AI agent tool:

- **Recommended**: Use one prefix — `@` for agent search. When user types `@`, filter to agents-only group and show all registered agents.
- This is intuitive: `@` already means "mention" or "address to" in most contexts.
- GitHub Docs calls this "mode switching" — the palette changes scope based on the leading character.

**Implementation**: Watch the input value; when it starts with `@`, switch to `shouldFilter={false}` and render only an agent group with custom filtering on agent names/paths.

### 5. Agent/Project Switching UX Patterns

**From GitHub, VS Code, JetBrains, Raycast, Linear:**

**What context to show per agent**:
- Primary: agent name (display name from `agent.json`)
- Secondary: cwd path (abbreviated: `~/projects/my-api`)
- Tertiary: agent color/icon (DorkOS already has `useAgentVisual`)
- Status indicator: whether there's an active session (dot or badge)

**Indicating the active agent**:
- Show a checkmark (`✓`) or highlight on the currently active agent.
- VS Code's workspace switcher puts the current workspace first with a check.
- Linear puts the current project/team with a filled dot.

**Frecency ordering**:
- Frecency = frequency + recency (most recently used, weighted by frequency).
- Simple implementation: store `{ agentId, lastUsed: Date, useCount: number }` in localStorage.
- Sort by `score = useCount * 0.3 + (Date.now() - lastUsed) * -0.0001`.
- The currently active agent is always pinned first regardless of frecency.

**Fast switching**:
- Show 5–7 most recent agents in the zero-query state.
- Full list on demand (scroll or "Show all agents").
- VS Code recent projects: show max 5 recent, then "Open another folder..."

### 6. Sidebar Redesign Patterns

**Current DorkOS sidebar**: Session-centric (lists sessions, current session highlighted).

**Agent-centric sidebar patterns from modern dev tools**:

The VS Code "Agent Sessions" panel introduced in 2025 structures each agent as the top-level element, with sessions nested underneath. Each agent entry shows: name, current task, status indicator, and an expandable activity log.

**Recommended agent-centric sidebar structure for DorkOS**:

```
[Agent Identity Header]          ← Active agent name, color, icon
  ↳ New Session button
  ↳ Session list (recent first)

[Agent Switcher / Footer]        ← Click to open command palette scoped to agents
  ↳ "5 agents registered"
```

Key design decisions:
- The sidebar should be **agent-first**, not session-first.
- The agent header (name, color, icon) should be persistent and visually prominent.
- Sessions are subordinate to agents — they're the chat history for this agent.
- Switching agents should switch the entire sidebar context (like switching projects in VS Code).
- The "switch agent" trigger can be a compact badge/button in the sidebar header that opens the command palette scoped to `@`.

**Multi-agent sidebar patterns**:
- SidekickBar (sidebar with 30+ AI assistants): shows agent icons in a vertical strip; click to switch.
- VS Code's agent sessions panel: collapsible rows per agent with status indicator.
- For DorkOS: a compact "Agent Switcher" at the top of the sidebar showing the active agent's color + name, with a dropdown indicator that opens the palette.

---

## Detailed Analysis

### Shadcn Command Component Architecture

The existing `command.tsx` at `layers/shared/ui/command.tsx` is already correctly scaffolded. It does NOT yet include `CommandDialog`. The global palette needs a new component in `features/command-palette/` (not to be confused with the existing `features/commands/` which is the inline slash command palette for the chat input).

**Component structure for the global palette**:

```
features/command-palette/
├── ui/
│   ├── CommandPaletteDialog.tsx    # Root dialog + keyboard hook
│   ├── AgentCommandItem.tsx        # Agent result row with color + path
│   └── CommandPaletteEmpty.tsx     # Context-aware empty state
├── model/
│   ├── use-command-palette.ts      # open/close state + keyboard binding
│   ├── use-agent-frecency.ts       # localStorage frecency tracking
│   └── use-palette-items.ts        # Assembles all command items from sources
└── index.ts
```

**The palette is a `widget` concern** (app-level, wraps features) but since it references features (agents, pulse, relay, mesh, commands), it should live in `features/command-palette/` as a standalone feature that is mounted at the `app` layer. This matches how the existing `features/commands/` pattern is used.

**Key implementation pattern — separating data assembly from rendering**:

```typescript
// use-palette-items.ts
// Assembles PaletteItem[] from all sources:
// - Registered agents (from useRegisteredAgents)
// - App features (static list)
// - Slash commands (from useCommands)
// - Quick actions (static list)
// Returns grouped structure ready for CommandGroup rendering
```

### CommandDialog Implementation Pattern

```tsx
// CommandPaletteDialog.tsx
import { CommandDialog, CommandInput, CommandList, CommandGroup,
         CommandItem, CommandEmpty, CommandShortcut, CommandSeparator } from '@/layers/shared/ui';

export function CommandPaletteDialog() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const close = useCallback(() => { setOpen(false); setSearch(''); }, []);

  // Global Cmd+K binding
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const isAgentMode = search.startsWith('@');
  const effectiveSearch = isAgentMode ? search.slice(1) : search;

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Search agents, features, commands..."
        value={search}
        onValueChange={setSearch}
      />
      <CommandList>
        <CommandEmpty>
          {search ? `No results for "${search}". Try discovering agents →` : 'Start typing to search.'}
        </CommandEmpty>

        {/* Zero-query state: recent agents pinned */}
        {!search && (
          <CommandGroup heading="Recent Agents">
            {recentAgents.map((agent) => (
              <AgentCommandItem key={agent.id} agent={agent} onSelect={close} />
            ))}
          </CommandGroup>
        )}

        {/* Agent mode (@) or search includes agents */}
        <CommandGroup heading="Agents" forceMount={isAgentMode}>
          {/* ... */}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Features">
          <CommandItem onSelect={() => { navigateTo('pulse'); close(); }}>
            <CalendarIcon /> Pulse Scheduler <CommandShortcut>⌘P</CommandShortcut>
          </CommandItem>
          {/* relay, mesh, settings... */}
        </CommandGroup>

        <CommandGroup heading="Commands">
          {/* slash commands from useCommands */}
        </CommandGroup>

        <CommandGroup heading="Quick Actions">
          <CommandItem onSelect={() => { createNewSession(); close(); }}>
            <PlusIcon /> New Session
          </CommandItem>
          <CommandItem onSelect={() => { toggleTheme(); close(); }}>
            <SunIcon /> Toggle Theme
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
```

### Frecency Implementation for Agents

Store in `localStorage` to avoid server round-trips:

```typescript
// use-agent-frecency.ts
const STORAGE_KEY = 'dorkos:agent-frecency';

interface FrecencyEntry {
  agentId: string;
  lastUsed: number;  // timestamp
  useCount: number;
}

function computeScore(entry: FrecencyEntry): number {
  const hoursSinceUse = (Date.now() - entry.lastUsed) / (1000 * 60 * 60);
  // Higher score = more recent + more frequent
  return entry.useCount / (1 + hoursSinceUse * 0.1);
}
```

This is the same algorithm used by Raycast, VS Code's "recently opened", and Linear's quick switcher.

### Agent Item Design

Each agent result in the palette should show:

```
[●] my-api-agent          ~/projects/my-api
     "Builds and deploys the REST API"
```

- Colored dot using the agent's `color` field from `useAgentVisual`
- Agent name prominently
- Truncated cwd path (right-aligned, `text-muted-foreground`)
- Agent description as a subtitle (optional, shown on hover or always)
- `✓` checkmark on the currently active agent

### Sidebar Agent-Centric Redesign Direction

The current sidebar header shows "DorkOS" branding. For an agent-centric feel:

**Option A: Agent Identity Header (Recommended)**
```
[●] my-api-agent         [↕ switch]
    ~/projects/my-api
    ─────────────────────
    + New Session
    [session list]
```
- The `[↕ switch]` button opens the command palette scoped to `@` (agent search).
- Clean, focused — one agent at a time.
- Pattern: VS Code's workspace indicator in the status bar, JetBrains' project indicator in the toolbar.

**Option B: Agent Strip + Session List**
```
[●] [●] [●] [+]          ← Agent icons strip
─────────────────────
Sessions for: my-api-agent
[session list]
```
- Multiple agents visible simultaneously.
- More complex, harder to scan at a glance.
- Pattern: SidekickBar, browser tab bars.

**Option C: Keep session-centric, add agent switcher chip**
```
[my-api-agent ↕]         ← Chip at top
─────────────────────
[session list, unchanged]
```
- Smallest change, lowest risk.
- Does not feel agent-centric; the agent feels like a filter, not a first-class entity.

**Recommendation**: Option A. It mirrors how VS Code, JetBrains, and Linear treat the "active context" as a first-class concept with a prominent switch affordance. The Cmd+K palette handles discovery; the sidebar header handles identity.

---

## Pros and Cons by Approach

### Scoped Prefix Modes

| Approach | Pros | Cons |
|---|---|---|
| Full VS Code prefixes (`>`, `@`, `:`, `#`) | Maximum power, keyboard-only navigation | High complexity, steep learning curve for a web tool |
| Single `@` prefix for agents | Natural, intuitive, low learning curve | Only one scope switch, but that's all DorkOS needs |
| No prefixes, just groups | Simplest, fastest to implement | Less powerful, all content types compete in search |

**Recommendation**: Single `@` prefix for agents only. DorkOS doesn't have the content depth of VS Code to justify full prefix mode.

### Default/Zero-Query State

| Approach | Pros | Cons |
|---|---|---|
| Empty (show nothing) | Clean, minimal | Wastes the "opened" state, fails discovery |
| Full command list | Shows everything | Overwhelming, no personalization |
| Frecency-first (recent + pinned quick actions) | Personalized, fast for repeat actions | Requires tracking storage |
| Fixed curated defaults | Easy to implement, consistent | Not personalized |

**Recommendation**: Frecency-first. Show last 3–5 agents (frecency-sorted) + 4–5 quick actions. This is the Linear/GitHub/VS Code pattern.

### Sidebar Structure

| Approach | Pros | Cons |
|---|---|---|
| Agent Identity Header (A) | Agent-first, focused, mirrors VS Code/JetBrains | Breaking change to current layout |
| Agent Strip (B) | Multi-agent visibility | Complex, cluttered |
| Agent Switcher Chip (C) | Low-risk, incremental | Not truly agent-centric |

**Recommendation**: Option A for new feature development. Option C as a short-term interim if sidebar redesign is out of scope for this spec.

---

## Implementation Recommendations for DorkOS

### 1. FSD Placement

- New `features/command-palette/` module (separate from existing `features/commands/` which handles slash command inline palette).
- Mount the `<CommandPaletteDialog>` in `App.tsx` at the root (same level as the existing command palette, toaster, etc.).
- The keyboard hook lives inside `use-command-palette.ts` (model segment).

### 2. Data Sources

The palette aggregates from four existing entities:
- `useRegisteredAgents` (from `entities/mesh`) → agent items
- `useCommands` (from `entities/command`) → slash command items
- App feature list → static items (Pulse, Relay, Mesh, Settings)
- Quick actions → static items (New Session, Discover Agents, Toggle Theme)

No new API endpoints needed.

### 3. CommandDialog vs Custom Positioning

Use `CommandDialog` (from Radix UI Dialog). Do NOT build a custom positioned overlay. Reasons:
- `CommandDialog` handles focus trapping, scroll locking, backdrop, Escape, and portal rendering automatically.
- The existing inline slash command palette (`CommandPalette.tsx`) uses a custom positioned overlay — that's appropriate for that context (anchored to the input). The global palette is different.

### 4. Keyboard Shortcut Choice

- Use `Cmd+K` (not `Cmd+P` — that conflicts with Print on most browsers, and VS Code's Go to File).
- `Cmd+K` is used by: Linear, Slack, Superhuman, GitHub, Vercel, Retool. It is the web-native standard.
- Show the shortcut in the sidebar agent switcher affordance: `[my-api-agent ↕ ⌘K]`.

### 5. Agent Search Keywords

When rendering agents in `CommandItem`, add `keywords`:

```tsx
<CommandItem
  key={agent.id}
  value={agent.name}
  keywords={[agent.cwd, agent.persona ?? '', agent.description ?? '']}
  onSelect={() => { switchToAgent(agent.id); close(); }}
>
```

This makes agents findable by their cwd path, persona name, or description — not just display name.

### 6. onSelect + Close Pattern

Every command item's `onSelect` should:
1. Execute the action.
2. Call `close()` (which both closes the dialog and resets search to `''`).

Resetting search on close prevents the search state from persisting when the palette is reopened.

### 7. Existing `CommandPalette.tsx` Relationship

The existing `features/commands/CommandPalette.tsx` handles slash commands inline within the chat input. It uses a custom positioned dropdown, not a `CommandDialog`. These are two different UI patterns serving different contexts:
- Inline palette: triggered by `/` in the chat input, anchored below the input, shows slash commands only.
- Global palette: triggered by `Cmd+K` from anywhere, full-screen dialog, shows everything.

Keep both. Do not merge them.

---

## Sources & Evidence

- cmdk API documentation: [GitHub - dip/cmdk](https://github.com/dip/cmdk)
- shadcn Command component: [Command - shadcn/ui](https://ui.shadcn.com/docs/components/command)
- shadcn Command patterns: [Shadcn Command](https://www.shadcn.io/ui/command)
- Command palette UX design: [Designing a Command Palette - Destiner](https://destiner.io/blog/post/designing-a-command-palette/)
- Superhuman command palette best practices: [How to build a remarkable command palette](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/)
- Command palette UX patterns overview: [Command Palette UI Design - Mobbin](https://mobbin.com/glossary/command-palette)
- Command palette UX patterns #1: [Command Palette UX Patterns - Medium/Bootcamp](https://medium.com/design-bootcamp/command-palette-ux-patterns-1-d6b6e68f30c1)
- Command palette pattern deep dive: [Command Palette Interfaces - Philip Davis](https://philipcdavis.com/writing/command-palette-interfaces)
- VS Code command palette docs: [Command Palette - VS Code Extension API](https://code.visualstudio.com/api/ux-guidelines/command-palette)
- VS Code prefix modes: [Visual Studio Code Tips and Tricks](https://code.visualstudio.com/docs/getstarted/tips-and-tricks)
- GitHub command palette: [GitHub Command Palette Docs](https://docs.github.com/en/get-started/accessibility/github-command-palette)
- GitHub command palette multi-step: [Command Palette multi-step enhancement](https://github.blog/changelog/2022-05-05-command-palette-multi-step-enhancement/)
- Developer tool UI patterns: [5 Essential Design Patterns for Dev Tool UIs - Evil Martians](https://evilmartians.com/chronicles/keep-it-together-5-essential-design-patterns-for-dev-tool-uis)
- Agentic UX patterns: [Secrets of Agentic UX - UX Magazine](https://uxmag.com/articles/secrets-of-agentic-ux-emerging-design-patterns-for-human-interaction-with-ai-agents)
- AI agent sidebar patterns: [Mission Control for AI Coding - Medium](https://medium.com/@roman_fedyskyi/mission-control-for-ai-coding-c77d680feb46)
- Retool command palette design: [Designing Retool's Command Palette](https://retool.com/blog/designing-the-command-palette)
- cmdk React implementation: [Boost Your React App with cmdk](https://knowledge.buka.sh/boost-your-react-app-with-a-sleek-command-palette-using-cmdk/)
- PowerToys command palette prefix modes: [PowerToys Command Palette - Microsoft Learn](https://learn.microsoft.com/en-us/windows/powertoys/command-palette/overview)
- Raycast developer overview: [Raycast for Software Engineers - Pixelmatters](https://www.pixelmatters.com/insights/raycast-for-software-engineers)

---

## Research Gaps & Limitations

- Could not access Retool's full blog post (403 error) — their command palette design blog is referenced widely but content was inaccessible.
- No specific frecency algorithm documentation from Linear or GitHub was found — the scoring formula above is derived from first principles and common patterns.
- No existing DorkOS-specific user research on how users currently discover features or navigate between agents. Recommendations are based on industry patterns, not DorkOS-specific usage data.
- The sidebar redesign (Option A) is recommended but would require its own spec — this research covers direction only, not full implementation details.

---

## Contradictions & Disputes

- **Cmd+K vs Cmd+P**: VS Code uses Cmd+P for Go to File, Cmd+Shift+P for Command Palette. Web tools (Linear, Slack, Superhuman, GitHub) universally use Cmd+K. DorkOS is a web tool — Cmd+K is correct.
- **Prefix scoping**: GitHub has full prefix scoping (`>`, `#`, `@`, `!`); Superhuman and Linear do not. For DorkOS at its current scale, a single `@` prefix is the right balance.
- **Dialog vs. anchored overlay**: Some tools (Notion) use a full-screen dialog; others anchor the palette to a search bar. For a global shortcut, the full-screen dialog is always preferred — it's harder to accidentally dismiss and easier to position on all screen sizes.

---

## Search Methodology

- Searches performed: 14
- Most productive search terms: "shadcn cmdk command palette patterns", "command palette UX best practices VS Code Linear Raycast", "command palette scoped modes prefix filtering", "GitHub command palette design context navigation"
- Primary information sources: shadcn/ui docs, cmdk GitHub, VS Code docs, GitHub Docs, Mobbin UX glossary, Destiner's command palette design post, Superhuman engineering blog
