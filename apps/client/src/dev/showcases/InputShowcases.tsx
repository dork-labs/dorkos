import { useState } from 'react';
import { Composer } from '@/layers/features/composer';
import { QueuePanel } from '@/layers/features/chat/ui/input/QueuePanel';
import { QuestionPrompt } from '@/layers/features/ask';
import { CommandPalette } from '@/layers/features/commands';
import { FilePalette } from '@/layers/features/files';
import { TransportProvider } from '@/layers/shared/model';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  SAMPLE_FILES,
  SAMPLE_QUEUE,
  SAMPLE_QUEUE_MIXED_ORIGINS,
  SAMPLE_COMMANDS,
  SAMPLE_COMMANDS_LONG,
  SAMPLE_FILE_ENTRIES,
} from '../mock-chat-data';
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

function ComposerInputDemo({
  label,
  initialValue = '',
  isStreaming = false,
  queueDepth = 0,
  richText = false,
  canSteer = false,
  canAddContext = false,
}: {
  label: string;
  initialValue?: string;
  isStreaming?: boolean;
  queueDepth?: number;
  /**
   * Render the formatting field instead of the plain one. Forced through the
   * prop rather than read from config, so the playground never depends on — or
   * changes — whoever is looking at it.
   */
  richText?: boolean;
  /**
   * Offer the Steer choice beside Queue. Modelled on the runtime capability the
   * real composer reads: on the playground it is a prop, so both the supported
   * and the queue-only busy states are visible side by side.
   */
  canSteer?: boolean;
  /** Offer the Add context choice beside Queue. Same modelling as {@link canSteer}. */
  canAddContext?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <div>
      <ShowcaseLabel>{label}</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="border-border rounded-xl border">
          <Composer.Input
            value={value}
            onChange={setValue}
            onSubmit={() => {}}
            isStreaming={isStreaming}
            richText={richText}
            queueDepth={queueDepth}
            onStop={() => {}}
            onQueue={() => {}}
            // Present ONLY when the capability is, exactly as the real host wires
            // them — so the queue-only busy state shows a plain Queue button and
            // the supported one shows the caret. Never greyed.
            onSteer={canSteer ? () => {} : undefined}
            onStage={canAddContext ? () => {} : undefined}
            // The composer only renders its clear affordance when a host wires
            // one; without this every showcase silently lost the X.
            onClear={() => setValue('')}
          />
        </div>
      </ShowcaseDemo>
    </div>
  );
}

/**
 * The card, with and without attach wiring.
 *
 * The two demos differ by exactly one prop, which is the whole point:
 * `onFilesDropped` IS the attach declaration. Given it, the card mounts a
 * dropzone, a hidden file input, and the "Drop files to attach" overlay;
 * omitted, none of that exists — which is why a room composer listens for no
 * drags at all.
 */
function ComposerRootDemo({ label, onFilesDropped }: { label: string; onFilesDropped?: true }) {
  const [value, setValue] = useState('');
  const [dropped, setDropped] = useState<string[]>([]);

  return (
    <div>
      <ShowcaseLabel>{label}</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <Composer.Root
          onFilesDropped={
            onFilesDropped ? (files) => setDropped(files.map((file) => file.name)) : undefined
          }
        >
          <Composer.Input
            value={value}
            onChange={setValue}
            onSubmit={() => {}}
            isStreaming={false}
            onClear={() => setValue('')}
            placeholder={onFilesDropped ? 'Drop a file on this card…' : 'Message DorkBot…'}
          />
        </Composer.Root>
        {dropped.length > 0 && (
          <p className="text-muted-foreground px-2 text-xs">Dropped: {dropped.join(', ')}</p>
        )}
      </ShowcaseDemo>
    </div>
  );
}

/** Renders a palette dropdown in normal flow above a fake input anchor. */
function PaletteAnchor({
  hint,
  children,
  controls,
}: {
  hint: string;
  children: React.ReactNode;
  controls?: React.ReactNode;
}) {
  return (
    <div>
      {controls && <div className="mb-2">{controls}</div>}
      <div className="mb-2">{children}</div>
      <div className="border-border bg-muted/30 text-muted-foreground flex h-10 items-center rounded-lg border px-3 text-sm">
        {hint}
        <span className="bg-foreground ml-0.5 inline-block h-4 w-px animate-pulse" />
      </div>
    </div>
  );
}

