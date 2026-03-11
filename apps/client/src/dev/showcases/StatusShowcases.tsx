import { useState } from 'react';
import { StreamingText } from '@/layers/features/chat/ui/StreamingText';
import { InferenceIndicator } from '@/layers/features/chat/ui/InferenceIndicator';
import { TaskListPanel } from '@/layers/features/chat/ui/TaskListPanel';
import { PlaygroundSection } from '../PlaygroundSection';
import { SAMPLE_TASKS } from '../mock-chat-data';

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wider">
      {children}
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

/** Status-related component showcases: StreamingText, InferenceIndicator, TaskListPanel. */
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
        <Label>Short text</Label>
        <StreamingText content={SHORT_TEXT} />

        <Label>Markdown with code block</Label>
        <StreamingText content={MARKDOWN_TEXT} />

        <Label>Code block only</Label>
        <StreamingText content={CODE_BLOCK_TEXT} />

        <Label>Streaming cursor active</Label>
        <StreamingText content="Working on it..." isStreaming />
      </PlaygroundSection>

      <PlaygroundSection
        title="InferenceIndicator"
        description="Status indicator showing agent activity."
      >
        <Label>Streaming (live timer)</Label>
        <InferenceIndicator
          status="streaming"
          streamStartTime={streamStart}
          estimatedTokens={1250}
        />

        <Label>Waiting for approval</Label>
        <InferenceIndicator
          status="streaming"
          streamStartTime={streamStart - 5000}
          estimatedTokens={800}
          isWaitingForUser
          waitingType="approval"
        />

        <Label>Waiting for question</Label>
        <InferenceIndicator
          status="streaming"
          streamStartTime={streamStart - 3000}
          estimatedTokens={600}
          isWaitingForUser
          waitingType="question"
        />
      </PlaygroundSection>

      <PlaygroundSection
        title="TaskListPanel"
        description="Task progress panel with mixed statuses."
      >
        <Label>Expanded</Label>
        <TaskListPanel
          tasks={SAMPLE_TASKS}
          activeForm="Implementing authentication service"
          isCollapsed={taskCollapsed}
          onToggleCollapse={() => setTaskCollapsed((c) => !c)}
        />

        <Label>Collapsed</Label>
        <TaskListPanel
          tasks={SAMPLE_TASKS}
          activeForm="Implementing authentication service"
          isCollapsed={taskCollapsed2}
          onToggleCollapse={() => setTaskCollapsed2((c) => !c)}
        />
      </PlaygroundSection>
    </>
  );
}
