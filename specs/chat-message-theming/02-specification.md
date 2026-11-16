# Chat Message Theming & MessageItem Architecture

**Status:** Draft
**Authors:** Claude Code, 2026-03-09
**Spec:** 105
**Ideation:** [specs/chat-message-theming/01-ideation.md](./01-ideation.md)
**Research:** [research/20260309_chat_message_theming_architecture.md](../../research/20260309_chat_message_theming_architecture.md)

---

## Overview

Redesign the chat message theming system and `MessageItem.tsx` architecture to establish a semantic design token foundation, variant-driven styling via tailwind-variants, and composable sub-component decomposition. The chat interface is DorkOS's primary product surface — this spec upgrades its internal architecture without changing any user-visible behavior.

## Background / Problem Statement

The current `MessageItem.tsx` (272 lines) has two compounding problems:

1. **Styling is inline conditional logic.** Role-based styling is expressed as ternary expressions (`isUser ? 'bg-user-msg hover:bg-user-msg/90' : 'hover:bg-muted/20'`). Position-based spacing is inline (`isGroupStart ? 'pt-4' : 'pt-0.5'`). There is exactly one message-specific semantic token (`--user-msg`); all status colors in `ToolCallCard` and `ToolApproval` are hardcoded Tailwind color classes (`text-blue-500`, `bg-emerald-500/10`, `bg-red-600`).

2. **Rendering logic for 5+ message sub-types is inlined in one component.** The user-side has a 3-branch nested conditional (plain/command/compaction). The assistant-side maps over `parts` with inline type-switching. Props are drilled from `MessageItem` through `AutoHideToolCall` to `ToolCallCard`, and `sessionId`/`activeToolCallId`/`onToolRef`/`focusedOptionIndex`/`onToolDecided` all pass through `MessageItem` to reach `ToolApproval` and `QuestionPrompt`.

Every styling change requires navigating conditional logic. Adding a new message type requires modifying the monolith. Status colors can't be changed from a single location.

## Goals

- Establish a complete 7-category semantic token system (`--msg-*`, `--status-*`) in `index.css` covering color, typography, spacing, shape, motion, interactive states, and elevation
- Replace all hardcoded color values in message components with semantic tokens
- Introduce `tailwind-variants` for multi-slot message styling, replacing inline `cn()` conditionals
- Decompose `MessageItem` into focused sub-components in `features/chat/ui/message/`
- Add `MessageContext` (React Context) to eliminate prop drilling
- Maintain exact visual parity — no user-visible changes
- Maintain virtualizer compatibility — `motion.div` remains the outermost measurement target

## Non-Goals

- Density settings UI toggle (tokens only, no toggle)
- Avatar/profile pictures, bubble-style redesign
- MessageList refactoring (virtual scroll logic is clean)
- New message types (system, pinned, etc.)
- Changes to `useChatSession` or chat state management
- Changes to `ChatPanel` or `MessageList` props/API

## Technical Dependencies

| Dependency                 | Version          | Purpose                                           |
| -------------------------- | ---------------- | ------------------------------------------------- |
| `tailwind-variants`        | `^2.0`           | Multi-slot variant styling for message components |
| `tailwindcss`              | `4.x` (existing) | CSS-first configuration with `@theme inline`      |
| `motion`                   | existing         | Entrance animations (unchanged)                   |
| `class-variance-authority` | existing         | Stays for shadcn primitives (no change)           |

**New dependency: `tailwind-variants`** (~3.5KB min+gzip). Install via `pnpm --filter=@dorkos/client add tailwind-variants`. TV coexists with CVA — both output class strings. CVA remains for single-element shadcn primitives; TV is used for multi-slot feature components.

## Detailed Design

### 1. Semantic Token System (`index.css`)

Add tokens in 7 categories to `:root` and `.dark` blocks. All follow the existing HSL pattern. New tokens use the `--msg-*` and `--status-*` prefixes.

#### 1a. Status Color Tokens

These replace all hardcoded emerald/red/blue/green colors in `ToolCallCard` and `ToolApproval`.

