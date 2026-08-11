// @vitest-environment jsdom
/**
 * The durable half of the autonomy door (spec `trust-dial`, decision 5).
 *
 * The dialog itself, and the once-per-session memory behind it, are covered in
 * `ChatStatusSection-plan-mode.test.tsx`. What is checked here is the part that
 * outlives a session: "don't show this again" writing a standing
 * acknowledgement, the cockpit asserting that standing consent on every later
 * autonomy change instead of asking, and what happens when the server disagrees
 * and refuses one anyway.
 *
 * That last case is the reason the door lives on the server at all. This client
 * can be wrong about the standing record — another tab cleared it, this tab's
 * config is a minute stale — and when it is, the refusal has to become the
 * question again rather than an error nobody can act on.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { useSessionChatStore } from '@/layers/entities/session';

// ──────────────────────────────────────────────────────────────────────────────
// Mocks (hoisted before component import)
// ──────────────────────────────────────────────────────────────────────────────

/** The standing acknowledgement this suite pretends is on file. */
const standingAck = { current: null as string | null };
/** Whether the transport behind this suite can store one at all (false = Obsidian). */
const canRemember = { current: true };
const acknowledge = vi.fn();
vi.mock('@/layers/entities/config/model/use-autonomy-acknowledgement', () => ({
  useAutonomyAcknowledgement: () => ({
    acknowledgedAt: standingAck.current,
    acknowledge,
    clear: vi.fn(),
    canRemember: canRemember.current,
    isPending: false,
  }),
}));

// The status line now also asks where NEW sessions start, so it reads config and
// can write it (spec `trust-dial`, decision 6C). Stubbed to "nothing configured,
// writes go nowhere" — the offer is its own suite's subject
// (`ChatStatusSection-make-default.test.tsx`), and every case below is about
// something else.
vi.mock('@/layers/entities/config/model/use-config', () => ({
  useConfig: () => ({ data: undefined }),
}));
vi.mock('@/layers/entities/config/model/use-update-config', () => ({
  useUpdateConfig: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({
  useIsMobile: () => false,
}));

const CAPS: RuntimeCapabilities = {
  type: 'claude-code',
  supportsToolApproval: true,
  supportsCostTracking: true,
  supportsResume: true,
  supportsMcp: true,
  supportsManagedMcpServers: true,
  supportsQuestionPrompt: true,
  supportsPlugins: true,
  supportsPersistentSession: false,
  supportsSteer: false,
  supportsContextStaging: false,
  nativeContext: [],
  permissionModes: {
    supported: true,
    default: 'default',
    values: [
      {
        id: 'default',
        label: 'Default',
        stop: 'ask',
        asks: 'always',
        reach: 'edit',
        promise: 'Asks before it edits a file or runs a command.',
      },
      {
        id: 'acceptEdits',
        label: 'Accept edits',
        stop: 'act',
        asks: 'when-risky',
        reach: 'edit',
        promise: 'Edits files on its own. Asks before it runs a command.',
      },
      {
        id: 'bypassPermissions',
        label: 'Bypass permissions',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise: 'Runs everything without asking, including outside this project.',
      },
      {
        // A middle stop that never asks — Codex's shape, declared here so the
        // door can be exercised without naming a runtime (DOR-816). It sits at
        // the same stop as `acceptEdits` above, which is exactly the pairing
        // that matters: one of them asks and one of them cannot.
        id: 'dontAsk',
        label: 'Workspace write',
        stop: 'act',
        asks: 'never',
        reach: 'workspace',
        promise: 'Edits files and runs commands inside the workspace without asking.',
      },
    ],
  },
  commandIntents: { compact: { supported: false } },
  settings: { configSection: null, supportsEffort: false, sections: [] },
  features: {},
};

vi.mock('@/layers/entities/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/runtime')>()),
  useCapabilitiesForRuntime: () => CAPS,
  useRuntimeCapabilities: () => ({ data: undefined }),
}));

vi.mock('@/layers/entities/session/model/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/use-sessions')>()),
  useSessions: () => ({ sessions: [], isLoading: false }) as never,
}));

/**
 * What the server answers next. `null` means it accepts; an error object is
 * handed to the caller's `onError` exactly as the real hook does — after its own
 * rollback, and without throwing.
 */
const nextRefusal = { current: null as { code?: string } | null };
const updateSession = vi.fn((_opts: unknown, handlers?: { onError?: (err: unknown) => void }) => {
  if (nextRefusal.current) handlers?.onError?.(nextRefusal.current);
  return Promise.resolve(undefined);
});
vi.mock('@/layers/entities/session/model/use-session-status', () => ({
  useSessionStatus: () => ({
    permissionMode: 'default',
    cwd: '/test/dir',
    model: 'claude-opus-4-8',
    costUsd: null,
    contextPercent: null,
    updateSession,
  }),
}));

