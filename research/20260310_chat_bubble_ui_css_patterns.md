---
title: 'Chat Bubble UI CSS Patterns — ChatGPT, Claude.ai, iMessage, Slack, Discord'
date: 2026-03-10
type: external-best-practices
status: active
tags:
  [
    chat-ui,
    message-bubble,
    css,
    flexbox,
    border-radius,
    tailwind,
    imessage,
    chatgpt,
    claude-ai,
    slack,
    discord,
  ]
searches_performed: 14
sources_count: 22
---

# Chat Bubble UI CSS Patterns

## Research Summary

This report documents the concrete CSS/layout patterns used by ChatGPT, Claude.ai, iMessage, Slack, and Discord for message bubble styling — covering alignment strategy, border-radius values, max-width, padding, color, and grouped-message radius reduction. It also synthesizes general best practices for chat bubble UI that are implementable directly in Tailwind CSS v4 / React.

The key finding: **the industry has bifurcated into two clear patterns**. Consumer messaging apps (iMessage, WhatsApp, Facebook Messenger, Discord-with-bubbles) use colored bubbles for both sides with positional radius variation. AI chat apps (ChatGPT, Claude.ai) use a **hybrid model**: user messages are right-aligned bubbles with a background, assistant messages are full-width with no bubble background at all.

---

## Key Findings

### 1. ChatGPT — Hybrid Bubble Pattern

ChatGPT uses a deliberately asymmetric layout:

- **User messages**: Right-aligned pill-shaped bubble. Background is a muted surface color (light mode: light gray; dark mode: roughly `bg-white/5` — 5% white overlay on dark). Rounded with `rounded-3xl` (Tailwind) = `24px` border-radius, making them strongly pill-shaped. Max-width constrained to approximately 70–75% of the conversation column. Right-aligned via `ml-auto` on a flex-column container (NOT via `justify-end` on the row — see alignment section below).

- **Assistant messages**: Full-width, no bubble background, no border. Left-aligned with avatar. The container max-width is `max-w-screen-md` (768px) or `max-w-2xl` (672px) depending on viewport — this is the **conversation column width**, not individual message width.

- **No tail**: Neither side uses a speech bubble tail / pointer.

- **Padding**: User bubble uses approximately `px-4 py-3` (16px horizontal, 12px vertical).

- **Typography**: Assistant uses `font-light` or `font-normal`; user bubble uses regular weight.

**CSS summary for ChatGPT-style user message:**

```css
/* Outer row */
display: flex;
flex-direction: column;
align-items: flex-end; /* or: use ml-auto on the bubble itself */

/* User bubble */
max-width: 70%;
padding: 12px 16px;
border-radius: 24px; /* rounded-3xl */
background: hsl(0 0% 91%); /* light mode */
background: rgba(255, 255, 255, 0.05); /* dark mode */
```

**Tailwind equivalent:**

```html
<!-- User message row -->
<div class="flex justify-end">
  <div class="bg-muted max-w-[70%] rounded-3xl px-4 py-3 text-sm">Message text here</div>
</div>

<!-- Assistant message row (full width) -->
<div class="flex gap-3">
  <div class="mt-0.5 size-6 flex-shrink-0"><!-- avatar --></div>
  <div class="min-w-0 flex-1 text-sm">Assistant response here</div>
</div>
```

---

### 2. Claude.ai — Warm Minimal Hybrid

Claude.ai follows the same hybrid pattern as ChatGPT but with distinct visual identity:

- **User messages**: Right-aligned bubble. Background uses a warm cream/beige tone (`oklch(0.97 0.02 70)` light mode, `#393937` dark mode). The assistant-ui Claude clone documents the user bubble color as `#DDD9CE` (light) / `#393937` (dark). Rounded with a large radius — approximately `rounded-2xl` to `rounded-3xl` (16–24px).

- **Assistant messages**: Full-width, no bubble. Uses warm off-white background for the conversation area. Claude's brand colors are warm terracotta orange (`oklch(0.70 0.14 45)`) for accents; messages themselves are black text on cream.

- **No tail**: No speech bubble pointers.