```css
/* === Status tokens === */
:root {
  --status-success: 152 69% 31%; /* replaces emerald-600 */
  --status-success-bg: 152 69% 96%; /* replaces emerald-500/10 */
  --status-success-border: 152 69% 80%; /* replaces emerald-500/20 */
  --status-success-fg: 152 69% 31%;

  --status-error: 0 72% 51%; /* replaces red-600 */
  --status-error-bg: 0 72% 96%; /* replaces red-500/10 */
  --status-error-border: 0 72% 80%; /* replaces red-500/20 */
  --status-error-fg: 0 72% 41%;

  --status-warning: 38 92% 50%; /* replaces amber-500 */
  --status-warning-bg: 38 92% 96%; /* replaces amber-500/10 */
  --status-warning-border: 38 92% 80%; /* replaces amber-500/20 */
  --status-warning-fg: 38 92% 40%;

  --status-info: 217 91% 60%; /* replaces blue-500 */
  --status-info-bg: 217 91% 96%;
  --status-info-border: 217 91% 80%;
  --status-info-fg: 217 91% 40%;

  --status-pending: 0 0% 45%; /* neutral for pending state */
  --status-pending-bg: 0 0% 96%;
  --status-pending-fg: 0 0% 32%;
}

.dark {
  --status-success: 152 69% 55%;
  --status-success-bg: 152 69% 12%;
  --status-success-border: 152 69% 25%;
  --status-success-fg: 152 69% 55%;

  --status-error: 0 72% 60%;
  --status-error-bg: 0 72% 12%;
  --status-error-border: 0 72% 25%;
  --status-error-fg: 0 72% 60%;

  --status-warning: 38 92% 60%;
  --status-warning-bg: 38 92% 12%;
  --status-warning-border: 38 92% 25%;
  --status-warning-fg: 38 92% 50%;

  --status-info: 213 94% 68%;
  --status-info-bg: 213 94% 12%;
  --status-info-border: 213 94% 25%;
  --status-info-fg: 213 94% 68%;

  --status-pending: 0 0% 55%;
  --status-pending-bg: 0 0% 12%;
  --status-pending-fg: 0 0% 64%;
}
```

Register in `@theme inline`:

```css
@theme inline {
  /* Status colors */
  --color-status-success: hsl(var(--status-success));
  --color-status-success-bg: hsl(var(--status-success-bg));
  --color-status-success-border: hsl(var(--status-success-border));
  --color-status-success-fg: hsl(var(--status-success-fg));
  --color-status-error: hsl(var(--status-error));
  --color-status-error-bg: hsl(var(--status-error-bg));
  --color-status-error-border: hsl(var(--status-error-border));
  --color-status-error-fg: hsl(var(--status-error-fg));
  --color-status-warning: hsl(var(--status-warning));
  --color-status-warning-bg: hsl(var(--status-warning-bg));
  --color-status-warning-border: hsl(var(--status-warning-border));
  --color-status-warning-fg: hsl(var(--status-warning-fg));
  --color-status-info: hsl(var(--status-info));
  --color-status-info-bg: hsl(var(--status-info-bg));
  --color-status-info-border: hsl(var(--status-info-border));
  --color-status-info-fg: hsl(var(--status-info-fg));
  --color-status-pending: hsl(var(--status-pending));
  --color-status-pending-bg: hsl(var(--status-pending-bg));
  --color-status-pending-fg: hsl(var(--status-pending-fg));
}
```

#### 1b. Message Color Tokens

```css
:root {
  /* --user-msg already exists: 0 0% 91%; */
  --msg-assistant-bg: transparent;
  --msg-system-bg: 0 0% 96%;
  --msg-command-fg: var(--muted-foreground);
  --msg-compaction-fg: 0 0% 32%;
}

.dark {
  /* --user-msg already exists: 0 0% 15%; */
  --msg-assistant-bg: transparent;
  --msg-system-bg: 0 0% 9%;
  --msg-command-fg: var(--muted-foreground);
  --msg-compaction-fg: 0 0% 64%;
}
```

#### 1c. Typography Tokens

```css
:root {
  --msg-user-font-weight: 400;
  --msg-user-line-height: 1.6;
  --msg-assistant-font-weight: 300;
  --msg-assistant-line-height: 1.75;
  --msg-timestamp-color: hsl(var(--muted-foreground) / 0.6);
}
```

#### 1d. Spacing Tokens (Density-Aware)

```css
:root {
  --msg-padding-x: 1rem;
  --msg-padding-y-start: 1rem;
  --msg-padding-y-mid: 0.125rem;
  --msg-padding-y-end: 0.75rem;
  --msg-gap: 0.75rem;
  --msg-leading-width: 1rem;
  --msg-content-max-width: 80ch;
}
```

