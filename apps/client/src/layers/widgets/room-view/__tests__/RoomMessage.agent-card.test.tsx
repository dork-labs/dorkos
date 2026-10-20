// @vitest-environment jsdom
/**
 * An agent's card over its face and name in a room, with the DM view on
 * (DOR-3074): a click opens it, and its Message opens the agent's DM. With the
 * view off, the face is today's door to the profile and nothing else.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { agentAuthorRef, type RoomEntry } from '@dorkos/shared/room-schemas';
import { useRoomDraftStore, useRoomOpenThreadStore } from '@/layers/entities/room';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import {
  buildProfileDeepLinkHarness,
  type ProfileDeepLinkHarness,
} from '@/test-helpers/profile-deep-link';
import { agentFacesByRef, type RosterAgentInfo } from '../lib/agent-details';
import { toMessageAuthor, type RosterAuthor } from '../lib/room-timeline';
import { AgentInfoProvider, type RoomAgentDirectory } from '../model/agent-info-context';
import { RoomMessage } from '../ui/RoomMessage';
import { useRoomAgentCard, type RoomAgentCard } from '../ui/identity/room-agent-card';
import { renderHook } from '@testing-library/react';
import { Conversation } from '@/layers/features/conversation';
import { ROOM_CAPABILITIES } from '../model/room-capabilities';

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

let harness: ProfileDeepLinkHarness;

beforeEach(() => {
  harness = buildProfileDeepLinkHarness();
});

afterEach(() => {
  cleanup();
  useRoomDraftStore.setState({ drafts: {} });
  useRoomOpenThreadStore.setState({ open: {} });
});

/** Where the benched agent lives — both halves of the fleet join derive from it. */
const WARDEN_PATH = '/w/warden';
const WARDEN_REF = agentAuthorRef(WARDEN_PATH);

/** The two id spaces, spelled out so the assertions read as what they are. */
const ANA_AUTHOR_ID = 'author-ana';
const WARDEN_AUTHOR_ID = 'author-warden';
const WARDEN_MEMBER_ID = '01JWARDENREGISTRYULID';

const ANA: RosterAuthor = {
  id: ANA_AUTHOR_ID,
  kind: 'human',
  displayName: 'Ana',
  handle: 'ana',
  origin: 'local',
};

const WARDEN: RosterAuthor = {
  id: WARDEN_AUTHOR_ID,
  kind: 'agent',
  displayName: 'Warden',
  handle: 'warden',
  color: '#6d5ae0',
  agentRef: WARDEN_REF,
  origin: 'local',
};

/** Whoever is reading, when the case is not about them. Never rendered. */
const VIEWER_AUTHOR_ID = 'author-viewer';

const AUTHORS = new Map<string, RosterAuthor>([
  [ANA_AUTHOR_ID, ANA],
  [WARDEN_AUTHOR_ID, WARDEN],
]);

const FLEET_INFO: ReadonlyMap<string, RosterAgentInfo> = new Map([
  [
    WARDEN_REF,
    {
      memberId: WARDEN_MEMBER_ID,
      visual: { color: '#6d5ae0', emoji: '🛡️' },
      runtime: 'Claude Code',
      model: 'opus',
    },
  ],
]);

const FLEET: RoomAgentDirectory = { info: FLEET_INFO, faces: agentFacesByRef(FLEET_INFO) };

function entry(authorId: string, text = 'shipped it'): RoomEntry {
  const at = text.indexOf('@warden');
  const spans =
    at === -1 ? [] : [{ offset: at, length: '@warden'.length, authorId: WARDEN_AUTHOR_ID }];
  return {
    roomId: 'room-1',
    seq: 1,
    id: 'entry-1',
    authorId,
    kind: 'post',
    body: { text },
    mentions: spans.map((span) => span.authorId),
    mentionSpans: spans,
    sessionId: null,
    cascadeRoot: 'entry-1',
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-26T10:00:00.000Z',
  };
}

/** Mount one row, with the DM view on or off. */
function renderRow(author: RosterAuthor, dmView: boolean, text?: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      version: '1.0.0',
      experiments: [
        { key: 'ui.dmView', title: '', description: '', enabled: dmView, lockedByEnv: false },
      ],
    }),
    listMeshAgentPaths: vi
      .fn()
      .mockResolvedValue({ agents: [{ id: WARDEN_MEMBER_ID, projectPath: WARDEN_PATH }] }),
    openDirectChat: vi.fn().mockResolvedValue({
      sessionId: 'warden-direct',
      sessionIds: ['warden-direct'],
      roomId: 'dm-warden',
      agentPath: WARDEN_PATH,
    }),
  });
  render(
    <RoomMessage
      roomId="room-1"
      entry={entry(author.id, text)}
      author={toMessageAuthor(author.id, AUTHORS, FLEET.faces)}
      authorRef={author}
      authors={AUTHORS}
      viewerAuthorId={VIEWER_AUTHOR_ID}
      authorNames={new Map([[author.id, author.displayName]])}
      reactionFrequents={[]}
      grouping={{ position: 'only' }}
    />,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>
            <TooltipProvider>
              <harness.Wrapper>
                <AgentInfoProvider known={FLEET}>
                  <Conversation.Root surface="room" capabilities={ROOM_CAPABILITIES} anchor="rail">
                    {children}
                  </Conversation.Root>
                </AgentInfoProvider>
              </harness.Wrapper>
            </TooltipProvider>
          </TransportProvider>
        </QueryClientProvider>
      ),
    }
  );
  return { transport };
}

