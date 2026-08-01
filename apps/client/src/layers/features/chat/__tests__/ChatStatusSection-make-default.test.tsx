// @vitest-environment jsdom
/**
 * "Start every new session in ⟨stop⟩?" — the offer that meets the intent where
 * it happens (spec `trust-dial`, decision 6C).
 *
 * The behaviour worth pinning is not that a line appears; it is everything that
 * keeps the line from appearing. An offer that showed up on every stop change
 * would be a nag, and this one has three separate reasons to stay quiet: the
 * chosen stop is already the effective default, this session already said no, or
 * nothing on this install could store the answer. Each is checked here, because
 * each is the difference between a product that noticed and a product that
 * pesters.
 *
 * The autonomy path is checked too, and it is the one with teeth: making Full
 * autonomy the standing default needs the durable acknowledgement, in the same
 * write, or the server refuses it.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { ExecutionDefaults } from '@dorkos/shared/types';
import { useSessionChatStore } from '@/layers/entities/session';

// ──────────────────────────────────────────────────────────────────────────────
// Mocks (hoisted before component import)
// ──────────────────────────────────────────────────────────────────────────────

const standingAck = { current: null as string | null };
const canRemember = { current: true };
vi.mock('@/layers/entities/config/model/use-autonomy-acknowledgement', () => ({
  useAutonomyAcknowledgement: () => ({
    acknowledgedAt: standingAck.current,
    acknowledge: vi.fn(),
    clear: vi.fn(),
    canRemember: canRemember.current,
    isPending: false,
  }),
}));

/** What `GET /api/config` reports about where new sessions start. */
const executionDefaults = {
  current: {
    runtime: 'claude-code',
    trustStop: null,
    perRuntime: [
      {
        runtime: 'claude-code',
        model: null,
        effort: null,
        supportsEffort: true,
        trustStop: null,
      },
    ],
  } as ExecutionDefaults,
};
vi.mock('@/layers/entities/config/model/use-config', () => ({
  useConfig: () => ({ data: { executionDefaults: executionDefaults.current } }),
}));

const updateConfig = vi.fn();
vi.mock('@/layers/entities/config/model/use-update-config', () => ({
  useUpdateConfig: () => ({ mutate: updateConfig, isPending: false }),
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
  supportsQuestionPrompt: true,
  supportsPlugins: true,
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
        id: 'plan',
        label: 'Plan',
        stop: 'ask',
        axis: 'working',
        asks: 'always',
        reach: 'read',
        promise: 'Reads and plans only. Nothing changes until you approve the plan.',
      },
      {
        id: 'bypassPermissions',
        label: 'Bypass permissions',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise: 'Runs everything without asking, including outside this project.',
      },
    ],
  },
  commandIntents: { compact: { supported: false } },
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

const updateSession = vi.fn(() => Promise.resolve(undefined));
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
    // Stands in for the popover's dial: three ways to pick a stop, and the REAL
    // line under them, wired from the props the component actually passes.
    PermissionModeItem: ({
      onChangeMode,
      makeDefault,
    }: {
      onChangeMode: (m: string) => void;
      makeDefault: React.ComponentProps<typeof actual.MakeDefaultStopLine> | null;
    }) => (
      <div>
        <button type="button" data-testid="select-ask" onClick={() => onChangeMode('default')}>
          ask
        </button>
        <button type="button" data-testid="select-act" onClick={() => onChangeMode('acceptEdits')}>
          act
        </button>
        <button type="button" data-testid="select-plan" onClick={() => onChangeMode('plan')}>
          plan
        </button>
        <button
          type="button"
          data-testid="select-autonomy"
          onClick={() => onChangeMode('bypassPermissions')}
        >
          autonomy
        </button>
        {makeDefault && <actual.MakeDefaultStopLine {...makeDefault} />}
      </div>
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

const SESSION_ID = 'make-default-session';

function renderSection() {
  return render(
    <TooltipProvider>
      <ChatStatusSection
        sessionId={SESSION_ID}
        sessionStatus={null}
        isStreaming={false}
        syncConnectionState="connected"
      />
    </TooltipProvider>
  );
}

beforeEach(() => {
  vi.useRealTimers();
  updateSession.mockClear();
  updateConfig.mockClear();
  standingAck.current = null;
  canRemember.current = true;
  executionDefaults.current = {
    runtime: 'claude-code',
    trustStop: null,
    perRuntime: [
      { runtime: 'claude-code', model: null, effort: null, supportsEffort: true, trustStop: null },
    ],
  };
  useSessionChatStore.setState({ autonomyConfirmedSessions: {}, defaultStopOfferDismissed: {} });
});

afterEach(cleanup);

describe('the offer appears where the habit is', () => {
  it('offers the stop just chosen, by its own name', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));

    expect(screen.getByTestId('make-default-offer')).toHaveTextContent(
      'Start every new session in Act?'
    );
  });

  it('writes the runtime-neutral stop when accepted', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));
    fireEvent.click(screen.getByTestId('make-default-confirm'));

    expect(updateConfig.mock.calls[0]![0]).toEqual({ runtimes: { defaultTrustStop: 'act' } });
    // And the offer is done: it was an offer, not a toggle.
    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
  });

  it('reserves its space, so arriving moves nothing', () => {
    // The offer appears under a control the person is mid-interaction with. A
    // line that pushed the caption down as it arrived would move the thing they
    // are pointing at.
    renderSection();
    expect(screen.getByTestId('make-default-slot')).toBeInTheDocument();
    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
  });

  it('withdraws itself after a few seconds', () => {
    vi.useFakeTimers();
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));
    expect(screen.getByTestId('make-default-offer')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(6_000);
    });

    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
  });
});

