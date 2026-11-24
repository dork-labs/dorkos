/**
 * The approval card: what it says about a proposal, and what each answer does.
 *
 * The card exists because the row it replaced asked people to arm an unattended
 * cron on the strength of a name and a cadence. So most of what is pinned here
 * is that the card says the things it has and stays silent about the things it
 * does not — a card that invented a first run, or quietly dropped the agent's
 * stated reason, would be worse than the row.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { Session, Task, TaskRun } from '@dorkos/shared/types';
import { createMockTransport, createMockSession } from '@dorkos/test-utils/mock-factories';

/** Where the card said to go, if anywhere. */
const mockNavigate = vi.fn();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useSafeNavigate: () => mockNavigate };
});

import { TransportProvider } from '@/layers/shared/model';
import {
  APPROVAL_SETTLE_MS,
  REJECTION_UNDO_MS,
  discardPendingRejections,
  discardSettlingSchedules,
  useScheduleApprovalCards,
} from '../index';
import {
  MISPLACED_SCHEDULE_PERMISSIONS,
  MISPLACED_PERMISSIONS_RUN_ONCE,
} from '@dorkos/shared/schedule-file-problems';
import { promptHash } from '../lib/prompt-hash';
import { ScheduleApprovalCard } from '../ui/ScheduleApprovalCard';

/** Frozen so a suite that takes a minute cannot age its own fixtures. */
const LOADED_AT = Date.now();

/** An ISO timestamp `minutes` either side of load. */
function minutesFromLoad(minutes: number): string {
  return new Date(LOADED_AT + minutes * 60_000).toISOString();
}

/** A schedule an agent proposed, carrying everything the server can send. */
function proposal(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    approvalRevision: 'a'.repeat(64),
    name: 'nightly-sweep',
    displayName: 'Nightly sweep',
    description: null,
    prompt: 'Sweep the backlog and file anything stale.',
    cron: '0 3 * * *',
    timezone: 'UTC',
    defaultCron: '0 3 * * *',
    defaultTimezone: 'UTC',
    timingOverridden: false,
    packageOwned: null,
    approvalChanges: [],
    agentId: null,
    // A proposal asks to run: `tasks_create` stores it switched on.
    enabled: true,
    sticky: false,
    maxRuntime: null,
    permissionMode: 'acceptEdits',
    requestedPermissionMode: null,
    requestedAllow: null,
    approvedAllow: null,
    runtime: null,
    model: null,
    effort: null,
    account: null,
    status: 'pending_approval',
    approvedAt: null,
    approvedBy: null,
    approvedVia: null,
    filePath: '/tmp/nightly-sweep/SKILL.md',
    createdAt: minutesFromLoad(-20),
    updatedAt: minutesFromLoad(-20),
    reason: 'The backlog piles up overnight and nobody sees it until Monday.',
    proposedBySessionId: 'ses-42',
    proposedByAgentPath: '/Users/dev/agents/dorkbot',
    proposedByName: 'DorkBot',
    origin: null,
    reasonSource: null,
    nextRuns: [minutesFromLoad(120), minutesFromLoad(1560), minutesFromLoad(3000)],
    ...overrides,
  };
}

/** A run of that schedule. */
function taskRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-1',
    scheduleId: 'task-1',
    status: 'running',
    startedAt: minutesFromLoad(-1),
    finishedAt: null,
    durationMs: null,
    outputSummary: null,
    error: null,
    sessionId: null,
    trigger: 'manual',
    resolvedRuntime: null,
    resolvedModel: null,
    refusedTools: null,
    outcome: null,
    scheduledFor: null,
    missedTicks: null,
    createdAt: minutesFromLoad(-1),
    ...overrides,
  };
}

/** What the card's yes carries beside its fields: the hash of the prompt it showed (M4). */
const SHOWN = {
  expectedApprovalRevision: 'a'.repeat(64),
  approvedPromptHash: expect.stringMatching(/^sha256:[A-Za-z0-9_-]{43}$/),
  approvalSurface: 'home',
};

/** Render one card over a mock transport. */
function renderCard(
  task: Task = proposal(),
  overrides: Partial<Transport> = {},
  props: {
    pinActions?: boolean;
    compact?: boolean;
    turnOnApproval?: boolean;
    initialPickedMode?: string;
    reviewHeader?: ReactNode;
  } = {}
) {
  const base = createMockTransport();
  const transport = createMockTransport({
    getSession: vi.fn().mockResolvedValue(createMockSession({ title: '' })),
    getCapabilities: vi.fn(async () => {
      const map = await base.getCapabilities();
      map.capabilities['claude-code']!.permissionModes.values = map.capabilities[
        'claude-code'
      ]!.permissionModes.values.filter((mode) => mode.id !== 'dontAsk');
      map.capabilities['claude-code']!.permissionModes.values.push({
        id: 'dontAsk',
        label: 'Never ask',
        stop: 'ask',
        asks: 'always',
        reach: 'edit',
        promise: 'Reads in its own folder still run, whatever its rules say.',
      });
      return map;
    }),
    ...overrides,
  });
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
  return {
    transport,
    ...render(<ScheduleApprovalCard task={task} approvalSurface="home" {...props} />, {
      wrapper: Wrapper,
    }),
  };
}

/** The card element itself. */
function card(): HTMLElement {
  return screen.getByTestId('schedule-approval-card');
}

/** One of the card's own slots, or null when it drew none. */
function slot(name: string): HTMLElement | null {
  return document.querySelector(`[data-slot="${name}"]`);
}

/**
 * Wait for one of the card's slots to actually appear.
 *
 * `waitFor(() => slot(name))` does NOT wait: `waitFor` resolves as soon as its
 * callback stops throwing, and returning `null` throws nothing — so it resolved
 * on the first tick and handed back null, turning an intended wait into a
 * synchronous read that then failed with "received value must be a Node"
 * instead of the real reason. Throwing is what makes it retry.
 *
 * @param name - The `data-slot` value to wait for.
 */
async function findSlot(name: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = slot(name);
    if (found === null) throw new Error(`no [data-slot="${name}"] on screen yet`);
    return found;
  });
}

beforeEach(() => {
  mockNavigate.mockClear();
});

afterEach(() => {
  cleanup();
  discardPendingRejections();
  discardSettlingSchedules();
  vi.clearAllMocks();
});

/**
 * The line `RequestingAgent` renders for an agent-proposed schedule nothing
 * named. Held here so the two cases that assert this branch does NOT fall back
 * to it keep pinning something real when the copy moves — the previous string
 * survived a rename and quietly became unconditionally true.
 */
const AGENT_UNNAMED_COPY = 'An agent asked. DorkOS can’t tell which.';

