---
title: "Prompt Suggestion Chips UX — Patterns, Placement, and DorkOS Recommendation"
date: 2026-03-16
type: external-best-practices
status: active
tags: [chat-ui, suggestion-chips, prompt-suggestions, ux-patterns, developer-tools, animation]
feature_slug: prompt-suggestion-chips
searches_performed: 10
sources_count: 18
---

## Research Summary

The `prompt_suggestion` SDK message type emits after each agent turn when `promptSuggestions: true` is set on the query options. Industry analysis across ChatGPT, Gemini, Perplexity, GitHub Copilot, and Cursor reveals strong consensus: suggestion chips work best **inline below the last assistant message**, **dismiss on any submission**, and **populate the input (do not auto-submit)**. For a developer-tools audience that values efficiency and control, Approach A (inline chips below message) wins decisively over floating or input-embedded alternatives.

---

## Key Findings

1. **SDK contract is fully established**: `SDKPromptSuggestionMessage` has type `"prompt_suggestion"`, a plain `suggestion: string` field, `uuid`, and `session_id`. The stream event handler in `stream-event-handler.ts` currently has no case for `"prompt_suggestion"` — it would fall through to the `default` warn branch. This is the correct hook point to collect suggestions and surface them in the UI.

2. **Industry placement consensus: inline below last message**. NN/G research confirms "follow-up questions are usually displayed below the answer to the user's previous prompt." ChatGPT, Perplexity, and Gemini all use this pattern. Floating bars are uncommon in post-conversation contexts and create accessibility/layering problems.

3. **Input interaction consensus: populate, do not auto-submit**. NN/G found chips "trigger the prompt directly or insert a longer prompt into the input field for users to edit before submitting." For developer users who want to review and modify before running, populate-only is strictly safer. Auto-submit is only appropriate for dead-simple single-word responses ("Yes" / "No").

4. **Persistence: ephemeral, cleared on any send**. Suggestions are contextually relevant only to the current turn result. Once the user sends a new message (whether from a chip or from their own input), the old suggestions should be removed. They do not belong in message history — they are transient UI affordances, not conversation content.

5. **Cross-client sync: send the suggestion text over SSE, never sync UI-only state**. The `prompt_suggestion` event is already session-scoped via `session_id`. The server can relay it through the existing SSE stream. Both clients (main web app, Obsidian plugin) will receive the event and render suggestions independently. Since suggestions clear on any message send, they stay naturally in sync — both clients will clear on the same user turn.

6. **Input guard: hide chips when input has content**. When the user has already started typing, suggestion chips should be hidden entirely (not disabled). Per Smashing Magazine and Nielsen Norman Group guidance: hide when contextually irrelevant, disable only when the element exists but cannot yet be used. Chips with typed input already present are irrelevant, not blocked.

7. **Security: the `suggestion` string is plain text from the SDK — no HTML rendering required**. React's JSX escaping provides full XSS protection by default. Never render suggestion text via `dangerouslySetInnerHTML`. The suggestion is agent-generated text that should be treated as untrusted display content, rendered as a text node.

8. **Animation: `AnimatePresence` + `layout` prop for coordinated stagger**. Motion (formerly Framer Motion) `AnimatePresence` handles unmount exit animations. The `layout` prop coordinates sibling reflow so removal of one chip does not cause jarring jumps. This is the existing animation approach in DorkOS.

---

## Detailed Analysis

### The SDK Event

The `SDKPromptSuggestionMessage` type, from the official TypeScript SDK reference:

```typescript
type SDKPromptSuggestionMessage = {
  type: "prompt_suggestion";
  suggestion: string;
  uuid: UUID;
  session_id: string;
};
```

Enabled with `promptSuggestions: true` in the `query()` options object. Emitted **after each turn** — meaning after the agent finishes a response, not during streaming. This makes the timing clean: suggestions always appear after the `done` event fires, when the chat is back in `idle` state.

The DorkOS server currently pipes SDK messages through the SSE stream. Adding `"prompt_suggestion"` event forwarding at the server level is the only backend change needed — no schema changes to the database, no session store impact, since suggestions are transient.

### Approach Comparison

#### Approach A: Inline Chips Below Last Assistant Message

Chips are rendered as a small horizontal row of pill buttons directly below the final assistant message bubble, scrolling with the conversation.

**Pros:**
- Industry consensus location (ChatGPT, Perplexity, Gemini all use this)
- Contextually associated with the message that generated them
- Keyboard navigation follows natural DOM order (Tab to first chip after the message)
- Invisible to users who scroll past (non-intrusive)
- No z-index or stacking context issues
- In conversation replay / history, suggestions simply don't exist (they were never persisted) — clean separation