- **Typography**: Claude uses serif typography (`font-serif`) for a refined, humanistic feel — distinct from ChatGPT's sans-serif. Line-height is generous (~1.75) optimized for reading long markdown.

- **Alignment**: Same `ml-auto` / `flex-end` pattern as ChatGPT.

**Tailwind equivalent (Claude-style):**

```html
<!-- User message -->
<div class="flex justify-end px-4">
  <div class="max-w-[75%] rounded-2xl bg-[#DDD9CE] px-4 py-3 text-sm dark:bg-[#393937]">
    Message text
  </div>
</div>

<!-- Assistant message -->
<div class="flex gap-3 px-4">
  <div class="mt-1 size-7 flex-shrink-0 rounded-full"><!-- Claude avatar --></div>
  <div class="prose prose-sm min-w-0 flex-1 font-serif">Assistant response markdown</div>
</div>
```

---

### 3. Apple iMessage — The Classic Bubble Reference

iMessage is the canonical reference for colored-bubble chat UI. It uses bubbles for **both sides**, differentiated by color and alignment:

**Sent messages (right side):**

- `align-self: flex-end` in a `display: flex; flex-direction: column` container
- Background: `#0b93f6` (blue, iOS default) or `#34C759` (green for SMS)
- Text: white
- `border-radius: 25px` base, with speech bubble tail via pseudo-elements

**Received messages (left side):**

- `align-self: flex-start`
- Background: `#e5e5ea` (light gray)
- Text: black

**Exact CSS values from iOS implementation:**

```css
/* Shared bubble */
max-width: 255px;
padding: 10px 20px;
border-radius: 25px;
line-height: 24px;

/* Sent */
align-self: flex-end;

/* Received */
align-self: flex-start;

/* Container */
display: flex;
flex-direction: column;
max-width: 450px;
```

**Grouped messages (tail removal):** Consecutive messages from the same sender use the `.noTail` class which sets `opacity: 0` on the `::before` / `::after` pseudo-elements (the tail). The bubble shape itself stays fully rounded — iMessage does NOT change border-radius for grouped messages; it only hides/shows the tail. Vertical margin is reduced from `15px` to `2px` for grouped messages.

**Dark mode colors:**

- Background: `#161515`
- Sent bubble remains blue `#0b93f6`

---

### 4. Slack — No Bubbles, Thread-Based Grouping

Slack does **not** use chat bubbles. It uses a flat, email-thread-inspired layout:

- **No bubble backgrounds**: Messages have no background color. The full message row gets a subtle hover background (`rgba(var(--sk_primary_foreground), 0.04)` or similar).
- **Left-aligned only**: All messages are left-aligned. No right-alignment for "your" messages.
- **Avatar grouping**: The first message in a group shows the avatar and username. Subsequent messages within ~5 minutes from the same user hide the avatar, showing only a compact timestamp on hover.
- **Message width**: Full available width minus left padding for avatar column (~68px).
- **Vertical spacing**: Grouped messages have ~2px gap between them. New groups get ~16px gap + avatar + username header.
- **Compact mode**: Removes avatars entirely; shows inline `HH:mm` timestamps; all messages are vertically compact at ~20px line-height.

**CSS pattern for Slack-style grouping:**

```css
/* Message row */
.message-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 2px 16px 2px 72px; /* 72px left gutter for avatar */
}

/* Group start — shows avatar */
.message-row.group-start {
  padding-top: 8px;
}

/* Group middle/end — avatar hidden, timestamp on hover only */
.message-row.group-middle .avatar {
  visibility: hidden;
}
```

---

### 5. Discord — Cozy Mode (Grouped) + Compact Mode

Discord has two distinct display modes:

**Cozy Mode (default):**

- No bubble backgrounds by default — same flat layout as Slack
- Avatar shown for first message in group; subsequent messages have `padding-left: 68px` (matching the avatar width) and no avatar
- Hover reveals a timestamp inline
- No border-radius; no bubble

**BetterDiscord "Chat Bubbles" CSS** (community mod, shows what Discord could look like with bubbles):