#### 1e. Shape Tokens

```css
:root {
  --msg-radius: 0;
  --msg-tool-radius: var(--radius);
  --msg-divider-color: hsl(var(--border) / 0.2);
}
```

#### 1f. Motion Tokens

```css
:root {
  --msg-enter-y: 8px;
  --msg-enter-scale-user: 0.97;
  --msg-enter-stiffness: 320;
  --msg-enter-damping: 28;
  --msg-tool-expand-duration: 300ms;
  --msg-tool-expand-easing: cubic-bezier(0.4, 0, 0.2, 1);
}
```

#### 1g. Interactive State Tokens

```css
:root {
  --msg-hover-user: hsl(var(--user-msg) / 0.9);
  --msg-hover-assistant: hsl(var(--muted) / 0.2);
  --msg-actions-opacity-default: 0;
  --msg-actions-opacity-hover: 1;
}
```

#### 1h. Elevation Tokens

```css
:root {
  --msg-tool-shadow: none;
  --msg-tool-shadow-hover: 0 1px 3px hsl(0 0% 0% / 0.08);
  --msg-tool-border: hsl(var(--border) / 0.6);
}

.dark {
  --msg-tool-shadow-hover: 0 1px 3px hsl(0 0% 0% / 0.3);
}
```

### 2. MessageContext

A React Context that provides shared values to all message sub-components, eliminating prop drilling.

**File:** `features/chat/ui/message/MessageContext.tsx`

```typescript
import { createContext, useContext, useMemo } from 'react';
import type { InteractiveToolHandle } from './types';

interface MessageContextValue {
  sessionId: string;
  isStreaming: boolean;
  activeToolCallId: string | null;
  onToolRef: ((handle: InteractiveToolHandle | null) => void) | undefined;
  focusedOptionIndex: number;
  onToolDecided: ((toolCallId: string) => void) | undefined;
}

const MessageCtx = createContext<MessageContextValue | null>(null);

export function MessageProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: MessageContextValue;
}) {
  const memoized = useMemo(() => value, [
    value.sessionId,
    value.isStreaming,
    value.activeToolCallId,
    value.onToolRef,
    value.focusedOptionIndex,
    value.onToolDecided,
  ]);
  return <MessageCtx value={memoized}>{children}</MessageCtx>;
}

export function useMessageContext(): MessageContextValue {
  const ctx = useContext(MessageCtx);
  if (!ctx) throw new Error('useMessageContext must be used within MessageProvider');
  return ctx;
}
```

The `useMemo` dependency array lists individual fields to prevent re-renders when the parent re-creates the value object but the individual fields haven't changed.

### 3. Tailwind-Variants Message Definitions

**File:** `features/chat/ui/message/message-variants.ts`

```typescript
import { tv } from 'tailwind-variants';

export const messageItem = tv({
  slots: {
    root: 'group relative flex gap-[var(--msg-gap)] px-[var(--msg-padding-x)] transition-colors duration-150',
    leading: 'mt-[3px] w-[var(--msg-leading-width)] flex-shrink-0',
    content: 'max-w-[var(--msg-content-max-width)] min-w-0 flex-1 text-sm',
    timestamp: 'absolute top-1 right-4 hidden text-xs transition-colors duration-150 sm:inline',
    divider: 'absolute inset-x-0 top-0 h-px bg-[var(--msg-divider-color)]',
  },
  variants: {
    role: {
      user: {
        root: 'bg-user-msg hover:bg-user-msg/90',
        content: 'font-[var(--msg-user-font-weight)]',
      },
      assistant: {
        root: 'hover:bg-muted/20',
        content: 'font-[var(--msg-assistant-font-weight)]',
      },
    },
    position: {
      first: { root: 'pt-[var(--msg-padding-y-start)] pb-[var(--msg-padding-y-mid)]' },
      middle: { root: 'pt-[var(--msg-padding-y-mid)] pb-[var(--msg-padding-y-mid)]' },
      last: { root: 'pt-[var(--msg-padding-y-mid)] pb-[var(--msg-padding-y-end)]' },
      only: { root: 'pt-[var(--msg-padding-y-start)] pb-[var(--msg-padding-y-end)]' },
    },
    density: {
      comfortable: {},
      compact: {
        root: 'px-3',
        content: 'text-xs',
      },
    },
  },
  defaultVariants: {
    role: 'assistant',
    position: 'only',
    density: 'comfortable',
  },
});

export const toolStatus = tv({
  variants: {
    status: {
      pending: 'text-status-pending',
      running: 'text-status-info',
      complete: 'text-status-success',
      error: 'text-status-error',
    },
  },
});

export const approvalState = tv({
  variants: {
    state: {
      pending: 'border-status-warning-border bg-status-warning-bg',
      approved: 'border-status-success-border bg-status-success-bg text-status-success-fg',
      denied: 'border-status-error-border bg-status-error-bg text-status-error-fg',
    },
  },
});
```

