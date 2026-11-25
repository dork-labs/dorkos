// @vitest-environment jsdom
/**
 * Changing how a session runs from the status line: the Auto-mode confirmation,
 * Full autonomy as a plain choice, the composer's Plan switch, and the offer to
 * make a stop the default for new chats (spec `trust-dial`, decision 6C).
 *
 * The permission picker is replaced by a row of buttons that call the props the
 * section really passes; everything those props do runs for real.
 */
import { harness, resetHarness, hideStatusItems } from './chat-status-harness';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { ExecutionDefaults } from '@dorkos/shared/types';
import { useSessionChatStore } from '@/layers/entities/session';
import { MakeDefaultStopLine } from '@/layers/features/status';
import { TooltipProvider } from '@/layers/shared/ui';
import { ChatStatusSection } from '../ui/status/ChatStatusSection';

const SESSION_ID = 'permission-mode-session';

/** Claude's declared modes; `plan` is the way of working the Plan switch is built on. */
const CLAUDE_CAPS: RuntimeCapabilities = {
  type: 'claude-code',
  supportsToolApproval: true,
  supportsCostTracking: true,
  supportsResume: true,
  supportsMcp: true,
  supportsManagedMcpServers: true,
  supportsQuestionPrompt: true,
  supportsPlugins: true,
  supportsAccounts: true,
  supportsPersistentSession: false,
  supportsSteer: false,
  supportsContextStaging: false,
  wakesForLostBackgroundWork: false,
  continuesInterruptedTurn: false,
  mediaOutput: 'none',
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
  // offer writes the per-runtime leaf named here, so a fixture that lied would
  // let it write a leaf nothing reads.
  settings: { configSection: 'claudeCode', supportsEffort: true, sections: [] },
  features: {},
};

/** A runtime that declares no way of working at all. */
const CODEX_CAPS: RuntimeCapabilities = {
  ...CLAUDE_CAPS,
  type: 'codex',
  permissionModes: {
    supported: true,
    default: 'default',
    values: CLAUDE_CAPS.permissionModes.values.filter((v) => v.id !== 'plan'),
  },
};

/** Stands in for the picker: a way to pick each stop, and the REAL offer line under them. */
function PickerStub({
  onChangeMode,
  makeDefault,
  onOpenChange,
}: {
  onChangeMode: (m: string) => void;
  makeDefault: React.ComponentProps<typeof MakeDefaultStopLine> | null;
  onOpenChange?: (open: boolean) => void;
}) {
  const modes = {
    ask: 'default',
    act: 'acceptEdits',
    plan: 'plan',
    autonomy: 'bypassPermissions',
    auto: 'auto',
  };
  return (
    <div>
      {Object.entries(modes).map(([name, mode]) => (
        <button
          key={name}
          type="button"
          data-testid={`select-${name}`}
          onClick={() => onChangeMode(mode)}
        >
          {name}
        </button>
      ))}
      <button type="button" data-testid="open-picker" onClick={() => onOpenChange?.(true)}>
        open picker
      </button>
      {makeDefault && <MakeDefaultStopLine {...makeDefault} />}
    </div>
  );
}

/**
 * The section for one conversation. An element rather than a render so a test
 * can hand the SAME tree a different `sessionId`: the app switches conversations
 * without remounting `ChatPanel`.
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

function renderSection() {
  return render(section());
}

/** What `updateSession` was last asked to write, first argument only. */
function lastPatch(): unknown {
  return harness.updateSession.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  resetHarness();
  harness.status.PermissionModeItem = PickerStub;
  hideStatusItems('CwdItem', 'GitStatusItem', 'ModelConfigPopover', 'ContextItem');
  hideStatusItems('UsageStatusItem', 'SubagentsItem');
  // `default` permissions are quiet by design; pin the item into the line.
  harness.pins = ['permission'];
  harness.sessionStatus = { model: 'claude-opus-4-8' };
  harness.capabilitiesForRuntime = CLAUDE_CAPS;
  useSessionChatStore.setState({
    autoConfirmedSessions: {},
    modeBeforePlan: {},
    defaultStopOfferDismissed: {},
  });
});

