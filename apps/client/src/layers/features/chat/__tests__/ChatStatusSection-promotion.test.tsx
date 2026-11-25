// @vitest-environment jsdom
/**
 * Which items earn a slot in the status line, how they rank, and what stays when
 * a chat drawn as a DM hides the line (DOR-3074). The real promotion and budget
 * pipeline runs; only its drawing is stubbed.
 */
import { harness, resetHarness, hideStatusItems } from './chat-status-harness';
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { ChatStatusSection } from '../ui/status/ChatStatusSection';
import { useSessionChatStore } from '@/layers/entities/session';

const SESSION_ID = 'promotion-session';

const props = {
  sessionId: SESSION_ID,
  sessionStatus: null,
  isStreaming: false,
  syncConnectionState: 'connected' as const,
};

/** Draws each promoted item as `key:severity`, so a test reads the ranking. */
function PromotedLine({ items }: { items: { key: string; severity: number }[] }) {
  return (
    <div data-testid="promoted">
      {items.map((item) => `${item.key}:${item.severity}`).join(' ')}
    </div>
  );
}

/** The promoted items, key to severity, for the current render. */
function promoted(): Map<string, number> {
  const text = screen.getByTestId('promoted').textContent ?? '';
  return new Map(
    text
      .split(' ')
      .filter(Boolean)
      .map((pair) => {
        const [key, severity] = pair.split(':');
        return [key!, Number(severity)] as const;
      })
  );
}

function sessionOn(runtime: string): void {
  harness.sessions = [{ id: SESSION_ID, runtime, model: null }];
}

beforeEach(() => {
  resetHarness();
  harness.status.StatusLine = PromotedLine;
  harness.status.SessionPopover = () => null;
  hideStatusItems('RuntimeItem', 'ModelConfigPopover', 'PermissionModeItem', 'CwdItem');
  hideStatusItems('SubagentsItem');
  sessionOn('codex');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ChatStatusSection — the runtime item and the capability map', () => {
  // With no map there is no `defaultRuntime` to compare against, so "is this the
  // default?" has no answer yet. Answering `false` promoted the item above git,
  // model and the directory for the frames before the query landed. A started
  // session row is what makes the chip resolve WITHOUT the map.
  it.each([
    ['no slot while the map is in flight', undefined, 'codex', false],
    ['a slot once the map says it is not the default', 'claude-code', 'codex', true],
    ['no slot once the map says it is the usual one', 'claude-code', 'claude-code', false],
  ] as const)('gives the runtime %s', (_case, defaultRuntime, runtime, promotes) => {
    harness.runtimeCapabilities = {
      data: defaultRuntime ? { defaultRuntime, capabilities: {} } : undefined,
    };
    sessionOn(runtime);
    render(<ChatStatusSection {...props} />);
    expect(promoted().has('runtime')).toBe(promotes);
  });
});

/**
 * ChatStatusSection is the ONLY producer of
 * `StatusPromotionContext.permissionDescriptor`. Every other test hands the
 * registry a descriptor directly, so replacing that one line with `null` would
 * leave all of them green while the app went back to ranking permissions by
 * mode NAME. This runtime's run-everything mode is spelled `yolo`, which no id
 * list in the client contains, so a bypass rank can only come from its declared
 * semantics.
 */