vi.mock('@/layers/entities/session/model/use-models', () => ({
  useModels: () => ({
    data: [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8', supportsAutoMode: false }],
  }),
}));

vi.mock('@/layers/entities/session/model/use-subagents', () => ({
  useSubagents: () => ({ data: undefined }),
}));

vi.mock('@/layers/entities/workspace', () => ({
  useWorkspaceForSession: () => null,
}));

vi.mock('@/layers/shared/model/TransportContext', () => ({
  useTransport: vi.fn(() => ({ runCommandIntent: vi.fn() })),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: vi.fn(() => ({ data: undefined })),
    useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
  };
});

vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state: Record<string, unknown> = {
      pendingRuntime: null,
      setPendingRuntime: vi.fn(),
      enableNotificationSound: false,
      setEnableNotificationSound: vi.fn(),
      enableMessagePolling: false,
      setEnableMessagePolling: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../ui/status/AgentIdentityChip', () => ({
  AgentIdentityChip: () => null,
}));

vi.mock('@/layers/features/status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/features/status')>();
  return {
    ...actual,
    StatusLine: ({ items }: { items: { key: string; node: React.ReactNode }[] }) => (
      <div data-testid="status-line">
        {items.map((item) => (
          <div key={item.key}>{item.node}</div>
        ))}
      </div>
    ),
    CwdItem: () => null,
    GitStatusItem: () => null,
    PermissionModeItem: ({ onChangeMode }: { onChangeMode: (m: string) => void }) => (
      <>
        <button
          type="button"
          data-testid="select-autonomy"
          onClick={() => onChangeMode('bypassPermissions')}
        >
          select autonomy
        </button>
        <button
          type="button"
          data-testid="select-never-asking-middle"
          onClick={() => onChangeMode('dontAsk')}
        >
          select the middle stop that never asks
        </button>
        <button
          type="button"
          data-testid="select-asking-middle"
          onClick={() => onChangeMode('acceptEdits')}
        >
          select the middle stop that asks
        </button>
      </>
    ),
    ModelConfigPopover: () => null,
    ContextItem: () => null,
    UsageStatusItem: () => null,
    ConnectionItem: () => null,
    SubagentsItem: () => null,
    SessionPopover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useGitStatus: vi.fn(() => ({ data: undefined })),
    useStatusBarPins: () => ({ pins: ['permission'], toggle: vi.fn(), reset: vi.fn() }),
  };
});

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

// Import after mocks
import { ChatStatusSection } from '../ui/status/ChatStatusSection';
import { TooltipProvider } from '@/layers/shared/ui';

const SESSION_ID = 'autonomy-door-session';

const defaultProps = {
  sessionId: SESSION_ID,
  sessionStatus: null,
  isStreaming: false,
  syncConnectionState: 'connected' as const,
};

function renderSection() {
  return render(
    <TooltipProvider>
      <ChatStatusSection {...defaultProps} />
    </TooltipProvider>
  );
}

/** The dialog's "don't show this again" tick. */
function rememberCheckbox() {
  return screen.getByRole('checkbox', { name: /don.t show this again/i });
}

/** The first (and normally only) settings PATCH the component sent. */
function firstPatch(): Record<string, unknown> | undefined {
  return updateSession.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  updateSession.mockClear();
  acknowledge.mockClear();
  standingAck.current = null;
  canRemember.current = true;
  nextRefusal.current = null;
  useSessionChatStore.setState({ autonomyConfirmedSessions: {} });
});

afterEach(cleanup);

describe('the standing acknowledgement is offered, not assumed', () => {
  it('starts unticked, so confirming once means once', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-autonomy'));

    expect(rememberCheckbox()).not.toBeChecked();
  });

  it('records nothing durable when the box is left alone', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-autonomy'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Full autonomy' }));

    expect(acknowledge).not.toHaveBeenCalled();
    // The session still remembers, which is the #680 behavior this preserves.
    expect(useSessionChatStore.getState().autonomyConfirmedSessions[SESSION_ID]).toBe(true);
  });

  it('records the standing acknowledgement when the box is ticked', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-autonomy'));
    fireEvent.click(rememberCheckbox());
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Full autonomy' }));

    expect(acknowledge).toHaveBeenCalledTimes(1);
    // And the mode still changes in the same act — the write does not wait on
    // the config round trip.
    expect(firstPatch()).toEqual({
      permissionMode: 'bypassPermissions',
      acknowledgedAutonomy: true,
    });
  });

  it('forgets a tick that was never confirmed', () => {
    // Cancelling and coming back must not present the box already ticked: that
    // would turn a change of mind into a standing consent.
    renderSection();
    fireEvent.click(screen.getByTestId('select-autonomy'));
    fireEvent.click(rememberCheckbox());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByTestId('select-autonomy'));
    expect(rememberCheckbox()).not.toBeChecked();
  });
});

