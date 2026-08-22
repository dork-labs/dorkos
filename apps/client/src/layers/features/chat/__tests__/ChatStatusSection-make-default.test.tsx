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
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
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
  // Where this runtime keeps its settings, declared by the runtime itself. The
  // hook reads the per-runtime config leaf off this, so a fixture that lied
  // here would let the offer write a leaf nothing reads.
  settings: { configSection: 'claudeCode', supportsEffort: true, sections: [] },
  features: {},
};

/**
 * What `GET /api/capabilities` has answered so far. Mutable because "it has not
 * answered yet" is a state the hook has to survive, not an impossible one.
 */
const capabilityMap = {
  current: { capabilities: { 'claude-code': CAPS }, defaultRuntime: 'claude-code' } as
    | { capabilities: Record<string, RuntimeCapabilities>; defaultRuntime: string }
    | undefined,
};

vi.mock('@/layers/entities/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/runtime')>()),
  useCapabilitiesForRuntime: () => CAPS,
  useRuntimeCapabilities: () => ({ data: capabilityMap.current }),
}));

vi.mock('@/layers/entities/session/model/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/use-sessions')>()),
  useSessions: () => ({ sessions: [], isLoading: false }) as never,
}));

/**
 * What the server answers next: an updated session (success) or `undefined`,
 * which is what `useSessionStatus.updateSession` returns once it has handed a
 * failure to `onError`.
 */
