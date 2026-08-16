/**
 * @vitest-environment jsdom
 *
 * The managed-agent half of the profile (spec `profile-unification` §1.2, §1.4,
 * §1.5): the pages every nav row pushes, the counts the rows carry before you
 * push them, the Appearance page the face opens, and the kebab.
 *
 * The assertions that matter are the ones a careless port would pass and the
 * design would not: a Tasks row on an install with no tasks, an About editor
 * reachable on DorkBot, a rename that moves the manifest and leaves the roster
 * saying the old name, a Delete that fires without the typed confirmation.
 */
import { useState, type ReactNode } from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { buildProfileDeepLinkHarness } from '@/test-helpers/profile-deep-link';
import { ProfileView } from '../ui/ProfileView';
import { profilePage, isProfilePageAvailable } from '../ui/pages/registry';
import { isProfilePickAvailable } from '../ui/popovers/registry';
import { profileStack, type ProfilePageId, type ProfileStackState } from '../model/profile-stack';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }));
vi.mock('sonner', () => ({
  toast: Object.assign(toasts.message, { success: toasts.success, error: toasts.error }),
}));

const byId = (id: string): TeamMember => MOCK_TEAM_ROSTER.find((member) => member.id === id)!;

const SELF = byId('person-dorian');
const MANAGED = byId('agent-warden');
const DORKBOT = byId('agent-dorkbot');
const ROSTER: TeamMember[] = [SELF, MANAGED, byId('agent-scout'), DORKBOT];

/** The manifest `GET /api/agents/current` answers for Warden, conventions included. */
const WARDEN_MANIFEST = {
  id: MANAGED.agent!.manifestId,
  name: 'warden',
  displayName: 'Warden',
  description: 'Watches the build.',
  capabilities: ['review'],
  runtime: 'claude-code',
  traits: { verbosity: 3, autonomy: 3, chaos: 3, creativity: 3, humor: 3, spice: 3 },
  conventions: { soul: true, nope: true, dorkosKnowledge: true },
  behavior: { responseMode: 'always' },
  enabledToolGroups: {},
  mcpServers: [],
  soulContent: '<!-- TRAITS:START -->\ntraits\n<!-- TRAITS:END -->\nBe careful.',
  nopeContent: 'Never force-push.',
} as unknown as AgentManifest;

/** What the transport answers, with per-test overrides. */
function mockTransport(over: Record<string, unknown> = {}) {
  return createMockTransport({
    getAgentByPath: vi.fn().mockResolvedValue(WARDEN_MANIFEST),
    updateAgentByPath: vi.fn().mockResolvedValue(WARDEN_MANIFEST),
    ...over,
  });
}

/** A profile that really pushes and pops, so a page can be opened and left. */
function StatefulProfile({ member, start }: { member: TeamMember; start?: ProfilePageId }) {
  const [stack, setStack] = useState<ProfileStackState>(
    profileStack(member.id, start ? [{ kind: 'page', page: start }] : [])
  );
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

/** Mount a profile inside everything it needs, and hand back the cache. */
async function renderProfile(
  member: TeamMember,
  options: { start?: ProfilePageId; transport?: ReturnType<typeof mockTransport> } = {}
) {
  const harness = buildProfileDeepLinkHarness('/');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const transport = options.transport ?? mockTransport();

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
      <StatefulProfile member={member} start={options.start} />
    </Wrapper>
  );
  await harness.ready();
  return { transport, queryClient };
}

/** Open the row with this id. */
async function openRow(id: string) {
  await userEvent.click(document.querySelector(`[data-profile-row="${id}"]`)!);
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => cleanup());

describe('the registry', () => {
  it('serves every page §1.5 names', () => {
    // The row model names the whole set from the first slice; this is the
    // assertion that the build has caught up with it.
    const pages: ProfilePageId[] = [
      'about',
      'sessions',
      'tasks',
      'rooms',
      'skills',
      'tools',
      'connections',
      'instructions',
      'boundaries',
      'manages',
      'appearance',
      'name',
      'handle',
      'photo',
    ];
    for (const page of pages) {
      expect(isProfilePageAvailable(page), page).toBe(true);
      expect(profilePage(page)!.title, page).toBeTruthy();
    }
  });

  it('serves both popovers the property list offers', () => {
    expect(isProfilePickAvailable('runs-on')).toBe(true);
    expect(isProfilePickAvailable('personality')).toBe(true);
  });

  it('names Instructions and Boundaries after what they do, not after their files', () => {
    // The file name is the row's VALUE (SOUL.md, NOPE.md); the title is the
    // thing a person came here to change.
    expect(profilePage('instructions')!.title).toBe('Instructions');
    expect(profilePage('boundaries')!.title).toBe('Boundaries');
  });
});

