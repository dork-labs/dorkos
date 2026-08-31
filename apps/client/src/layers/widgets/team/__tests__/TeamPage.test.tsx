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
import { QueryClient, QueryClientProvider, IsRestoringProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { TeamMember, TeamRosterResponse } from '@dorkos/shared/team-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  buildProfileDeepLinkHarness,
  type ProfileDeepLinkHarness,
} from '@/test-helpers/profile-deep-link';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { TeamPage } from '../ui/TeamPage';

// No local `motion/react` mock: `test-setup.ts` already mocks the whole module
// for every client test, and its version is strictly better — it renders the
// real tag rather than a `<div>`, strips motion props so they cannot leak to
// the DOM as unknown attributes, and exports the hooks too. The local subset
// that used to live here went red the moment this page's grid started reading
// `useReducedMotion`, which is the failure mode a partial mock always has.

/**
 * The router the page's own profile links write into.
 *
 * Rebuilt per test in `beforeEach`, so one test's open profile cannot leak into
 * the next through a shared history.
 */
let harness: ProfileDeepLinkHarness;

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

  it('names a platform the way the rest of the cockpit does', async () => {
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Dorian');

    // "On Telegram", not "On telegram" — the wire token goes through the same
    // resolver every other surface uses.
    expect(screen.getByText('On Telegram')).toBeInTheDocument();
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

    // The chip row shows both people, in their own group — the kind chips
    // answer a different question and must not be labelled as one set.
    const people = within(screen.getByRole('group', { name: 'Filter by person' }));
    expect(people.getByRole('button', { name: /Dorian/ })).toHaveTextContent('@dorian');
    expect(people.getByRole('button', { name: /Miguel/ })).toHaveTextContent('@miguel.telegram');
  });

  it('draws no person chips when there is only one person to choose', async () => {
    const oneOperator = MOCK_TEAM_ROSTER.filter((member) => member.id !== 'person-miguel');
    renderPage({ members: oneOperator });
    await screen.findByText('Dorian');

    expect(screen.queryByRole('group', { name: 'Filter by person' })).toBeNull();
  });
});

describe('TeamPage — the owner filter', () => {
  it('narrows to a person and their agents when their attribution is clicked', async () => {
    const user = userEvent.setup();
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Dorian');

    // The attribution under the OTHER person's agent, so a page that quietly
    // filtered to the operator would fail here. Scoped to that card: the
    // person chip carries the same accessible name, and this test is about
    // the attribution specifically.
    const card = screen.getByText('Cartographer of the Northern Reaches').closest('article')!;
    await user.click(
      within(card).getByRole('button', {
        name: 'Show only Miguel Ferreira-Santos and their agents',
      })
    );

    expect(cardNames()).toEqual(['Miguel Ferreira-Santos', 'Cartographer of the Northern Reaches']);
  });

  it('says whose roster this is, and offers a way back', async () => {
    const user = userEvent.setup();
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Dorian');

    // Via the person chip rather than the attribution, so both routes to the
    // same filter are exercised across this file.
    const people = within(screen.getByRole('group', { name: 'Filter by person' }));
    await user.click(people.getByRole('button', { name: /Miguel/ }));
    expect(screen.getByText('Showing @miguel.telegram and their agents')).toBeInTheDocument();

    await user.click(chip('Clear'));
    expect(cardNames()).toHaveLength(MOCK_TEAM_ROSTER.length);
  });

  it('attributes an agent to its owner by handle, and to nobody when nobody owns it', async () => {
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Dorian');

    const warden = screen.getByText('Warden').closest('article')!;
    const attribution = within(warden).getByRole('button', {
      name: 'Show only Dorian and their agents',
    });
    // The label says what it does; the visible text says whose it is.
    expect(attribution).toHaveTextContent('by @dorian');

    // The system agent belongs to the install, not to a person — so no
    // attribution. Named rather than "no button at all": every card now carries
    // the profile control, and this is about the ATTRIBUTION being absent.
    const dorkbot = screen.getByText('DorkBot').closest('article')!;
    expect(within(dorkbot).queryByRole('button', { name: /^Show only/ })).toBeNull();
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

  it('does not open a profile when the attribution inside the card is pressed', async () => {
    // **Half the guard, and only half — say which half.** This covers event
    // PROPAGATION: it is red the moment the card opens the profile from a
    // handler the attribution's click can bubble to (an `onClick` on the
    // `<article>`, the obvious shape this deliberately does not use).
    //
    // It cannot cover the other half. The card's reach is a `::after` overlay
    // and the attribution escapes it by being `relative` — both are PAINT
    // order, and jsdom computes no layout, so deleting that `relative` leaves
    // this green while a real click on the attribution starts opening the
    // profile instead. That half is asserted where a browser can see it:
    // `apps/e2e/tests/team/team-page.spec.ts`, via `elementFromPoint`.
    const user = userEvent.setup();
    renderPage({ members: MOCK_TEAM_ROSTER });
    await screen.findByText('Warden');

    // Scoped to the card: the toolbar carries a person chip with the same label.
    const warden = screen.getByText('Warden').closest('article')!;
    await user.click(
      within(warden).getByRole('button', { name: 'Show only Dorian and their agents' })
    );

    expect(harness.openProfileId()).toBeNull();
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

  it('does not offer to import projects when the roster could not be read at all', async () => {
    // What embedded mode returns: no rows, and a warning saying why. Offering
    // "Bring in existing projects" here would answer a question nobody asked
    // with a button that cannot help.
    renderPage({
      members: [],
      warnings: [{ source: 'team', message: 'No DorkOS server in embedded mode.' }],
    });

    expect(
      await screen.findByText('Your team lives on the DorkOS server, and there is no server here.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Bring in existing projects')).toBeNull();
    // "Nothing matched your filter" would be a lie: no filter is on.
    expect(screen.getByText('Nobody to show yet.')).toBeInTheDocument();
  });

  it('names an unknown source without leaking the wire token at the reader', async () => {
    renderPage({
      members: MOCK_TEAM_ROSTER,
      warnings: [{ source: 'community:acme', message: 'timed out' }],
    });

    expect(await screen.findByText("Some of your team couldn't be loaded.")).toBeInTheDocument();
    expect(screen.queryByText(/community:acme/)).toBeNull();
    // The diagnostic message is for a log, not for this page.
    expect(screen.queryByText(/timed out/)).toBeNull();
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

describe('the query-restore pause (DOR-1419)', () => {
  it('shows the loading state, not an empty roster, while a persisted cache is restoring', async () => {
    // `IsRestoringProvider` is the same context `PersistQueryClientProvider`
    // sets while its persister's restore promise is in flight — forcing it
    // here reproduces the paused-query window deterministically, without
    // racing a real persister and a real router against each other.
    // `useBaseQuery` reads it directly (`useBaseQuery.js`): while true, a
    // query neither subscribes nor fetches, so `isFetching` stays false. With
    // no data yet either, `isLoading` (`isPending && isFetching`) used to read
    // FALSE — nothing loading, nothing to show — and `TeamPage` painted
    // "Nobody to show yet." for a beat before the real roster arrived
    // (DOR-1419). `useIsRestoring` fixes that read; this pins it.
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
    // The transport was never given the chance to answer — `IsRestoringProvider`
    // keeps the query from ever subscribing or fetching — which is the proof
    // that the loading state above is read off `isRestoring`, not off a request
    // that happened to still be in flight.
    expect(transport.getTeamRoster).not.toHaveBeenCalled();
  });
});
