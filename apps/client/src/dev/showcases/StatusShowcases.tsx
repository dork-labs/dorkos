import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { StreamingText } from '@/layers/features/chat/ui/StreamingText';
import { InferenceIndicator } from '@/layers/features/chat/ui/InferenceIndicator';
import { SystemStatusZone } from '@/layers/features/chat/ui/SystemStatusZone';
import { TaskListPanel } from '@/layers/features/chat/ui/TaskListPanel';
import { ClientsItem } from '@/layers/features/status';
import type { TransportErrorInfo } from '@/layers/features/chat/model/chat-types';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { SAMPLE_TASKS } from '../mock-chat-data';

/** Replica of the inline transport error banner from ChatPanel for showcase purposes. */
function TransportErrorBanner({ error, onRetry }: { error: TransportErrorInfo; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-destructive">{error.heading}</p>
        <p className="text-sm text-muted-foreground">{error.message}</p>
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

/** Status-related component showcases: StreamingText, InferenceIndicator, SystemStatusZone, TransportErrorBanner, TaskListPanel, ClientsItem. */
export function StatusShowcases() {
  const [taskCollapsed, setTaskCollapsed] = useState(false);
  const [taskCollapsed2, setTaskCollapsed2] = useState(true);

  // Stable timestamps computed once on mount via useState initializer (useMemo triggers react-hooks/purity)
  const [streamStart] = useState(() => Date.now());
  const [ts] = useState(() => {
    const base = Date.now();
    return {
      now: new Date(base).toISOString(),
      fiveMinAgo: new Date(base - 5 * 60_000).toISOString(),
      twelveMinAgo: new Date(base - 12 * 60_000).toISOString(),
      fortyFiveMinAgo: new Date(base - 45 * 60_000).toISOString(),
      threeMinAgo: new Date(base - 3 * 60_000).toISOString(),
      tenSecAgo: new Date(base - 10_000).toISOString(),
      twoMinAgo: new Date(base - 2 * 60_000).toISOString(),
    };
  });

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
        title="InferenceIndicator"
        description="Status indicator showing agent activity."
      >
        <ShowcaseLabel>Streaming (live timer)</ShowcaseLabel>
        <ShowcaseDemo>
          <InferenceIndicator
            status="streaming"
            streamStartTime={streamStart}
            estimatedTokens={1250}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Waiting for approval</ShowcaseLabel>
        <ShowcaseDemo>
          <InferenceIndicator
            status="streaming"
            streamStartTime={streamStart - 5000}
            estimatedTokens={800}
            isWaitingForUser
            waitingType="approval"
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Waiting for question</ShowcaseLabel>
        <ShowcaseDemo>
          <InferenceIndicator
            status="streaming"
            streamStartTime={streamStart - 3000}
            estimatedTokens={600}
            isWaitingForUser
            waitingType="question"
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Rate limited (with countdown)</ShowcaseLabel>
        <ShowcaseDemo>
          <InferenceIndicator
            status="streaming"
            streamStartTime={streamStart - 10000}
            estimatedTokens={400}
            isRateLimited
            rateLimitRetryAfter={42}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Rate limited (no duration)</ShowcaseLabel>
        <ShowcaseDemo>
          <InferenceIndicator
            status="streaming"
            streamStartTime={streamStart - 10000}
            estimatedTokens={400}
            isRateLimited
            rateLimitRetryAfter={null}
          />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="SystemStatusZone"
        description="Ephemeral status banner for SDK system messages (e.g. context compaction, permission changes)."
      >
        <ShowcaseLabel>Active message</ShowcaseLabel>
        <ShowcaseDemo>
          <SystemStatusZone message="Compacting context..." />
        </ShowcaseDemo>

        <ShowcaseLabel>Permission mode change</ShowcaseLabel>
        <ShowcaseDemo>
          <SystemStatusZone message="Permission mode changed to plan" />
        </ShowcaseDemo>

        <ShowcaseLabel>Response truncated (max tokens)</ShowcaseLabel>
        <ShowcaseDemo>
          <SystemStatusZone message="Response truncated — reached max output tokens." />
        </ShowcaseDemo>

        <ShowcaseLabel>Null (renders nothing)</ShowcaseLabel>
        <ShowcaseDemo>
          <SystemStatusZone message={null} />
        </ShowcaseDemo>
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
            activeForm="Implementing authentication service"
            isCollapsed={taskCollapsed}
            onToggleCollapse={() => setTaskCollapsed((c) => !c)}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Collapsed</ShowcaseLabel>
        <ShowcaseDemo>
          <TaskListPanel
            tasks={SAMPLE_TASKS}
            activeForm="Implementing authentication service"
            isCollapsed={taskCollapsed2}
            onToggleCollapse={() => setTaskCollapsed2((c) => !c)}
          />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="ClientsItem"
        description="Multi-client session presence indicator. Shows connected client count with popover details."
      >
        <ShowcaseLabel>2 web clients</ShowcaseLabel>
        <ShowcaseDemo>
          <ClientsItem
            clientCount={2}
            clients={[
              { type: 'web', connectedAt: ts.now },
              { type: 'web', connectedAt: ts.fiveMinAgo },
            ]}
            lockInfo={null}
            pulse={false}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Mixed client types (web + Obsidian + external)</ShowcaseLabel>
        <ShowcaseDemo>
          <ClientsItem
            clientCount={3}
            clients={[
              { type: 'web', connectedAt: ts.now },
              { type: 'obsidian', connectedAt: ts.twelveMinAgo },
              { type: 'mcp', connectedAt: ts.fortyFiveMinAgo },
            ]}
            lockInfo={null}
            pulse={false}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Session locked by another client (amber)</ShowcaseLabel>
        <ShowcaseDemo>
          <ClientsItem
            clientCount={2}
            clients={[
              { type: 'web', connectedAt: ts.now },
              { type: 'obsidian', connectedAt: ts.threeMinAgo },
            ]}
            lockInfo={{
              clientId: 'obsidian-abc123',
              acquiredAt: ts.tenSecAgo,
            }}
            pulse={false}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Pulse animation (sync event from another client)</ShowcaseLabel>
        <ShowcaseDemo>
          <ClientsItem
            clientCount={2}
            clients={[
              { type: 'web', connectedAt: ts.now },
              { type: 'web', connectedAt: ts.twoMinAgo },
            ]}
            lockInfo={null}
            pulse={true}
          />
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
