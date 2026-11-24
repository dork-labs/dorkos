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
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import {
  MEMORY_MAX_CHARS,
  SOUL_MAX_CHARS,
  buildSoulContent,
} from '@dorkos/shared/convention-files';
import { DEFAULT_TRAITS, renderTraits } from '@dorkos/shared/trait-renderer';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { buildProfileDeepLinkHarness } from '@/test-helpers/profile-deep-link';
import { ProfileView } from '../ui/ProfileView';
import { profilePage, profilePageTitle, isProfilePageAvailable } from '../ui/pages/registry';
import { profileStack, type ProfilePageId, type ProfileStackState } from '../model/profile-stack';
import { openEveryProfileFold, resetProfileFolds } from './profile-fold-helpers';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }));
vi.mock('sonner', () => ({
  toast: Object.assign(toasts.message, { success: toasts.success, error: toasts.error }),
}));

// The Sessions page draws the shared chat list, which reads the fleet-wide
// prompt list off the app's event stream. These cases stand up no stream; what
// the list needs from it is which chats have a prompt waiting, and none do.
vi.mock('@/layers/entities/attention', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/attention')>()),
  usePendingInteractions: () => ({ interactions: [], isLoading: false, isError: false }),
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
  conventions: { soul: true, nope: true, memory: true, dorkosKnowledge: true },
  behavior: { responseMode: 'always' },
  mcpServers: [],
  soulContent: '<!-- TRAITS:START -->\ntraits\n<!-- TRAITS:END -->\nBe careful.',
  nopeContent: 'Never force-push.',
  memoryContent: '- Deploys go out on Tuesdays. (noted in #product, 2026-08-24)',
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
  // The REAL error policy, caches included. A client declared from scratch here
  // carries no `MutationCache.onError`, so "this surface reports a failure
  // exactly once" would be asserted against a surface that has no app-wide
  // toast to double up with — which is the trap `createQueryClientConfig`'s own
  // doc warns about. Only the query retry and gc are overridden, so a test that
  // rejects a read fails fast instead of retrying.
  const config = createQueryClientConfig();
  const queryClient = new QueryClient({
    ...config,
    defaultOptions: {
      ...config.defaultOptions,
      queries: { ...config.defaultOptions?.queries, retry: false, gcTime: 0 },
    },
  });
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

// The pages are code-split (`registry.ts` uses `lazy`), so the first render of
// one waits on a real dynamic import — which vitest transforms on demand, and
// under a loaded machine that took longer than a `findBy`'s second. This file
// then went red on the machine rather than on a bug. Importing the modules once
// up front turns every later wait into an already-resolved promise.
//
// The ceiling is the hook's own, not the default 10s, because what this waits on
// is four module graphs being transformed on demand — work whose cost belongs to
// the machine and the transform cache, not to anything under test. On a busy
// machine it outran 10s and the whole file failed in a hook. Nothing here polls
// or sleeps: the imports resolve as soon as they are compiled, so the wider
// ceiling is only ever spent when the machine is the thing that is slow.
beforeAll(async () => {
  await Promise.all([
    import('../ui/pages/AboutPage'),
    import('../ui/pages/AppearancePage'),
    import('../ui/pages/ConventionPage'),
    import('../ui/pages/SessionsPage'),
  ]);
}, 60_000);

/** A promise this test decides the ending of — a request that has not answered. */
function deferred<T>() {
  let settle!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle, fail };
}

beforeEach(() => {
  resetProfileFolds();
  openEveryProfileFold(ROSTER);
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
      'activity',
      'skills',
      'tools',
      'connections',
      'instructions',
      'boundaries',
      'memory',
      'manages',
      'appearance',
      'name',
      'handle',
      'photo',
    ];
    for (const page of pages) {
      expect(isProfilePageAvailable(page), page).toBe(true);
      expect(profilePageTitle(profilePage(page)!, MANAGED), page).toBeTruthy();
    }
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
    await waitFor(() => expect(row.textContent).toContain('2 chats'));
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
});

