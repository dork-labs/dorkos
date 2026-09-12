// @vitest-environment jsdom
/**
 * A `dorkos-ui` widget fence, drawn inside a real room message.
 *
 * Chat has rendered these as native widgets since ADR `260708-111500`; a room
 * showed the same fence as a wall of JSON in a code block, because the room's
 * body renderer registered no fence renderer at all. What these tests pin is
 * not "a widget appears" — it is the ROOM's version of the contract: the
 * widget is read-only, because a room message has no session for an
 * `agent`-kind control to post into, while `ui` and `url` controls are as live
 * here as they are in chat — with one line drawn through the `ui` half: a
 * command that needs a session (canvas, browser, file, diff, terminal, PiP,
 * agent switching, layout) is inert here too, because a room message can come
 * from an agent the reader does not run or be relayed in from a bridged
 * Telegram or Slack room, and firing one would write into whichever session the
 * READER happens to have open (DOR-1997). And the two things a room body
 * already had to do — draw its mention pills, and survive a body it cannot
 * parse — must both survive the fence sharing the message with them.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { MentionSpan, RoomEntry } from '@dorkos/shared/room-schemas';
import { useRoomDraftStore, useRoomOpenThreadStore } from '@/layers/entities/room';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import type { RosterAuthor } from '../lib/room-timeline';
import { RoomMessage } from '../ui/RoomMessage';
import { Conversation } from '@/layers/features/conversation';
import { ROOM_CAPABILITIES } from '../model/room-capabilities';

// The row reads route state to decide where its author face and its mention
// pills lead (`useProfileDeepLink`), and this file mounts it with no router.
// Where those links go has its own file (`RoomMessage.click-to-profile.test.tsx`);
// here it is stubbed so the row renders, which is what this file is about.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useProfileDeepLink: () => ({ isOpen: false, memberId: null, open: vi.fn(), close: vi.fn() }),
  };
});

const transport = createMockTransport();

afterEach(() => {
  cleanup();
  useRoomDraftStore.setState({ drafts: {} });
  useRoomOpenThreadStore.setState({ open: {} });
  useAppStore.setState({ settingsOpen: false, rightPanelOpen: false, canvasOpen: false });
  // Call history only — `mockRestore` would strip the mock transport's own
  // implementations, which are shared across this file's tests.
  vi.clearAllMocks();
});

/** The room's roster — a resolved mention draws its identity from here. */
const AUTHORS = new Map<string, RosterAuthor>([
  ['ana', { id: 'ana', kind: 'human', displayName: 'Ana', handle: 'ana', origin: 'local' }],
  [
    'bo',
    {
      id: 'bo',
      kind: 'agent',
      displayName: 'Bo',
      handle: 'bo',
      color: '#7c9cf5',
      origin: 'local',
    },
  ],
]);

function entry(text: string, mentionSpans?: MentionSpan[]): RoomEntry {
  return {
    roomId: 'room-1',
    seq: 1,
    id: 'entry-1',
    authorId: 'ana',
    kind: 'post',
    body: { text },
    mentions: mentionSpans?.map((span) => span.authorId) ?? [],
    ...(mentionSpans ? { mentionSpans } : {}),
    sessionId: null,
    cascadeRoot: 'entry-1',
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-26T10:00:00.000Z',
  };
}

/** One span, positioned by slicing `text` so a test cannot mistype an offset. */
function spanFor(text: string, needle: string, authorId: string): MentionSpan {
  const offset = text.indexOf(needle);
  if (offset === -1) throw new Error(`fixture error: "${needle}" is not in "${text}"`);
  return { offset, length: needle.length, authorId };
}

function renderRow(target: RoomEntry) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <RoomMessage
      roomId="room-1"
      entry={target}
      author={{ id: 'ana', kind: 'human', displayName: 'Ana' }}
      authorRef={AUTHORS.get('ana')}
      authors={AUTHORS}
      viewerAuthorId="ana"
      authorNames={new Map([['ana', 'Ana']])}
      reactionFrequents={['👍', '❤️', '🎉']}
      grouping={{ position: 'only' }}
    />,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>
            <TooltipProvider>
              {/* The same conversation the room mounts (`RoomSurface`). */}
              <Conversation.Root surface="room" capabilities={ROOM_CAPABILITIES} anchor="rail">
                {children}
              </Conversation.Root>
            </TooltipProvider>
          </TransportProvider>
        </QueryClientProvider>
      ),
    }
  );
}

/** The message body's own content region — where the fence renders. */
function content(): HTMLElement {
  return document.querySelector('[data-slot="message-content"]') as HTMLElement;
}

/** A message whose body wraps `document` in a `dorkos-ui` fence, with prose around it. */
function bodyWithFence(
  document: unknown,
  { before = 'Here you go:', after = 'Anything else?' } = {}
) {
  return [
    before,
    '',
    '```dorkos-ui',
    typeof document === 'string' ? document : JSON.stringify(document),
    '```',
    '',
    after,
  ].join('\n');
}

const STAT_WIDGET = {
  version: 1,
  title: 'Build health',
  root: { type: 'stat', label: 'Slowest step', value: 'typecheck' },
};

/** One `agent` control — the kind a room can show but never fire. */
const AGENT_BUTTON_WIDGET = {
  version: 1,
  title: 'Deploy',
  root: {
    type: 'button',
    label: 'Ship it',
    action: { kind: 'agent', id: 'ship', payload: { target: 'prod' } },
  },
};

