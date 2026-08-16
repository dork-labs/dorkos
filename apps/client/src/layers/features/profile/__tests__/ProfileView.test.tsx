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
import { render, screen, cleanup, within } from '@testing-library/react';
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

/** A live turn on an agent. Temporary shape — see `profile-status.ts`'s seam. */
function working(member: TeamMember, roomName: string | null = 'team'): TeamMember {
  return {
    ...member,
    agent: {
      ...member.agent!,
      projectPath: '/Users/dorian/code/dorkos',
      activity: {
        working: { roomId: 'r1', roomName, since: new Date(Date.now() - 120_000).toISOString() },
        lastActiveAt: new Date(Date.now() - 120_000).toISOString(),
      },
    } as TeamMember['agent'],
  };
}

/** A second local person, which the shared roster has none of. */
const PRIYA: TeamMember = {
  id: 'person-priya',
  kind: 'human',
  displayName: 'Priya',
  handle: 'priya',
  isSelf: false,
  ownerId: null,
  origin: 'local',
  person: { role: 'Staff architect' },
};

const SELF = byId('person-dorian');
const BRIDGED = byId('person-miguel');
const MANAGED = working(byId('agent-warden'));
const OTHERS_AGENT: TeamMember = { ...byId('agent-cartographer'), ownerId: PRIYA.id };
const DORKBOT: TeamMember = {
  ...byId('agent-dorkbot'),
  agent: { ...byId('agent-dorkbot').agent!, projectPath: '/Users/dorian/.dork/agents/dorkbot' },
};

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
    expect(screen.getByText('Working in #team · 2 min')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Managed by/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Message' })).toBeInTheDocument();
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

  it('copies the handle when you tap it', async () => {
    await renderProfile(MANAGED);

    await userEvent.click(screen.getByRole('button', { name: 'Copy @handle' }));

    expect(toasts.success).toHaveBeenCalledWith('Copied');
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
    // fact would claim a live turn for an agent that finished 40 minutes ago.
    await renderProfile(byId('agent-warden'));
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

  it('names the other person on their agent', async () => {
    await renderProfile(OTHERS_AGENT);
    expect(screen.getByRole('button', { name: 'Managed by @priya' })).toBeInTheDocument();
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
  it('opens the agent’s own directory, and records the agent', async () => {
    await renderProfile(MANAGED);

    await userEvent.click(screen.getByRole('button', { name: 'Message' }));

    // It names a directory, not a session — which conversation opens is
    // resolved afterwards — so the agent is the only honest thing to record.
    expect(Object.keys(useInteractionStore.getState().opened)).toEqual([
      'agent:/Users/dorian/code/dorkos',
    ]);
  });

  it('is gone on your own profile', async () => {
    await renderProfile(SELF);
    expect(screen.queryByRole('button', { name: 'Message' })).toBeNull();
  });

  it('is gone when the profile is docked in that agent’s own session', async () => {
    // The composer is right there. A button that scrolls you to where you
    // already are is the panel arguing with itself.
    await renderProfile(MANAGED, { inOwnSession: true });
    expect(screen.queryByRole('button', { name: 'Message' })).toBeNull();
  });

  it('is gone when there is nowhere for a message to go', async () => {
    // No DM route to a person exists, and none out over Telegram (§8). Never a
    // dead button.
    await renderProfile(PRIYA);
    expect(screen.queryByRole('button', { name: 'Message' })).toBeNull();
    cleanup();

    await renderProfile(BRIDGED);
    expect(screen.queryByRole('button', { name: 'Message' })).toBeNull();
    cleanup();

    // An agent whose folder the roster does not know is one we cannot open.
    await renderProfile(byId('agent-warden'));
    expect(screen.queryByRole('button', { name: 'Message' })).toBeNull();
  });
});

describe('the rows', () => {
  it('draws your four fields and what you belong to, as controls', async () => {
    await renderProfile(SELF);
    // Rooms is absent because its page is not registered yet (W1.2 brings the
    // data): a row whose destination does not exist is not drawn.
    expect(rowLabels()).toEqual(['name', 'handle', 'photo', 'email', 'manages']);
    expect(renderedRows().every((row) => !row.endsWith('|null'))).toBe(true);
  });

  it('draws someone else’s agent as facts, with no arrows', async () => {
    await renderProfile(OTHERS_AGENT);
    const kinds = [...document.querySelectorAll('[data-profile-row]')].map((row) =>
      row.getAttribute('data-row-kind')
    );
    expect(kinds.every((kind) => kind === 'text')).toBe(true);
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

  it('does not draw a row whose page this build has not got', async () => {
    await renderProfile(MANAGED);
    // Sessions, Tasks, Skills, Tools, Connections, Instructions, Boundaries all
    // arrive with W2.2's pages. Personality is a `pick` whose popover is also
    // W2.2's, and it carries no value to fall back to — a label with empty
    // space beside it is not a fact, so it waits too.
    expect(rowLabels()).toEqual(['about', 'runs-on', 'folder']);
  });

  it('draws a pick with no popover behind it yet as the plain fact it carries', async () => {
    await renderProfile(MANAGED);
    const runsOn = document.querySelector('[data-profile-row="runs-on"]')!;
    expect(runsOn.getAttribute('data-row-kind')).toBe('text');
    expect(runsOn.textContent).toContain('Claude Code · opus-4.8');
  });

  it('copies the real folder, not the shortened one', async () => {
    await renderProfile(MANAGED);

    await userEvent.click(document.querySelector('[data-profile-row="folder"]')!);

    expect(toasts.success).toHaveBeenCalledWith('Copied');
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
    // Somebody bridged in over Telegram has only a Rooms row, whose page W1.2
    // brings. An empty framed region running the height of the panel is what
    // the old drawer got wrong.
    await renderProfile(BRIDGED);
    expect(screen.getByRole('heading', { name: 'Miguel Ferreira-Santos' })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="profile-rows"]')).toBeNull();
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

  it('lists the agents you manage, each a door into its own profile', async () => {
    await renderStateful(SELF);

    await userEvent.click(document.querySelector('[data-profile-row="manages"]')!);

    expect(await screen.findByText('Warden')).toBeInTheDocument();
    expect(screen.getByText('Scout')).toBeInTheDocument();
    // Priya's agent is hers, not yours.
    expect(screen.queryByText('Cartographer of the Northern Reaches')).toBeNull();
  });
});