```css
/* Variables */
--bubble-radius-full: 0.8rem; /* 12.8px */
--bubble-radius-tight: 0rem; /* sharp corner on grouped side */

/* First message in group */
border-radius: 0.8rem 0.8rem 0.8rem 0rem;

/* Middle messages */
border-radius: 0rem 0.8rem 0.8rem 0rem;

/* Last message in group */
border-radius: 0rem 0.8rem 0.8rem 0.8rem;

/* Padding */
padding: 0.3rem 0.4rem; /* very compact: ~5px vertical, 6px horizontal */

/* Max-width */
max-width: 62ch; /* character-based, excellent for readability */
```

This uses CSS `:has()` selector (Chrome 105+, now universally supported) to detect consecutive messages:

```css
/* Message is followed by another from same author */
.message-group:has(+ .message-group[data-author='same']) .bubble {
  border-end-start-radius: var(--bubble-radius-tight);
}
```

**Compact Mode:**

- Fully flat, no avatars, all messages in one column
- Timestamp shown at start of each message inline
- Maximum information density

---

## Detailed Analysis

### Alignment: `justify-end` vs `ml-auto`

This is a subtle but important CSS decision. Both approaches achieve right-alignment but have different semantics and different effects in a flex column:

**`justify-end` on the row container:**

```css
/* Row is flex-row, justify-end pushes bubble right */
.message-row {
  display: flex;
  justify-content: flex-end;
}
.bubble {
  /* no special alignment needed */
}
```

- Use when: The entire row is dedicated to this message (no avatar on the right side for user messages)
- Effect: The bubble fills from right; any child elements also push right

**`ml-auto` on the bubble itself:**

```css
/* Container is flex-column (all messages stacked) */
.message-list {
  display: flex;
  flex-direction: column;
}
.bubble.user {
  margin-left: auto;
}
```

- Use when: Messages are stacked in a single flex column (the most common pattern)
- Effect: The bubble is pushed to the right edge; works regardless of sibling alignment
- **This is the correct approach for chat UIs** where messages from different roles alternate in the same column

**`align-self: flex-end` (equivalent in flex column):**

```css
.message-list {
  display: flex;
  flex-direction: column;
}
.bubble.user {
  align-self: flex-end;
}
```

- Equivalent to `ml-auto` in a flex column
- Slightly more explicit about intent

**Industry consensus:** ChatGPT, iMessage implementations, and community Tailwind patterns all converge on `ml-auto` or `align-self: flex-end` for individual bubble alignment within a flex column. Avoid `justify-end` on the row if the row also contains an avatar or any other element that should stay left.

**Tailwind implementation:**

```html
<!-- Flex column container for all messages -->
<div class="flex flex-col gap-1">
  <!-- User message: pushed right via ml-auto -->
  <div class="bg-muted ml-auto max-w-[75%] rounded-3xl px-4 py-3">User text</div>
  <!-- Assistant message: natural left flow -->
  <div class="flex gap-3">
    <div><!-- avatar --></div>
    <div>Assistant text</div>
  </div>
</div>
```

---

### Max-Width Best Practices

| App / Context               | Max-Width Value             | Notes                                 |
| --------------------------- | --------------------------- | ------------------------------------- |
| iMessage                    | `255px` fixed               | Mobile-native; feels tight on desktop |
| Facebook Messenger          | `calc(100% - 67px)`         | Accounts for action menu              |
| ChatGPT user bubble         | ~70% of conversation column | Column itself is `max-w-2xl` (672px)  |
| Claude.ai user bubble       | ~75% of conversation column | Slightly wider                        |
| Discord bubbles (community) | `62ch`                      | Character-based — best for text       |
| Flowbite component          | `max-w-[320px]`             | Fixed px                              |
| General best practice       | `clamp(200px, 75%, 480px)`  | Fluid, responsive                     |

**Recommendation for AI chat UIs:**

- User bubble: `max-w-[75%]` or `max-w-prose` (65ch)
- The conversation column itself should have `max-w-2xl` to `max-w-3xl` (672px–768px)
- On mobile, relax to `max-w-[85%]`
- Character-based (`ch` units) max-widths are semantically ideal for text content: `max-width: 60ch` keeps lines within the optimal reading range (45–75 chars per line)

