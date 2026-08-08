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
 *
 * **Absence is asserted structurally, on the card's own chip row, never as a
 * missing string.** "Does not contain 'Claude Code'" is satisfied by any
 * placeholder that happens to say something else — a seeded `{ runtime:
 * 'Unknown' }` passed every test in this file when they were written that way.
 * `chipRow` is what makes the assertion about chips rather than about wording.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import {
  render,
  screen,
  cleanup,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { agentAuthorRef } from '@dorkos/shared/room-schemas';
import type { RoomEntry, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { RoomTimeline } from '../ui/RoomTimeline';

// A mention pill now reads route state to build its profile link
// (`useProfileDeepLink`), and these tests mount it with no router. The link's
// own behaviour has a dedicated file — `RoomEntryRow.click-to-profile.test.tsx`,
// which mounts a real router and asserts the id that travels. Here it is stubbed
// so the pill renders, which is what this file is actually about.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useProfileDeepLink: () => ({
      isOpen: false,
      memberId: null,
      open: vi.fn(),
      close: vi.fn(),
    }),
  };
});

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

/** Where each agent lives — the path both sides derive its handle from. */
const BO_PATH = '/w/bo';
const GONE_PATH = '/w/gone';

function agentMember(id: string, displayName: string, path: string): RoomRosterEntry {
  return {
    roomId: 'room-1',
    authorId: id,
    responseMode: 'always',
    joinedAt: '2026-08-06T09:00:00.000Z',
    joinedSeq: 0,
    lastReadSeq: 0,
    origin: 'local',
    author: {
      id,
      kind: 'agent',
      displayName,
      handle: id,
      agentRef: agentAuthorRef(path),
    },
  };
}

const MEMBERS: RoomRosterEntry[] = [
  {
    roomId: 'room-1',
    authorId: 'ana',
    responseMode: 'always',
    joinedAt: '2026-08-06T09:00:00.000Z',
    joinedSeq: 0,
    lastReadSeq: 0,
    origin: 'local',
    author: { id: 'ana', kind: 'human', displayName: 'Ana', handle: 'ana' },
  },
  agentMember('bo', 'Bo', BO_PATH),
  agentMember('gone', 'Gone', GONE_PATH),
];