### 4. Sub-Component Decomposition

#### File Structure

```
features/chat/ui/message/
├── index.ts                    # Barrel: exports MessageItem + InteractiveToolHandle type
├── MessageContext.tsx           # React Context provider + useMessageContext hook
├── MessageItem.tsx             # Orchestrator (~80 lines)
├── message-variants.ts         # tv() definitions (messageItem, toolStatus, approvalState)
├── UserMessageContent.tsx      # Plain/command/compaction rendering
├── AssistantMessageContent.tsx # Parts mapping + AutoHideToolCall
└── types.ts                    # Shared types (InteractiveToolHandle)
```

The original `features/chat/ui/MessageItem.tsx` is **replaced** by a thin re-export from the barrel:

```typescript
// features/chat/ui/MessageItem.tsx — backward compatibility re-export
export { MessageItem } from './message/index';
export type { InteractiveToolHandle } from './message/index';
```

This preserves all existing imports (MessageList, tests, etc.) without modification.

#### MessageItem Orchestrator

**File:** `features/chat/ui/message/MessageItem.tsx`

The orchestrator reads grouping, role, and store settings, then delegates rendering to sub-components. It provides `MessageContext` to all children.

```typescript
import { motion } from 'motion/react';
import { ChevronRight } from 'lucide-react';
import type { ChatMessage, MessageGrouping } from '../../model/use-chat-session';
import { useAppStore } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { messageItem } from './message-variants';
import { MessageProvider } from './MessageContext';
import { UserMessageContent } from './UserMessageContent';
import { AssistantMessageContent } from './AssistantMessageContent';
import type { InteractiveToolHandle } from './types';

interface MessageItemProps {
  message: ChatMessage;
  grouping: MessageGrouping;
  sessionId: string;
  isNew?: boolean;
  isStreaming?: boolean;
  activeToolCallId?: string | null;
  onToolRef?: (handle: InteractiveToolHandle | null) => void;
  focusedOptionIndex?: number;
  onToolDecided?: (toolCallId: string) => void;
}

function formatTime(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function MessageItem({
  message,
  grouping,
  sessionId,
  isNew = false,
  isStreaming = false,
  activeToolCallId = null,
  onToolRef,
  focusedOptionIndex = -1,
  onToolDecided,
}: MessageItemProps) {
  const isUser = message.role === 'user';
  const { showTimestamps } = useAppStore();
  const { position, groupIndex } = grouping;
  const showIndicator = position === 'only' || position === 'first';
  const isGroupStart = position === 'only' || position === 'first';

  const styles = messageItem({
    role: isUser ? 'user' : 'assistant',
    position,
  });

  return (
    <MessageProvider
      value={{ sessionId, isStreaming, activeToolCallId, onToolRef, focusedOptionIndex, onToolDecided }}
    >
      <motion.div
        initial={isNew ? { opacity: 0, y: 8, scale: isUser ? 0.97 : 1 } : false}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 320, damping: 28 }}
        data-testid="message-item"
        data-role={message.role}
        className={styles.root()}
      >
        {isGroupStart && groupIndex > 0 && <div className={styles.divider()} />}
        {message.timestamp && (
          <span
            className={cn(
              styles.timestamp(),
              showTimestamps
                ? 'text-muted-foreground/60'
                : 'text-muted-foreground/0 group-hover:text-muted-foreground/60'
            )}
          >
            {formatTime(message.timestamp)}
          </span>
        )}
        <div className={styles.leading()}>
          {showIndicator &&
            (isUser ? (
              <ChevronRight className="text-muted-foreground size-(--size-icon-md)" />
            ) : (
              <span className="text-muted-foreground flex size-(--size-icon-md) items-center justify-center text-[10px]">
                ●
              </span>
            ))}
        </div>
        <div className={styles.content()}>
          {isUser ? (
            <UserMessageContent message={message} />
          ) : (
            <AssistantMessageContent message={message} />
          )}
        </div>
      </motion.div>
    </MessageProvider>
  );
}
```

