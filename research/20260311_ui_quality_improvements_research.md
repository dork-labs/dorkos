---
title: 'UI Quality Improvements: 5 React/TypeScript Best Practice Topics'
date: 2026-03-11
type: external-best-practices
status: active
tags:
  [
    FSD,
    shadcn,
    TypeScript,
    React,
    event-log,
    error-display,
    module-splitting,
    binding-list,
    auto-scroll,
  ]
searches_performed: 18
sources_count: 42
---

# UI Quality Improvements: 5 Research Topics

## Research Summary

This report covers five targeted research areas for improving a React 19 + TanStack Query + Tailwind CSS v4 + shadcn/ui application following FSD (Feature-Sliced Design) architecture. Topics span architecture (shared constants placement, module splitting), UX patterns (error display, binding list views, event log UI), and implementation guidance (SSE auto-scroll, accessible overlays). For each topic, three approaches are evaluated with pros/cons and a clear recommendation.

---

## Topic 1: Extracting Shared Constants in FSD

### Background

FSD defines a strict set of standard segments: `ui`, `api`, `model`, `lib`, and `config`. The key principle from FSD documentation is that **segment names should describe purpose (the "why"), not the "what"**. A folder called `constants/` is discouraged — `lib/` or `config/` are preferred depending on the nature of the data.

### Approaches

#### Approach A: `shared/config` for all display constants

Place all cross-feature constants — including color maps, badge variant maps, status maps — in `shared/config`.

**Pros:**

- `config` is explicitly for "constants and flags" per FSD spec
- Simple mental model — all "lookup tables" live in one place
- Easy to find; aligns with FSD v2.1 which explicitly allows "application-aware things like route constants" in Shared

**Cons:**

- Mixes display concerns with global configuration (env vars, feature flags)
- `shared/config` becomes a grab-bag; harder to navigate as it grows
- Color maps are arguably UI concern, not configuration

#### Approach B: `shared/lib` scoped by domain area (RECOMMENDED)

Put color maps and display-related constants in `shared/lib`, organized by concern: `shared/lib/colors.ts`, `shared/lib/status.ts`, `shared/lib/formatting.ts`.

**Pros:**

- FSD documentation explicitly states: "libraries in `shared/lib` should have one area of focus, for example, dates, **colors**, text manipulation"
- Color and status maps are code that _does something_ (lookup/transform), which is more "lib" than "config"
- Scales cleanly — each domain gets a focused file
- Cleaner import paths: `import { statusColorMap } from '@/shared/lib/status'`

**Cons:**

- Slightly less obvious than a `constants/` folder for junior devs
- Requires discipline to keep files focused (avoid dumping into `lib/utils.ts`)

#### Approach C: Feature-local constants + colocation

Keep color maps in the feature that owns them, only promoting to `shared/lib` if used in 3+ features.

**Pros:**

- Maximum colocation — easier to delete when feature is removed
- No premature abstraction

**Cons:**

- Color maps used across features become duplicated
- FSD's purpose is to avoid exactly this kind of inconsistency
- Violates the DRY principle when the same status-to-color mapping is needed in a sidebar, a card, and a detail view

### Recommendation

Use **Approach B: `shared/lib` scoped by domain**. The FSD docs are explicit that `shared/lib` is for "focused library areas" like colors. Reserve `shared/config` for environment-derived values and feature flags. A typical structure:

```
shared/
  lib/
    colors.ts        # statusColorMap, severityColorMap, etc.
    status.ts        # statusLabelMap, statusIconMap
    formatting.ts    # date/number formatters
  config/
    env.ts           # Zod-validated env vars
    features.ts      # Feature flags
```

**When to use `shared/ui` instead:** If a constant is only needed to render a component that itself lives in `shared/ui`, co-locate the constant inside that component file or its barrel.

**When to use `entities/[entity]/lib`:** If the color map is specific to one business entity (e.g., a mapping from `AgentStatus` to colors), it can live in `entities/agent/lib/colors.ts` — because it is "entity-aware" knowledge. Only promote to `shared/lib` if multiple unrelated entities need it.

