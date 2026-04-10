---
title: 'Extended Thinking Visibility — UI/UX Patterns for Displaying AI Reasoning in Chat Interfaces'
date: 2026-03-16
type: external-best-practices
status: active
tags:
  [
    extended-thinking,
    reasoning,
    streaming,
    chat-ui,
    collapsible,
    animation,
    progressive-disclosure,
    calm-tech,
    shadcn,
    framer-motion,
  ]
feature_slug: extended-thinking-visibility
searches_performed: 10
sources_count: 22
---

# Extended Thinking Visibility — UI/UX Patterns for Displaying AI Reasoning in Chat Interfaces

## Research Summary

The industry has converged on a **Progressive Disclosure Collapsible Block** as the dominant pattern for surfacing AI reasoning in chat interfaces. Claude.ai, ChatGPT, Perplexity, and v0 all implement variations of the same core mechanic: a bounded, labeled container that is visible (and optionally animated) during token streaming, then collapses to a minimal affordance once the model's response begins. The key insight from ShapeofAI's Stream of Thought pattern taxonomy is that visibility should be **tailored to context** — developer-tool users running complex tasks want full traces; simple chat users want minimal visibility. For DorkOS, the Calm Tech design constraint strongly favors a subtle but honest approach: show the thinking panel by default during streaming, collapse it automatically on completion (preserving user access), with no aggressive motion.

---

## Key Findings

### 1. Claude.ai — Reference Implementation

Claude.ai is the authoritative reference for how extended thinking should look because it is Anthropic's own implementation of the same SDK events DorkOS consumes.

**Visual treatment:**

- A labeled **"Thinking" section appears above the response** in the message thread
- During processing: a **timer indicator** shows elapsed thinking time alongside the label
- After completion: the section is presented as an **expandable/collapsible accordion**
- Default state post-completion: **collapsed** — users click to reveal the full chain of thought
- Thinking text is shown in raw form (unfiltered internal monologue including self-corrections and branches)

**Streaming behavior:**

- An **ellipsis animation** (`...`) indicates active streaming
- The block grows as tokens arrive
- Safety note: thinking may truncate with a message if content triggers safety systems

**Transition from thinking → response:**

- The thinking block stays in place (collapsed) once the response begins streaming
- The response text appears below, in the normal assistant message style
- No dramatic animation — a calm, sequential layout change