/** Input-related component showcases: Composer.Input, Composer.Attachments, QueuePanel, CommandPalette, FilePalette, QuestionPrompt. */
export function InputShowcases() {
  const [files, setFiles] = useState(SAMPLE_FILES);
  const [cmdIndex, setCmdIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState(0);

  return (
    <>
      <PlaygroundSection
        title="Composer.Root"
        description="The card chrome every composer sits in — chat and rooms alike. A surface accepts files because it wired onFilesDropped, and for no other reason: drag one onto the second card and the drop overlay appears, drag it onto the first and nothing is listening."
      >
        <ComposerRootDemo label="Card only — no attach wiring (rooms today)" />
        <ComposerRootDemo label="Card with attach wiring (chat)" onFilesDropped />
      </PlaygroundSection>

      <PlaygroundSection title="Composer.Input" description="Chat text input in different states.">
        <ComposerInputDemo label="Idle" />
        <ComposerInputDemo
          label="With text"
          initialValue="Can you help me refactor the auth module?"
        />
        <ComposerInputDemo label="Streaming (stop button)" isStreaming />
        <ComposerInputDemo label="Streaming with queue" isStreaming queueDepth={2} />
        <ComposerInputDemo
          label="Formatting as you type (on in chat; Settings → Advanced turns it off)"
          richText
          initialValue={'# Ship notes\n\n- **check** the `build`\n- then the *docs*'}
        />
      </PlaygroundSection>

      <PlaygroundSection
        title="Composer dispositions"
        description="What the send action offers while the agent is working. Idle sessions get a plain Send. Busy sessions get Queue, plus Steer and Add context when the runtime can take them — Claude Code can, Codex and OpenCode cannot, and there the caret is absent rather than greyed. A steer that has to be queued says so once on its chip."
      >
        <ComposerInputDemo
          label="Idle — one plain Send (every disposition would just run now)"
          initialValue="Refactor the auth module"
        />
        <ComposerInputDemo
          label="Busy, runtime can steer (Claude Code) — Queue plus the caret for Steer and Add context"
          isStreaming
          initialValue="Also check the tests"
          canSteer
          canAddContext
        />
        <ComposerInputDemo
          label="Busy, queue-only runtime (Codex / OpenCode) — a plain Queue button, no caret"
          isStreaming
          initialValue="Also check the tests"
        />
        <ShowcaseLabel>Downgraded chip — a steer that had to be queued, said once</ShowcaseLabel>
        <ShowcaseDemo>
          <QueuePanel
            queue={SAMPLE_QUEUE_MIXED_ORIGINS}
            editingId={null}
            onEdit={() => {}}
            onRemove={() => {}}
            onSend={() => {}}
            onMoveUp={() => {}}
            statusNote="Sending one at a time as the agent finishes"
          />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Composer.Attachments"
        description="File chips in various upload states. A failed upload states its reason and offers a retry."
      >
        <ShowcaseDemo>
          <Composer.Attachments
            files={files}
            onRemove={(id) => setFiles((prev) => prev.filter((f) => f.id !== id))}
            onRetry={(id) =>
              setFiles((prev) =>
                prev.map((f) =>
                  f.id === id ? { ...f, status: 'pending', progress: 0, error: undefined } : f
                )
              )
            }
          />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="QueuePanel"
        description="Queued messages displayed above the input. Every row can be sent now, edited, or removed."
      >
        <ShowcaseLabel>With items</ShowcaseLabel>
        <ShowcaseDemo>
          <QueuePanel
            queue={SAMPLE_QUEUE}
            editingId={null}
            onEdit={() => {}}
            onRemove={() => {}}
            onSend={() => {}}
            onMoveUp={() => {}}
            statusNote="Sending one at a time as the agent finishes"
          />
        </ShowcaseDemo>

        <ShowcaseLabel>With item being edited</ShowcaseLabel>
        <ShowcaseDemo>
          <QueuePanel
            queue={SAMPLE_QUEUE}
            editingId={SAMPLE_QUEUE[1]!.id}
            onEdit={() => {}}
            onRemove={() => {}}
            onSend={() => {}}
            onMoveUp={() => {}}
            statusNote="Sending one at a time as the agent finishes"
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Queued from another window, and a message that was downgraded</ShowcaseLabel>
        <ShowcaseDemo>
          <QueuePanel
            queue={SAMPLE_QUEUE_MIXED_ORIGINS}
            editingId={null}
            onEdit={() => {}}
            onRemove={() => {}}
            onSend={() => {}}
            onMoveUp={() => {}}
            statusNote="Waiting for your answer above"
          />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="CommandPalette"
        description="Dropdown autocomplete for slash commands, triggered by typing / in the input."
      >
        <ShowcaseLabel>With commands</ShowcaseLabel>
        <ShowcaseDemo>
          <PaletteAnchor hint="/">
            <CommandPalette
              filteredCommands={SAMPLE_COMMANDS}
              selectedIndex={1}
              onSelect={() => {}}
            />
          </PaletteAnchor>
        </ShowcaseDemo>

        <ShowcaseLabel>Long text (real-world commands)</ShowcaseLabel>
        <ShowcaseDemo>
          <PaletteAnchor hint="/debug:">
            <CommandPalette
              filteredCommands={SAMPLE_COMMANDS_LONG}
              selectedIndex={2}
              onSelect={() => {}}
            />
          </PaletteAnchor>
        </ShowcaseDemo>

        <ShowcaseLabel>Filtered (single namespace)</ShowcaseLabel>
        <ShowcaseDemo>
          <PaletteAnchor hint="/linear:">
            <CommandPalette
              filteredCommands={SAMPLE_COMMANDS.filter((c) => c.namespace === 'linear')}
              selectedIndex={0}
              onSelect={() => {}}
            />
          </PaletteAnchor>
        </ShowcaseDemo>

        <ShowcaseLabel>Empty state</ShowcaseLabel>
        <ShowcaseDemo>
          <PaletteAnchor hint="/xyz">
            <CommandPalette filteredCommands={[]} selectedIndex={0} onSelect={() => {}} />
          </PaletteAnchor>
        </ShowcaseDemo>

        <ShowcaseLabel>Interactive (arrow keys)</ShowcaseLabel>
        <ShowcaseDemo>
          <PaletteAnchor
            hint="/"
            controls={
              <div className="flex gap-2">
                <button
                  type="button"
                  className="bg-muted text-foreground rounded px-2 py-1 text-xs"
                  onClick={() => setCmdIndex((i) => Math.max(0, i - 1))}
                >
                  &uarr; Up
                </button>
                <button
                  type="button"
                  className="bg-muted text-foreground rounded px-2 py-1 text-xs"
                  onClick={() => setCmdIndex((i) => Math.min(SAMPLE_COMMANDS.length - 1, i + 1))}
                >
                  &darr; Down
                </button>
                <span className="text-muted-foreground self-center text-xs">Index: {cmdIndex}</span>
              </div>
            }
          >
            <CommandPalette
              filteredCommands={SAMPLE_COMMANDS}
              selectedIndex={cmdIndex}
              onSelect={() => {}}
            />
          </PaletteAnchor>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="FilePalette"
        description="Dropdown autocomplete for file mentions, triggered by typing @ in the input."
      >
        <ShowcaseLabel>With files</ShowcaseLabel>
        <ShowcaseDemo>
          <PaletteAnchor hint="@auth">
            <FilePalette
              filteredFiles={SAMPLE_FILE_ENTRIES}
              selectedIndex={0}
              onSelect={() => {}}
            />
          </PaletteAnchor>
        </ShowcaseDemo>

        <ShowcaseLabel>Empty state</ShowcaseLabel>
        <ShowcaseDemo>
          <PaletteAnchor hint="@nonexistent">
            <FilePalette filteredFiles={[]} selectedIndex={0} onSelect={() => {}} />
          </PaletteAnchor>
        </ShowcaseDemo>

        <ShowcaseLabel>Interactive (arrow keys)</ShowcaseLabel>
        <ShowcaseDemo>
          <PaletteAnchor
            hint="@"
            controls={
              <div className="flex gap-2">
                <button
                  type="button"
                  className="bg-muted text-foreground rounded px-2 py-1 text-xs"
                  onClick={() => setFileIndex((i) => Math.max(0, i - 1))}
                >
                  &uarr; Up
                </button>
                <button
                  type="button"
                  className="bg-muted text-foreground rounded px-2 py-1 text-xs"
                  onClick={() =>
                    setFileIndex((i) => Math.min(SAMPLE_FILE_ENTRIES.length - 1, i + 1))
                  }
                >
                  &darr; Down
                </button>
                <span className="text-muted-foreground self-center text-xs">
                  Index: {fileIndex}
                </span>
              </div>
            }
          >
            <FilePalette
              filteredFiles={SAMPLE_FILE_ENTRIES}
              selectedIndex={fileIndex}
              onSelect={() => {}}
            />
          </PaletteAnchor>
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
