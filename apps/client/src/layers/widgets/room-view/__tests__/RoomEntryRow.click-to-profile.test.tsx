// @vitest-environment jsdom
/**
 * Clicking a face in a room opens that identity's profile (DOR-957, spec
 * `identity-consistency` §W3.2).
 *
 * The claim under test is **which id travels**, not that something opened. A
 * room entry stores an AUTHOR id; the team roster the drawer reads is keyed by
 * author id for people and by MANIFEST id for agents. Passing the id a room
 * already has would open nothing at all for every agent mention in the product
 * — the drawer would find no row and close itself — and a test that only
 * asserted "the drawer opened" would have shipped exactly that.
 *
 * The answer is read off the URL — `?profile=<id>` is what `open()` writes, what
 * a reload reopens, and what a person shares.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { agentAuthorRef, type MentionSpan, type RoomEntry } from '@dorkos/shared/room-schemas';
import { useRoomDraftStore, useRoomOpenThreadStore } from '@/layers/entities/room';
import { TransportProvider } from '@/layers/shared/model';
import {
  buildProfileDeepLinkHarness,
  type ProfileDeepLinkHarness,
} from '@/test-helpers/profile-deep-link';
import { TooltipProvider } from '@/layers/shared/ui';
import { agentFacesByRef, type RosterAgentInfo } from '../lib/agent-details';
import type { RosterAuthor } from '../lib/room-timeline';
import { AgentInfoProvider, type RoomAgentDirectory } from '../model/agent-info-context';
import { RoomEntryRow } from '../ui/RoomEntryRow';

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

/**
 * The ids that must not be confused, spelled out so the assertions below read
 * as the two id spaces they actually are.
 */
const ANA_AUTHOR_ID = 'author-ana';
const WARDEN_AUTHOR_ID = 'author-warden';
const WARDEN_MEMBER_ID = '01JWARDENREGISTRYULID';

const AUTHORS = new Map<string, RosterAuthor>([
  [
    ANA_AUTHOR_ID,
    { id: ANA_AUTHOR_ID, kind: 'human', displayName: 'Ana', handle: 'ana', origin: 'local' },
  ],
  [
    WARDEN_AUTHOR_ID,
    {
      id: WARDEN_AUTHOR_ID,
      kind: 'agent',
      displayName: 'Warden',
      handle: 'warden',
      color: '#6d5ae0',
      agentRef: WARDEN_REF,
      origin: 'local',
    },
  ],
]);

/** The fleet, as the room's own provider would have resolved it. */
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

/** The same answer in the shape the provider takes: how each agent runs, and its face. */
const FLEET: RoomAgentDirectory = {
  info: FLEET_INFO,
  faces: agentFacesByRef(FLEET_INFO),
};

/** A fleet that answered nothing — an unreachable mesh, or a manifest that would not read. */
const NO_FLEET: RoomAgentDirectory = { info: new Map(), faces: new Map() };

function entry(text: string, mentionSpans: MentionSpan[]): RoomEntry {
  return {
    roomId: 'room-1',
    seq: 1,
    id: 'entry-1',
    authorId: ANA_AUTHOR_ID,
    kind: 'post',
    body: { text },
    mentions: mentionSpans.map((s) => s.authorId),
    mentionSpans,
    sessionId: null,
    cascadeRoot: 'entry-1',
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-26T10:00:00.000Z',
  };
}

/** One span, positioned by slicing `text` so a fixture cannot mistype an offset. */
function spanFor(text: string, needle: string, authorId: string): MentionSpan {
  const offset = text.indexOf(needle);
  if (offset === -1) throw new Error(`fixture error: "${needle}" is not in "${text}"`);
  return { offset, length: needle.length, authorId };
}

function renderMention(text: string, spans: MentionSpan[], fleet: RoomAgentDirectory = FLEET) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <RoomEntryRow
      roomId="room-1"
      entry={entry(text, spans)}
      author={{ id: ANA_AUTHOR_ID, kind: 'human', displayName: 'Ana' }}
      authorRef={AUTHORS.get(ANA_AUTHOR_ID)}
      authors={AUTHORS}
      viewerAuthorId={ANA_AUTHOR_ID}
      authorNames={new Map([[ANA_AUTHOR_ID, 'Ana']])}
      reactionFrequents={[]}
      grouping={{ position: 'only' }}
    />,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={createMockTransport()}>
            <TooltipProvider>
              <harness.Wrapper>
                <AgentInfoProvider known={fleet}>{children}</AgentInfoProvider>
              </harness.Wrapper>
            </TooltipProvider>
          </TransportProvider>
        </QueryClientProvider>
      ),
    }
  );
}

