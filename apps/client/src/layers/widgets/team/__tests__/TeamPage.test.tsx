/**
 * @vitest-environment jsdom The Team page against a roster the product cannot produce yet: two
 * people, four agents, two owners (spec §W2.6).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider, IsRestoringProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { TeamMember, TeamRosterResponse } from '@dorkos/shared/team-schemas';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { TransportProvider } from '@/layers/shared/model';
import {
  buildProfileDeepLinkHarness,
  type ProfileDeepLinkHarness,
} from '@/test-helpers/profile-deep-link';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { TeamPage } from '../ui/TeamPage';

// No local `motion/react` mock: `test-setup.ts` already mocks the whole module for every client
// test, and its version is strictly better — it renders the real tag rather than a `<div>`,
// strips motion props so they cannot leak to the DOM as unknown attributes, and exports the hooks
// too.

/** The router the page's own profile links write into. */
let harness: ProfileDeepLinkHarness;

function renderPage(roster: TeamRosterResponse, overrides: Partial<Transport> = {}) {
  const transport = createMockTransport({
    getTeamRoster: vi.fn().mockResolvedValue(roster),
    ...overrides,
  } as Partial<Transport>);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <harness.Wrapper>{children}</harness.Wrapper>
        </TransportProvider>
      </QueryClientProvider>
    );
  }

  return render(<TeamPage />, { wrapper: Wrapper });
}

/** Every card currently on screen, in DOM order, by the name it draws. */
function cardNames(): string[] {
  return screen
    .queryAllByRole('article')
    .map((card) => within(card).getByRole('heading').textContent ?? '');
}

const chip = (name: string) => screen.getByRole('button', { name });

beforeEach(() => {
  vi.clearAllMocks();
  harness = buildProfileDeepLinkHarness();
});

afterEach(() => {
  cleanup();
});

describe('TeamPage — the roster', () => {
  it('draws every identity, the operator first', async () => {
    renderPage({ members: MOCK_TEAM_ROSTER });

    expect(await screen.findByText('Dorian')).toBeInTheDocument();
    expect(cardNames()).toEqual([
      'Dorian',
      'Miguel Ferreira-Santos',
      'Warden',
      'Scout',
      'Cartographer of the Northern Reaches',
      'DorkBot',
    ]);
  });

  it('marks the viewer with a chip, and marks nobody else', async () => {
    renderPage({ members: MOCK_TEAM_ROSTER });

    const you = await screen.findAllByText('you');
    expect(you).toHaveLength(1);
    // The chip lives on the operator's card and nowhere else — "you" is a flag
    // on one row, not a branch the page takes.
    expect(you[0]!.closest('[data-member-id]')).toHaveAttribute('data-member-id', 'person-dorian');
  });
});

describe('TeamPage — the filter chips', () => {
  it('narrows to people — both of them', async () => {
    const user = userEvent.setup();
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Dorian');

    await user.click(chip('People'));

    expect(cardNames()).toEqual(['Dorian', 'Miguel Ferreira-Santos']);
  });

  it('offers a chip per person, because there is more than one', async () => {
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Dorian');

    // The chip row shows both people, in their own group — the kind chips
    // answer a different question and must not be labelled as one set.
    const people = within(screen.getByRole('group', { name: 'Filter by person' }));
    expect(people.getByRole('button', { name: /Dorian/ })).toHaveTextContent('@dorian');
    expect(people.getByRole('button', { name: /Miguel/ })).toHaveTextContent('@miguel.telegram');
  });
});