const nextUpdateResult = { current: { id: 'ok' } as unknown };
const updateSession = vi.fn(() => Promise.resolve(nextUpdateResult.current));
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
      pendingAccount: null,
      setPendingAccount: vi.fn(),
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
      onOpenChange,
    }: {
      onChangeMode: (m: string) => void;
      makeDefault: React.ComponentProps<typeof actual.MakeDefaultStopLine> | null;
      onOpenChange?: (open: boolean) => void;
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
        <button type="button" data-testid="open-picker" onClick={() => onOpenChange?.(true)}>
          open picker
        </button>
        <button type="button" data-testid="close-picker" onClick={() => onOpenChange?.(false)}>
          close picker
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

/**
 * The status section for one conversation. Built as an element rather than
 * rendered here so a test can hand the SAME tree a different `sessionId` — the
 * cockpit switches conversations without remounting `ChatPanel`, and that is a
 * state the offer has to survive correctly.
 */
function section(sessionId: string = SESSION_ID) {
  return (
    <TooltipProvider>
      <ChatStatusSection
        sessionId={sessionId}
        sessionStatus={null}
        isStreaming={false}
        syncConnectionState="connected"
      />
    </TooltipProvider>
  );
}

function renderSection(sessionId: string = SESSION_ID) {
  return render(section(sessionId));
}

beforeEach(() => {
  vi.useRealTimers();
  updateSession.mockClear();
  nextUpdateResult.current = { id: 'ok' };
  updateConfig.mockClear();
  standingAck.current = null;
  canRemember.current = true;
  capabilityMap.current = { capabilities: { 'claude-code': CAPS }, defaultRuntime: 'claude-code' };
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
  it('offers the stop just chosen, by its own name', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));

    expect(await screen.findByTestId('make-default-offer')).toHaveTextContent(
      'Start every new session in Act?'
    );
  });

  it('writes the runtime-neutral stop when accepted', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));
    fireEvent.click(await screen.findByTestId('make-default-confirm'));

    expect(updateConfig.mock.calls[0]![0]).toEqual({ runtimes: { defaultTrustStop: 'act' } });
  });

  it('waits for the change to land before proposing to spread it', async () => {
    // Offering to make a stop the standing default while the session itself
    // failed to take it would be the product proposing to spread a change that
    // did not happen.
    nextUpdateResult.current = undefined;
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));
    await waitFor(() => expect(updateSession).toHaveBeenCalled());

    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
  });

  it('reserves its space inside the open picker, so arriving moves nothing', async () => {
    // The inline instance appears under a control the person is mid-interaction
    // with, so its row is there whether or not it has anything in it.
    renderSection();
    fireEvent.click(screen.getByTestId('open-picker'));

    expect(await screen.findByTestId('make-default-slot')).toBeInTheDocument();
    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
  });

  it('costs the closed composer nothing at all', async () => {
    // The overlay instance takes no space until there is something to say —
    // a permanently reserved row under the status line would charge every
    // conversation a blank line for a remark that is usually absent.
    renderSection();
    expect(screen.queryByTestId('make-default-slot-overlay')).not.toBeInTheDocument();
  });

  it('speaks from the overlay while the picker is shut, and inline once it opens', async () => {
    // The two homes, and why there are two: the Full-autonomy dialog closes the
    // picker under it, so an offer that only existed inline would be drawn into
    // an unmounted tree (observed in a browser, 2026-08-01).
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));
    await screen.findByTestId('make-default-offer');
    expect(screen.getByTestId('make-default-slot-overlay')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('open-picker'));
    await waitFor(() =>
      expect(screen.queryByTestId('make-default-slot-overlay')).not.toBeInTheDocument()
    );
    expect(screen.getByTestId('make-default-slot')).toBeInTheDocument();
    expect(screen.getByTestId('make-default-offer')).toBeInTheDocument();
  });

  it('withdraws itself after a few seconds, whether or not anything is drawing it', async () => {
    // `shouldAdvanceTime` keeps Testing Library's own waiting working while the
    // offer's clock is under our control.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));
    await screen.findByTestId('make-default-offer');

    // The clock belongs to the offer, not to the line: an offer made while the
    // picker was closed used to sit un-expired and reappear stale.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe('the offer stays quiet when it would say nothing', () => {
  it('says nothing about a stop that is already where new sessions start', async () => {
    // Ask first, on a fresh install: the runtime already starts there, so
    // "make it the default" would be an offer to change nothing.
    renderSection();
    fireEvent.click(screen.getByTestId('select-ask'));
    await waitFor(() => expect(updateSession).toHaveBeenCalled());

    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
  });

  it('reads the configured default, not just the runtime’s own', async () => {
    executionDefaults.current = { ...executionDefaults.current, trustStop: 'act' };
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));
    await waitFor(() => expect(updateSession).toHaveBeenCalled());

    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
  });

  it('prefers a per-runtime override over the global one, as the server does', async () => {
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
    await waitFor(() => expect(updateSession).toHaveBeenCalled());

    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
  });

  it('never offers a way of working as a trust level', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-plan'));
    await waitFor(() => expect(updateSession).toHaveBeenCalled());

    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
  });

  it('remembers a dismissal for the rest of the session', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));
    fireEvent.click(await screen.findByTestId('make-default-dismiss'));
    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
    expect(useSessionChatStore.getState().defaultStopOfferDismissed[SESSION_ID]).toBe(true);

    fireEvent.click(screen.getByTestId('select-act'));
    await waitFor(() => expect(updateSession).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
  });

  it('offers nothing where the answer could not be stored', async () => {
    // Obsidian: config does not round-trip, so an offer would save nothing and
    // report nothing — worse than never offering.
    canRemember.current = false;
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));
    await waitFor(() => expect(updateSession).toHaveBeenCalled());

    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
  });
});

