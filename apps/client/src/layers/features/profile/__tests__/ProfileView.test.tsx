/**
 * @vitest-environment jsdom
 *
 * One profile, six relationships (spec `profile-unification` §1.1–§1.5).
 *
 * The fixtures mirror `design/05-states-final.html`: you, another person,
 * somebody bridged in over Telegram, an agent you manage, an agent somebody
 * else manages, and DorkBot. The assertions that matter are the ones a per-kind
 * fork would pass and the design would not: a Message button with nowhere to
 * go, a live dot on an agent that finished an hour ago, someone else's rows
 * drawn as controls.
 */
import { useState, type ReactNode } from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { useInteractionStore } from '@/layers/entities/interactions';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { buildProfileDeepLinkHarness } from '@/test-helpers/profile-deep-link';
import { ProfileView } from '../ui/ProfileView';
import {
  profileStack,
  type ProfileStackEntry,
  type ProfileStackState,
} from '../model/profile-stack';

const toasts = vi.hoisted(() => ({ success: vi.fn(), message: vi.fn() }));
vi.mock('sonner', () => ({
  toast: Object.assign(toasts.message, { success: toasts.success }),
}));

const byId = (id: string): TeamMember => MOCK_TEAM_ROSTER.find((member) => member.id === id)!;

/** A second local person, which the shared roster has none of. */
const PRIYA: TeamMember = {
  id: 'person-priya',
  kind: 'human',
  displayName: 'Priya',
  handle: 'priya',
  isSelf: false,
  ownerId: null,
  origin: 'local',
  person: { role: 'Staff architect', lastSeenAt: null },
};

const SELF = byId('person-dorian');
const BRIDGED = byId('person-miguel');
const MANAGED = byId('agent-warden');
const OTHERS_AGENT: TeamMember = { ...byId('agent-cartographer'), ownerId: PRIYA.id };
const DORKBOT = byId('agent-dorkbot');

/** The same agent between turns: heard from recently, doing nothing now. */
const IDLE: TeamMember = {
  ...MANAGED,
  agent: {
    ...MANAGED.agent!,
    activity: { working: null, lastActiveAt: new Date(Date.now() - 40 * 60_000).toISOString() },
  },
};

/** An agent whose folder the roster cannot place — a member from somewhere else. */
const UNPLACED: TeamMember = (() => {
  const { projectPath: _remote, ...agent } = MANAGED.agent!;
  return { ...MANAGED, agent };
})();

const ROSTER: TeamMember[] = [
  SELF,
  PRIYA,
  BRIDGED,
  MANAGED,
  byId('agent-scout'),
  OTHERS_AGENT,
  DORKBOT,
];

/** Mount a profile inside everything it needs: a router, a transport, a cache. */
async function renderProfile(
  member: TeamMember,
  options: {
    stack?: ProfileStackState;
    inOwnSession?: boolean;
    onPush?: (e: ProfileStackEntry) => void;
  } = {}
) {
  const harness = buildProfileDeepLinkHarness('/');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const transport = createMockTransport({ getAgentByPath: vi.fn().mockResolvedValue(null) });
  const onPush = options.onPush ?? vi.fn();
  const onPop = vi.fn();

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <harness.Wrapper>
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>
            <TooltipProvider>{children}</TooltipProvider>
          </TransportProvider>
        </QueryClientProvider>
      </harness.Wrapper>
    );
  }

  render(
    <Wrapper>
      <ProfileView
        member={member}
        roster={ROSTER}
        home="sheet"
        inOwnSession={options.inOwnSession}
        stack={options.stack ?? profileStack(member.id)}
        onPush={onPush}
        onPop={onPop}
      />
    </Wrapper>
  );

  await harness.ready();
  return { onPush, onPop };
}

/** The rendered rows, as `label kind` — the same shape the row-model test reads. */
function renderedRows(): string[] {
  return [...document.querySelectorAll('[data-slot="profile-row"]')].map(
    (row) => `${row.textContent?.replace(/\s+/g, ' ').trim()}|${row.getAttribute('data-row-kind')}`
  );
}

