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
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { Session, Task, TaskRun } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';

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
    name: 'nightly-sweep',
    displayName: 'Nightly sweep',
    description: null,
    prompt: 'Sweep the backlog and file anything stale.',
    cron: '0 3 * * *',
    timezone: 'UTC',
    agentId: null,
    enabled: false,
    sticky: false,
    maxRuntime: null,
    permissionMode: 'acceptEdits',
    runtime: null,
    model: null,
    effort: null,
    status: 'pending_approval',
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
    createdAt: minutesFromLoad(-1),
    ...overrides,
  };
}

/** Render one card over a mock transport. */
function renderCard(task: Task = proposal(), overrides: Partial<Transport> = {}) {
  const transport = createMockTransport(overrides);
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
  return { transport, ...render(<ScheduleApprovalCard task={task} />, { wrapper: Wrapper }) };
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

describe('ScheduleApprovalCard — what it says', () => {
  it('names the schedule, its proposer, and how long it has waited', async () => {
    renderCard();

    expect(await screen.findByText('Nightly sweep')).toBeInTheDocument();
    expect(slot('ask-detail')).toHaveTextContent('Proposed by DorkBot');
    expect(slot('ask-detail')).toHaveTextContent('waiting 20m');
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

  it('falls back to the description when a legacy proposal carries no reason', async () => {
    // Rows created before `reason` existed, and the sessionless external `/mcp`
    // registration, both arrive with it null. The card degrades to whatever the
    // task does say rather than drawing an empty quotation mark.
    renderCard(proposal({ reason: null, description: 'Weekly backlog sweep' }));

    expect(await screen.findByText(/Weekly backlog sweep/)).toBeInTheDocument();
  });

  it('draws no reason line at all when a description would only repeat the name', async () => {
    // A description that IS the name says nothing, and quoting it would put the
    // same words on the card twice under a quotation mark.
    renderCard(proposal({ reason: null, description: 'Nightly sweep' }));

    await screen.findByText('Nightly sweep');
    expect(slot('schedule-reason')).toBeNull();
  });

  it('draws no reason line when there is neither a reason nor a description', async () => {
    renderCard(proposal({ reason: null, description: null }));

    await screen.findByText('Nightly sweep');
    expect(slot('schedule-reason')).toBeNull();
  });

  it('says the cadence in words, with the timezone it is anchored to', async () => {
    // "every day at 3:00 AM" is a different promise in UTC than in Chicago, and
    // the operator is the one who has to know which.
    renderCard();

    const cadence = await findSlot('schedule-cadence');
    expect(cadence).toHaveTextContent(/At 03:00 AM/i);
    expect(cadence).toHaveTextContent('(UTC)');
  });

  it('falls back to the raw expression for a cron nothing can read', async () => {
    // A string somebody can paste into a cron checker beats a card that refuses
    // to say when it fires.
    renderCard(proposal({ cron: 'not a cron', timezone: null }));

    expect(await screen.findByText('not a cron')).toBeInTheDocument();
  });

  it('lists the first runs the server computed', async () => {
    renderCard();

    const runs = await findSlot('schedule-first-runs');
    expect(runs).toHaveTextContent(/^First run /);
    expect(runs).toHaveTextContent(/· then /);
  });

  it('says nothing about first runs when the server sent none', async () => {
    // `nextRuns` is empty for an unparseable cron. Inventing a time here is the
    // one thing this card must never do — it is the evidence somebody approves on.
    renderCard(proposal({ nextRuns: [] }));

    await screen.findByText('Nightly sweep');
    expect(slot('schedule-first-runs')).toBeNull();
  });

  it('keeps the exact instructions behind a disclosure, and says what power they run with', async () => {
    renderCard();

    // Collapsed by default: a wall of prompt on every card is what stops anybody
    // reading any of them.
    expect(slot('schedule-prompt')).toBeNull();
    expect(await screen.findByText(/Runs as: Accept Edits/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Show exact instructions/ }));

    expect(slot('schedule-prompt')).toHaveTextContent('Sweep the backlog and file anything stale.');
  });

  it('says a proposal has no agent identity rather than inventing one', async () => {
    // The sessionless external `/mcp` registration stamps no path. A disc and a
    // name invented from nothing would put a request under a mark it never earned.
    renderCard(proposal({ proposedByAgentPath: null, proposedByName: null }));

    expect(await screen.findByText('Requested without an agent identity')).toBeInTheDocument();
    expect(slot('ask-detail')).toHaveTextContent('Proposed by an agent');
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
    expect(screen.queryByText('Requested without an agent identity')).toBeNull();
  });

  // The drift case on a person's OWN schedule: origin is not `file`, but the
  // words are still ours. Quoting them under "Proposed by an agent" attributed
  // our prose to an agent that never said it (DOR-1485 review, residual 2).
  it('does not dress our drift notice as an agent’s quoted case', async () => {
    renderCard(
      proposal({
        origin: null,
        reasonSource: 'dorkos',
        proposedByAgentPath: null,
        proposedByName: null,
        proposedBySessionId: null,
        reason: 'This schedule’s file changed since it was last approved.',
      })
    );

    const reason = await findSlot('schedule-reason');
    expect(reason?.textContent).toBe('This schedule’s file changed since it was last approved.');
    expect(reason).not.toHaveClass('italic');
    expect(slot('ask-detail')).not.toHaveTextContent('Proposed by');
    expect(screen.queryByText('Requested without an agent identity')).toBeNull();
  });

  it('shows why a discovered schedule is parked, unquoted — they are our words', async () => {
    renderCard(
      proposal({
        origin: 'file',
        reason: '"cron" is not a schedule DorkOS can read.',
      })
    );

    const reason = await findSlot('schedule-reason');
    // `textContent`, not `toHaveTextContent`: the matcher normalizes whitespace
    // and happily matches a substring, so it passes with the curly quotes still
    // wrapped around our sentence — which is the exact thing this case forbids.
    expect(reason?.textContent).toBe('"cron" is not a schedule DorkOS can read.');
    expect(reason?.textContent?.startsWith('“')).toBe(false);
    expect(reason).not.toHaveClass('italic');
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
      search: { session: 'ses-42', dir: '/Users/dev/agents/dorkbot' },
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

  it('omits the fragment silently when the lookup fails', async () => {
    // Never block the card on it: the decision is about the schedule, and a
    // session that cannot be read is not a reason to withhold the buttons.
    renderCard(proposal(), { getSession: vi.fn().mockRejectedValue(new Error('gone')) });

    expect(
      await screen.findByRole('button', { name: 'Approve Nightly sweep' })
    ).toBeInTheDocument();
    expect(slot('schedule-proposing-session')).toBeNull();
  });

  it('omits the fragment when the proposal names no session', async () => {
    const getSession = vi.fn();
    renderCard(proposal({ proposedBySessionId: null }), { getSession });

    await screen.findByText('Nightly sweep');
    expect(slot('schedule-proposing-session')).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
  });
});

describe('ScheduleApprovalCard — answering it', () => {
  it('approves with both the status and the enabled flag', async () => {
    const updateTask = vi.fn().mockResolvedValue(proposal({ status: 'active' }));
    renderCard(proposal(), { updateTask });

    await userEvent.click(await screen.findByRole('button', { name: 'Approve Nightly sweep' }));

    // Sending only one of them leaves a schedule that is approved and will never
    // fire — the exact half-armed state the Tasks page's mutation guards against.
    expect(updateTask).toHaveBeenCalledWith('task-1', { status: 'active', enabled: true });
  });

  it('says when the first run will be, in the receipt', async () => {
    renderCard(proposal(), { updateTask: vi.fn().mockResolvedValue(proposal()) });

    await userEvent.click(await screen.findByRole('button', { name: 'Approve Nightly sweep' }));

    const receipt = await findSlot('schedule-receipt');
    expect(receipt).toHaveAttribute('data-tone', 'allowed');
    // Not a bare "Approved": the whole point of the card is that a person knows
    // what they just armed, and the first run is the fact they were weighing.
    expect(receipt).toHaveTextContent(/^Approved — first run /);
  });

  it('says only "Approved" when there was no first run to promise', async () => {
    renderCard(proposal({ nextRuns: [] }), { updateTask: vi.fn().mockResolvedValue(proposal()) });

    await userEvent.click(await screen.findByRole('button', { name: 'Approve Nightly sweep' }));

    expect(await findSlot('schedule-receipt')).toHaveTextContent('Approved');
    expect(slot('schedule-receipt')).not.toHaveTextContent('first run');
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

  it('puts the answers back when the rejection is undone', async () => {
    const deleteTask = vi.fn().mockResolvedValue({ success: true });
    renderCard(proposal(), { deleteTask });

    await userEvent.click(await screen.findByRole('button', { name: 'Reject Nightly sweep' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    expect(
      await screen.findByRole('button', { name: 'Approve Nightly sweep' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject Nightly sweep' })).toBeInTheDocument();
    expect(slot('schedule-receipt')).toBeNull();
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it('comes back showing its receipt when the card is drawn again mid-window', async () => {
    // The popover closing is the ordinary case: rejecting the last schedule
    // empties the queue and unmounts the panel. The decision belongs to the
    // module, so the next card drawn for the same schedule picks it back up.
    // Seeded defect: hold the undo window in component state and the remounted
    // card draws answerable buttons over a DELETE that is already on its way.
    const deleteTask = vi.fn().mockResolvedValue({ success: true });
    const { unmount } = renderCard(proposal(), { deleteTask });

    await userEvent.click(await screen.findByRole('button', { name: 'Reject Nightly sweep' }));
    unmount();

    renderCard(proposal(), { deleteTask });

    expect(await findSlot('schedule-receipt')).toHaveTextContent('Rejected');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve Nightly sweep' })).not.toBeInTheDocument();
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

    expect(updateTask).toHaveBeenCalledWith('task-1', { status: 'active', enabled: true });
  });

  it('denies on D', async () => {
    const deleteTask = vi.fn().mockResolvedValue({ success: true });
    renderCard(proposal(), { deleteTask });
    await screen.findByRole('button', { name: 'Reject Nightly sweep' });

    card().focus();
    await userEvent.keyboard('d');

    expect(await findSlot('schedule-receipt')).toHaveTextContent('Rejected');
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
          <ScheduleApprovalCard task={proposal({ id: 'task-1', displayName: 'First' })} />
          <ScheduleApprovalCard task={proposal({ id: 'task-2', displayName: 'Second' })} />
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
          <ScheduleApprovalCard key={task.id} task={task} />
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

  it('lets go of a schedule the server refused to approve', async () => {
    // The hold must not outlive the decision it was holding for: a refused
    // approval hands the card back to the live list, and a stale hold would
    // draw it twice — once from the server's copy and once from ours.
    //
    // Real timers throughout: what has to settle here is a rejected promise,
    // not a window.
    const transport = createMockTransport({
      updateTask: vi.fn().mockRejectedValue(new Error('nope')),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <Host schedules={[proposal()]} />
        </TransportProvider>
      </QueryClientProvider>
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Approve Nightly sweep' }));

    // Answerable again, and drawn exactly once.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Approve Nightly sweep' })).toBeInTheDocument()
    );
    expect(screen.getAllByTestId('schedule-approval-card')).toHaveLength(1);
  });
});

describe('ScheduleApprovalCard — running it once', () => {
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

  it('counts a run it has an id for but no row yet as running', async () => {
    // The second between the trigger answering and the history refetching.
    // Reporting `idle` there would blink the button back and invite a second run.
    renderCard(proposal(), {
      triggerTask: vi.fn().mockResolvedValue({ runId: 'run-1' }),
      listTaskRuns: vi.fn().mockResolvedValue([]),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Run Nightly sweep once' }));

    await waitFor(() => expect(slot('schedule-test-run')).toHaveAttribute('data-phase', 'running'));
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
      search: { session: 'ses-run-1', dir: '/Users/dev/agents/dorkbot' },
    });
  });

  it('points at the run history when the run left no session behind', async () => {
    renderCard(proposal(), {
      triggerTask: vi.fn().mockResolvedValue({ runId: 'run-1' }),
      listTaskRuns: vi
        .fn()
        .mockResolvedValue([
          taskRun({ status: 'completed', finishedAt: minutesFromLoad(-1), sessionId: null }),
        ]),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Run Nightly sweep once' }));
    await waitFor(() =>
      expect(slot('schedule-test-run')).toHaveAttribute('data-phase', 'finished')
    );

    await userEvent.click(screen.getByRole('button', { name: /view what it did/ }));
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/tasks' });
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
      'Test run failed — Command not found: sweep'
    );
    // And it offers no "view what it did" over a failure with no session.
    expect(screen.queryByRole('button', { name: /view what it did/ })).not.toBeInTheDocument();
  });

  it('says a cancelled run was stopped, which is neither success nor fault', async () => {
    renderCard(proposal(), {
      triggerTask: vi.fn().mockResolvedValue({ runId: 'run-1' }),
      listTaskRuns: vi.fn().mockResolvedValue([taskRun({ status: 'cancelled' })]),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Run Nightly sweep once' }));

    await waitFor(() => expect(slot('schedule-test-run')).toHaveAttribute('data-phase', 'stopped'));
    expect(slot('schedule-test-run')).toHaveTextContent('Test run was stopped before it finished.');
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

  it('reports the run it started, not whichever run the history lists first', async () => {
    // The selection, not the query. The existing case above asserts that the
    // request carries `scheduleId`; that leaves `runs?.[0]` — take the newest
    // row rather than the one we started — passing, and it is wrong in the way
    // that matters: a run somebody kicked off from the Tasks page in another
    // tab lands at the head of this same list, and the card would report ITS
    // outcome as the evidence for approving.
    //
    // The other run FAILED and ours COMPLETED, so the two readings are opposite
    // and the strip cannot be right by accident.
    renderCard(proposal(), {
      triggerTask: vi.fn().mockResolvedValue({ runId: 'run-mine' }),
      listTaskRuns: vi
        .fn()
        .mockResolvedValue([
          taskRun({ id: 'run-someone-elses', status: 'failed', error: 'not our run' }),
          taskRun({ id: 'run-mine', status: 'completed', finishedAt: minutesFromLoad(-1) }),
        ]),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Run Nightly sweep once' }));

    await waitFor(() =>
      expect(slot('schedule-test-run')).toHaveAttribute('data-phase', 'finished')
    );
    expect(slot('schedule-test-run')).not.toHaveTextContent('not our run');
  });

  it('reads only this schedule’s runs', async () => {
    // Attaching the strip to "the newest manual run" would report an outcome
    // that belonged to a run somebody started from the Tasks page in another tab.
    const listTaskRuns = vi.fn().mockResolvedValue([]);
    renderCard(proposal(), {
      triggerTask: vi.fn().mockResolvedValue({ runId: 'run-1' }),
      listTaskRuns,
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Run Nightly sweep once' }));

    await waitFor(() =>
      expect(listTaskRuns).toHaveBeenCalledWith(expect.objectContaining({ scheduleId: 'task-1' }))
    );
  });

  it('asks for no run history at all until a test run exists', async () => {
    // One card per parked schedule on three surfaces; polling a run list for
    // every one of them, forever, to draw nothing is the cost this avoids.
    const listTaskRuns = vi.fn().mockResolvedValue([]);
    renderCard(proposal(), { listTaskRuns });

    await screen.findByRole('button', { name: 'Run Nightly sweep once' });
    expect(listTaskRuns).not.toHaveBeenCalled();
    expect(slot('schedule-test-run')).toBeNull();
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
    expect(updateTask).toHaveBeenCalledWith('task-1', { status: 'active', enabled: true });
  });
});