#### UserMessageContent

**File:** `features/chat/ui/message/UserMessageContent.tsx`

Handles the 3 user message sub-types. Owns `compactionExpanded` state locally.

```typescript
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ChatMessage } from '../../model/use-chat-session';
import { cn } from '@/layers/shared/lib';

export function UserMessageContent({ message }: { message: ChatMessage }) {
  const [compactionExpanded, setCompactionExpanded] = useState(false);

  if (message.messageType === 'command') {
    return (
      <div className="text-muted-foreground truncate font-mono text-sm">
        {message.content}
      </div>
    );
  }

  if (message.messageType === 'compaction') {
    return (
      <div className="w-full">
        <button
          onClick={() => setCompactionExpanded(!compactionExpanded)}
          className="text-muted-foreground/60 hover:text-muted-foreground flex w-full items-center gap-2 text-xs transition-colors"
        >
          <div className="bg-border/40 h-px flex-1" />
          <ChevronRight
            className={cn(
              'size-3 transition-transform duration-200',
              compactionExpanded && 'rotate-90'
            )}
          />
          <span>Context compacted</span>
          <div className="bg-border/40 h-px flex-1" />
        </button>
        {compactionExpanded && (
          <div className="text-muted-foreground/60 mt-2 text-xs whitespace-pre-wrap">
            {message.content}
          </div>
        )}
      </div>
    );
  }

  return <div className="break-words whitespace-pre-wrap">{message.content}</div>;
}
```

#### AssistantMessageContent

**File:** `features/chat/ui/message/AssistantMessageContent.tsx`

Maps over `parts` and renders each part type. Contains `AutoHideToolCall` (moved from MessageItem) and the `useToolCallVisibility` hook. Uses `useMessageContext()` for `sessionId`, `activeToolCallId`, etc.

```typescript
import { useRef, useState, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { ChatMessage } from '../../model/use-chat-session';
import { useAppStore } from '@/layers/shared/model';
import { TIMING } from '@/layers/shared/lib';
import { StreamingText } from '../StreamingText';
import { ToolCallCard } from '../ToolCallCard';
import { ToolApproval } from '../ToolApproval';
import type { ToolApprovalHandle } from '../ToolApproval';
import { QuestionPrompt } from '../QuestionPrompt';
import type { QuestionPromptHandle } from '../QuestionPrompt';
import { useMessageContext } from './MessageContext';

function useToolCallVisibility(status: string, autoHide: boolean): boolean {
  const initialStatusRef = useRef(status);
  const [visible, setVisible] = useState(!(autoHide && initialStatusRef.current === 'complete'));

  useEffect(() => {
    if (autoHide && status === 'complete' && initialStatusRef.current !== 'complete') {
      const timer = setTimeout(() => setVisible(false), TIMING.TOOL_CALL_AUTO_HIDE_MS);
      return () => clearTimeout(timer);
    }
  }, [status, autoHide]);

  if (!autoHide) return true;
  return visible;
}

function AutoHideToolCall({
  part,
  autoHide,
  expandToolCalls,
}: {
  part: {
    toolCallId: string;
    toolName: string;
    input?: string;
    result?: string;
    status: 'pending' | 'running' | 'complete' | 'error';
  };
  autoHide: boolean;
  expandToolCalls: boolean;
}) {
  const visible = useToolCallVisibility(part.status, autoHide);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key={part.toolCallId}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
          className="overflow-hidden"
        >
          <ToolCallCard
            toolCall={{
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input || '',
              result: part.result,
              status: part.status,
            }}
            defaultExpanded={expandToolCalls}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function AssistantMessageContent({ message }: { message: ChatMessage }) {
  const { sessionId, isStreaming, activeToolCallId, onToolRef, focusedOptionIndex, onToolDecided } =
    useMessageContext();
  const { expandToolCalls, autoHideToolCalls } = useAppStore();
  const parts = message.parts ?? [];

  const approvalRefCallback = useCallback(
    (handle: ToolApprovalHandle | null) => { onToolRef?.(handle); },
    [onToolRef]
  );
  const questionRefCallback = useCallback(
    (handle: QuestionPromptHandle | null) => { onToolRef?.(handle); },
    [onToolRef]
  );

  // Find the last text part for streaming cursor placement
  let lastTextPartIndex = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].type === 'text') {
      lastTextPartIndex = i;
      break;
    }
  }

  return (
    <>
      {parts.map((part, i) => {
        if (part.type === 'text') {
          return (
            <div key={`text-${i}`} className="msg-assistant">
              <StreamingText
                content={part.text}
                isStreaming={isStreaming && i === lastTextPartIndex}
              />
            </div>
          );
        }
        if (part.interactiveType === 'approval') {
          const isActive = part.toolCallId === activeToolCallId;
          return (
            <ToolApproval
              key={part.toolCallId}
              ref={isActive ? approvalRefCallback : undefined}
              sessionId={sessionId}
              toolCallId={part.toolCallId}
              toolName={part.toolName}
              input={part.input || ''}
              isActive={isActive}
              onDecided={onToolDecided ? () => onToolDecided(part.toolCallId) : undefined}
            />
          );
        }
        if (part.interactiveType === 'question' && part.questions) {
          const isActive = part.toolCallId === activeToolCallId;
          return (
            <QuestionPrompt
              key={part.toolCallId}
              ref={isActive ? questionRefCallback : undefined}
              sessionId={sessionId}
              toolCallId={part.toolCallId}
              questions={part.questions}
              answers={part.answers}
              isActive={isActive}
              focusedOptionIndex={isActive ? focusedOptionIndex : -1}
            />
          );
        }
        return (
          <AutoHideToolCall
            key={part.toolCallId}
            part={part}
            autoHide={autoHideToolCalls}
            expandToolCalls={expandToolCalls}
          />
        );
      })}
    </>
  );
}
```