describe('ScheduleApprovalCard — what it says', () => {
  it('says the mode once: the picker on a desktop review, the pinned row on a phone (DOR-4572)', async () => {
    renderCard(proposal(), {}, { pinActions: true });
    await screen.findByRole('button', { name: 'Approve Nightly sweep' });
    expect(screen.queryByText(/^(Runs as|Run permissions):/)).toBeNull();
    // What the mode does sits under the picker that names it, once.
    await waitFor(() =>
      expect(
        slot('schedule-mode-choice')!.querySelector('[data-slot="schedule-mode-explanation"]')
      ).not.toBeNull()
    );
    expect(document.querySelectorAll('[data-slot="schedule-mode-explanation"]')).toHaveLength(1);
    cleanup();

    // The phone's sheet: the picker scrolls away under the pinned row, so it stays.
    renderCard(proposal(), {}, { pinActions: true, reviewHeader: <h2>Review schedule</h2> });
    expect(await screen.findByText('Run permissions: Accept edits')).toBeVisible();
    expect(screen.queryByText(/^Runs as:/)).toBeNull();
  });

  it('still names the agent when DorkOS parked the agent’s edit and the header is quiet', async () => {
    // An agent's edit parks with DorkOS's own reason: no header, no byline name,
    // so the Agent line is where the agent is named.
    renderCard(
      proposal({
        agentId: 'agent-a',
        runsAsName: 'DorkBot',
        reasonSource: 'dorkos',
        reason: 'This schedule changed since you approved it.',
      })
    );
    expect(await screen.findByText('Agent: DorkBot')).toBeVisible();
  });

  it('heads the card with the agent’s display name, not its folder name (DOR-4337)', async () => {
    renderCard();

    await screen.findByText('Nightly sweep');
    expect(slot('requesting-agent-name')).toHaveTextContent('DorkBot');
    // Case-sensitive: the folder name the header used to show.
    expect(card()).not.toHaveTextContent(/dorkbot/);
  });

  it('names the agent once when it proposed the schedule and its runs act as it (DOR-4572)', async () => {
    // Same agent: its runs stand in the very folder the proposal was stamped with.
    renderCard(
      proposal({
        agentId: 'agent-a',
        runsAsName: 'DorkBot',
        runPlace: { kind: 'agent', path: '/Users/dev/agents/dorkbot' },
      })
    );

    await screen.findByText('Nightly sweep');
    expect(screen.queryByText(/^Agent:/)).toBeNull();
    expect(slot('ask-detail')).not.toHaveTextContent('DorkBot');
  });

  it('quotes the agent’s reason in full, never clamped', async () => {
    // The reason is the case being made. Seeded defect: add `line-clamp-2` and
    // this still passes on text content — so the assertion is on the CLASS, the
    // only thing jsdom can actually see (it lays nothing out and reports every
    // element as 0×0).
    renderCard();

    const reason = await findSlot('schedule-reason');
    expect(reason).toHaveTextContent(
      'The backlog piles up overnight and nobody sees it until Monday.'
    );
    expect(reason?.className).not.toMatch(/line-clamp|truncate/);
  });

  it('draws no reason line when the reason only repeats a prompt shown in full (DOR-5075)', async () => {
    // A card that attests the file shows the prompt in full already; quoting it
    // as the reason too puts the same words on the card twice.
    renderCard(
      proposal({ reason: ' Sweep the backlog and file anything stale.', fileCapNext: true })
    );

    await screen.findByText('Nightly sweep');
    expect(slot('schedule-reason')).toBeNull();
  });

  it('says the cadence in words, with the timezone it is anchored to', async () => {
    // "every day at 3:00 AM" is a different promise in UTC than in Chicago, and
    // the operator is the one who has to know which.
    renderCard();

    const cadence = await findSlot('schedule-cadence');
    expect(cadence).toHaveTextContent('3:00 AM (UTC)');
    expect(cadence).not.toHaveTextContent(/At 0|\b0\d:\d{2}/);
  });

  it('lists the first runs the server computed', async () => {
    renderCard();

    const runs = await findSlot('schedule-first-runs');
    expect(runs).toHaveTextContent(/^First run /);
    expect(runs).toHaveTextContent(/· then /);
  });

  it('opens an agent’s proposal on the exact instructions, since its yes approves the file (M4), and says what power they run with', async () => {
    renderCard();
    expect(slot('schedule-prompt')).toHaveTextContent('Sweep the backlog and file anything stale.');
    // No toggle at all: the prompt is a focusable region a keyboard can scroll.
    expect(screen.queryByRole('button', { name: /exact instructions/ })).toBeNull();
    const region = screen.getByRole('region', { name: 'Prompt' });
    expect(region).toBe(slot('schedule-prompt'));
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.className).toContain('focus-ring');
    expect(region.className).toContain('text-xs');
    expect(region.className).not.toContain('text-sm');
    expect(region.className).toContain('whitespace-pre-wrap');
    expect(region.className).toContain('break-words');
    expect(region.className).toContain('max-h-[40dvh]');
    expect(region.className).toContain('sm:max-h-64');
    // The runtime's OWN word for the level, once its profile lands — the same
    // word the Trust Dial shows, rather than the id-keyed fallback this card
    // used before it resolved a profile of its own (DOR-2100). `waitFor`, not
    // `findByText`: the fallback renders first and a query that returns on its
    // first match would settle on it.
    await waitFor(() =>
      expect(
        screen.getByRole('option', { name: 'Accept edits', selected: true })
      ).toBeInTheDocument()
    );
    // The picker names the mode, so the line beside it does not (DOR-4572).
    expect(slot('schedule-permission-mode')).not.toHaveTextContent('Run permissions:');
  });

  it('sends no hash from a folded prompt, so its yes approves no file (SC2)', async () => {
    const updateTask = vi.fn().mockResolvedValue(proposal({ status: 'active' }));
    renderCard(proposal({ proposedByAgentPath: null, proposedByName: null }), { updateTask });
    expect(slot('schedule-prompt')).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Approve Nightly sweep' }));
    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith('task-1', {
        status: 'active',
        expectedApprovalRevision: 'a'.repeat(64),
        approvalSurface: 'home',
      })
    );
  });

  it('opens on the instructions whenever its yes would approve a file, and its yes sends their hash', async () => {
    const updateTask = vi.fn().mockResolvedValue(proposal({ status: 'active' }));
    renderCard(proposal({ proposedByAgentPath: null, proposedByName: null, fileCapNext: true }), {
      updateTask,
    });
    expect(slot('schedule-prompt')).toHaveTextContent('Sweep the backlog and file anything stale.');
    await userEvent.click(await screen.findByRole('button', { name: 'Approve Nightly sweep' }));
    // sha256 of the prompt the card showed, base64url: what the server compares the file to.
    const shown = await promptHash('Sweep the backlog and file anything stale.');
    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith('task-1', {
        status: 'active',
        approvedPromptHash: shown,
        expectedApprovalRevision: 'a'.repeat(64),
        approvalSurface: 'home',
      })
    );
  });

  it('shows hidden characters in the prompt as markers, and its yes hashes the real prompt (DOR-5060)', async () => {
    // A zero-width space, a bidi override, and a tag character: the last is
    // invisible to a person but read as text by a model.
    const hidden = [0x200b, 0x202e, 0xe0041].map((cp) => String.fromCodePoint(cp));
    const prompt = `Sweep${hidden.join(' the ')} backlog.`;
    const updateTask = vi.fn().mockResolvedValue(proposal({ status: 'active' }));
    renderCard(
      proposal({ proposedByAgentPath: null, proposedByName: null, fileCapNext: true, prompt }),
      { updateTask }
    );
    const shown = slot('schedule-prompt')!;
    const shownText = shown.textContent ?? '';
    // Each one is a chip a screen reader names, never the `<U+200B>` text a
    // prompt could carry to look like one (DOR-5075).
    for (const codePoint of ['U+200B', 'U+202E', 'U+E0041']) {
      const chip = within(shown).getByRole('img', { name: `hidden character ${codePoint}` });
      expect(chip).toHaveTextContent(codePoint);
      expect(chip.getAttribute('data-slot')).toBe('hidden-character');
    }
    expect(shownText).not.toContain('<U+');
    for (const ch of hidden) expect(shownText).not.toContain(ch);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve Nightly sweep' }));
    const real = await promptHash(prompt);
    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith('task-1', {
        status: 'active',
        approvedPromptHash: real,
        expectedApprovalRevision: 'a'.repeat(64),
        approvalSurface: 'home',
      })
    );
  });

  it('still approves on a plain-http page, with no hash, so it attests no file', async () => {
    vi.stubGlobal('crypto', {});
    try {
      const updateTask = vi.fn().mockResolvedValue(proposal({ status: 'active' }));
      renderCard(proposal(), { updateTask });
      await userEvent.click(await screen.findByRole('button', { name: 'Approve Nightly sweep' }));
      await waitFor(() =>
        expect(updateTask).toHaveBeenCalledWith('task-1', {
          status: 'active',
          expectedApprovalRevision: 'a'.repeat(64),
          approvalSurface: 'home',
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('names the agent the schedule runs as (DOR-3640)', async () => {
    renderCard(proposal({ agentId: 'agent-b', runsAsName: 'Scout' }));
    // A different agent from the proposer, so the line stays (DOR-4572).
    expect(await screen.findByText('Agent: Scout')).toBeVisible();
  });

  it.each([
    [
      "the agent's folder, with its path",
      { runsAsName: 'Quill', runPlace: { kind: 'agent', path: '/Users/sam/agents/quill' } },
      "Where: Quill's folder",
      '~/agents/quill',
      null,
    ],
    [
      "the agent's folder when its name is unknown",
      { runsAsName: null, runPlace: { kind: 'agent', path: '/Users/sam/agents/quill' } },
      "Where: The agent's folder",
      '~/agents/quill',
      null,
    ],
    [
      "a private copy of the agent's project",
      { runsAsName: 'Quill', runPlace: { kind: 'agent_checkout', ready: true } },
      "Where: A private copy of Quill's project",
      null,
      null,
    ],
    [
      'a private copy that is not made yet',
      { runsAsName: 'Quill', runPlace: { kind: 'agent_checkout', ready: false } },
      "Where: A private copy of Quill's project",
      null,
      "Not made yet. Until it is, runs use Quill's folder.",
    ],
    [
      "DorkOS's default folder, with its path",
      {
        runsAsName: 'Quill',
        runPlace: { kind: 'folder', path: '/Users/sam/projects/site', of: 'default' },
      },
      "Where: DorkOS's default folder",
      '~/projects/site',
      null,
    ],
    [
      'the folder DorkOS runs in, for no agent',
      {
        agentId: null,
        runPlace: { kind: 'folder', path: '/Users/sam/projects/site', of: 'server' },
      },
      'Where: The folder DorkOS runs in',
      '~/projects/site',
      null,
    ],
    [
      'a fresh private folder',
      { agentId: null, runPlace: { kind: 'private' } },
      'Where: A fresh private folder',
      null,
      null,
    ],
  ] as const)('says where it runs: %s (DOR-4067)', async (_case, overrides, where, path, note) => {
    renderCard(proposal({ agentId: 'agent-b', ...overrides } as Partial<Task>));
    await screen.findByText('Nightly sweep');
    expect(slot('schedule-run-place')).toHaveTextContent(where);
    const shown = slot('schedule-run-place-path');
    if (path === null) expect(shown).toBeNull();
    else expect(shown).toHaveTextContent(path);
    const said = slot('schedule-run-place-note');
    if (note === null) expect(said).toBeNull();
    else expect(said).toHaveTextContent(note);
  });

  // A schedule DorkOS found in a skills root had no asker at all (DOR-1485).
  // Crediting "an agent" would be inventing a proposer, which is the one thing
  // the test above exists to forbid.
  it('names the file a discovered schedule came from instead of a proposer', async () => {
    renderCard(
      proposal({
        origin: 'file',
        proposedByAgentPath: null,
        proposedByName: null,
        proposedBySessionId: null,
        filePath: '/Users/dev/project/.agents/skills/nightly-sweep/SKILL.md',
      })
    );

    // The WHOLE rendered string, so the home-directory shortening is actually
    // under test: asserting a substring of the path would pass identically if
    // `shortenHomePath` were dropped.
    expect((await findSlot('schedule-file-origin'))?.textContent).toBe(
      '~/project/.agents/skills/nightly-sweep/SKILL.md'
    );
    expect(slot('ask-detail')).toHaveTextContent('Found in a file on this computer');
    expect(slot('ask-detail')).not.toHaveTextContent('Proposed by');
    expect(screen.queryByText(AGENT_UNNAMED_COPY)).toBeNull();
  });
});

describe('ScheduleApprovalCard — the conversation behind it', () => {
  it('links to the session that proposed it, by its real title', async () => {
    renderCard(proposal(), {
      getSession: vi.fn().mockResolvedValue({ title: 'Fixing the flaky test' } as Session),
    });

    const link = await screen.findByRole('button', { name: /Fixing the flaky test/ });
    await userEvent.click(link);

    // The directory travels with the id: a session row is addressed by both, and
    // the proposing session is usually not the one this window has open.
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { session: 'ses-42', dir: undefined },
    });
  });

  it('reads the proposing session under ITS directory, not this window’s', async () => {
    const getSession = vi.fn().mockResolvedValue({ title: 'Fixing the flaky test' } as Session);
    renderCard(proposal(), { getSession });

    // Seeded defect: drop the `dir` option from `useSessionDetail` and this is
    // called with the app store's `selectedCwd` (null here), so the query never
    // runs at all and the title never appears.
    await waitFor(() =>
      expect(getSession).toHaveBeenCalledWith('ses-42', '/Users/dev/agents/dorkbot')
    );
  });
});

describe('ScheduleApprovalCard — answering it', () => {
  it('shows structured requested limits and applies exactly those limits', async () => {
    const updateTask = vi.fn().mockResolvedValue(proposal({ status: 'active' }));
    renderCard(
      proposal({
        requestedPermissionMode: 'dontAsk',
        requestedAllow: ['Bash(/abs/path/script.sh --once)'],
      } as Partial<Task>),
      { updateTask }
    );

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('dontAsk'));
    expect(slot('schedule-requested-allow')).toHaveTextContent(
      'Runs without asking, and may only:'
    );
    expect(slot('schedule-requested-allow')).toHaveTextContent('Bash(/abs/path/script.sh --once)');
    // A command rule always takes its own tick (Security Should D-2).
    await userEvent.click(screen.getByRole('checkbox', { name: /these programs/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Approve Nightly sweep' }));
    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith('task-1', {
        ...SHOWN,
        status: 'active',
        permissionMode: 'dontAsk',
        approvedAllow: ['Bash(/abs/path/script.sh --once)'],
        acceptLooserThanRequested: true,
      })
    );
  });

  it('requires a separate choice before applying a looser mode', async () => {
    const updateTask = vi.fn().mockResolvedValue(proposal({ status: 'active' }));
    renderCard(
      proposal({ requestedPermissionMode: 'dontAsk', requestedAllow: [] } as Partial<Task>),
      { updateTask }
    );
    const picker = await screen.findByRole('combobox', { name: 'Run permissions' });
    await userEvent.selectOptions(picker, 'acceptEdits');
    const approve = screen.getByRole('button', { name: 'Approve Nightly sweep' });
    expect(approve).toBeDisabled();
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Allow Accept edits when you’re not there' })
    );
    expect(approve).toBeEnabled();
    await userEvent.click(approve);
    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          acceptLooserThanRequested: true,
        })
      )
    );
  });

  it('confirms a rule that changes files outside the task folder', async () => {
    renderCard(
      proposal({
        requestedPermissionMode: 'acceptEdits',
        requestedAllow: ['Edit(~/.zshrc)'],
      } as Partial<Task>)
    );
    expect(await findSlot('schedule-writes-outside')).toHaveTextContent(
      'Can change files outside its folder.'
    );
    expect(screen.getByRole('button', { name: 'Approve Nightly sweep' })).toBeDisabled();
    await userEvent.click(
      screen.getByRole('checkbox', {
        name: 'Allow edits outside its folder when you’re not there',
      })
    );
    expect(screen.getByRole('button', { name: 'Approve Nightly sweep' })).toBeEnabled();
  });

  it('names the reads and the programs on outsider work in one tick', async () => {
    renderCard(
      proposal({
        permissionMode: 'dontAsk',
        originMarks: { outsider: true },
        requestedPermissionMode: 'dontAsk',
        requestedAllow: ['Read(notes/today.md)', 'Bash(/abs/report.sh --once)'],
      } as Partial<Task>)
    );
    expect(
      await screen.findByRole('checkbox', {
        name: 'Allow these programs and these reads when you’re not there',
      })
    ).toBeInTheDocument();
  });

  it('warns and asks before a broad read over an absolute path', async () => {
    renderCard(
      proposal({
        requestedPermissionMode: 'acceptEdits',
        requestedAllow: ['Read(//users/sam/notes/**)'],
      } as Partial<Task>)
    );
    expect(await findSlot('schedule-reads-broadly')).toHaveTextContent(
      'Can read files across this computer.'
    );
    expect(
      screen.getByRole('checkbox', { name: 'Allow these reads when you’re not there' })
    ).toBeInTheDocument();
  });

  it('names everything one tick covers, and nothing it does not', async () => {
    renderCard(
      proposal({
        requestedPermissionMode: 'dontAsk',
        requestedAllow: ['Bash(/abs/report.sh --once)'],
      } as Partial<Task>)
    );
    const picker = await screen.findByRole('combobox', { name: 'Run permissions' });
    await waitFor(() => expect(picker).toHaveValue('dontAsk'));
    expect(
      screen.getByRole('checkbox', { name: 'Allow these programs when you’re not there' })
    ).toBeInTheDocument();
    await userEvent.selectOptions(picker, 'acceptEdits');
    expect(
      screen.getByRole('checkbox', {
        name: 'Allow Accept edits and these programs when you’re not there',
      })
    ).toBeInTheDocument();
  });

  it('says a command rule can run programs and needs its own tick (D-2)', async () => {
    const updateTask = vi.fn().mockResolvedValue(proposal({ status: 'active' }));
    renderCard(
      proposal({
        permissionMode: 'dontAsk',
        requestedPermissionMode: 'dontAsk',
        requestedAllow: ['Bash(/abs/report.sh --once)'],
      } as Partial<Task>),
      { updateTask }
    );
    expect(await findSlot('schedule-runs-programs')).toHaveTextContent(
      'Can run programs on this computer.'
    );
    const approve = screen.getByRole('button', { name: 'Approve Nightly sweep' });
    expect(approve).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /these programs/i }));
    await userEvent.click(approve);
    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          approvedAllow: ['Bash(/abs/report.sh --once)'],
          acceptLooserThanRequested: true,
        })
      )
    );
  });

  it('asks for the tick before an outsider’s requested rules (D-3)', async () => {
    renderCard(
      proposal({
        permissionMode: 'dontAsk',
        originMarks: { outsider: true },
        requestedPermissionMode: 'dontAsk',
        requestedAllow: ['Read(/abs/notes/today.md)'],
      } as Partial<Task>)
    );
    await screen.findByRole('combobox', { name: 'Run permissions' });
    expect(screen.getByRole('button', { name: 'Approve Nightly sweep' })).toBeDisabled();
    const tick = screen.getByRole('checkbox', { name: 'Allow these reads when you’re not there' });
    // Looks 24px tall; a touch screen gets a 44px target from 10px above and below.
    expect(tick.closest('label')).toHaveClass(
      'relative',
      'min-h-6',
      'pointer-coarse:before:absolute',
      'pointer-coarse:before:inset-x-0',
      'pointer-coarse:before:-inset-y-2.5'
    );
  });

  it('needs the tick to raise the saved mode when nothing was requested (D-1)', async () => {
    renderCard(proposal({ permissionMode: 'dontAsk' } as Partial<Task>));
    const picker = await screen.findByRole('combobox', { name: 'Run permissions' });
    await userEvent.selectOptions(picker, 'acceptEdits');
    expect(screen.getByRole('button', { name: 'Approve Nightly sweep' })).toBeDisabled();
    expect(
      screen.getByRole('checkbox', { name: 'Allow Accept edits when you’re not there' })
    ).toBeInTheDocument();
  });

  it('defaults outsider work to the tightest unattended mode', async () => {
    renderCard(
      proposal({
        originMarks: { outsider: true },
        requestedPermissionMode: 'acceptEdits',
      } as Partial<Task>)
    );
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('dontAsk'));
  });

  it('approves and turns on an off schedule with one primary action', async () => {
    const updateTask = vi.fn().mockResolvedValue(proposal({ status: 'active', enabled: false }));
    renderCard(proposal({ enabled: false }), { updateTask });

    const approve = await screen.findByRole('button', {
      name: 'Approve Nightly sweep and turn it on',
    });
    expect(approve).toHaveTextContent('Approve and turn on');
    await userEvent.click(approve);

    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith('task-1', {
        ...SHOWN,
        status: 'active',
        enabled: true,
      })
    );
    expect(await findSlot('schedule-receipt')).toHaveTextContent(/Approved by you at/);
  });

  it('never names the owner for an approval the server recorded without a name (DOR-3641)', async () => {
    renderCard(proposal(), {
      // The owner's saved name is not who approved: with login on, a signed-in
      // teammate's yes is recorded by id alone.
      getConfig: vi.fn().mockResolvedValue({ profile: { displayName: 'Dorian' } }),
      updateTask: vi.fn().mockResolvedValue(
        proposal({
          status: 'active',
          approvedAt: new Date(2026, 0, 15, 14, 30).toISOString(),
          approvedBy: { kind: 'person', userId: 'user-2', name: null },
        })
      ),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Approve Nightly sweep' }));

    const receipt = await findSlot('schedule-receipt');
    await waitFor(() => expect(receipt).toHaveTextContent('Approved by you at 2:30 PM, in Home.'));
    expect(receipt).not.toHaveTextContent('Dorian');
  });

  it('sends enabled: true with "Approve and turn on" (DOR-3309)', async () => {
    const updateTask = vi.fn().mockResolvedValue(proposal({ status: 'active' }));
    renderCard(proposal({ enabled: false }), { updateTask });

    await userEvent.click(
      await screen.findByRole('button', { name: 'Approve Nightly sweep and turn it on' })
    );

    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith('task-1', {
        ...SHOWN,
        status: 'active',
        enabled: true,
      })
    );
  });

  it('hands the card back when the server refuses the approval', async () => {
    // A checkmark over a proposal that is still sitting there answerable is a
    // lie about something a person cares about.
    renderCard(proposal(), { updateTask: vi.fn().mockRejectedValue(new Error('nope')) });

    await userEvent.click(await screen.findByRole('button', { name: 'Approve Nightly sweep' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Approve Nightly sweep' })).toBeInTheDocument()
    );
    expect(slot('schedule-receipt')).toBeNull();
  });

  it('rejects into a receipt with a live undo, and sends no delete yet', async () => {
    const deleteTask = vi.fn().mockResolvedValue({ success: true });
    renderCard(proposal(), { deleteTask });

    await userEvent.click(await screen.findByRole('button', { name: 'Reject Nightly sweep' }));

    const receipt = await findSlot('schedule-receipt');
    expect(receipt).toHaveAttribute('data-tone', 'denied');
    expect(receipt).toHaveTextContent('Rejected');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it('answers A and D from the keyboard, but only while focus is inside it', async () => {
    const updateTask = vi.fn().mockResolvedValue(proposal());
    renderCard(proposal(), { updateTask });
    await screen.findByRole('button', { name: 'Approve Nightly sweep' });

    // Nothing focused: the letter must go nowhere. Without this half the test
    // could not tell a card-scoped handler from a document-level hotkey, which
    // is the whole promise `AskCard.Root` makes.
    await userEvent.keyboard('a');
    expect(updateTask).not.toHaveBeenCalled();

    card().focus();
    await userEvent.keyboard('a');

    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith('task-1', {
        ...SHOWN,
        status: 'active',
      })
    );
  });

  it('stops answering the keys once it has been answered', async () => {
    // A decided card that still took `A` would re-arm a schedule somebody just
    // rejected, from a keystroke aimed at the card behind it.
    const updateTask = vi.fn().mockResolvedValue(proposal());
    renderCard(proposal(), {
      updateTask,
      deleteTask: vi.fn().mockResolvedValue({ success: true }),
    });
    await screen.findByRole('button', { name: 'Reject Nightly sweep' });

    card().focus();
    await userEvent.keyboard('d');
    await waitFor(() => expect(slot('schedule-receipt')).not.toBeNull());

    card().focus();
    await userEvent.keyboard('a');

    expect(updateTask).not.toHaveBeenCalled();
  });
});

describe('ScheduleApprovalCard — the rejection really lands', () => {
  /**
   * The hole this closes, found by review: every assertion the card suite made
   * about rejecting was satisfied by a card that DELETES NOTHING. Replacing the
   * scheduled `deleteTask.mutateAsync(...)` with a bare `void deleteTask` left
   * 996 tests green — the receipt appeared, Undo restored the buttons, the
   * scheduler's own unit tests still passed against their injected spy, and no
   * test anywhere watched the card's own callback reach the transport.
   *
   * These cross that boundary: the real card, the real module timer, a real
   * transport, and the clock pushed past the window.
   *
   * **The clock is switched on only after the card is on screen, and the clicks
   * are `fireEvent`.** Two other arrangements were tried and both were wrong.
   * `vi.useFakeTimers({ shouldAdvanceTime: true })` ties fake time to REAL
   * elapsed time, so the 600ms approval hold expired during a single click on a
   * loaded machine and the suite reported its own timing as the product's
   * defect (seen here, intermittently). Plain fake timers with `userEvent` hangs
   * instead: RTL's `waitFor` does not advance vitest's clock, so `findByRole`
   * never resolves and every case times out at 5s. Locating on real timers and
   * then driving a synchronous click leaves the window under this file's
   * control and nobody else's.
   */
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the DELETE after the window even though the card is long gone', async () => {
    const deleteTask = vi.fn().mockResolvedValue({ success: true });
    const { unmount } = renderCard(proposal(), { deleteTask });
    const reject = await screen.findByRole('button', { name: 'Reject Nightly sweep' });

    vi.useFakeTimers();
    fireEvent.click(reject);
    expect(deleteTask).not.toHaveBeenCalled();

    // The ordinary case: rejecting the last schedule empties the queue and the
    // popover holding the card goes with it.
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REJECTION_UNDO_MS);
    });

    expect(deleteTask).toHaveBeenCalledWith('task-1');
  });

  it('deletes only the schedule that was not taken back', async () => {
    const deleteTask = vi.fn().mockResolvedValue({ success: true });
    const transport = createMockTransport({ deleteTask });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <ScheduleApprovalCard
            task={proposal({ id: 'task-1', displayName: 'First' })}
            approvalSurface="home"
          />
          <ScheduleApprovalCard
            task={proposal({ id: 'task-2', displayName: 'Second' })}
            approvalSurface="home"
          />
        </TransportProvider>
      </QueryClientProvider>
    );
    const first = await screen.findByRole('button', { name: 'Reject First' });
    const second = screen.getByRole('button', { name: 'Reject Second' });

    vi.useFakeTimers();
    fireEvent.click(first);
    fireEvent.click(second);

    // Two receipts, two live offers — and taking one back must not spare the
    // other, which a scheduler holding a single timer would get wrong.
    const undos = screen.getAllByRole('button', { name: 'Undo' });
    expect(undos).toHaveLength(2);
    fireEvent.click(undos[0] as HTMLElement);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REJECTION_UNDO_MS);
    });

    expect(deleteTask).toHaveBeenCalledTimes(1);
    expect(deleteTask).toHaveBeenCalledWith('task-2');
  });
});