### Security/Accessibility Notes

None specific to placement, but ensure color maps are never used as the sole differentiator — always pair color with a text label or icon for color-blind accessibility.

---

## Topic 2: Error Message Display Patterns in Compact Card UIs

### Background

In data-dense UIs with compact cards (e.g., an agent status card or binding row), error messages from failed operations may be long (stack traces, API error bodies, multi-line validation messages). Truncation loses context; full display breaks layout. Three patterns address this.

### Approaches

#### Approach A: Tooltip on Truncated Text

Truncate the error with `truncate` / `line-clamp-2`, show full text in a shadcn `Tooltip` on hover.

**Pros:**

- Minimal footprint — no layout change
- Familiar pattern for sighted users
- Zero interactivity required — hover reveals content

**Cons:**

- Tooltips are hover-only — keyboard users cannot access the content on mobile or keyboard-only navigation
- WCAG 1.4.13 (Content on Hover or Focus) requires tooltip content to be dismissable, hoverable (pointer can enter tooltip), and persistent — shadcn's Tooltip meets this but requires careful configuration
- Long error messages make bad tooltip text — tooltips should be "concise"; truncated error strings are not
- `HoverCard` (more spacious) shares the same accessibility problem: "intended for sighted users only, the content will be inaccessible to keyboard users"
- No copy mechanism for the error text

**Verdict:** Acceptable for supplemental hints, **not acceptable as the primary error display mechanism**.

#### Approach B: Inline Collapsible Expand (shadcn Collapsible) (RECOMMENDED)

Show a 1–2 line preview of the error. Provide a "Show more" / chevron button that expands the full text inline using shadcn `Collapsible`.

```tsx
<Collapsible>
  <div className="flex items-center gap-2">
    <span className="text-destructive truncate">{shortError}</span>
    <CollapsibleTrigger asChild>
      <Button variant="ghost" size="sm">
        <ChevronDown className="h-3 w-3" />
        <span className="sr-only">Show full error</span>
      </Button>
    </CollapsibleTrigger>
  </div>
  <CollapsibleContent>
    <pre className="text-muted-foreground mt-1 text-xs break-words whitespace-pre-wrap">
      {fullError}
    </pre>
  </CollapsibleContent>
</Collapsible>
```

**Pros:**

- Fully keyboard accessible — the trigger is a button, focusable with Tab, activatable with Enter/Space
- ARIA-correct: Radix Collapsible uses `aria-expanded` and `aria-controls` automatically
- Stays in-place — no viewport change, no focus teleportation
- Can contain a "Copy" button for the full error
- Works in compact card layouts without scrolljacking
- The 9 Radix Collapsible variants (including "dense/compact") are purpose-built for this

**Cons:**

- Layout shifts slightly when expanded — needs `min-h` or animation to soften
- Card height becomes variable — may cause layout reflow in grid views
- Requires motion animation to avoid jarring pop

**Mitigation:** Use `motion` (Framer Motion) for height animation. Set `overflow-hidden` and animate `height` from `0` to `auto` for a smooth reveal.

#### Approach C: Popover on Explicit "View Error" Action

Replace inline error text entirely with an error icon badge. Clicking it opens a shadcn `Popover` containing the full error, a copy button, and potentially a "Report" link.

**Pros:**

- Zero layout impact — the card always has the same height
- Popover is fully keyboard accessible (focus is managed, focus trap, escape closes)
- Can contain interactive elements (Copy, Dismiss, Report)
- Best for very long errors (>100 characters) that would meaninglessly truncate

**Cons:**

- Two-click pattern — user must discover the icon, then click
- Hides the error text from immediate visual scanning — user must know to look for the icon
- Popovers should not be nested in other popovers (relevant if the card row is itself in a popover)
- Known shadcn issue: Tooltip and Popover combined on the same trigger can conflict

### Recommendation

Use **Approach B (Collapsible)** as the primary pattern for errors in compact cards. It is the only pattern that:

