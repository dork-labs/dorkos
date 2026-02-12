# Chat UI Aesthetic Refinement - Task Breakdown

**Spec:** `specs/chat-ui-aesthetic-refinement/02-specification.md`
**Design System:** `guides/design-system.md`
**Date:** 2026-02-07
**Mode:** Full

---

## Phase 1: Foundations (Color, Typography, Spacing)

### Task 1.1: Update color palette and keyframe animations in index.css

**File:** `src/client/index.css`
**Depends on:** Nothing (foundation task)

Update CSS custom properties in `src/client/index.css` to replace zinc HSL values with refined neutral palette. Add `@keyframes` for typing indicator and streaming cursor. Add `prefers-reduced-motion` media query.

#### Light Mode Token Replacements (`:root`)

Replace each value exactly:

| Token | Current (zinc) | New (refined neutral) |
|-------|---------------|----------------------|
| `--background` | `0 0% 100%` | `0 0% 98%` |
| `--foreground` | `240 10% 3.9%` | `0 0% 9%` |
| `--card` | `0 0% 100%` | `0 0% 100%` (unchanged) |
| `--card-foreground` | `240 10% 3.9%` | `0 0% 9%` |
| `--popover` | `0 0% 100%` | `0 0% 100%` (unchanged) |
| `--popover-foreground` | `240 10% 3.9%` | `0 0% 9%` |
| `--primary` | `240 5.9% 10%` | `0 0% 9%` |
| `--primary-foreground` | `0 0% 98%` | `0 0% 98%` (unchanged) |
| `--secondary` | `240 4.8% 95.9%` | `0 0% 96%` |
| `--secondary-foreground` | `240 5.9% 10%` | `0 0% 9%` |
| `--muted` | `240 4.8% 95.9%` | `0 0% 96%` |
| `--muted-foreground` | `240 3.8% 46.1%` | `0 0% 32%` |
| `--accent` | `240 4.8% 95.9%` | `0 0% 96%` |
| `--accent-foreground` | `240 5.9% 10%` | `0 0% 9%` |
| `--border` | `240 5.9% 90%` | `0 0% 83%` |
| `--input` | `240 5.9% 90%` | `0 0% 83%` |
| `--ring` | `240 5.9% 10%` | `217 91% 60%` |

#### Dark Mode Token Replacements (`.dark`)

| Token | Current (zinc) | New (refined neutral) |
|-------|---------------|----------------------|
| `--background` | `240 10% 3.9%` | `0 0% 4%` |
| `--foreground` | `0 0% 98%` | `0 0% 93%` |
| `--card` | `240 10% 3.9%` | `0 0% 4%` |
| `--card-foreground` | `0 0% 98%` | `0 0% 93%` |
| `--popover` | `240 10% 3.9%` | `0 0% 4%` |
| `--popover-foreground` | `0 0% 98%` | `0 0% 93%` |
| `--primary` | `0 0% 98%` | `0 0% 93%` |
| `--primary-foreground` | `240 5.9% 10%` | `0 0% 9%` |
| `--secondary` | `240 3.7% 15.9%` | `0 0% 9%` |
| `--secondary-foreground` | `0 0% 98%` | `0 0% 93%` |
| `--muted` | `240 3.7% 15.9%` | `0 0% 9%` |
| `--muted-foreground` | `240 5% 64.9%` | `0 0% 64%` |
| `--accent` | `240 3.7% 15.9%` | `0 0% 9%` |
| `--accent-foreground` | `0 0% 98%` | `0 0% 93%` |
| `--border` | `240 3.7% 15.9%` | `0 0% 25%` |
| `--input` | `240 3.7% 15.9%` | `0 0% 25%` |
| `--ring` | `240 4.9% 83.9%` | `213 94% 68%` |

#### New Keyframes (add after body styles)

```css
@keyframes typing-dot {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}

@keyframes blink-cursor {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
```

#### Reduced Motion Media Query (add after keyframes)

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

#### Complete Target File

```css
@import "tailwindcss";
@source "../node_modules/streamdown/dist/*.js";

:root {
  --background: 0 0% 98%;
  --foreground: 0 0% 9%;
  --card: 0 0% 100%;
  --card-foreground: 0 0% 9%;
  --popover: 0 0% 100%;
  --popover-foreground: 0 0% 9%;
  --primary: 0 0% 9%;
  --primary-foreground: 0 0% 98%;
  --secondary: 0 0% 96%;
  --secondary-foreground: 0 0% 9%;
  --muted: 0 0% 96%;
  --muted-foreground: 0 0% 32%;
  --accent: 0 0% 96%;
  --accent-foreground: 0 0% 9%;
  --destructive: 0 84.2% 60.2%;
  --destructive-foreground: 0 0% 98%;
  --border: 0 0% 83%;
  --input: 0 0% 83%;
  --ring: 217 91% 60%;
  --radius: 0.5rem;
}

.dark {
  --background: 0 0% 4%;
  --foreground: 0 0% 93%;
  --card: 0 0% 4%;
  --card-foreground: 0 0% 93%;
  --popover: 0 0% 4%;
  --popover-foreground: 0 0% 93%;
  --primary: 0 0% 93%;
  --primary-foreground: 0 0% 9%;
  --secondary: 0 0% 9%;
  --secondary-foreground: 0 0% 93%;
  --muted: 0 0% 9%;
  --muted-foreground: 0 0% 64%;
  --accent: 0 0% 9%;
  --accent-foreground: 0 0% 93%;
  --destructive: 0 62.8% 30.6%;
  --destructive-foreground: 0 0% 98%;
  --border: 0 0% 25%;
  --input: 0 0% 25%;
  --ring: 213 94% 68%;
}

* {
  border-color: hsl(var(--border));
}

body {
  background-color: hsl(var(--background));
  color: hsl(var(--foreground));
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

@keyframes typing-dot {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}

@keyframes blink-cursor {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

#### Acceptance Criteria

- [ ] Light mode background is #FAFAFA (0 0% 98%), not pure white
- [ ] Dark mode background is #0A0A0A (0 0% 4%), not zinc-tinted
- [ ] All light mode tokens updated from zinc to pure neutral grays (no 240deg hue)
- [ ] All dark mode tokens updated from zinc to pure neutral grays
- [ ] Ring color is blue (#3B82F6 light / #60A5FA dark) instead of gray
- [ ] `typing-dot` keyframe exists for three-dot typing indicator
- [ ] `blink-cursor` keyframe exists for streaming cursor
- [ ] `prefers-reduced-motion` media query disables animations
- [ ] Font family includes full system stack (`system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`)
- [ ] No regressions in existing component rendering

---

### Task 1.2: Update typography, spacing, and avatar in MessageItem

**File:** `src/client/components/chat/MessageItem.tsx`
**Depends on:** Nothing (foundation task)

Normalize MessageItem to 8pt grid spacing. Update the Claude avatar from bright `bg-orange-500` to muted terracotta `#C2724E`. Update user message background from nearly-invisible `bg-muted/30` to more visible `bg-muted/40`. Add `max-w-[65ch]` line-length constraint for readability. Add `group` class for hover states (needed by Task 2.2 for timestamps).