afterEach(cleanup);

describe('ChatStatusSection — auto-mode entry confirmation', () => {
  beforeEach(() => {
    harness.capabilitiesForRuntime = undefined;
    harness.models = {
      data: [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8', supportsAutoMode: true }],
    };
  });

  it('first selection of auto opens the modal and does NOT call updateSession until confirm', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-auto'));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(harness.updateSession).not.toHaveBeenCalled();
  });

  it('confirming records the session, applies auto, and the next pick skips the modal', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-auto'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Auto mode' }));

    expect(lastPatch()).toEqual({ permissionMode: 'auto' });
    expect(useSessionChatStore.getState().hasConfirmedAuto(SESSION_ID)).toBe(true);

    harness.updateSession.mockClear();
    fireEvent.click(screen.getByTestId('select-auto'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(lastPatch()).toEqual({ permissionMode: 'auto' });
  });

  it('cancel leaves the mode unchanged and does not record the session', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-auto'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(harness.updateSession).not.toHaveBeenCalled();
    expect(useSessionChatStore.getState().hasConfirmedAuto(SESSION_ID)).toBe(false);
  });
});

describe('ChatStatusSection — Full autonomy is a normal choice', () => {
  // ADR 261006-225605 retired the consent ritual: no dialog, and the whole
  // argument list is the patch, so an acknowledgement riding along fails it.
  it.each([
    ['autonomy', 'bypassPermissions'],
    ['act', 'acceptEdits'],
  ])('writes the %s stop straight through', (stop, permissionMode) => {
    renderSection();
    fireEvent.click(screen.getByTestId(`select-${stop}`));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(harness.updateSession.mock.calls).toEqual([[{ permissionMode }]]);
  });
});

describe('ChatStatusSection — the composer’s Plan switch', () => {
  /** The Plan chip, not the picker stub's `plan` button. */
  function chip() {
    return screen
      .getAllByRole('button', { name: /plan/i })
      .find((b) => b.hasAttribute('aria-pressed'));
  }

  it('is offered on a runtime that declares a way of working, and off by default', () => {
    renderSection();
    expect(chip()).toHaveAttribute('aria-pressed', 'false');
  });

  it('is absent on a runtime that declares none', () => {
    harness.capabilitiesForRuntime = CODEX_CAPS;
    renderSection();
    expect(chip()).toBeUndefined();
  });

  it('reads as on while the session is planning', () => {
    harness.sessionStatus = { ...harness.sessionStatus, permissionMode: 'plan' };
    renderSection();
    expect(chip()).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches into planning and back to where the session was', () => {
    // On at Act…
    harness.sessionStatus = { ...harness.sessionStatus, permissionMode: 'acceptEdits' };
    const { rerender } = renderSection();
    fireEvent.click(chip()!);
    expect(lastPatch()).toEqual({ permissionMode: 'plan' });

    // …and off again returns to Act, not to the runtime's default.
    harness.sessionStatus = { ...harness.sessionStatus, permissionMode: 'plan' };
    rerender(section());
    fireEvent.click(chip()!);
    expect(lastPatch()).toEqual({ permissionMode: 'acceptEdits' });
  });

  // Leaving Plan restores what the session ran at before, unless the runtime no
  // longer offers it (a PATCH the server would reject), or nothing was remembered
  // because the session was opened mid-plan.
  it.each([
    ['restores Full autonomy, with no acknowledgement', 'bypassPermissions', 'bypassPermissions'],
    ['does not restore a mode the runtime no longer offers', 'auto', 'default'],
    ['falls back to the runtime default when nothing was remembered', undefined, 'default'],
  ])('leaving Plan %s', (_case, remembered, expected) => {
    useSessionChatStore.setState({
      modeBeforePlan: remembered ? { [SESSION_ID]: remembered } : {},
    });
    harness.sessionStatus = { ...harness.sessionStatus, permissionMode: 'plan' };
    renderSection();

    fireEvent.click(chip()!);
    expect(harness.updateSession.mock.calls).toEqual([[{ permissionMode: expected }]]);
  });
});