**Cons:**
- Requires scroll to see if user is far up in history (mitigated by auto-scroll on `done` event which already exists)
- Three-chip rows can be wide on small viewports — needs wrapping

**Complexity:** Low. A new `PromptSuggestionChips` component in `features/chat/ui/`. State stored locally in the chat feature model alongside `status`. Clears on message send.

**Cross-client sync:** The server SSE stream relays the `prompt_suggestion` event to all connected clients. Each client renders independently. No shared server-side suggestion state needed.

---

#### Approach B: Floating Bar Above Input

A fixed-position (or sticky) element sits above the chat input, always visible regardless of scroll.

**Pros:**
- Always reachable without scrolling

**Cons:**
- Visually heavy — occupies permanent screen real estate
- Creates layout shift between states (visible vs. hidden)
- Accessibility challenges: floating elements break natural tab order
- Overlaps the keyboard on mobile (not the target platform, but worth noting)
- Developer persona (`Kai`) will find persistent floating bars distracting when they don't need them
- More complex z-index/stacking context management

**Complexity:** High. Layout changes needed in the chat shell. Requires careful z-index layering against dropdowns, popovers, and the command palette.

---

#### Approach C: Ghost Text / Chips Inside the Input

Suggestions appear as ghost/placeholder text or as tab-completable chips inside the textarea.

**Pros:**
- No additional layout real estate

**Cons:**
- Ghost text conflicts with actual cursor position and typed text
- Multiple suggestions require a scrollable list inside the input — unusual and confusing
- The SDK emits 1-3 separate `prompt_suggestion` events (one per suggestion), so multiple chips do not map to a single "ghost" input string
- Destroys the simplicity of the chat input — the input area already handles streaming, approvals, and question prompts
- Observed to cause user confusion (users unsure if the text is their own or suggested)

**Complexity:** Very high. Requires custom textarea behavior, careful caret management, and focus state handling.

---

#### Approach D: Hybrid — Inline with Auto-Scroll Anchor

Same as Approach A but with an explicit scroll-to behavior when suggestions appear.

**Pros:**
- Guarantees visibility without floating overlay

**Cons:**
- Auto-scrolling on every suggestion appearance is jarring if the user has scrolled up to reference earlier output
- DorkOS already auto-scrolls on `done` event when at the bottom — combining these carefully avoids double-scroll

**Complexity:** Low-Medium. Essentially Approach A plus an `IntersectionObserver` guard that only scrolls if the user is already near the bottom (same pattern used by the existing `useScrollToBottom` behavior).

**Verdict:** Approach D is the pragmatic refinement of Approach A. Use the existing scroll anchor behavior rather than adding a new scroll trigger.

---

### Persistence Decision

**Recommended: Ephemeral, cleared on any user submission.**

| Option | Verdict |
|--------|---------|
| One-shot (disappear on click) | Acceptable but suboptimal — user may want to click a different chip |
| Clear on any send (own text OR chip) | Best. Suggestions are tied to one agent turn. |
| Persist until manual dismiss | Unnecessary friction, stale suggestions become noise |
| Fade after timeout | Bad for keyboard-only users; creates race conditions |
| Persist in message history | Wrong. Suggestions are UI affordances, not conversation content. They would be confusing in replayed sessions. |

Implementation: Store `string[]` in the chat feature model as `promptSuggestions`. Set on `prompt_suggestion` event (accumulate). Clear on `done` event when the next message starts streaming (i.e., on `setStatus('streaming')`). Or simpler: clear when the user submits any message, including when a chip is clicked.

---

### Input Interaction Decision

**Recommended: Populate the input with the suggestion text, without auto-submitting.**

Rationale:
- Developer users (`Kai`, `Priya`) want to review and optionally modify before running
- NN/G research confirms this is the preferred pattern for AI tool suggestions
- Auto-submit is appropriate only for simple acknowledgment responses — agent task suggestions like "Run the tests" may need contextual amendments ("Run the tests for the auth module")
- If the user wants immediate execution, they can press Enter immediately after the chip populates the input

**When input already has content:**
- **Hide chips entirely** (not disable). The UX pattern from Smashing Magazine: hide = irrelevant, disable = blocked. Chips are irrelevant when the user is actively composing.
- Use `inputValue.length > 0` as the condition to render `null` for the chips container.
- This also solves the "replace vs. append" debate by eliminating the scenario.

---

### Accessibility