describe('RoomMessage — dorkos-ui fences in a room body', () => {
  it('draws the fence as a widget rather than a code block', async () => {
    renderRow(entry(bodyWithFence(STAT_WIDGET)));

    // The widget itself, from the fence's own document.
    expect(await screen.findByText('Slowest step')).toBeInTheDocument();
    expect(screen.getByText('typecheck')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Build health' })).toBeInTheDocument();
    // Not the JSON. Before this renderer was registered the whole document
    // rendered verbatim inside a `<pre>`, which is the exact failure here.
    expect(content().querySelector('pre')).toBeNull();
    expect(content()).not.toHaveTextContent('"version"');
    // …and the prose on either side of it is untouched.
    expect(content()).toHaveTextContent('Here you go:');
    expect(content()).toHaveTextContent('Anything else?');
  });

  it('renders an `agent` control inert, with the off-session tooltip, and never posts', async () => {
    const user = userEvent.setup();
    renderRow(entry(bodyWithFence(AGENT_BUTTON_WIDGET)));

    const ship = await screen.findByRole('button', { name: 'Ship it' });
    // Inert via `aria-disabled` (not `disabled`) so it stays focusable and can
    // still explain itself — the gen-ui contract for an unavailable action.
    expect(ship).toHaveAttribute('aria-disabled', 'true');

    await user.hover(ship);
    // The tooltip the provider already shows off a session. A room message has
    // no session to POST into, so this is the honest sentence, not a new one.
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Interactions aren’t available here'
    );

    await user.click(ship);
    expect(transport.sendUiAction).not.toHaveBeenCalled();
  });

  it('fires a `ui` control — local commands work in a room', async () => {
    const user = userEvent.setup();
    expect(useAppStore.getState().settingsOpen).toBe(false);
    renderRow(
      entry(
        bodyWithFence({
          version: 1,
          title: 'Settings',
          root: {
            type: 'button',
            label: 'Open settings',
            action: { kind: 'ui', command: { action: 'open_panel', panel: 'settings' } },
          },
        })
      )
    );

    await user.click(await screen.findByRole('button', { name: 'Open settings' }));
    expect(useAppStore.getState().settingsOpen).toBe(true);
  });

  it('routes a `url` control through the link-safety modal', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderRow(
      entry(
        bodyWithFence({
          version: 1,
          title: 'Docs',
          root: {
            type: 'button',
            label: 'Open docs',
            action: { kind: 'url', href: 'https://dorkos.ai' },
          },
        })
      )
    );

    await user.click(await screen.findByRole('button', { name: 'Open docs' }));
    // Nothing opens straight from a room message — the confirmation comes first.
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /open external link/i })).toHaveTextContent(
      'https://dorkos.ai'
    );
    open.mockRestore();
  });

  it('falls back to the error card for a fence it cannot parse, and keeps the message', async () => {
    renderRow(entry(bodyWithFence('{ "version": 1, "root": { "type"')));

    expect(await screen.findByText('This widget couldn’t be rendered')).toBeInTheDocument();
    // The rest of the message is worth keeping — a broken widget costs the room
    // its widget, never the words around it or the row itself.
    expect(content()).toHaveTextContent('Here you go:');
    expect(content()).toHaveTextContent('Anything else?');
    expect(screen.getByTestId('room-entry')).toBeInTheDocument();
  });

  it('renders a session-shaped `ui` control inert — a room message cannot drive a canvas', async () => {
    // The probe this closes (DOR-1997 review): a `browser_navigate` button in a
    // room message wrote an arbitrary URL into whichever session's canvas the
    // reader had open, revealed the right panel on it, and asked nobody. The
    // widget is somebody else's words — possibly a stranger's, through a
    // bridged Telegram room — so the control is inert, like an `agent` one.
    const user = userEvent.setup();
    const openCanvasDocument = vi.spyOn(useAppStore.getState(), 'openCanvasDocument');

    renderRow(
      entry(
        bodyWithFence({
          version: 1,
          title: 'Preview',
          root: {
            type: 'button',
            label: 'Preview it',
            action: {
              kind: 'ui',
              command: { action: 'browser_navigate', url: 'https://evil.example/steal' },
            },
          },
        })
      )
    );

    const preview = await screen.findByRole('button', { name: 'Preview it' });
    expect(preview).toHaveAttribute('aria-disabled', 'true');
    await user.hover(preview);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Interactions aren’t available here'
    );

    await user.click(preview);
    expect(openCanvasDocument).not.toHaveBeenCalled();
    // And nothing reached the SERVER either. Since the canvas moved there (spec
    // `canvas-agent-seat` §1.5) the store's mutators write through, so a control
    // that got past the inert gate would put a stranger's URL on a table every
    // device of that session is drawing from.
    expect(transport.openSessionCanvasDocument).not.toHaveBeenCalled();
    expect(useAppStore.getState().canvasOpen).toBe(false);
    expect(useAppStore.getState().rightPanelOpen).toBe(false);
    // Restored here rather than in `afterEach`, which clears call history only
    // (a blanket restore would strip the mock transport's implementations).
    openCanvasDocument.mockRestore();
  });

  it('draws a mention pill and a widget in the same body', async () => {
    const before = 'over to you @bo —';
    const text = bodyWithFence(STAT_WIDGET, { before });
    renderRow(entry(text, [spanFor(text, '@bo', 'bo')]));

    // The pill resolved from the roster…
    const pill = content().querySelector('[data-kind], [data-resolved="false"]');
    expect(pill).toHaveAttribute('data-kind', 'agent');
    expect(pill).toHaveTextContent('Bo');
    // …and the widget below it, from the same single Streamdown pass.
    expect(await screen.findByText('Slowest step')).toBeInTheDocument();
    expect(content().querySelector('pre')).toBeNull();
  });
});