**Source:** [Using Extended Thinking — Claude Help Center](https://support.claude.com/en/articles/10574485-using-extended-thinking), [Claude's Extended Thinking — Anthropic News](https://www.anthropic.com/news/visible-extended-thinking)

---

### 2. ChatGPT — "Think" Box Pattern

OpenAI's o1/o3/o4 reasoning models established one of the first widely-seen implementations of this pattern.

**Visual treatment:**

- A **dedicated "Think" button** in the prompt composer activates reasoning mode
- The reasoning appears in a **structured "thinking" box** — a visually distinct container, separate from the response
- In newer versions (o4-mini, o3 web): the box is more visually refined with a "neat little box" layout
- Reasoning tokens are **not exposed via the API** (they are consumed and discarded); only the UI surface shows a summary

**Key difference from Claude:**

- OpenAI does **not expose raw reasoning tokens** to developers via API — they only show a curated summary in the UI
- Claude exposes raw `thinking` blocks, giving developers (and DorkOS) full access

**Source:** [OpenAI Reasoning Models](https://platform.openai.com/docs/guides/reasoning), [OpenAI "Think" Button Community Discussion](https://community.openai.com/t/what-is-the-new-think-button-for-o1/1108023)

---

### 3. Cursor IDE — Toggle Pattern (Inconsistent)

**Visual treatment:**

- A **"thinking toggle"** that sometimes appears in the chat panel showing the model's thought process
- Users can expand/collapse it
- Critically: this feature is **inconsistently visible** — community threads explicitly complain it disappears across versions

**Key lesson for DorkOS:**

- Inconsistency around thinking visibility is one of Cursor's most-cited UX complaints
- Users find it critical for transparency ("without it, the AI feels like a black box")
- **Implication:** DorkOS should make the thinking block reliably present whenever the model emits thinking tokens — never silently swallowed

**Source:** [Cursor "thinking toggle" forum thread](https://forum.cursor.com/t/please-make-thinking-toggle-visible/76708), [OpenAI Community thread on IDE thinking display](https://community.openai.com/t/i-am-wondering-how-ide-s-like-cursor-and-antigravity-display-thinking-with-every-model/1374556)

---

### 4. Perplexity — Step-by-Step Tab Pattern

**Visual treatment:**

- Pro Search mode shows a **"steps" tab** above the results pane
- Each search/reasoning step is shown as a discrete labeled item
- After completion, the steps are accessible in a **separate drawer/panel** while the answer occupies the main canvas
- Deep Research mode surfaces "thinking in stages" — live step-by-step planning visible during generation

**Key pattern:**

- Perplexity separates **source retrieval** from **reasoning logic** into different visual containers (Grok does the same)
- The steps tab keeps the primary answer uncluttered while still allowing inspection

**Source:** [Perplexity Deep Research](https://www.perplexity.ai/hub/blog/introducing-perplexity-deep-research), [ShapeofAI Stream of Thought](https://www.shapeof.ai/patterns/stream-of-thought)

---

### 5. v0.dev (Vercel) — Inline Then Drawer Pattern

**Visual treatment:**

- v0 exposes its reasoning **inline** until it is ready to start building
- Once building begins, the remaining reasoning steps are visible **from the left drawer** while the app builds in the main canvas
- This mirrors a "show thinking inline, then move it out of the way" progression

**Vercel AI SDK approach (AI Elements library):**

- Provides a first-class **Reasoning Component** specifically for displaying model thought processes
- `useChat` hook streams `reasoning-delta` parts to the client by default (can be disabled via `sendReasoning: false`)
- `message.parts` array contains typed `reasoning` entries interspersed with `text` entries
- The SDK normalizes reasoning across providers (OpenAI, Anthropic, Google, Bedrock)

```typescript
// Vercel AI SDK message.parts pattern
message.parts?.map((part, i) => {
  if (part.type === "reasoning") {
    return <ReasoningBlock key={i} text={part.reasoning} />;
  }
  if (part.type === "text") {
    return <TextBlock key={i} text={part.text} />;
  }
});
```

**Source:** [AI SDK 4.2 — Message Parts](https://vercel.com/blog/ai-sdk-4-2), [AI Elements](https://vercel.com/academy/ai-sdk/ai-elements), [Vercel Reasoning Docs](https://vercel.com/docs/ai-gateway/capabilities/reasoning)

---

### 6. Stream of Thought — Industry Pattern Taxonomy (ShapeofAI)

ShapeofAI's canonical pattern documentation identifies the Stream of Thought as one of the foundational AI UX patterns:

> "A bounded box, with details minimized or altogether hidden behind a click, showing the AI's logic in real time or for review when complete."

**Three expression modes:**

1. Human-readable plans (previewing intended actions)
2. Execution logs (documenting tool calls)
3. Compact summaries (capturing reasoning/decisions)

**Principles:**

- "Tailor visibility to context" — complex tasks need deeper traces; simple chats need minimal visibility
- "Make steps into states" — queued, running, completed, error — with clear visual progress cues
- "Separate plan, execution, and evidence" into synchronized views

**Source:** [ShapeofAI — Stream of Thought Pattern](https://www.shapeof.ai/patterns/stream-of-thought)

---

## Detailed Analysis

### Streaming UX for Thinking Blocks

**During streaming (model is emitting `thinking_delta` events):**

The dominant industry pattern is to show the thinking block **open** with a live animation:

- A **pulsing label** ("Thinking..." with animated dots or a spinner) as the header
- The actual thinking text streaming in below the label (using `streamdown` or direct text append)
- The block grows as tokens arrive — this requires CSS `height: auto` or Framer Motion's `layout` prop to avoid jarring jumps
- Some implementations show just the header (a shimmer skeleton) and only reveal text on user expansion

For DorkOS's Calm Tech aesthetic, the **recommended streaming treatment** is:

- Subtle pulsing label with a small activity indicator (not a spinner — a breathing opacity animation or 3-dot cycle)
- Thinking text streams in at normal reading pace (not suppressed)
- Block uses `motion.div layout` so height grows smoothly without explicit height calculations

**On completion (model transitions to `text_delta` events):**

The thinking block should **auto-collapse** once the response begins:

- This is the pattern Claude.ai uses and it is the right default
- Rationale: the thinking is scaffolding — users want the answer; thinking is secondary
- Collapse with a gentle height transition (200–300ms ease-out)
- The collapsed block becomes a clickable affordance: "Thought for X seconds" or "Thinking (N tokens)" with an expand chevron

**After complete — auto-collapse vs. stay open:**

Research indicates auto-collapse is the right default for developer tools. The ShapeofAI taxonomy notes that simple interactions "need little-to-no visibility into the AI's process." Auto-collapsing respects the user's primary intent (the answer) while preserving access to the reasoning. Users can explicitly expand if they want to review.

**Long thinking blocks (1000+ words):**

- Auto-collapse is even more important here to prevent the chat from being dominated by reasoning content
- When expanded, the block should be **max-height constrained with internal scroll** (e.g., `max-h-64 overflow-y-auto`) to avoid pushing the response off screen
- Alternatively, a "Show full thinking" link at the bottom that expands to unconstrained height

---

### Approach Comparison for DorkOS

#### Approach A: Collapsible Accordion Block

**Description:** Thinking appears as a collapsible block above the response. Expanded during streaming, collapsed by default after completion. Click to expand/collapse.

| Dimension             | Assessment                                      |
| --------------------- | ----------------------------------------------- |
| Complexity            | Low–Medium                                      |
| Calm Tech alignment   | High — thinking is accessible but not intrusive |
| Streaming fidelity    | High — block grows naturally with content       |
| Transition handling   | Smooth — collapse on response start             |
| Long content handling | Good — collapse hides length                    |
| Developer familiarity | High — mirrors Claude.ai exactly                |

**Pros:**

- Mirrors the reference implementation (Claude.ai) — familiar to the target user
- Clean separation between thinking and response
- Dismissable without losing access
- Easiest to implement correctly with `motion.div` + `AnimatePresence`

**Cons:**

- Requires state management to track streaming vs. complete phases
- Auto-collapse logic needs to be tied to stream events

**Verdict: Primary recommendation.**

---

#### Approach B: Inline Dimmed Text

**Description:** Thinking text rendered inline before the response in a muted/dimmed style. Visually distinct but always visible.

| Dimension             | Assessment                                       |
| --------------------- | ------------------------------------------------ |
| Complexity            | Low                                              |
| Calm Tech alignment   | Medium — always-visible thinking is noisy        |
| Streaming fidelity    | High — simplest to implement                     |
| Transition handling   | None — abrupt visual shift to normal text        |
| Long content handling | Poor — long thinking blocks dominate the message |
| Developer familiarity | Low — no major tool uses this pattern            |

**Pros:**

- Simplest implementation (no collapse/expand state)
- Fully transparent — nothing hidden

**Cons:**

- Long thinking blocks make the chat unreadable
- No way to dismiss — forces scrolling past reasoning
- Violates "Less, but better" — reasoning is noise most of the time
- No smooth transition from thinking to response

**Verdict: Rejected. Violates Calm Tech and Dieter Rams principles.**

---

#### Approach C: Side Panel / Popover

**Description:** Thinking content shown in a separate panel or popover, accessed via a button/icon. Main response stream uninterrupted.

| Dimension             | Assessment                                           |
| --------------------- | ---------------------------------------------------- |
| Complexity            | High — requires panel state, layout changes          |
| Calm Tech alignment   | High — main thread is clean                          |
| Streaming fidelity    | Medium — requires streaming to a non-primary surface |
| Transition handling   | Complex — popover appears on demand                  |
| Long content handling | Excellent — panel scrolls independently              |
| Developer familiarity | Low — no major chat tool uses this                   |

**Pros:**

- Keeps the main message thread completely clean
- Ideal for very long thinking sessions

**Cons:**

- Context switching cost — thinking and response are spatially separated
- Adds layout complexity (sidebar state, responsive behavior)
- Diminishes the "show the work" value — easy for users to ignore entirely
- DorkOS chat view is already constrained in width; a side panel adds significant complexity

**Verdict: Rejected for v1. Consider as an opt-in view mode in a future iteration.**

---

#### Approach D: Progressive Disclosure (Claude.ai style)

**Description:** During streaming: show a "Thinking..." indicator with animated dots or shimmer. After complete: collapsible block with thinking content, collapsed by default. Subtle visual nesting to differentiate from response text.

This is essentially a refined version of Approach A with explicit attention to the streaming state UI.

| Dimension             | Assessment                                                 |
| --------------------- | ---------------------------------------------------------- |
| Complexity            | Medium                                                     |
| Calm Tech alignment   | Highest — right information at the right time              |
| Streaming fidelity    | Highest — two distinct streaming states, both handled      |
| Transition handling   | Excellent — explicit transition from streaming to complete |
| Long content handling | Good — collapsed by default                                |
| Developer familiarity | Highest — Claude.ai, ChatGPT both use this                 |

**Phases:**

1. **Idle** — nothing shown
2. **Thinking (streaming)** — animated "Thinking..." header + streaming text inside an open block
3. **Transition** — thinking complete, response begins → block collapses with animation
4. **Complete** — collapsed chip showing "Thought for Xs" with expand chevron; response renders normally below

**Pros:**

- Honest — users can always see that thinking happened
- Minimal during normal use — collapsed thinking doesn't crowd the chat
- Smooth streaming experience — both phases have clear affordances
- Matches both Claude.ai and ChatGPT's established mental model

**Cons:**

- More states to manage vs. Approach A
- Requires streaming phase detection (know when thinking ends, response begins)

**Verdict: Primary recommendation (this is Approach A with explicit streaming-state design).**

---

### Animation Specification for DorkOS

DorkOS uses `motion` (Framer Motion) from `contributing/animations.md`. The following animation design aligns with the Calm Tech aesthetic:

**Streaming state (header indicator):**

```tsx
// Breathing opacity pulse — calm, not aggressive
<motion.div
  animate={{ opacity: [0.4, 1, 0.4] }}
  transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
>
  Thinking
</motion.div>
```

**Block expand/collapse:**

```tsx
// CSS grid trick — no JS height measurement needed
// Matches the pattern identified in subagent research (20260316_subagent_activity_streaming_ui_patterns.md)
<motion.div
  style={{ overflow: 'hidden' }}
  animate={{ height: isOpen ? 'auto' : 0 }}
  transition={{ duration: 0.2, ease: 'easeOut' }}
>
  {thinkingContent}
</motion.div>
```

Or using CSS grid (zero JS):

```css
.thinking-body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 200ms ease-out;
}
.thinking-body.open {
  grid-template-rows: 1fr;
}
.thinking-body > div {
  overflow: hidden;
}
```

**Auto-collapse trigger:**

```typescript
// Collapse when first text_delta arrives after thinking phase
useEffect(() => {
  if (phase === 'responding' && wasThinking) {
    setThinkingOpen(false);
  }
}, [phase]);
```

**Collapsed affordance label:**

```
"Thought for 8s"  ↕ (chevron)
```

Or for token-aware implementations:

```
"Thinking (1,240 tokens)"  ↕
```

---

### Overlapping Patterns from Prior DorkOS Research

The `20260316_subagent_activity_streaming_ui_patterns.md` research contains directly relevant findings for collapsible streaming blocks in DorkOS's chat UI:

- The **CSS `grid-template-rows: 0fr → 1fr` trick** is already documented as the dominant no-JS-height approach for streaming collapsibles
- The **ARIA contract** for collapsible blocks is `button[aria-expanded] + div[role=region][id=X]`
- The **status line pattern** (elapsed time, status icon) is established for other streaming blocks in the codebase

The `ThinkingBlock.tsx` component should follow the same structural contract as the `SubagentBlock` component (once built), to maintain visual consistency across all streaming-block types in the chat view.

---

## Potential Solutions

### Solution 1 (Recommended): Accordion with Streaming-Aware States

**Component: `ThinkingBlock.tsx`**

Four discrete visual states driven by stream phase:

| State        | Visual                                                    |
| ------------ | --------------------------------------------------------- |
| `idle`       | Nothing rendered                                          |
| `streaming`  | Open block with breathing "Thinking..." label + live text |
| `collapsing` | Animated height collapse (200ms)                          |
| `collapsed`  | "Thought for Xs" chip with expand chevron                 |

**Implementation surface:**

- Add `ThinkingPart` to `MessagePart` union in `packages/shared/src/types.ts`
- Create `ThinkingBlock.tsx` in the appropriate FSD layer (likely `entities/message/ui/`)
- Wire to SSE stream: detect `content_block_start(type: "thinking")` → `content_block_delta(thinking_delta)` → `content_block_stop` → switch to response phase

**Complexity:** Medium

---

### Solution 2: Minimal Collapsed-Only Display

Only show a collapsed "Thinking block available" affordance — never stream the text in real time. Users expand to read after the response is complete.

**Pros:** Simplest implementation, no streaming complexity
**Cons:** Misses the "honest by design" principle — users can't see the thinking in progress
**Verdict:** Acceptable as a phased rollout step (Phase 1 = collapsed affordance, Phase 2 = live streaming)

---

### Solution 3: User Preference Toggle

Add a setting in DorkOS preferences: "Show thinking blocks" with options [Always visible | Collapsed by default | Hidden]. Default: Collapsed by default.

**Pros:** Respects user agency; Priya-friendly (she may want always-visible for architecture work)
**Cons:** Adds preference complexity
**Verdict:** Worth adding in v2 once the base component is stable.

---

## Security Considerations

- **Thinking content is model output** — it may contain sensitive reasoning about the user's codebase, credentials, or plans. DorkOS should treat it with the same access controls as the response text (no special exposure).
- **Safety truncation**: Claude may truncate thinking blocks when safety systems intervene. The UI must handle partial/truncated thinking gracefully — a `truncated: true` flag should suppress the expand chevron or add a note.
- **Token budget awareness**: Extended thinking uses the configured `budgetTokens`. If DorkOS surfaces a token counter, thinking tokens should be counted (Anthropic counts them as output tokens). Do not surprise users with unexpectedly large token bills from silent thinking.

---

## Performance Considerations

- **Streaming text append**: Thinking blocks may emit 100–10,000+ tokens. The component must efficiently append to a string buffer without re-rendering the entire message list. Use a `ref`-based buffer that flushes to state at a controlled rate (e.g., every 50ms via `requestAnimationFrame`) rather than on every `thinking_delta`.
- **Auto-scroll management**: During thinking streaming, the chat should auto-scroll. When the thinking block collapses on response start, ensure the response text is scrolled into view without a jarring position jump.
- **Max height + scroll for long blocks**: Cap the expanded thinking block at `max-h-64` (or `max-h-96` for power users) with `overflow-y-auto`. This prevents extremely long thinking sessions from dominating the viewport.
- **Animation performance**: Use CSS transitions (`grid-template-rows`) over JS-driven height animations wherever possible. Framer Motion's `layout` prop is acceptable but adds compute cost on every token append — reserve it for the header/chip only.

---

## Recommendation

**Implement Approach D (Progressive Disclosure, Claude.ai-style) as `ThinkingBlock.tsx`.**

This is the right choice for DorkOS for three reasons:

1. **Honest by design**: It never hides that thinking happened. The collapsed "Thought for Xs" chip is always present in the message thread, giving users access without clutter. This directly satisfies the "Honest by design" decision filter from `AGENTS.md`.

2. **Calm Tech alignment**: Open during streaming (when it's actively relevant), collapsed after (when the answer is the focus). Right information, right time. Jony Ive would approve of this restraint.

3. **The Kai Test**: Kai runs 10-20 sessions per week. He wants to glance at what the agent was thinking when debugging a bad output, not wade through walls of reasoning text on every message. Collapsed-by-default respects his workflow.

**Execution order:**

1. Add `ThinkingPart` to `MessagePart` union in `packages/shared/src/`
2. Wire server-side SSE to emit `thinking_delta` events (parallel to `text_delta`)
3. Build `ThinkingBlock.tsx` with 4-state design (idle / streaming / collapsing / collapsed)
4. Use `grid-template-rows` CSS transition for the collapse — consistent with the subagent block pattern
5. Auto-collapse when first `text_delta` arrives (phase transition detection)
6. ARIA: `button[aria-expanded]` on the header chip, `role=region` on the content div

**Do not implement** Approach B (inline dimmed text) or Approach C (side panel) in v1.

---

## Research Gaps & Limitations

- No direct screenshots of the Claude.ai thinking block were obtained — the visual description is based on documentation and user reports, not direct visual inspection
- Cursor's exact visual implementation could not be confirmed from screenshots — only community descriptions
- No user research data found on whether developers prefer thinking blocks collapsed or expanded by default (this is inferred from product decisions, not measured preference)
- Token budget cost implications for DorkOS users were not quantified — depends on usage patterns

---

## Contradictions & Disputes

- **Auto-collapse default**: Claude.ai collapses by default; some Cursor users explicitly request always-visible. The DorkOS recommendation (collapsed default with user preference in v2) resolves this split.
- **Show raw vs. summarized thinking**: Claude.ai shows raw thinking; ChatGPT shows only a curated summary. DorkOS should show raw thinking (it's a developer tool — Kai wants the unfiltered view).
- **Stream thinking live vs. hide until complete**: Both patterns exist in the wild. Live streaming is more honest; hide-until-complete is simpler. Given DorkOS's "honest by design" principle, live streaming is preferred.

---

## Sources & Evidence

- [Using Extended Thinking — Claude Help Center](https://support.claude.com/en/articles/10574485-using-extended-thinking)
- [Claude's Extended Thinking — Anthropic News](https://www.anthropic.com/news/visible-extended-thinking)
- [Building with Extended Thinking — Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [OpenAI Reasoning Models — Platform Docs](https://platform.openai.com/docs/guides/reasoning)
- [OpenAI "Think" Button Community Thread](https://community.openai.com/t/what-is-the-new-think-button-for-o1/1108023)
- [Cursor "thinking toggle" visibility forum thread](https://forum.cursor.com/t/please-make-thinking-toggle-visible/76708)
- [Cursor IDE thinking display — OpenAI Community](https://community.openai.com/t/i-am-wondering-how-ide-s-like-cursor-and-antigravity-display-thinking-with-every-model/1374556)
- [ShapeofAI — Stream of Thought Pattern](https://www.shapeof.ai/patterns/stream-of-thought)
- [Perplexity Deep Research](https://www.perplexity.ai/hub/blog/introducing-perplexity-deep-research)
- [Vercel AI SDK 4.2 — Message Parts & Reasoning](https://vercel.com/blog/ai-sdk-4-2)
- [AI Elements — Vercel Academy](https://vercel.com/academy/ai-sdk/ai-elements)
- [Vercel Reasoning Gateway Docs](https://vercel.com/docs/ai-gateway/capabilities/reasoning)
- [Framer Motion Layout Animations](https://www.framer.com/motion/)
- [Progressive Disclosure — IxDF](https://ixdf.org/literature/topics/progressive-disclosure)
- [DorkOS Subagent Activity Streaming UI Patterns](research/20260316_subagent_activity_streaming_ui_patterns.md) _(prior DorkOS research — directly applicable)_

---

## Search Methodology

- Searches performed: 10
- Most productive terms: "Claude.ai extended thinking UI", "ChatGPT o1 o3 thinking reasoning display", "ShapeofAI stream of thought pattern", "Vercel AI SDK useChat reasoning display", "progressive disclosure AI thinking streaming UX"
- Primary source types: Official product documentation (Anthropic, OpenAI, Vercel), UX pattern databases (ShapeofAI, IxDF), community forums (Cursor, OpenAI), internal prior research