#### Current Code (to be modified)

```tsx
export function MessageItem({ message }: MessageItemProps) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex gap-3 px-4 py-3 ${isUser ? 'bg-muted/30' : ''}`}>
      <div className="flex-shrink-0 mt-1">
        {isUser ? (
          <div className="rounded-full bg-primary p-1.5">
            <User className="h-4 w-4 text-primary-foreground" />
          </div>
        ) : (
          <div className="rounded-full bg-orange-500 p-1.5">
            <Bot className="h-4 w-4 text-white" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-muted-foreground mb-1">
          {isUser ? 'You' : 'Claude'}
        </div>
        <div className={isUser ? '' : 'max-w-prose'}>
          {/* content */}
        </div>
      </div>
    </div>
  );
}
```

#### Changes

1. **Avatar color**: Change `bg-orange-500` to `bg-[#C2724E]` for muted terracotta
2. **User message background**: Change `bg-muted/30` to `bg-muted/40` for better visibility
3. **Spacing**: Change `gap-3` to `gap-4` (16px, 8pt grid). Keep `px-4 py-3` (16px/12px, already 8pt-aligned)
4. **Group hover**: Add `group` class to root div, add `hover:bg-muted/20` for subtle hover state, add `transition-colors duration-150`
5. **Line length**: Change `max-w-prose` to `max-w-[65ch]` on assistant content wrapper
6. **Label weight**: Add `font-medium` to "You"/"Claude" labels per design system

#### Updated Component (key parts)

```tsx
export function MessageItem({ message }: MessageItemProps) {
  const isUser = message.role === 'user';

  return (
    <div
      className={cn(
        'group flex gap-4 px-4 py-3 transition-colors duration-150',
        isUser ? 'bg-muted/40' : '',
        'hover:bg-muted/20'
      )}
    >
      <div className="flex-shrink-0 mt-1">
        {isUser ? (
          <div className="rounded-full bg-primary p-1.5">
            <User className="h-4 w-4 text-primary-foreground" />
          </div>
        ) : (
          <div className="rounded-full bg-[#C2724E] p-1.5">
            <Bot className="h-4 w-4 text-white" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-muted-foreground font-medium mb-1">
          {isUser ? 'You' : 'Claude'}
        </div>
        <div className={isUser ? '' : 'max-w-[65ch]'}>
          {isUser ? (
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          ) : (
            <StreamingText content={message.content} />
          )}
        </div>
        {message.toolCalls?.map((tc) => (
          <ToolCallCard key={tc.toolCallId} toolCall={tc} />
        ))}
      </div>
    </div>
  );
}
```

Note: Import `cn` from `../../lib/utils` (already available in the project).

#### Acceptance Criteria

- [ ] Claude avatar uses `bg-[#C2724E]` (muted terracotta), not `bg-orange-500`
- [ ] User message background is `bg-muted/40` (visible tint)
- [ ] Gap between avatar and content is 16px (`gap-4`)
- [ ] Message has `hover:bg-muted/20` hover state with 150ms transition
- [ ] `group` class is present on root element (for hover-reveal timestamps in Task 2.2)
- [ ] Assistant message content constrained to `max-w-[65ch]`
- [ ] "You" and "Claude" labels have `font-medium` weight
- [ ] Existing tests still pass (structure is unchanged, just className updates)

---

### Task 1.3: Normalize spacing in SessionSidebar and SessionItem

**Files:** `src/client/components/sessions/SessionSidebar.tsx`, `src/client/components/sessions/SessionItem.tsx`
**Depends on:** Nothing (foundation task)

Normalize padding to 8pt grid. Add hover transition to SessionItem.

#### SessionSidebar Changes

The current `p-2` (8px) is already 8pt-aligned. Keep it. The "New Session" button border-dashed styling is fine. Ensure consistent 8px spacing (`mb-2` is 8px, good).

No code changes needed in SessionSidebar -- spacing is already 8pt aligned.

#### SessionItem Changes

Current:
```tsx
<div
  onClick={onClick}
  className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm cursor-pointer ${
    isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
  }`}
>
```

Updated -- add `transition-colors duration-150`:
```tsx
<div
  onClick={onClick}
  className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm cursor-pointer transition-colors duration-150 ${
    isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
  }`}
>
```

The only change is adding `transition-colors duration-150` for smooth hover state transitions. The existing spacing (`px-2 py-1.5` = 8px/6px) is close to 8pt grid and acceptable for compact sidebar items.

#### Acceptance Criteria

- [ ] SessionItem has `transition-colors duration-150` class
- [ ] Active/hover state transitions smoothly instead of snapping
- [ ] No layout shifts or visual regressions
- [ ] Existing sidebar functionality unchanged

---

## Phase 2: Motion (motion.dev integration)

### Task 2.1: Install motion and add MotionConfig wrapper in App.tsx

**Files:** `package.json`, `src/client/App.tsx`
**Depends on:** Task 1.1 (CSS palette must be in place)

Install `motion` package. Wrap App root with `<MotionConfig reducedMotion="user">` for global accessibility. Replace static sidebar conditional render with animated width transition. Update the empty state styling.

#### Step 1: Install motion

```bash
npm install motion
```

#### Step 2: Update App.tsx

Current:
```tsx
import { useAppStore } from './stores/app-store';
import { Header } from './components/layout/Header';
import { PermissionBanner } from './components/layout/PermissionBanner';
import { SessionSidebar } from './components/sessions/SessionSidebar';
import { ChatPanel } from './components/chat/ChatPanel';

export function App() {
  const { activeSessionId, sidebarOpen } = useAppStore();

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <PermissionBanner sessionId={activeSessionId} />
      <Header />
      <div className="flex flex-1 overflow-hidden">
        {sidebarOpen && (
          <aside className="w-64 border-r flex-shrink-0 overflow-y-auto">
            <SessionSidebar />
          </aside>
        )}
        <main className="flex-1 overflow-hidden">
          {activeSessionId ? (
            <ChatPanel key={activeSessionId} sessionId={activeSessionId} />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              Select or create a session to begin
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
```