1. Keeps the error text scannable in context (not hidden behind an icon)
2. Is fully keyboard and screen reader accessible
3. Avoids viewport-disrupting navigation

Use **Approach C (Popover)** as a fallback when the card is so space-constrained that even a truncated preview line cannot fit — for example, in a mini status chip or a table cell.

**Never use HoverCard for error text** — it is inaccessible to keyboard users, violating WCAG 2.1 criterion 1.3.1 (Info and Relationships) and 2.1.1 (Keyboard).

### Accessibility Requirements

- Error text must be available to keyboard users — tooltip-only patterns fail WCAG 2.1
- Use `role="alert"` or `aria-live="polite"` on newly appearing error content
- The "Show more" button needs a `<span className="sr-only">` describing what will expand
- Ensure sufficient color contrast for error text (4.5:1 minimum, WCAG 1.4.3)
- Never rely on red color alone to convey error state — pair with icon or text label

---

## Topic 3: Binding/Connection Management List Views

### Background

A "binding" is a relationship between two entities: an adapter (e.g., Telegram, Slack) and an agent. The view shows all active bindings with properties (session strategy, active status) and inline actions (edit, delete). This is a classic "junction table" UI problem.

### Layout Decision Framework

Use the following decision criteria (from UX Patterns for Developers and design system research):

| Criterion                      | Table | List Rows | Cards    |
| ------------------------------ | ----- | --------- | -------- |
| Many columns to compare        | Best  | Mediocre  | Poor     |
| 1-3 properties per item        | Good  | Best      | Good     |
| Inline actions (edit/delete)   | Good  | Best      | Mediocre |
| Responsive/mobile              | Poor  | Good      | Best     |
| Items are homogeneous          | Best  | Good      | Mediocre |
| User needs to scan quickly     | Best  | Good      | Poor     |
| Items have images/rich content | Poor  | Mediocre  | Best     |

Bindings are homogeneous, have 2-4 properties, and need scan-and-act behavior. This points to **list rows or a minimal table** — not cards.

### Approaches

#### Approach A: Table Layout (TanStack Table or native `<table>`)

Columns: Adapter, Agent, Session Strategy, Status, Actions.

**Pros:**

- Best for comparison — user can scan adapter column or agent column independently
- Sort and filter come naturally with TanStack Table
- Familiar to developer-persona users (Kai) who are accustomed to tabular data

**Cons:**

- Overkill for small datasets (most users have <20 bindings)
- Inline editing in tables requires cell-level edit modes — more complex to implement
- Tables scroll horizontally on mobile
- "Session strategy" as a select dropdown in a table cell is awkward UX

#### Approach B: Structured List Rows with Inline Editing (RECOMMENDED)

Each binding is a horizontal row (`flex` or `grid`) with:

- Left: adapter name + icon
- Center: agent name (possibly a Select for reassigning)
- Right: session strategy Select + action buttons (edit icon, delete icon)

**Pros:**

- Simple to implement — just a `ul` with `li` rows styled with Tailwind
- Inline Select for session strategy is natural in a list row (more space than a table cell)
- Empty state, loading state, and error state are straightforward
- Responsive — can stack vertically on narrow viewports
- Matches the pattern used by tools like Vercel environment variable management, Render service connections
- Keyboard navigable naturally
- Deletions can use a small confirm popover on the delete icon (avoiding a full modal)

**Cons:**

- Less scannable than a table when there are many bindings (>50)
- No built-in sort/filter

**Mitigation:** For the DorkOS context, the binding count is expected to be small (under 20). Sort/filter are not needed. List rows are the right call.

#### Approach C: Card Grid per Binding

Each binding is a card showing adapter + agent + properties + actions.

**Pros:**

- More real estate for rich adapter metadata (description, last sync time)
- Each binding feels like a discrete "thing" the user manages

**Cons:**

- Cards are best when each item requires "thinking about" — bindings are operational, not exploratory
- Takes up significantly more vertical space
- Actions (edit/delete) in cards typically require a menu, adding clicks
- Card-in-a-card anti-pattern if the binding list is inside another panel