describe('the offer writes the leaf it compared', () => {
  it('writes THIS runtime’s override when that is what made it differ', async () => {
    // The forever-no-op this exists to end: with an override at Ask first, a
    // person picking Act was offered the default, the write went to the GLOBAL
    // leaf, the override kept winning — and the same offer came back on the next
    // stop change, changing nothing, forever.
    executionDefaults.current = {
      runtime: 'claude-code',
      trustStop: null,
      perRuntime: [
        {
          runtime: 'claude-code',
          model: null,
          effort: null,
          supportsEffort: true,
          trustStop: 'ask',
        },
      ],
    };
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));
    fireEvent.click(await screen.findByTestId('make-default-confirm'));

    expect(updateConfig.mock.calls[0]![0]).toEqual({
      runtimes: { claudeCode: { defaultTrustStop: 'act' } },
    });
  });

  it('writes the global leaf when nothing overrides it', async () => {
    executionDefaults.current = { ...executionDefaults.current, trustStop: 'ask' };
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));
    fireEvent.click(await screen.findByTestId('make-default-confirm'));

    expect(updateConfig.mock.calls[0]![0]).toEqual({ runtimes: { defaultTrustStop: 'act' } });
  });

  it('falls back to the global leaf while the capability map has not arrived', async () => {
    // Which leaf a runtime's override lives under is the RUNTIME's declaration,
    // and before it arrives there is no honest per-runtime key to write. The
    // global leaf is the fallback rather than a guessed section name: a guess
    // that got the spelling wrong would write somewhere nothing reads and
    // report success. The offer still stands, so the write is still possible —
    // the map lands in milliseconds and the next attempt targets correctly.
    capabilityMap.current = undefined;
    executionDefaults.current = {
      runtime: 'claude-code',
      trustStop: null,
      perRuntime: [
        {
          runtime: 'claude-code',
          model: null,
          effort: null,
          supportsEffort: true,
          trustStop: 'ask',
        },
      ],
    };
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));
    fireEvent.click(await screen.findByTestId('make-default-confirm'));

    expect(updateConfig.mock.calls[0]![0]).toEqual({ runtimes: { defaultTrustStop: 'act' } });
  });
});