#### Types

**File:** `features/chat/ui/message/types.ts`

```typescript
import type { ToolApprovalHandle } from '../ToolApproval';
import type { QuestionPromptHandle } from '../QuestionPrompt';

export type InteractiveToolHandle = ToolApprovalHandle | QuestionPromptHandle;
```

#### Barrel

**File:** `features/chat/ui/message/index.ts`

```typescript
/**
 * Message sub-component module — internal decomposition of MessageItem.
 *
 * @module features/chat/ui/message
 */
export { MessageItem } from './MessageItem';
export type { InteractiveToolHandle } from './types';
```

### 5. Status Token Migration in ToolCallCard

Replace hardcoded status colors with semantic tokens:

```typescript
// Before:
const statusIcon = {
  pending: <Loader2 className="size-(--size-icon-xs) animate-spin" />,
  running: <Loader2 className="size-(--size-icon-xs) animate-spin text-blue-500" />,
  complete: <Check className="size-(--size-icon-xs) text-green-500" />,
  error: <X className="size-(--size-icon-xs) text-red-500" />,
};

// After:
import { toolStatus } from './message/message-variants';

const statusIcon = {
  pending: <Loader2 className={cn('size-(--size-icon-xs) animate-spin', toolStatus({ status: 'pending' }))} />,
  running: <Loader2 className={cn('size-(--size-icon-xs) animate-spin', toolStatus({ status: 'running' }))} />,
  complete: <Check className={cn('size-(--size-icon-xs)', toolStatus({ status: 'complete' }))} />,
  error: <X className={cn('size-(--size-icon-xs)', toolStatus({ status: 'error' }))} />,
};
```

### 6. Status Token Migration in ToolApproval

Replace hardcoded state colors with semantic tokens:

```typescript
// Before (decided state):
decided === 'approved'
  ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  : 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400'

// After:
import { approvalState } from './message/message-variants';

// Decided rendering:
<div className={cn(
  'my-1 rounded border px-3 py-2 text-sm transition-colors duration-200',
  approvalState({ state: decided })
)} />

// Before (pending state):
'border-amber-500/20 bg-amber-500/10'
isActive && 'ring-2 ring-amber-500/30'

// After:
cn(
  'my-1 rounded border p-3 text-sm transition-all duration-200',
  approvalState({ state: 'pending' }),
  isActive && 'ring-2 ring-status-warning/30'
)

// Before (buttons):
'bg-emerald-600 hover:bg-emerald-700' → 'bg-status-success hover:bg-status-success/90'
'bg-red-600 hover:bg-red-700' → 'bg-status-error hover:bg-status-error/90'
```

Additionally, `ToolApproval` should migrate from `forwardRef` to React 19 ref-as-prop:

```typescript
// Before:
export const ToolApproval = forwardRef<ToolApprovalHandle, ToolApprovalProps>(...)

// After:
export function ToolApproval({ ref, ...props }: ToolApprovalProps & { ref?: React.Ref<ToolApprovalHandle> }) {
  useImperativeHandle(ref, () => ({ approve: handleApprove, deny: handleDeny }), [...]);
  ...
}
```

### 7. Obsidian Theme Bridge

The Obsidian `.copilot-view-content` theme bridge in `index.css` must be updated to map status tokens. Since Obsidian uses raw color values (not HSL triplets), add direct `--color-status-*` overrides:

```css
.copilot-view-content {
  /* existing mappings... */
  --color-status-success: #16a34a;
  --color-status-success-bg: rgba(22, 163, 74, 0.1);
  --color-status-success-border: rgba(22, 163, 74, 0.2);
  --color-status-success-fg: #16a34a;
  --color-status-error: #dc2626;
  --color-status-error-bg: rgba(220, 38, 38, 0.1);
  --color-status-error-border: rgba(220, 38, 38, 0.2);
  --color-status-error-fg: #dc2626;
  --color-status-warning: #f59e0b;
  --color-status-warning-bg: rgba(245, 158, 11, 0.1);
  --color-status-warning-border: rgba(245, 158, 11, 0.2);
  --color-status-warning-fg: #f59e0b;
  --color-status-info: #3b82f6;
  --color-status-info-bg: rgba(59, 130, 246, 0.1);
  --color-status-info-border: rgba(59, 130, 246, 0.2);
  --color-status-info-fg: #3b82f6;
  --color-status-pending: #737373;
  --color-status-pending-bg: rgba(115, 115, 115, 0.1);
  --color-status-pending-fg: #737373;
}
```

## User Experience

No user-visible changes. The refactoring is entirely internal:

- Same visual appearance in both light and dark modes
- Same animations and transitions
- Same tool approval/deny flow
- Same auto-hide behavior
- Same keyboard shortcuts (Enter/Escape for tool decisions)
- Same virtualizer scroll behavior

## Testing Strategy

### Unit Tests

**MessageItem tests** (`__tests__/MessageItem.test.tsx`): All 20 existing tests must continue passing. Test updates required:

1. **Mock path update**: `vi.mock('../ToolApproval', ...)` becomes `vi.mock('../message/AssistantMessageContent', ...)` OR the existing mock path continues to work because `ToolApproval` and `QuestionPrompt` are still imported from their original locations. Verify mock resolution.

2. **Class selector updates**: Tests that query by class (e.g., `container.querySelector('.max-w-\\[80ch\\]')`) may need updates if TV generates different class names. Prefer `data-testid` selectors over class-based queries.

3. **New tests to add**:
   - `MessageContext` provides values to sub-components
   - `UserMessageContent` renders all 3 sub-types correctly
   - `AssistantMessageContent` renders text, tool call, approval, and question parts
   - TV variant classes are applied correctly for each role/position combination
   - Status token classes appear on tool call status icons

**ToolCallCard tests** (`__tests__/ToolCallCard.test.tsx`): Update assertions that check for `text-blue-500`, `text-green-500`, `text-red-500` to check for `text-status-info`, `text-status-success`, `text-status-error`.

**ToolApproval tests** (`__tests__/ToolApproval.test.tsx`): Update assertions for `border-emerald-500/20`, `bg-red-500/10`, etc. to use `bg-status-*` / `border-status-*` selectors.

### Integration Tests

- Verify virtualizer measurement is unchanged by rendering `MessageList` with 100+ messages
- Verify streaming cursor still appears on the last text part during streaming

### Mocking Strategy

- `motion/react` mock (existing) — renders `motion.div` as plain `div`
- `streamdown` mock (existing) — renders children as plain text
- `ToolApproval` and `QuestionPrompt` mocks (existing) — simplified UI for unit tests
- `tailwind-variants` — no mock needed, it returns class strings synchronously

## Performance Considerations

- **Bundle size**: `tailwind-variants` adds ~3.5KB min+gzip. Acceptable for the DX improvement.
- **Virtualizer**: The outermost `motion.div` remains the `measureElement` target. Sub-component extraction does not change the DOM structure visible to the virtualizer. The `data-testid="message-item"` attribute stays on the root element.
- **Context re-renders**: `MessageProvider` memoizes its value object to prevent re-rendering sub-components when parent state changes for unrelated reasons.
- **TV class computation**: `tv()` calls are invoked per-render but are lightweight string operations. No performance concern at message scale.