### Recommendation

Use **Approach B: Structured List Rows**. Here is the recommended row structure:

```tsx
// Each binding row
<li className="flex items-center gap-3 py-2 px-3 rounded-md hover:bg-muted/50">
  {/* Adapter identity */}
  <AdapterIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
  <span className="w-32 font-medium truncate">{binding.adapterName}</span>

  {/* Arrow indicator */}
  <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />

  {/* Agent */}
  <span className="flex-1 truncate text-sm">{binding.agentName}</span>

  {/* Strategy inline select */}
  <Select value={binding.strategy} onValueChange={...}>
    <SelectTrigger className="h-7 w-32 text-xs">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="round-robin">Round Robin</SelectItem>
      <SelectItem value="single">Single</SelectItem>
    </SelectContent>
  </Select>

  {/* Actions */}
  <Button variant="ghost" size="icon" className="h-7 w-7">
    <Trash2 className="h-3 w-3" />
  </Button>
</li>
```

**Empty State Pattern:**

Per Carbon Design System and Atlassian guidance, empty states should:

1. Use an icon representing the absent entity (e.g., a plug or link icon)
2. Provide a headline: "No bindings configured"
3. Provide a helpful secondary line: "Connect an adapter to route messages to an agent"
4. Include a primary CTA button: "Create binding"

Avoid blank white space alone — it creates anxiety that something is broken.

### Edit vs Delete Patterns

- **Edit a binding:** Inline via the Select for simple properties (strategy). For complex edits (reassigning adapter or agent), open a small Sheet (not a Dialog) that slides in from the right — preserving context without full-page navigation.
- **Delete a binding:** Inline confirm via a `Popover` with a red "Confirm Delete" button. Do not navigate to a confirmation page. Do not use a full-screen Dialog for a destructive action this small.

---

## Topic 4: Splitting Large TypeScript Modules

### Background

A 700+ line TypeScript file typically mixes concerns: initialization/lifecycle, inbound message handling, outbound message dispatch, state management, and sometimes schema definitions. The goal is to split it into focused modules while keeping the public API stable.

### Strategies

#### Strategy A: Facade Pattern — Thin Coordinator + Focused Modules (RECOMMENDED)

The original file becomes a facade: a thin module that imports from focused sub-modules and re-exports a unified public API. Internal modules are not exported directly.

```
services/
  relay/
    index.ts                 ← facade (public API, unchanged)
    relay-manager.ts         ← original file (now thin coordinator)
    inbound/
      message-handler.ts     ← inbound processing
      validation.ts          ← message validation
    outbound/
      publisher.ts           ← outbound dispatch
      retry.ts               ← retry logic
    lifecycle/
      connection-manager.ts  ← connect/disconnect/reconnect
      health-check.ts        ← ping/health
    schemas/
      relay-messages.ts      ← Zod schemas for message types
      relay-events.ts        ← Zod schemas for events
```

The facade (`index.ts`) re-exports the public surface:

```typescript
export { RelayManager } from './relay-manager';
export type { RelayConfig, RelayEvent } from './schemas/relay-events';
```

**Pros:**

- Zero breaking changes — all existing imports from the module path are unchanged
- Each sub-module is testable in isolation
- Clear single responsibility per file
- Facade pattern is well-understood and documented as the canonical approach for this problem
- Avoids "god object" anti-pattern while maintaining consumer simplicity

**Cons:**

- The facade itself can become a god object if not kept thin — must resist adding logic to it
- Increased file count — navigating the directory requires more hops
- Import cycles are possible if sub-modules import from each other without discipline

**Mitigation for circular imports:** Enforce a strict dependency direction within the module cluster: `schemas` → `inbound/outbound` → `lifecycle`. Nothing imports from a "higher" layer.

#### Strategy B: Barrel Exports with Internal Re-exports

Keep all logic in a single directory, split into files (`handler.ts`, `publisher.ts`, etc.), and create an `index.ts` barrel that re-exports everything with named exports.

**Pros:**

- Simple to implement — just move code into files, create `index.ts`
- Familiar pattern in TypeScript projects