describe('ChatStatusSection — the permission item is ranked by what the mode does', () => {
  const EXOTIC: RuntimeCapabilities = {
    type: 'exotic',
    supportsToolApproval: true,
    supportsCostTracking: false,
    supportsResume: false,
    supportsMcp: false,
    supportsManagedMcpServers: false,
    supportsQuestionPrompt: false,
    supportsPlugins: false,
    supportsAccounts: false,
    supportsPersistentSession: false,
    supportsSteer: false,
    supportsContextStaging: false,
    wakesForLostBackgroundWork: false,
    continuesInterruptedTurn: false,
    mediaOutput: 'none',
    nativeContext: [],
    permissionModes: {
      supported: true,
      default: 'yolo',
      values: [
        {
          id: 'yolo',
          label: 'Yolo',
          stop: 'autonomy',
          asks: 'never',
          reach: 'everything',
          promise: 'Runs everything without asking.',
        },
      ],
    },
    commandIntents: { compact: { supported: false } },
    settings: { configSection: null, supportsEffort: false, sections: [] },
    features: {},
  };

  /** Ranks from `SEVERITY` in the status registry, restated so a drift is visible. */
  const PERMISSION_BYPASS = 70;
  const PERMISSION_ELEVATED = 40;

  beforeEach(() => {
    harness.capabilitiesForRuntime = EXOTIC;
    harness.runtimeCapabilities = {
      data: { defaultRuntime: 'exotic', capabilities: { exotic: EXOTIC } },
    };
    sessionOn('exotic');
  });

  // Passing `null` for the descriptor sends `yolo` back to the name fallback,
  // where it ranks 30 points lower; the ordinary mode proves the bypass rank is
  // about semantics, not the item shouting about everything.
  it.each([
    ['a run-everything mode as a bypass', 'yolo', PERMISSION_BYPASS],
    ['an ordinary mode at the elevated rank', 'acceptEdits', PERMISSION_ELEVATED],
  ])('ranks %s', (_case, permissionMode, severity) => {
    harness.sessionStatus = { permissionMode };
    render(<ChatStatusSection {...props} />);
    expect(promoted().get('permission')).toBe(severity);
  });
});

describe('ChatStatusSection — lineHidden', () => {
  beforeEach(() => {
    sessionOn('claude-code');
    harness.status.StatusLine = ({ trailing }: { trailing?: React.ReactNode }) => (
      <div data-testid="status-line">{trailing}</div>
    );
    harness.status.UsageRevealPopover = () => <div data-testid="usage-reveal" />;
    harness.status.WifiTurnCapPill = () => <span data-testid="wifi-cap" />;
    harness.status.SessionPopover = ({ open }: { open: boolean }) => (
      <div data-testid="session-popover" data-open={String(open)} />
    );
    useSessionChatStore.setState({ sessions: {} });
  });

  it('draws the status line by default', () => {
    render(<ChatStatusSection {...props} />);
    expect(screen.getByTestId('status-line')).toBeInTheDocument();
  });

  it('draws no status line in a DM, and keeps what /context opens', () => {
    render(<ChatStatusSection {...props} lineHidden />);
    expect(screen.queryByTestId('status-line')).not.toBeInTheDocument();
    expect(screen.getByTestId('usage-reveal')).toBeInTheDocument();
  });

  it('keeps why every turn asks on Wi-Fi in view in a DM', () => {
    render(<ChatStatusSection {...props} lineHidden />);
    expect(screen.getByTestId('dm-safety-line')).toContainElement(screen.getByTestId('wifi-cap'));
  });

  it('warns of a nearly full context in a DM, with the way to compact it', () => {
    act(() => {
      useSessionChatStore.getState().updateSession(SESSION_ID, {
        contextUsage: {
          totalTokens: 174_000,
          maxTokens: 200_000,
          percentage: 87,
          model: 'claude-opus-4-6',
          categories: [],
        },
      });
    });
    render(<ChatStatusSection {...props} lineHidden />);

    expect(screen.getByTestId('dm-compact-warning')).toHaveTextContent('Context 87% full');
    fireEvent.click(screen.getByRole('button', { name: 'Compact chat' }));
    expect(harness.transport.runCommandIntent).toHaveBeenCalledWith(
      SESSION_ID,
      'compact',
      undefined
    );
  });

  it('ignores the session shortcut in a DM, so nothing opens later on its own', () => {
    const { rerender } = render(<ChatStatusSection {...props} lineHidden />);
    fireEvent.keyDown(document, { key: '.', metaKey: true, shiftKey: true });
    rerender(<ChatStatusSection {...props} />);
    expect(screen.getByTestId('session-popover')).toHaveAttribute('data-open', 'false');

    fireEvent.keyDown(document, { key: '.', metaKey: true, shiftKey: true });
    expect(screen.getByTestId('session-popover')).toHaveAttribute('data-open', 'true');
  });
});
