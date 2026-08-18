// @vitest-environment jsdom
/**
 * What `Conversation.Composer` promises both surfaces.
 *
 * The card's own rules, not the field's: `features/composer` has its own suite
 * for what Enter does and how the palettes behave. What is asked here is what
 * the CARD decides from the target — whether there is queue chrome at all,
 * whether the box is live, where the chips come from, and whether a prompt may
 * replace the whole thing.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Conversation } from '..';
import type { ConversationCapabilities } from '../model/capabilities';
import type { ConversationTarget } from '../model/target';

/** Every capability off, so each case turns on only what it is about. */
const BASE: ConversationCapabilities = {
  reactions: false,
  threads: false,
  runWith: false,
  attachments: false,
  toolCards: false,
  mentions: false,
  presence: false,
  turnStatus: false,
  asks: false,
};

/** A target with nothing switched on: no queue, no files, always sendable. */
function target(overrides: Partial<ConversationTarget> = {}): ConversationTarget {
  return {
    kind: 'room',
    id: 'room-1',
    placeholder: 'Message #mio…',
    canSend: true,
    send: vi.fn(async () => {}),
    queueDepth: 0,
    attachments: null,
    ...overrides,
  };
}

/** Mount the card with whatever the case varies. */
function mount(
  props: Partial<Parameters<typeof Conversation.Composer>[0]> = {},
  conversation: {
    capabilities?: Partial<ConversationCapabilities>;
    target?: ConversationTarget;
  } = {}
) {
  return render(
    <Conversation.Root
      surface="room"
      capabilities={{ ...BASE, ...conversation.capabilities }}
      target={conversation.target ?? target()}
    >
      <Conversation.Composer
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        input={{ isStreaming: false }}
        {...props}
      />
    </Conversation.Root>
  );
}

describe('Conversation.Composer', () => {
  it('draws no queue chrome at all on a surface with no queue', () => {
    // **Seeded defect:** gate the queue slot on `queueDepth` alone, or render it
    // unconditionally, and a channel grows a control explaining a feature it
    // does not have. Run and red.
    mount({ queue: <p data-testid="queue-panel">1 queued</p> });

    expect(screen.queryByTestId('queue-panel')).not.toBeInTheDocument();
  });

  it('draws the queue chrome on a surface that has a queue', () => {
    mount(
      { queue: <p data-testid="queue-panel">1 queued</p> },
      { target: target({ kind: 'session', queue: vi.fn(async () => {}), queueDepth: 1 }) }
    );

    expect(screen.getByTestId('queue-panel')).toHaveTextContent('1 queued');
  });

  it('names the conversation in the box', () => {
    mount();

    expect(screen.getByRole('combobox')).toHaveAccessibleName('Message #mio…');
  });

  it('lets the surface override the placeholder for a mode of its own', () => {
    // A session editing a queued item says so in the box, and that is the
    // surface's sentence rather than the target's.
    mount({
      input: {
        isStreaming: false,
        placeholder: 'Edit queued message 1 of 2 — press Enter to save',
      },
    });

    expect(screen.getByRole('combobox')).toHaveAccessibleName(
      'Edit queued message 1 of 2 — press Enter to save'
    );
  });

  it('refuses the send honestly when the conversation cannot take one', () => {
    // **Seeded defect:** pass `canSubmit` through without reading `canSend`, and
    // an archived channel keeps a live-looking box that silently drops a message.
    mount(
      {},
      {
        target: target({
          canSend: false,
          canSendReason: 'This conversation is archived. You can read it, but not add to it.',
        }),
      }
    );

    expect(
      screen.getByText('This conversation is archived. You can read it, but not add to it.')
    ).toBeInTheDocument();
  });

  it('invents no reason of its own when the conversation can be written to', () => {
    // The two surfaces disagree about how a failed attachment reads, and each
    // keeps its own answer: the card must not write a third sentence.
    mount(
      {},
      {
        target: target({
          attachments: {
            staged: [],
            add: vi.fn(),
            remove: vi.fn(),
            retry: vi.fn(),
            cancel: vi.fn(),
            hasFailed: true,
            isUploading: false,
          },
        }),
        capabilities: { attachments: true },
      }
    );

    expect(screen.queryByText(/didn’t upload/u)).not.toBeInTheDocument();
  });

  it('offers no paperclip on a surface that does not take files', () => {
    mount();

    expect(screen.queryByRole('button', { name: /attach/iu })).not.toBeInTheDocument();
  });

  it('draws the chip bar from the target’s staged files', () => {
    mount(
      {},
      {
        capabilities: { attachments: true },
        target: target({
          attachments: {
            staged: [
              { id: 'f1', file: new File(['x'], 'notes.txt'), status: 'pending', progress: 0 },
            ],
            add: vi.fn(),
            remove: vi.fn(),
            retry: vi.fn(),
            cancel: vi.fn(),
            hasFailed: false,
            isUploading: false,
          },
        }),
      }
    );

    expect(screen.getByText('notes.txt')).toBeInTheDocument();
  });

  it('lets a prompt replace the whole box on a surface that can be taken over', () => {
    mount({ asks: <p data-testid="ask">Allow this?</p> });

    expect(screen.getByTestId('ask')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('keeps the box on a surface that is never taken over', () => {
    // **Seeded defect:** render the takeover branch whenever `capabilities.asks`
    // is true, and a channel — which draws its Asks in the lane — loses its
    // composer the moment an agent asks anything. Run and red.
    mount({}, { capabilities: { asks: true } });

    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('refuses to draw without a target, rather than pretending to send', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      render(
        <Conversation.Root surface="room" capabilities={BASE}>
          <Conversation.Composer
            value=""
            onChange={() => {}}
            onSubmit={() => {}}
            input={{ isStreaming: false }}
          />
        </Conversation.Root>
      )
    ).toThrow(/needs a target/u);
    quiet.mockRestore();
  });
});