describe('the offer belongs to the conversation it was made about (DOR-1237)', () => {
  // `ChatPanel` is not keyed by session id — switching conversations changes a
  // prop and keeps every piece of component state. So an offer armed by a dial
  // move in one conversation used to still be standing, one click from a
  // durable write, in the next one: the person answers a question they were
  // never asked here, about a stop they chose somewhere else, and their
  // standing default moves. That is the drift DOR-1237 recorded on a real
  // install (`runtimes.claudeCode.defaultTrustStop` went `autonomy` → `act`
  // between two sign-offs, with nothing on the wire that admits to it).

  /** An install whose claude-code override is at Full autonomy, as DOR-1237's was. */
  function overrideAtAutonomy() {
    executionDefaults.current = {
      runtime: 'claude-code',
      trustStop: null,
      perRuntime: [
        {
          runtime: 'claude-code',
          model: null,
          effort: null,
          supportsEffort: true,
          trustStop: 'autonomy',
        },
      ],
    };
  }

  it('withdraws when the person moves to another conversation', async () => {
    overrideAtAutonomy();
    const { rerender } = renderSection();
    fireEvent.click(screen.getByTestId('select-act'));
    expect(await screen.findByTestId('make-default-offer')).toBeInTheDocument();

    rerender(section('some-other-session'));

    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
  });

  it('cannot be accepted after the switch, so no stop chosen elsewhere becomes the default', async () => {
    // The assertion with teeth: the button is what writes, so its absence is
    // what keeps `runtimes.claudeCode.defaultTrustStop` where the operator put
    // it. Left standing, one click here wrote `act` over `autonomy`.
    overrideAtAutonomy();
    const { rerender } = renderSection();
    fireEvent.click(screen.getByTestId('select-act'));
    await screen.findByTestId('make-default-confirm');

    rerender(section('some-other-session'));

    expect(screen.queryByTestId('make-default-confirm')).not.toBeInTheDocument();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('takes the Full-autonomy consent dialog with it', async () => {
    // The dialog whose answer IS the standing record. Surviving a switch, it
    // would ask about one conversation and be answered from another — and its
    // confirmation writes the default outright.
    const { rerender } = renderSection();
    fireEvent.click(screen.getByTestId('select-autonomy'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Full autonomy' }));
    fireEvent.click(await screen.findByTestId('make-default-confirm'));
    expect(screen.getByTestId('autonomy-consent-note')).toBeInTheDocument();

    rerender(section('some-other-session'));

    expect(screen.queryByTestId('autonomy-consent-note')).not.toBeInTheDocument();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('still offers in the conversation it was made about', async () => {
    // The guard is the SESSION changing, never a re-render — an offer that
    // withdrew on every parent render would never survive long enough to be
    // answered.
    overrideAtAutonomy();
    const { rerender } = renderSection();
    fireEvent.click(screen.getByTestId('select-act'));
    await screen.findByTestId('make-default-offer');

    rerender(section());

    expect(screen.getByTestId('make-default-offer')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('make-default-confirm'));
    expect(updateConfig.mock.calls[0]![0]).toEqual({
      runtimes: { claudeCode: { defaultTrustStop: 'act' } },
    });
  });
});

describe('a failed write is said, not swallowed', () => {
  it('keeps the offer standing and names the refusal', async () => {
    // A 428 (another tab pressed Reset between the read and the write) or a 403
    // (login came on) has to be sayable and retryable.
    updateConfig.mockImplementation(
      (_patch: unknown, handlers?: { onError?: (err: unknown) => void }) => {
        handlers?.onError?.(new Error('Turning on Full autonomy needs you to confirm it first.'));
      }
    );
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));
    fireEvent.click(await screen.findByTestId('make-default-confirm'));

    expect(await screen.findByTestId('make-default-offer')).toHaveTextContent(
      'Turning on Full autonomy needs you to confirm it first.'
    );
    expect(screen.getByTestId('make-default-retry')).toBeInTheDocument();
  });
});

describe('Full autonomy as the standing default asks first', () => {
  /** The dialog that belongs to the DEFAULT, told apart by its consent note. */
  function defaultConsentDialog() {
    return screen.queryByTestId('autonomy-consent-note');
  }

  it('offers the default right after the person confirms it for this session', async () => {
    // The person decision 6C was written for: they choose Full autonomy every
    // morning, and they have just been told exactly what it means. The dialog
    // has closed the picker by now, so this offer is the overlay's.
    renderSection();
    fireEvent.click(screen.getByTestId('select-autonomy'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Full autonomy' }));

    expect(await screen.findByTestId('make-default-offer')).toHaveTextContent(
      'Start every new session in Full autonomy?'
    );
  });

  it('asks again before making it standing, and writes nothing until answered', async () => {
    // A session-scoped confirmation is an answer about one conversation. Making
    // it the default is the wider claim, and the server requires a durable
    // record for it.
    renderSection();
    fireEvent.click(screen.getByTestId('select-autonomy'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Full autonomy' }));
    fireEvent.click(await screen.findByTestId('make-default-confirm'));

    expect(defaultConsentDialog()).toBeInTheDocument();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('records the acknowledgement and the default in one write', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-autonomy'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Full autonomy' }));
    fireEvent.click(await screen.findByTestId('make-default-confirm'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Full autonomy' }));

    expect(updateConfig).toHaveBeenCalledTimes(1);
    const patch = updateConfig.mock.calls[0]![0] as {
      ui: { autonomyAcknowledgedAt: string };
      runtimes: { defaultTrustStop: string };
    };
    expect(patch.runtimes).toEqual({ defaultTrustStop: 'autonomy' });
    expect(typeof patch.ui.autonomyAcknowledgedAt).toBe('string');
  });

  it('asks nothing of somebody who already has a standing acknowledgement', async () => {
    standingAck.current = '2026-08-01T09:30:00.000Z';
    renderSection();
    fireEvent.click(screen.getByTestId('select-autonomy'));
    fireEvent.click(await screen.findByTestId('make-default-confirm'));

    expect(defaultConsentDialog()).not.toBeInTheDocument();
    expect(updateConfig.mock.calls[0]![0]).toEqual({ runtimes: { defaultTrustStop: 'autonomy' } });
  });
});