describe('the counts a row carries', () => {
  it('says how many conversations there are before you open them', async () => {
    const sessions = [
      {
        id: 's1',
        title: 'One',
        updatedAt: new Date().toISOString(),
        cwd: MANAGED.agent!.projectPath,
      },
      {
        id: 's2',
        title: 'Two',
        updatedAt: new Date().toISOString(),
        cwd: MANAGED.agent!.projectPath,
      },
    ];
    await renderProfile(MANAGED, {
      transport: mockTransport({
        listSessions: vi.fn().mockResolvedValue({ sessions, warnings: [] }),
      }),
    });

    const row = document.querySelector('[data-profile-row="sessions"]')!;
    await waitFor(() => expect(row.textContent).toContain('2 conversations'));
  });

  it('counts only the schedules that belong to THIS agent', async () => {
    const schedules = [
      {
        id: 't1',
        name: 'Nightly',
        agentId: MANAGED.agent!.manifestId,
        enabled: true,
        status: 'active',
        nextRun: null,
      },
      {
        id: 't2',
        name: 'Someone else’s',
        agentId: 'other-agent',
        enabled: true,
        status: 'active',
        nextRun: null,
      },
    ];
    await renderProfile(MANAGED, {
      transport: mockTransport({ listTasks: vi.fn().mockResolvedValue(schedules) }),
    });

    const row = document.querySelector('[data-profile-row="tasks"]')!;
    await waitFor(() => expect(row.textContent).toContain('1 scheduled'));
  });

  it('draws no Tasks row at all where the server has tasks switched off', async () => {
    // Not "0 scheduled", and not a locked row: an install with the tool off has
    // no such thing as a schedule, so there is nothing here to name.
    await renderProfile(MANAGED, {
      transport: mockTransport({
        getConfig: vi.fn().mockResolvedValue({ features: { tasks: false } }),
      }),
    });

    await waitFor(() => expect(document.querySelector('[data-profile-row="tasks"]')).toBeNull());
    // The rows either side of it are untouched.
    expect(document.querySelector('[data-profile-row="sessions"]')).not.toBeNull();
    expect(document.querySelector('[data-profile-row="rooms"]')).not.toBeNull();
  });
});

describe('the popovers', () => {
  it('puts the runtime, the model and the effort behind one row', async () => {
    await renderProfile(MANAGED);

    await openRow('runs-on');

    // Three settings, one question — "what does this run on?" — so they are one
    // panel rather than the Config tab's three separate fields.
    expect(await screen.findByText('Runtime')).toBeInTheDocument();
    expect(screen.getByText('Model')).toBeInTheDocument();
    expect(screen.getByText('Effort')).toBeInTheDocument();
  });

  it('changes what an agent runs on, and tells the roster', async () => {
    const { transport, queryClient } = await renderProfile(MANAGED);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await openRow('runs-on');

    await userEvent.click(await screen.findByTestId('agent-model-row'));
    await userEvent.click(await screen.findByTestId('agent-model-row-inherit'));

    expect(transport.updateAgentByPath).toHaveBeenCalledWith(MANAGED.agent!.projectPath, {
      model: null,
    });
    await waitFor(() =>
      expect(invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey))).toContain(
        JSON.stringify(['team'])
      )
    );
  });

  it('opens the personality picker from its own row', async () => {
    await renderProfile(MANAGED);

    await openRow('personality');

    expect(await screen.findByText('How this agent talks')).toBeInTheDocument();
  });
});

describe('About, where an agent is named', () => {
  it('edits the name and the description on an agent you manage', async () => {
    const { transport } = await renderProfile(MANAGED, { start: 'about' });

    const name = await screen.findByTestId('agent-name-field');
    await userEvent.clear(name);
    await userEvent.type(name, 'Sentinel{Enter}');

    expect(transport.updateAgentByPath).toHaveBeenCalledWith(MANAGED.agent!.projectPath, {
      displayName: 'Sentinel',
    });
  });

  it('tells the roster as well as the manifest, so the header agrees', async () => {
    // The portrait, the property rows and /team all read `['team']`. A rename
    // that only invalidated the manifest left the header saying one name and
    // the roster behind it saying another (§4).
    const { queryClient } = await renderProfile(MANAGED, { start: 'about' });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const name = await screen.findByTestId('agent-name-field');
    await userEvent.clear(name);
    await userEvent.type(name, 'Sentinel{Enter}');

    await waitFor(() => {
      const keys = invalidate.mock.calls.map((call) => JSON.stringify(call[0]?.queryKey));
      expect(keys).toContain(JSON.stringify(['team']));
      expect(keys.some((key) => key?.includes('byPath'))).toBe(true);
      // And the fleet the sidebar draws (`agentKeys.resolved`), which is a
      // third reader of the same name — the prefix covers it.
      expect(keys).toContain(JSON.stringify(['agents']));
    });
  });

  it('adds and removes a capability', async () => {
    const { transport } = await renderProfile(MANAGED, { start: 'about' });

    await userEvent.click(await screen.findByRole('button', { name: /Remove capability review/ }));

    expect(transport.updateAgentByPath).toHaveBeenCalledWith(MANAGED.agent!.projectPath, {
      capabilities: [],
    });
  });

  it('never becomes an editor on DorkBot', async () => {
    // Its About row is locked, so the only way here is a link — and the server
    // answers 403 SYSTEM_PROTECTED, which is what the lock exists to preempt.
    await renderProfile(DORKBOT, { start: 'about' });

    expect(screen.queryByTestId('agent-name-field')).toBeNull();
    expect(screen.queryByTestId('agent-description-field')).toBeNull();
  });
});

