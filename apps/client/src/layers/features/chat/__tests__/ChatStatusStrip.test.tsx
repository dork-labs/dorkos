// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Info } from 'lucide-react';
import { DEFAULT_THEME } from '../ui/status/inference-themes';
import {
  deriveStripState,
  ChatStatusStrip,
  type StripStateInput,
} from '../ui/status/ChatStatusStrip';

afterEach(() => {
  cleanup();
});

// Mock hooks to control their output in component tests
vi.mock('@/layers/shared/model', () => ({
  useElapsedTime: vi.fn(() => ({ formatted: '2m 14s', ms: 134000 })),
}));

vi.mock('../model/use-rotating-verb', () => ({
  useRotatingVerb: vi.fn(() => ({ verb: "Droppin' Science", key: 'verb-0' })),
}));

// ---------------------------------------------------------------------------
// Group 1: deriveStripState() pure function tests
// ---------------------------------------------------------------------------

describe('deriveStripState', () => {
  const baseInput: StripStateInput = {
    status: 'idle',
    isRateLimited: false,
    countdown: null,
    isWaitingForUser: false,
    waitingType: 'approval',
    operationProgress: null,
    systemStatus: null,
    elapsed: '0m 00s',
    verb: 'Thinking',
    verbKey: 'verb-0',
    tokens: '~0 tokens',
    theme: DEFAULT_THEME,
    isBypassVerb: false,
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

  it('returns streaming state with correct verb and tokens', () => {
    const state = deriveStripState({ ...baseInput, status: 'streaming' });
    if (state.type === 'streaming') {
      expect(state.verb).toBe('Thinking');
      expect(state.tokens).toBe('~0 tokens');
      expect(state.elapsed).toBe('0m 00s');
      expect(state.icon).toBe(DEFAULT_THEME.icon);
      expect(state.iconAnimation).toBe(DEFAULT_THEME.iconAnimation);
      expect(state.isBypassVerb).toBe(false);
    }
  });

  it('uses skull icon and no animation for bypass verbs', () => {
    const state = deriveStripState({ ...baseInput, status: 'streaming', isBypassVerb: true });
    if (state.type === 'streaming') {
      expect(state.icon).toBe('☠');
      expect(state.iconAnimation).toBeNull();
    }
  });

  it('rate-limited takes priority over waiting (priority 1 > 2)', () => {
    const state = deriveStripState({
      ...baseInput,
      status: 'streaming',
      isRateLimited: true,
      isWaitingForUser: true,
    });
    expect(state.type).toBe('rate-limited');
  });

  it('rate-limited includes countdown and elapsed', () => {
    const state = deriveStripState({
      ...baseInput,
      status: 'streaming',
      isRateLimited: true,
      countdown: 30,
      elapsed: '1m 05s',
    });
    if (state.type === 'rate-limited') {
      expect(state.countdown).toBe(30);
      expect(state.elapsed).toBe('1m 05s');
    }
  });

  it('waiting takes priority over operation-progress (priority 2 > 3)', () => {
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

  it('operation-progress takes priority over system-message (priority 3 > 4)', () => {
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

  it('system message takes priority over streaming (priority 4 > 5)', () => {
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

  it('streaming takes priority over complete (priority 5 > 6)', () => {
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

  it('renders streaming content with verb, elapsed, and tokens', () => {
    render(
      <ChatStatusStrip
        status="streaming"
        streamStartTime={Date.now()}
        estimatedTokens={3200}
        systemStatus={null}
      />
    );
    expect(screen.getByTestId('chat-status-strip-streaming')).toBeInTheDocument();
    expect(screen.getByText("Droppin' Science")).toBeInTheDocument();
    expect(screen.getByText('2m 14s')).toBeInTheDocument();
    expect(screen.getByText('~3.2k tokens')).toBeInTheDocument();
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

  it('renders rate-limited state with countdown', () => {
    render(
      <ChatStatusStrip
        status="streaming"
        streamStartTime={Date.now()}
        estimatedTokens={100}
        isRateLimited={true}
        rateLimitRetryAfter={30}
        systemStatus={null}
      />
    );
    expect(screen.getByTestId('chat-status-strip-rate-limited')).toBeInTheDocument();
    expect(screen.getByText(/Rate limited.*retrying in 30s/)).toBeInTheDocument();
  });

  it('renders rate-limited state without countdown when retryAfter is null', () => {
    render(
      <ChatStatusStrip
        status="streaming"
        streamStartTime={Date.now()}
        estimatedTokens={100}
        isRateLimited={true}
        rateLimitRetryAfter={null}
        systemStatus={null}
      />
    );
    expect(screen.getByTestId('chat-status-strip-rate-limited')).toBeInTheDocument();
    expect(screen.getByText(/Rate limited.*retrying shortly/)).toBeInTheDocument();
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
    // is never forwarded — the rotating verb owns the thinking phase.)
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