describe('the popovers', () => {
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

  it('writes the personality into SOUL.md, not only into the manifest', async () => {
    // A turn reads the trait block out of SOUL.md; the manifest alone reaches
    // the prompt only where that block already exists. Writing both is what the
    // panel this replaced always did, and what makes the change audible (DOR-1253).
    const { transport } = await renderProfile(MANAGED);
    await openRow('personality');

    await userEvent.click(await screen.findByRole('button', { name: /The Sage/ }));

    await waitFor(() => expect(transport.updateAgentByPath).toHaveBeenCalled());
    const [, updates] = vi.mocked(transport.updateAgentByPath).mock.calls[0];
    const patch = updates as { traits?: unknown; soulContent?: string };
    expect(patch.traits).toBeDefined();
    expect(patch.soulContent).toContain('TRAITS:END');
    // And the prose already in the file is still under it.
    expect(patch.soulContent).toContain('Be careful.');
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

  it('adds and removes a capability', async () => {
    const { transport } = await renderProfile(MANAGED, { start: 'about' });

    await userEvent.click(await screen.findByRole('button', { name: /Remove capability review/ }));

    expect(transport.updateAgentByPath).toHaveBeenCalledWith(MANAGED.agent!.projectPath, {
      capabilities: [],
    });
  });

  it('will not save an agent with no name, and says so where you typed it', async () => {
    const { transport } = await renderProfile(MANAGED, { start: 'about' });

    const name = await screen.findByTestId('agent-name-field');
    await userEvent.clear(name);
    await userEvent.type(name, '{Enter}');

    expect(transport.updateAgentByPath).not.toHaveBeenCalled();
    // Not silently blank: the field goes back to what the agent is called, and
    // the reason sits under it.
    expect(name).toHaveValue('Warden');
    expect(screen.getByText(/A name can’t be empty/)).toBeInTheDocument();
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

    const editor = await screen.findByPlaceholderText('Write markdown here…');
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

  it('says why a refused save failed, and keeps the text', async () => {
    // The rejection is DEFERRED on purpose. `useUpdateAgent` writes the patch
    // into the manifest cache optimistically and rolls it back on failure, and
    // an immediate rejection batches both into one render — so the editor never
    // sees the optimistic value and the bug hides. Left in flight for a render,
    // the round trip is the real one, and it used to end with the operator's
    // text replaced by the version the server had just refused to change.
    const save = deferred<AgentManifest>();
    const transport = mockTransport({
      updateAgentByPath: vi.fn().mockReturnValue(save.promise),
    });
    await renderProfile(MANAGED, { start: 'instructions', transport });

    const editor = await screen.findByPlaceholderText('Write markdown here…');
    await userEvent.type(editor, ' More.');
    const button = screen.getByRole('button', { name: 'Save' });
    await userEvent.click(button);
    await waitFor(() => expect(transport.updateAgentByPath).toHaveBeenCalled());

    save.fail(new Error('SOUL.md is too long: the whole file has to fit in 4,000 characters.'));

    // ONE toast, not two. The page used to toast for itself beside the app-wide
    // mutation handler, so a refusal was reported twice in two different voices
    // — the page's precise sentence and a generic "That didn't work. Try
    // again." The page now names the action through `meta.errorLabel`, which
    // becomes the toast's headline, and the server's own sentence sits under it
    // as the description (DOR-1755).
    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    expect(toasts.error).toHaveBeenCalledWith(
      'Couldn’t save your instructions',
      expect.objectContaining({
        description: 'SOUL.md is too long: the whole file has to fit in 4,000 characters.',
      })
    );
    expect(toasts.success).not.toHaveBeenCalled();
    // The draft survives the rollback, and stays dirty — a refusal is a reason
    // to try again, not to lose what you wrote.
    expect(editor).toHaveValue('Be careful. More.');
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('refuses to save a file the whole of which is over budget', async () => {
    // The editor bounds the prose; the server bounds the FILE. A legal-looking
    // 3,900 characters of instructions was over once the trait block above it
    // was counted, and the page offered a Save that could not work.
    const traitBlock = renderTraits({ ...DEFAULT_TRAITS, ...WARDEN_MANIFEST.traits });
    const overhead = buildSoulContent(traitBlock, 'x').length - 1;
    const prose = 'x'.repeat(SOUL_MAX_CHARS - overhead - 2);
    const transport = mockTransport({
      getAgentByPath: vi.fn().mockResolvedValue({
        ...WARDEN_MANIFEST,
        soulContent: buildSoulContent(traitBlock, prose),
      }),
    });
    await renderProfile(MANAGED, { start: 'instructions', transport });

    const editor = await screen.findByPlaceholderText('Write markdown here…');
    await userEvent.type(editor, 'yyy');

    const save = screen.getByRole('button', { name: 'Save' });
    await waitFor(() => expect(save).toBeDisabled());
    const status = document.querySelector('[data-slot="profile-convention-status"]')!;
    expect(status.textContent).toContain('Too long by 1 character');
    expect(status.textContent).toContain('personality block');
    expect(transport.updateAgentByPath).not.toHaveBeenCalled();
  });

  it('asks before Back throws away what you wrote', async () => {
    await renderProfile(MANAGED, { start: 'instructions' });

    const editor = await screen.findByPlaceholderText('Write markdown here…');
    await userEvent.type(editor, ' More.');
    await userEvent.click(screen.getByRole('button', { name: 'Back to profile' }));

    expect(await screen.findByText('Discard your changes?')).toBeInTheDocument();
    // Still on the page, with the text intact.
    expect(screen.getByPlaceholderText('Write markdown here…')).toHaveValue('Be careful. More.');

    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));

    expect(await screen.findByRole('heading', { name: 'Warden' })).toBeInTheDocument();
  });
});

describe('Memory, where an agent’s notes can be read and corrected', () => {
  it('opens the file the agent writes, and saves an edit to it', async () => {
    const { transport } = await renderProfile(MANAGED, { start: 'memory' });

    const editor = await screen.findByPlaceholderText('Write markdown here…');
    expect(editor).toHaveValue('- Deploys go out on Tuesdays. (noted in #product, 2026-08-24)');

    await userEvent.clear(editor);
    await userEvent.type(editor, '- Deploys go out on Thursdays.');
    const save = screen.getByRole('button', { name: 'Save' });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);

    expect(transport.updateAgentByPath).toHaveBeenCalledWith(MANAGED.agent!.projectPath, {
      memoryContent: '- Deploys go out on Thursdays.',
    });
  });

  it('says who else can end up reading this, before you type into it', async () => {
    // The two facts about this file a person cannot get by looking at it: what is
    // here can come up in any chat, and the agent writes here itself. Both stay
    // visible, not behind the details toggle.
    await renderProfile(MANAGED, { start: 'memory' });

    expect(
      await screen.findByText(
        'Anything here can come up in any chat. Never keep secrets, passwords or keys here.'
      )
    ).toBeVisible();
    expect(screen.getByText('Your agent writes notes here as it works.')).toBeVisible();
  });

  it('refuses to save a file somebody made too big on disk, and says by how much', async () => {
    // The tool and the wire both refuse to cross the cap, so the only way a
    // memory file gets over it is an editor on disk — and that file still opens
    // here. Trimming it back under the cap is the fix, and the page has to say
    // how far there is to go rather than offering a Save that cannot work.
    const transport = mockTransport({
      getAgentByPath: vi.fn().mockResolvedValue({
        ...WARDEN_MANIFEST,
        memoryContent: 'x'.repeat(MEMORY_MAX_CHARS + 3),
      }),
    });
    await renderProfile(MANAGED, { start: 'memory', transport });

    const editor = await screen.findByPlaceholderText('Write markdown here…');
    await userEvent.type(editor, '{backspace}');

    const save = screen.getByRole('button', { name: 'Save' });
    await waitFor(() => expect(save).toBeDisabled());
    expect(
      document.querySelector('[data-slot="profile-convention-status"]')!.textContent
    ).toContain('Too long by 2 characters');
    expect(transport.updateAgentByPath).not.toHaveBeenCalled();
  });
});

describe('the Sessions page', () => {
  it('does not claim there are none while it is still asking', async () => {
    const sessions = deferred<{ sessions: unknown[]; warnings: unknown[] }>();
    await renderProfile(MANAGED, {
      start: 'sessions',
      transport: mockTransport({ listSessions: vi.fn().mockReturnValue(sessions.promise) }),
    });

    await screen.findByRole('heading', { name: 'Chats' });
    expect(screen.queryByText(/No chats with/)).toBeNull();
    expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();

    sessions.settle({ sessions: [], warnings: [] });

    expect(await screen.findByText('No chats with Warden yet.')).toBeInTheDocument();
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

  it('refuses a typed ?profilePage=appearance on an identity that has no face button', async () => {
    // No row pushes this page, so the row table cannot gate it — but it is an
    // editor, and the address bar reaches it. It lands on the root instead.
    await renderProfile(DORKBOT, { start: 'appearance' });

    expect(screen.queryByRole('heading', { name: 'Appearance' })).toBeNull();
    expect(await screen.findByRole('heading', { name: 'DorkBot' })).toBeInTheDocument();
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

  // Spec `audit-trail` PR5: any agent can be paused everywhere, DorkBot too,
  // and anyone but the agent itself can lift it.
  it('pauses an agent everywhere from its profile, with a reason', async () => {
    const transport = mockTransport();
    await renderProfile(MANAGED, { transport });

    await userEvent.click(screen.getByRole('button', { name: 'Actions for Warden' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Pause everywhere' }));
    await userEvent.type(await screen.findByTestId('pause-reason-input'), 'looping');
    await userEvent.click(screen.getByRole('button', { name: 'Pause agent' }));

    await waitFor(() =>
      expect(transport.pauseAgent).toHaveBeenCalledWith(MANAGED.agent!.manifestId, 'looping')
    );
    expect(toasts.message).toHaveBeenCalledWith('Warden paused');
  });

  it('offers Resume on a paused agent, shows it as paused, and resumes it', async () => {
    const transport = mockTransport({
      listAgentPauses: vi.fn().mockResolvedValue({
        pauses: [
          {
            agentId: MANAGED.agent!.manifestId,
            pausedBy: { accountId: 'p', kind: 'person', name: 'Owner' },
            pausedAt: '2026-10-09T00:00:00.000Z',
          },
        ],
      }),
    });
    await renderProfile(MANAGED, { transport });

    expect(await screen.findByTestId('profile-paused-badge')).toHaveTextContent('paused');
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Warden' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Resume' }));

    await waitFor(() =>
      expect(transport.resumeAgent).toHaveBeenCalledWith(MANAGED.agent!.manifestId)
    );
  });

  it('says the folder is blocked when the agent file had to stay on disk', async () => {
    // The durable second effect of unregistering an agent whose manifest git
    // tracks: the file is left alone and the folder denied, so the agent does
    // not simply come back on the next scan. A toast that only said
    // "unregistered" would leave the person to discover the block themselves
    // (DOR-1019).
    const transport = mockTransport();
    transport.unregisterMeshAgent = vi
      .fn()
      .mockResolvedValue({ success: true, blockedFromDiscovery: true });
    await renderProfile(MANAGED, { transport });

    await userEvent.click(screen.getByRole('button', { name: 'Actions for Warden' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Unregister' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Unregister agent' }));

    await waitFor(() =>
      expect(toasts.message).toHaveBeenCalledWith(
        expect.stringContaining('scans skip it'),
        expect.anything()
      )
    );
  });

  it('passes the server’s refusal through when the files belong to a repo', async () => {
    // The 409 this route can answer carries the only instruction the person
    // gets. Without `meta.errorLabel` the shared mutation toast throws that
    // sentence away and says "That didn't work. Try again." (DOR-1019).
    const transport = mockTransport();
    transport.deleteAgentData = vi
      .fn()
      .mockRejectedValue(
        new Error('Cannot delete /repo/.dork: agent.json in it is tracked by git')
      );
    await renderProfile(MANAGED, { transport });

    await userEvent.click(screen.getByRole('button', { name: 'Actions for Warden' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete agent and data' }));
    await userEvent.type(screen.getByTestId('delete-confirm-input'), 'Warden');
    await userEvent.click(screen.getByRole('button', { name: 'Delete agent and data' }));

    // Both halves still reach the person, in their own slots since DOR-1755:
    // the authored line is the headline, the server's sentence the description.
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith(
        expect.stringContaining(`Couldn’t delete this agent’s files`),
        expect.objectContaining({ description: expect.stringContaining('tracked by git') })
      )
    );
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
