import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button, TooltipProvider } from '@/layers/shared/ui';
import { StreamingText } from '@/layers/features/chat/ui/message/StreamingText';
import { ChatStatusStrip } from '@/layers/features/chat/ui/status/ChatStatusStrip';
import { UsageStatusItem } from '@/layers/features/status';
import { TaskListPanel } from '@/layers/features/chat/ui/tasks/TaskListPanel';
import type { TransportErrorInfo } from '@/layers/features/chat/model/chat-types';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { SAMPLE_TASKS } from '../mock-chat-data';

/** Replica of the inline transport error banner from ChatPanel for showcase purposes. */
function TransportErrorBanner({
  error,
  onRetry,
}: {
  error: TransportErrorInfo;
  onRetry?: () => void;
}) {
  return (
    <div className="border-destructive/30 bg-destructive/5 flex items-start gap-3 rounded-lg border px-3 py-2">
      <AlertTriangle className="text-destructive mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-destructive text-sm font-medium">{error.heading}</p>
        <p className="text-muted-foreground text-sm">{error.message}</p>
      </div>
      {error.retryable && (
        <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0">
          Retry
        </Button>
      )}
    </div>
  );
}

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

/** Status-related component showcases: StreamingText, ChatStatusStrip, TransportErrorBanner, TaskListPanel. */
export function StatusShowcases() {
  const [taskCollapsed, setTaskCollapsed] = useState(false);
  const [taskCollapsed2, setTaskCollapsed2] = useState(true);

  // Stable timestamp computed once on mount via useState initializer (useMemo triggers react-hooks/purity)
  const [streamStart] = useState(() => Date.now());

  return (
    <>
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
        title="ChatStatusStrip"
        description="Unified status strip — one morphing container showing agent activity, system status, and completion summaries."
      >
        <ShowcaseLabel>Streaming (live timer + rotating verb)</ShowcaseLabel>
        <ShowcaseDemo>
          <ChatStatusStrip
            status="streaming"
            streamStartTime={streamStart}
            estimatedTokens={1250}
            systemStatus={null}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Waiting for approval</ShowcaseLabel>
        <ShowcaseDemo>
          <ChatStatusStrip
            status="streaming"
            streamStartTime={streamStart - 5000}
            estimatedTokens={800}
            isWaitingForUser
            waitingType="approval"
            systemStatus={null}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Waiting for question</ShowcaseLabel>
        <ShowcaseDemo>
          <ChatStatusStrip
            status="streaming"
            streamStartTime={streamStart - 3000}
            estimatedTokens={600}
            isWaitingForUser
            waitingType="question"
            systemStatus={null}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Rate limited (with countdown)</ShowcaseLabel>
        <ShowcaseDemo>
          <ChatStatusStrip
            status="streaming"
            streamStartTime={streamStart - 10000}
            estimatedTokens={400}
            isRateLimited
            rateLimitRetryAfter={42}
            systemStatus={null}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Rate limited (no duration)</ShowcaseLabel>
        <ShowcaseDemo>
          <ChatStatusStrip
            status="streaming"
            streamStartTime={streamStart - 10000}
            estimatedTokens={400}
            isRateLimited
            rateLimitRetryAfter={null}
            systemStatus={null}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>System message: compacting</ShowcaseLabel>
        <ShowcaseDemo>
          <ChatStatusStrip
            status="idle"
            streamStartTime={null}
            estimatedTokens={0}
            systemStatus={{ message: 'Compacting context...', status: null }}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>System message: permission change</ShowcaseLabel>
        <ShowcaseDemo>
          <ChatStatusStrip
            status="idle"
            streamStartTime={null}
            estimatedTokens={0}
            systemStatus={{ message: 'Permission mode changed to plan', status: null }}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>System message: session hook (preempts the verb mid-turn)</ShowcaseLabel>
        <ShowcaseDemo>
          <ChatStatusStrip
            status="streaming"
            streamStartTime={streamStart}
            estimatedTokens={0}
            systemStatus={{ message: 'Running hook "format"…', status: null }}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Idle (renders nothing — height 0)</ShowcaseLabel>
        <ShowcaseDemo>
          <ChatStatusStrip
            status="idle"
            streamStartTime={null}
            estimatedTokens={0}
            systemStatus={null}
          />
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
                resetsAt: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
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
        title="TransportErrorBanner"
        description="Structured error banner for transport-level failures (network, server, timeout, session lock). Shown outside the message stream."
      >
        <ShowcaseLabel>Connection failed (retryable)</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <TransportErrorBanner
            error={{
              heading: 'Connection failed',
              message: 'Could not reach the server. Check your connection and try again.',
              retryable: true,
            }}
            onRetry={() => console.log('[Showcase] Retry clicked')}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Server error (retryable)</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <TransportErrorBanner
            error={{
              heading: 'Server error',
              message: 'The server encountered an error. Try again.',
              retryable: true,
            }}
            onRetry={() => console.log('[Showcase] Retry clicked')}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Request timed out (retryable)</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <TransportErrorBanner
            error={{
              heading: 'Request timed out',
              message: 'The server took too long to respond. Try again.',
              retryable: true,
            }}
            onRetry={() => console.log('[Showcase] Retry clicked')}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Session in use (not retryable, auto-dismisses)</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <TransportErrorBanner
            error={{
              heading: 'Session in use',
              message: 'Another client is sending a message. Try again in a few seconds.',
              retryable: false,
              autoDismissMs: 4000,
            }}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Unknown error (not retryable)</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <TransportErrorBanner
            error={{
              heading: 'Error',
              message: 'An unexpected error occurred.',
              retryable: false,
            }}
          />
        </ShowcaseDemo>
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
