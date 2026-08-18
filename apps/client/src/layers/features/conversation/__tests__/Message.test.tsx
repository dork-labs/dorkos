// @vitest-environment jsdom
/**
 * The one row, against the thing that decides what it offers.
 *
 * Every case here asks the same question from a different angle: does this row
 * read its CAPABILITIES, or does it know which surface it is on? A row that
 * quietly learned the second would still pass a screenshot and still pass the
 * two hosts' own suites, because each host only ever renders one of the two
 * tables. So the table is what varies here, and nothing else.
 */
import { describe, expect, it, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, renderHook } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { TooltipProvider } from '@/layers/shared/ui';
import type { MessageAuthor } from '@/layers/shared/model';
import type { EntryAction } from '@/layers/features/entry-actions';
import { Reply } from 'lucide-react';
import { useConversation } from '../model/conversation-context';
import type { ConversationCapabilities } from '../model/capabilities';
import { Conversation, Message } from '../index';

// The run-with menu reaches for the router and the session/runtime queries. The
// question here is whether the row OFFERS it, so the menu itself is stubbed to
// something observable, exactly as the chat suites stub it.
vi.mock('../../entry-actions/ui/EntryRunWithMenu', () => ({
  EntryRunWithMenu: () => <button type="button" data-entry-action="run-with" />,
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(cleanup);

const AUTHOR: MessageAuthor = { id: 'author-ana', kind: 'human', displayName: 'Ana' };
const AT = '2026-08-18T09:45:00.000Z';

/** Everything off. Each case turns on exactly the flag it is about. */
const NOTHING: ConversationCapabilities = {
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

/** A command that does nothing, for a row that needs to offer something. */
const REPLY: EntryAction = { id: 'reply', label: 'Reply in thread', icon: Reply, run: () => {} };

/** The pills a reacted-to message would draw. */
const REACTION = { emoji: '👍', authorIds: ['author-kai'], firstAt: AT };

/** One whole row, rendered inside a conversation with the given capabilities. */
function renderRow(
  capabilities: Partial<ConversationCapabilities>,
  options: { anchor?: 'corner' | 'rail'; actions?: EntryAction[] } = {}
) {
  return render(
    <TooltipProvider>
      <Conversation.Root
        surface="room"
        capabilities={{ ...NOTHING, ...capabilities }}
        anchor={options.anchor ?? 'rail'}
      >
        <Message.Root position="first" actions={options.actions}>
          <Message.Gutter author={AUTHOR} at={AT} />
          <Message.Body>
            <Message.Author id="author-line" author={AUTHOR} at={AT} />
            <Message.Content id="content">what happened to the build?</Message.Content>
            <Message.Attachments
              items={[
                {
                  id: 'att-1',
                  name: 'log.txt',
                  mimeType: 'text/plain',
                  size: 12,
                  preview: null,
                  url: '/api/rooms/r/attachments/att-1',
                },
              ]}
            />
            <Message.Reactions
              reactions={[REACTION]}
              viewerAuthorId="author-you"
              names={new Map([['author-kai', 'Kai']])}
              frequents={['👍']}
              onToggle={() => {}}
              onExit={() => {}}
            />
            <Message.Actions
              actions={options.actions}
              reactions={{ quick: ['👍'], mine: [], onToggle: () => {} }}
              runWith={{ prompt: 'ship it', sessionId: 'sess-1' }}
              onExit={() => {}}
            />
          </Message.Body>
        </Message.Root>
      </Conversation.Root>
    </TooltipProvider>
  );
}

/** The `data-slot` names present in the rendered row. */
function slots(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-slot]')].map(
    (el) => el.getAttribute('data-slot') ?? ''
  );
}

describe('Message.* — what a row offers comes from its capabilities', () => {
  it('draws no reactions at all where the conversation has none', () => {
    const { container } = renderRow({ reactions: false });

    // The pills, not merely the slot: a row that rendered the pill row and hid
    // it would still be offering a reaction nobody can act on.
    expect(container.querySelector('[data-slot="message-reactions"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /React with/ })).toBeNull();
  });

  it('draws them where it does', () => {
    const { container } = renderRow({ reactions: true });

    expect(container.querySelector('[data-slot="message-reactions"]')).not.toBeNull();
    expect(screen.getAllByRole('button', { name: /React with/ }).length).toBeGreaterThan(0);
  });

  it('withholds "run this with…" where the conversation does not offer it', () => {
    const { container } = renderRow({ runWith: false });

    expect(container.querySelector('[data-entry-action="run-with"]')).toBeNull();
  });

  it('offers it where it does', () => {
    const { container } = renderRow({ runWith: true });

    expect(container.querySelector('[data-entry-action="run-with"]')).not.toBeNull();
  });

  it('stamps every part with its own data-slot', () => {
    // The names browser tests and the design system's per-area rules target. A
    // part that lost its slot is a part nothing can be aimed at by name.
    const { container } = renderRow({ reactions: true, runWith: true });

    expect(slots(container)).toEqual(
      expect.arrayContaining([
        'message-root',
        'message-gutter',
        'message-author',
        'message-body',
        'message-content',
        'message-attachments',
        'message-reactions',
        'message-actions',
      ])
    );
  });

  it('holds the capsule differently under each anchor, from the one variant call', () => {
    // `anchor` carries the whole visual difference between the two rows, and it
    // is the reason neither of them needs to know which surface it is on.
    const corner = renderRow({}, { anchor: 'corner', actions: [REPLY] });
    const cornerClass =
      corner.container.querySelector('[data-slot="message-actions"]')?.className ?? '';
    cleanup();
    const rail = renderRow({}, { anchor: 'rail', actions: [REPLY] });
    const railClass =
      rail.container.querySelector('[data-slot="message-actions"]')?.className ?? '';

    expect(cornerClass).not.toBe(railClass);
    // The rail is a real band the capsule rides; the corner contributes no box
    // at all, because the capsule is positioned against the row itself.
    expect(railClass).toContain('sticky');
    expect(cornerClass).toBe('contents');
  });

  it('offers the touch screen reader its way in only where there are commands', () => {
    // `run-with` keeps a tab stop of its own, so a capsule holding only that one
    // is already reachable; the sr-only button exists for the roving commands.
    const withCommands = renderRow({}, { actions: [REPLY] });
    expect(withCommands.getByTestId('entry-actions-reach')).toBeInTheDocument();
    cleanup();

    const runWithOnly = renderRow({ runWith: true });
    expect(runWithOnly.queryByTestId('entry-actions-reach')).toBeNull();
  });
});

describe('useConversation', () => {
  it('refuses to answer outside a Conversation.Root', () => {
    // A part that got a default here would render half-configured and look
    // fine — which is exactly the failure this throw exists to make loud.
    expect(() => renderHook(() => useConversation())).toThrowError(/inside a <Conversation.Root>/);
  });

  it('answers what the host declared', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Conversation.Root surface="dm" capabilities={{ ...NOTHING, reactions: true }} anchor="rail">
        {children}
      </Conversation.Root>
    );
    const { result } = renderHook(() => useConversation(), { wrapper });

    expect(result.current.surface).toBe('dm');
    expect(result.current.capabilities.reactions).toBe(true);
    expect(result.current.anchor).toBe('rail');
    // Nothing has a composer yet — P4 mounts one, and until then a host says so
    // rather than handing down a stub whose `send` would throw.
    expect(result.current.target).toBeNull();
  });
});
