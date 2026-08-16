// @vitest-environment jsdom
/**
 * The face beside a message opens that author's profile (spec
 * `profile-unification` §3, bug 7).
 *
 * Same claim, same trap as the mention pill next door
 * (`RoomEntryRow.click-to-profile.test.tsx`): the id that must travel is the
 * ROSTER's, and a room entry carries the author's. For a person those are one
 * id; for an agent they are two, and using the one already in hand opens an
 * empty profile. The answer is read off the URL, which is what `open()` writes
 * and what a reload reopens.
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

/** The room's own voice — on nobody's roster, and never will be. */
const SYSTEM: RosterAuthor = {
  id: 'system',
  kind: 'system',
  displayName: 'System',
  handle: null,
  origin: 'local',
};

/** Whoever is reading, when the case is not about them. Never rendered. */
const VIEWER_AUTHOR_ID = 'author-viewer';

const AUTHORS = new Map<string, RosterAuthor>([
  [ANA_AUTHOR_ID, ANA],
  [WARDEN_AUTHOR_ID, WARDEN],
  [SYSTEM.id, SYSTEM],
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

/** A fleet that answered nothing — an unreachable mesh, or a manifest that would not read. */
const NO_FLEET: RoomAgentDirectory = { info: new Map(), faces: new Map() };

function entry(authorId: string): RoomEntry {
  return {
    roomId: 'room-1',
    seq: 1,
    id: 'entry-1',
    authorId,
    kind: 'post',
    body: { text: 'shipped it' },
    mentions: [],
    mentionSpans: [],
    sessionId: null,
    cascadeRoot: 'entry-1',
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-26T10:00:00.000Z',
  };
}

function renderRow(
  author: RosterAuthor,
  fleet: RoomAgentDirectory = FLEET,
  viewerAuthorId: string = VIEWER_AUTHOR_ID
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <RoomEntryRow
      roomId="room-1"
      entry={entry(author.id)}
      author={toMessageAuthor(author.id, AUTHORS, fleet.faces)}
      authorRef={author}
      authors={AUTHORS}
      viewerAuthorId={viewerAuthorId}
      authorNames={new Map([[author.id, author.displayName]])}
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
 * The identity disc in the row's gutter, whatever it turned out to be.
 *
 * Queried by slot rather than by role, so the inert case — plain art, no role
 * at all — is reachable by the same helper as the control.
 *
 * Awaited because the harness's router loads its initial location
 * asynchronously; nothing under the route renders until it settles.
 */
async function faceOf(): Promise<HTMLElement> {
  return waitFor(
    () => {
      const face = document.querySelector('[data-slot="message-author-avatar"]');
      if (!face) throw new Error('no author face rendered');
      return face as HTMLElement;
    },
    // Generous on purpose: this file runs alongside ~900 others on a machine
    // usually running other agents too, and Testing Library's 1000ms default is
    // a statement about a quiet one.
    { timeout: 5000 }
  );
}

describe('the face beside a message opens its author’s profile', () => {
  it('carries a person’s AUTHOR id — their roster row is their author row', async () => {
    const user = userEvent.setup();
    renderRow(ANA);

    await user.click(await faceOf());

    expect(harness.openProfileId()).toBe(ANA_AUTHOR_ID);
  });

  it('carries an agent’s ROSTER id, never the author id the room holds', async () => {
    const user = userEvent.setup();
    renderRow(WARDEN);

    await user.click(await faceOf());

    expect(harness.openProfileId()).toBe(WARDEN_MEMBER_ID);
    // Spelled out because this is the whole point: the id the row already had
    // is the one that would have opened an empty profile.
    expect(harness.openProfileId()).not.toBe(WARDEN_AUTHOR_ID);
  });

  it('stays OUT of the tab order — a room costs one Tab per message', async () => {
    // The budget this face broke on its first outing: a room's rows are the tab
    // stops, and everything inside a message is reached with arrow keys instead
    // (`room-entry-actions.spec.ts`, "a room costs one Tab per message"). A
    // focusable disc per author group turned a three-message room from two
    // presses to cross into five.
    renderRow(ANA);

    const face = await faceOf();
    expect(face).toHaveAttribute('tabindex', '-1');
    // Still named and still a button: a screen reader's virtual cursor walks the
    // document, not the tab order, so it reaches and activates this.
    expect(face).toHaveAttribute('role', 'button');
  });

  it('puts the same profile in the message’s own action capsule', async () => {
    // Where the KEYBOARD goes instead. The capsule is reached with one arrow
    // key from the message and costs no Tab of its own, so this is the path
    // that keeps the budget above and keyboard reachability at the same time.
    const user = userEvent.setup();
    renderRow(ANA);
    await faceOf();

    const capsule = within(screen.getByTestId('entry-actions'));
    await user.click(capsule.getByRole('button', { name: 'View profile' }));

    expect(harness.openProfileId()).toBe(ANA_AUTHOR_ID);
  });

  it('offers no capsule action for an author it cannot name to the roster', async () => {
    // Withheld the same way the face is, and for the same reason — an action
    // that opened an empty profile is worse than one that is not there.
    renderRow(SYSTEM);
    await faceOf();

    expect(
      within(screen.getByTestId('entry-actions')).queryByRole('button', { name: 'View profile' })
    ).not.toBeInTheDocument();
  });

  it.each([
    ['Enter', '{Enter}'],
    ['Space', '[Space]'],
  ])('activates on %s once something has focused it', async (_name, keys) => {
    const user = userEvent.setup();
    renderRow(ANA);

    const face = await faceOf();
    expect(face).toHaveAttribute('role', 'button');
    face.focus();
    await user.keyboard(keys);

    expect(harness.openProfileId()).toBe(ANA_AUTHOR_ID);
  });

  it('announces what pressing it does, not only who it names', async () => {
    // The name beside the disc is the half a reader can already see; the label
    // carries the verb, matching the Team card and the sidebar face.
    renderRow(ANA);

    expect(await faceOf()).toHaveAttribute('aria-label', 'Open Ana’s profile');
  });

  it('says “your profile” on your own face, not “You’s”', async () => {
    // The local human's display name is the literal string "You", so the
    // ordinary possessive template produces "Open You’s profile" — on every
    // message the operator has ever sent. Second person is the only way to
    // write this one.
    renderRow(ANA, FLEET, ANA_AUTHOR_ID);

    expect(await faceOf()).toHaveAttribute('aria-label', 'Open your profile');
  });

  it('still opens the right id when the face is your own', async () => {
    // The wording changes; the destination must not.
    const user = userEvent.setup();
    renderRow(ANA, FLEET, ANA_AUTHOR_ID);

    await user.click(await faceOf());

    expect(harness.openProfileId()).toBe(ANA_AUTHOR_ID);
  });

  it('stays plain art for the room’s own voice — no roster row, no control', async () => {
    const user = userEvent.setup();
    renderRow(SYSTEM);

    const face = await faceOf();
    expect(face).not.toHaveAttribute('role', 'button');
    // Still hidden from assistive technology, exactly as it was before any of
    // this: decoration is the honest state for something with nowhere to go.
    expect(face).toHaveAttribute('aria-hidden', 'true');
    await user.click(face);

    expect(harness.openProfileId()).toBeNull();
  });

  it('stays plain art for an agent the fleet could not name', async () => {
    const user = userEvent.setup();
    renderRow(WARDEN, NO_FLEET);

    const face = await faceOf();
    expect(face).not.toHaveAttribute('role', 'button');
    await user.click(face);

    expect(harness.openProfileId()).toBeNull();
  });
});
