// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Info } from 'lucide-react';
import { DEFAULT_THEME } from '../ui/status/inference-themes';
import { ChatStatusStrip } from '../ui/status/ChatStatusStrip';
import { deriveStripState, type StripStateInput } from '../ui/status/strip-state';

afterEach(() => {
  cleanup();
});

// Mock hooks to control their output in component tests
vi.mock('@/layers/shared/model', () => ({
  useElapsedTime: vi.fn(() => ({ formatted: '2m 14s', ms: 134000 })),
}));

// ---------------------------------------------------------------------------
// Group 1: deriveStripState() pure function tests
// ---------------------------------------------------------------------------

describe('deriveStripState', () => {
  const baseInput: StripStateInput = {
    status: 'idle',
    isWaitingForUser: false,
    waitingType: 'approval',
    operationProgress: null,
    systemStatus: null,
    elapsed: '0m 00s',
    activity: null,
    tokens: '~0 tokens',
    theme: DEFAULT_THEME,
    isBypass: false,
    showComplete: false,
    lastElapsed: '0m 32s',
    lastTokens: '~12.3k tokens',
  };

  it('returns idle when no active status', () => {
    expect(deriveStripState(baseInput).type).toBe('idle');
  });

  it('returns streaming when status is streaming', () => {
    const state = deriveStripState({ ...baseInput, status: 'streaming' });
    expect(state.type).toBe('streaming');
  });

  it('says what the session is doing when the fleet reading names a tool', () => {
    // Purpose: the strip's whole point after DOR-1053 — the verb is the tool
    // the session actually started, not a phrase drawn from a hat.
    const state = deriveStripState({
      ...baseInput,
      status: 'streaming',
      activity: { toolName: 'Bash', target: 'pnpm verify' },
    });
    if (state.type === 'streaming') {
      expect(state.verb).toBe('Running pnpm verify…');
      expect(state.tokens).toBe('~0 tokens');
      expect(state.elapsed).toBe('0m 00s');
      expect(state.icon).toBe(DEFAULT_THEME.icon);
      expect(state.iconAnimation).toBe(DEFAULT_THEME.iconAnimation);
      expect(state.isBypass).toBe(false);
    }
  });

  it('says only "Working…" when no tool is known', () => {
    // Purpose: a streaming lifecycle on its own supports nothing more specific
    // — before the first tool of a turn, between tools, or on a runtime that
    // reports none. The strip must not fill that gap with something invented.
    const state = deriveStripState({ ...baseInput, status: 'streaming', activity: null });
    if (state.type === 'streaming') expect(state.verb).toBe('Working…');
  });

  it('degrades to the server it is talking to for an unrecognized MCP tool', () => {
    const state = deriveStripState({
      ...baseInput,
      status: 'streaming',
      activity: { toolName: 'mcp__slack__post_message' },
    });
    if (state.type === 'streaming') expect(state.verb).toBe('Using Slack…');
  });

  it('keys the crossfade on the label, so it animates only when the label changes', () => {
    // Purpose: the strip crossfades on `verbKey`. Keyed on anything that moves
    // per render, a settled label would flicker on every token delta.
    const activity = { toolName: 'Edit', target: 'router.tsx' };
    const first = deriveStripState({ ...baseInput, status: 'streaming', activity });
    const again = deriveStripState({
      ...baseInput,
      status: 'streaming',
      activity: { ...activity },
      elapsed: '0m 04s',
    });
    const other = deriveStripState({
      ...baseInput,
      status: 'streaming',
      activity: { toolName: 'Edit', target: 'index.ts' },
    });
    if (first.type === 'streaming' && again.type === 'streaming' && other.type === 'streaming') {
      expect(again.verbKey).toBe(first.verbKey);
      expect(other.verbKey).not.toBe(first.verbKey);
    }
  });

  it('uses the skull icon for as long as permissions are bypassed', () => {
    // Purpose: the bypass warning used to ride the joke verb pool, so it
    // appeared only when the rotation happened to land on one. It is a standing
    // fact about the session, and now shows for the whole of it.
    const state = deriveStripState({ ...baseInput, status: 'streaming', isBypass: true });
    if (state.type === 'streaming') {
      expect(state.icon).toBe('☠');
      expect(state.iconAnimation).toBeNull();
    }
  });

  it('waiting takes priority over operation-progress (priority 1 > 2)', () => {
    const state = deriveStripState({
      ...baseInput,
      status: 'streaming',
      isWaitingForUser: true,
      operationProgress: {
        operation: 'compaction',
        determinate: false,
        message: 'Compacting context…',
      },
    });
    expect(state.type).toBe('waiting');
  });

  it('waiting includes waitingType and elapsed', () => {
    const state = deriveStripState({
      ...baseInput,
      status: 'streaming',
      isWaitingForUser: true,
      waitingType: 'question',
      elapsed: '3m 10s',
    });
    if (state.type === 'waiting') {
      expect(state.waitingType).toBe('question');
      expect(state.elapsed).toBe('3m 10s');
    }
  });

  it('operation-progress takes priority over system-message (priority 2 > 3)', () => {
    const state = deriveStripState({
      ...baseInput,
      status: 'streaming',
      operationProgress: {
        operation: 'compaction',
        determinate: false,
        message: 'Compacting context…',
      },
      systemStatus: { message: 'Running hook "format"…' },
    });
    expect(state.type).toBe('operation-progress');
  });

  it('operation-progress carries the producer message and indeterminate flag', () => {
    const state = deriveStripState({
      ...baseInput,
      status: 'streaming',
      operationProgress: {
        operation: 'compaction',
        determinate: false,
        message: 'Compacting context…',
      },
    });
    if (state.type === 'operation-progress') {
      expect(state.message).toBe('Compacting context…');
      expect(state.determinate).toBe(false);
      expect(state.percent).toBeNull();
    }
  });

  it('operation-progress carries a determinate percent when present', () => {
    const state = deriveStripState({
      ...baseInput,
      status: 'streaming',
      operationProgress: {
        operation: 'compaction',
        determinate: true,
        percent: 42,
        message: 'Compacting context…',
      },
    });
    if (state.type === 'operation-progress') {
      expect(state.determinate).toBe(true);
      expect(state.percent).toBe(42);
    }
  });

  it('system message takes priority over streaming (priority 3 > 4)', () => {
    const state = deriveStripState({
      ...baseInput,
      status: 'streaming',
      systemStatus: { message: 'Running hook "format"…' },
    });
    expect(state.type).toBe('system-message');
  });

  it('system message includes the message and the Info icon', () => {
    const state = deriveStripState({
      ...baseInput,
      status: 'streaming',
      systemStatus: { message: 'Running hook "format"…' },
    });
    if (state.type === 'system-message') {
      expect(state.message).toBe('Running hook "format"…');
      expect(state.icon).toBe(Info);
    }
  });

  it('system message shown even when not streaming', () => {
    const state = deriveStripState({
      ...baseInput,
      status: 'idle',
      systemStatus: { message: 'Running hook "lint"…' },
    });
    expect(state.type).toBe('system-message');
  });

  it('returns complete when showComplete is true', () => {
    const state = deriveStripState({ ...baseInput, showComplete: true });
    expect(state.type).toBe('complete');
    if (state.type === 'complete') {
      expect(state.elapsed).toBe('0m 32s');
      expect(state.tokens).toBe('~12.3k tokens');
    }
  });

  it('streaming takes priority over complete (priority 4 > 5)', () => {
    const state = deriveStripState({
      ...baseInput,
      status: 'streaming',
      showComplete: true,
    });
    expect(state.type).toBe('streaming');
  });

  it('returns idle for error status with no other conditions', () => {
    const state = deriveStripState({ ...baseInput, status: 'error' });
    expect(state.type).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Group 2: ChatStatusStrip component rendering tests
// ---------------------------------------------------------------------------

describe('ChatStatusStrip component', () => {
  it('renders nothing visible when idle (height 0 container exists)', () => {
    const { container } = render(
      <ChatStatusStrip
        status="idle"
        streamStartTime={null}
        estimatedTokens={0}
        systemStatus={null}
      />
    );
    // The outer motion.div exists but should animate to height 0
    expect(container.firstChild).toBeTruthy();
    expect(screen.queryByTestId('chat-status-strip-streaming')).not.toBeInTheDocument();
  });

  it('renders streaming content with the live activity, elapsed, and tokens', () => {
    render(
      <ChatStatusStrip
        status="streaming"
        streamStartTime={Date.now()}
        estimatedTokens={3200}
        activity={{ toolName: 'Edit', target: 'router.tsx' }}
        systemStatus={null}
      />
    );
    expect(screen.getByTestId('chat-status-strip-streaming')).toBeInTheDocument();
    expect(screen.getByText('Editing router.tsx…')).toBeInTheDocument();
    expect(screen.getByText('2m 14s')).toBeInTheDocument();
    expect(screen.getByText('~3.2k tokens')).toBeInTheDocument();
  });

  it('falls back to "Working…" with no activity to show', () => {
    render(
      <ChatStatusStrip
        status="streaming"
        streamStartTime={Date.now()}
        estimatedTokens={0}
        systemStatus={null}
      />
    );
    expect(screen.getByTestId('chat-status-strip-streaming')).toHaveTextContent('Working…');
  });

  it('renders waiting state with Shield icon for approval', () => {
    render(
      <ChatStatusStrip
        status="streaming"
        streamStartTime={Date.now()}
        estimatedTokens={100}
        isWaitingForUser={true}
        waitingType="approval"
        systemStatus={null}
      />
    );
    expect(screen.getByTestId('chat-status-strip-waiting')).toBeInTheDocument();
    expect(screen.getByText('Waiting for your approval')).toBeInTheDocument();
  });

  it('renders waiting state with MessageSquare icon for question', () => {
    render(
      <ChatStatusStrip
        status="streaming"
        streamStartTime={Date.now()}
        estimatedTokens={100}
        isWaitingForUser={true}
        waitingType="question"
        systemStatus={null}
      />
    );
    expect(screen.getByTestId('chat-status-strip-waiting')).toBeInTheDocument();
    expect(screen.getByText('Waiting for your answer')).toBeInTheDocument();
  });

  it('renders an indeterminate operation-progress bar for compaction (DOR-110)', () => {
    render(
      <ChatStatusStrip
        status="streaming"
        streamStartTime={Date.now()}
        estimatedTokens={0}
        systemStatus={null}
        operationProgress={{
          operation: 'compaction',
          determinate: false,
          message: 'Compacting context…',
        }}
      />
    );
    const bar = screen.getByTestId('chat-status-strip-operation-progress');
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveAttribute('data-determinate', 'false');
    expect(bar).toHaveTextContent('Compacting context…');
  });

  it('renders a determinate operation-progress bar when a percent is present', () => {
    render(
      <ChatStatusStrip
        status="streaming"
        streamStartTime={Date.now()}
        estimatedTokens={0}
        systemStatus={null}
        operationProgress={{
          operation: 'compaction',
          determinate: true,
          percent: 65,
          message: 'Compacting context…',
        }}
      />
    );
    const bar = screen.getByTestId('chat-status-strip-operation-progress');
    expect(bar).toHaveAttribute('data-determinate', 'true');
  });

  it('renders a session hook message in the strip (DOR-125)', () => {
    // Hooks are the real non-operation state the strip surfaces. ('requesting'
    // is never forwarded — the activity label owns the thinking phase.)
    render(
      <ChatStatusStrip
        status="streaming"
        streamStartTime={Date.now()}
        estimatedTokens={0}
        systemStatus={{ message: 'Running hook "format"...' }}
      />
    );
    expect(screen.getByTestId('chat-status-strip-system-message')).toHaveTextContent(
      'Running hook "format"...'
    );
  });
});

// ---------------------------------------------------------------------------
// Group 2b: the strip announces itself
// ---------------------------------------------------------------------------

describe('ChatStatusStrip announcements', () => {
  it('is a polite live region, so a state change reaches someone who cannot see it', () => {
    const { container } = render(
      <ChatStatusStrip
        status="streaming"
        streamStartTime={Date.now()}
        estimatedTokens={0}
        isWaitingForUser
        waitingType="approval"
        systemStatus={null}
      />
    );
    expect(container.firstElementChild).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('Waiting for your approval')).toBeInTheDocument();
  });

  it('hides everything that ticks, so the churn is not announced with it', () => {
    // A live region that re-reads the activity label every few seconds — or the
    // elapsed clock every second — is worse than silence. One stable sentence
    // announces the state instead.
    render(
      <ChatStatusStrip
        status="streaming"
        streamStartTime={Date.now()}
        estimatedTokens={3200}
        systemStatus={null}
      />
    );
    const row = screen.getByTestId('chat-status-strip-streaming');
    expect(row).toHaveTextContent('Working');
    for (const churning of ['2m 14s', '~3.2k tokens']) {
      expect(screen.getByText(churning).closest('[aria-hidden="true"]')).not.toBeNull();
    }
  });

  it('keeps the waiting clock out of the announcement but the message in it', () => {
    render(
      <ChatStatusStrip
        status="streaming"
        streamStartTime={Date.now()}
        estimatedTokens={0}
        isWaitingForUser
        systemStatus={null}
      />
    );
    expect(screen.getByText('Waiting for your approval')).not.toHaveAttribute('aria-hidden');
    expect(screen.getByText('2m 14s')).toHaveAttribute('aria-hidden', 'true');
  });
});

// ---------------------------------------------------------------------------
// Group 3: Lifecycle tests
// ---------------------------------------------------------------------------

describe('ChatStatusStrip lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows complete state after streaming ends with tokens', () => {
    const { rerender } = render(
      <ChatStatusStrip
        status="streaming"
        streamStartTime={Date.now()}
        estimatedTokens={3200}
        systemStatus={null}
      />
    );

    act(() => {
      rerender(
        <ChatStatusStrip
          status="idle"
          streamStartTime={null}
          estimatedTokens={3200}
          systemStatus={null}
        />
      );
    });

    expect(screen.getByTestId('chat-status-strip-complete')).toBeInTheDocument();
  });

  it('auto-dismisses complete state after 8 seconds', () => {
    const { rerender } = render(
      <ChatStatusStrip
        status="streaming"
        streamStartTime={Date.now()}
        estimatedTokens={3200}
        systemStatus={null}
      />
    );

    act(() => {
      rerender(
        <ChatStatusStrip
          status="idle"
          streamStartTime={null}
          estimatedTokens={3200}
          systemStatus={null}
        />
      );
    });

    expect(screen.getByTestId('chat-status-strip-complete')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(8000);
    });

    expect(screen.queryByTestId('chat-status-strip-complete')).not.toBeInTheDocument();
  });
});