/** Just the labels, in order. */
function rowLabels(): string[] {
  return [...document.querySelectorAll('[data-profile-row]')].map(
    (row) => row.getAttribute('data-profile-row')!
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useInteractionStore.getState().reset();
  // jsdom ships no clipboard, and `useCopyFeedback` reaches for it directly.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => cleanup());

describe('the portrait, in one fixed order', () => {
  it('reads face, name, handle, status, who it belongs to, then the button', async () => {
    await renderProfile(MANAGED);

    const header = document.querySelector('[data-slot="profile-header"]')!;
    const order = [...header.querySelectorAll('[data-slot="identity-avatar"], h2, button, p')]
      .map((el) => el.getAttribute('data-slot') ?? el.tagName.toLowerCase())
      .join(' ');

    // The disc first, the name after it, the button last. Nothing else lives
    // up here — everything else in the profile is a row.
    expect(order.indexOf('identity-avatar')).toBeLessThan(order.indexOf('h2'));
    expect(screen.getByText('Warden')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy @handle' })).toBeInTheDocument();
    expect(screen.getByText(/Working in #team ·/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Managed by/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open session' })).toBeInTheDocument();
  });

  it('flags you, the system agent and the default one', async () => {
    await renderProfile(SELF);
    expect(screen.getByText('you')).toBeInTheDocument();
    cleanup();

    await renderProfile(DORKBOT);
    expect(screen.getByText('system')).toBeInTheDocument();
    cleanup();

    await renderProfile(MANAGED);
    expect(screen.getByText('default')).toBeInTheDocument();
  });

  it('says nothing rather than an empty @ when there is no handle', async () => {
    await renderProfile({ ...byId('agent-cartographer'), ownerId: PRIYA.id });
    expect(screen.queryByRole('button', { name: 'Copy @handle' })).toBeNull();
  });

  it('copies the handle when you tap it, inline — no toast beside it', async () => {
    await renderProfile(MANAGED);

    await userEvent.click(screen.getByRole('button', { name: 'Copy @handle' }));

    expect(await screen.findByRole('button', { name: 'Copy @handle' })).toHaveTextContent('Copied');
    expect(toasts.success).not.toHaveBeenCalled();
  });
});

describe('the status line', () => {
  it('spends its one live dot only on a turn that is running now', async () => {
    await renderProfile(MANAGED);
    expect(document.querySelector('[data-slot="profile-status-dot"]')).toHaveAttribute(
      'data-live',
      'true'
    );
    cleanup();

    // `recentlyActive` is a 60-minute mesh window, not "right now". The old
    // drawer said "Active in the last hour" from it; a dot keyed on the same
    // fact would claim a live turn for an agent that finished 40 minutes ago —
    // which is exactly this fixture.
    await renderProfile(IDLE);
    expect(document.querySelector('[data-slot="profile-status-dot"]')).not.toHaveAttribute(
      'data-live'
    );
  });

  it('never puts the live signal on the face itself', async () => {
    await renderProfile(MANAGED);
    // identity-micro-interactions §3D: words, never a ring or a dot on the disc.
    expect(document.querySelector('[data-slot="identity-status-dot"]')).toBeNull();
  });
});

describe('who it belongs to', () => {
  it('names the owner, and pushes their profile when tapped', async () => {
    const onPush = vi.fn();
    await renderProfile(MANAGED, { onPush });

    await userEvent.click(screen.getByRole('button', { name: /Managed by/ }));

    expect(onPush).toHaveBeenCalledWith({ kind: 'profile', memberId: 'person-dorian' });
  });

  it('says "You" rather than your own handle on an agent of yours', async () => {
    await renderProfile(MANAGED);
    expect(screen.getByRole('button', { name: 'Managed by You' })).toBeInTheDocument();
  });

  // Priya has a handle, so this is the case that tells the two apart: the line
  // names a person the way the portrait above names one, and `@priya` is an
  // address rather than who they are (design 05, state 5).
  it('names the other person on their agent, and not their handle', async () => {
    await renderProfile(OTHERS_AGENT);

    expect(screen.getByRole('button', { name: 'Managed by Priya' })).toBeInTheDocument();
    expect(screen.queryByText(/@priya/)).toBeNull();
  });

  it('promises the push with a chevron, the way a nav row does', async () => {
    await renderProfile(OTHERS_AGENT);

    const pill = screen.getByRole('button', { name: /Managed by/ });
    // `aria-hidden`, so it says nothing twice — the pill is already a button.
    expect(pill.querySelector('svg[aria-hidden]')).not.toBeNull();
  });

  it('says DorkBot belongs to the install, and offers no owner to open', async () => {
    await renderProfile(DORKBOT);
    expect(screen.getByText('System agent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Managed by/ })).toBeNull();
  });

  it('gives a person no belongs-to line at all', async () => {
    await renderProfile(PRIYA);
    expect(screen.queryByText(/Managed by/)).toBeNull();
    expect(screen.queryByText('System agent')).toBeNull();
  });
});

describe('the one button', () => {
  // It reads "Open session", not "Message": what it does is land on `/session`
  // with this agent's directory, and a person who reads "Message" is promised
  // a DM instead (spec `sidebar-simplification` §D2). Re-seed the old word and
  // every case in this block goes red on the query alone.
  it('says what it does rather than promising a message', async () => {
    await renderProfile(MANAGED);

    expect(screen.getByRole('button', { name: 'Open session' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Message' })).toBeNull();
  });

  it('opens the agent’s own directory, and records the agent', async () => {
    await renderProfile(MANAGED);

    await userEvent.click(screen.getByRole('button', { name: 'Open session' }));

    // It names a directory, not a session — which conversation opens is
    // resolved afterwards — so the agent is the only honest thing to record.
    expect(Object.keys(useInteractionStore.getState().opened)).toEqual([
      `agent:${MANAGED.agent!.projectPath}`,
    ]);
  });

  it('is gone on your own profile', async () => {
    await renderProfile(SELF);
    expect(screen.queryByRole('button', { name: 'Open session' })).toBeNull();
  });

  it('is gone when the profile is docked in that agent’s own session', async () => {
    // The composer is right there. A button that scrolls you to where you
    // already are is the panel arguing with itself.
    await renderProfile(MANAGED, { inOwnSession: true });
    expect(screen.queryByRole('button', { name: 'Open session' })).toBeNull();
  });

  it('is gone when there is nowhere for a session to open', async () => {
    // No session belongs to a person, and none to an identity that reaches us
    // over Telegram (§8). Never a dead button.
    await renderProfile(PRIYA);
    expect(screen.queryByRole('button', { name: 'Open session' })).toBeNull();
    cleanup();

    await renderProfile(BRIDGED);
    expect(screen.queryByRole('button', { name: 'Open session' })).toBeNull();
    cleanup();

    // An agent whose folder the roster cannot place is one we cannot open.
    await renderProfile(UNPLACED);
    expect(screen.queryByRole('button', { name: 'Open session' })).toBeNull();
  });
});

describe('the rows', () => {
  it('draws your four fields and what you belong to, as controls', async () => {
    await renderProfile(SELF);
    expect(rowLabels()).toEqual(['name', 'handle', 'photo', 'email', 'manages', 'rooms']);
    expect(renderedRows().every((row) => !row.endsWith('|null'))).toBe(true);
  });

  it('draws someone else’s agent as facts, plus the rooms you share', async () => {
    // Nothing private, and nothing to change: About and Runs on are plain
    // facts. Rooms is the one door, because a room is a shared surface.
    await renderProfile(OTHERS_AGENT);
    const kinds = [...document.querySelectorAll('[data-profile-row]')].map(
      (row) => `${row.getAttribute('data-profile-row')}:${row.getAttribute('data-row-kind')}`
    );
    expect(kinds).toEqual(['runs-on:text', 'rooms:nav']);
  });

  it('keeps DorkBot’s locked rows visible, and explains them on tap', async () => {
    await renderProfile(DORKBOT);
    const about = document.querySelector('[data-profile-row="about"]')!;
    expect(about.getAttribute('data-row-kind')).toBe('locked');

    await userEvent.click(about);

    expect(toasts.message).toHaveBeenCalledWith(expect.stringContaining('part of DorkOS'));
    // And a screen reader is told the same thing without the tap.
    expect(about.getAttribute('aria-describedby')).not.toBeNull();
  });

  it('draws the whole §1.4 list for an agent you manage, in order', async () => {
    await renderProfile(MANAGED);
    expect(rowLabels()).toEqual([
      'about',
      'runs-on',
      'personality',
      'folder',
      'sessions',
      'tasks',
      'rooms',
      'notifications',
      'skills',
      'tools',
      'connections',
      'instructions',
      'boundaries',
      'memory',
    ]);
  });

  it('draws a pick as a control, and opens its popover on tap', async () => {
    await renderProfile(MANAGED);
    const runsOn = document.querySelector('[data-profile-row="runs-on"]')!;
    expect(runsOn.getAttribute('data-row-kind')).toBe('pick');
    // The row still says what it currently is — a control you have to open to
    // read would be worse than the fact it replaced.
    expect(runsOn.textContent).toContain('Claude Code · opus-4.8');
    expect(runsOn).toHaveAttribute('aria-haspopup', 'dialog');

    await userEvent.click(runsOn);

    // The row IS the trigger, so the row is what reports the open panel — what
    // is inside it is `ProfileAgentPages.test`'s subject, not this one's.
    await waitFor(() => expect(runsOn).toHaveAttribute('aria-expanded', 'true'));
  });

  it('gives DorkBot the same work rows and none of the identity ones', async () => {
    await renderProfile(DORKBOT);
    // Who DorkBot IS is part of DorkOS; how it SOUNDS is yours, and so is what
    // it runs on and what it has been doing.
    expect(rowLabels()).toEqual([
      'about',
      'runs-on',
      'personality',
      'sessions',
      'tasks',
      'rooms',
      'notifications',
      'skills',
      'tools',
    ]);
    const kind = (id: string) =>
      document.querySelector(`[data-profile-row="${id}"]`)!.getAttribute('data-row-kind');
    expect(kind('about')).toBe('locked');
    // Not locked: onboarding asks you to pick DorkBot's voice on the first run
    // and the server has never protected `traits`, so a locked row here was the
    // profile refusing a change the product had already invited (DOR-1255).
    expect(kind('personality')).toBe('pick');
    // The one thing that IS yours to set on it: the model it runs on.
    expect(kind('runs-on')).toBe('pick');
  });

  it('copies the real folder, not the shortened one, inline — no toast beside it', async () => {
    await renderProfile(MANAGED);
    const row = document.querySelector('[data-profile-row="folder"]')!;

    await userEvent.click(row);

    await waitFor(() => expect(row.querySelector('.lucide-check')).toBeInTheDocument());
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it('draws the identity’s own colour as the rule above them', async () => {
    // The panel's "whose this is" moment, and it does not move to say so
    // (identity-micro-interactions §3D4). On the body rather than under the
    // header, so it exists exactly when there is something to separate.
    await renderProfile(SELF);
    const rows = document.querySelector('[data-slot="profile-rows"]') as HTMLElement;
    expect(rows.style.borderTopColor).toContain('var(--identity-color) 55%');
  });

  it('draws no body at all when this build has no row to put in it', async () => {
    // An empty framed region running the height of the panel is what the old
    // drawer got wrong. Nothing production serves dates a bridged person's
    // first sighting, so their Rooms row is the only one they have — take it
    // away and the portrait stands alone rather than over a void.
    await renderProfile({ ...BRIDGED, id: 'person-nowhere' });
    expect(screen.getByRole('heading', { name: 'Miguel Ferreira-Santos' })).toBeInTheDocument();
    expect(rowLabels()).toEqual(['rooms']);
  });

  it('pushes the page a nav row names', async () => {
    const onPush = vi.fn();
    await renderProfile(SELF, { onPush });

    await userEvent.click(document.querySelector('[data-profile-row="manages"]')!);

    expect(onPush).toHaveBeenCalledWith({ kind: 'page', page: 'manages' });
  });
});

/** A profile that actually pushes and pops, so the frame can be driven. */
function StatefulProfile({ member }: { member: TeamMember }) {
  const [stack, setStack] = useState<ProfileStackState>(profileStack(member.id));
  return (
    <ProfileView
      member={member}
      roster={ROSTER}
      home="sheet"
      stack={stack}
      onPush={(entry) =>
        setStack((current) => (entry.kind === 'page' ? { ...current, entries: [entry] } : current))
      }
      onPop={() => setStack((current) => ({ ...current, entries: [] }))}
    />
  );
}

describe('pushing a page', () => {
  async function renderStateful(member: TeamMember) {
    const harness = buildProfileDeepLinkHarness('/');
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const transport = createMockTransport({ getAgentByPath: vi.fn().mockResolvedValue(null) });

    render(
      <harness.Wrapper>
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>
            <TooltipProvider>
              <StatefulProfile member={member} />
            </TooltipProvider>
          </TransportProvider>
        </QueryClientProvider>
      </harness.Wrapper>
    );
    await harness.ready();
    return harness;
  }

  it('takes the whole panel, keeping only the way back and the strip', async () => {
    await renderStateful(SELF);

    await userEvent.click(document.querySelector('[data-profile-row="manages"]')!);

    const page = await screen.findByRole('heading', { name: 'Manages' });
    expect(page).toBeInTheDocument();
    // The portrait is gone; the strip carries the same identity in one line.
    expect(document.querySelector('[data-slot="profile-header"]')).toBeNull();
    const strip = document.querySelector('[data-slot="profile-strip"]')!;
    expect(within(strip as HTMLElement).getByText('Dorian')).toBeInTheDocument();
  });

  it('puts focus on the page’s title, not on its back link', async () => {
    await renderStateful(SELF);

    await userEvent.click(document.querySelector('[data-profile-row="manages"]')!);

    const title = await screen.findByRole('heading', { name: 'Manages' });
    expect(title).toHaveFocus();
  });

  it('offers the way out first, and names it', async () => {
    await renderStateful(SELF);

    await userEvent.click(document.querySelector('[data-profile-row="manages"]')!);
    const back = await screen.findByRole('button', { name: 'Back to profile' });

    const page = document.querySelector('[data-slot="profile-page"]')!;
    expect(page.querySelector('button')).toBe(back);
  });

  it('comes back to the row it left from', async () => {
    await renderStateful(SELF);
    await userEvent.click(document.querySelector('[data-profile-row="manages"]')!);

    await userEvent.click(await screen.findByRole('button', { name: 'Back to profile' }));

    // Focus back where the eye already is — not at the top of a list the
    // person has to find their place in again.
    expect(document.querySelector('[data-profile-row="manages"]')).toHaveFocus();
  });

  it('comes back to the FACE when the page the face pushed is popped', async () => {
    // Appearance is the one page no row opens — its control is the portrait
    // itself — so the pop has nothing named `data-profile-row` to restore. The
    // face carries `data-profile-return` for exactly this, and without it focus
    // falls to the frame and the next Tab starts the panel over.
    await renderStateful(MANAGED);

    await userEvent.click(
      screen.getByRole('button', { name: 'Change Warden’s face and personality' })
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Back to profile' }));

    expect(document.querySelector('[data-profile-return="appearance"]')).toHaveFocus();
  });

  // `?profilePage=` is an address anybody can type, and the pages that edit an
  // identity all write the OPERATOR's own profile. Without this gate,
  // `?profile=<DorkBot>&profilePage=name` drew "What DorkOS calls you" seeded
  // with DorkBot's name over a Save that renamed the operator.
  it('refuses a page no row of this identity offers, and stays on the portrait', async () => {
    await renderProfile(DORKBOT, {
      stack: profileStack(DORKBOT.id, [{ kind: 'page', page: 'name' }]),
    });

    expect(screen.queryByRole('heading', { name: 'Name' })).toBeNull();
    expect(screen.queryByLabelText('Display name')).toBeNull();
    expect(document.querySelector('[data-slot="profile-header"]')).not.toBeNull();
  });

  it('still opens a page the identity’s own rows do offer', async () => {
    await renderProfile(DORKBOT, {
      stack: profileStack(DORKBOT.id, [{ kind: 'page', page: 'rooms' }]),
    });

    expect(await screen.findByRole('heading', { name: 'Rooms' })).toBeInTheDocument();
  });

  it('lists the agents you manage, each a door into its own profile', async () => {
    await renderStateful(SELF);

    await userEvent.click(document.querySelector('[data-profile-row="manages"]')!);

    expect(await screen.findByText('Warden')).toBeInTheDocument();
    expect(screen.getByText('Scout')).toBeInTheDocument();
    // Priya's agent is hers, not yours.
    expect(screen.queryByText('Cartographer of the Northern Reaches')).toBeNull();
  });
});
