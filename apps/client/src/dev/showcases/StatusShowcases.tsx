import { useState } from 'react';
import { StreamingText } from '@/layers/features/chat/ui/StreamingText';
import { InferenceIndicator } from '@/layers/features/chat/ui/InferenceIndicator';
import { SystemStatusZone } from '@/layers/features/chat/ui/SystemStatusZone';
import { TaskListPanel } from '@/layers/features/chat/ui/TaskListPanel';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { SAMPLE_TASKS } from '../mock-chat-data';

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

/** Status-related component showcases: StreamingText, InferenceIndicator, SystemStatusZone, TaskListPanel. */
export function StatusShowcases() {
  const [taskCollapsed, setTaskCollapsed] = useState(false);
  const [taskCollapsed2, setTaskCollapsed2] = useState(true);
  // Stable start times to avoid react-hooks/purity warnings from Date.now() in render
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

        <ShowcaseLabel>Null (renders nothing)</ShowcaseLabel>
        <ShowcaseDemo>
          <SystemStatusZone message={null} />
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
    </>
  );
}
