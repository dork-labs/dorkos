import { useState } from 'react';
import { ChatInput } from '@/layers/features/chat/ui/ChatInput';
import { FileChipBar } from '@/layers/features/chat/ui/FileChipBar';
import { QueuePanel } from '@/layers/features/chat/ui/QueuePanel';
import { ShortcutChips } from '@/layers/features/chat/ui/ShortcutChips';
import { PlaygroundSection } from '../PlaygroundSection';
import { SAMPLE_FILES, SAMPLE_QUEUE } from '../mock-chat-data';

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wider">
      {children}
    </div>
  );
}

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
      <Label>{label}</Label>
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
    </div>
  );
}

/** Input-related component showcases: ChatInput, FileChipBar, QueuePanel, ShortcutChips. */
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
        <FileChipBar
          files={files}
          onRemove={(id) => setFiles((prev) => prev.filter((f) => f.id !== id))}
        />
      </PlaygroundSection>

      <PlaygroundSection
        title="QueuePanel"
        description="Queued messages displayed above the input."
      >
        <Label>With items</Label>
        <QueuePanel
          queue={SAMPLE_QUEUE}
          editingIndex={null}
          onEdit={() => {}}
          onRemove={() => {}}
        />

        <Label>With item being edited</Label>
        <QueuePanel
          queue={SAMPLE_QUEUE}
          editingIndex={1}
          onEdit={() => {}}
          onRemove={() => {}}
        />
      </PlaygroundSection>

      <PlaygroundSection
        title="ShortcutChips"
        description="Quick-access chips for / commands and @ file mentions."
      >
        <ShortcutChips onChipClick={() => {}} />
      </PlaygroundSection>
    </>
  );
}
