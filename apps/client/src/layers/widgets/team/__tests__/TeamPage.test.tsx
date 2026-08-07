/**
 * @vitest-environment jsdom
 *
 * The Team page against a roster the product cannot produce yet: two people,
 * four agents, two owners (spec §W2.6). Every assertion below that mentions a
 * second person is the point of the file — a component that assumed one person,
 * or that reached for "the operator" instead of reading a list, fails here and
 * passes against every roster today's server can build.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { TeamMember, TeamRosterResponse } from '@dorkos/shared/team-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { TeamPage } from '../ui/TeamPage';

// AgentGhostRows animates in with `motion`; jsdom has no layout, so render the
// markup and skip the animation rather than assert on frames that never run.
vi.mock('motion/react', () => ({
  motion: new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...rest }: { children?: ReactNode }) => <div {...rest}>{children}</div>,
    }
  ),
  AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

function renderPage(roster: TeamRosterResponse) {
  const transport = createMockTransport({
    getTeamRoster: vi.fn().mockResolvedValue(roster),
  } as Partial<Transport>);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
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

  it('draws no @ at all for an identity with no handle', async () => {
    renderPage({ members: MOCK_TEAM_ROSTER });

    const card = await screen.findByText('Cartographer of the Northern Reaches');
    const article = card.closest('article')!;
    // No line at all where the handle goes — not an empty `@`, and not
    // `@null`. An unclaimed handle reaches nobody, so drawing one would be a
    // lie about how to address this agent.
    expect(article.querySelector('[data-slot="team-member-handle"]')).toBeNull();

    // The same selector on a row that HAS one, so the assertion above is a
    // statement about this agent rather than about a slot nothing ever fills.
    const warden = screen.getByText('Warden').closest('article')!;
    expect(warden.querySelector('[data-slot="team-member-handle"]')).toHaveTextContent('@warden');
  });

  it('says an agent was active recently in words, never as a live dot', async () => {
    const { container } = renderPage({ members: MOCK_TEAM_ROSTER });

    expect(await screen.findAllByText('Active in the last hour')).toHaveLength(2);
    // `recentlyActive` means "the mesh heard from it within the hour", which is
    // not "it is working right now". The pulsing dot says right now, so wiring
    // the two together would put a live signal on an agent that stopped forty
    // minutes ago.
    expect(container.querySelector('.animate-ping')).toBeNull();
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

  it('narrows to agents, hiding every person', async () => {
    const user = userEvent.setup();
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Dorian');

    await user.click(chip('Agents'));

    expect(cardNames()).toEqual([
      'Warden',
      'Scout',
      'Cartographer of the Northern Reaches',
      'DorkBot',
    ]);
  });

  it('offers a chip per person, because there is more than one', async () => {
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Dorian');

    // The chip row names both people by handle. On a one-person install these
    // do not appear at all, which is why the fixture has two.
    expect(chip('@dorian')).toBeInTheDocument();
    expect(chip('@miguel.telegram')).toBeInTheDocument();
  });

  it('draws no person chips when there is only one person to choose', async () => {
    const oneOperator = MOCK_TEAM_ROSTER.filter((member) => member.id !== 'person-miguel');
    renderPage({ members: oneOperator });
    await screen.findByText('Dorian');

    expect(screen.queryByRole('button', { name: '@dorian' })).toBeNull();
  });
});

describe('TeamPage — the owner filter', () => {
  it('narrows to a person and their agents when their attribution is clicked', async () => {
    const user = userEvent.setup();
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Dorian');

    // The attribution under the OTHER person's agent, so a page that quietly
    // filtered to the operator would fail here.
    await user.click(chip('by @miguel.telegram'));

    expect(cardNames()).toEqual(['Miguel Ferreira-Santos', 'Cartographer of the Northern Reaches']);
  });

  it('says whose roster this is, and offers a way back', async () => {
    const user = userEvent.setup();
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Dorian');

    await user.click(chip('@miguel.telegram'));
    expect(screen.getByText('Showing @miguel.telegram and their agents')).toBeInTheDocument();

    await user.click(chip('Clear'));
    expect(cardNames()).toHaveLength(MOCK_TEAM_ROSTER.length);
  });

  it('attributes an agent to its owner by handle, and to nobody when nobody owns it', async () => {
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Dorian');

    const warden = screen.getByText('Warden').closest('article')!;
    expect(within(warden).getByRole('button', { name: 'by @dorian' })).toBeInTheDocument();

    // The system agent belongs to the install, not to a person.
    const dorkbot = screen.getByText('DorkBot').closest('article')!;
    expect(within(dorkbot).queryByRole('button', { name: /^by / })).toBeNull();
  });
});

describe('TeamPage — grouping by manager', () => {
  it('clusters each person’s agents under them, and what nobody owns last', async () => {
    const user = userEvent.setup();
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Dorian');

    await user.click(chip('Group: manager'));

    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings).toHaveLength(3);
    expect(within(headings[0]!).getByText('Dorian')).toBeInTheDocument();
    expect(within(headings[0]!).getByText('@dorian')).toBeInTheDocument();
    expect(within(headings[1]!).getByText('Miguel Ferreira-Santos')).toBeInTheDocument();
    expect(within(headings[1]!).getByText('@miguel.telegram')).toBeInTheDocument();
    expect(headings[2]!).toHaveTextContent('Belongs to no one');
    // Two clusters, so a page that grouped everything under one owner — or
    // under "the operator" — fails here.
    expect(cardNames()).toEqual([
      'Warden',
      'Scout',
      'Cartographer of the Northern Reaches',
      'DorkBot',
    ]);
  });

  it('does not draw a person twice — as a cluster header and again as a card', async () => {
    const user = userEvent.setup();
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Dorian');

    await user.click(chip('Group: manager'));

    expect(cardNames()).not.toContain('Dorian');
    expect(cardNames()).not.toContain('Miguel Ferreira-Santos');
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

  it('says so when nothing matches, rather than showing an empty page', async () => {
    const user = userEvent.setup();
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Dorian');

    await user.type(screen.getByRole('searchbox', { name: 'Search the team' }), 'zzz');

    expect(cardNames()).toEqual([]);
    expect(screen.getByText('Nobody here matches that.')).toBeInTheDocument();
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

  it('does not invite you to import projects when agents already exist', async () => {
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Dorian');

    expect(screen.queryByText('Bring in existing projects')).toBeNull();
  });

  it('names the source that failed, and still shows who it could read', async () => {
    const peopleOnly: TeamMember[] = MOCK_TEAM_ROSTER.filter((member) => member.kind === 'human');
    renderPage({
      members: peopleOnly,
      warnings: [{ source: 'agents', message: 'database is locked' }],
    });

    expect(
      await screen.findByText("Couldn't read your agents — showing who we could.")
    ).toBeInTheDocument();
    expect(cardNames()).toEqual(['Dorian', 'Miguel Ferreira-Santos']);
  });

  it('draws no banner when every source read cleanly', async () => {
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Dorian');

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('lets you dismiss the banner', async () => {
    const user = userEvent.setup();
    renderPage({
      members: MOCK_TEAM_ROSTER,
      warnings: [{ source: 'agents', message: 'database is locked' }],
    });
    await screen.findByRole('status');

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByRole('status')).toBeNull();
  });
});
