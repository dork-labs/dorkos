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
import { SOUL_MAX_CHARS, buildSoulContent } from '@dorkos/shared/convention-files';
import { DEFAULT_TRAITS, renderTraits } from '@dorkos/shared/trait-renderer';
import { createMockTransport } from '@dorkos/test-utils';
import { createQueryClientConfig } from '@/layers/shared/lib';
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
beforeAll(async () => {
  await Promise.all([
    import('../ui/pages/AboutPage'),
    import('../ui/pages/AppearancePage'),
    import('../ui/pages/ConventionPage'),
    import('../ui/pages/SessionsPage'),
  ]);
});

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

  it('says nothing at all while it is still counting', async () => {
    // "0 conversations" about an agent with a hundred of them is worse than an
    // empty row: the row exists to save you opening the page (DOR-1253).
    const sessions = deferred<{ sessions: unknown[]; warnings: unknown[] }>();
    const tasks = deferred<unknown[]>();
    await renderProfile(MANAGED, {
      transport: mockTransport({
        listSessions: vi.fn().mockReturnValue(sessions.promise),
        listTasks: vi.fn().mockReturnValue(tasks.promise),
      }),
    });

    const row = () => document.querySelector('[data-profile-row="sessions"]')!;
    await waitFor(() => expect(row()).not.toBeNull());
    expect(row().textContent).not.toContain('conversation');
    expect(document.querySelector('[data-profile-row="tasks"]')!.textContent).not.toContain(
      'scheduled'
    );

    sessions.settle({ sessions: [], warnings: [] });
    tasks.settle([]);

    await waitFor(() => expect(row().textContent).toContain('0 conversations'));
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

  it('writes the personality into SOUL.md, not only into the manifest', async () => {
    // A turn reads the trait block out of SOUL.md; the manifest alone reaches
    // the prompt only where that block already exists. Writing both is what the
    // panel this replaced always did, and what makes the change audible (DOR-1253).
    const { transport } = await renderProfile(MANAGED);
    await openRow('personality');

    await userEvent.click(await screen.findByRole('button', { name: /The Sage/ }));

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

  it('will not save an agent with no name, and says so where you typed it', async () => {
    const { transport } = await renderProfile(MANAGED, { start: 'about' });

    const name = await screen.findByTestId('agent-name-field');
    await userEvent.clear(name);
    await userEvent.type(name, '{Enter}');

    expect(transport.updateAgentByPath).not.toHaveBeenCalled();
    // Not silently blank: the field goes back to what the agent is called, and
    // the reason sits under it.
    expect(name).toHaveValue('Warden');
    expect(screen.getByText(/An agent needs a name/)).toBeInTheDocument();
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

  it('says "Saved" only once the server has stored it', async () => {
    // It used to say so next to a fire-and-forget mutation, so a 400 and a 200
    // looked identical: toast, "Saved just now", nothing on disk (DOR-1253).
    const save = deferred<AgentManifest>();
    const transport = mockTransport({
      updateAgentByPath: vi.fn().mockReturnValue(save.promise),
    });
    await renderProfile(MANAGED, { start: 'instructions', transport });

    const editor = await screen.findByPlaceholderText('Write markdown content...');
    await userEvent.type(editor, ' More.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(toasts.success).not.toHaveBeenCalled();

    save.settle(WARDEN_MANIFEST);

    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Saved'));
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

    const editor = await screen.findByPlaceholderText('Write markdown content...');
    await userEvent.type(editor, ' More.');
    const button = screen.getByRole('button', { name: 'Save' });
    await userEvent.click(button);
    await waitFor(() => expect(transport.updateAgentByPath).toHaveBeenCalled());

    save.fail(new Error('SOUL.md is too long: the whole file has to fit in 4,000 characters.'));

    // ONE toast, not two. The page used to toast for itself beside the app-wide
    // mutation handler, so a refusal was reported twice in two different voices
    // — the page's precise sentence and a generic "Action failed. Please try
    // again." The page now names the action through `meta.errorLabel` and the
    // one handler composes it with the server's own sentence.
    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    expect(toasts.error).toHaveBeenCalledWith(
      'Couldn’t save your instructions — SOUL.md is too long: the whole file has to fit in 4,000 characters.',
      expect.anything()
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

    const editor = await screen.findByPlaceholderText('Write markdown content...');
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

    const editor = await screen.findByPlaceholderText('Write markdown content...');
    await userEvent.type(editor, ' More.');
    await userEvent.click(screen.getByRole('button', { name: 'Back to profile' }));

    expect(await screen.findByText('Discard your changes?')).toBeInTheDocument();
    // Still on the page, with the text intact.
    expect(screen.getByPlaceholderText('Write markdown content...')).toHaveValue(
      'Be careful. More.'
    );

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(await screen.findByRole('heading', { name: 'Warden' })).toBeInTheDocument();
  });

  it('does not ask when there is nothing unsaved', async () => {
    await renderProfile(MANAGED, { start: 'instructions' });

    await screen.findByPlaceholderText('Write markdown content...');
    await userEvent.click(screen.getByRole('button', { name: 'Back to profile' }));

    expect(screen.queryByText('Discard your changes?')).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Warden' })).toBeInTheDocument();
  });

  it('keeps the NOPE disclaimer wherever boundaries are edited', async () => {
    await renderProfile(MANAGED, { start: 'boundaries' });

    expect(await screen.findByText(/not enforced at the tool level/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Write markdown content...')).toHaveValue(
      'Never force-push.'
    );
  });

  // ── The preview: what the agent will actually read (DOR-1255) ──

  /** Open the disclosure and hand back the assembled prompt. */
  async function openPreview(): Promise<string> {
    await userEvent.click(await screen.findByRole('button', { name: /Preview what Warden/ }));
    const pre = await screen.findByTestId('injected-prompt');
    return pre.textContent ?? '';
  }

  it('shows both files assembled, not just the one being edited', async () => {
    // The agent reads them together and neither editor can show the other half,
    // so the preview is on BOTH pages and carries BOTH files.
    await renderProfile(MANAGED, { start: 'instructions' });

    const prompt = await openPreview();

    expect(prompt).toContain('<agent_identity>');
    // The SLUG, which is the only name the server writes into the block
    // (`agent-context.ts`: `Name: ${manifest.name}`). The fixture's display name
    // is "Warden" and its slug is "warden", so this line is the one that can
    // tell the two apart — the disclosure's own label says "Warden" and the
    // identity block must not.
    expect(prompt).toContain('Name: warden');
    expect(prompt).not.toContain('Name: Warden');
    expect(prompt).toContain('Description: Watches the build.');
    expect(prompt).toContain('Capabilities: review');
    expect(prompt).toContain('<agent_persona>');
    expect(prompt).toContain('Be careful.');
    expect(prompt).toContain('<agent_safety_boundaries>');
    expect(prompt).toContain('Never force-push.');
  });

  it('is closed until you ask for it — the file you are writing is the subject', async () => {
    await renderProfile(MANAGED, { start: 'instructions' });

    await screen.findByRole('button', { name: /Preview what Warden/ });
    expect(screen.queryByTestId('injected-prompt')).toBeNull();
  });

  it('follows the DRAFT, not the file on disk', async () => {
    // A preview that only moved once you saved would answer the question after
    // you no longer had it.
    await renderProfile(MANAGED, { start: 'instructions' });

    const editor = await screen.findByPlaceholderText('Write markdown content...');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'Say what broke first.');

    const prompt = await openPreview();

    expect(prompt).toContain('Say what broke first.');
    expect(prompt).not.toContain('Be careful.');
    // Nothing was saved to get there.
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('follows the draft on the Boundaries page too', async () => {
    await renderProfile(MANAGED, { start: 'boundaries' });

    const editor = await screen.findByPlaceholderText('Write markdown content...');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'Never touch main.');

    const prompt = await openPreview();

    expect(prompt).toContain('<agent_safety_boundaries>\nNever touch main.');
    // And the OTHER file is still the stored one — a draft on one page does not
    // invent one on the other.
    expect(prompt).toContain('Be careful.');
  });

  it('regenerates the trait block from the personality currently picked', async () => {
    // The server does this on every turn (`agent-context.ts` `buildAgentBlock`),
    // so a preview showing the stale block on disk would be showing something
    // the agent never sees. The fixture's SOUL.md carries a literal `traits`
    // placeholder between the markers; the rendered block does not.
    //
    // **From the BOUNDARIES page, deliberately.** On Instructions the SOUL text
    // reaching the preview has already been through `soulFile` (that is what
    // saving would write), so the regeneration inside the preview is dead code
    // there and a test run from that page cannot see it fail. Here SOUL arrives
    // straight off the manifest, stale block and all — which is the case that
    // needed the code in the first place.
    await renderProfile(MANAGED, { start: 'boundaries' });

    const prompt = await openPreview();

    expect(prompt).toContain('TRAITS:START');
    expect(prompt).not.toContain('\ntraits\n');
  });

  it('leaves out a file that is switched off — an off file is not injected', async () => {
    const transport = mockTransport({
      getAgentByPath: vi.fn().mockResolvedValue({
        ...WARDEN_MANIFEST,
        conventions: { soul: true, nope: false, dorkosKnowledge: true },
      }),
    });
    await renderProfile(MANAGED, { start: 'instructions', transport });

    const prompt = await openPreview();

    expect(prompt).toContain('<agent_persona>');
    expect(prompt).not.toContain('<agent_safety_boundaries>');
  });
});

describe('the Sessions page', () => {
  it('does not claim there are none while it is still asking', async () => {
    const sessions = deferred<{ sessions: unknown[]; warnings: unknown[] }>();
    await renderProfile(MANAGED, {
      start: 'sessions',
      transport: mockTransport({ listSessions: vi.fn().mockReturnValue(sessions.promise) }),
    });

    await screen.findByRole('heading', { name: 'Sessions' });
    expect(screen.queryByText(/No conversations yet/)).toBeNull();
    expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();

    sessions.settle({ sessions: [], warnings: [] });

    expect(await screen.findByText(/No conversations yet/)).toBeInTheDocument();
  });

  it('says it could not look, rather than that there is nothing', async () => {
    await renderProfile(MANAGED, {
      start: 'sessions',
      transport: mockTransport({
        listSessions: vi.fn().mockRejectedValue(new Error('offline')),
      }),
    });

    expect(await screen.findByText(/Couldn’t read Warden’s conversations/)).toBeInTheDocument();
    expect(screen.queryByText(/No conversations yet/)).toBeNull();
  });
});

describe('what a profile asks the server for', () => {
  it('asks nothing about packages or blocks on a person', async () => {
    // Every read here is a question about an AGENT. On "You" they can only
    // answer "not yours", and two of them were being asked anyway.
    const { transport } = await renderProfile(SELF);

    await screen.findByRole('heading', { name: SELF.displayName });
    expect(transport.listInstalledPackages).not.toHaveBeenCalled();
    expect(transport.listDeniedMeshAgents).not.toHaveBeenCalled();
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
