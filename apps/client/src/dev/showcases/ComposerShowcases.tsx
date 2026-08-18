/**
 * `Conversation.Composer` — one host, benched against both adapters.
 *
 * Replaces `InputShowcases.tsx` (DOR-1332, P5): that file recreated the old
 * `ChatInputContainer` / `RoomComposer` chrome by hand, and both are gone —
 * `Conversation.Composer` (`features/conversation/ui/ComposerHost.tsx`) is the
 * one card every surface now sits in. This benches the REAL host against two
 * fixture `ConversationTarget` adapters — a session-shaped one with a queue,
 * a room-shaped one without — the same way `MessageRowShowcases` benches
 * `Message.*` against fixture capability tables rather than reaching into a
 * live session or room.
 *
 * @module dev/showcases/ComposerShowcases
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Conversation } from '@/layers/features/conversation';
import type {
  ConversationAttachmentPort,
  ConversationTarget,
} from '@/layers/features/conversation';
import { SESSION_CAPABILITIES } from '@/layers/widgets/session';
import { ROOM_CAPABILITIES } from '@/layers/widgets/room-view';
import { QueuePanel } from '@/layers/features/chat/ui/input/QueuePanel';
import { ApprovalPrompt, QuestionPrompt } from '@/layers/features/ask';
import { CommandPalette } from '@/layers/features/commands';
import { FilePalette } from '@/layers/features/files';
import { MentionPalette, type MentionRow } from '@/layers/features/mentions';
import { TransportProvider } from '@/layers/shared/model';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  MOCK_SESSION_ID,
  SAMPLE_FILES,
  SAMPLE_QUEUE,
  SAMPLE_FILE_ENTRIES,
  SAMPLE_COMMANDS,
  SAMPLE_COMMANDS_LONG,
  TOOL_CALL_APPROVAL,
} from '../mock-chat-data';
import { createPlaygroundTransport } from '../playground-transport';
import type { PendingFile } from '@/layers/features/composer';
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
];

/** A staged-files port a demo can drive from local state — the same shape `ChannelComposer` and `SessionComposer` each build over their own upload hook. */
function useFixtureAttachments(initial: PendingFile[] = []): ConversationAttachmentPort {
  const [staged, setStaged] = useState(initial);
  return {
    staged,
    add: () => {},
    remove: (fileId) => setStaged((prev) => prev.filter((f) => f.id !== fileId)),
    retry: (fileId) =>
      setStaged((prev) =>
        prev.map((f) => (f.id === fileId ? { ...f, status: 'pending', progress: 0 } : f))
      ),
    cancel: () => {},
    hasFailed: staged.some((f) => f.status === 'error'),
    isUploading: staged.some((f) => f.status === 'uploading'),
    holdsSendWhileUploading: false,
  };
}

/** A fixture session target: has a queue, no mentions, no attach dropzone unless staged. */
export function buildSessionTarget(
  overrides: Partial<ConversationTarget> = {}
): ConversationTarget {
  return {
    kind: 'session',
    id: MOCK_SESSION_ID,
    placeholder: 'Message DorkBot…',
    canSend: true,
    send: () => Promise.resolve(),
    queue: () => Promise.resolve(),
    attachments: null,
    ...overrides,
  };
}

/** A fixture room target: no `queue` at all — that absence is what turns off the queue chrome. */
export function buildRoomTarget(overrides: Partial<ConversationTarget> = {}): ConversationTarget {
  return {
    kind: 'room',
    id: 'room-release-train',
    placeholder: 'Message #release-train…',
    canSend: true,
    send: () => Promise.resolve(),
    attachments: null,
    ...overrides,
  };
}

/** One composer demo: a surface, a target, and whatever slots this state needs. */
function ComposerDemo({
  label,
  surface,
  capabilities,
  target,
  asks,
  note,
  initialValue = '',
  showQueueItems = false,
}: {
  label: string;
  surface: 'session' | 'room' | 'dm';
  capabilities: typeof SESSION_CAPABILITIES;
  target: ConversationTarget;
  asks?: ReactNode;
  note?: string;
  /**
   * What the field starts with. A demo labelled "Typing" that starts empty is
   * pixel-identical to the "Idle" one above it, which makes the label a claim
   * the demo does not support.
   */
  initialValue?: string;
  /**
   * Draw the queue panel with its sample items. Distinct from `target.queue`
   * existing: every session target carries the method (that presence is what
   * the capability gate reads), but only the "Queue depth" demo should
   * actually show held drafts — an idle or typing demo with a queue panel
   * already in it would misdescribe its own label.
   */
  showQueueItems?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <div>
      <ShowcaseLabel>{label}</ShowcaseLabel>
      {note !== undefined && <p className="text-muted-foreground mb-1 text-xs">{note}</p>}
      <ShowcaseDemo responsive>
        <Conversation.Root surface={surface} capabilities={capabilities} target={target}>
          <Conversation.Composer
            value={value}
            onChange={setValue}
            onSubmit={() => {}}
            {...(target.queue !== undefined &&
              showQueueItems && {
                queue: (
                  <QueuePanel
                    queue={SAMPLE_QUEUE}
                    editingId={null}
                    onEdit={() => {}}
                    onRemove={() => {}}
                    onSend={() => {}}
                    onMoveUp={() => {}}
                    statusNote="Sending one at a time as the agent finishes"
                  />
                ),
              })}
            {...(asks !== undefined && { asks })}
            input={{ placeholder: target.placeholder, isStreaming: false }}
          />
        </Conversation.Root>
      </ShowcaseDemo>
    </div>
  );
}

