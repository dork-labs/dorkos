import { useState } from 'react';
import {
  IdentityAvatar,
  TooltipProvider,
  statusDotClass,
  STATUS_DOT_LABEL,
  type StatusSignal,
} from '@/layers/shared/ui';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { UsageStatus } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';
import { AgentActivityBadge } from '@/layers/features/dashboard-sidebar';
import { ErrorMessageBlock, StreamingText, TaskListPanel } from '@/layers/features/chat';
import { ContextItem, UsageRevealPopover, UsageStatusItem } from '@/layers/features/status';
import { Button } from '@/layers/shared/ui';
import type { TransportErrorInfo } from '@/layers/features/chat/model/chat-types';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { SAMPLE_TASKS } from '../mock-chat-data';
import { MOCK_ACCOUNT_USAGE } from './account-mock-data';
import { IDENTITY_STATUSES, SAMPLE_LONG_PLAN } from '../mock-samples';

/** A fixed "three hours from now", picked once at import: a showcase reads the clock nowhere near a render. */
const SHOWCASE_RESETS_AT = new Date(Date.now() + 3 * 3600 * 1000).toISOString();

/** A reading `minutes` before the page loaded. */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/**
 * Acct 1 of {@link MOCK_ACCOUNT_USAGE}: 5-hour 40%, weekly 72%. The status bar
 * shows its most-used window, the week.
 */
const ACCT_1 = MOCK_ACCOUNT_USAGE[0]!;
const ACCT_1_WEEK = ACCT_1.windows.find((entry) => entry.key === 'seven_day')!;

/** Acct 1's reading as the usage item draws it (`accountUsageToStatus`). */
const ACCOUNT_READING: UsageStatus = {
  kind: 'subscription',
  utilization: ACCT_1_WEEK.usedPct! / 100,
  windowLabel: ACCT_1_WEEK.label,
  resetsAt: ACCT_1_WEEK.resetsAt ?? undefined,
  state: 'ok',
};

/** Acct 1 after its 5-hour window reset: the server reads it at 0%, `expired`. */
const ACCT_1_FIVE_HOUR_RESET: AccountUsage = {
  ...ACCT_1,
  windows: ACCT_1.windows.map((entry) =>
    entry.key === 'five_hour'
      ? { ...entry, usedPct: 0, status: null, expired: true, observedAt: minutesAgo(12) }
      : { ...entry, observedAt: minutesAgo(12) }
  ),
};

/** A session's own context reading, as a reopened session carries it. */
function contextReading(observedAt: string, totalTokens = 62_000) {
  return {
    totalTokens,
    maxTokens: 200_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    observedAt,
  };
}