---

### Border-Radius Values by Platform and Position

**Standard (no grouping):**

| App                         | Border-Radius                                              |
| --------------------------- | ---------------------------------------------------------- |
| iMessage                    | `25px` (approximately `rounded-3xl` in Tailwind)           |
| ChatGPT user bubble         | `24px` (`rounded-3xl`)                                     |
| Claude.ai user bubble       | ~`18px`–`20px` (`rounded-2xl`)                             |
| Facebook Messenger          | `18px` base                                                |
| Discord (community bubbles) | `12.8px` (0.8rem)                                          |
| Flowbite component          | uses logical properties (`rounded-e-base rounded-es-base`) |

**Grouped message radius reduction (the "stacking" pattern):**

The standard pattern is: **full radius on the side away from the group, reduced (2–4px) radius on the side adjacent to the next/previous message from the same sender.**

For **right-aligned user bubbles**, the grouped side is the bottom-right:

```css
/* Only message OR single message in group */
.bubble {
  border-radius: 18px;
}

/* First message of group (more coming below from same sender) */
.bubble.group-first {
  border-radius: 18px 18px 4px 18px;
  /* top-left top-right bottom-right bottom-left */
  /* The bottom-right gets tight because next message continues */
}

/* Middle message of group */
.bubble.group-middle {
  border-radius: 18px 4px 4px 18px;
  /* top-right and bottom-right are tight (continuation above and below) */
}

/* Last message of group */
.bubble.group-last {
  border-radius: 18px 4px 18px 18px;
  /* top-right tight (continuation above), full elsewhere */
}
```

For **left-aligned received/assistant bubbles** (mirror):

```css
.bubble.group-first {
  border-radius: 18px 18px 18px 4px;
} /* bottom-left tight */
.bubble.group-middle {
  border-radius: 4px 18px 18px 4px;
} /* both left corners tight */
.bubble.group-last {
  border-radius: 4px 18px 18px 18px;
} /* top-left tight */
```

**Using CSS logical properties** (RTL-safe, modern approach):

```css
/* User bubble (inline-end = right in LTR) */
.bubble.user {
  border-radius: 1.25rem;
}

.bubble.user.group-first {
  border-end-end-radius: 0.25rem;
}
.bubble.user.group-middle {
  border-start-end-radius: 0.25rem;
  border-end-end-radius: 0.25rem;
}
.bubble.user.group-last {
  border-start-end-radius: 0.25rem;
}
```

**Tailwind v4 with arbitrary values:**

```html
<!-- first in group (user, right-aligned) -->
<div class="rounded-3xl rounded-br-[4px] ...">
  <!-- middle in group -->
  <div class="rounded-3xl rounded-tr-[4px] rounded-br-[4px] ...">
    <!-- last in group -->
    <div class="rounded-3xl rounded-tr-[4px] ..."></div>
  </div>
</div>
```

**Tight radius value:** Industry converges on `2px`–`6px` for the "grouped side" corner. Facebook Messenger uses `4px`. Discord uses `0rem` (fully sharp). iMessage doesn't change the radius at all (just hides the tail). **Recommendation: `4px` (`rounded-[4px]`) — sharp enough to signal grouping without looking broken.**

---

### Padding Values by Pattern

| Pattern             | Padding          | Tailwind                           |
| ------------------- | ---------------- | ---------------------------------- |
| iMessage            | `10px 20px`      | `py-2.5 px-5`                      |
| ChatGPT estimated   | `12px 16px`      | `py-3 px-4`                        |
| Facebook Messenger  | `8px 12px 9px`   | `px-3 pt-2 pb-[9px]`               |
| Discord (community) | `5px 6px`        | `py-[5px] px-[6px]` (very compact) |
| Flowbite            | `16px` all sides | `p-4`                              |
| General recommended | `10px 14px`      | `py-2.5 px-3.5`                    |