/**
 * A roster's worth of `@` rows: People first, then Agents, one flat list whose
 * indices the keyboard walks straight through — the order `ROOM_SECTION_ORDER`
 * gives a room composer. The last row is the deliberately unselectable case: a
 * member the server has no `@name` for.
 */
const SAMPLE_MENTION_ROWS: MentionRow[] = [
  { section: 'people', authorId: 'ana', label: 'Ana Ruiz', handle: 'ana', disabled: false },
  {
    section: 'people',
    authorId: 'aurora',
    label: 'Aurora Vance',
    handle: 'aurora',
    disabled: false,
  },
  {
    section: 'agents',
    authorId: 'audit-bot',
    label: 'Audit Bot',
    handle: 'audit-bot',
    emoji: '🔍',
    disabled: false,
  },
  {
    section: 'agents',
    authorId: 'august',
    label: 'August',
    emoji: '📓',
    disabled: true,
    disabledReason: 'No @name',
  },
];

/**
 * The mention picker overlay, anchored under a room composer that has typed `@`.
 *
 * Draws the REAL `MentionPalette` — the same component `ChannelComposer` hands
 * this slot. A file palette under a label reading "Mentions" would be the
 * no-replicas failure one step sideways: a real component, just not the one the
 * section claims to be showing.
 */
function MentionPickerDemo() {
  const [value, setValue] = useState('Loop in @au');
  const target = buildRoomTarget();
  return (
    <div>
      <ShowcaseLabel>
        Mentions — the `@` picker (room and DM only; a session declares no mentions)
      </ShowcaseLabel>
      <ShowcaseDemo responsive>
        <Conversation.Root surface="room" capabilities={ROOM_CAPABILITIES} target={target}>
          <Conversation.Composer
            value={value}
            onChange={setValue}
            onSubmit={() => {}}
            mentionPicker={
              <MentionPalette rows={SAMPLE_MENTION_ROWS} selectedIndex={1} onSelect={() => {}} />
            }
            input={{ placeholder: target.placeholder, isStreaming: false }}
          />
        </Conversation.Root>
      </ShowcaseDemo>
    </div>
  );
}

/**
 * The file picker over a SESSION composer, in the `overlays` slot.
 *
 * The counterpart to the demo above, and the reason the two slots are separate:
 * a session declares `mentions: false`, so its `@` reaches for a file in the
 * working directory rather than a person, and `SessionComposer` puts the real
 * `FilePalette` in `overlays` — which the card draws for every surface —
 * instead of `mentionPicker`, which the card draws only where the capability
 * says so.
 */
function FilePickerDemo() {
  const [value, setValue] = useState('Have a look at @types');
  const target = buildSessionTarget();
  return (
    <div>
      <ShowcaseLabel>
        Files — the same `@` on a session, which has no mentions and reaches for a file instead
      </ShowcaseLabel>
      <ShowcaseDemo responsive>
        <Conversation.Root surface="session" capabilities={SESSION_CAPABILITIES} target={target}>
          <Conversation.Composer
            value={value}
            onChange={setValue}
            onSubmit={() => {}}
            overlays={
              <FilePalette
                filteredFiles={SAMPLE_FILE_ENTRIES}
                selectedIndex={0}
                onSelect={() => {}}
              />
            }
            input={{ placeholder: target.placeholder, isStreaming: false }}
          />
        </Conversation.Root>
      </ShowcaseDemo>
    </div>
  );
}

/** Attachments staged on each adapter — both accept files, drawn from the same chip bar. */
function AttachmentsDemo({
  surface,
  capabilities,
  target,
}: {
  surface: 'session' | 'room';
  capabilities: typeof SESSION_CAPABILITIES;
  target: ConversationTarget;
}) {
  const [value, setValue] = useState('');
  const attachments = useFixtureAttachments(SAMPLE_FILES);
  return (
    <div>
      <ShowcaseLabel>{`Attachments — staged on the ${surface}`}</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <Conversation.Root
          surface={surface}
          capabilities={capabilities}
          target={{ ...target, attachments }}
        >
          <Conversation.Composer
            value={value}
            onChange={setValue}
            onSubmit={() => {}}
            input={{ placeholder: target.placeholder, isStreaming: false }}
          />
        </Conversation.Root>
      </ShowcaseDemo>
    </div>
  );
}