describe('the offer stays quiet when it would say nothing', () => {
  it('says nothing about a stop that is already where new sessions start', () => {
    // Ask first, on a fresh install: the runtime already starts there, so
    // "make it the default" would be an offer to change nothing.
    renderSection();
    fireEvent.click(screen.getByTestId('select-ask'));

    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
  });

  it('reads the configured default, not just the runtime’s own', () => {
    executionDefaults.current = { ...executionDefaults.current, trustStop: 'act' };
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));

    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
  });

  it('prefers a per-runtime override over the global one, as the server does', () => {
    executionDefaults.current = {
      runtime: 'claude-code',
      trustStop: 'ask',
      perRuntime: [
        {
          runtime: 'claude-code',
          model: null,
          effort: null,
          supportsEffort: true,
          trustStop: 'act',
        },
      ],
    };
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));

    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
  });

  it('never offers a way of working as a trust level', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-plan'));

    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
  });

  it('remembers a dismissal for the rest of the session', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));
    fireEvent.click(screen.getByTestId('make-default-dismiss'));
    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
    expect(useSessionChatStore.getState().defaultStopOfferDismissed[SESSION_ID]).toBe(true);

    fireEvent.click(screen.getByTestId('select-act'));
    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
  });

  it('offers nothing where the answer could not be stored', () => {
    // Obsidian: config does not round-trip, so an offer would save nothing and
    // report nothing — worse than never offering.
    canRemember.current = false;
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));

    expect(screen.queryByTestId('make-default-slot')).not.toBeInTheDocument();
  });
});

describe('Full autonomy as the standing default asks first', () => {
  /** The dialog that belongs to the DEFAULT, told apart by its consent note. */
  function defaultConsentDialog() {
    return screen.queryByTestId('autonomy-consent-note');
  }

  it('offers the default right after the person confirms it for this session', () => {
    // The person decision 6C was written for: they choose Full autonomy every
    // morning, and they have just been told exactly what it means.
    renderSection();
    fireEvent.click(screen.getByTestId('select-autonomy'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Full autonomy' }));

    expect(screen.getByTestId('make-default-offer')).toHaveTextContent(
      'Start every new session in Full autonomy?'
    );
  });

  it('asks again before making it standing, and writes nothing until answered', () => {
    // A session-scoped confirmation is an answer about one conversation. Making
    // it the default is the wider claim, and the server requires a durable
    // record for it.
    renderSection();
    fireEvent.click(screen.getByTestId('select-autonomy'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Full autonomy' }));
    fireEvent.click(screen.getByTestId('make-default-confirm'));

    expect(defaultConsentDialog()).toBeInTheDocument();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('records the acknowledgement and the default in one write', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-autonomy'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Full autonomy' }));
    fireEvent.click(screen.getByTestId('make-default-confirm'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Full autonomy' }));

    expect(updateConfig).toHaveBeenCalledTimes(1);
    const patch = updateConfig.mock.calls[0]![0] as {
      ui: { autonomyAcknowledgedAt: string };
      runtimes: { defaultTrustStop: string };
    };
    expect(patch.runtimes).toEqual({ defaultTrustStop: 'autonomy' });
    expect(typeof patch.ui.autonomyAcknowledgedAt).toBe('string');
  });

  it('asks nothing of somebody who already has a standing acknowledgement', () => {
    standingAck.current = '2026-08-01T09:30:00.000Z';
    renderSection();
    fireEvent.click(screen.getByTestId('select-autonomy'));
    fireEvent.click(screen.getByTestId('make-default-confirm'));

    expect(defaultConsentDialog()).not.toBeInTheDocument();
    expect(updateConfig.mock.calls[0]![0]).toEqual({ runtimes: { defaultTrustStop: 'autonomy' } });
  });
});