describe('ScheduleApprovalCard — the receipt outlives the refetch', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A host that composes the hold exactly as the three real surfaces do. */
  function Host({ schedules }: { schedules: readonly Task[] }) {
    const shown = useScheduleApprovalCards(schedules);
    return (
      <>
        {shown.map((task) => (
          <ScheduleApprovalCard key={task.id} task={task} approvalSurface="home" />
        ))}
      </>
    );
  }

  it('holds an approved schedule on screen after the server stops listing it', async () => {
    // Approving is optimistic, and the refetch that follows drops the task out
    // of the parked list — which used to take the card and the group around it
    // out of the tree inside 10-60ms, tearing away the only confirmation an
    // approval ever gets. The hold is what the consumers merge back in.
    const transport = createMockTransport({ updateTask: vi.fn().mockResolvedValue(proposal()) });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const wrap = (schedules: readonly Task[]) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <Host schedules={schedules} />
        </TransportProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(wrap([proposal()]));
    const approve = await screen.findByRole('button', { name: 'Approve Nightly sweep' });
    await waitFor(() => expect(approve).toBeEnabled());

    vi.useFakeTimers();
    fireEvent.click(approve);
    expect(slot('schedule-receipt')).toHaveTextContent('Approved');

    // The refetch lands: the server no longer calls this schedule parked.
    rerender(wrap([]));

    // Still there, still saying what happened. Seeded defect: drop
    // `holdApprovedSchedule` from `approve` and the card is gone by this line.
    expect(slot('schedule-receipt')).toHaveTextContent('Approved');

    // And it does leave, once it has been read — a hold that never released
    // would pin a decided card to the surface forever.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(APPROVAL_SETTLE_MS + 50);
    });
    expect(slot('schedule-receipt')).toBeNull();
  });
});