describe('Instructions and Boundaries', () => {
  it('edits SOUL.md’s prose and saves the whole file around the traits', async () => {
    const { transport } = await renderProfile(MANAGED, { start: 'instructions' });

    const editor = await screen.findByPlaceholderText('Write markdown content...');
    expect(editor).toHaveValue('Be careful.');
    // `clear` + `type` rather than `type` alone: the caret's starting position
    // is not something this test should be asserting about, and typing into an
    // un-cleared field made the whole case depend on it.
    await userEvent.clear(editor);
    await userEvent.type(editor, 'Be careful. Twice.');
    const save = screen.getByRole('button', { name: 'Save' });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);

    const [, updates] = vi.mocked(transport.updateAgentByPath).mock.calls[0];
    const soul = (updates as { soulContent: string }).soulContent;
    expect(soul).toContain('Be careful. Twice.');
    // The trait block the personality picker owns survives a prose save.
    expect(soul).toContain('TRAITS:END');
  });

  it('keeps Save inert until something has actually changed', async () => {
    await renderProfile(MANAGED, { start: 'instructions' });

    expect(await screen.findByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('keeps the NOPE disclaimer wherever boundaries are edited', async () => {
    await renderProfile(MANAGED, { start: 'boundaries' });

    expect(await screen.findByText(/not enforced at the tool level/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Write markdown content...')).toHaveValue(
      'Never force-push.'
    );
  });
});

describe('the Appearance page', () => {
  it('opens from the face, and comes back to it', async () => {
    await renderProfile(MANAGED);

    const face = screen.getByRole('button', { name: /Change Warden’s face and personality/ });
    await userEvent.click(face);

    expect(await screen.findByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    // One page, two sections — the colour and the manner are the same decision
    // made twice, so there are no tabs between them.
    expect(await screen.findByTestId('avatar-picker-panel')).toBeInTheDocument();
    expect(screen.getByText('Personality')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Back to profile' }));

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Change Warden’s face and personality/ })
      ).toHaveFocus()
    );
  });

  it('is not offered on DorkBot — its face is part of DorkOS', async () => {
    await renderProfile(DORKBOT);

    expect(screen.queryByRole('button', { name: /face and personality/ })).toBeNull();
  });
});

describe('the kebab', () => {
  async function openKebab(member: TeamMember) {
    await renderProfile(member);
    await userEvent.click(
      screen.getByRole('button', { name: `Actions for ${member.displayName}` })
    );
  }

  it('offers everything on an agent you manage', async () => {
    await openKebab(MANAGED);

    expect(await screen.findByRole('menuitem', { name: 'Copy @handle' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Block' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Unregister' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete agent and data' })).toBeInTheDocument();
  });

  it('says why a system agent has none of them', async () => {
    await openKebab(DORKBOT);

    expect(
      await screen.findByText(/can’t be blocked, unregistered or deleted/)
    ).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Unregister' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete agent and data' })).toBeNull();
  });

  it('leaves a person with nothing but their handle', async () => {
    await openKebab(SELF);

    expect(await screen.findByRole('menuitem', { name: 'Copy @handle' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Delete/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Set as default' })).toBeNull();
  });

  it('does not offer to set the default agent to the one that already is', async () => {
    // The header's `default` badge has already said so; an item that answers a
    // tap with nothing is the dead affordance this design removes.
    await openKebab(MANAGED);

    expect(await screen.findByRole('menuitem', { name: 'Copy @handle' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Set as default' })).toBeNull();
  });

  it('holds Delete behind the agent’s name, typed out', async () => {
    const { transport } = await renderProfile(MANAGED);
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Warden' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete agent and data' }));

    const confirm = await screen.findByRole('button', { name: 'Delete agent and data' });
    expect(confirm).toBeDisabled();

    await userEvent.type(screen.getByTestId('delete-confirm-input'), 'Warden');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);

    await waitFor(() =>
      expect(transport.deleteAgentData).toHaveBeenCalledWith(MANAGED.agent!.manifestId)
    );
  });
});
