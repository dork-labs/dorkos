// @vitest-environment jsdom
/**
 * The read-only explanation: who gets it, who does not, how it is spent, and
 * what its one action does when there is nowhere to send anybody (DOR-2019).
 *
 * The hook is tested against runtime-declared descriptors rather than runtime
 * names, because that is the whole claim — a runtime that declares an approval
 * channel must stop qualifying without anybody editing this feature.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

const mockCaps = vi.fn<(runtime?: string | null) => Partial<RuntimeCapabilities> | undefined>();
vi.mock('@/layers/entities/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/runtime')>()),
  useCapabilitiesForRuntime: (runtime?: string | null) => mockCaps(runtime),
}));

import { useSessionChatStore } from '@/layers/entities/session';
import { useReadOnlyModeHint } from '../model/use-read-only-mode-hint';
import { useSessionPermissionPicker } from '../model/permission-picker-store';
import { ReadOnlyModeNotice } from '../ui/ReadOnlyModeNotice';

/** Codex's declared shape: read-only, and no channel to ask through. */
const CODEX = {
  permissionModes: {
    supported: true,
    default: 'default',
    values: [
      {
        id: 'default',
        label: 'Read only',
        stop: 'ask' as const,
        asks: 'never' as const,
        reach: 'read' as const,
        promise: 'Codex can read files but not change them.',
      },
      {
        id: 'acceptEdits',
        label: 'Workspace write',
        stop: 'act' as const,
        asks: 'never' as const,
        reach: 'workspace' as const,
        promise: 'Codex can change files in this project.',
      },
    ],
  },
};

/** Claude's shape at the same stop: read-limited, but it can ask. */
const CLAUDE = {
  permissionModes: {
    supported: true,
    default: 'default',
    values: [
      {
        id: 'default',
        label: 'Default',
        stop: 'ask' as const,
        asks: 'always' as const,
        reach: 'edit' as const,
        promise: 'Asks before it edits a file or runs a command.',
      },
      {
        id: 'plan',
        label: 'Plan',
        stop: 'ask' as const,
        axis: 'working' as const,
        asks: 'always' as const,
        reach: 'read' as const,
        promise: 'Reads and plans only.',
      },
    ],
  },
};

/**
 * One consumer of the hook. `drawn` is what the bottom slot would decide: the
 * card is a candidate that can LOSE the slot, so a test can hold it back and
 * still have the hook running, which is the case rule 2 is about.
 */
function Harness({
  sessionId,
  runtime,
  mode,
  drawn = true,
}: {
  sessionId: string;
  runtime: string;
  mode: string;
  drawn?: boolean;
}) {
  const hint = useReadOnlyModeHint(sessionId, runtime, mode);
  return (
    <div>
      <span data-testid="eligible">{hint.eligible ? 'yes' : 'no'}</span>
      {hint.eligible && drawn && (
        <ReadOnlyModeNotice
          runtimeLabel={hint.runtimeLabel}
          onShown={hint.markShown}
          onDismiss={hint.dismiss}
        />
      )}
    </div>
  );
}