/**
 * `Conversation.Composer`, benched against the session and room/DM adapters —
 * idle, typing, attachments, mentions, queue depth, an Ask takeover, and the
 * archived / `canSend: false` refusal.
 */
export function ComposerShowcases() {
  const sessionIdle = buildSessionTarget();
  const sessionTyping = buildSessionTarget();
  const sessionQueued = buildSessionTarget();
  const sessionArchived = buildSessionTarget({
    canSend: false,
    canSendReason: 'This session has ended. Start a new one to keep going.',
  });
  const roomIdle = buildRoomTarget();
  const roomTyping = buildRoomTarget();
  const roomArchived = buildRoomTarget({
    canSend: false,
    canSendReason: 'This room is archived. Unarchive it to post here.',
  });

  return (
    <PlaygroundSection
      title="Composer"
      description="One card — Conversation.Composer — for every surface with something to type into. Look is decided by the surface's own field wiring; behaviour by the target it is handed. A session target carries a queue; a room target does not, and that absence is what turns off the queue chrome entirely rather than greying it out. Only a session's composer is ever replaced by an Ask — a channel draws its Asks in the Live lane instead."
    >
      <ShowcaseLabel>Idle — session, then room</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="flex flex-col gap-4">
          <ComposerDemo
            label="Session"
            surface="session"
            capabilities={SESSION_CAPABILITIES}
            target={sessionIdle}
          />
          <ComposerDemo
            label="Room"
            surface="room"
            capabilities={ROOM_CAPABILITIES}
            target={roomIdle}
          />
        </div>
      </ShowcaseDemo>

      <ComposerDemo
        label="Typing — session"
        surface="session"
        capabilities={SESSION_CAPABILITIES}
        target={sessionTyping}
        initialValue="Can you check why the deploy is stuck?"
      />
      <ComposerDemo
        label="Typing — room"
        surface="room"
        capabilities={ROOM_CAPABILITIES}
        target={roomTyping}
        initialValue="Looks like the migration step timed out waiting on a lock."
      />

      <AttachmentsDemo surface="session" capabilities={SESSION_CAPABILITIES} target={sessionIdle} />
      <AttachmentsDemo surface="room" capabilities={ROOM_CAPABILITIES} target={roomIdle} />

      <MentionPickerDemo />
      <FilePickerDemo />

      <ComposerDemo
        label="Queue depth — session (a room has no queue method, so it draws no queue chrome at all)"
        surface="session"
        capabilities={SESSION_CAPABILITIES}
        target={sessionQueued}
        showQueueItems
      />

      <TransportProvider transport={playgroundTransport}>
        <ComposerDemo
          label="Ask takeover — the asks slot replaces the whole card"
          surface="session"
          capabilities={SESSION_CAPABILITIES}
          target={sessionIdle}
          asks={
            <ApprovalPrompt
              sessionId={MOCK_SESSION_ID}
              toolCallId={TOOL_CALL_APPROVAL.toolCallId + '-composer-takeover'}
              toolName={TOOL_CALL_APPROVAL.toolName}
              input={TOOL_CALL_APPROVAL.input}
              isActive
            />
          }
        />
      </TransportProvider>

      <ComposerDemo
        label="Archived / canSend: false — session, with its own reason"
        surface="session"
        capabilities={SESSION_CAPABILITIES}
        target={sessionArchived}
      />
      <ComposerDemo
        label="Archived / canSend: false — room, with its own reason"
        surface="room"
        capabilities={ROOM_CAPABILITIES}
        target={roomArchived}
      />
    </PlaygroundSection>
  );
}

/** Renders a palette dropdown in normal flow above a fake input anchor. */
function PaletteAnchor({ hint, children }: { hint: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2">{children}</div>
      <div className="border-border bg-muted/30 text-muted-foreground flex h-10 items-center rounded-lg border px-3 text-sm">
        {hint}
        <span className="bg-foreground ml-0.5 inline-block h-4 w-px animate-pulse" />
      </div>
    </div>
  );
}

/** The slash-command dropdown the composer's overlay lane opens on `/`. */
export function CommandPaletteShowcase() {
  return (
    <PlaygroundSection
      title="CommandPalette"
      description="Dropdown autocomplete for slash commands, triggered by typing / in the input. Stacks in Conversation.Composer's overlay lane, above the field."
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
    </PlaygroundSection>
  );
}

/** The interactive question form an agent's question tool renders inline. */
export function QuestionPromptShowcase() {
  return (
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
  );
}