**Observation:** iMessage-like apps use generous horizontal padding (20px) to make short messages feel substantial. AI chat apps use more moderate padding since bubbles are only on the user side and messages tend to be longer.

---

### Colors

**The invariant:** user/sent messages use an accent color; assistant/received messages use either no background (AI chat pattern) or a neutral gray.

**ChatGPT:**

- User bubble light mode: `rgba(0,0,0,0.05)` to `#e5e5e5` range (muted surface)
- User bubble dark mode: `rgba(255,255,255,0.05)` (very subtle white overlay)
- Note: OpenAI uses `bg-token-*` custom properties internally, not raw hex values

**Claude.ai (assistant-ui documented colors):**

- User bubble light: `#DDD9CE` (warm cream)
- User bubble dark: `#393937` (warm dark gray)
- No bubble for assistant messages

**iMessage:**

- Sent: `#0b93f6` (blue) with white text
- Received: `#e5e5ea` (gray) with dark text

**Facebook Messenger:**

- Sent: brand blue (`#0084ff`) historically, now gradient
- Received: `#f0f0f0` or dark surface

**Discord (default, no bubbles):**

- Hover: `rgba(4, 4, 5, 0.07)` on dark theme
- No background at rest

**AI chat UI recommendation (for DorkOS):**

```css
/* Light mode */
--user-bubble: hsl(0 0% 91%); /* existing --user-msg token */
/* Dark mode */
--user-bubble-dark: hsl(0 0% 18%);
/* No background for assistant — transparent/inherit */
```

---

### Vertical Spacing Between Grouped Messages

| App                 | Same-sender gap                   | New-sender gap            |
| ------------------- | --------------------------------- | ------------------------- |
| iMessage            | `2px` (`margin-bottom: 2px`)      | `15px`                    |
| Discord cozy        | ~`2px`                            | `~16px` + username header |
| Slack               | `2px`                             | `~12px` + avatar + name   |
| Facebook Messenger  | `2px` (`gap: 2px` in flex column) | `8px`                     |
| ChatGPT (estimated) | `4px`–`8px`                       | `16px`                    |

**Tailwind pattern:**

```html
<div class="flex flex-col">
  <!-- group start -->
  <div class="mt-4 ...">First message in group</div>
  <!-- grouped follow-ups -->
  <div class="mt-0.5 ...">Second in group</div>
  <div class="mt-0.5 pb-3 ...">Last in group</div>
</div>
```

---

### Complete Implementable Tailwind Pattern

This is the synthesis of all research into a clean, implementable Tailwind v4 pattern for an AI chat UI (ChatGPT/Claude style):

```tsx
// MessageBubble.tsx — AI chat hybrid pattern
// User = right-aligned bubble, Assistant = full-width no bubble

type MessagePosition = 'only' | 'first' | 'middle' | 'last';
type MessageRole = 'user' | 'assistant';

function getBubbleClasses(role: MessageRole, position: MessagePosition): string {
  if (role === 'assistant') return ''; // No bubble for assistant

  const base = 'ml-auto max-w-[75%] px-4 py-3 text-sm bg-user-msg dark:bg-user-msg';

  // Border-radius per position (tight corner on bottom-right for user bubbles)
  const radius: Record<MessagePosition, string> = {
    only: 'rounded-3xl',
    first: 'rounded-3xl rounded-br-[4px]',
    middle: 'rounded-3xl rounded-tr-[4px] rounded-br-[4px]',
    last: 'rounded-3xl rounded-tr-[4px]',
  };

  return `${base} ${radius[position]}`;
}

function getRowSpacing(position: MessagePosition, role: MessageRole): string {
  // Group start gets breathing room; grouped messages stack tight
  const isGroupStart = position === 'only' || position === 'first';
  return isGroupStart ? 'mt-4 pb-0.5' : 'mt-0.5 pb-0.5';
}
```

