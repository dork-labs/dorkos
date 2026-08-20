/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { SessionDiagnostics } from '../model/session-diagnostics';
import { makeDiagnostics } from './session-diagnostics-fixture';

const toastSuccess = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (m: string) => toastSuccess(m) } }));

const writeText = vi.fn();
Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

// The readout reads the session id from the route/store; the shared hook is the
// unit under test elsewhere, so stub both seams and assert the RENDER.
const mockSessionId = vi.fn<() => string | null>(() => 'session-42');
vi.mock('@/layers/entities/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useSessionId: () => [mockSessionId(), vi.fn()] as never,
}));

const mockDiagnostics = vi.fn<() => SessionDiagnostics>(() => makeDiagnostics());
vi.mock('../model/use-session-diagnostics', () => ({
  useSessionDiagnostics: () => mockDiagnostics(),
}));

// The Connectors group is the connections feature's component (live transport
// + query hooks of its own, tested in features/connections); this file asserts
// the READOUT, so the slot renders empty here.
vi.mock('@/layers/features/connections', () => ({
  SessionConnectorsGroup: () => null,
}));

import { useAppStore } from '@/layers/shared/model';
import { SessionInspector } from '../ui/SessionInspector';

/** The value rendered beside a label, as text. */
function valueFor(label: string): string {
  const row = screen.getByText(label).parentElement!;
  return row.lastElementChild!.textContent!.trim();
}