**Cons:**

- Large barrel files degrade TypeScript performance — documented reports of 11,000+ module imports when barrels are overused in monorepos
- Named exports from barrels can accidentally expose internals if not carefully curated
- **TkDodo's "Please Stop Using Barrel Files"** (2023, widely cited) argues barrel files cause circular dependency bugs and slow down builds
- Tree-shaking is less effective with barrel re-exports

**Recommendation:** Use barrels only at the `public API boundary` (the top-level `index.ts` of a module). Do not create internal barrels within a module's subdirectory.

#### Strategy C: Splitting into Separate Service Classes with Dependency Injection

Break the monolith into 3-4 separate injectable classes (e.g., `MessageInboundService`, `MessageOutboundService`, `ConnectionLifecycleService`) that share a common context object.

**Pros:**

- Most testable — each class can be unit-tested with simple mocks
- Clean DI container integration
- Aligns with SOLID principles at the class level

**Cons:**

- Significant refactoring cost — every consumer that accesses the original class needs updating unless you keep a facade
- Context object / shared state between classes requires careful design to avoid hidden coupling
- More complex for simple cases that don't warrant full DI

### Recommendation for Zod Schema Files

When a schema file grows large, split by domain entity — **not** by schema type (don't create `input-schemas.ts` and `response-schemas.ts`; create `relay-message.schema.ts` and `relay-event.schema.ts`).

Pattern:

```typescript
// packages/shared/src/schemas/relay/
//   index.ts               ← re-exports all relay schemas
//   message.schema.ts      ← RelayMessageSchema, RelayMessageType
//   event.schema.ts        ← RelayEventSchema, RelayEventType
//   config.schema.ts       ← RelayConfigSchema

// index.ts
export * from './message.schema';
export * from './event.schema';
export * from './config.schema';
```

This gives consumers: `import { RelayMessageSchema } from '@dorkos/shared/schemas/relay'`.

### Splitting Adapter Classes

For adapter classes with mixed concerns (listen + send + connect + health), the proven split is by concern axis, not by direction:

| File                   | Responsibility                                           |
| ---------------------- | -------------------------------------------------------- |
| `adapter-lifecycle.ts` | `connect()`, `disconnect()`, `reconnect()`, health check |
| `adapter-inbound.ts`   | Receive messages, parse, validate, dispatch to relay     |
| `adapter-outbound.ts`  | Format and send messages to external service             |
| `adapter.ts` (facade)  | Implements `AdapterInterface`, delegates to the above    |

### Backward Compatibility Rules

1. **Never delete a public export** — mark as `@deprecated` with a JSDoc comment pointing to the new location
2. **Keep the original module path** — add a facade at the old path that re-exports from the new structure
3. **Add `@deprecated` TSDoc** — IDEs surface deprecation warnings on usage
4. **Type aliases survive**: `export type OldType = NewType` is a non-breaking change
5. **Version the breaking change** — put it in a minor version if the module is internal; require a major if it's part of the public API

---

## Topic 5: Event/Audit Log UI Patterns

### Background

An event log panel in a sidebar shows a chronological stream of timestamped events from agent operations (messages received, jobs fired, errors, tool calls). Events arrive via SSE in real time. The UI must be compact, auto-scrolling, filterable, and readable at a glance.

### Row Design

Each event row should contain exactly four pieces of information, in this order (left to right):

```
[timestamp]  [type badge]  [message text]
```

Example with Tailwind:

```tsx
<li className="hover:bg-muted/40 flex items-start gap-2 rounded px-2 py-1 text-xs">
  <time className="text-muted-foreground w-16 shrink-0 tabular-nums">
    {format(event.timestamp, 'HH:mm:ss')}
  </time>
  <Badge
    variant="outline"
    className={cn('h-4 shrink-0 px-1 text-[10px]', eventTypeColor(event.type))}
  >
    {event.type}
  </Badge>
  <span className="text-foreground/80 flex-1 leading-tight break-words">{event.message}</span>
</li>
```

**Key design decisions:**

- `tabular-nums` on timestamp so digits don't shift as seconds change
- Fixed-width timestamp column (`w-16`) keeps badge and message aligned
- `break-words` on message to handle long tool names or JSON excerpts
- Hover highlight on row for hover-to-read-in-context
- Colored badges communicate type at a glance (error=red, info=blue, tool=purple, message=green)

### Approaches

#### Approach A: SSE + Custom `useAutoScroll` Hook (RECOMMENDED)

Build a custom hook that:

1. Tracks whether the user is "at the bottom" of the scroll container
2. Auto-scrolls to bottom when new events arrive, **only if** already at the bottom
3. Pauses auto-scroll when the user manually scrolls up
4. Resumes when the user scrolls back to the bottom

```typescript
function useAutoScroll(deps: unknown[]) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUp = useRef(false);

  // Detect manual scroll up
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    isUserScrolledUp.current = !atBottom;
  }, []);

  // Auto-scroll when deps change (new events), only if not user-scrolled-up
  useEffect(() => {
    if (isUserScrolledUp.current) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, deps);

  return { containerRef, handleScroll };
}
```

Usage:

```tsx
const { containerRef, handleScroll } = useAutoScroll([events])

<div
  ref={containerRef}
  onScroll={handleScroll}
  className="overflow-y-auto flex-1"
>
  {events.map(e => <EventRow key={e.id} event={e} />)}
</div>
```

**Pros:**

- Zero dependencies beyond React
- Respects user intent — does not fight the user's scroll position
- The "8px threshold" handles sub-pixel rounding without false positives
- Can be extended to show a "Jump to bottom" button when `isUserScrolledUp.current` is true

**Cons:**

- Custom implementation — must be tested for edge cases (initial render, rapid events)
- Does not handle variable-height rows gracefully without TanStack Virtual

**Alternative library: `use-stick-to-bottom`** (Stackblitz Labs)

- Zero-dependency, ResizeObserver-based, spring animation
- Provides `useStickToBottomContext` for `isAtBottom` state and `scrollToBottom` callable
- Best for cases where smooth animation of new content is needed (AI streaming)
- Slightly more than needed for a compact event log — overkill unless events are streamed character-by-character

#### Approach B: Virtualized List (TanStack Virtual)

For very high-frequency logs (100+ events/second), use TanStack Virtual to render only visible rows.

**Pros:**

- Handles unlimited event counts without DOM bloat
- Smooth scrolling even with 10,000+ events

**Cons:**

- Significant complexity — measuring dynamic row heights, managing scroll positions with virtual scroll
- Auto-scroll with virtualization has a known open issue in TanStack Virtual (GitHub issue #537)
- Overkill for typical agent event logs (tens to hundreds of events per session)

**Recommendation:** Do not use virtualization unless profiling shows render bottleneck at >500 events.

#### Approach C: React Query Polling

Poll `GET /api/events?since=<timestamp>` every 2 seconds with TanStack Query.

**Pros:**

- Simpler than SSE — no long-lived connection management
- TanStack Query handles caching, deduplication, refetch-on-focus

**Cons:**

- 2-second delay for new events — not "real-time"
- Creates unnecessary server load even when no events are occurring
- SSE is the right transport for push-based event streams — it was designed for this

### Filtering/Searching

Implement client-side filtering using a controlled input with `useMemo`:

```typescript
const filteredEvents = useMemo(
  () =>
    events.filter(
      (e) =>
        (!typeFilter || e.type === typeFilter) &&
        (!searchQuery || e.message.toLowerCase().includes(searchQuery.toLowerCase()))
    ),
  [events, typeFilter, searchQuery]
);
```

UI: A small toolbar above the log with a text input (shadcn `Input`, compact) and a type filter (shadcn `ToggleGroup` or segmented tabs). Keep the toolbar minimal — this is a developer-facing panel, not a consumer app.

### SSE Integration Pattern

```typescript
// In the event log widget or hook
useEffect(() => {
  const source = new EventSource(`/api/sessions/${sessionId}/events`);

  source.addEventListener('event', (e) => {
    const event = JSON.parse(e.data) as AgentEvent;
    setEvents((prev) => [...prev, event]);
  });

  source.addEventListener('error', () => {
    // Reconnect after delay — EventSource handles this natively
    source.close();
  });

  return () => source.close();
}, [sessionId]);
```

Note: The native `EventSource` API does not support custom headers (for auth). If `MCP_API_KEY` auth is needed for the events endpoint, use `fetch` with `ReadableStream` or a library like `eventsource` (npm) that supports headers.

### Timestamp Display

- Use `HH:mm:ss` for real-time logs (most relevant part is seconds)
- Use relative time (e.g., "2m ago") for historical/archived logs
- Use `date-fns` `format()` — already likely in the project
- `tabular-nums` CSS property prevents timestamp column from dancing as digits change

### Recommendation Summary for Topic 5

- **Approach A (custom `useAutoScroll` + SSE)** for most cases
- **`use-stick-to-bottom`** if you want library-backed auto-scroll with spring animation
- **TanStack Virtual** only if log volume exceeds 500 events and profiling confirms it
- **Client-side filtering** with `useMemo` — keep it in the component, not on the server
- Row design: timestamp | type badge | message text, in a fixed-height `overflow-y-auto` container

---

## Key Findings Summary

1. **FSD shared constants** — `shared/lib/[domain].ts` is the correct home for color maps and display constants per FSD spec. `shared/config` is for env/flags. Feature-local constants are fine until they're needed in 3+ places.

2. **Error display in compact cards** — shadcn `Collapsible` with a "Show more" trigger is the only pattern that is both compact and fully keyboard/screen-reader accessible. Tooltip-only and HoverCard patterns fail WCAG 2.1 for keyboard users.

3. **Binding list views** — List rows (not table, not cards) are the right layout for small-count homogeneous binding data with inline actions. Empty states require an icon, a headline, a description, and a CTA.

4. **Module splitting** — Facade pattern: thin coordinator + focused sub-modules + a stable `index.ts` public surface. Never use internal barrel files. Split Zod schemas by entity, not by schema type.

5. **Event log UI** — Custom `useAutoScroll` hook that respects user scroll intent + SSE for transport + `useMemo` for client-side filtering. Row format: `time | badge | message` with tabular-nums timestamp column.

---

## Research Gaps & Limitations

- No direct FSD codebase examples were found showing color map placement in production apps — the placement in `shared/lib` is inferred from FSD documentation's explicit mention of "colors" as a lib concern
- The `use-stick-to-bottom` README could not be fetched due to rate limiting — the API description is from search result excerpts and npm page summaries
- Binding list UI patterns for the specific adapter→agent relationship were not found in any design system documentation; recommendations are based on general relationship management UI patterns

## Contradictions & Disputes

- **Barrel files**: TkDodo (influential React Query maintainer) advocates strongly against barrel files; FSD documentation's guidance to "always import from barrels" in DorkOS AGENTS.md is specifically about the module's public `index.ts` barrel — not internal barrels. These are compatible: use barrels only at the public API boundary.
- **`shared/config` vs `shared/lib`**: FSD documentation says `config` is for "constants and flags" while also saying `lib` is for "colors, dates, text manipulation." Color maps that are pure lookup tables could fit either; the `lib` placement is preferred because the content is behavior (a function/map) rather than configuration.

---

## Sources & Evidence

### Topic 1 — FSD Constants

- [Slices and Segments | FSD Documentation](https://feature-sliced.design/docs/reference/slices-segments) — defines `lib` as "library code that other modules need" and explicitly lists "colors" as an example lib area
- [Layers | Feature-Sliced Design](https://feature-sliced.design/docs/reference/layers) — clarifies `shared/lib` vs `shared/config` segments
- [FSD Overview](https://feature-sliced.design/docs/get-started/overview) — v2.1 allows application-aware things in Shared

### Topic 2 — Error Display

- [Tooltip Accessibility WCAG 1.4.13](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html) — defines dismissable, hoverable, persistent requirements
- [shadcn/ui Discussion #2417 — Tooltip vs HoverCard](https://github.com/shadcn-ui/ui/discussions/2417) — confirms HoverCard is inaccessible to keyboard users
- [Collapsible — shadcn/ui](https://ui.shadcn.com/docs/components/radix/collapsible) — Radix-based, aria-expanded managed automatically
- [Popping preconceived popover ponderings | scottohara.me](https://www.scottohara.me/blog/2025/03/14/popovers.html) — accessibility analysis of HTML popover API
- [Tooltip Pattern | UX Patterns for Developers](https://uxpatterns.dev/patterns/content-management/tooltip)

### Topic 3 — Binding List Views

- [Table vs List vs Cards: When to Use Each Data Display Pattern (2025) | UX Patterns for Developers](https://uxpatterns.dev/pattern-guide/table-vs-list-vs-cards)
- [Carbon Design System — Empty States Pattern](https://carbondesignsystem.com/patterns/empty-states-pattern/)
- [Empty State | Atlassian Design](https://atlassian.design/components/empty-state/)
- [Editing CRUD Inline Example — Material React Table V3](https://www.material-react-table.com/docs/examples/editing-crud-inline-cell)

### Topic 4 — Module Splitting

- [Leveraging Facade and Adapter Patterns for Backward Compatibility in TypeScript | CodeSignal](https://codesignal.com/learn/courses/backward-compatibility-in-software-development-with-typescript/lessons/leveraging-facade-and-adapter-patterns-for-backward-compatibility-in-typescript)
- [The Barrel Trap: How I Learned to Stop Re-Exporting and Love Explicit Imports | DEV Community](https://dev.to/elmay/the-barrel-trap-how-i-learned-to-stop-re-exporting-and-love-explicit-imports-3872)
- [Please Stop Using Barrel Files | TkDodo](https://tkdodo.eu/blog/please-stop-using-barrel-files)
- [Facade — Design Patterns in TypeScript | Refactoring Guru](https://refactoring.guru/design-patterns/facade/typescript/example)
- [Sharing Types and Validations with Zod Across a Monorepo | Leapcell](https://kr.leapcell.io/blog/en/sharing-types-and-validations-with-zod-across-a-monorepo)
- [Zod Schema Structure Discussion](https://github.com/colinhacks/zod/discussions/1663)

### Topic 5 — Event Log UI

- [use-stick-to-bottom | Stackblitz Labs](https://github.com/stackblitz-labs/use-stick-to-bottom) — lightweight hook for sticky scroll with spring animation
- [react-scroll-to-bottom — npm](https://www.npmjs.com/package/react-scroll-to-bottom) — useSticky hook
- [How to Detect When a User Scrolls to Bottom of div with React](https://thewebdev.info/2021/09/25/how-to-detect-when-a-user-scrolls-to-bottom-of-div-with-react/)
- [Autoscrolling lists with React Hooks | DEV Community](https://dev.to/forksofpower/autoscrolling-lists-with-react-hooks-10o7)
- [Real-Time UI Updates with SSE | codingwithmuhib.com](https://www.codingwithmuhib.com/blogs/real-time-ui-updates-with-sse-simpler-than-websockets)
- [Developing Real-Time Web Applications with Server-Sent Events | Auth0](https://auth0.com/blog/developing-real-time-web-applications-with-server-sent-events/)
- [TanStack Virtual Issue #537 — Auto-scroll with virtual scrolling](https://github.com/TanStack/virtual/issues/537)

---

## Search Methodology

- Searches performed: 18
- Most productive search terms: "FSD shared/lib vs shared/config segments", "use-stick-to-bottom sticky scroll React", "shadcn HoverCard Tooltip Popover difference accessibility", "table vs list vs card UX decision framework", "facade pattern TypeScript backward compatibility module splitting"
- Primary information sources: feature-sliced.design official docs, shadcn/ui GitHub discussions, W3C WCAG documentation, UX Patterns for Developers, Refactoring Guru, npm package pages
