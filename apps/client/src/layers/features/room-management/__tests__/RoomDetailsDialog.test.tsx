// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import {
  agentAuthorRef,
  REACTION_FREQUENTS_DEFAULT,
  type RoomRosterEntry,
  type RoomSummary,
  type RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import { formatRelativeTime } from '@/layers/shared/lib';
import { TooltipProvider } from '@/layers/shared/ui';
import { TransportProvider, useAgentCreationStore } from '@/layers/shared/model';
import type { AgentPickerCandidate } from '@/layers/entities/agent';
import type { RoomDetailsFocus } from '../model/room-details';
import { RoomDetailsDialog } from '../ui/RoomDetailsDialog';

/**
 * The fleet this surface reads for itself.
 *
 * Mocked at the hook rather than injected as a prop, because the component now
 * fetches it — which is the point of the slice owning it. Every test names the
 * state it is about; the hook's own three-state behaviour is asserted in
 * `use-agent-picker-candidates.test.tsx`, and the rendering of each state in
 * `AgentRosterPicker.test.tsx`.
 */
const { mockRosterRef } = vi.hoisted(() => ({
  mockRosterRef: { current: null as unknown },
}));
vi.mock('../model/use-agent-picker-candidates', () => ({
  useAgentPickerCandidates: () => mockRosterRef.current,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The sheet reads route state to decide where each member row's face leads
// (`useProfileDeepLink`), and this file mounts it with no router. Where that
// link goes has its own file — `RoomMemberRow.click-to-profile.test.tsx`, which
// mounts a real router and asserts the id that travels.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useProfileDeepLink: () => ({ isOpen: false, memberId: null, open: vi.fn(), close: vi.fn() }),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOM: RoomSummary = {
  id: 'room-1',
  kind: 'channel',
  slug: 'general',
  title: 'General',
  topic: null,
  workspaceId: null,
  archived: false,
  ambientMaxEntries: 30,
  createdAt: '2026-07-26T10:00:00.000Z',
  lastActivityAt: '2026-07-26T10:00:00.000Z',
  unreadCount: 0,
  participants: null,
};

function agentMember(
  displayName: string,
  agentPath: string,
  responseMode: RoomRosterEntry['responseMode'] = 'mention-only'
): RoomRosterEntry {
  return {
    roomId: ROOM.id,
    authorId: `author-${displayName}`,
    responseMode,
    joinedAt: '2026-07-26T10:00:00.000Z',
    joinedSeq: 0,
    lastReadSeq: 0,
    author: {
      id: `author-${displayName}`,
      handle: null,
      kind: 'agent',
      displayName,
      agentRef: agentAuthorRef(agentPath),
    },
    origin: 'local',
  };
}

const HUMAN: RoomRosterEntry = {
  roomId: ROOM.id,
  authorId: 'me',
  responseMode: 'always',
  joinedAt: '2026-07-26T10:00:00.000Z',
  joinedSeq: 0,
  lastReadSeq: 0,
  author: { id: 'me', kind: 'human', displayName: 'You', handle: null },
  origin: 'local',
};

/**
 * What `getRoom` answers with. `base` matters: the sheet reads the room's kind
 * from the SERVER's copy rather than from the prop it was handed, so a fixture
 * that answered "channel" for a direct message would quietly test a channel.
 */
function roster(members: RoomRosterEntry[], base: RoomSummary = ROOM): RoomWithRoster {
  return {
    ...base,
    members,
    viewerAuthorId: HUMAN.authorId,
    reactionFrequents: [...REACTION_FREQUENTS_DEFAULT],
  };
}

/**
 * A fleet that has been read successfully. Named for the state rather than
 * defaulted into one — see `AgentRosterPicker.test.tsx` for the loading and
 * failed rosters, which render something else entirely.
 */
function settled(candidates: AgentPickerCandidate[]) {
  return { candidates, isLoading: false, isError: false, retry: vi.fn() };
}

const FLEET = settled([
  { agentPath: '/repo/ana', displayName: 'Ana', visual: null, description: null },
  { agentPath: '/repo/bo', displayName: 'Bo', visual: null, description: null },
]);

function renderPanel(
  opts: {
    transport?: Transport;
    focus?: RoomDetailsFocus;
    agents?: ReturnType<typeof settled>;
    onOpenChange?: (open: boolean) => void;
    /** The room the panel is opened over. Defaults to the channel above. */
    room?: RoomSummary;
  } = {}
) {
  const transport =
    opts.transport ??
    createMockTransport({
      getRoom: vi.fn().mockResolvedValue(roster([HUMAN, agentMember('Ana', '/repo/ana')])),
    });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  // Set before render: the picker reads the roster on its first pass.
  mockRosterRef.current = opts.agents ?? FLEET;
  const utils = render(
    <RoomDetailsDialog
      room={opts.room ?? ROOM}
      open
      onOpenChange={opts.onOpenChange ?? vi.fn()}
      focus={opts.focus ?? 'members'}
    />,
    { wrapper }
  );
  return { ...utils, transport };
}

/**
 * The roster section, once it holds somebody.
 *
 * Deliberately the region and not "the list": there are two of them now, one
 * per group, and a helper that reached for a single list would throw the moment
 * the sheet grouped people apart from agents.
 */
async function rosterSection(): Promise<HTMLElement> {
  const region = await screen.findByRole('region', { name: 'Current members' });
  await within(region).findAllByRole('listitem');
  return region;
}

/**
 * The add-agents half of the panel. Scoped deliberately: a chip and a roster
 * row both offer to "Remove Ana", and they are opposite verbs — one takes back
 * a selection, the other takes an agent out of the room.
 */
function addSection() {
  return within(screen.getByRole('region', { name: 'Add agents' }));
}

/**
 * Open the picker the way a reader does — by pressing the row at the foot of
 * the roster. Not needed when the sheet was opened through "Add agents…",
 * which is the entry point that opens it already expanded.
 */
function openAddRow(): void {
  const row = addSection().getByRole('button', { name: 'Add agents' });
  // Focused first, because a real pointer focuses the button it presses and
  // `fireEvent.click` does not — and the hazard lives in what happens to that
  // focus one commit later, when the row unmounts and drops it on `<body>`.
  row.focus();
  fireEvent.click(row);
}

/**
 * Answer the pointer queries as a phone would, leaving the width ones alone.
 *
 * `useIsTouchOnly` asks two: is the primary pointer coarse, and is ANY attached
 * pointer fine. A phone answers yes and no. The viewport queries are left at the
 * shared setup's "desktop", because the rule under test is about pointers — a
 * narrow desktop window is still a desktop.
 */
function touchOnly(on: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: on && query.includes('pointer: coarse'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

/** One member's loudness pill — what the row shows, and what opens the scale. */
function pill(name = 'Ana'): HTMLElement {
  return screen.getByRole('button', { name: `How loud ${name} is here` });
}

/**
 * A `getRoom` that answers once and then never again.
 *
 * The point is what it makes impossible: a refetch cannot be the thing that
 * restores a rolled-back value, so a test that sees the true rung back on the
 * pill has seen the rollback and nothing else. With an always-answering fake,
 * the same assertion stays green with the rollback deleted.
 */
function readableOnce(value: RoomWithRoster) {
  let served = false;
  return vi.fn().mockImplementation(() => {
    if (served) return new Promise<RoomWithRoster>(() => {});
    served = true;
    return Promise.resolve(value);
  });
}

/** A member's scale, once something has opened it. */
function scale(name = 'Ana'): HTMLElement {
  return screen.getByRole('radiogroup', { name: `How loud is ${name} here?` });
}

/** Open a member's scale and hand back the radiogroup. */
function openScale(name = 'Ana'): HTMLElement {
  fireEvent.click(pill(name));
  return scale(name);
}

/** Ask to remove a member through the row's "…" menu, and confirm it. */
function removeThroughMenu(name = 'Ana'): void {
  fireEvent.pointerDown(screen.getByLabelText(`${name} actions`));
  fireEvent.click(within(screen.getByRole('menu')).getByText('Remove from this room'));
}

// Radix Select drives itself with pointer capture and scrolls the highlighted
// option into view — both browser APIs jsdom does not implement at all, and
// without them the listbox never opens.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  // A real store, shared by the whole module graph — left open it would leak
  // into the next test's assertion about it.
  useAgentCreationStore.setState({ isOpen: false, seed: null, onCreated: null });
});
afterEach(() => {
  cleanup();
  touchOnly(false);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RoomDetailsDialog', () => {
  it('lists everyone in the room, the reader included', async () => {
    // The panel answers "who is in here?", and a list that omits the person
    // asking describes a room that does not exist. Red if the roster goes back
    // to agents only.
    renderPanel({
      transport: createMockTransport({
        getRoom: vi
          .fn()
          .mockResolvedValue(
            roster([HUMAN, agentMember('Ana', '/repo/ana'), agentMember('Bo', '/repo/bo')])
          ),
      }),
    });

    const section = await rosterSection();
    expect(within(section).getAllByRole('listitem')).toHaveLength(3);
    expect(within(section).getByText('Ana')).toBeInTheDocument();
    expect(within(section).getByText('You')).toBeInTheDocument();
    expect(within(section).getByText('(you)')).toBeInTheDocument();
  });

  it('groups people apart from agents, and counts each group', async () => {
    // Grouped, not segregated: Slack splits its sheet into a Members tab and an
    // "Agents & apps" tab, which is the opposite of treating agents as
    // participants. Red if the two groups collapse back into one list, or if
    // either count stops tracking what is under it.
    renderPanel({
      transport: createMockTransport({
        getRoom: vi
          .fn()
          .mockResolvedValue(
            roster([HUMAN, agentMember('Ana', '/repo/ana'), agentMember('Bo', '/repo/bo')])
          ),
      }),
    });

    const section = await rosterSection();
    expect(within(section).getByRole('heading', { name: 'People 1' })).toBeInTheDocument();
    expect(within(section).getByRole('heading', { name: 'Agents 2' })).toBeInTheDocument();
  });

  it('gives the reader no loudness and no verbs', async () => {
    // A person is never triggered and there is no verb for them, so the empty
    // slot is the statement. Red if the row starts drawing a pill or a menu for
    // a human — it would be offering a setting that does nothing.
    renderPanel();
    await rosterSection();

    expect(pill('Ana')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'How loud You is here' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('You actions')).not.toBeInTheDocument();
  });

  it('shows a skeleton while the roster loads, then the roster', async () => {
    let resolve!: (value: RoomWithRoster) => void;
    renderPanel({
      transport: createMockTransport({
        getRoom: vi.fn().mockReturnValue(
          new Promise<RoomWithRoster>((r) => {
            resolve = r;
          })
        ),
      }),
    });

    expect(screen.getByRole('region', { name: 'Current members' })).toHaveAttribute('aria-busy');
    resolve(roster([HUMAN, agentMember('Ana', '/repo/ana')]));
    await waitFor(() => expect(screen.getByText('Ana')).toBeInTheDocument());
  });

  it('says so when the roster could not be read, without claiming anyone left', async () => {
    renderPanel({
      transport: createMockTransport({ getRoom: vi.fn().mockRejectedValue(new Error('offline')) }),
    });

    expect(await screen.findByText(/Couldn't read who is in here/i)).toBeInTheDocument();
  });

  it('opens the picker itself for a room with nobody in it, and puts the cursor there', async () => {
    // The sheet's most consequential moment: a room with no agents does
    // nothing, and the only useful act on this surface is putting somebody in
    // it. Red if it goes back to a grey line and a button to press first.
    renderPanel({
      transport: createMockTransport({ getRoom: vi.fn().mockResolvedValue(roster([HUMAN])) }),
    });

    const search = await screen.findByRole('combobox', { name: 'Search agents' });
    await waitFor(() => expect(search).toHaveFocus());
    expect(addSection().queryByRole('button', { name: 'Add agents' })).not.toBeInTheDocument();
  });

  it('says the one thing about an empty room the line above it does not', async () => {
    // The loudness line already says "There is nobody here to answer you", so
    // this line saying it too would be the sheet stating one fact twice. What
    // is left is the part only it has: joining is not starting.
    renderPanel({
      transport: createMockTransport({ getRoom: vi.fn().mockResolvedValue(roster([HUMAN])) }),
    });

    expect(
      await screen.findByText(/Whoever you add can read everything already said/i)
    ).toBeInTheDocument();
    expect(screen.getByText('There is nobody here to answer you')).toBeInTheDocument();
  });

  it('offers a way to make an agent when there are none to add', async () => {
    // "You have not added any agents yet" is true and is a dead end with
    // nothing to press. Red if the sentence goes back to standing on its own.
    const onOpenChange = vi.fn();
    renderPanel({
      agents: settled([]),
      onOpenChange,
      transport: createMockTransport({ getRoom: vi.fn().mockResolvedValue(roster([HUMAN])) }),
    });
    await screen.findByText(/You have not added any agents yet/i);

    fireEvent.click(addSection().getByRole('button', { name: 'Create agent' }));

    // The sheet gets out of the way: the creation dialog is a modal of its own,
    // and a modal over this one closes both when it is answered.
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(useAgentCreationStore.getState().isOpen).toBe(true);
  });

  it('offers no such way when every agent is already in the room', async () => {
    // That sentence is a finished job, not a dead end — there is nothing to
    // fix, and a button under it would be inviting somebody to solve a problem
    // they do not have.
    renderPanel({
      agents: settled([
        { agentPath: '/repo/ana', displayName: 'Ana', visual: null, description: null },
      ]),
    });
    await rosterSection();
    openAddRow();

    expect(screen.getByText('Every agent you have is already in here.')).toBeInTheDocument();
    expect(addSection().queryByRole('button', { name: 'Create agent' })).not.toBeInTheDocument();
  });

  it('offers to read the roster again rather than asking to be closed and reopened', async () => {
    // "Close this and open it again to retry" is the retry button, made out of
    // a person. Red if the button goes, or stops actually re-reading.
    const getRoom = vi.fn().mockRejectedValue(new Error('offline'));
    const { transport } = renderPanel({ transport: createMockTransport({ getRoom }) });
    await screen.findByText(/Couldn't read who is in here/i);
    expect(screen.getByText(/Everyone is still where they were/i)).toBeInTheDocument();

    const before = vi.mocked(transport.getRoom).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() =>
      expect(vi.mocked(transport.getRoom).mock.calls.length).toBeGreaterThan(before)
    );
  });

  describe('how loud each agent is', () => {
    /** The same panel over a direct message rather than a channel. */
    const DM: RoomSummary = { ...ROOM, kind: 'dm', slug: null, title: 'Ana' };

    /** Open Ana's scale and read back the rungs it offers, in order. */
    function offeredRungs(): string[] {
      return within(openScale())
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('aria-label') ?? radio.textContent ?? '');
    }

    /** The panel over a direct message whose only agent holds `mode`. */
    function renderDm(mode: RoomRosterEntry['responseMode']) {
      return renderPanel({
        room: DM,
        transport: createMockTransport({
          getRoom: vi
            .fn()
            .mockResolvedValue(roster([HUMAN, agentMember('Ana', '/repo/ana', mode)], DM)),
        }),
      });
    }

    it('offers a channel four rungs, quiet to loud', async () => {
      // Position is the meaning. Five peer sentences in no stated order were
      // the defect this replaces — nobody could rank them.
      renderPanel();
      await rosterSection();

      expect(offeredRungs()).toEqual(['Silent', '@only', 'Engaged', 'Everything']);
    });

    it('offers a direct message the same four, because it has the same four behaviours', async () => {
      // Three were offered here for one commit, on the inherited claim that a
      // direct message's engaged window can never open. `room-trigger.ts` runs
      // `engagementFor` for every room kind, and a GROUP conversation is still
      // a `dm` — so the rung people would most want in a room holding three
      // agents was the one they could not reach.
      renderDm('mention-only');
      await rosterSection();

      expect(offeredRungs()).toEqual(['Silent', '@only', 'Engaged', 'Everything']);
    });

    it('says what a second agent would turn this conversation into, before it does', async () => {
      // A one-to-one holding two agents is a group conversation, and finding
      // that out afterwards — from a stack of faces where one face used to be —
      // is the product teaching by surprise. The wording is the one the "+"
      // beside Direct messages already uses.
      renderDm('mention-only');
      await rosterSection();

      expect(
        addSection().getByText('Adding a second agent turns this into a group conversation.')
      ).toBeInTheDocument();
    });

    it('says it only where it is true', async () => {
      // A channel is a channel however many agents are in it, and a
      // conversation already holding two is already a group. Red if the note
      // is drawn unconditionally: it would tell a reader of #general that
      // adding Bo turns a channel into a direct message.
      renderPanel();
      await rosterSection();
      expect(addSection().queryByText(/group conversation/)).not.toBeInTheDocument();

      cleanup();
      renderPanel({
        room: DM,
        transport: createMockTransport({
          getRoom: vi
            .fn()
            .mockResolvedValue(
              roster([HUMAN, agentMember('Ana', '/repo/ana'), agentMember('Bo', '/repo/bo')], DM)
            ),
        }),
      });
      await rosterSection();
      expect(addSection().queryByText(/group conversation/)).not.toBeInTheDocument();
    });

    it('shows the rung on the row, and what it does once you open it', async () => {
      // The pill is the glance and the scale is the task. Red if the row stops
      // naming the rung — the roster would go back to being a list of names
      // with the one thing worth knowing hidden behind a click.
      renderPanel();
      await rosterSection();

      expect(pill()).toHaveTextContent('@only');
      expect(screen.queryByText('Answers only when you @mention it.')).not.toBeInTheDocument();

      openScale();
      expect(screen.getByText('Answers only when you @mention it.')).toBeInTheDocument();
    });

    it('opens one scale at a time', async () => {
      // Four rungs and their consequences is most of a phone screen; two rows
      // of them is a sheet nobody can find the bottom of.
      renderPanel({
        transport: createMockTransport({
          getRoom: vi
            .fn()
            .mockResolvedValue(
              roster([HUMAN, agentMember('Ana', '/repo/ana'), agentMember('Bo', '/repo/bo')])
            ),
        }),
      });
      await rosterSection();

      openScale('Ana');
      openScale('Bo');

      expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
      expect(screen.getByRole('radiogroup', { name: 'How loud is Bo here?' })).toBeInTheDocument();
    });

    it('states the engaged window this install is running, not the shipped one', async () => {
      // The numbers are settings, and they are inside the sentence. An install
      // that tuned them must not read a sentence built from the defaults.
      renderPanel({
        transport: createMockTransport({
          getRoom: vi
            .fn()
            .mockResolvedValue(roster([HUMAN, agentMember('Ana', '/repo/ana', 'engaged')])),
          getConfig: vi
            .fn()
            .mockResolvedValue({ rooms: { engagedWindowMinutes: 3, engagedWindowPosts: 7 } }),
        }),
      });
      await rosterSection();
      openScale();

      expect(
        await screen.findByText(/keeps answering for 3 more minutes or 7 more messages/)
      ).toBeInTheDocument();
    });

    it('shows a direct message’s stored engaged value as engaged, and says what it does', async () => {
      // The whole defect, end to end. `seedResponseMode` seeds a DM membership
      // from the agent's own manifest and `engaged` is a legal value there, so
      // this is a room somebody can really be looking at. It read `@only`, the
      // sentence under it described `@only`, and the sentence was false of the
      // membership it was describing.
      renderDm('engaged');
      await rosterSection();

      expect(pill()).toHaveTextContent('Engaged');
      expect(within(openScale()).getByText(/keeps answering for/)).toBeInTheDocument();
    });

    it('writes one canonical value per rung, never a room-dependent alias', async () => {
      const { transport } = renderPanel();
      await rosterSection();

      fireEvent.click(within(openScale()).getByRole('radio', { name: 'Silent' }));

      await waitFor(() =>
        expect(transport.updateRoomMember).toHaveBeenCalledWith('room-1', 'author-Ana', {
          responseMode: 'silent',
        })
      );
    });

    it('writes nothing when the rung pressed is the one already stored', async () => {
      // A `direct-only` membership sits on `@only` in a channel, so pressing
      // `@only` there would rewrite it to `mention-only` — same behaviour, a
      // real write, and nothing on screen moves to say it happened. Silence is
      // the honest answer to "set it to what it already is".
      //
      // Both clicks in one `act`, because `mutate` only SCHEDULES: separate
      // `fireEvent` calls each flush on their own, so a guard could be missing
      // and the second write would still arrive second.
      const { transport } = renderPanel({
        transport: createMockTransport({
          getRoom: vi
            .fn()
            .mockResolvedValue(roster([HUMAN, agentMember('Ana', '/repo/ana', 'direct-only')])),
        }),
      });
      await rosterSection();
      const rungs = openScale();

      act(() => {
        fireEvent.click(within(rungs).getByRole('radio', { name: '@only' }));
      });
      expect(transport.updateRoomMember).not.toHaveBeenCalled();

      // The barrier: a control that never writes at all would pass the line
      // above on its own.
      fireEvent.click(within(rungs).getByRole('radio', { name: 'Silent' }));
      await waitFor(() => expect(transport.updateRoomMember).toHaveBeenCalledTimes(1));
    });

    it('moves the meter as soon as it is picked, not a round trip later', async () => {
      // The confirmation IS the meter moving, so a value that arrives when the
      // server agrees reads as a control that did not respond. Red the moment
      // the optimistic write goes: this write never settles, so nothing else
      // can put `Everything` on the pill.
      renderPanel({
        transport: createMockTransport({
          getRoom: vi.fn().mockResolvedValue(roster([HUMAN, agentMember('Ana', '/repo/ana')])),
          updateRoomMember: vi.fn().mockReturnValue(new Promise<never>(() => {})),
        }),
      });
      await rosterSection();

      fireEvent.click(within(openScale()).getByRole('radio', { name: 'Everything' }));

      await waitFor(() => expect(pill()).toHaveTextContent('Everything'));
      // The pill is dimmed with a class jsdom cannot see; this is the half of
      // "in flight" that reaches somebody who is not looking at it.
      expect(pill()).toHaveAttribute('aria-busy', 'true');
    });

    it('takes the rung back when the write is refused, and says why on the row', async () => {
      // A control still showing the value that never saved is worse than one
      // that showed nothing: it states a setting the server does not hold.
      renderPanel({
        transport: createMockTransport({
          getRoom: readableOnce(roster([HUMAN, agentMember('Ana', '/repo/ana')])),
          updateRoomMember: vi.fn().mockRejectedValue(new Error('Only you can change that')),
        }),
      });
      await rosterSection();

      fireEvent.click(within(openScale()).getByRole('radio', { name: 'Everything' }));

      expect(
        await screen.findByText("That didn't save — Only you can change that")
      ).toBeInTheDocument();
      expect(pill()).toHaveTextContent('@only');
      expect(pill()).not.toHaveAttribute('aria-busy');
    });

    it('blames the row it happened on, and no other', async () => {
      // One mutation observer serves every row, so the failure has to be
      // matched back to a member. Red if the reason is drawn on every agent's
      // row — Bo would be told a change nobody made to it had failed.
      renderPanel({
        transport: createMockTransport({
          getRoom: readableOnce(
            roster([HUMAN, agentMember('Ana', '/repo/ana'), agentMember('Bo', '/repo/bo')])
          ),
          updateRoomMember: vi.fn().mockRejectedValue(new Error('Only you can change that')),
        }),
      });
      const section = await rosterSection();

      fireEvent.click(within(openScale('Bo')).getByRole('radio', { name: 'Everything' }));

      await screen.findByText("That didn't save — Only you can change that");
      const rows = within(section).getAllByRole('listitem');
      const ana = rows.find((row) => within(row).queryByText('Ana') !== null);
      expect(ana).toBeDefined();
      expect(within(ana!).queryByText(/didn't save/)).not.toBeInTheDocument();
    });

    it.each(['channel', 'dm'] as const)(
      'writes `engaged` for the engaged rung in a %s',
      async (kind) => {
        // A direct message wrote `mention-only` here — a narrowing write, fired
        // by a rung that was already showing as chosen, storing a behaviour
        // nobody picked. Red if the room kind ever reaches the write again.
        const { transport } = kind === 'dm' ? renderDm('silent') : renderPanel();
        await rosterSection();

        fireEvent.click(within(openScale()).getByRole('radio', { name: 'Engaged' }));

        await waitFor(() =>
          expect(transport.updateRoomMember).toHaveBeenCalledWith('room-1', 'author-Ana', {
            responseMode: 'engaged',
          })
        );
      }
    );
  });

  it('removes nobody until the confirmation is accepted', async () => {
    const { transport } = renderPanel();
    await rosterSection();

    removeThroughMenu();
    const confirm = screen.getByRole('group', { name: 'Remove Ana from #general?' });
    expect(confirm).toHaveTextContent('Adding it back starts a fresh session.');
    expect(transport.removeRoomMember).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(transport.removeRoomMember).toHaveBeenCalledWith('room-1', 'author-Ana')
    );
  });

  /**
   * How a row arrives and how it leaves.
   *
   * **Almost none of this is settleable here, and saying so is the point.** The
   * movement itself is `motion` props, which the shared test setup strips off
   * before anything renders; jsdom runs no transitions and measures every
   * element as 0 × 0. So whether a row really opens its height, whether the
   * brand wash really fades, and whether both go to zero under
   * `prefers-reduced-motion` are browser questions and are on the browser
   * suite's list. What is settleable is the structure the movement needs — and
   * every one of these has a way to be wrong that a person would notice.
   */
  describe('how the roster arrives and leaves', () => {
    /** The `li` elements of whichever group holds the agents. */
    async function agentRows(): Promise<HTMLElement[]> {
      const region = await rosterSection();
      return within(region).getAllByRole('listitem');
    }

    it('clips each row, so a collapsing one does not spill out of its own height', async () => {
      // Red if the clip goes: a row leaving would draw its whole self outside a
      // box that is already shrinking, which reads as a glitch rather than as a
      // removal — and the Undo toast would be about something nobody saw go.
      renderPanel();

      for (const row of await agentRows()) expect(row.className).toContain('overflow-hidden');
    });

    it('spaces the rows with padding rather than with a margin', async () => {
      // A margin sits OUTSIDE the height being animated, so every row that
      // collapsed would leave a stripe of empty list behind it. Red if the list
      // goes back to `space-y`.
      renderPanel();
      const region = await rosterSection();

      for (const list of within(region).getAllByRole('list')) {
        expect(list.className).not.toContain('space-y');
      }
    });

    it('lays the landing wash over the row without ever taking a press from it', async () => {
      // It covers the whole row, including the pill and the "…". Red if it
      // becomes clickable or reachable: an agent's controls would go dead for as
      // long as the wash is on screen, and a screen reader would find an
      // element that says nothing.
      renderPanel();
      const rows = await agentRows();

      const wash = rows[0]!.querySelector('.bg-brand');
      expect(wash).not.toBeNull();
      expect(wash!.className).toContain('pointer-events-none');
      expect(wash).toHaveAttribute('aria-hidden');
    });
  });

  describe('on a phone', () => {
    /**
     * Two class contracts and one behaviour.
     *
     * The classes are the honest limit of jsdom here: it measures every element
     * as 0 × 0, so nothing about how tall anything actually is, or whether a
     * drag-to-dismiss fights the roster's own scroll, can be settled short of a
     * real browser on a real viewport. What a class assertion still catches is
     * the rule being deleted, which is how both of these went missing.
     */
    it('caps its own height, because neither shell caps itself', () => {
      // A drawer is `bottom-0` with `h-auto` and `mt-24` does nothing to it —
      // a margin-top cannot move a fixed box whose `top` is `auto` — so a
      // roster of eight agents grows its top off the screen and takes the
      // room's name with it. A centred dialog does the same at both ends. Every
      // other dialog in this app caps itself; this one did not. Red if the cap
      // goes: the body below it is the only scrolling region, and without a
      // bounded parent it never becomes one.
      renderPanel();

      const content = document.querySelector('[role="dialog"]');
      expect(content!.className).toContain('max-h-[85vh]');
    });

    it('gives the scrolling region a bounded parent to scroll inside', () => {
      renderPanel();

      const body = document.querySelector('[data-slot="responsive-dialog-body"]');
      expect(body!.className).toContain('overflow-y-auto');
    });
  });

  describe('taking an agent back out', () => {
    /** The undo the removal toast offered, or `null` when it offered none. */
    function undoOffer(name?: string): (() => void) | null {
      const calls = vi.mocked(toast.success).mock.calls;
      const call =
        name === undefined ? calls[0] : calls.find(([offer]) => String(offer).startsWith(name));
      if (call === undefined) return null;
      const options = call[1] as { action?: { label: string; onClick: () => void } } | undefined;
      return options?.action?.onClick ?? null;
    }

    /** Ask to remove a member and accept the confirmation, in one gesture. */
    function confirmRemoval(name: string): void {
      removeThroughMenu(name);
      fireEvent.click(
        within(screen.getByRole('group', { name: `Remove ${name} from #general?` })).getByRole(
          'button',
          { name: 'Remove' }
        )
      );
    }

    it('puts the agent back on the mode it had, not the one a new join gets', async () => {
      // The whole point. `engaged` is what the server seeds a channel join
      // with, so an undo that re-adds without naming a mode turns an agent
      // somebody set to Silent into one that answers — and calls that undo.
      // Red if the mode stops being sent, or is read after the write, when the
      // roster no longer holds the membership to read it off.
      const { transport } = renderPanel({
        transport: createMockTransport({
          getRoom: vi
            .fn()
            .mockResolvedValue(roster([HUMAN, agentMember('Ana', '/repo/ana', 'silent')])),
        }),
      });
      await rosterSection();

      removeThroughMenu();
      fireEvent.click(
        within(screen.getByRole('group', { name: 'Remove Ana from #general?' })).getByRole(
          'button',
          { name: 'Remove' }
        )
      );

      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith('Ana removed from #general', expect.anything())
      );
      const undo = undoOffer();
      expect(undo).not.toBeNull();
      undo!();

      await waitFor(() =>
        expect(transport.addRoomMember).toHaveBeenCalledWith('room-1', {
          agentPath: '/repo/ana',
          responseMode: 'silent',
        })
      );
    });

    it('says nothing when it has no way back to offer', async () => {
      // The agent's directory is what an add needs, and a roster row carries
      // only a one-way hash of it — so an agent the fleet cannot name is one
      // nothing could put back. A toast with no verb on it, over a row the
      // reader has just watched leave, would be a notification about their own
      // hand. Red if the offer is raised regardless of whether it works.
      //
      // Ana is not in the fleet and Bo is, and BOTH are removed: a bare
      // `not.toHaveBeenCalled()` after the first would be true whether or not
      // the toast was on its way, so removing Bo afterwards is the barrier that
      // turns the absence into a decision. An offer raised for Ana too makes
      // this count two. Both are confirmed before either settles, which is the
      // shape this really has to hold in: the offer is raised from each
      // removal's own promise, so a second one starting first cannot take it.
      renderPanel({
        agents: settled([
          { agentPath: '/repo/bo', displayName: 'Bo', visual: null, description: null },
        ]),
        transport: createMockTransport({
          getRoom: vi
            .fn()
            .mockResolvedValue(
              roster([HUMAN, agentMember('Ana', '/repo/ana'), agentMember('Bo', '/repo/bo')])
            ),
        }),
      });
      await rosterSection();

      confirmRemoval('Ana');
      confirmRemoval('Bo');

      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith('Bo removed from #general', expect.anything())
      );
      expect(toast.success).toHaveBeenCalledTimes(1);
    });

    it('offers an undo for each of two removals in flight at once', async () => {
      // One mutation observer serves every row, and TanStack keeps ONE slot for
      // per-call callbacks: a second `mutate` overwrote the first call's
      // `onSuccess`, so the first agent left with no way back. What it destroys
      // is invisible — the per-room session binding goes with the membership —
      // which is the whole reason the offer exists.
      //
      // Both removals are confirmed while neither has settled, which is what
      // makes this the concurrent case rather than two sequential ones.
      const resolvers: Array<() => void> = [];
      const { transport } = renderPanel({
        transport: createMockTransport({
          getRoom: vi
            .fn()
            .mockResolvedValue(
              roster([
                HUMAN,
                agentMember('Ana', '/repo/ana', 'silent'),
                agentMember('Bo', '/repo/bo', 'always'),
              ])
            ),
          removeRoomMember: vi
            .fn()
            .mockImplementation(() => new Promise<void>((resolve) => resolvers.push(resolve))),
        }),
      });
      await rosterSection();

      confirmRemoval('Ana');
      confirmRemoval('Bo');
      // `mutate` only SCHEDULES, so the calls have to be waited for — and
      // neither can settle while it is waited for, because the transport holds
      // both promises open. That is what puts them in flight together.
      await waitFor(() => expect(transport.removeRoomMember).toHaveBeenCalledTimes(2));
      expect(resolvers).toHaveLength(2);

      await act(async () => {
        for (const resolve of resolvers) resolve();
      });

      await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));
      // Each offer has to carry ITS OWN member's captured mode. A single
      // surviving callback would put one of them back on the other's setting,
      // or on the server's join-time seed — `engaged` for a channel, which is
      // how a deliberately silenced agent starts answering and calls it undo.
      undoOffer('Ana')!();
      undoOffer('Bo')!();

      await waitFor(() => expect(transport.addRoomMember).toHaveBeenCalledTimes(2));
      expect(transport.addRoomMember).toHaveBeenCalledWith('room-1', {
        agentPath: '/repo/ana',
        responseMode: 'silent',
      });
      expect(transport.addRoomMember).toHaveBeenCalledWith('room-1', {
        agentPath: '/repo/bo',
        responseMode: 'always',
      });
    });
  });

  it('confirms in place, so the panel the reader is working in stays open', async () => {
    // A dialog over a dialog closed BOTH when answered. The panel has to
    // survive its own confirmation, which is the whole reason this is inline.
    const { transport } = renderPanel();
    await rosterSection();

    removeThroughMenu();
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Remove Ana from #general?' })).getByRole('button', {
        name: 'Remove',
      })
    );

    await waitFor(() => expect(transport.removeRoomMember).toHaveBeenCalled());
    expect(
      within(screen.getByRole('dialog')).getByRole('region', { name: 'Current members' })
    ).toBeInTheDocument();
  });

  it('puts the focus on the confirmation so it can be answered from the keyboard', async () => {
    renderPanel();
    await rosterSection();

    removeThroughMenu();
    await waitFor(() =>
      expect(
        within(screen.getByRole('group', { name: 'Remove Ana from #general?' })).getByRole(
          'button',
          { name: 'Remove' }
        )
      ).toHaveFocus()
    );
  });

  it('leaves the roster alone when the removal is refused', async () => {
    const { transport } = renderPanel();
    await rosterSection();

    removeThroughMenu();
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Remove Ana from #general?' })).getByRole('button', {
        name: 'Cancel',
      })
    );

    expect(transport.removeRoomMember).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: /^Remove Ana/ })).not.toBeInTheDocument();
  });

  it('lets Escape answer the confirmation without closing the panel', async () => {
    const onOpenChange = vi.fn();
    renderPanel({ onOpenChange });
    await rosterSection();

    removeThroughMenu();
    // Radix listens for Escape on the document in the capture phase, which is
    // where the panel's own handler has to intercept it — so this is dispatched
    // there rather than at the confirmation.
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('group', { name: /^Remove Ana/ })).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      within(screen.getByRole('dialog')).getByRole('region', { name: 'Current members' })
    ).toBeInTheDocument();
  });

  describe('what the whole room will do', () => {
    it('does not describe a roster that has not arrived', async () => {
      // "There is nobody here to answer you" is what an EMPTY roster really
      // says, so saying it about one still being read states something false
      // and then corrects itself. Red if the line stops waiting.
      let resolve!: (value: RoomWithRoster) => void;
      renderPanel({
        transport: createMockTransport({
          getRoom: vi.fn().mockReturnValue(
            new Promise<RoomWithRoster>((r) => {
              resolve = r;
            })
          ),
        }),
      });

      expect(screen.queryByText(/nobody here to answer you/i)).not.toBeInTheDocument();

      resolve(roster([HUMAN, agentMember('Ana', '/repo/ana', 'engaged')]));
      expect(await screen.findByText('One agent will answer you here')).toBeInTheDocument();
    });

    it('names the one member the headline does not cover', async () => {
      // The two questions people open this sheet with are about the ROOM, and
      // both used to be answerable only by reading N grey sentences and
      // comparing them yourself.
      renderPanel({
        transport: createMockTransport({
          getRoom: vi
            .fn()
            .mockResolvedValue(
              roster([
                HUMAN,
                agentMember('Ana', '/repo/ana', 'engaged'),
                agentMember('Bo', '/repo/bo', 'mention-only'),
              ])
            ),
        }),
      });
      await rosterSection();

      expect(screen.getByText('One agent will answer you here')).toBeInTheDocument();
      expect(screen.getByText('Bo only when @mentioned')).toBeInTheDocument();
    });

    /**
     * Pointing at a rung and being shown what it would do to the room.
     *
     * **Nothing here settles the motion.** jsdom runs no CSS transitions and
     * reports every element as 0 × 0, so whether the meter slides or jumps —
     * and whether it snaps under `prefers-reduced-motion`, which the global rule
     * in `index.css` decides for every transition in the app — is a browser
     * question. What is settleable is which sentence is on screen, and that it
     * is the one `previewLoudness` gives for that exact roster rather than a
     * second answer computed some other way.
     */
    describe('and what it would do if you changed something', () => {
      /** A room where moving Bo really does change the room's own answer. */
      function renderMixed() {
        return renderPanel({
          transport: createMockTransport({
            getRoom: vi
              .fn()
              .mockResolvedValue(
                roster([
                  HUMAN,
                  agentMember('Ana', '/repo/ana', 'engaged'),
                  agentMember('Bo', '/repo/bo', 'mention-only'),
                ])
              ),
          }),
        });
      }

      /** The room's own line, whatever it currently says. */
      function loudnessLine(): HTMLElement {
        const found = document.querySelector('[data-slot="room-loudness-line"]');
        if (found === null) throw new Error('the room says nothing about itself');
        return found as HTMLElement;
      }

      it('rewrites the room’s own sentence as the keyboard crosses the rungs', async () => {
        // The whole model in three seconds and no help text: point at `Everything`
        // for Bo and the ROOM says what it would become. Red if the line ever
        // computes its own answer — `previewLoudness` is `roomLoudness` over one
        // swapped value, and a preview that can drift is worse than none.
        renderMixed();
        await rosterSection();
        expect(screen.getByText('One agent will answer you here')).toBeInTheDocument();

        fireEvent.keyDown(openScale('Bo'), { key: 'End' });

        expect(screen.getByText('Two agents will answer you here')).toBeInTheDocument();
        expect(screen.queryByText('One agent will answer you here')).not.toBeInTheDocument();
      });

      it('says it is a hypothetical, in words as well as in colour', async () => {
        // A reader who is not looking at the tint would otherwise be told
        // something false about the room they are in.
        renderMixed();
        await rosterSection();

        fireEvent.keyDown(openScale('Bo'), { key: 'End' });

        expect(loudnessLine()).toHaveAttribute('data-preview');
        expect(within(loudnessLine()).getByText(/If you make that change/)).toBeInTheDocument();
      });

      it('answers a pointer exactly as it answers the arrow keys', async () => {
        // Keyboard parity is not a courtesy here: the arrows were the ONLY way
        // to reach this before there was a pointer path at all. Red if either
        // input gets its own answer.
        renderMixed();
        await rosterSection();

        fireEvent.mouseEnter(within(openScale('Bo')).getByRole('radio', { name: 'Everything' }));

        expect(screen.getByText('Two agents will answer you here')).toBeInTheDocument();
      });

      it('slides back to what is true when the reader stops pointing', async () => {
        renderMixed();
        await rosterSection();
        const group = openScale('Bo');

        fireEvent.keyDown(group, { key: 'End' });
        fireEvent.blur(group, { relatedTarget: document.body });

        expect(screen.getByText('One agent will answer you here')).toBeInTheDocument();
        expect(loudnessLine()).not.toHaveAttribute('data-preview');
      });

      it('says nothing hypothetical about an archived room', async () => {
        // There is no loudness line to preview into: an archived room triggers
        // nobody, so the sentence would be false however it was computed. Red if
        // the line comes back, or if the scale starts reporting there.
        renderPanel({
          room: { ...ROOM, archived: true },
          transport: createMockTransport({
            getRoom: vi.fn().mockResolvedValue(
              roster([HUMAN, agentMember('Ana', '/repo/ana', 'engaged')], {
                ...ROOM,
                archived: true,
                ambientMaxEntries: 30,
              })
            ),
          }),
        });
        await rosterSection();

        fireEvent.keyDown(openScale('Ana'), { key: 'Home' });

        expect(document.querySelector('[data-slot="room-loudness-line"]')).toBeNull();
        expect(screen.getByText(/their settings are on hold/)).toBeInTheDocument();
      });
    });
  });

  describe('the foot of the sheet', () => {
    /** A sheet over a room whose archived flag the fake server really holds. */
    function renderArchivable(startArchived: boolean, members: RoomRosterEntry[] = [HUMAN]) {
      let archived = startArchived;
      const transport = createMockTransport({
        getRoom: vi
          .fn()
          .mockImplementation(() => Promise.resolve({ ...roster(members), archived })),
        updateRoom: vi.fn().mockImplementation((_id: string, body: { archived?: boolean }) => {
          if (body.archived !== undefined) archived = body.archived;
          return Promise.resolve({ ...roster(members), archived });
        }),
      });
      renderPanel({ room: { ...ROOM, archived: startArchived }, transport });
      return { transport };
    }

    it('says how old the room is, in the cockpit voice every other date uses', async () => {
      // Deliberately not `lastActivityAt`, which the fixture also carries: the
      // foot of the sheet says when the room was MADE. And through
      // `formatRelativeTime`, so a member row and this line age the same way
      // rather than the sheet growing a second date vocabulary.
      const born = '2026-07-01T08:00:00.000Z';
      renderPanel({
        room: { ...ROOM, createdAt: born },
        transport: createMockTransport({
          getRoom: vi.fn().mockResolvedValue({ ...roster([HUMAN]), createdAt: born }),
        }),
      });
      await screen.findByText(/Whoever you add can read everything already said/i);

      expect(screen.getByText(`Created ${formatRelativeTime(born)}`)).toBeInTheDocument();
    });

    it('archives in place, and puts the way back where the action was', async () => {
      // No alert, deliberately. The sheet you pressed it in redraws with the
      // badge and the undo, which says more than a modal asking "are you
      // sure?" — and a modal over a modal closes both when it is answered
      // (see `RemoveMemberConfirm`). The sidebar row keeps ITS alert, because
      // archiving from a menu over a list is where you archive the wrong room.
      const { transport } = renderArchivable(false);
      await screen.findByText(/Whoever you add can read everything already said/i);

      fireEvent.click(screen.getByRole('button', { name: 'Archive room' }));

      await waitFor(() =>
        expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { archived: true })
      );
      expect(
        await screen.findByRole('button', { name: 'Bring this room back' })
      ).toBeInTheDocument();
      expect(screen.getByText('Archived')).toBeInTheDocument();
    });

    it('stops claiming an archived room will answer anybody', async () => {
      // Nothing is triggered in an archived room, so the loudness sentence
      // would be false there. Red if the room line comes back: it would read
      // "One agent will answer you here" of a room that answers nothing.
      renderArchivable(true);
      await rosterSection();

      expect(screen.getByText(/Nobody is triggered in an archived room/)).toBeInTheDocument();
      expect(screen.queryByText(/answer you here/)).not.toBeInTheDocument();
    });

    it('greys every meter, because the setting is real and dormant', async () => {
      // A bright meter on a room that triggers nobody claims the setting is in
      // effect. Unlit would be the opposite lie — the rung is still stored and
      // still what the agent will do the moment the room comes back. Red if the
      // room's archived flag stops reaching the meter.
      renderArchivable(true, [HUMAN, agentMember('Ana', '/repo/ana')]);
      await rosterSection();

      expect(pill().querySelector('[data-slot="loudness-meter"]')).toHaveAttribute('data-dormant');
    });

    it('describes a dormant rung with the reason, and keeps it reachable', async () => {
      // A `disabled` button leaves the tab order, so the reason a screen reader
      // was handed would sit on a control it can never arrive at — which is the
      // dead control the reason exists to explain. Red if the rungs go back to
      // the disabled attribute, or if the description drops the banner.
      renderArchivable(true, [HUMAN, agentMember('Ana', '/repo/ana')]);
      await rosterSection();

      const rung = within(openScale()).getByRole('radio', { name: 'Everything' });
      expect(rung).toHaveAttribute('aria-disabled', 'true');
      const described = (rung.getAttribute('aria-describedby') ?? '').split(' ');
      const banner = screen.getByText(/Nobody is triggered in an archived room/);
      expect(described).toContain(banner.id);
      // The `disabled` attribute is what takes an element out of the tab order,
      // and jsdom has no tab order to check — it will happily focus a disabled
      // button that carries a `tabindex`, which every rung does. So its absence
      // is asserted directly rather than through a focus call that would pass
      // either way.
      expect(rung).not.toBeDisabled();
    });

    it('writes nothing while the room is archived, and writes again once it is back', async () => {
      // The barrier: `not.toHaveBeenCalled()` on the line after a click is true
      // whatever the control did, because `mutate` only schedules its
      // `mutationFn`. Committing a real change afterwards through the SAME
      // control and insisting the port saw exactly one call is what turns the
      // absence into a decision.
      const { transport } = renderArchivable(true, [HUMAN, agentMember('Ana', '/repo/ana')]);
      await rosterSection();

      fireEvent.click(within(openScale()).getByRole('radio', { name: 'Everything' }));

      fireEvent.click(screen.getByRole('button', { name: 'Bring this room back' }));
      await screen.findByRole('button', { name: 'Archive room' });

      // The scale is still open — pressing the pill again would shut it.
      fireEvent.click(within(scale()).getByRole('radio', { name: 'Everything' }));

      await waitFor(() =>
        expect(transport.updateRoomMember).toHaveBeenCalledWith('room-1', 'author-Ana', {
          responseMode: 'always',
        })
      );
      expect(transport.updateRoomMember).toHaveBeenCalledTimes(1);
    });

    it('offers no way to staff a room whose settings it says are on hold', async () => {
      // The banner said the settings were on hold while the add row sat there
      // unguarded — and adding names no `responseMode`, so the server seeds
      // one: `engaged` for a channel. Remove-then-add inside an archived room
      // therefore rewrote a deliberate `Silent` into an agent that answers, in
      // the one room the sheet claims nothing can be changed in. An archived
      // room is one you are deciding whether to revive, not one you staff.
      //
      // The barrier is bringing it back: both verbs return, so their absence
      // above is this guard's doing rather than a roster that never drew them.
      renderArchivable(true, [HUMAN, agentMember('Ana', '/repo/ana', 'silent')]);
      await rosterSection();

      expect(screen.queryByRole('button', { name: 'Add agents' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Ana actions')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Bring this room back' }));

      expect(await screen.findByRole('button', { name: 'Add agents' })).toBeInTheDocument();
      expect(screen.getByLabelText('Ana actions')).toBeInTheDocument();
    });

    it('holds the touch path’s Remove button too, not only the desktop menu', async () => {
      // Below 768px the "…" does not exist at all — a dropdown portalled inside
      // a vaul drawer is a known-hazard nesting — and Remove is a plain button
      // at the foot of the expanded row. Guarding only the menu would leave the
      // whole removal path open on a phone.
      // Every query answered yes — a phone is under 768px AND coarse-pointered,
      // and `useIsMobile` is the one that decides which removal verb is drawn.
      // `touchOnly` alone leaves the width queries at "desktop", so this test
      // would assert the absence of a button the desktop never renders.
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: (query: string) => ({
          matches: true,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }),
      });
      renderArchivable(true, [HUMAN, agentMember('Ana', '/repo/ana', 'silent')]);
      await rosterSection();
      openScale();

      expect(screen.getByRole('radiogroup', { name: 'How loud is Ana here?' })).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Remove from this room' })
      ).not.toBeInTheDocument();
    });

    it('brings an archived room back from the same place', async () => {
      const { transport } = renderArchivable(true);
      await rosterSection();

      fireEvent.click(screen.getByRole('button', { name: 'Bring this room back' }));

      await waitFor(() =>
        expect(transport.updateRoom).toHaveBeenCalledWith('room-1', { archived: false })
      );
    });
  });

  describe('adding somebody', () => {
    it('ends the roster with a row rather than opening a second panel', async () => {
      // The old sheet carried a second heading, a second explanation and an
      // always-open picker whose disabled button was the heaviest thing on
      // screen. Red if any of that comes back: the foot of the roster is one
      // more row until somebody presses it.
      renderPanel();
      await rosterSection();

      expect(addSection().getByRole('button', { name: 'Add agents' })).toBeInTheDocument();
      expect(
        addSection().queryByRole('combobox', { name: 'Search agents' })
      ).not.toBeInTheDocument();
    });

    it('turns that row into the picker, with the cursor already in it', async () => {
      // Expanding it unmounts the button that was pressed, which drops focus
      // to <body>. Red if the focus guard treats that as "the reader has gone
      // somewhere else" — pressing the row would open a field nobody is in.
      renderPanel();
      await rosterSection();
      openAddRow();

      const search = screen.getByRole('combobox', { name: 'Search agents' });
      await waitFor(() => expect(search).toHaveFocus());
      expect(addSection().queryByRole('button', { name: 'Add agents' })).not.toBeInTheDocument();
    });

    it('opens with the picker already open for the door that asked to add', async () => {
      // "Add agents…" and "Members…" land on ONE sheet, so the state it opens
      // in is the only thing left saying which was pressed.
      renderPanel({ focus: 'add' });
      await rosterSection();

      expect(screen.getByRole('combobox', { name: 'Search agents' })).toBeInTheDocument();
    });
  });

  it('offers only agents that are not already in the room', async () => {
    renderPanel();
    await rosterSection();
    openAddRow();

    // Ana is on the roster; Bo is not.
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: 'Bo' })).toBeInTheDocument();
  });

  it('adds every agent picked, one call each', async () => {
    const { transport } = renderPanel({
      transport: createMockTransport({
        getRoom: vi.fn().mockResolvedValue(roster([HUMAN])),
        addRoomMember: vi.fn().mockResolvedValue(agentMember('Ana', '/repo/ana')),
      }),
    });
    await screen.findByText(/Whoever you add can read everything already said/i);

    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    fireEvent.click(screen.getByRole('option', { name: 'Bo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 agents' }));

    await waitFor(() => expect(transport.addRoomMember).toHaveBeenCalledTimes(2));
    expect(transport.addRoomMember).toHaveBeenNthCalledWith(1, 'room-1', {
      agentPath: '/repo/ana',
    });
    expect(transport.addRoomMember).toHaveBeenNthCalledWith(2, 'room-1', { agentPath: '/repo/bo' });
  });

  it('keeps the chip for the agent that failed, and only that one', async () => {
    // A partial success is progress worth keeping, so the selection empties at
    // the rate the writes actually land: the reader is left holding the failure,
    // and the button offers a retry rather than adding the others a second time.
    let members = [HUMAN];
    const transport = createMockTransport({
      getRoom: vi.fn().mockImplementation(() => Promise.resolve(roster(members))),
      addRoomMember: vi.fn().mockImplementation((_roomId: string, body: { agentPath: string }) => {
        if (body.agentPath === '/repo/bo') return Promise.reject(new Error('nope'));
        const joined = agentMember('Ana', '/repo/ana');
        members = [...members, joined];
        return Promise.resolve(joined);
      }),
    });
    renderPanel({ transport });
    await screen.findByText(/Whoever you add can read everything already said/i);

    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    fireEvent.click(screen.getByRole('option', { name: 'Bo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 agents' }));

    await waitFor(() => expect(transport.addRoomMember).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(addSection().queryByText('Ana')).not.toBeInTheDocument());
    expect(addSection().getByRole('button', { name: 'Remove Bo' })).toBeInTheDocument();
    expect(addSection().getByRole('button', { name: 'Add agent' })).toBeEnabled();
  });

  it('does not put a chip back when the agent it added is removed again', async () => {
    // The picker forgets a committed agent for good rather than deriving its
    // chips from whoever happens to be offerable. Otherwise taking Ana back out
    // of the room — from the same open panel — would re-select her, and the
    // panel would offer to add somebody the reader had just removed.
    let members = [HUMAN];
    const transport = createMockTransport({
      getRoom: vi.fn().mockImplementation(() => Promise.resolve(roster(members))),
      addRoomMember: vi.fn().mockImplementation(() => {
        const joined = agentMember('Ana', '/repo/ana');
        members = [...members, joined];
        return Promise.resolve(joined);
      }),
      removeRoomMember: vi.fn().mockImplementation(() => {
        members = [HUMAN];
        return Promise.resolve();
      }),
    });
    renderPanel({ transport });
    await screen.findByText(/Whoever you add can read everything already said/i);

    fireEvent.click(screen.getByRole('option', { name: 'Ana' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
    await waitFor(() => expect(addSection().queryByText('Ana')).not.toBeInTheDocument());

    await screen.findByLabelText('Ana actions');
    removeThroughMenu();
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Remove Ana from #general?' })).getByRole('button', {
        name: 'Remove',
      })
    );

    await waitFor(() => expect(screen.getByRole('option', { name: 'Ana' })).toBeInTheDocument());
    expect(addSection().queryByRole('button', { name: 'Remove Ana' })).not.toBeInTheDocument();
  });

  // Where focus lands is asserted in `RoomRow.test.tsx`, through the menu that
  // opens this panel. Rendering it directly here cannot see the thing that
  // actually breaks it: the menu closes a commit later and restores focus to
  // its own trigger, so a panel that focuses correctly in isolation still
  // leaves the reader typing into the sidebar.

  it('lands on the search field even when the fleet is still being read', async () => {
    // "Add agents…" asks for the picker, and the picker is not there yet when
    // the panel opens on a cold read — it draws a shape while the fleet lands.
    // `onOpenAutoFocus` fires once, at open, so without a second pass the
    // reader is left with focus on the dialog and nowhere to type.
    const loading = { candidates: [], isLoading: true, isError: false, retry: vi.fn() };
    const { rerender } = renderPanel({ focus: 'add', agents: loading });

    expect(screen.queryByRole('combobox', { name: 'Search agents' })).not.toBeInTheDocument();

    mockRosterRef.current = FLEET;
    rerender(<RoomDetailsDialog room={ROOM} open onOpenChange={vi.fn()} focus="add" />);

    const search = await screen.findByRole('combobox', { name: 'Search agents' });
    await waitFor(() => expect(search).toHaveFocus());
  });

  it('never pops a software keyboard on a device that only has one', async () => {
    // None of the three paths to this cursor is somebody tapping a text field:
    // they are a menu item, a row, and a room that turned out to be empty. On
    // touch, taking the cursor puts the keyboard over the list the reader came
    // to read — the rule `focusUnlessTouch` holds the composer to. Red if the
    // guard goes: the test above proves the same request IS answered where
    // there is a real pointer, so the two together are the whole rule.
    //
    // Pointer, deliberately, and not width: a narrow desktop window is still a
    // desktop, so this leaves the viewport queries answering "wide" and changes
    // only what kind of pointer exists.
    touchOnly(true);
    renderPanel({ focus: 'add' });

    const search = await screen.findByRole('combobox', { name: 'Search agents' });
    expect(search).not.toHaveFocus();
  });

  it('lets an empty room open its picker without taking the cursor off the topic', async () => {
    // Two things want the keyboard at once: the door that said "topic", and a
    // room that turns out to be empty and opens its own picker. The reader
    // asked for the topic, and a live editor is somewhere REAL — unlike the
    // dialog's own content element, which is where the cursor parks when a
    // door named no field. Red if the guard goes back to "anywhere inside the
    // sheet counts": this reader would be typing into "Search agents".
    renderPanel({
      focus: 'topic',
      transport: createMockTransport({ getRoom: vi.fn().mockResolvedValue(roster([HUMAN])) }),
    });

    const search = await screen.findByRole('combobox', { name: 'Search agents' });
    expect(screen.getByRole('textbox', { name: 'Topic' })).toHaveFocus();
    expect(search).not.toHaveFocus();
  });

  it('leaves the picker shut for an entry point that did not ask to add anybody', async () => {
    // An entry point that asked about the topic has no claim on the search
    // box. Red if the picker ever opens for anything but "Add agents…" — a
    // reader who came for the topic would be typing into "Search agents".
    renderPanel({ focus: 'topic' });

    await rosterSection();
    expect(screen.queryByRole('combobox', { name: 'Search agents' })).not.toBeInTheDocument();
  });

  it('says there is nobody left to add rather than showing an empty picker', async () => {
    renderPanel({
      agents: settled([
        { agentPath: '/repo/ana', displayName: 'Ana', visual: null, description: null },
      ]),
    });
    await rosterSection();
    openAddRow();

    expect(screen.getByText('Every agent you have is already in here.')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