describe('nothing is offered that could not be kept', () => {
  it('withholds the checkbox where the answer could not be stored', () => {
    // Obsidian. `DirectTransport.updateConfig` is a documented no-op and its
    // `getConfig` returns no `ui` block, so a tick there would save nothing,
    // report nothing, and ask again forever. The dialog still works — it just
    // asks every time, which is what it did before any of this existed.
    canRemember.current = false;
    renderSection();

    fireEvent.click(screen.getByTestId('select-autonomy'));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: /don.t show this again/i })
    ).not.toBeInTheDocument();
  });

  it('still confirms, and still records nothing durable', () => {
    canRemember.current = false;
    renderSection();

    fireEvent.click(screen.getByTestId('select-autonomy'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Full autonomy' }));

    expect(acknowledge).not.toHaveBeenCalled();
    expect(firstPatch()).toEqual({
      permissionMode: 'bypassPermissions',
      acknowledgedAutonomy: true,
    });
  });
});

describe('a standing acknowledgement is sent, not re-asked', () => {
  it('skips the dialog and asserts the consent on the request', () => {
    standingAck.current = '2026-08-01T09:30:00.000Z';
    renderSection();

    fireEvent.click(screen.getByTestId('select-autonomy'));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(firstPatch()).toEqual({
      permissionMode: 'bypassPermissions',
      acknowledgedAutonomy: true,
    });
  });
});

describe('a refusal reopens the door', () => {
  it('asks again when the server says an acknowledgement is required', () => {
    // The state this exists for: this client believes it has consent on file,
    // and the server does not agree.
    standingAck.current = '2026-08-01T09:30:00.000Z';
    nextRefusal.current = { code: 'AUTONOMY_ACK_REQUIRED' };
    renderSection();

    fireEvent.click(screen.getByTestId('select-autonomy'));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Turn on Full autonomy');
  });

  it('does not turn an ordinary failure into a consent question', () => {
    // A dropped connection is not a question about autonomy, and dressing it as
    // one would ask a person to agree to something to fix their network.
    standingAck.current = '2026-08-01T09:30:00.000Z';
    nextRefusal.current = { code: 'SESSION_LOCKED' };
    renderSection();

    fireEvent.click(screen.getByTestId('select-autonomy'));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe('a middle stop that never asks (DOR-816)', () => {
  it('asks first, in the words of the stop the person picked', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-never-asking-middle'));

    const dialog = screen.getByRole('alertdialog');
    // Never "Full autonomy": this mode is bounded to the workspace, and
    // borrowing the loudest word for it is how the loudest word stops working.
    expect(dialog).toHaveTextContent('Turn on Act');
    expect(dialog).not.toHaveTextContent(/Full autonomy/);
    // The fact the stop's own name hides — "Act" promises asking about the
    // risky parts, and this runtime cannot. It has to be ANNOUNCED, not merely
    // present: a sentence outside the element `aria-describedby` points at is
    // one a screen reader never reads, and this is the sentence that exists
    // because the name is misleading.
    const note = screen.getByTestId('consent-asks-note');
    expect(note).toHaveTextContent(/never pauses to ask/i);
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy, 'the dialog must point at a description').toBeTruthy();
    const description = document.getElementById(describedBy!);
    expect(description).toContainElement(note);
    // And the words must not run together when they are read out. The
    // accessible description is computed from text content, which ignores the
    // line break this sits on — so the separating space has to be in the markup
    // or a screen reader says "anytime.This stop never pauses".
    expect(description?.textContent).toMatch(/anytime\.\sThis stop never pauses/);
    // And the correction the strongest sentence has to arrive with (DOR-816):
    // this mode covers tools in the session, not DorkOS's own approvals.
    expect(dialog).toHaveTextContent(/Actions on DorkOS itself/);
    // Nothing is written until they answer.
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('applies it with the acknowledgement once the person confirms', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-never-asking-middle'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Act' }));

    expect(firstPatch()).toEqual({ permissionMode: 'dontAsk', acknowledgedAutonomy: true });
  });

  it('offers the same standing acknowledgement, and honours one already on file', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-never-asking-middle'));
    fireEvent.click(rememberCheckbox());
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Act' }));

    expect(acknowledge).toHaveBeenCalledTimes(1);

    // One record, one door: what the person acknowledged is that a mode will
    // not stop to ask, so the standing record covers this stop too.
    cleanup();
    updateSession.mockClear();
    standingAck.current = '2026-08-01T09:30:00.000Z';
    renderSection();
    fireEvent.click(screen.getByTestId('select-never-asking-middle'));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(firstPatch()).toEqual({ permissionMode: 'dontAsk', acknowledgedAutonomy: true });
  });

  it('leaves the same stop alone on a runtime that still asks', () => {
    // `acceptEdits` sits at the very same stop and asks about the risky parts.
    // One click, no dialog, no acknowledgement on the wire.
    renderSection();
    fireEvent.click(screen.getByTestId('select-asking-middle'));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(firstPatch()).toEqual({ permissionMode: 'acceptEdits' });
  });
});