describe('RoomMessage with the DM view on', () => {
  it('opens the agent’s card from a click on its face, and Message opens its DM', async () => {
    const { transport } = renderRow(WARDEN, true);

    const face = await waitFor(() => {
      const found = document.querySelector('[data-slot="room-agent-card-face"]');
      if (!found) throw new Error('no card over the face yet');
      return found as HTMLElement;
    });
    await userEvent.click(face);
    await userEvent.click(await screen.findByRole('button', { name: 'Message' }));

    await waitFor(() =>
      expect(transport.openDirectChat).toHaveBeenCalledWith({ agentPath: WARDEN_PATH })
    );
  });

  it('opens the same card from a click on its name, with Profile beside Message', async () => {
    renderRow(WARDEN, true);

    await waitFor(() =>
      expect(document.querySelector('[data-slot="room-agent-card-face"]')).not.toBeNull()
    );
    const author = document.querySelector('[data-slot="message-author"]') as HTMLElement;
    await userEvent.click(author.firstElementChild as HTMLElement);

    expect(await screen.findByRole('button', { name: 'Message' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Profile' })).toBeInTheDocument();
  });

  it('leaves a person’s face exactly as it was', async () => {
    renderRow(ANA, true);

    await waitFor(() =>
      expect(document.querySelector('[data-slot="message-author-avatar"]')).not.toBeNull()
    );
    expect(document.querySelector('[data-slot="room-agent-card-face"]')).toBeNull();
  });
});

describe('RoomMessage with the DM view on, by keyboard', () => {
  it('makes the face and the name buttons named for the agent that open a dialog', async () => {
    renderRow(WARDEN, true);

    await waitFor(() =>
      expect(
        screen
          .getAllByRole('button', { name: 'Warden' })
          .filter((button) => button.getAttribute('aria-haspopup') === 'dialog')
      ).toHaveLength(2)
    );
    // The name is the tab stop; the face stays out of the tab order, as faces do.
    const face = document.querySelector('[data-slot="room-agent-card-face"]');
    expect(face).toHaveAttribute('tabindex', '-1');
    expect(document.querySelector('[data-slot="room-agent-card-name"]')).not.toHaveAttribute(
      'tabindex'
    );
  });

  it('opens the card on Enter, steps in to Message, moves on with the arrows, and Escape returns', async () => {
    const user = userEvent.setup();
    renderRow(WARDEN, true);
    await waitFor(() =>
      expect(document.querySelector('[data-slot="room-agent-card-name"]')).not.toBeNull()
    );
    const name = document.querySelector('[data-slot="room-agent-card-name"]') as HTMLElement;

    name.focus();
    await user.keyboard('{Enter}');

    const dialog = await screen.findByRole('dialog', { name: 'Warden' });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Message' })).toHaveFocus()
    );
    await user.keyboard('{ArrowRight}');
    expect(within(dialog).getByRole('button', { name: 'Profile' })).toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(name).toHaveFocus();
  });

  it('names a mention for who it is and opens the same card from it', async () => {
    const user = userEvent.setup();
    renderRow(ANA, true, 'ping @warden about it');

    const pill = await waitFor(() => {
      const found = document.querySelector('[aria-haspopup="dialog"][role="button"]');
      if (!found) throw new Error('no card on the mention yet');
      return found as HTMLElement;
    });
    expect(pill).not.toHaveAttribute('aria-label', 'View Warden’s profile');

    pill.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Warden' })).toBeInTheDocument();
  });
});

describe('RoomMessage with the DM view off', () => {
  it('draws no card: the face stays the door to the profile', async () => {
    renderRow(WARDEN, false);

    const face = await waitFor(() => {
      const found = document.querySelector('[data-slot="message-author-avatar"]');
      if (!found) throw new Error('no face yet');
      return found as HTMLElement;
    });
    expect(face).toHaveAttribute('role', 'button');
    expect(document.querySelector('[data-slot="room-agent-card-face"]')).toBeNull();
  });
});

describe('useRoomAgentCard', () => {
  it('keeps its wrappers across re-renders while the agent stays the same', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const transport = createMockTransport({
      getConfig: vi.fn().mockResolvedValue({
        version: '1.0.0',
        experiments: [
          { key: 'ui.dmView', title: '', description: '', enabled: true, lockedByEnv: false },
        ],
      }),
      listMeshAgentPaths: vi
        .fn()
        .mockResolvedValue({ agents: [{ id: WARDEN_MEMBER_ID, projectPath: WARDEN_PATH }] }),
    });
    const identity = { kind: 'agent' as const, displayName: 'Warden' };
    const { result, rerender } = renderHook(
      () => useRoomAgentCard({ agentRef: WARDEN_REF, identity }),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={queryClient}>
            <TransportProvider transport={transport}>
              <AgentInfoProvider known={FLEET}>{children}</AgentInfoProvider>
            </TransportProvider>
          </QueryClientProvider>
        ),
      }
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    const first: RoomAgentCard | null = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