## Security Considerations

No security implications. This is a pure client-side refactoring of styling and component structure. No new data flows, no new API calls, no user input handling changes.

## Documentation

Update the following files after implementation:

- **`contributing/design-system.md`**: Add Status Tokens section documenting `--status-*` token names and usage. Update Message component section to reference TV variants.
- **`contributing/styling-theming.md`**: Add section on tailwind-variants usage alongside CVA. Document when to use TV (multi-slot) vs CVA (single-element).
- **`AGENTS.md`**: Update the client FSD layer table to include `features/chat/ui/message/` sub-module.

## Implementation Phases

### Phase 1: Token Expansion (CSS only)

**Files modified:** `apps/client/src/index.css`

Add all 7 categories of semantic tokens (Sections 1a-1h) to `:root`, `.dark`, `@theme inline`, and `.copilot-view-content`. No component changes.

**Verification:** Visual regression check — no UI changes should be visible. Tokens exist but are not yet consumed.

### Phase 2: MessageContext Extraction

**Files created:**

- `features/chat/ui/message/MessageContext.tsx`
- `features/chat/ui/message/types.ts`

**Files modified:** `features/chat/ui/MessageItem.tsx` — wrap content in `MessageProvider`, but keep all rendering inline for now. Sub-components don't exist yet; context is provided but consumed by the same file.

**Verification:** All existing tests pass. No visual changes.

### Phase 3: Tailwind-Variants Migration

**Files created:**

- `features/chat/ui/message/message-variants.ts`

**Files modified:**

- `features/chat/ui/MessageItem.tsx` — replace inline `cn()` conditionals with `messageItem()` TV call
- `features/chat/ui/ToolCallCard.tsx` — replace hardcoded status colors with `toolStatus()` TV call
- `features/chat/ui/ToolApproval.tsx` — replace hardcoded state colors with `approvalState()` TV call; migrate from `forwardRef` to ref-as-prop

**New dependency:** `pnpm --filter=@dorkos/client add tailwind-variants`

**Verification:** All tests pass. Visual comparison confirms identical rendering.

### Phase 4: Sub-Component Decomposition

**Files created:**

- `features/chat/ui/message/MessageItem.tsx` (orchestrator)
- `features/chat/ui/message/UserMessageContent.tsx`
- `features/chat/ui/message/AssistantMessageContent.tsx`
- `features/chat/ui/message/index.ts` (barrel)

**Files modified:**

- `features/chat/ui/MessageItem.tsx` — becomes re-export shim
- `features/chat/__tests__/MessageItem.test.tsx` — update mock paths if needed, add sub-component tests

**Verification:** All tests pass. Virtualizer scroll behavior is identical.

## Open Questions

1. ~~**TV `responsiveVariants` for mobile density**~~ (RESOLVED)
   **Answer:** Zustand store only
   **Rationale:** Consistent with existing patterns (expandToolCalls, autoHideToolCalls). User controls density via settings. Mobile can default to compact via store initialization if desired.

2. ~~**`approvalState` active ring color**~~ (RESOLVED)
   **Answer:** Use `ring-status-warning/30` (reuse the status-warning token)
   **Rationale:** Fewer tokens, conceptually correct (approval pending = warning state). No need for a separate `--status-active-ring` token.

## Related ADRs

- **ADR-0005**: Zustand for UI state, TanStack Query for server state — `showTimestamps`, `expandToolCalls`, `autoHideToolCalls` remain in Zustand
- **ADR-0006**: Adopt sonner for toast notifications — no impact, toast not used in message components

## References

- [Tailwind Variants Slots Documentation](https://www.tailwind-variants.org/docs/slots)
- [Nuxt UI ChatMessage](https://ui.nuxt.com/docs/components/chat-message) — slot-based role variant pattern
- [Stream Chat React Components](https://getstream.io/chat/docs/sdk/react/components/message-components/ui-components/) — Context + building blocks pattern
- [CVA vs Tailwind Variants comparison](https://dev.to/webdevlapani/cva-vs-tailwind-variants-choosing-the-right-tool-for-your-design-system-12am)
- specs/chat-message-theming/01-ideation.md
- research/20260309_chat_message_theming_architecture.md
- contributing/design-system.md
- contributing/styling-theming.md