Updated:
```tsx
import { useAppStore } from './stores/app-store';
import { motion, MotionConfig } from 'motion/react';
import { Header } from './components/layout/Header';
import { PermissionBanner } from './components/layout/PermissionBanner';
import { SessionSidebar } from './components/sessions/SessionSidebar';
import { ChatPanel } from './components/chat/ChatPanel';

export function App() {
  const { activeSessionId, sidebarOpen } = useAppStore();

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex flex-col h-screen bg-background text-foreground">
        <PermissionBanner sessionId={activeSessionId} />
        <Header />
        <div className="flex flex-1 overflow-hidden">
          <motion.div
            animate={{ width: sidebarOpen ? 256 : 0 }}
            transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
            className="overflow-hidden flex-shrink-0 border-r"
          >
            <div className="w-64 h-full overflow-y-auto">
              <SessionSidebar />
            </div>
          </motion.div>
          <main className="flex-1 overflow-hidden">
            {activeSessionId ? (
              <ChatPanel key={activeSessionId} sessionId={activeSessionId} />
            ) : (
              <div className="flex-1 flex items-center justify-center h-full">
                <div className="text-center">
                  <p className="text-muted-foreground text-base">New conversation</p>
                  <p className="text-muted-foreground/60 text-sm mt-2">
                    Select a session or start a new one
                  </p>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </MotionConfig>
  );
}
```

#### Key Changes

1. **Import**: `import { motion, MotionConfig } from 'motion/react'`
2. **MotionConfig wrapper**: `<MotionConfig reducedMotion="user">` wraps entire app
3. **Sidebar animation**: `motion.div` with `animate={{ width: sidebarOpen ? 256 : 0 }}` and `overflow-hidden`
4. **Sidebar always renders**: The sidebar content is always in the DOM but hidden by width=0. This enables smooth animation.
5. **Empty state**: Two-line centered text with "New conversation" heading and "Select a session or start a new one" subtitle

#### Acceptance Criteria

- [ ] `motion` package is installed and in `package.json` dependencies
- [ ] `<MotionConfig reducedMotion="user">` wraps the app root
- [ ] Sidebar animates open/closed with 200ms ease-out transition
- [ ] Sidebar content remains rendered (not unmounted) when closed
- [ ] Empty state shows "New conversation" + subtitle when no session selected
- [ ] `prefers-reduced-motion` users see instant sidebar toggle (via MotionConfig)
- [ ] All existing functionality unchanged

---

### Task 2.2: Add message entrance animation with isNew flag

**Files:** `src/client/components/chat/MessageList.tsx`, `src/client/components/chat/MessageItem.tsx`
**Depends on:** Task 1.2 (MessageItem styling), Task 2.1 (motion installed)

Add `isNew` flag to distinguish between history messages (load instantly) and streaming messages (animate entrance). Add hover-reveal timestamps. Wrap MessageItem in motion.div for entrance animation.

#### MessageList Changes

The MessageList needs to track whether history has finished loading. Messages added after history load are "new" (from SSE streaming) and get entrance animations.

Current MessageList passes only `message` to MessageItem. Updated version passes `isNew` and `isStreaming`.

Add state tracking:
```tsx
import { useRef, useEffect, useState, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChatMessage } from '../../hooks/use-chat-session';
import { MessageItem } from './MessageItem';

interface MessageListProps {
  messages: ChatMessage[];
  status?: 'idle' | 'streaming' | 'error';
}

export function MessageList({ messages, status }: MessageListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [historyCount, setHistoryCount] = useState<number | null>(null);

  // On first render with messages, mark them all as history
  useEffect(() => {
    if (historyCount === null && messages.length > 0) {
      setHistoryCount(messages.length);
    }
  }, [messages.length, historyCount]);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    overscan: 5,
    measureElement: (el) => el?.getBoundingClientRect().height ?? 80,
  });

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
    }
  }, [messages.length, virtualizer]);

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto relative">
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: 'relative',
          width: '100%',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const msg = messages[virtualRow.index];
          const isNew = historyCount !== null && virtualRow.index >= historyCount;
          const isLastAssistant =
            virtualRow.index === messages.length - 1 && msg.role === 'assistant';
          const isStreaming = isLastAssistant && status === 'streaming';

          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <MessageItem
                message={msg}
                isNew={isNew}
                isStreaming={isStreaming}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

Note: `status` prop will be threaded from ChatPanel (which already has `status` from `useChatSession`).

#### MessageItem Changes

Update the interface to accept `isNew` and `isStreaming` props. Wrap in `motion.div` for entrance animation. Add hover-reveal timestamp.

```tsx
import { motion } from 'motion/react';
import type { ChatMessage } from '../../hooks/use-chat-session';
import { StreamingText } from './StreamingText';
import { ToolCallCard } from './ToolCallCard';
import { User, Bot } from 'lucide-react';
import { cn } from '../../lib/utils';

interface MessageItemProps {
  message: ChatMessage;
  isNew?: boolean;
  isStreaming?: boolean;
}

