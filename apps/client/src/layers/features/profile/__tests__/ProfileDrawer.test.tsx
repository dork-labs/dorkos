/**
 * @vitest-environment jsdom
 *
 * One drawer, both kinds (spec `identity-consistency` §W3.2).
 *
 * The assertions that matter here are the ones a per-kind fork or an `isSelf`
 * code path would pass: an agent drawn with a person's disc, a working dot
 * standing in for an hour-old fact, and someone else's email rendered because
 * the payload happened to carry one. Each of those is red below.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { ResponsiveSheet, ResponsiveSheetContent } from '@/layers/shared/ui';
import { ProfileDrawer } from '../ui/ProfileDrawer';

const byId = (id: string): TeamMember => MOCK_TEAM_ROSTER.find((member) => member.id === id)!;

const operator = byId('person-dorian');
const miguel = byId('person-miguel');
const warden = byId('agent-warden');
const scout = byId('agent-scout');

/** The disc the drawer draws for the identity, portalled into `document.body`. */
function disc(): HTMLElement {
  const el = document.body.querySelector('[data-slot="identity-avatar"]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

afterEach(() => {
  cleanup();
});

/** The drawer's own panel, portalled into `document.body`. */
function panel(): HTMLElement {
  const el = document.body.querySelector('[data-slot="profile-drawer"]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

describe('ProfileDrawer — whose panel this is', () => {
  it('wears the identity’s own colour, and says so with a static rule', () => {
    // A full panel about exactly one identity that mentioned that identity's
    // colour nowhere. The rule under the header is the answer, and it is
    // deliberately STATIC: the calm version of "the identity answers" is a
    // panel that states whose it is without moving to say so.
    render(<ProfileDrawer member={warden} open onOpenChange={() => {}} />);

    expect(panel().style.getPropertyValue('--identity-color')).not.toBe('');
    // Inline, because `index.css` sets `border-color` on `*` in an unlayered
    // rule that outranks Tailwind's whole utilities layer — no `border-<colour>`
    // class paints a border in this app.
    expect(panel().innerHTML).toContain('var(--identity-color) 55%');
    expect(panel().innerHTML).toContain('border-b-2');
  });

  it('draws no rule at all when there is no body to separate', () => {
    // A hairline under a header with nothing beneath it fences off nothing.
    // Miguel is a person: no project, no namespace, no registration date, and
    // not you, so `factsFor` returns an empty list.
    render(<ProfileDrawer member={miguel} open onOpenChange={() => {}} />);

    expect(panel().innerHTML).not.toContain('var(--identity-color) 55%');
  });
});

describe('ProfileDrawer — an agent', () => {
  it('draws the agent silhouette: a square disc, never a person’s circle', () => {
    render(<ProfileDrawer member={warden} open onOpenChange={() => {}} />);

    // `lg` + square resolves to `rounded-2xl` in `identityAvatarVariants`;
    // a circle would carry `rounded-full`. Drawing an agent as a person is
    // the regression this file exists to catch.
    expect(disc().className).toContain('rounded-2xl');
    expect(disc().className).not.toContain('rounded-full');
  });

  it('says how it runs — runtime and model in one chip', () => {
    render(<ProfileDrawer member={warden} open onOpenChange={() => {}} />);

    expect(screen.getByText('Claude Code · opus-4.8')).toBeInTheDocument();
  });

  it('names the person it belongs to', () => {
    render(<ProfileDrawer member={warden} owner={operator} open onOpenChange={() => {}} />);

    expect(screen.getByText('Managed by @dorian')).toBeInTheDocument();
  });

  it('states liveness in words, and draws no working dot for it', () => {
    const { baseElement } = render(<ProfileDrawer member={warden} open onOpenChange={() => {}} />);

    expect(screen.getByText('Active in the last hour')).toBeInTheDocument();
    // `recentlyActive` means "the mesh heard from it within the hour", and the
    // pulsing dot means "right now". Wiring the two together would put a live
    // signal on an agent that finished forty minutes ago.
    expect(baseElement.querySelector('.animate-ping')).toBeNull();
  });

  it('shades the absence of liveness rather than flattening it', () => {
    // `scout` is `stale` — which the mesh also returns for an agent it has
    // never heard from, so the words must not name a span it cannot know.
    render(<ProfileDrawer member={scout} open onOpenChange={() => {}} />);

    expect(screen.getByText('No recent activity')).toBeInTheDocument();
  });

  it('distinguishes a day-old agent from one nobody has heard from', () => {
    const yesterday: TeamMember = {
      ...scout,
      agent: { ...scout.agent!, healthStatus: 'inactive' },
    };
    render(<ProfileDrawer member={yesterday} open onOpenChange={() => {}} />);

    expect(screen.getByText('Active in the last day')).toBeInTheDocument();
  });

  it('says an unreachable agent’s folder is missing, rather than calling it quiet', () => {
    const gone: TeamMember = {
      ...scout,
      agent: { ...scout.agent!, healthStatus: 'unreachable' },
    };
    render(<ProfileDrawer member={gone} open onOpenChange={() => {}} />);

    expect(screen.getByText('Its folder can’t be found')).toBeInTheDocument();
  });

  it('offers a session in the agent’s own project, when the roster knows where that is', async () => {
    const onOpenSession = vi.fn();
    const placed: TeamMember = {
      ...warden,
      agent: { ...warden.agent!, projectPath: '/Users/dorian/code/dorkos' },
    };
    render(
      <ProfileDrawer member={placed} open onOpenChange={() => {}} onOpenSession={onOpenSession} />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Open a session' }));

    expect(onOpenSession).toHaveBeenCalledWith('/Users/dorian/code/dorkos');
    expect(screen.getByText('/Users/dorian/code/dorkos')).toBeInTheDocument();
  });

  it('offers no session when there is nowhere to open one', () => {
    // The roster now fills `projectPath` for every agent registered on this
    // machine (spec `profile-unification` §3.1), so the pathless row is the one
    // it genuinely cannot place — an agent whose directory the mesh's paths
    // listing did not know. An action with no destination is not drawn rather
    // than drawn dead.
    const { projectPath: _nowhere, ...unplaced } = warden.agent!;
    render(
      <ProfileDrawer
        member={{ ...warden, agent: unplaced }}
        open
        onOpenChange={() => {}}
        onOpenSession={vi.fn()}
      />
    );

    expect(screen.queryByRole('button', { name: 'Open a session' })).toBeNull();
  });

  it('says when it joined this install', () => {
    render(<ProfileDrawer member={warden} open onOpenChange={() => {}} />);

    expect(screen.getByText('Jul 1, 2026')).toBeInTheDocument();
  });

  it('marks the default and system agents as what they are', () => {
    render(<ProfileDrawer member={warden} open onOpenChange={() => {}} />);
    expect(screen.getByText('default')).toBeInTheDocument();

    cleanup();
    render(<ProfileDrawer member={byId('agent-dorkbot')} open onOpenChange={() => {}} />);
    expect(screen.getByText('system')).toBeInTheDocument();
  });
});

describe('ProfileDrawer — a person', () => {
  it('draws the person silhouette: a circle, never an agent’s square', () => {
    render(<ProfileDrawer member={operator} open onOpenChange={() => {}} />);

    expect(disc().className).toContain('rounded-full');
    expect(disc().className).not.toContain('rounded-2xl');
  });

  it('says where they are, in the words the rest of the cockpit uses', () => {
    render(<ProfileDrawer member={operator} open onOpenChange={() => {}} />);
    expect(screen.getByText('On this machine')).toBeInTheDocument();

    cleanup();
    render(<ProfileDrawer member={miguel} open onOpenChange={() => {}} />);
    expect(screen.getByText('On Telegram')).toBeInTheDocument();
  });

  it('shows a declared role instead of guessing at one', () => {
    const staffed: TeamMember = { ...miguel, person: { role: 'Design partner', lastSeenAt: null } };
    render(<ProfileDrawer member={staffed} open onOpenChange={() => {}} />);

    expect(screen.getByText('Design partner')).toBeInTheDocument();
  });
});

describe('ProfileDrawer — what `isSelf` gates', () => {
  it('shows your email on your own row', () => {
    render(<ProfileDrawer member={operator} open onOpenChange={() => {}} />);

    expect(screen.getByText('dorian@dorkos.ai')).toBeInTheDocument();
  });

  it('shows nobody else’s, even when the payload carries one', () => {
    // The server only ever sends `email` on the viewer's own row, so this
    // fixture cannot arrive today. The drawer refusing it anyway is what keeps
    // that true the day a second source is less careful.
    const leaky: TeamMember = {
      ...miguel,
      person: { role: null, email: 'miguel@example.com', lastSeenAt: null },
    };
    render(<ProfileDrawer member={leaky} open onOpenChange={() => {}} />);

    expect(screen.queryByText('miguel@example.com')).toBeNull();
  });

  it('offers Edit on your own row', async () => {
    const onEdit = vi.fn();
    render(<ProfileDrawer member={operator} open onOpenChange={() => {}} onEdit={onEdit} />);

    await userEvent.click(screen.getByRole('button', { name: 'Edit profile' }));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('offers Edit on nobody else’s', () => {
    const notYou: TeamMember = { ...operator, isSelf: false };
    render(<ProfileDrawer member={notYou} open onOpenChange={() => {}} onEdit={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Edit profile' })).toBeNull();
  });

  it('draws the same drawer either way — the `you` chip is the only difference', () => {
    render(<ProfileDrawer member={operator} open onOpenChange={() => {}} />);
    expect(screen.getByText('you')).toBeInTheDocument();
    expect(screen.getByText('Dorian')).toBeInTheDocument();
    expect(screen.getByText('@dorian')).toBeInTheDocument();

    cleanup();
    const notYou: TeamMember = {
      ...operator,
      isSelf: false,
      person: { role: null, lastSeenAt: null },
    };
    render(<ProfileDrawer member={notYou} open onOpenChange={() => {}} />);
    expect(screen.queryByText('you')).toBeNull();
    expect(screen.getByText('Dorian')).toBeInTheDocument();
    expect(screen.getByText('@dorian')).toBeInTheDocument();
  });
});

describe('ProfileDrawer — a row with nothing to say', () => {
  // The state the playground's rich fixture hides and a real install serves
  // constantly: a person carries no project, no namespace and no registration
  // date, and only your own row carries an email. An unconditional scroll
  // region turns that into ~700px of framed blank down the whole panel.
  it('draws no body at all when the identity has no facts', () => {
    const { baseElement } = render(<ProfileDrawer member={miguel} open onOpenChange={() => {}} />);

    expect(screen.getByText('Miguel Ferreira-Santos')).toBeInTheDocument();
    expect(baseElement.querySelector('[data-slot="profile-facts"]')).toBeNull();
  });

  it('draws no hairline under the header when nothing follows it', () => {
    const { baseElement } = render(<ProfileDrawer member={miguel} open onOpenChange={() => {}} />);

    const header = baseElement.querySelector('[data-slot="sheet-header"]');
    expect(header).not.toBeNull();
    expect(header!.className).not.toContain('border-b');
  });

  it('still draws the body — and its rule — the moment there is one fact', () => {
    const { baseElement } = render(
      <ProfileDrawer member={operator} open onOpenChange={() => {}} />
    );

    expect(baseElement.querySelector('[data-slot="profile-facts"]')).not.toBeNull();
    expect(baseElement.querySelector('[data-slot="sheet-header"]')!.className).toContain(
      'border-b'
    );
  });
});

describe('ProfileDrawer — how fast it arrives', () => {
  const panelOf = (baseElement: HTMLElement) =>
    baseElement.querySelector('[data-slot="profile-drawer"]')!;

  it('opens in 300ms, not the primitive’s 500', () => {
    // 500 made this the slowest transition in the identity flow and the most
    // noticeable — you watched a panel arrive rather than finding it already
    // there, every time, on a surface people open to read a project path.
    const { baseElement } = render(
      <ProfileDrawer member={operator} open onOpenChange={() => {}} />
    );
    const classes = panelOf(baseElement).className;

    expect(classes).toContain('data-[state=open]:duration-300');
    // And the primitive's own value is gone rather than merely outranked in
    // source order: `cn` runs tailwind-merge, so the loser is dropped outright.
    // If it survived here, the winner would be whichever the cascade preferred.
    expect(classes).not.toContain('data-[state=open]:duration-500');
  });

  it('leaves every other sheet in the app alone', () => {
    // Scoped to this panel deliberately: the Sheet primitive is shared with
    // Settings' panels, and re-timing every sheet is a decision about every
    // sheet — which this change is not. Rendered rather than read off the
    // source, so it is the shipped behaviour being checked and not a string.
    const { baseElement } = render(
      <ResponsiveSheet open>
        <ResponsiveSheetContent>a plain sheet</ResponsiveSheetContent>
      </ResponsiveSheet>
    );

    expect(baseElement.querySelector('[data-slot="sheet-content"]')!.className).toContain(
      'data-[state=open]:duration-500'
    );
  });
});

describe('ProfileDrawer — an identity with no handle', () => {
  it('says nothing rather than an empty @', () => {
    const { baseElement } = render(
      <ProfileDrawer member={byId('agent-cartographer')} open onOpenChange={() => {}} />
    );

    expect(screen.getByText('Cartographer of the Northern Reaches')).toBeInTheDocument();
    expect(baseElement.textContent).not.toContain('@');
  });
});