beforeEach(() => {
  act(() => {
    useSessionChatStore.setState({ readOnlyHint: {} });
    useSessionPermissionPicker.setState({ available: true, open: false });
  });
  mockCaps.mockImplementation((runtime) => (runtime === 'codex' ? CODEX : CLAUDE));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useReadOnlyModeHint', () => {
  it('speaks for a mode that can neither change anything nor ask', () => {
    render(<Harness sessionId="s1" runtime="codex" mode="default" />);
    expect(screen.getByTestId('eligible')).toHaveTextContent('yes');
    expect(screen.getByTestId('read-only-mode-notice')).toBeInTheDocument();
  });

  it('stays quiet on a runtime whose stop genuinely asks', () => {
    render(<Harness sessionId="s1" runtime="claude-code" mode="default" />);
    expect(screen.getByTestId('eligible')).toHaveTextContent('no');
  });

  it('stays quiet in a read-only mode that CAN ask — Plan is not a dead end', () => {
    render(<Harness sessionId="s1" runtime="claude-code" mode="plan" />);
    expect(screen.getByTestId('eligible')).toHaveTextContent('no');
  });

  it('stays quiet in a never-asking mode that can act', () => {
    render(<Harness sessionId="s1" runtime="codex" mode="acceptEdits" />);
    expect(screen.getByTestId('eligible')).toHaveTextContent('no');
  });

  it('stays quiet while the runtime has not declared itself yet', () => {
    mockCaps.mockReturnValue(undefined);
    render(<Harness sessionId="s1" runtime="codex" mode="default" />);
    expect(screen.getByTestId('eligible')).toHaveTextContent('no');
  });

  it('is spent by the dismissal and does not come back', async () => {
    const { rerender } = render(<Harness sessionId="s1" runtime="codex" mode="default" />);
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.getByTestId('eligible')).toHaveTextContent('no');
    rerender(<Harness sessionId="s1" runtime="codex" mode="default" />);
    expect(screen.getByTestId('eligible')).toHaveTextContent('no');
  });

  it('is spent by leaving the mode, so coming back does not say it twice', () => {
    const { rerender } = render(<Harness sessionId="s1" runtime="codex" mode="default" />);
    expect(screen.getByTestId('eligible')).toHaveTextContent('yes');
    rerender(<Harness sessionId="s1" runtime="codex" mode="acceptEdits" />);
    rerender(<Harness sessionId="s1" runtime="codex" mode="default" />);
    expect(screen.getByTestId('eligible')).toHaveTextContent('no');
  });

  it('is NOT spent by leaving a mode it was never actually drawn in', () => {
    // The card lost the slot to a higher-priority candidate the whole time it
    // qualified. Nothing was said, so nothing may be spent — the old version
    // latched on eligibility and threw the sentence away unseen.
    const { rerender } = render(
      <Harness sessionId="s1" runtime="codex" mode="default" drawn={false} />
    );
    expect(screen.getByTestId('eligible')).toHaveTextContent('yes');
    rerender(<Harness sessionId="s1" runtime="codex" mode="acceptEdits" drawn={false} />);
    rerender(<Harness sessionId="s1" runtime="codex" mode="default" />);
    expect(screen.getByTestId('eligible')).toHaveTextContent('yes');
    expect(screen.getByTestId('read-only-mode-notice')).toBeInTheDocument();
  });

  it('is still owed when you come back to the session you left it standing in', () => {
    // Leaving the CONVERSATION is not leaving the mode. s1 never changed its
    // setting and never dismissed anything, so the fact is still true and still
    // unanswered when the person returns to it.
    const { rerender } = render(<Harness sessionId="s1" runtime="codex" mode="default" />);
    expect(screen.getByTestId('read-only-mode-notice')).toBeInTheDocument();
    rerender(<Harness sessionId="s2" runtime="codex" mode="acceptEdits" />);
    rerender(<Harness sessionId="s1" runtime="codex" mode="default" />);
    expect(screen.getByTestId('eligible')).toHaveTextContent('yes');
    expect(screen.getByTestId('read-only-mode-notice')).toBeInTheDocument();
  });

  it('does not let one session spend another session’s explanation', () => {
    // ChatPanel is not keyed by session id, so one instance of this hook serves
    // every conversation. A `wasSilent` ref survived the switch and spent the
    // SECOND session, which then never explained itself (DOR-2019 review).
    const { rerender } = render(<Harness sessionId="s1" runtime="codex" mode="default" />);
    expect(screen.getByTestId('read-only-mode-notice')).toBeInTheDocument();

    // Switch to a second session that is NOT in a silent read-only mode.
    rerender(<Harness sessionId="s2" runtime="codex" mode="acceptEdits" />);
    expect(screen.getByTestId('eligible')).toHaveTextContent('no');

    // s2 now moves to read-only. It has never been told, so it must be told.
    rerender(<Harness sessionId="s2" runtime="codex" mode="default" />);
    expect(screen.getByTestId('eligible')).toHaveTextContent('yes');
    expect(screen.getByTestId('read-only-mode-notice')).toBeInTheDocument();

    // And s1's own answer was not disturbed by any of it.
    expect(useSessionChatStore.getState().readOnlyHint.s1).toBe('shown');
  });
});

describe('ReadOnlyModeNotice', () => {
  it('says what the mode does and what happens when you ask for more', () => {
    render(<ReadOnlyModeNotice runtimeLabel="Codex" onDismiss={() => {}} />);
    expect(screen.getByTestId('read-only-mode-notice')).toHaveTextContent(
      'In this mode Codex can read files but not change them. Ask for a change and it will say no, with nothing for you to approve.'
    );
  });

  it('names whichever runtime declared the mode, never Codex by hardcode', () => {
    render(<ReadOnlyModeNotice runtimeLabel="OpenCode" onDismiss={() => {}} />);
    expect(screen.getByTestId('read-only-mode-notice')).toHaveTextContent(
      'In this mode OpenCode can read files'
    );
  });

  it('opens the picker through the store, not by clicking a trigger', async () => {
    render(<ReadOnlyModeNotice runtimeLabel="Codex" onDismiss={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Change permissions' }));
    expect(useSessionPermissionPicker.getState().open).toBe(true);
  });

  it('offers no way in when the status line has dropped the picker', () => {
    // The phone case. `applyStatusBudget` removes an item that does not fit from
    // the array rather than hiding it, so at a narrow width there is no picker
    // in the DOM at all — and a button that quietly does nothing is worse than
    // no button.
    act(() => {
      useSessionPermissionPicker.setState({ available: false });
    });
    render(<ReadOnlyModeNotice runtimeLabel="Codex" onDismiss={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Change permissions' })).not.toBeInTheDocument();
    // The sentence and the dismissal still stand.
    expect(screen.getByTestId('read-only-mode-notice')).toHaveTextContent('can read files');
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
  });

  it('reports that it reached the screen, once', () => {
    const onShown = vi.fn();
    const { rerender } = render(
      <ReadOnlyModeNotice runtimeLabel="Codex" onShown={onShown} onDismiss={() => {}} />
    );
    rerender(<ReadOnlyModeNotice runtimeLabel="Codex" onShown={onShown} onDismiss={() => {}} />);
    expect(onShown).toHaveBeenCalledTimes(1);
  });
});