function formatTime(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function MessageItem({ message, isNew = false, isStreaming = false }: MessageItemProps) {
  const isUser = message.role === 'user';

  return (
    <motion.div
      initial={isNew ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
      className={cn(
        'group flex gap-4 px-4 py-3 transition-colors duration-150',
        isUser ? 'bg-muted/40' : '',
        'hover:bg-muted/20'
      )}
    >
      <div className="flex-shrink-0 mt-1">
        {isUser ? (
          <div className="rounded-full bg-primary p-1.5">
            <User className="h-4 w-4 text-primary-foreground" />
          </div>
        ) : (
          <div className="rounded-full bg-[#C2724E] p-1.5">
            <Bot className="h-4 w-4 text-white" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs text-muted-foreground font-medium">
            {isUser ? 'You' : 'Claude'}
          </span>
          <span className="text-xs text-muted-foreground/0 group-hover:text-muted-foreground/60 transition-colors duration-150">
            {formatTime(message.timestamp)}
          </span>
        </div>
        <div className={isUser ? '' : 'max-w-[65ch]'}>
          {isUser ? (
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          ) : (
            <StreamingText content={message.content} isStreaming={isStreaming} />
          )}
        </div>
        {message.toolCalls?.map((tc) => (
          <ToolCallCard key={tc.toolCallId} toolCall={tc} />
        ))}
      </div>
    </motion.div>
  );
}
```

#### ChatPanel Threading

In `ChatPanel.tsx`, pass `status` through to `MessageList`:

Current:
```tsx
<MessageList messages={messages} />
```

Updated:
```tsx
<MessageList messages={messages} status={status} />
```

#### Acceptance Criteria

- [ ] New messages (from SSE) fade in with slide-up animation (opacity 0->1, y 8->0, 200ms)
- [ ] History messages load instantly without animation (`initial={false}`)
- [ ] `historyCount` tracking correctly distinguishes history from new messages
- [ ] Hovering over any message reveals its timestamp next to the role label
- [ ] Timestamp is invisible by default (opacity 0), visible on hover (opacity 60%)
- [ ] Timestamp transition is 150ms
- [ ] `isStreaming` prop is passed to last assistant message's StreamingText
- [ ] `status` prop threaded from ChatPanel -> MessageList -> MessageItem
- [ ] Virtual scrolling continues to work correctly with motion.div wrapper
- [ ] Existing MessageList and MessageItem tests still pass (may need motion mock)

---

### Task 2.3: Add tool card expand/collapse animation

**File:** `src/client/components/chat/ToolCallCard.tsx`
**Depends on:** Task 2.1 (motion installed)

Replace static conditional render with AnimatePresence height animation. Animate chevron rotation with spring physics. Add hover state to card container.

#### Current Code

```tsx
<div className="my-1 rounded border bg-muted/50 text-sm">
  <button
    onClick={() => setExpanded(!expanded)}
    className="flex w-full items-center gap-2 px-3 py-1.5"
  >
    {statusIcon}
    <span className="font-mono">{toolCall.toolName}</span>
    <ChevronDown
      className={`ml-auto h-3 w-3 transition-transform ${
        expanded ? 'rotate-180' : ''
      }`}
    />
  </button>
  {expanded && (
    <div className="border-t px-3 py-2">
      {/* content */}
    </div>
  )}
</div>
```

#### Updated Code

```tsx
import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2, Check, X, ChevronDown } from 'lucide-react';
import type { ToolCallState } from '../../hooks/use-chat-session';

interface ToolCallCardProps {
  toolCall: ToolCallState;
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = {
    pending: <Loader2 className="h-3 w-3 animate-spin" />,
    running: <Loader2 className="h-3 w-3 animate-spin text-blue-500" />,
    complete: <Check className="h-3 w-3 text-green-500" />,
    error: <X className="h-3 w-3 text-red-500" />,
  }[toolCall.status];

  return (
    <div className="my-1 rounded border bg-muted/50 text-sm transition-all duration-150 hover:border-border hover:shadow-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1.5"
      >
        {statusIcon}
        <span className="font-mono">{toolCall.toolName}</span>
        <motion.div
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          className="ml-auto"
        >
          <ChevronDown className="h-3 w-3" />
        </motion.div>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t px-3 pb-3 pt-1">
              {toolCall.input && (
                <pre className="text-xs overflow-x-auto whitespace-pre-wrap">
                  {(() => {
                    try {
                      return JSON.stringify(JSON.parse(toolCall.input), null, 2);
                    } catch {
                      return toolCall.input;
                    }
                  })()}
                </pre>
              )}
              {toolCall.result && (
                <pre className="mt-2 text-xs overflow-x-auto border-t pt-2 whitespace-pre-wrap">
                  {toolCall.result}
                </pre>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

#### Key Changes

1. **Import**: Add `motion, AnimatePresence` from `motion/react`
2. **Chevron**: Wrap in `motion.div` with `animate={{ rotate: expanded ? 180 : 0 }}` and spring transition
3. **Content**: Wrap in `AnimatePresence initial={false}` with `motion.div` for height/opacity animation
4. **Hover**: Add `transition-all duration-150 hover:border-border hover:shadow-sm` to card container
5. **Content padding**: Changed from `px-3 py-2` to `px-3 pb-3 pt-1` for better rhythm inside animated container

#### Acceptance Criteria

- [ ] Tool card content expands/collapses with smooth height animation (300ms)
- [ ] Chevron rotates 180 degrees with spring physics (stiffness 400, damping 30)
- [ ] Card shows border + shadow on hover with 150ms transition
- [ ] AnimatePresence enables exit animation (content doesn't just vanish)
- [ ] Expand/collapse still toggles on click
- [ ] Existing ToolCallCard tests still pass (with motion mock)

---

### Task 2.4: Add command palette enter/exit animation

**File:** `src/client/components/commands/CommandPalette.tsx`, `src/client/components/chat/ChatPanel.tsx`
**Depends on:** Task 2.1 (motion installed)

Wrap CommandPalette rendering in AnimatePresence with fade + scale animation.

#### ChatPanel.tsx Change

The AnimatePresence wrapper goes in ChatPanel.tsx where CommandPalette is conditionally rendered:

Current:
```tsx
{showCommands && (
  <CommandPalette
    filteredCommands={filteredCommands}
    selectedIndex={selectedIndex}
    onSelect={handleCommandSelect}
    onClose={() => setShowCommands(false)}
  />
)}
```

Updated:
```tsx
import { AnimatePresence } from 'motion/react';
// ...
<AnimatePresence>
  {showCommands && (
    <CommandPalette
      filteredCommands={filteredCommands}
      selectedIndex={selectedIndex}
      onSelect={handleCommandSelect}
      onClose={() => setShowCommands(false)}
    />
  )}
</AnimatePresence>
```

#### CommandPalette.tsx Change

Wrap the root div in a motion.div with enter/exit animations:

Current root:
```tsx
<div
  className="absolute bottom-full left-0 right-0 mb-2 max-h-80 overflow-hidden rounded-lg border bg-popover shadow-lg"
  onMouseDown={(e) => e.preventDefault()}
>
```

Updated root:
```tsx
import { motion } from 'motion/react';
// ...
<motion.div
  initial={{ opacity: 0, scale: 0.98, y: 4 }}
  animate={{ opacity: 1, scale: 1, y: 0 }}
  exit={{ opacity: 0, scale: 0.98, y: 4 }}
  transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
  className="absolute bottom-full left-0 right-0 mb-2 max-h-80 overflow-hidden rounded-lg border bg-popover shadow-lg"
  onMouseDown={(e) => e.preventDefault()}
>
```

#### Acceptance Criteria

- [ ] Command palette fades in with subtle scale (0.98->1) and slide (y: 4->0) animation, 150ms
- [ ] Command palette fades out on close with matching exit animation
- [ ] AnimatePresence in ChatPanel enables exit animations
- [ ] No change to command selection, keyboard navigation, or filtering behavior
- [ ] Existing CommandPalette tests still pass (with motion mock)

---

## Phase 3: Micro-interactions & Polish

### Task 3.1: Add button micro-interactions and input refinements in ChatInput

**File:** `src/client/components/chat/ChatInput.tsx`
**Depends on:** Task 2.1 (motion installed)

Replace static button elements with motion.button for hover/press scale animations. Update placeholder text. Add focus ring transition to textarea wrapper.

#### Current Buttons

```tsx
// Send button
<button
  onClick={onSubmit}
  disabled={!value.trim()}
  className="rounded-lg bg-primary p-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
  aria-label="Send message"
>
  <Send className="h-4 w-4" />
</button>

// Stop button
<button
  onClick={onStop}
  className="rounded-lg bg-destructive p-2 text-destructive-foreground hover:bg-destructive/90"
  aria-label="Stop generating"
>
  <Square className="h-4 w-4" />
</button>
```

#### Updated Code

```tsx
import { useRef, useCallback, useState } from 'react';
import { motion } from 'motion/react';
import { Send, Square } from 'lucide-react';

// ... (interface and destructuring unchanged)

export function ChatInput({ /* same props */ }: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isFocused, setIsFocused] = useState(false);

  // ... (handleKeyDown, handleChange unchanged)

  const handleFocus = useCallback(() => setIsFocused(true), []);
  const handleBlurEvent = useCallback(() => {
    setIsFocused(false);
    if (isPaletteOpen) {
      onEscape?.();
    }
  }, [isPaletteOpen, onEscape]);

  return (
    <div className="flex items-end gap-2">
      <div
        className={cn(
          'flex-1 rounded-lg border transition-colors duration-150',
          isFocused ? 'border-ring' : 'border-border'
        )}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlurEvent}
          role="combobox"
          aria-autocomplete="list"
          aria-controls="command-palette-listbox"
          aria-expanded={isPaletteOpen ?? false}
          aria-activedescendant={isPaletteOpen ? activeDescendantId : undefined}
          placeholder="Message Claude..."
          className="w-full resize-none bg-transparent px-3 py-2 text-sm focus:outline-none min-h-[40px] max-h-[200px]"
          rows={1}
          disabled={isLoading}
        />
      </div>
      {isLoading ? (
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          onClick={onStop}
          className="rounded-lg bg-destructive p-2 text-destructive-foreground hover:bg-destructive/90"
          aria-label="Stop generating"
        >
          <Square className="h-4 w-4" />
        </motion.button>
      ) : (
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          onClick={onSubmit}
          disabled={!value.trim()}
          className="rounded-lg bg-primary p-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          aria-label="Send message"
        >
          <Send className="h-4 w-4" />
        </motion.button>
      )}
    </div>
  );
}
```

Note: Import `cn` from `../../lib/utils`.

#### Key Changes

1. **motion.button**: Both send and stop buttons use `motion.button` with `whileHover={{ scale: 1.05 }}` and `whileTap={{ scale: 0.97 }}` with spring transition
2. **Placeholder**: Changed from `"Type a message or / for commands..."` to `"Message Claude..."`
3. **Focus ring**: Textarea wrapped in a div with `border-ring` on focus, `border-border` otherwise, with `transition-colors duration-150`
4. **Textarea border removed**: Border is now on the wrapper div, textarea uses `bg-transparent` and `focus:outline-none`
5. **Focus state**: `isFocused` state + `onFocus`/`onBlur` handlers to control wrapper border color
6. **Blur handler merged**: Combined the existing `handleBlur` (palette close on blur) with the new focus state management

#### Acceptance Criteria

- [ ] Send button scales to 1.05 on hover, 0.97 on press with spring physics
- [ ] Stop button has same scale micro-interactions
- [ ] Textarea placeholder reads "Message Claude..."
- [ ] Textarea wrapper border transitions from `border-border` to `border-ring` on focus (150ms)
- [ ] Existing ChatInput tests still pass (motion.button renders as button with mock)
- [ ] All keyboard handling unchanged (Enter, Shift+Enter, Escape, arrows)

---

### Task 3.2: Add streaming cursor to StreamingText

**File:** `src/client/components/chat/StreamingText.tsx`
**Depends on:** Task 1.1 (blink-cursor keyframe), Task 2.2 (isStreaming prop threading)

Accept an `isStreaming` prop. When true, show a blinking cursor after Streamdown content.

#### Current Code

```tsx
import { Streamdown } from 'streamdown';

interface StreamingTextProps {
  content: string;
}

export function StreamingText({ content }: StreamingTextProps) {
  return (
    <Streamdown
      shikiTheme={['github-light', 'github-dark']}
    >
      {content}
    </Streamdown>
  );
}
```

#### Updated Code

```tsx
import { Streamdown } from 'streamdown';

interface StreamingTextProps {
  content: string;
  isStreaming?: boolean;
}

export function StreamingText({ content, isStreaming = false }: StreamingTextProps) {
  return (
    <div className="relative">
      <Streamdown shikiTheme={['github-light', 'github-dark']}>
        {content}
      </Streamdown>
      {isStreaming && (
        <span
          className="inline-block w-0.5 h-[1.1em] bg-foreground/70 align-text-bottom ml-0.5"
          style={{ animation: 'blink-cursor 1s step-end infinite' }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
```

#### Key Changes

1. **Interface**: Added `isStreaming?: boolean` prop (default false)
2. **Wrapper**: Streamdown wrapped in a `div.relative` to contain the cursor
3. **Cursor element**: `span` with `inline-block w-0.5 h-[1.1em]` (thin, line-height-matched), `bg-foreground/70` color, blinking via CSS `blink-cursor` keyframe (1s, step-end timing)
4. **Accessibility**: `aria-hidden="true"` since cursor is purely decorative
5. **Reduced motion**: Handled by the global `prefers-reduced-motion` media query in index.css

#### Acceptance Criteria

- [ ] Blinking cursor visible when `isStreaming={true}`
- [ ] Cursor hidden when `isStreaming={false}` (default)
- [ ] Cursor blinks at 1s interval with step-end timing
- [ ] Cursor is `aria-hidden="true"` for screen readers
- [ ] Cursor color is `foreground/70` (adapts to light/dark mode)
- [ ] Cursor dimensions: 2px wide, 1.1em tall (matches text line height)
- [ ] Existing StreamingText tests still pass (they don't pass isStreaming)

---

### Task 3.3: Add scroll-to-bottom button in MessageList

**File:** `src/client/components/chat/MessageList.tsx`
**Depends on:** Task 2.2 (MessageList already being modified)

Add a floating scroll-to-bottom button that appears when the user scrolls up from the bottom.

#### Implementation

Add to the MessageList component (which already has the virtualizer and parentRef):

```tsx
import { useRef, useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowDown } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChatMessage } from '../../hooks/use-chat-session';
import { MessageItem } from './MessageItem';

interface MessageListProps {
  messages: ChatMessage[];
  status?: 'idle' | 'streaming' | 'error';
}

export function MessageList({ messages, status }: MessageListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  useEffect(() => {
    if (historyCount === null && messages.length > 0) {
      setHistoryCount(messages.length);
    }
  }, [messages.length, historyCount]);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    overscan: 5,
    measureElement: (el) => el?.getBoundingClientRect().height ?? 80,
  });

  // Track scroll position for scroll-to-bottom button
  const handleScroll = useCallback(() => {
    const container = parentRef.current;
    if (!container) return;
    const threshold = 100;
    const isNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    setShowScrollButton(!isNearBottom);
  }, []);

  useEffect(() => {
    const container = parentRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // Auto-scroll to bottom on new messages (only if near bottom)
  useEffect(() => {
    if (messages.length > 0 && !showScrollButton) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
    }
  }, [messages.length, virtualizer, showScrollButton]);

  const scrollToBottom = useCallback(() => {
    virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
    setShowScrollButton(false);
  }, [virtualizer, messages.length]);

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto relative">
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: 'relative',
          width: '100%',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const msg = messages[virtualRow.index];
          const isNew = historyCount !== null && virtualRow.index >= historyCount;
          const isLastAssistant =
            virtualRow.index === messages.length - 1 && msg.role === 'assistant';
          const isStreaming = isLastAssistant && status === 'streaming';

          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <MessageItem
                message={msg}
                isNew={isNew}
                isStreaming={isStreaming}
              />
            </div>
          );
        })}
      </div>

      <AnimatePresence>
        {showScrollButton && (
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.15 }}
            onClick={scrollToBottom}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-background border shadow-sm p-2 hover:shadow-md transition-shadow"
            aria-label="Scroll to bottom"
          >
            <ArrowDown className="h-4 w-4" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
```

#### Key Changes

1. **Scroll tracking**: `handleScroll` callback checks if user is within 100px of bottom. If not, show button.
2. **Event listener**: Added on mount, removed on unmount, with `{ passive: true }` for performance
3. **Conditional auto-scroll**: Only auto-scroll to bottom on new messages if user hasn't scrolled up
4. **Floating button**: Positioned `absolute bottom-4 left-1/2 -translate-x-1/2`, rounded-full with border + shadow
5. **Button animation**: AnimatePresence with fade + slide (opacity 0->1, y 10->0), 150ms
6. **ArrowDown icon**: From lucide-react, already available

#### Acceptance Criteria

- [ ] Scroll-to-bottom button appears when user scrolls up more than 100px from bottom
- [ ] Button disappears when user is near bottom
- [ ] Clicking button scrolls to latest message
- [ ] Button has enter/exit animation (fade + slide)
- [ ] Auto-scroll only happens when user is already at bottom (doesn't fight manual scrolling)
- [ ] Button has `aria-label="Scroll to bottom"` for accessibility
- [ ] Button has hover shadow increase
- [ ] No performance issues with scroll event listener (passive flag)

---

### Task 3.4: Add typing indicator and empty session state in ChatPanel

**File:** `src/client/components/chat/ChatPanel.tsx`
**Depends on:** Task 1.1 (typing-dot keyframe), Task 2.1 (AnimatePresence for command palette)

Replace the spinner loading indicator with a three-dot typing indicator. Add empty session greeting. Refine error banner colors.

#### TypingIndicator Component (inline in ChatPanel)

```tsx
function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 px-4 py-3">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="w-2 h-2 rounded-full bg-muted-foreground/50"
          style={{ animation: `typing-dot 1.4s ease-in-out ${i * 0.2}s infinite` }}
        />
      ))}
    </div>
  );
}
```

#### ChatPanel Changes

Current loading state:
```tsx
{isLoadingHistory ? (
  <div className="flex-1 flex items-center justify-center">
    <div className="flex items-center gap-2 text-muted-foreground text-sm">
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
      Loading conversation history...
    </div>
  </div>
) : (
  <MessageList messages={messages} />
)}
```

Updated:
```tsx
{isLoadingHistory ? (
  <div className="flex-1 flex items-center justify-center">
    <TypingIndicator />
  </div>
) : messages.length === 0 ? (
  <div className="flex-1 flex items-center justify-center">
    <div className="text-center">
      <p className="text-muted-foreground text-base">Start a conversation</p>
      <p className="text-muted-foreground/60 text-sm mt-2">
        Type a message or use / for commands
      </p>
    </div>
  </div>
) : (
  <MessageList messages={messages} status={status} />
)}
```

#### Error Banner Refinement

Current:
```tsx
<div className="mx-4 mb-2 rounded-lg bg-destructive/10 text-destructive px-3 py-2 text-sm">
  Error: {error}
</div>
```

Updated (use muted red with border):
```tsx
<div className="mx-4 mb-2 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20 px-3 py-2 text-sm">
  Error: {error}
</div>
```

#### Full Updated ChatPanel

```tsx
import { useState, useMemo, useEffect, useCallback } from 'react';
import { AnimatePresence } from 'motion/react';
import { useChatSession } from '../../hooks/use-chat-session';
import { useCommands } from '../../hooks/use-commands';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { CommandPalette } from '../commands/CommandPalette';
import type { CommandEntry } from '@shared/types';

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 px-4 py-3">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="w-2 h-2 rounded-full bg-muted-foreground/50"
          style={{ animation: `typing-dot 1.4s ease-in-out ${i * 0.2}s infinite` }}
        />
      ))}
    </div>
  );
}

interface ChatPanelProps {
  sessionId: string;
}

export function ChatPanel({ sessionId }: ChatPanelProps) {
  const { messages, input, setInput, handleSubmit, status, error, stop, isLoadingHistory } =
    useChatSession(sessionId);
  // ... (all existing command palette state and handlers unchanged)

  return (
    <div className="flex flex-col h-full">
      {isLoadingHistory ? (
        <div className="flex-1 flex items-center justify-center">
          <TypingIndicator />
        </div>
      ) : messages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-muted-foreground text-base">Start a conversation</p>
            <p className="text-muted-foreground/60 text-sm mt-2">
              Type a message or use / for commands
            </p>
          </div>
        </div>
      ) : (
        <MessageList messages={messages} status={status} />
      )}

      {error && (
        <div className="mx-4 mb-2 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20 px-3 py-2 text-sm">
          Error: {error}
        </div>
      )}

      <div className="relative border-t p-4">
        <AnimatePresence>
          {showCommands && (
            <CommandPalette
              filteredCommands={filteredCommands}
              selectedIndex={selectedIndex}
              onSelect={handleCommandSelect}
              onClose={() => setShowCommands(false)}
            />
          )}
        </AnimatePresence>

        <ChatInput
          value={input}
          onChange={handleInputChange}
          onSubmit={handleSubmit}
          isLoading={status === 'streaming'}
          onStop={stop}
          onEscape={() => setShowCommands(false)}
          isPaletteOpen={showCommands}
          onArrowUp={handleArrowUp}
          onArrowDown={handleArrowDown}
          onCommandSelect={handleKeyboardCommandSelect}
          activeDescendantId={activeDescendantId}
        />
      </div>
    </div>
  );
}
```

#### Acceptance Criteria

- [ ] Loading spinner replaced with three-dot typing indicator
- [ ] Typing dots pulse with staggered 0.2s delays (1.4s cycle)
- [ ] Empty session (0 messages, history loaded) shows "Start a conversation" centered greeting
- [ ] Error banner uses muted red: `bg-red-500/10`, `text-red-600`, `border-red-500/20`
- [ ] Error banner adapts to dark mode: `dark:text-red-400`
- [ ] AnimatePresence wraps CommandPalette conditional render (for exit animations)
- [ ] `status` prop passed to `MessageList` for streaming detection
- [ ] All existing ChatPanel functionality unchanged (command palette, input handling)

---

## Phase 4: Visual Details & Tests

### Task 4.1: Soften tool approval status colors

**File:** `src/client/components/chat/ToolApproval.tsx`
**Depends on:** Nothing (independent visual task)

Replace saturated status colors with muted, accessible variants. Add transition-colors for smooth state transitions.

#### Status Color Mapping

| Status | Current | New |
|--------|---------|-----|
| Pending | `border-yellow-500/50 bg-yellow-500/10` | `border-amber-500/20 bg-amber-500/10` |
| Approved | `border-green-500/50 bg-green-500/10` | `border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400` |
| Denied | `border-red-500/50 bg-red-500/10` | `border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400` |
| Approve button | `bg-green-600 hover:bg-green-700` | `bg-emerald-600 hover:bg-emerald-700` |
| Deny button | `bg-red-600 hover:bg-red-700` | `bg-red-600 hover:bg-red-700` (unchanged) |
| Shield icon | `text-yellow-500` | `text-amber-500` |

#### Updated Component

```tsx
import { useState } from 'react';
import { Check, X, Shield } from 'lucide-react';
import { api } from '../../lib/api';

interface ToolApprovalProps {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: string;
}

export function ToolApproval({ sessionId, toolCallId, toolName, input }: ToolApprovalProps) {
  const [responding, setResponding] = useState(false);
  const [decided, setDecided] = useState<'approved' | 'denied' | null>(null);

  async function handleApprove() {
    setResponding(true);
    try {
      await api.approveTool(sessionId, toolCallId);
      setDecided('approved');
    } catch (err) {
      console.error('Approval failed:', err);
    } finally {
      setResponding(false);
    }
  }

  async function handleDeny() {
    setResponding(true);
    try {
      await api.denyTool(sessionId, toolCallId);
      setDecided('denied');
    } catch (err) {
      console.error('Deny failed:', err);
    } finally {
      setResponding(false);
    }
  }

  if (decided) {
    return (
      <div className={`my-1 rounded border px-3 py-2 text-sm transition-colors duration-200 ${
        decided === 'approved'
          ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400'
      }`}>
        <span className="font-mono">{toolName}</span>
        <span className="ml-2 text-xs">
          {decided === 'approved' ? 'Approved' : 'Denied'}
        </span>
      </div>
    );
  }

  return (
    <div className="my-1 rounded border border-amber-500/20 bg-amber-500/10 p-3 text-sm transition-colors duration-200">
      <div className="flex items-center gap-2 mb-2">
        <Shield className="h-4 w-4 text-amber-500" />
        <span className="font-semibold">Tool approval required</span>
      </div>
      <div className="font-mono text-xs mb-2">{toolName}</div>
      {input && (
        <pre className="text-xs overflow-x-auto mb-3 p-2 bg-muted rounded whitespace-pre-wrap">
          {(() => {
            try {
              return JSON.stringify(JSON.parse(input), null, 2);
            } catch {
              return input;
            }
          })()}
        </pre>
      )}
      <div className="flex gap-2">
        <button
          onClick={handleApprove}
          disabled={responding}
          className="flex items-center gap-1 rounded bg-emerald-600 px-3 py-1 text-white text-xs hover:bg-emerald-700 disabled:opacity-50 transition-colors"
        >
          <Check className="h-3 w-3" /> Approve
        </button>
        <button
          onClick={handleDeny}
          disabled={responding}
          className="flex items-center gap-1 rounded bg-red-600 px-3 py-1 text-white text-xs hover:bg-red-700 disabled:opacity-50 transition-colors"
        >
          <X className="h-3 w-3" /> Deny
        </button>
      </div>
    </div>
  );
}
```

#### Key Changes

1. **Pending state**: `yellow-500` -> `amber-500` (warmer), border opacity from `/50` to `/20` (subtler)
2. **Approved state**: `green-500` -> `emerald-500`, added explicit text colors for dark mode
3. **Denied state**: border opacity from `/50` to `/20`, added explicit dark mode text
4. **Shield icon**: `text-yellow-500` -> `text-amber-500`
5. **Approve button**: `bg-green-600` -> `bg-emerald-600`
6. **Transitions**: Added `transition-colors duration-200` to decided and pending containers
7. **Button transitions**: Added `transition-colors` to approve/deny buttons

#### Acceptance Criteria

- [ ] Pending state uses amber-500 (not yellow-500)
- [ ] Approved state uses emerald-500 with explicit light/dark text colors
- [ ] Denied state uses red-500 with explicit light/dark text colors
- [ ] All borders are subtle (/20 opacity, not /50)
- [ ] State transitions are smooth (200ms transition-colors)
- [ ] Buttons have transition-colors for hover state
- [ ] All functionality unchanged (approve/deny still works)

---

### Task 4.2: Update and add tests for all changed components

**Files:**
- `src/client/components/chat/__tests__/MessageItem.test.tsx`
- `src/client/components/chat/__tests__/StreamingText.test.tsx`
- `src/client/components/chat/__tests__/ToolCallCard.test.tsx`
- `src/client/components/chat/__tests__/MessageList.test.tsx`
- `src/client/components/chat/__tests__/ChatInput.test.tsx`

**Depends on:** ALL previous tasks (tests verify the changes)

Add motion/react mock to all test files that use components with motion. Add new test cases for new behaviors.

#### Global Motion Mock

Every test file that renders components using motion.div or AnimatePresence needs this mock at the top (before describe blocks):

```tsx
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
  MotionConfig: ({ children }: any) => <>{children}</>,
}));
```

#### MessageItem.test.tsx Updates

Add motion mock. Add new test cases:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MessageItem } from '../MessageItem';

afterEach(() => {
  cleanup();
});

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div data-testid="streamdown">{children}</div>,
}));

vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
  MotionConfig: ({ children }: any) => <>{children}</>,
}));

describe('MessageItem', () => {
  // ... keep ALL existing tests unchanged ...

  it('applies initial animation props when isNew is true', () => {
    const msg = { id: '1', role: 'assistant' as const, content: 'Hi', timestamp: new Date().toISOString() };
    render(<MessageItem message={msg} isNew={true} />);
    expect(screen.getByText('Claude')).toBeDefined();
  });

  it('renders without animation when isNew is false', () => {
    const msg = { id: '1', role: 'assistant' as const, content: 'Hi', timestamp: new Date().toISOString() };
    render(<MessageItem message={msg} isNew={false} />);
    expect(screen.getByText('Claude')).toBeDefined();
  });

  it('renders timestamp element', () => {
    const ts = '2026-02-07T10:30:00Z';
    const msg = { id: '1', role: 'user' as const, content: 'Test', timestamp: ts };
    render(<MessageItem message={msg} />);
    // Timestamp text should be in the DOM (visibility controlled by CSS hover)
    expect(screen.getByText(/10:30/)).toBeDefined();
  });

  it('renders Claude avatar with terracotta color (not orange-500)', () => {
    const msg = { id: '1', role: 'assistant' as const, content: 'Hi', timestamp: new Date().toISOString() };
    const { container } = render(<MessageItem message={msg} />);
    // Verify orange-500 is no longer used
    expect(container.querySelector('.bg-orange-500')).toBeNull();
    // Verify terracotta class is present
    expect(container.querySelector('.bg-\\[\\#C2724E\\]')).toBeDefined();
  });

  it('passes isStreaming to StreamingText for assistant messages', () => {
    const msg = { id: '1', role: 'assistant' as const, content: 'Hi', timestamp: new Date().toISOString() };
    render(<MessageItem message={msg} isStreaming={true} />);
    expect(screen.getByTestId('streamdown')).toBeDefined();
  });
});
```

#### StreamingText.test.tsx Updates

Add tests for streaming cursor:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { StreamingText } from '../StreamingText';

afterEach(() => {
  cleanup();
});

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div data-testid="streamdown">{children}</div>,
}));

describe('StreamingText', () => {
  // ... keep ALL existing tests unchanged ...

  it('shows cursor when streaming', () => {
    const { container } = render(<StreamingText content="Hello" isStreaming={true} />);
    const cursor = container.querySelector('[aria-hidden="true"]');
    expect(cursor).not.toBeNull();
  });

  it('hides cursor when not streaming', () => {
    const { container } = render(<StreamingText content="Hello" isStreaming={false} />);
    const cursor = container.querySelector('[style*="blink-cursor"]');
    expect(cursor).toBeNull();
  });

  it('hides cursor by default (isStreaming not passed)', () => {
    const { container } = render(<StreamingText content="Hello" />);
    const cursor = container.querySelector('[style*="blink-cursor"]');
    expect(cursor).toBeNull();
  });
});
```

#### ToolCallCard.test.tsx Updates

Add motion mock:

```tsx
// Add at top with other mocks:
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
  MotionConfig: ({ children }: any) => <>{children}</>,
}));

// Add new test case:
it('renders expanded content with animation wrapper', () => {
  render(<ToolCallCard toolCall={baseToolCall} />);
  const button = screen.getByText('Read');
  fireEvent.click(button);
  // With mocked AnimatePresence, content renders directly
  expect(screen.getByText(/file_path/)).toBeDefined();
});
```

#### MessageList.test.tsx Updates

Add motion mock:

```tsx
// Add at top with other mocks:
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
  MotionConfig: ({ children }: any) => <>{children}</>,
}));
```

The existing tests should pass with the mock since motion.div renders as a plain div.

#### ChatInput.test.tsx Updates

Add motion mock:

```tsx
// Add at top:
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
  MotionConfig: ({ children }: any) => <>{children}</>,
}));
```

Update the placeholder test:
```tsx
// Change from:
expect(screen.getByPlaceholderText(/Type a message/)).toBeDefined();
// To:
expect(screen.getByPlaceholderText(/Message Claude/)).toBeDefined();
```

#### Acceptance Criteria

- [ ] All test files have motion/react mock
- [ ] All existing tests still pass
- [ ] MessageItem tests: isNew renders without error, timestamp in DOM, terracotta avatar class present, orange-500 absent
- [ ] StreamingText tests: cursor present when isStreaming=true, absent when false/default
- [ ] ToolCallCard tests: expand still works with AnimatePresence mock
- [ ] ChatInput tests: placeholder updated to "Message Claude..."
- [ ] `npm run test:run` passes with 0 failures

---

### Task 4.3: Update gateway CLAUDE.md documentation

**File:** `CLAUDE.md` (gateway root)
**Depends on:** ALL previous tasks

Add note about motion.dev for animations. Reference design system guide.

#### Addition to CLAUDE.md

Add under the "### Client (`src/client/`)" section, after the existing bullet about Markdown Rendering:

```
- **Animation**: motion.dev (imported as `motion/react`) for message entrance, tool card expand/collapse, command palette, sidebar toggle, and button interactions. `<MotionConfig reducedMotion="user">` wraps the app root. CSS-only `@keyframes` for typing indicator and streaming cursor. All motion respects `prefers-reduced-motion`. See `guides/design-system.md` for the full design system including color tokens, typography scale, spacing grid, and motion catalog.
```

#### Acceptance Criteria

- [ ] CLAUDE.md mentions motion.dev for animations
- [ ] References `guides/design-system.md` for design system details
- [ ] Notes that MotionConfig wraps the app root
- [ ] Notes prefers-reduced-motion support
- [ ] No other CLAUDE.md content changed

---

## Dependency Graph

```
P1.1 (CSS palette) ─────────────┐
P1.2 (MessageItem styling) ─────┤
P1.3 (sidebar spacing) ─────────┤ (all independent foundations)
                                 │
                                 v
P2.1 (motion install + App) ─── depends on P1.1
  ├── P2.2 (message anim) ───── depends on P1.2, P2.1
  │     ├── P3.2 (streaming cursor) depends on P1.1, P2.2
  │     └── P3.3 (scroll button) depends on P2.2
  ├── P2.3 (tool card anim) ─── depends on P2.1
  ├── P2.4 (command palette) ─── depends on P2.1
  └── P3.1 (button micro) ──── depends on P2.1

P3.4 (typing indicator) ──────── depends on P1.1, P2.1

P4.1 (tool approval colors) ──── independent (no deps)

P4.2 (tests) ─────────────────── depends on ALL other tasks
P4.3 (docs) ──────────────────── depends on ALL other tasks
```

## Parallel Execution Opportunities

- **Wave 1**: P1.1, P1.2, P1.3, P4.1 can all run in parallel (no cross-dependencies)
- **Wave 2**: P2.1 (after P1.1 completes)
- **Wave 3**: P2.2, P2.3, P2.4, P3.1, P3.4 can all run in parallel (after P2.1)
- **Wave 4**: P3.2, P3.3 (after P2.2)
- **Wave 5**: P4.2, P4.3 (after all others)

## Critical Path

```
P1.1 -> P2.1 -> P2.2 -> P3.3 -> P4.2 -> P4.3
```

## Task Summary

| ID | Phase | Title | Dependencies |
|----|-------|-------|-------------|
| 1.1 | P1 | Update color palette and keyframe animations in index.css | None |
| 1.2 | P1 | Update typography, spacing, and avatar in MessageItem | None |
| 1.3 | P1 | Normalize spacing in SessionSidebar and SessionItem | None |
| 2.1 | P2 | Install motion and add MotionConfig wrapper in App.tsx | 1.1 |
| 2.2 | P2 | Add message entrance animation with isNew flag | 1.2, 2.1 |
| 2.3 | P2 | Add tool card expand/collapse animation | 2.1 |
| 2.4 | P2 | Add command palette enter/exit animation | 2.1 |
| 3.1 | P3 | Add button micro-interactions and input refinements | 2.1 |
| 3.2 | P3 | Add streaming cursor to StreamingText | 1.1, 2.2 |
| 3.3 | P3 | Add scroll-to-bottom button in MessageList | 2.2 |
| 3.4 | P3 | Add typing indicator and empty session state in ChatPanel | 1.1, 2.1 |
| 4.1 | P4 | Soften tool approval status colors | None |
| 4.2 | P4 | Update and add tests for all changed components | All others |
| 4.3 | P4 | Update gateway CLAUDE.md documentation | All others |
