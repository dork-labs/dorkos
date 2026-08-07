// @vitest-environment jsdom
/**
 * What a mention's hover card says about an AGENT, end to end.
 *
 * `RoomEntryRow.mentions.test.tsx` pins that a pill's identity comes from the
 * roster and nowhere else. This pins the half the roster cannot answer: a room
 * is never told how an agent runs (ADR 260726-170126 keeps even its path off
 * the wire), so the runtime and model on the card come from the fleet's own
 * manifests, joined on `agentRef`. The claim under test is that the join
 * actually reaches the card — and that an agent the fleet cannot account for
 * gets NO chip rather than a placeholder one.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { agentAuthorRef } from '@dorkos/shared/room-schemas';
import type { RoomEntry, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { RoomTimeline } from '../ui/RoomTimeline';

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

/** Where the agent behind `@bo` lives — the path both sides derive its handle from. */
const BO_PATH = '/w/bo';

const MEMBERS: RoomRosterEntry[] = [
  {
    roomId: 'room-1',
    authorId: 'ana',
    responseMode: 'always',
    joinedAt: '2026-08-06T09:00:00.000Z',
    lastReadSeq: 0,
    origin: 'local',
    author: { id: 'ana', kind: 'human', displayName: 'Ana', mentionHandle: 'ana' },
  },
  {
    roomId: 'room-1',
    authorId: 'bo',
    responseMode: 'always',
    joinedAt: '2026-08-06T09:00:00.000Z',
    lastReadSeq: 0,
    origin: 'local',
    author: {
      id: 'bo',
      kind: 'agent',
      displayName: 'Bo',
      mentionHandle: 'bo',
      agentRef: agentAuthorRef(BO_PATH),
    },
  },
];

/** One message that mentions Bo, spanned by the server exactly as it would be. */
const TEXT = 'cc @bo';
const ENTRY: RoomEntry = {
  roomId: 'room-1',
  seq: 1,
  id: 'entry-1',
  authorId: 'ana',
  kind: 'post',
  body: { text: TEXT },
  mentions: ['bo'],
  mentionSpans: [{ offset: TEXT.indexOf('@bo'), length: 3, authorId: 'bo' }],
  sessionId: null,
  cascadeRoot: 'entry-1',
  cascadeDepth: 0,
  parentEntryId: null,
  threadRootEntryId: null,
  signature: null,
  createdAt: '2026-08-06T10:00:00.000Z',
};

function renderTimeline(overrides: Partial<Transport>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <RoomTimeline
      roomId="room-1"
      roomName="general"
      viewerAuthorId="ana"
      entries={[ENTRY]}
      members={MEMBERS}
      lastReadSeq={null}
      reactionFrequents={['👍', '❤️', '🎉']}
      isLoading={false}
      error={null}
      onAddAgents={vi.fn()}
      onOpenThread={vi.fn()}
    />,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={createMockTransport(overrides)}>
            <TooltipProvider>{children}</TooltipProvider>
          </TransportProvider>
        </QueryClientProvider>
      ),
    }
  );
}

/** The mention pill inside the message body — see `RoomEntryRow.mentions.test.tsx` for why it is queried this way. */
function pill(): HTMLElement {
  const content = document.querySelector('[data-slot="message-content"]') as HTMLElement;
  return content.querySelector('[data-kind]') as HTMLElement;
}

/** Open the card over the mention and wait for it to be there. */
async function openCard() {
  const user = userEvent.setup();
  await user.hover(pill());
  await screen.findByText('View profile');
}

describe('mention hover card — agent details', () => {
  it('names the runtime and model the fleet holds for the agent mentioned', async () => {
    renderTimeline({
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [{ projectPath: BO_PATH }] }),
      resolveAgents: vi
        .fn()
        .mockResolvedValue({ [BO_PATH]: { runtime: 'claude-code', model: 'opus' } }),
    });

    // The pill is drawn from the roster immediately and the fleet answers
    // afterwards, so this deliberately hovers first and then waits: it is the
    // exact order that used to fail. Streamdown keeps the render it already
    // produced for a block, so an answer arriving as a PROP never reached the
    // pill at all and the card stayed bare for as long as the room was open.
    await screen.findByText('Bo');
    await openCard();

    expect(await screen.findByText('Claude Code · opus')).toBeInTheDocument();
  });

  it('draws the runtime alone for an agent that inherits its runtime default model', async () => {
    // "Inherits the default" is a fact this client does not have — the default
    // is the server's, per runtime — so the model half is left off rather than
    // guessed at.
    renderTimeline({
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [{ projectPath: BO_PATH }] }),
      resolveAgents: vi.fn().mockResolvedValue({ [BO_PATH]: { runtime: 'codex' } }),
    });

    await screen.findByText('Bo');
    await openCard();

    expect(await screen.findByText('Codex')).toBeInTheDocument();
    expect(screen.queryByText(/·/)).not.toBeInTheDocument();
  });

  it('shows the card with no chips at all when the fleet cannot account for the agent', async () => {
    // The degradation that must never become a placeholder: mesh knows of no
    // such agent, so nothing is drawn about how it runs — and the card is still
    // there, still naming who was mentioned.
    renderTimeline({
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [] }),
      resolveAgents: vi.fn().mockResolvedValue({}),
    });

    await screen.findByText('Bo');
    await openCard();

    const card = document.querySelector('[data-slot="identity-hover-card"]') as HTMLElement;
    expect(card).toHaveTextContent('@bo');
    expect(card).not.toHaveTextContent('Claude Code');
    expect(card).not.toHaveTextContent('Codex');
    expect(card).not.toHaveTextContent('Unknown');
  });

  it('leaves the agent undecorated when the manifests could not be read', async () => {
    // A failed resolve costs the extra line and nothing else — the mention, the
    // name and the handle are all still the roster's, which never needed the
    // fleet to answer.
    renderTimeline({
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [{ projectPath: BO_PATH }] }),
      resolveAgents: vi.fn().mockRejectedValue(new Error('500')),
    });

    await screen.findByText('Bo');
    await openCard();

    const card = document.querySelector('[data-slot="identity-hover-card"]') as HTMLElement;
    expect(card).toHaveTextContent('@bo');
    expect(card).not.toHaveTextContent('Claude Code');
  });
});