describe('ScheduleApprovalCard — running it once', () => {
  it('runs a trial at a stricter picked mode, and says nothing else (DOR-4336)', async () => {
    const triggerTask = vi.fn().mockResolvedValue({ runId: 'run-1' });
    renderCard(proposal(), { triggerTask, listTaskRuns: vi.fn().mockResolvedValue([]) });
    const picker = await screen.findByRole('combobox', { name: 'Run permissions' });
    await userEvent.selectOptions(picker, 'plan');

    expect(slot('schedule-try-mode')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Run Nightly sweep once' }));
    expect(triggerTask).toHaveBeenCalledWith('task-1', { permissionMode: 'plan' });
  });

  it('holds a looser pick at the saved mode, says so, and sends no pick (DOR-4336)', async () => {
    const triggerTask = vi.fn().mockResolvedValue({ runId: 'run-1' });
    renderCard(proposal(), { triggerTask, listTaskRuns: vi.fn().mockResolvedValue([]) });
    const picker = await screen.findByRole('combobox', { name: 'Run permissions' });
    await userEvent.selectOptions(picker, 'bypassPermissions');

    expect(await findSlot('schedule-try-mode')).toHaveTextContent(/uses the saved mode/);
    await userEvent.click(screen.getByRole('button', { name: 'Run Nightly sweep once' }));
    expect(triggerTask).toHaveBeenCalledTimes(1);
    expect(triggerTask.mock.calls[0]).toEqual(['task-1']);
  });

  it('triggers a supervised run without arming anything', async () => {
    const triggerTask = vi.fn().mockResolvedValue({ runId: 'run-1' });
    const updateTask = vi.fn();
    renderCard(proposal(), {
      triggerTask,
      updateTask,
      listTaskRuns: vi.fn().mockResolvedValue([]),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Run Nightly sweep once' }));

    expect(triggerTask).toHaveBeenCalledWith('task-1');
    // Nothing about a test run approves the proposal, arms the cron, or changes
    // its status. Seeded defect: have the button also call `useUpdateTask` and
    // this reds.
    expect(updateTask).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Approve Nightly sweep' })).toBeInTheDocument();
  });

  it('reports a run in progress, and refuses to fire a second one', async () => {
    renderCard(proposal(), {
      triggerTask: vi.fn().mockResolvedValue({ runId: 'run-1' }),
      listTaskRuns: vi.fn().mockResolvedValue([taskRun()]),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Run Nightly sweep once' }));

    await waitFor(() => expect(slot('schedule-test-run')).toHaveAttribute('data-phase', 'running'));
    expect(slot('schedule-test-run')).toHaveTextContent('Test run in progress…');
    expect(screen.getByRole('button', { name: 'Run Nightly sweep once' })).toBeDisabled();
  });

  it('offers a way into what the finished run actually did', async () => {
    renderCard(proposal(), {
      triggerTask: vi.fn().mockResolvedValue({ runId: 'run-1' }),
      listTaskRuns: vi
        .fn()
        .mockResolvedValue([
          taskRun({ status: 'completed', finishedAt: minutesFromLoad(-1), sessionId: 'ses-run-1' }),
        ]),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Run Nightly sweep once' }));

    await waitFor(() =>
      expect(slot('schedule-test-run')).toHaveAttribute('data-phase', 'finished')
    );
    expect(slot('schedule-test-run')).toHaveTextContent(/Test run finished 1m ago/);

    await userEvent.click(screen.getByRole('button', { name: /view what it did/ }));
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { session: 'ses-run-1', dir: undefined },
    });
  });

  it('says a failed run failed, and quotes the reason', async () => {
    // The card exists to produce evidence. A strip that reported "finished" over
    // a failure would produce the opposite — somebody arming a nightly cron on
    // the strength of a run that did not work.
    renderCard(proposal(), {
      triggerTask: vi.fn().mockResolvedValue({ runId: 'run-1' }),
      listTaskRuns: vi
        .fn()
        .mockResolvedValue([taskRun({ status: 'failed', error: 'Command not found: sweep' })]),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Run Nightly sweep once' }));

    await waitFor(() => expect(slot('schedule-test-run')).toHaveAttribute('data-phase', 'failed'));
    expect(slot('schedule-test-run')).toHaveTextContent(
      'Test run didn’t work: Command not found: sweep'
    );
    // And it offers no "view what it did" over a failure with no session.
    expect(screen.queryByRole('button', { name: /view what it did/ })).not.toBeInTheDocument();
  });

  it('reports a refused trigger rather than sitting there looking idle', async () => {
    renderCard(proposal(), {
      triggerTask: vi.fn().mockRejectedValue(new Error('Tasks are switched off')),
      listTaskRuns: vi.fn().mockResolvedValue([]),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Run Nightly sweep once' }));

    await waitFor(() => expect(slot('schedule-test-run')).toHaveAttribute('data-phase', 'failed'));
    expect(slot('schedule-test-run')).toHaveTextContent('Tasks are switched off');
  });

  it('keeps Approve and Reject answerable throughout a test run', async () => {
    // Approval by demonstration: the evidence arrives and the decision is still
    // there to make, now backed by it.
    const updateTask = vi.fn().mockResolvedValue(proposal());
    renderCard(proposal(), {
      triggerTask: vi.fn().mockResolvedValue({ runId: 'run-1' }),
      listTaskRuns: vi.fn().mockResolvedValue([taskRun()]),
      updateTask,
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Run Nightly sweep once' }));
    await waitFor(() => expect(slot('schedule-test-run')).toHaveAttribute('data-phase', 'running'));

    await userEvent.click(screen.getByRole('button', { name: 'Approve Nightly sweep' }));
    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith('task-1', {
        ...SHOWN,
        status: 'active',
      })
    );
  });
});

/**
 * Approving can also grant the operator's own trust stop, per task (DOR-2100).
 *
 * The clamp on an agent's proposal stays; what changes is that the person
 * answering the card can say "yes, AND at my level" in the same click. So what
 * is pinned here is the whole of that offer: when it appears, when it must not,
 * what it names, and exactly what goes on the wire — because the wire is where
 * the grant either happens or silently does not.
 */
describe('ScheduleApprovalCard — choosing the run permissions', () => {
  it('runs an outsider’s trial at the baseline, and says so', async () => {
    renderCard(
      proposal({
        originMarks: { outsider: true },
        requestedPermissionMode: 'acceptEdits',
      } as Partial<Task>)
    );
    await screen.findByRole('combobox', { name: 'Run permissions' });
    // Saved Accept edits is looser than Allowed commands, the outsider floor,
    // so the trial runs at the floor, as the trigger route does.
    await userEvent.selectOptions(screen.getByRole('combobox'), 'default');
    expect(await findSlot('schedule-try-mode')).toHaveTextContent(
      'Try it once now uses Allowed commands.'
    );
    expect(screen.getByRole('button', { name: 'Run Nightly sweep once' })).toBeEnabled();
  });

  it('never preselects a requested Full access, and raising to it takes the tick', async () => {
    renderCard(proposal({ requestedPermissionMode: 'bypassPermissions' } as Partial<Task>));
    const picker = await screen.findByRole('combobox', { name: 'Run permissions' });
    expect(picker).toHaveValue('acceptEdits');
    expect(screen.getByRole('button', { name: 'Approve Nightly sweep' })).toBeEnabled();
    await userEvent.selectOptions(picker, 'bypassPermissions');
    expect(screen.getByRole('button', { name: 'Approve Nightly sweep' })).toBeDisabled();
    expect(
      screen.getByRole('checkbox', { name: 'Allow Full access when you’re not there' })
    ).toBeInTheDocument();
  });

  it('measures outsider work that asked for plan against plan, as the server does', async () => {
    renderCard(
      proposal({
        originMarks: { outsider: true },
        requestedPermissionMode: 'plan',
      } as Partial<Task>)
    );
    const picker = await screen.findByRole('combobox', { name: 'Run permissions' });
    await waitFor(() => expect(picker).toHaveValue('plan'));
    expect(screen.getByRole('button', { name: 'Approve Nightly sweep' })).toBeEnabled();
    await userEvent.selectOptions(picker, 'dontAsk');
    expect(screen.getByRole('button', { name: 'Approve Nightly sweep' })).toBeDisabled();
  });

  it('seeds a looser preview mode and requires its confirmation', async () => {
    renderCard(
      proposal({ requestedPermissionMode: 'dontAsk', permissionMode: 'dontAsk' }),
      {},
      { initialPickedMode: 'acceptEdits' }
    );

    const picker = await screen.findByRole('combobox', { name: 'Run permissions' });
    expect(picker).toHaveValue('acceptEdits');
    const confirm = screen.getByRole('checkbox', {
      name: 'Allow Accept edits when you’re not there',
    });
    const approve = screen.getByRole('button', { name: 'Approve Nightly sweep' });
    expect(approve).toBeDisabled();
    // Test runs still use the saved mode, so the card keeps saying so.
    expect(
      screen.getByText('Try it once now uses the saved mode: Allowed commands.')
    ).toBeInTheDocument();
    expect(confirm.closest('label')?.nextElementSibling).toBe(slot('schedule-folder-rules'));

    await userEvent.click(confirm);
    expect(approve).toBeEnabled();
  });

  it('starts at the structured requested mode', async () => {
    const updateTask = vi
      .fn()
      .mockResolvedValue(proposal({ status: 'active', permissionMode: 'dontAsk' }));
    renderCard(
      proposal({
        requestedPermissionMode: 'dontAsk',
        folderRules: { status: 'approved', applied: ['Bash(pnpm check:watchdog)'], pending: [] },
      }),
      { updateTask }
    );
    const picker = await screen.findByRole('combobox', { name: 'Run permissions' });
    await waitFor(() => expect(picker).toHaveValue('dontAsk'));
    expect(slot('schedule-folder-rules')).toHaveTextContent('Bash(pnpm check:watchdog)');
    expect(slot('schedule-mode-mismatch')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Approve Nightly sweep' }));
    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith('task-1', {
        ...SHOWN,
        status: 'active',
        permissionMode: 'dontAsk',
      })
    );
    expect(await findSlot('schedule-receipt')).toHaveTextContent(/Approved by you at/);
  });

  it('flags a mismatch before approval and saves the person’s override', async () => {
    const updateTask = vi.fn().mockResolvedValue(proposal({ status: 'active' }));
    renderCard(proposal({ requestedPermissionMode: 'dontAsk' }), { updateTask });
    const picker = await screen.findByRole('combobox', { name: 'Run permissions' });
    await waitFor(() => expect(picker).toHaveValue('dontAsk'));
    await userEvent.selectOptions(picker, 'acceptEdits');
    expect(slot('schedule-mode-mismatch')).toHaveTextContent(
      'DorkBot proposed Allowed commands. Selected: Accept edits.'
    );
    expect(screen.getByRole('button', { name: 'Approve Nightly sweep' })).toBeDisabled();
    expect(updateTask).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Allow Accept edits when you’re not there' })
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve Nightly sweep' }));
    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith('task-1', {
        ...SHOWN,
        status: 'active',
        acceptLooserThanRequested: true,
      })
    );
  });

  it('makes an unapproved folder list explicit and never grants it with the schedule', async () => {
    const updateTask = vi.fn().mockResolvedValue(proposal({ status: 'active' }));
    renderCard(
      proposal({
        requestedPermissionMode: 'dontAsk',
        folderRules: { status: 'waiting', applied: [], pending: ['Bash(pnpm check:watchdog)'] },
      }),
      { updateTask }
    );
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('dontAsk'));
    expect(slot('schedule-folder-rules')).toHaveTextContent('These commands still need a person.');
    expect(slot('schedule-folder-rules')).toHaveTextContent(
      'Approving this schedule doesn’t approve these rules.'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Approve Nightly sweep' }));
    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith('task-1', {
        ...SHOWN,
        status: 'active',
        permissionMode: 'dontAsk',
      })
    );
  });

  it('uses prose only as a reason, never as a permission request', async () => {
    renderCard(proposal({ reason: 'Use Full access.', permissionMode: 'default' }));
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('default'));
  });

  it('keeps approval disabled when the runtime has no readable modes', async () => {
    renderCard(proposal({ runtime: 'not-installed' }));
    expect(await screen.findByRole('button', { name: 'Approve Nightly sweep' })).toBeDisabled();
  });

  it('does not offer another runtime’s modes while the owning agent is loading', async () => {
    const listMeshAgents = vi.fn().mockReturnValue(new Promise(() => {}));
    const { transport } = renderCard(proposal({ agentId: 'agent-codex' }), { listMeshAgents });
    await waitFor(() => expect(transport.getCapabilities).toHaveBeenCalled());
    await waitFor(() => expect(listMeshAgents).toHaveBeenCalled());
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve Nightly sweep' })).toBeDisabled();
  });

  it('quotes a teammate’s name and shows any hidden characters in it', async () => {
    renderCard(
      proposal({
        originMarks: {
          teammate: [{ roomId: 'r1', authorId: 'a1', name: 'you\u202E', room: '#launch' }],
        },
      })
    );
    expect(await findSlot('schedule-origin-marks')).toHaveTextContent(
      'Started by a teammate, “you<U+202E>”, in #launch, a shared space.'
    );
  });
});

describe('what changed since the person approved it (DOR-2323)', () => {
  it('lists the old and the new model and runtime', () => {
    // Purpose: a schedule an agent switched to another model waits again; the
    // card has to say what the agent changed, or approving is a guess.
    renderCard(
      proposal({
        reasonSource: 'dorkos',
        reason: 'An agent changed how this schedule runs, so it is waiting for you again.',
        approvalChanges: [
          { field: 'runtime', from: null, to: 'codex', via: 'schedule' },
          { field: 'model', from: 'claude-sonnet-4', to: 'claude-opus-4', via: 'schedule' },
        ],
      })
    );

    const changes = slot('schedule-changes');
    expect(changes).not.toBeNull();
    expect(changes).toHaveTextContent('Runs on: the agent’s own → codex');
    expect(changes).toHaveTextContent('Model: claude-sonnet-4 → claude-opus-4');
    // Kept whole at any width: a model name broken at a hyphen reads as two.
    expect(changes!.querySelector('[data-slot="schedule-change-value"]')).toHaveClass(
      'whitespace-nowrap'
    );
  });
});

describe('stale schedule approval', () => {
  it.each([false, true])(
    'disables Run it once while a review is stale (pinned: %s)',
    async (pinActions) => {
      const triggerTask = vi.fn();
      const { rerender } = renderCard(proposal(), { triggerTask }, { pinActions });
      const run = await screen.findByRole('button', { name: 'Run Nightly sweep once' });
      expect(run).toBeEnabled();
      rerender(
        <ScheduleApprovalCard
          task={proposal({ prompt: 'Changed work.', approvalRevision: 'b'.repeat(64) })}
          approvalSurface="home"
          pinActions={pinActions}
        />
      );
      expect(await screen.findByRole('status')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Run Nightly sweep once' })).toBeDisabled();
      await userEvent.click(screen.getByRole('button', { name: 'Run Nightly sweep once' }));
      expect(triggerTask).not.toHaveBeenCalled();
    }
  );

  it.each(['prompt', 'permissionMode', 'enabled'] as const)(
    'pins an open review across a background %s change',
    async (field) => {
      const first = proposal({ enabled: false });
      const fresh = {
        ...first,
        approvalRevision: 'b'.repeat(64),
        [field]:
          field === 'prompt'
            ? 'Check the sample ledger.'
            : field === 'permissionMode'
              ? 'dontAsk'
              : true,
      } as Task;
      const updateTask = vi.fn().mockResolvedValue(fresh);
      const { rerender } = renderCard(first, { updateTask }, { pinActions: true });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /Approve Nightly sweep/ })).toBeEnabled()
      );
      screen.getByRole('button', { name: /Approve Nightly sweep/ }).focus();
      rerender(<ScheduleApprovalCard task={fresh} approvalSurface="home" pinActions />);
      expect(await screen.findByRole('status')).toHaveTextContent(
        'This schedule changed. Review it again.'
      );
      expect(screen.getByRole('button', { name: 'Review again' })).toHaveFocus();
      expect(await screen.findByText('This schedule changed. Review it again.')).toBeVisible();
      expect(screen.getByRole('button', { name: /Approve Nightly sweep/ })).toBeDisabled();
      fireEvent.keyDown(card(), { key: 'a' });
      expect(updateTask).not.toHaveBeenCalled();
      if (field === 'prompt') expect(screen.queryByText('Check the sample ledger.')).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Review again' }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /Approve Nightly sweep/ })).toBeEnabled()
      );
      if (field === 'prompt') expect(screen.getByText('Check the sample ledger.')).toBeVisible();
      fireEvent.keyDown(card(), { key: 'a' });
      await waitFor(() =>
        expect(updateTask).toHaveBeenCalledWith(
          'task-1',
          expect.objectContaining({ expectedApprovalRevision: 'b'.repeat(64) })
        )
      );
    }
  );

  it('refreshes instructions and mode before allowing another approval', async () => {
    let finishRefresh!: (tasks: Task[]) => void;
    const staleError = Object.assign(new Error('This schedule changed. Review it again.'), {
      code: 'schedule_review_changed',
    });
    const updateTask = vi.fn().mockRejectedValueOnce(staleError).mockResolvedValue(proposal());
    const listTasks = vi.fn(
      () =>
        new Promise<Task[]>((resolve) => {
          finishRefresh = resolve;
        })
    );
    renderCard(proposal(), { updateTask, listTasks });
    const approve = await screen.findByRole('button', { name: 'Approve Nightly sweep' });
    await waitFor(() => expect(approve).toBeEnabled());
    await userEvent.click(approve);
    expect(await screen.findByText('This schedule changed. Review it again.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approve Nightly sweep' })).toBeDisabled();
    await act(async () =>
      finishRefresh([
        proposal({
          prompt: 'Check the sample ledger.',
          permissionMode: 'dontAsk',
          approvalRevision: 'b'.repeat(64),
        }),
      ])
    );
    expect(screen.queryByText('Check the sample ledger.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve Nightly sweep' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Review again' }));
    expect(await screen.findByText('Check the sample ledger.')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Approve Nightly sweep' })).toBeEnabled()
    );
    expect(
      screen.getByRole('option', { name: 'Allowed commands', selected: true })
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve Nightly sweep' }));
    await waitFor(() =>
      expect(updateTask).toHaveBeenLastCalledWith(
        'task-1',
        expect.objectContaining({ expectedApprovalRevision: 'b'.repeat(64) })
      )
    );
  });
});
it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  'blocks misplaced-mode approval and labels its trial (file capped: %s, pinned: %s)',
  (fileCapNext, pinActions) => {
    renderCard(
      proposal({
        origin: 'file',
        reasonSource: 'dorkos',
        reason: MISPLACED_SCHEDULE_PERMISSIONS,
        fileCapNext,
        enabled: false,
      }),
      {},
      { pinActions, turnOnApproval: true }
    );
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('permissions is in the wrong place');
    expect(
      screen.getByRole('button', { name: 'Approve Nightly sweep and turn it on' })
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run Nightly sweep once' })).toBeEnabled();
    expect(
      screen.getByText(
        fileCapNext
          ? 'The next run is capped until you approve the file.'
          : MISPLACED_PERMISSIONS_RUN_ONCE
      )
    ).toBeInTheDocument();
  }
);