/** The `/context` reveal, opened by a button rather than the slash command. */
function RevealDemo({ usage, label }: { usage: AccountUsage; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
        {label}
      </Button>
      <UsageRevealPopover
        usage={ACCOUNT_READING}
        accountUsage={usage}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}

/** What each dot signal means, in the words the app uses for it. */
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
      message: 'Couldn’t reach the server. Check your network and try again.',
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
        description="One dot vocabulary, four surfaces. Green means a turn is streaming as you look at it and is the only signal that ever moves; amber means something is waiting on you; red means something broke; blue means output you have not read. Idle draws nothing at all — a surface where every row wears a dot has no signal left in it. Every colour here is a theme token from one map, which is what stopped the same green being bg-green-500 in the sidebar, bg-emerald-500 in an agent panel and bg-primary in a group header."
      >
        <ShowcaseLabel>The vocabulary — colour, and which one moves</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap items-center gap-6">
            {SIGNALS.map(({ signal, means }) => (
              <div key={signal} className="flex items-center gap-2">
                <span className={cn('size-1.5 shrink-0 rounded-full', statusDotClass(signal))} />
                <span className="text-muted-foreground text-2xs">{means}</span>
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
                <span className="text-muted-foreground text-3xs">{label}</span>
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
                <span className="text-muted-foreground text-2xs">
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
                <span className="text-muted-foreground text-2xs">{kind}</span>
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
          <StreamingText content="Working on it…" isStreaming />
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

          <ShowcaseLabel>
            {'Cached on open — the account’s reading before any turn; hover for “as of 12 min ago”'}
          </ShowcaseLabel>
          <ShowcaseDemo>
            <span className="text-muted-foreground text-xs">
              <UsageStatusItem usage={ACCOUNT_READING} observedAt={minutesAgo(12)} />
            </span>
          </ShowcaseDemo>

          <ShowcaseLabel>Fresh — a reading under a minute old reads “just now”</ShowcaseLabel>
          <ShowcaseDemo>
            <span className="text-muted-foreground text-xs">
              <UsageStatusItem usage={ACCOUNT_READING} observedAt={minutesAgo(0)} />
            </span>
          </ShowcaseDemo>

          <ShowcaseLabel>Stale — older than an hour: the number dims, “as of 2h ago”</ShowcaseLabel>
          <ShowcaseDemo>
            <span className="text-muted-foreground text-xs">
              <UsageStatusItem usage={ACCOUNT_READING} observedAt={minutesAgo(125)} />
            </span>
          </ShowcaseDemo>

          <ShowcaseLabel>
            Stale near a limit — the amber number dims, the gauge stays amber
          </ShowcaseLabel>
          <ShowcaseDemo>
            <span className="text-muted-foreground text-xs">
              <UsageStatusItem
                usage={{ ...ACCOUNT_READING, utilization: 0.91, state: 'warning' }}
                observedAt={minutesAgo(125)}
              />
            </span>
          </ShowcaseDemo>

          <ShowcaseLabel>
            The /context reveal — every window as a bar; the 5-hour window reset, so it reads
            “reset”
          </ShowcaseLabel>
          <ShowcaseDemo>
            <RevealDemo usage={ACCT_1_FIVE_HOUR_RESET} label="Open the usage reveal" />
          </ShowcaseDemo>
        </TooltipProvider>
      </PlaygroundSection>

      <PlaygroundSection
        title="ContextItem"
        description="How full the conversation window is. It shows whenever there is a reading, from the moment a session opens: a reopened session shows its last known context at once, and the tooltip says how fresh it is. It turns amber, then red, near the limit."
      >
        <TooltipProvider>
          <ShowcaseLabel>Cached on open — hover for “as of 12 min ago”</ShowcaseLabel>
          <ShowcaseDemo>
            <span className="text-muted-foreground text-xs">
              <ContextItem percent={31} reading={contextReading(minutesAgo(12))} />
            </span>
          </ShowcaseDemo>

          <ShowcaseLabel>Live — a reading under a minute old reads “just now”</ShowcaseLabel>
          <ShowcaseDemo>
            <span className="text-muted-foreground text-xs">
              <ContextItem percent={31} reading={contextReading(minutesAgo(0))} />
            </span>
          </ShowcaseDemo>

          <ShowcaseLabel>Near the limit — amber at 80%, still shown from open</ShowcaseLabel>
          <ShowcaseDemo>
            <span className="text-muted-foreground text-xs">
              <ContextItem percent={82} reading={contextReading(minutesAgo(125), 164_000)} />
            </span>
          </ShowcaseDemo>

          <ShowcaseLabel>
            An older server with no time on the reading — no freshness line
          </ShowcaseLabel>
          <ShowcaseDemo>
            <span className="text-muted-foreground text-xs">
              <ContextItem percent={31} />
            </span>
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

        <ShowcaseLabel>
          A ten-item plan scrolls inside itself, rather than pushing the conversation off screen
        </ShowcaseLabel>
        <ShowcaseDemo>
          <TaskListPanel
            tasks={SAMPLE_LONG_PLAN}
            taskMap={new Map(SAMPLE_LONG_PLAN.map((t) => [t.id, t]))}
            activeForm="Implementing authentication service"
            isCollapsed={false}
            onToggleCollapse={() => {}}
            statusTimestamps={new Map()}
          />
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