describe('the offer to make a stop the default', () => {
  /** A fresh install: claude-code, no stop configured anywhere. */
  function executionDefaults(
    trustStop: string | null = null,
    runtimeTrustStop: string | null = null
  ): ExecutionDefaults {
    return {
      runtime: 'claude-code',
      trustStop,
      perRuntime: [
        {
          runtime: 'claude-code',
          model: null,
          effort: null,
          supportsEffort: true,
          trustStop: runtimeTrustStop,
        },
      ],
    } as ExecutionDefaults;
  }

  function configure(defaults: ExecutionDefaults | null): void {
    harness.config = { data: defaults ? { executionDefaults: defaults } : undefined };
  }

  /** What the server answers next: an updated session, or `undefined` after a failed write. */
  let nextUpdateResult: unknown;

  beforeEach(() => {
    vi.useRealTimers();
    configure(executionDefaults());
    harness.runtimeCapabilities = {
      data: { capabilities: { 'claude-code': CLAUDE_CAPS }, defaultRuntime: 'claude-code' },
    };
    harness.models = {
      data: [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8', supportsAutoMode: false }],
    };
    nextUpdateResult = { id: 'ok' };
    harness.updateSession.mockImplementation(() => Promise.resolve(nextUpdateResult));
  });

  describe('appears where the habit is', () => {
    it('offers the stop just chosen, by its own name', async () => {
      renderSection();
      fireEvent.click(screen.getByTestId('select-act'));

      expect(await screen.findByTestId('make-default-offer')).toHaveTextContent(
        'Start every new chat in Act?'
      );
    });

    it('waits for the change to land before proposing to spread it', async () => {
      nextUpdateResult = undefined;
      renderSection();
      fireEvent.click(screen.getByTestId('select-act'));
      await waitFor(() => expect(harness.updateSession).toHaveBeenCalled());

      expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
    });

    it('reserves its space inside the open picker, and costs the closed composer nothing', async () => {
      renderSection();
      expect(screen.queryByTestId('make-default-slot-overlay')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('open-picker'));
      expect(await screen.findByTestId('make-default-slot')).toBeInTheDocument();
      expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
    });

    it('speaks from the overlay while the picker is shut, and inline once it opens', async () => {
      // The Full-autonomy dialog closes the picker under it, so an offer that only
      // existed inline would be drawn into an unmounted tree.
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
      // `shouldAdvanceTime` keeps Testing Library's own waiting working.
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderSection();
      fireEvent.click(screen.getByTestId('select-act'));
      await screen.findByTestId('make-default-offer');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });

      expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
      vi.useRealTimers();
    });

    it('offers Full autonomy right after the session switches to it, with no dialog', async () => {
      renderSection();
      fireEvent.click(screen.getByTestId('select-autonomy'));

      expect(await screen.findByTestId('make-default-offer')).toHaveTextContent(
        'Start every new chat in Full autonomy?'
      );
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
  });

  // An offer that showed up on every stop change would be a nag.
  it.each([
    ['a stop that is already where new sessions start', 'ask', executionDefaults()],
    ['the configured default', 'act', executionDefaults('act')],
    [
      'a per-runtime override, preferred as the server does',
      'act',
      executionDefaults('ask', 'act'),
    ],
    ['a way of working, which is not a trust level', 'plan', executionDefaults()],
    ['anything, while nothing could store the answer', 'act', null],
  ])('says nothing about %s', async (_case, stop, defaults) => {
    configure(defaults);
    renderSection();
    fireEvent.click(screen.getByTestId(`select-${stop}`));
    await waitFor(() => expect(harness.updateSession).toHaveBeenCalled());

    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
  });

  it('remembers a dismissal for the rest of the session', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));
    fireEvent.click(await screen.findByTestId('make-default-dismiss'));
    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
    expect(useSessionChatStore.getState().defaultStopOfferDismissed[SESSION_ID]).toBe(true);

    fireEvent.click(screen.getByTestId('select-act'));
    await waitFor(() => expect(harness.updateSession).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
  });

  // The forever-no-op this ends: with an override at Ask, accepting Act wrote the
  // GLOBAL leaf, the override kept winning, and the offer came back forever. With
  // no capability map there is no honest per-runtime key, so the global leaf is
  // the fallback rather than a guessed section name.
  it.each([
    [
      'the runtime-neutral stop on a fresh install',
      'act',
      executionDefaults(),
      true,
      { runtimes: { defaultTrustStop: 'act' } },
    ],
    [
      'THIS runtime’s override when that is what made it differ',
      'act',
      executionDefaults(null, 'ask'),
      true,
      { runtimes: { claudeCode: { defaultTrustStop: 'act' } } },
    ],
    [
      'the global leaf when nothing overrides it',
      'act',
      executionDefaults('ask'),
      true,
      { runtimes: { defaultTrustStop: 'act' } },
    ],
    [
      'the global leaf while the capability map has not arrived',
      'act',
      executionDefaults(null, 'ask'),
      false,
      { runtimes: { defaultTrustStop: 'act' } },
    ],
    [
      'Full autonomy as a plain write, with no acknowledgement',
      'autonomy',
      executionDefaults(),
      true,
      { runtimes: { defaultTrustStop: 'autonomy' } },
    ],
  ])('writes %s', async (_case, stop, defaults, mapArrived, patch) => {
    configure(defaults);
    if (!mapArrived) harness.runtimeCapabilities = { data: undefined };
    renderSection();
    fireEvent.click(screen.getByTestId(`select-${stop}`));
    fireEvent.click(await screen.findByTestId('make-default-confirm'));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(harness.updateConfig.mock.calls).toHaveLength(1);
    // The whole patch: an acknowledgement under `ui` riding along would fail it.
    expect(harness.updateConfig.mock.calls[0]![0]).toEqual(patch);
  });

  // DOR-1237: `ChatPanel` is not keyed by session id, so an offer armed in one
  // conversation used to still be standing, one click from a durable write, in
  // the next. On a real install `runtimes.claudeCode.defaultTrustStop` went
  // `autonomy` → `act` with nothing on the wire that admits to it.
  describe('belongs to the conversation it was made about (DOR-1237)', () => {
    beforeEach(() => configure(executionDefaults(null, 'autonomy')));

    it('withdraws on a switch, so no stop chosen elsewhere becomes the default', async () => {
      const { rerender } = renderSection();
      fireEvent.click(screen.getByTestId('select-act'));
      await screen.findByTestId('make-default-confirm');

      rerender(section('some-other-session'));

      expect(screen.queryByTestId('make-default-offer')).not.toBeInTheDocument();
      expect(screen.queryByTestId('make-default-confirm')).not.toBeInTheDocument();
      expect(harness.updateConfig).not.toHaveBeenCalled();
    });

    it('still offers in the conversation it was made about', async () => {
      // The guard is the SESSION changing, never a re-render.
      const { rerender } = renderSection();
      fireEvent.click(screen.getByTestId('select-act'));
      await screen.findByTestId('make-default-offer');

      rerender(section());

      fireEvent.click(screen.getByTestId('make-default-confirm'));
      expect(harness.updateConfig.mock.calls[0]![0]).toEqual({
        runtimes: { claudeCode: { defaultTrustStop: 'act' } },
      });
    });
  });

  it('keeps the offer standing and names a refused write', async () => {
    // A 403 (login came on) has to be sayable and retryable.
    harness.updateConfig.mockImplementation(
      (_patch: unknown, handlers?: { onError?: (err: unknown) => void }) => {
        handlers?.onError?.(new Error('Only a person can change this.'));
      }
    );
    renderSection();
    fireEvent.click(screen.getByTestId('select-act'));
    fireEvent.click(await screen.findByTestId('make-default-confirm'));

    expect(await screen.findByTestId('make-default-offer')).toHaveTextContent(
      'Only a person can change this.'
    );
    expect(screen.getByTestId('make-default-retry')).toBeInTheDocument();
  });
});
