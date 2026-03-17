import { useState } from 'react';
import { ChatInput } from '@/layers/features/chat/ui/ChatInput';
import { FileChipBar } from '@/layers/features/chat/ui/FileChipBar';
import { QueuePanel } from '@/layers/features/chat/ui/QueuePanel';
import { ShortcutChips } from '@/layers/features/chat/ui/ShortcutChips';
import { PromptSuggestionChips } from '@/layers/features/chat/ui/PromptSuggestionChips';
import { QuestionPrompt } from '@/layers/features/chat/ui/QuestionPrompt';
import { TransportProvider } from '@/layers/shared/model';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { SAMPLE_FILES, SAMPLE_QUEUE } from '../mock-chat-data';
import { createPlaygroundTransport } from '../playground-transport';
import type { QuestionItem } from '@dorkos/shared/types';

const playgroundTransport = createPlaygroundTransport();

const SINGLE_QUESTION: QuestionItem[] = [
  {
    header: 'Auth method',
    question: 'Which authentication method should we use?',
    options: [
      { label: 'JWT tokens', description: 'Stateless, good for microservices' },
      { label: 'Session cookies', description: 'Traditional, server-side state' },
      { label: 'OAuth 2.0', description: 'Third-party provider delegation' },
    ],
    multiSelect: false,
  },
];

const MULTI_QUESTION: QuestionItem[] = [
  {
    header: 'Runtime',
    question: 'Which runtime should the agent use?',
    options: [
      { label: 'Claude Code', description: 'Primary runtime' },
      { label: 'Codex', description: 'OpenAI alternative' },
    ],
    multiSelect: false,
  },
  {
    header: 'Features',
    question: 'Which features do you want to enable?',
    options: [
      { label: 'Extended thinking', description: 'Chain-of-thought reasoning' },
      { label: 'Tool approval', description: 'Require user confirmation' },
      { label: 'Auto-commit', description: 'Commit changes automatically' },
    ],
    multiSelect: true,
  },
  {
    header: 'Priority',
    question: 'What is the task priority?',
    options: [
      { label: 'High', description: 'Process immediately' },
      { label: 'Normal', description: 'Standard queue' },
      { label: 'Low', description: 'Background processing' },
    ],
    multiSelect: false,
  },
];

const MULTI_SELECT_QUESTION: QuestionItem[] = [
  {
    header: 'Tools',
    question: 'Which tools should the agent have access to?',
    options: [
      { label: 'Bash', description: 'Shell command execution' },
      { label: 'Read', description: 'File reading' },
      { label: 'Write', description: 'File writing' },
      { label: 'WebSearch', description: 'Internet search' },
    ],
    multiSelect: true,
  },
];

function ChatInputDemo({
  label,
  initialValue = '',
  isStreaming = false,
  queueDepth = 0,
}: {
  label: string;
  initialValue?: string;
  isStreaming?: boolean;
  queueDepth?: number;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <div>
      <ShowcaseLabel>{label}</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="border-border rounded-xl border">
          <ChatInput
            value={value}
            onChange={setValue}
            onSubmit={() => {}}
            isStreaming={isStreaming}
            queueDepth={queueDepth}
            onStop={() => {}}
            onQueue={() => {}}
          />
        </div>
      </ShowcaseDemo>
    </div>
  );
}

/** Input-related component showcases: ChatInput, FileChipBar, QueuePanel, ShortcutChips, PromptSuggestionChips, QuestionPrompt. */
export function InputShowcases() {
  const [files, setFiles] = useState(SAMPLE_FILES);

  return (
    <>
      <PlaygroundSection
        title="ChatInput"
        description="Chat text input in different states."
      >
        <ChatInputDemo label="Idle" />
        <ChatInputDemo
          label="With text"
          initialValue="Can you help me refactor the auth module?"
        />
        <ChatInputDemo label="Streaming (stop button)" isStreaming />
        <ChatInputDemo
          label="Streaming with queue"
          isStreaming
          queueDepth={2}
        />
      </PlaygroundSection>

      <PlaygroundSection
        title="FileChipBar"
        description="File chips in various upload states."
      >
        <ShowcaseDemo>
          <FileChipBar
            files={files}
            onRemove={(id) => setFiles((prev) => prev.filter((f) => f.id !== id))}
          />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="QueuePanel"
        description="Queued messages displayed above the input."
      >
        <ShowcaseLabel>With items</ShowcaseLabel>
        <ShowcaseDemo>
          <QueuePanel
            queue={SAMPLE_QUEUE}
            editingIndex={null}
            onEdit={() => {}}
            onRemove={() => {}}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>With item being edited</ShowcaseLabel>
        <ShowcaseDemo>
          <QueuePanel
            queue={SAMPLE_QUEUE}
            editingIndex={1}
            onEdit={() => {}}
            onRemove={() => {}}
          />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="ShortcutChips"
        description="Quick-access chips for / commands and @ file mentions."
      >
        <ShowcaseDemo>
          <ShortcutChips onChipClick={() => {}} />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="PromptSuggestionChips"
        description="SDK-provided follow-up suggestions shown after assistant responses."
      >
        <ShowcaseLabel>With suggestions</ShowcaseLabel>
        <ShowcaseDemo>
          <PromptSuggestionChips
            suggestions={[
              'Run the tests',
              'Review the changes',
              'Commit this work',
            ]}
            onChipClick={() => {}}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Long suggestions (truncated)</ShowcaseLabel>
        <ShowcaseDemo>
          <PromptSuggestionChips
            suggestions={[
              'Can you refactor the authentication module to use JWT tokens instead?',
              'Show me the test coverage report for the shared package',
              'Deploy to staging',
              'Fix the TypeScript errors in the relay package',
            ]}
            onChipClick={() => {}}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Single suggestion</ShowcaseLabel>
        <ShowcaseDemo>
          <PromptSuggestionChips
            suggestions={['Run the tests']}
            onChipClick={() => {}}
          />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="QuestionPrompt"
        description="Interactive question form with radio, checkbox, and tabbed multi-question layouts."
      >
        <TransportProvider transport={playgroundTransport}>
          <ShowcaseLabel>Single question (radio)</ShowcaseLabel>
          <ShowcaseDemo>
            <QuestionPrompt
              sessionId="demo-session"
              toolCallId="demo-tool-single"
              questions={SINGLE_QUESTION}
              isActive
            />
          </ShowcaseDemo>

          <ShowcaseLabel>Multi-question (tabs)</ShowcaseLabel>
          <ShowcaseDemo>
            <QuestionPrompt
              sessionId="demo-session"
              toolCallId="demo-tool-multi"
              questions={MULTI_QUESTION}
              isActive
            />
          </ShowcaseDemo>

          <ShowcaseLabel>Multi-select (checkboxes)</ShowcaseLabel>
          <ShowcaseDemo>
            <QuestionPrompt
              sessionId="demo-session"
              toolCallId="demo-tool-multiselect"
              questions={MULTI_SELECT_QUESTION}
              isActive
            />
          </ShowcaseDemo>

          <ShowcaseLabel>Submitted (collapsed)</ShowcaseLabel>
          <ShowcaseDemo>
            <QuestionPrompt
              sessionId="demo-session"
              toolCallId="demo-tool-submitted"
              questions={SINGLE_QUESTION}
              answers={{ '0': 'JWT tokens' }}
            />
          </ShowcaseDemo>
        </TransportProvider>
      </PlaygroundSection>
    </>
  );
}