beforeEach(() => {
  mockSessionId.mockReturnValue('session-42');
  mockDiagnostics.mockReturnValue(makeDiagnostics());
  // The readout only ticks while the panel holding it is open, so the default
  // (closed) would freeze the age rows. Every test but the gating one below
  // renders it the way a person sees it: open.
  useAppStore.setState({ rightPanelOpen: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('SessionInspector — without a session', () => {
  it('says so instead of rendering empty rows', () => {
    mockSessionId.mockReturnValue(null);
    render(<SessionInspector />);
    expect(screen.getByText('Open a session to see what it is doing.')).toBeInTheDocument();
    expect(screen.queryByText('Live')).not.toBeInTheDocument();
  });
});

describe('SessionInspector — the live group', () => {
  it('reports the stream state, cursors, and queue depth', () => {
    render(<SessionInspector />);
    expect(valueFor('Live updates')).toBe('Connected');
    expect(valueFor('Turn')).toBe('idle');
    expect(valueFor('Last event')).toBe('seq 412');
    expect(valueFor('Resumed from')).toBe('cursor 400');
    expect(valueFor('Queued messages')).toBe('2');
  });

  it('distinguishes a stalled trigger from a streaming turn', () => {
    mockDiagnostics.mockReturnValue(makeDiagnostics({ triggerPending: true, streaming: true }));
    render(<SessionInspector />);
    expect(valueFor('Turn')).toBe('sending');
  });

  it('is honest that nothing has hydrated yet', () => {
    mockDiagnostics.mockReturnValue(
      makeDiagnostics({ lastEventSeq: 0, snapshotCursor: null, lifecycle: null })
    );
    render(<SessionInspector />);
    expect(valueFor('Turn')).toBe('not hydrated');
    expect(valueFor('Last event')).toBe('none yet');
    expect(valueFor('Resumed from')).toBe('not hydrated');
    expect(valueFor('Last update')).toBe('—');
  });

  it('ages the last event in place while it stays open', () => {
    vi.useFakeTimers();
    mockDiagnostics.mockReturnValue(makeDiagnostics({ lastEventAt: Date.now() - 3_000 }));
    render(<SessionInspector />);
    expect(valueFor('Last update')).toBe('3.0s ago');

    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(valueFor('Last update')).toBe('15s ago');
  });

  it('stops ticking when the panel closes, and catches up when it reopens', () => {
    // Mounted is not visible. The container renders the active tab's content
    // unconditionally and collapses the desktop panel to zero width, so an
    // ungated interval re-rendered this group every second behind a closed
    // panel — and the active tab is persisted, so closing the panel while the
    // Session tab is selected is all it took to get there.
    vi.useFakeTimers();
    useAppStore.setState({ rightPanelOpen: false });
    mockDiagnostics.mockReturnValue(makeDiagnostics({ lastEventAt: Date.now() - 3_000 }));
    render(<SessionInspector />);
    expect(valueFor('Last update')).toBe('3.0s ago');

    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(valueFor('Last update')).toBe('3.0s ago');

    // Reopening re-reads the clock immediately rather than showing a value up to
    // a second stale until the first tick lands.
    act(() => {
      useAppStore.setState({ rightPanelOpen: true });
    });
    expect(valueFor('Last update')).toBe('15s ago');
  });

  it('colours the connection dot by severity, from the same map the line uses', () => {
    // `disconnected` is the most severe state there is; it read as an amber
    // warning on the one surface built to diagnose it, while `connected` rendered
    // in a different green from the status line's.
    const dotFor = () =>
      screen.getByText('Live updates').parentElement!.querySelector('span[aria-hidden]')!;

    render(<SessionInspector />);
    expect(dotFor().className).toContain('bg-emerald-500');

    cleanup();
    mockDiagnostics.mockReturnValue(makeDiagnostics({ connectionState: 'disconnected' }));
    render(<SessionInspector />);
    // shortLabel ("Offline"), not the full label ("Live updates lost") — the
    // row label already says "Live updates", so the value would otherwise
    // stutter it right back.
    expect(valueFor('Live updates')).toBe('Offline');
    expect(dotFor().className).toContain('bg-red-500');

    cleanup();
    mockDiagnostics.mockReturnValue(makeDiagnostics({ connectionState: 'reconnecting' }));
    render(<SessionInspector />);
    expect(dotFor().className).toContain('bg-amber-500');
  });
});

describe('SessionInspector — the resolved group', () => {
  it('shows the FULL directory, not the leaf the status line shows', () => {
    render(<SessionInspector />);
    expect(valueFor('Directory')).toBe('/Users/dev/work/dorkos');
  });

  it('shows the resolved model id and the selected option only when they differ', () => {
    render(<SessionInspector />);
    expect(valueFor('Model')).toBe('claude-opus-4-6');
    expect(valueFor('Model selected')).toBe('default');

    cleanup();
    mockDiagnostics.mockReturnValue(makeDiagnostics({ selectedModel: 'claude-opus-4-6' }));
    render(<SessionInspector />);
    expect(screen.queryByText('Model selected')).not.toBeInTheDocument();
  });

  it('reports effort, fast mode, permissions, and the session id', () => {
    render(<SessionInspector />);
    expect(valueFor('Effort')).toBe('high');
    expect(valueFor('Fast mode')).toBe('off');
    expect(valueFor('Permissions')).toBe('plan');
    expect(valueFor('Session id')).toBe('session-42');
    expect(valueFor('Git')).toBe('dor-452 · changed');
  });

  it('never claims "no repo" before the git query has answered', () => {
    // Opening the tab on a real checkout used to read "Git — no repo" until the
    // request resolved, because loading, failed, and not-a-repository were one
    // nullable branch. Silence is the only honest answer for a question that has
    // not come back.
    mockDiagnostics.mockReturnValue(makeDiagnostics({ git: { state: 'unknown' } }));
    render(<SessionInspector />);
    expect(valueFor('Git')).toBe('—');

    cleanup();
    mockDiagnostics.mockReturnValue(makeDiagnostics({ git: { state: 'no-repo' } }));
    render(<SessionInspector />);
    expect(valueFor('Git')).toBe('no repo');

    cleanup();
    mockDiagnostics.mockReturnValue(
      makeDiagnostics({ git: { state: 'repo', branch: 'main', dirty: false } })
    );
    render(<SessionInspector />);
    expect(valueFor('Git')).toBe('main · clean');
  });
});

describe('SessionInspector — usage', () => {
  it('breaks the context window down by category', () => {
    mockDiagnostics.mockReturnValue(
      makeDiagnostics({
        contextUsage: {
          totalTokens: 176_000,
          maxTokens: 200_000,
          percentage: 88,
          model: 'claude-opus-4-6',
          categories: [
            { name: 'System prompt', tokens: 12_000, color: '#f00' },
            { name: 'Messages', tokens: 160_000, color: '#0f0' },
            // Zero-token categories are noise, not information.
            { name: 'Memory', tokens: 0, color: '#00f' },
          ],
        },
      })
    );
    render(<SessionInspector />);
    expect(valueFor('Context')).toBe('88% full');
    expect(valueFor('Tokens')).toBe('176.0k / 200.0k');
    // Largest first, so the thing filling the window leads.
    const categories = [...document.querySelectorAll('[data-testid^="context-category-"]')].map(
      (el) => el.getAttribute('data-testid')
    );
    expect(categories).toEqual(['context-category-Messages', 'context-category-System prompt']);
  });

  it('reports the cache split, and says so when nothing is cached', () => {
    mockDiagnostics.mockReturnValue(
      makeDiagnostics({ cache: { readTokens: 9_000, creationTokens: 1_000 } })
    );
    render(<SessionInspector />);
    expect(valueFor('Cache hit')).toBe('90%');
    expect(valueFor('Cache read')).toBe('9.0k');
    expect(valueFor('Cache written')).toBe('1.0k');

    cleanup();
    mockDiagnostics.mockReturnValue(makeDiagnostics({ cache: null }));
    render(<SessionInspector />);
    expect(valueFor('Cache')).toBe('nothing cached yet');
  });

  it('shows a subscription window with its reset time', () => {
    mockDiagnostics.mockReturnValue(
      makeDiagnostics({
        usage: {
          kind: 'subscription',
          utilization: 0.42,
          windowLabel: '5-hour window',
          resetsAt: '2099-01-01T00:00:00.000Z',
          state: 'ok',
        },
      })
    );
    render(<SessionInspector />);
    expect(screen.getByText('5-hour window')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
  });
});

describe('SessionInspector — subagents', () => {
  it('lists what is running with its tool tally, and what is merely available', () => {
    mockDiagnostics.mockReturnValue(
      makeDiagnostics({
        activeSubagents: [
          {
            taskId: 't1',
            status: 'running',
            description: 'Search the codebase',
            toolUses: 3,
            lastToolName: 'Grep',
          },
        ],
        subagents: [{ name: 'researcher', description: 'reads code' }],
      })
    );
    render(<SessionInspector />);
    expect(screen.getByTestId('active-subagent-t1')).toHaveTextContent('Search the codebase');
    expect(screen.getByTestId('active-subagent-t1')).toHaveTextContent('3 tools · last Grep');
    expect(valueFor('Available')).toBe('researcher');
  });

  it('says none rather than rendering an empty block', () => {
    render(<SessionInspector />);
    expect(valueFor('Running')).toBe('none');
    expect(valueFor('Available')).toBe('none');
  });

  it('does not call a finished subagent running', () => {
    // The fold keeps one row per task for the whole turn, terminal rows included,
    // and the store keeps the turn's events after `turn_end` until the reconcile
    // reloads history. Rendering the list wholesale under "Running" therefore
    // asserted that three FINISHED subagents were still running, badged
    // `complete`, for as long as that window lasted.
    mockDiagnostics.mockReturnValue(
      makeDiagnostics({
        activeSubagents: [
          { taskId: 't1', status: 'complete', description: 'Search the codebase' },
          { taskId: 't2', status: 'error', description: 'Run the migration' },
          { taskId: 't3', status: 'stopped', description: 'Draft the notes' },
        ],
        runningSubagentCount: 0,
      })
    );
    render(<SessionInspector />);

    expect(valueFor('Running')).toBe('none');
    expect(valueFor('Finished this turn')).toBe('3');
    // Every terminal status counts as finished, not just `complete`.
    for (const id of ['t1', 't2', 't3']) {
      expect(screen.getByTestId(`active-subagent-${id}`)).toBeInTheDocument();
    }
  });

  it('separates what is still running from what finished in the same turn', () => {
    mockDiagnostics.mockReturnValue(
      makeDiagnostics({
        activeSubagents: [
          { taskId: 't1', status: 'complete', description: 'Read the spec' },
          { taskId: 't2', status: 'running', description: 'Rewrite the migration' },
        ],
        runningSubagentCount: 1,
      })
    );
    render(<SessionInspector />);

    expect(valueFor('Running')).toBe('1');
    expect(valueFor('Finished this turn')).toBe('1');
    expect(screen.getByTestId('active-subagent-t2')).toHaveAttribute('data-status', 'running');
    expect(screen.getByTestId('active-subagent-t1')).toHaveAttribute('data-status', 'complete');
  });

  it('says so when its own fold and the server disagree about what is running', () => {
    // The server projects `runningSubagentCount` from the same frames, so the two
    // should never differ. When they do, one of them is wrong — a dropped frame or
    // a mis-read terminal status — and this is the surface that has to admit it
    // rather than quietly pick a side.
    mockDiagnostics.mockReturnValue(
      makeDiagnostics({
        activeSubagents: [{ taskId: 't1', status: 'running', description: 'Grep' }],
        runningSubagentCount: 3,
      })
    );
    render(<SessionInspector />);
    expect(valueFor('Running')).toBe('1 · server says 3');
  });

  it('stays quiet about the cross-check while the two agree', () => {
    mockDiagnostics.mockReturnValue(
      makeDiagnostics({
        activeSubagents: [{ taskId: 't1', status: 'running' }],
        runningSubagentCount: 1,
      })
    );
    render(<SessionInspector />);
    expect(valueFor('Running')).toBe('1');

    // …and before the stream has hydrated a count there is nothing to compare to.
    cleanup();
    mockDiagnostics.mockReturnValue(
      makeDiagnostics({
        activeSubagents: [{ taskId: 't1', status: 'running' }],
        runningSubagentCount: null,
      })
    );
    render(<SessionInspector />);
    expect(valueFor('Running')).toBe('1');
  });
});

describe('SessionInspector — a readout, not a control panel', () => {
  it('offers no pins and no toggles — those live beside the line, in the `⋯` panel', () => {
    render(<SessionInspector />);
    expect(screen.queryByRole('button', { name: /Keep .* in the status bar/ })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('copies the same diagnostics blob the panel copies, and says so inline', async () => {
    render(<SessionInspector />);
    fireEvent.click(screen.getByRole('button', { name: /Copy diagnostics/ }));
    const parsed: Record<string, unknown> = JSON.parse(writeText.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({ sessionId: 'session-42', lastEventSeq: 412, queueDepth: 2 });
    // The button morphs itself — CopyDiagnosticsButton's own useCopyFeedback
    // state — instead of a toast beside it.
    expect(await screen.findByRole('button', { name: /Copied/ })).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
