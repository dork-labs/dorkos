import { useState } from 'react';
import {
  IdentityAvatar,
  TooltipProvider,
  statusDotClass,
  STATUS_DOT_LABEL,
  type StatusSignal,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { AgentActivityBadge } from '@/layers/features/dashboard-sidebar';
import { StreamingText } from '@/layers/features/chat/ui/message/StreamingText';
import { ErrorMessageBlock } from '@/layers/features/chat/ui/message/ErrorMessageBlock';
import { UsageStatusItem } from '@/layers/features/status';
import { TaskListPanel } from '@/layers/features/chat/ui/tasks/TaskListPanel';
import type { TransportErrorInfo } from '@/layers/features/chat/model/chat-types';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { SAMPLE_TASKS } from '../mock-chat-data';
import { IDENTITY_STATUSES } from '../mock-samples';

/** A fixed "three hours from now", picked once at import: a showcase reads the clock nowhere near a render. */
const SHOWCASE_RESETS_AT = new Date(Date.now() + 3 * 3600 * 1000).toISOString();

/** What each dot signal means, in the words the cockpit uses for it. */
const SIGNALS: readonly { signal: StatusSignal; means: string }[] = [
  { signal: 'working', means: 'working — a turn is streaming right now' },
  { signal: 'needs-you', means: 'needs you — approval or a question' },
  { signal: 'error', means: 'error — the last turn failed' },
  { signal: 'unseen', means: 'unseen — output you have not read' },
];

/**
 * The four transport-error states ChatPanel can hand to `ErrorMessageBlock`
 * (`apps/client/src/layers/features/chat/ui/ChatPanel.tsx`), which renders it
 * with `heading`/`message` from `TransportErrorInfo` and no `category` — the
 * same shape used here.
 */
const TRANSPORT_ERRORS: readonly { label: string; error: TransportErrorInfo }[] = [
  {
    label: "Can't reach DorkOS (retryable)",
    error: {
      heading: "Can't reach DorkOS",
      message: 'Could not reach the server. Check your network and try again.',
      retryable: true,
    },
  },
  {
    label: 'Server error (retryable)',
    error: {
      heading: 'Server error',
      message: 'The server encountered an error. Try again.',
      retryable: true,
    },
  },
  {
    label: 'Request timed out (retryable)',
    error: {
      heading: 'Request timed out',
      message: 'The server took too long to respond. Try again.',
      retryable: true,
    },
  },
  {
    label: 'Unknown error (not retryable)',
    error: {
      heading: 'Error',
      message: 'An unexpected error occurred.',
      retryable: false,
    },
  },
];

const SHORT_TEXT = 'The refactoring is complete. All tests pass.';

const MARKDOWN_TEXT = `Here's what I found in the codebase:

1. The auth module uses session-based authentication
2. Token refresh logic is missing
3. The middleware needs updating

\`\`\`typescript
export function verifyToken(token: string): JWTPayload {
  return jwt.verify(token, process.env.JWT_SECRET!) as JWTPayload;
}
\`\`\`

I'll update the implementation next.`;

const CODE_BLOCK_TEXT = `\`\`\`bash
npm install jsonwebtoken @types/jsonwebtoken
npm run test -- --watch
\`\`\``;

/** Status-related component showcases: StreamingText, ErrorMessageBlock (transport error), TaskListPanel. */
export function StatusShowcases() {
  const [taskCollapsed, setTaskCollapsed] = useState(false);
  const [taskCollapsed2, setTaskCollapsed2] = useState(true);

  return (
    <>
      <PlaygroundSection
        title="Live status dots"
        description="One dot vocabulary, four surfaces. Green means a turn is streaming as you look at it and is the only signal that ever moves; amber means something is waiting on you; red means something broke; blue means output you have not read. Idle draws nothing at all — a cockpit where every row wears a dot has no signal left in it. Every colour here is a theme token from one map, which is what stopped the same green being bg-green-500 in the sidebar, bg-emerald-500 in an agent panel and bg-primary in a group header."
      >
        <ShowcaseLabel>The vocabulary — colour, and which one moves</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap items-center gap-6">
            {SIGNALS.map(({ signal, means }) => (
              <div key={signal} className="flex items-center gap-2">
                <span className={cn('size-1.5 shrink-0 rounded-full', statusDotClass(signal))} />
                <span className="text-muted-foreground text-[11px]">{means}</span>
              </div>
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>On an identity — the disc’s top-right corner</ShowcaseLabel>
        <ShowcaseDemo>
          {/* The same three states the row dots say, said on a face. The
              bottom-right corner is identity (the Bot mark) and never moves out
              of the way for them — that separation is the whole design. */}
          <div className="flex items-end gap-6">
            {IDENTITY_STATUSES.map(({ status, label }) => (
              <div key={status} className="flex flex-col items-center gap-2">
                <IdentityAvatar color="#6366f1" emoji="🔍" kind="agent" status={status} size="md" />
                <span className="text-muted-foreground text-[10px]">{label}</span>
              </div>
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>…and what each one says out loud (R2)</ShowcaseLabel>
        <ShowcaseDemo>
          {/* Colour is never the sole indicator. A dot is a non-text graphic
              whose whole content is a hue, so it carries its meaning as text
              too — the corner dot is the one mark on the disc that is NOT
              aria-hidden, unlike the identity badge below it, which only
              repeats what the surface around it already says. */}
          <div className="flex flex-wrap items-center gap-6">
            {SIGNALS.map(({ signal }) => (
              <div key={signal} className="flex items-center gap-2">
                <span className={cn('size-1.5 shrink-0 rounded-full', statusDotClass(signal))} />
                <span className="text-muted-foreground text-[11px]">
                  announced as “{STATUS_DOT_LABEL[signal]}”
                </span>
              </div>
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>On a row — the sidebar’s aggregate agent badge</ShowcaseLabel>
        <ShowcaseDemo>
          {/* The same map, reached through the same helper. A row dot and a
              corner dot for one fact used to be two different greens. */}
          <div className="flex flex-wrap items-center gap-6">
            {(['streaming', 'pendingApproval', 'error', 'unseen', 'idle'] as const).map((kind) => (
              <div key={kind} className="flex items-center gap-2">
                <AgentActivityBadge status={kind} label={kind} />
                <span className="text-muted-foreground text-[11px]">{kind}</span>
              </div>
            ))}
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="StreamingText"
        description="Markdown rendering with streaming cursor."
      >
        <ShowcaseLabel>Short text</ShowcaseLabel>
        <ShowcaseDemo>
          <StreamingText content={SHORT_TEXT} />
        </ShowcaseDemo>

        <ShowcaseLabel>Markdown with code block</ShowcaseLabel>
        <ShowcaseDemo>
          <StreamingText content={MARKDOWN_TEXT} />
        </ShowcaseDemo>

        <ShowcaseLabel>Code block only</ShowcaseLabel>
        <ShowcaseDemo>
          <StreamingText content={CODE_BLOCK_TEXT} />
        </ShowcaseDemo>

        <ShowcaseLabel>Streaming cursor active</ShowcaseLabel>
        <ShowcaseDemo>
          <StreamingText content="Working on it..." isStreaming />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="UsageStatusItem"
        description="Merged Usage & cost status item — utilization primary for a subscription, cost primary for pay-as-you-go, hidden when nothing is renderable."
      >
        <TooltipProvider>
          <ShowcaseLabel>Subscription — utilization primary (cost in tooltip)</ShowcaseLabel>
          <ShowcaseDemo>
            <UsageStatusItem
              usage={{
                kind: 'subscription',
                utilization: 0.47,
                windowLabel: '5-hour window',
                resetsAt: SHOWCASE_RESETS_AT,
                costUsd: 1.23,
                state: 'ok',
              }}
            />
          </ShowcaseDemo>

          <ShowcaseLabel>Subscription — warning (amber) with overage detail</ShowcaseLabel>
          <ShowcaseDemo>
            <UsageStatusItem
              usage={{
                kind: 'subscription',
                utilization: 0.85,
                windowLabel: '7-day Opus',
                state: 'warning',
                detail: 'Using overage capacity',
              }}
            />
          </ShowcaseDemo>

          <ShowcaseLabel>Subscription — exhausted (red)</ShowcaseLabel>
          <ShowcaseDemo>
            <UsageStatusItem
              usage={{
                kind: 'subscription',
                utilization: 1,
                windowLabel: '5-hour window',
                state: 'exhausted',
              }}
            />
          </ShowcaseDemo>

          <ShowcaseLabel>Subscription — no utilization yet (degrades to cost)</ShowcaseLabel>
          <ShowcaseDemo>
            <UsageStatusItem usage={{ kind: 'subscription', costUsd: 0.42 }} />
          </ShowcaseDemo>

          <ShowcaseLabel>Pay-as-you-go — cost primary (provider in tooltip)</ShowcaseLabel>
          <ShowcaseDemo>
            <UsageStatusItem
              usage={{ kind: 'pay-as-you-go', costUsd: 0.42, detail: 'anthropic/claude-opus-4-6' }}
            />
          </ShowcaseDemo>
        </TooltipProvider>
      </PlaygroundSection>

      <PlaygroundSection
        title="Transport error (ErrorMessageBlock)"
        description="ChatPanel's inline transport-error banner (network, server, timeout) — the same ErrorMessageBlock the message stream uses, fed heading/message straight from TransportErrorInfo with no category. Shown outside the message stream."
      >
        {TRANSPORT_ERRORS.map(({ label, error }) => (
          <div key={label}>
            <ShowcaseLabel>{label}</ShowcaseLabel>
            <ShowcaseDemo responsive>
              <ErrorMessageBlock
                heading={error.heading}
                message={error.message}
                onRetry={
                  error.retryable ? () => console.log('[Showcase] Retry clicked') : undefined
                }
              />
            </ShowcaseDemo>
          </div>
        ))}
      </PlaygroundSection>

      <PlaygroundSection
        title="TaskListPanel"
        description="Task progress panel with mixed statuses."
      >
        <ShowcaseLabel>Expanded</ShowcaseLabel>
        <ShowcaseDemo>
          <TaskListPanel
            tasks={SAMPLE_TASKS}
            taskMap={new Map(SAMPLE_TASKS.map((t) => [t.id, t]))}
            activeForm="Implementing authentication service"
            isCollapsed={taskCollapsed}
            onToggleCollapse={() => setTaskCollapsed((c) => !c)}
            statusTimestamps={new Map()}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Collapsed</ShowcaseLabel>
        <ShowcaseDemo>
          <TaskListPanel
            tasks={SAMPLE_TASKS}
            taskMap={new Map(SAMPLE_TASKS.map((t) => [t.id, t]))}
            activeForm="Implementing authentication service"
            isCollapsed={taskCollapsed2}
            onToggleCollapse={() => setTaskCollapsed2((c) => !c)}
            statusTimestamps={new Map()}
          />
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