/**
 * The mention pill inside the message body — `data-kind` survives the
 * hover-card trigger merge, and `data-resolved="false"` is the unwrapped
 * fallback, so querying on both covers either state.
 *
 * Awaited because the harness's router loads its initial location
 * asynchronously; nothing under the route renders until it settles.
 */
/**
 * The identity card the pill opens, once it is open.
 *
 * Scoped by slot rather than by the words in it: the message's own action
 * capsule now carries a "View profile" command too (DOR-1251), so a global
 * query for that name answers two different controls about two different
 * people. This one is the card's.
 */
async function cardOf(): Promise<HTMLElement> {
  return waitFor(() => {
    const card = document.querySelector('[data-slot="identity-hover-card"]');
    if (!card) throw new Error('no identity card open');
    return card as HTMLElement;
  });
}

async function pillOf(): Promise<HTMLElement> {
  return waitFor(() => {
    const content = document.querySelector('[data-slot="message-content"]');
    const pill = content?.querySelector('[data-kind], [data-resolved="false"]');
    if (!pill) throw new Error('no mention pill rendered');
    return pill as HTMLElement;
  });
}

describe('a mention pill opens the mentioned identity’s profile', () => {
  it('carries a person’s AUTHOR id — their roster row is their author row', async () => {
    const user = userEvent.setup();
    const text = 'thanks @ana!';
    renderMention(text, [spanFor(text, '@ana', ANA_AUTHOR_ID)]);

    await user.click(await pillOf());

    expect(harness.openProfileId()).toBe(ANA_AUTHOR_ID);
  });

  it('carries an agent’s ROSTER id, never the author id the room holds', async () => {
    const user = userEvent.setup();
    const text = 'can you look, @warden?';
    renderMention(text, [spanFor(text, '@warden', WARDEN_AUTHOR_ID)]);

    await user.click(await pillOf());

    expect(harness.openProfileId()).toBe(WARDEN_MEMBER_ID);
    // Spelled out because this is the whole point: the id the pill already had
    // is the one that would have opened an empty drawer.
    expect(harness.openProfileId()).not.toBe(WARDEN_AUTHOR_ID);
  });

  it.each([
    ['Enter', '{Enter}'],
    ['Space', '[Space]'],
  ])('opens on %s — a role of button promises both, so both are wired', async (_name, keys) => {
    const user = userEvent.setup();
    const text = 'thanks @ana!';
    renderMention(text, [spanFor(text, '@ana', ANA_AUTHOR_ID)]);

    const pill = await pillOf();
    expect(pill).toHaveAttribute('role', 'button');
    pill.focus();
    await user.keyboard(keys);

    expect(harness.openProfileId()).toBe(ANA_AUTHOR_ID);
  });

  it('announces what pressing it does, not only who it names', async () => {
    // The visible text is the display name — the half a reader can already see.
    // The label carries the verb, matching the Team card and the sidebar face.
    const text = 'thanks @ana!';
    renderMention(text, [spanFor(text, '@ana', ANA_AUTHOR_ID)]);

    expect(await pillOf()).toHaveAttribute('aria-label', 'View Ana’s profile');
  });

  it('stays inert for an agent the fleet could not name — no id, no click', async () => {
    const user = userEvent.setup();
    const text = 'can you look, @warden?';
    renderMention(text, [spanFor(text, '@warden', WARDEN_AUTHOR_ID)], NO_FLEET);

    const pill = await pillOf();
    // No role, because there is nothing to press: the roster id for this agent
    // rides on a manifest nothing resolved.
    expect(pill).not.toHaveAttribute('role', 'button');
    await user.click(pill);

    expect(harness.openProfileId()).toBeNull();
  });

  it('opens the same profile from the hover card’s own footer', async () => {
    const user = userEvent.setup();
    const text = 'can you look, @warden?';
    renderMention(text, [spanFor(text, '@warden', WARDEN_AUTHOR_ID)]);

    await user.hover(await pillOf());
    await user.click(within(await cardOf()).getByRole('button', { name: 'View profile' }));

    expect(harness.openProfileId()).toBe(WARDEN_MEMBER_ID);
  });

  it('leaves the footer marked “soon” where the pill itself has no profile to open', async () => {
    const user = userEvent.setup();
    const text = 'can you look, @warden?';
    renderMention(text, [spanFor(text, '@warden', WARDEN_AUTHOR_ID)], NO_FLEET);

    await user.hover(await pillOf());

    const card = within(await cardOf());
    expect(card.getByText('soon')).toBeInTheDocument();
    expect(card.queryByRole('button', { name: 'View profile' })).not.toBeInTheDocument();
  });
});
