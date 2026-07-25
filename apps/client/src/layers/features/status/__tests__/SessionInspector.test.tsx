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

import { SessionInspector } from '../ui/SessionInspector';

/** The value rendered beside a label, as text. */
function valueFor(label: string): string {
  const row = screen.getByText(label).parentElement!;
  return row.lastElementChild!.textContent!.trim();
}

beforeEach(() => {
  mockSessionId.mockReturnValue('session-42');
  mockDiagnostics.mockReturnValue(makeDiagnostics());
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
    expect(valueFor('Connection')).toBe('connected');
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
});

describe('SessionInspector — a readout, not a control panel', () => {
  it('offers no pins and no toggles — those live beside the line, in the `⋯` panel', () => {
    render(<SessionInspector />);
    expect(screen.queryByRole('button', { name: /Keep .* in the status bar/ })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('copies the same diagnostics blob the panel copies', () => {
    render(<SessionInspector />);
    fireEvent.click(screen.getByRole('button', { name: /Copy diagnostics/ }));
    const parsed: Record<string, unknown> = JSON.parse(writeText.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({ sessionId: 'session-42', lastEventSeq: 412, queueDepth: 2 });
    expect(toastSuccess).toHaveBeenCalledWith('Diagnostics copied to your clipboard');
  });
});