- Each chip is a `<button>` element (not `<div>` with `onClick`) — native keyboard focusability and activation via Enter/Space
- Chips must have `aria-label` derived from the suggestion text when truncated
- The chips container should have `role="group"` with `aria-label="Suggested follow-ups"` or similar
- Natural tab order: after the assistant message, before the chat input
- Focus should NOT be auto-moved to chips on appearance — let the user navigate naturally
- `AnimatePresence` exit animations must not block interaction during exit (they don't — Motion removes from DOM after exit completes)
- Visible focus ring required (DorkOS uses `focus-visible:ring-2` via Tailwind — ensure chips inherit this)

---

### Performance

- The SDK emits `prompt_suggestion` as a sparse event (once per turn, not streaming). No debounce or batching needed.
- Chips are plain text buttons with no markdown rendering — negligible DOM cost
- `AnimatePresence` with 2-3 items adds no meaningful performance overhead
- Store suggestions as `string[]` in existing React state (no Zustand store needed — this is ephemeral UI state local to a session). `useState` in the `useChatSession` hook or in a dedicated `usePromptSuggestions` sub-hook is sufficient.

---

### Cross-Client Sync

The `session_id` on the `SDKPromptSuggestionMessage` ties it to a specific session. The DorkOS SSE stream already carries all SDK events per session. The server needs to forward the `prompt_suggestion` event through the existing `/api/sessions/:id/stream` SSE pipeline.

Both the main client and the Obsidian plugin will receive the event independently and render their own local suggestion UI. Since suggestions clear on any message send, and message sends are already synchronized via the session stream, the suggestion state stays naturally consistent.

No changes to the session JSONL storage are needed — suggestions are not persisted.

---

### Security

The `suggestion` string originates from the Claude SDK's model inference. It is plain text — no HTML, no markdown that requires rendering. Always render using React JSX string interpolation (e.g., `{suggestion}` inside a `<button>`), which provides automatic XSS escaping. Never use `dangerouslySetInnerHTML` for suggestion text.

If suggestion text is ever passed to a `sendMessage` call, it flows through the existing message send pipeline as user text — no special sanitization layer needed beyond what already exists for all user input.

---

### Implementation Sketch

**Server change** (`apps/server/src/`): Forward `prompt_suggestion` from the SDK stream to the SSE event stream. Add it to the shared types as a new event type.

**Shared types** (`packages/shared/src/types.ts`): Add `PromptSuggestionEvent` alongside existing event types.

**Stream event handler** (`stream-event-handler.ts`): Add `case 'prompt_suggestion'` to the switch statement. Call a `setPromptSuggestions` setter (or accumulate into an array via a callback).

**Chat session hook** (`useChatSession` or a new `usePromptSuggestions`): Maintain `promptSuggestions: string[]` state. Clear on submit. Inject `setPromptSuggestions` into the `StreamEventDeps` interface (or handle via the existing `onStreamingDone` / `done` lifecycle).

**Component** (`PromptSuggestionChips.tsx` in `features/chat/ui/`): Renders when `promptSuggestions.length > 0 && inputValue.length === 0 && status === 'idle'`. Uses `AnimatePresence` + `motion.button` with `layout` prop.

```tsx
// Conceptual structure only — not production code
<AnimatePresence>
  {showChips && promptSuggestions.map((suggestion) => (
    <motion.button
      key={suggestion}
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15 }}
      onClick={() => onSuggestionClick(suggestion)}
      className="..."
    >
      {suggestion}
    </motion.button>
  ))}
</AnimatePresence>
```

**Placement** in `ChatPanel.tsx`: Render `<PromptSuggestionChips>` between the messages list and the input area (or as the last item inside the scroll container, anchored below the last message).

---

## Sources & Evidence

- SDK type definition `SDKPromptSuggestionMessage` — [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- "Follow-up questions are usually displayed below the answer to the user's previous prompt" — [Prompt Suggestions, NN/G](https://www.nngroup.com/articles/prompt-suggestions/)
- "Positioned near the text input field — the primary focus of user attention" — [Designing Use-Case Prompt Suggestions, NN/G](https://www.nngroup.com/articles/designing-use-case-prompt-suggestions/)
- "Trigger the prompt directly or insert a longer prompt into the input field for users to edit before submitting" — [Designing Use-Case Prompt Suggestions, NN/G](https://www.nngroup.com/articles/designing-use-case-prompt-suggestions/)
- "Hide if the value shown is currently irrelevant and can't be used" — [Hidden vs. Disabled In UX, Smashing Magazine](https://www.smashingmagazine.com/2024/05/hidden-vs-disabled-ux/)
- Chip types: "Suggestion chips represent dynamic suggestions for user input" — [Material Design 3 Chips](https://m3.material.io/components/chips/guidelines)
- "Users often ignore them, especially when they're not in the right place or don't feel useful" — [Prompt Suggestions, NN/G](https://www.nngroup.com/articles/prompt-suggestions/)
- Motion AnimatePresence exit animation pattern — [AnimatePresence docs, motion.dev](https://motion.dev/docs/react-animate-presence)
- XSS via `dangerouslySetInnerHTML` and DOMPurify guidance — [Preventing XSS in React, PragmaticWebSecurity](https://pragmaticwebsecurity.com/articles/spasecurity/react-xss-part2.html)
- "Suggestion chips help to nudge important user actions in a convenient way" — [Chip UI Design, Mobbin](https://mobbin.com/glossary/chip)
- Keyboard accessibility requirements — [Keyboard Accessible, MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/Guides/Understanding_WCAG/Keyboard)
- Follow-up suggestion placement in Perplexity AI — [Perplexity AI Review 2025, Collabnix](https://collabnix.com/perplexity-ai-review-2025-the-complete-guide-to-pros-cons-and-user-experience/)
- Shape of AI — 50+ AI UX patterns catalog — [The Shape of AI](https://www.shapeof.ai/)
- AI Chat UI suggestion chip patterns 2025 — [UX Tigers: Prompt Augmentation](https://www.uxtigers.com/post/prompt-augmentation)

---

## Research Gaps & Limitations

- No direct access to GitHub Copilot Chat's post-response suggestion UI (their docs focus on inline code completion, not follow-up chips)
- The exact number of `prompt_suggestion` events emitted per turn by the Claude SDK is not documented — empirical testing needed to determine if 1, 2, or 3 events fire per turn and whether they should be accumulated into a fixed-size array or rendered as-they-arrive
- No data on how often developer users actually click suggestion chips vs. type their own follow-up — consider adding telemetry later

---

## Contradictions & Disputes

- **Auto-submit vs. populate**: Some sources (like Google Chat suggestion chips) use auto-submit for simple confirmations ("Yes", "No", "Sounds good"). For DorkOS, agent task suggestions like "Run the tests" or "Commit this work" are not simple confirmations — the user may want to append context. Populate-only wins here. The auto-submit interpretation is valid in a different product context.
- **Inline vs. floating**: The Perplexity model (inline below the answer) is clearly dominant in developer tools. Floating bars exist in some consumer apps (Google Assistant-style) but are not appropriate for the DorkOS control panel aesthetic.

---

## Search Methodology

- Searches performed: 10
- Most productive terms: `"NNgroup prompt suggestions placement"`, `Claude SDK prompt_suggestion typescript`, `"suggestion chips" inline floating accessibility WCAG`, `framer motion AnimatePresence exit`, `chat suggestion chips replace OR append input UX`, `hidden vs disabled UX pattern`
- Primary sources: Nielsen Norman Group, Anthropic SDK docs (official), Material Design 3, motion.dev, Smashing Magazine, Shape of AI

---

## Recommendation

**Recommended Approach: Approach A (inline chips below last assistant message), with Approach D refinements.**

**Rationale:**
1. Matches industry consensus for post-response follow-up suggestions
2. Contextually associated with the message that generated them
3. Natural keyboard navigation without floating layer complexity
4. Consistent with DorkOS's control-panel aesthetic — no floating overlays that compete with the command palette or other UI layers
5. Clean cross-client sync: relay the event via SSE, each client renders independently, both clients clear on the same send event
6. Accessibility: native `<button>` elements in document flow, `role="group"` container, visible focus rings
7. Animation: leverage existing `motion`/`AnimatePresence` patterns already established in the codebase
8. No persistence in message history — suggestions are UI affordances, not conversation content

**Persistence:** Clear on any user message send. Do not persist in JSONL / history replay.

**Input interaction:** Populate input field, no auto-submit. Hide chips entirely when `inputValue.length > 0`.

**Cross-client sync:** Forward `prompt_suggestion` via existing SSE pipeline. Both clients render locally. No server-side suggestion store needed.

**Security:** Render suggestion text as plain text nodes via JSX. No `dangerouslySetInnerHTML`.

**Caveats:**
- Requires server-side forwarding of the `prompt_suggestion` SDK event type through the SSE pipeline — this is the only backend change
- The `StreamEventDeps` interface in `stream-event-handler.ts` will need a `setPromptSuggestions` setter added — follow the same pattern as `setSystemStatus`
- Empirically verify how many `prompt_suggestion` events fire per agent turn before finalizing the accumulation strategy (cap at 3-4 to prevent UI overflow)
- The `promptSuggestions: true` option must be set in the `query()` call — verify this is plumbed through the runtime layer in `services/runtimes/claude-code/`