describe('TeamPage — claiming an account on another platform (DOR-1778)', () => {
  /** The claim control on one card, by the row it belongs to. */
  function claimControl(name: string): HTMLElement {
    const card = screen.getByText(name).closest('article')!;
    return within(card).getByRole('button', { name: new RegExp(`${name} is you$`) });
  }

  it('sends the claim for the row that was pressed', async () => {
    const user = userEvent.setup();
    const setIdentityLinkedToMe = vi.fn().mockResolvedValue(undefined);
    renderPage({ members: MOCK_TEAM_ROSTER }, { setIdentityLinkedToMe });
    await screen.findByText('Dorian');

    await user.click(claimControl('Miguel Ferreira-Santos'));

    expect(setIdentityLinkedToMe).toHaveBeenCalledWith('person-miguel', true);
  });

  it('draws the refusal on that row when the server says no', async () => {
    // The wiring this file exists to cover: the page holds ONE mutation for the whole grid, so a
    // refusal has to be routed back to the row it came from.
    const user = userEvent.setup();
    const setIdentityLinkedToMe = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('nope'), { code: 'operator_only' }));
    renderPage({ members: MOCK_TEAM_ROSTER }, { setIdentityLinkedToMe });
    await screen.findByText('Dorian');

    await user.click(claimControl('Miguel Ferreira-Santos'));

    const miguel = screen.getByText('Miguel Ferreira-Santos').closest('article')!;
    expect(await within(miguel).findByRole('alert')).toHaveTextContent(
      'Only this install’s owner can link accounts.'
    );
    // …and nowhere else on the page, which is the half a boolean would fail.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});

describe('TeamPage — the owner filter', () => {
  it('narrows to a person and their agents when their attribution is clicked', async () => {
    const user = userEvent.setup();
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Dorian');

    // The attribution under the OTHER person's agent, so a page that quietly filtered to the
    // operator would fail here.
    const card = screen.getByText('Cartographer of the Northern Reaches').closest('article')!;
    await user.click(
      within(card).getByRole('button', {
        name: 'Show only Miguel Ferreira-Santos and their agents',
      })
    );

    expect(cardNames()).toEqual(['Miguel Ferreira-Santos', 'Cartographer of the Northern Reaches']);
  });
});

describe('TeamPage — a card opens its own profile', () => {
  it('puts the member’s id on the URL, which is what a reload reopens', async () => {
    const user = userEvent.setup();
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Warden');

    const warden = MOCK_TEAM_ROSTER.find((m) => m.displayName === 'Warden')!;
    await user.click(screen.getByRole('button', { name: 'Open Warden’s profile' }));

    expect(harness.openProfileId()).toBe(warden.id);
  });
});

describe('TeamPage — grouping by manager', () => {
  it('clusters each person’s agents under them, and what nobody owns last', async () => {
    const user = userEvent.setup();
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Dorian');

    await user.click(chip('Group by owner'));

    // The To-dos section below the roster has its own heading; only the
    // owner clusters count here.
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .filter((heading) => heading.textContent !== 'To-dos');
    expect(headings).toHaveLength(3);
    expect(within(headings[0]!).getByText('Dorian')).toBeInTheDocument();
    expect(within(headings[0]!).getByText('@dorian')).toBeInTheDocument();
    expect(within(headings[1]!).getByText('Miguel Ferreira-Santos')).toBeInTheDocument();
    expect(within(headings[1]!).getByText('@miguel.telegram')).toBeInTheDocument();
    expect(headings[2]!).toHaveTextContent('No owner');
    // Two clusters, so a page that grouped everything under one owner — or
    // under "the operator" — fails here.
    expect(cardNames()).toEqual([
      'Warden',
      'Scout',
      'Cartographer of the Northern Reaches',
      'DorkBot',
    ]);
  });
});

describe('TeamPage — search', () => {
  it('matches display names and handles as you type', async () => {
    const user = userEvent.setup();
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Dorian');

    await user.type(screen.getByRole('searchbox', { name: 'Search the team' }), 'miguel');

    expect(cardNames()).toEqual(['Miguel Ferreira-Santos']);
  });
});

describe('TeamPage — the empty and degraded states', () => {
  it('is never empty: with no agents, the people are still on it', async () => {
    const peopleOnly = MOCK_TEAM_ROSTER.filter((member) => member.kind === 'human');
    renderPage({ members: peopleOnly });

    expect(await screen.findByText('Dorian')).toBeInTheDocument();
    // The invitation sits BELOW the cards rather than replacing them.
    expect(screen.getByText('Bring in existing projects')).toBeInTheDocument();
    expect(cardNames()).toEqual(['Dorian', 'Miguel Ferreira-Santos']);
  });

  it('names the source that failed, and still shows who it could read', async () => {
    const peopleOnly: TeamMember[] = MOCK_TEAM_ROSTER.filter((member) => member.kind === 'human');
    renderPage({
      members: peopleOnly,
      warnings: [{ source: 'agents', message: 'database is locked' }],
    });

    expect(
      await screen.findByText('Couldn’t read all your agents. Showing the rest.')
    ).toBeInTheDocument();
    expect(cardNames()).toEqual(['Dorian', 'Miguel Ferreira-Santos']);
  });
});

describe('the query-restore pause (DOR-1419)', () => {
  it('shows the loading state, not an empty roster, while a persisted cache is restoring', async () => {
    // `IsRestoringProvider` is the same context `PersistQueryClientProvider` sets while its
    // persister's restore promise is in flight — forcing it here reproduces the paused-query
    // window deterministically, without racing a real persister and a real router against each
    // other.
    const transport = createMockTransport({
      getTeamRoster: vi.fn().mockResolvedValue({ members: MOCK_TEAM_ROSTER }),
    } as Partial<Transport>);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <IsRestoringProvider value={true}>
          <TransportProvider transport={transport}>
            <harness.Wrapper>
              <TeamPage />
            </harness.Wrapper>
          </TransportProvider>
        </IsRestoringProvider>
      </QueryClientProvider>
    );

    await harness.ready();

    expect(screen.getByLabelText('Loading the team')).toBeInTheDocument();
    expect(screen.queryByText('Nobody to show yet.')).toBeNull();
    // The transport was never given the chance to answer — `IsRestoringProvider` keeps the query
    // from ever subscribing or fetching — which is the proof that the loading state above is read
    // off `isRestoring`, not off a request that happened to still be in flight.
    expect(transport.getTeamRoster).not.toHaveBeenCalled();
  });
});

describe('TeamPage — to-dos', () => {
  /** Someone else's person, and the cartographer re-homed onto them. */
  const priya: TeamMember = {
    id: 'person-priya',
    kind: 'human',
    displayName: 'Priya',
    handle: 'priya',
    isSelf: false,
    ownerId: null,
    origin: 'local',
    person: { role: null, lastSeenAt: null },
  } as TeamMember;
  const byId = (id: string) => MOCK_TEAM_ROSTER.find((member) => member.id === id)!;
  const warden = byId('agent-warden');
  const theirs: TeamMember = { ...byId('agent-cartographer'), ownerId: priya.id };

  const todoPromise = (id: string, agentId: string, what: string) => ({
    id,
    agentId,
    to: null,
    what,
    dueAt: null,
    state: 'open' as const,
    overdue: false,
    sourceSessionId: null,
    sourceRoomEntryId: null,
    createdAt: '2026-10-10T09:00:00.000Z',
    closedAt: null,
    note: null,
  });

  it('offers controls on your own agents’ to-dos only', async () => {
    const members = [
      ...MOCK_TEAM_ROSTER.filter((member) => member.id !== theirs.id),
      priya,
      theirs,
    ];
    renderPage(
      { members },
      {
        listTodoPromises: vi.fn().mockResolvedValue({
          todoPromises: [
            todoPromise('mine', warden.agent!.manifestId, 'Warden promise'),
            todoPromise('other', theirs.agent!.manifestId, 'Cartographer promise'),
          ],
        }),
      }
    );
    await screen.findByText('Warden promise');
    expect(screen.getByRole('button', { name: 'Mark kept: Warden promise' })).toBeInTheDocument();
    expect(screen.getByText('Cartographer promise')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Mark kept: Cartographer promise' })
    ).not.toBeInTheDocument();
  });
});