```html
<!-- User message -->
<div class="mt-4 flex">
  <div class="bg-user-msg ml-auto max-w-[75%] rounded-3xl px-4 py-3 text-sm">User message text</div>
</div>

<!-- User message grouped (follows another user message within ~2min) -->
<div class="mt-0.5 flex">
  <div class="bg-user-msg ml-auto max-w-[75%] rounded-3xl rounded-tr-[4px] px-4 py-3 text-sm">
    Follow-up from same user
  </div>
</div>

<!-- Assistant message (no bubble) -->
<div class="mt-4 flex items-start gap-3 px-4">
  <div class="mt-[3px] w-4 flex-shrink-0">
    <!-- role indicator icon -->
  </div>
  <div class="min-w-0 flex-1 text-sm leading-relaxed font-light">
    Assistant response with markdown
  </div>
</div>
```

---

### Grouping Logic: Detecting Position

For time-based grouping (same pattern used by Slack, Discord, iMessage):

```typescript
// Group messages from the same role sent within 2 minutes of each other
function getMessagePosition(
  messages: Message[],
  index: number,
  groupWindowMs = 2 * 60 * 1000
): MessagePosition {
  const msg = messages[index];
  const prev = messages[index - 1];
  const next = messages[index + 1];

  const sameRoleAsPrev = prev?.role === msg.role && msg.timestamp - prev.timestamp < groupWindowMs;
  const sameRoleAsNext = next?.role === msg.role && next.timestamp - msg.timestamp < groupWindowMs;

  if (sameRoleAsPrev && sameRoleAsNext) return 'middle';
  if (sameRoleAsPrev) return 'last';
  if (sameRoleAsNext) return 'first';
  return 'only';
}
```

---

## Summary Comparison Table

| Dimension                   | ChatGPT                                       | Claude.ai                          | iMessage                | Slack/Discord              |
| --------------------------- | --------------------------------------------- | ---------------------------------- | ----------------------- | -------------------------- |
| **User alignment**          | Right bubble                                  | Right bubble                       | Right bubble            | N/A (no "you" distinction) |
| **Assistant alignment**     | Full-width, no bubble                         | Full-width, no bubble              | Left bubble             | Left, no bubble            |
| **User border-radius**      | `~24px` (`rounded-3xl`)                       | `~18–20px` (`rounded-2xl`)         | `25px`                  | N/A                        |
| **Received border-radius**  | None (no bubble)                              | None (no bubble)                   | `25px`                  | N/A                        |
| **User bg**                 | Muted gray (~`#e5e5e5` light, `white/5` dark) | Warm cream (`#DDD9CE` / `#393937`) | Blue (`#0b93f6`)        | N/A                        |
| **Max-width (user bubble)** | ~70% of column                                | ~75% of column                     | `255px` fixed           | Full width                 |
| **Grouped radius**          | Likely reduced (unconfirmed)                  | Likely reduced (unconfirmed)       | No change (tail hidden) | `0–4px` on grouped side    |
| **Grouped spacing**         | ~`4px` gap                                    | ~`4px` gap                         | `2px` gap               | `2px` gap                  |
| **Tail/pointer**            | None                                          | None                               | Yes (pseudo-element)    | None                       |
| **Avatar position**         | Left of assistant                             | Left of assistant                  | None (name only)        | Left of first in group     |

---

## Research Gaps & Limitations

- ChatGPT and Claude.ai source CSS is not publicly inspectable (minified, token-based class names change on deployments). The values above are reverse-engineered from community customization scripts, official UI clones (assistant-ui), and visual inspection. They may drift with product updates.
- The exact border-radius ChatGPT applies to grouped user messages (multiple consecutive user messages) could not be confirmed — the `rounded-3xl` base is confirmed but position-based reduction is inferred.
- Discord's native (non-BetterDiscord) bubble styling is not documented because Discord does not ship bubbles natively — only the community CSS mod ships them.
- Slack's exact CSS class names are internal and change with design system updates; the patterns documented here are structural.

---

## Contradictions & Disputes