/** One message mentioning both agents, spanned by the server exactly as it would be. */
const TEXT = 'cc @bo and @gone';
const ENTRY: RoomEntry = {
  roomId: 'room-1',
  seq: 1,
  id: 'entry-1',
  authorId: 'ana',
  kind: 'post',
  body: { text: TEXT },
  mentions: ['bo', 'gone'],
  mentionSpans: [
    { offset: TEXT.indexOf('@bo'), length: '@bo'.length, authorId: 'bo' },
    { offset: TEXT.indexOf('@gone'), length: '@gone'.length, authorId: 'gone' },
  ],
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
  render(
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

/** A resolved mention pill by the name it drew — see `RoomEntryRow.mentions.test.tsx` for why it is queried this way. */
function pillFor(displayName: string): HTMLElement {
  const content = document.querySelector('[data-slot="message-content"]') as HTMLElement;
  const found = [...content.querySelectorAll<HTMLElement>('[data-kind]')].find(
    (candidate) => candidate.textContent === displayName
  );
  if (!found) throw new Error(`fixture error: no resolved mention pill for "${displayName}"`);
  return found;
}

/** The open identity card. */
function card(): HTMLElement {
  return document.querySelector('[data-slot="identity-hover-card"]') as HTMLElement;
}

/**
 * The card's row of fact chips, found by what it is NOT.
 *
 * The card is three stacked rows — the identity header (which holds the
 * avatar), the chips, and the footer (which holds "View profile") — and only
 * the outermost carries a `data-slot`. Selecting the chip row by elimination
 * keeps this test off the card's class names and, more importantly, makes
 * "no chips" an assertion about the row's CHILDREN rather than about which
 * words happen to be missing.
 */
function chipRow(): HTMLElement {
  const row = [...card().children].find(
    (child) =>
      child.querySelector('[data-slot="identity-avatar"]') === null &&
      !child.textContent?.includes('View profile')
  );
  if (!row) throw new Error('the identity card no longer has a chip row');
  return row as HTMLElement;
}

/** Hover a pill and wait for its card. */
async function openCardOn(user: UserEvent, displayName: string) {
  await user.hover(pillFor(displayName));
  await screen.findByText('View profile');
}

/** Close whatever card is open, so the next one can be opened cleanly. */
async function closeCard(user: UserEvent, displayName: string) {
  await user.unhover(pillFor(displayName));
  await waitForElementToBeRemoved(() => screen.queryByText('View profile'));
}

describe('mention hover card — agent details', () => {
  it('names the runtime and model the fleet holds for the agent mentioned', async () => {
    const user = userEvent.setup();
    renderTimeline({
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [{ projectPath: BO_PATH }] }),
      resolveAgents: vi
        .fn()
        .mockResolvedValue({ [BO_PATH]: { runtime: 'claude-code', model: 'opus' } }),
    });

    // The pill is drawn from the roster immediately and the fleet answers
    // afterwards, so this deliberately hovers first and then waits: it is the
    // exact order that used to fail. Streamdown's top-level memo comparator
    // (2.5.0) does not include `components`, so a rebuilt component map
    // re-renders nothing below it — an answer arriving as a PROP never reached
    // the pill at all and the card stayed bare for as long as the room was
    // open.
    await openCardOn(user, 'Bo');

    await waitFor(() => expect(chipRow().children).toHaveLength(1));
    expect(within(chipRow()).getByText('Claude Code · opus')).toBeInTheDocument();
  });

  it('draws the runtime alone for an agent that inherits its runtime default model', async () => {
    // "Inherits the default" is a fact this client does not have — the default
    // is the server's, per runtime — so the model half is left off rather than
    // guessed at. One chip, and it says only the runtime.
    const user = userEvent.setup();
    renderTimeline({
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [{ projectPath: BO_PATH }] }),
      resolveAgents: vi.fn().mockResolvedValue({ [BO_PATH]: { runtime: 'codex' } }),
    });

    await openCardOn(user, 'Bo');

    await waitFor(() => expect(chipRow().children).toHaveLength(1));
    expect(within(chipRow()).getByText('Codex')).toBeInTheDocument();
  });

  it('draws no chip for an agent the fleet has no manifest for', async () => {
    // The null-manifest branch, run for real: mesh knows both directories and
    // `resolveAgents` answers `null` for one of them.
    //
    // **Bo is the settle proof.** Asserting an absence against a render that
    // has not finished is a test that passes for the wrong reason forever, so
    // the resolved agent's chip is checked FIRST in the same render — once it
    // is on screen, the fleet has answered for both, and Gone's empty chip row
    // is a statement rather than a race.
    const user = userEvent.setup();
    renderTimeline({
      listMeshAgentPaths: vi
        .fn()
        .mockResolvedValue({ agents: [{ projectPath: BO_PATH }, { projectPath: GONE_PATH }] }),
      resolveAgents: vi.fn().mockResolvedValue({
        [BO_PATH]: { runtime: 'claude-code', model: 'opus' },
        [GONE_PATH]: null,
      }),
    });

    await openCardOn(user, 'Bo');
    await waitFor(() => expect(within(chipRow()).getByText('Claude Code · opus')).toBeVisible());
    await closeCard(user, 'Bo');

    await openCardOn(user, 'Gone');
    // Structural: no chips at all, whatever a placeholder might have said.
    expect(chipRow().children).toHaveLength(0);
    expect(card()).toHaveTextContent('@gone');
  });

  it('leaves an agent undecorated when the manifests could not be read', async () => {
    // A failed resolve costs the extra chip and nothing else — the mention, the
    // name and the handle are all still the roster's, which never needed the
    // fleet to answer. `retry: false` makes the rejection terminal, so once it
    // has been called and settled there is nothing left to arrive.
    const resolveAgents = vi.fn().mockRejectedValue(new Error('500'));
    const user = userEvent.setup();
    renderTimeline({
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [{ projectPath: BO_PATH }] }),
      resolveAgents,
    });

    await waitFor(() => expect(resolveAgents).toHaveBeenCalled());
    await openCardOn(user, 'Bo');

    expect(chipRow().children).toHaveLength(0);
    expect(card()).toHaveTextContent('@bo');
  });
});