- **`ml-auto` vs `justify-end`**: Both work. `ml-auto` is more appropriate when messages of different roles are in the same flex-column container. `justify-end` on individual message rows is equally valid when each row is its own flex container. The MDN documentation and Smashing Magazine confirm `ml-auto` as the semantically correct "push this one item to the end" approach in flex.
- **iMessage radius grouping**: Samuel Kraft's CSS implementation (the most-cited reference) hides the bubble tail via `opacity: 0` rather than changing border-radius for grouped messages. This differs from the Facebook Messenger / Discord approach which reduces corner radius. Both are valid; the tail-hiding approach is simpler and more faithful to the actual iOS implementation.
- **AI chat bubble style (full bubble vs hybrid)**: Some AI chat clones use colored bubbles for both sides. ChatGPT and Claude.ai specifically chose the hybrid (user bubble only) approach, which visually emphasizes that the assistant content is primary (it takes up full width) while the user input is secondary/contained.

---

## Sources & Evidence

- iMessage CSS exact values (border-radius 25px, padding 10px 20px, colors, tail pseudo-elements, grouped `.noTail` pattern) — [How to create iOS chat bubbles in CSS | Samuel Kraft](https://samuelkraft.com/blog/ios-chat-bubbles-css)
- Facebook Messenger grouped bubble radius (18px base, 4px grouped side, logical properties `border-end-end-radius`) — [Building Real-life Components: Facebook Messenger's Chat Bubble | Ahmad Shadeed](https://ishadeed.com/article/facebook-messenger-chat-component/)
- Discord community bubble CSS (0.8rem full radius, 0rem tight, `:has()` selector for grouping, 62ch max-width, 0.3rem/0.4rem padding) — [Fancy message bubbles for Discord in pure CSS](https://gist.github.com/hazycora/01586ece7792ba520c9495bb559bc4d5)
- ChatGPT layout container classes (`max-w-2xl`, `max-w-[38rem]`, `max-w-3xl`) — [ChatGPT web-interface width fix | GitHub Gist](https://gist.github.com/alexchexes/d2ff0b9137aa3ac9de8b0448138125ce)
- ChatGPT user bubble dark mode color (`bg-white/5`), assistant full-width pattern — [ChatGPT Clone | assistant-ui](https://www.assistant-ui.com/examples/chatgpt)
- Claude.ai user bubble colors (`#DDD9CE` light / `#393937` dark), warm color palette — [Claude Clone | assistant-ui](https://www.assistant-ui.com/examples/claude)
- `ml-auto` vs `justify-end` — auto margins as the correct flex item individual alignment approach — [Flexbox's Best-Kept Secret | HackerNoon](https://medium.com/hackernoon/flexbox-s-best-kept-secret-bd3d892826b6)
- Max-width best practice `clamp(200px, 80%, 400px)` for responsive bubbles — [Gradio Issue #4420](https://github.com/gradio-app/gradio/issues/4420)
- Facebook Messenger bubble padding `8px 12px 9px` — [Facebook Messenger Chat Bubble | Ahmad Shadeed](https://ishadeed.com/article/facebook-messenger-chat-component/)
- Flowbite chat bubble Tailwind classes (`max-w-[320px]`, `p-4`, `flex items-start gap-2.5`) — [Tailwind CSS Chat Bubble | Flowbite](https://flowbite.com/docs/components/chat-bubble/)
- CSS logical properties for bubble radius (supported Chrome 89+) — [Css: Creating Facebook Messenger Style Chat Bubbles](https://copyprogramming.com/howto/how-to-create-chat-bubbles-like-facebook-messenger)
- Discord compact mode timestamp vs cozy grouping behavior — [Discord Support: Change how messages are displayed](https://slack.com/help/articles/213893898-Change-how-messages-are-displayed)
- DaisyUI chat classes (`chat-start`, `chat-end`, `chat-bubble`) — [Tailwind Chat bubble Component – daisyUI](https://daisyui.com/components/chat/)
- Adjacent sibling selector grouping: `.me + .me { border-bottom-right-radius: 2px }` — [CSS stacked chat bubbles (Messenger style) | CodePen](https://codepen.io/jmpp/pen/mprGZo)
- 16 chat UI design patterns 2025 — [16 Chat UI Design Patterns That Work in 2025 | BricxLabs](https://bricxlabs.com/blogs/message-screen-ui-deisgn)
