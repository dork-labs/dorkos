// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Info, RefreshCw, Shield } from 'lucide-react';
import { DEFAULT_THEME } from '../ui/status/inference-themes';
import {
  deriveStripState,
  deriveSystemIcon,
  deriveStatusCopy,
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
      expect(state.icon).toBe('\u2620');
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

  it('waiting takes priority over system message (priority 2 > 3)', () => {
    const state = deriveStripState({
      ...baseInput,
      status: 'streaming',
      isWaitingForUser: true,
      systemStatus: { message: 'Compacting context...', status: null },
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

  it('system message takes priority over streaming (priority 3 > 4)', () => {
    const state = deriveStripState({
      ...baseInput,
      status: 'streaming',
      systemStatus: { message: 'Compacting context...', status: null },
    });
    expect(state.type).toBe('system-message');
  });

  it('system message includes message and icon', () => {
    const state = deriveStripState({
      ...baseInput,
      status: 'streaming',
      systemStatus: { message: 'Compacting context...', status: null },
    });
    if (state.type === 'system-message') {
      expect(state.message).toBe('Compacting context...');
      expect(state.icon).toBe(RefreshCw);
    }
  });

  it('system message shown even when not streaming', () => {
    const state = deriveStripState({
      ...baseInput,
      status: 'idle',
      systemStatus: { message: 'Permission mode changed', status: null },
    });
    expect(state.type).toBe('system-message');
  });

  it('does not map "requesting" \u2014 falls back to raw message (Thinking is the verb, DOR-125)', () => {
    const state = deriveStripState({
      ...baseInput,
      systemStatus: { message: 'Status: requesting', status: 'requesting' },
    });
    expect(state.type).toBe('system-message');
    if (state.type === 'system-message') {
      expect(state.message).toBe('Status: requesting');
    }
  });

  it('uses compacting copy when status is compacting', () => {
    const state = deriveStripState({
      ...baseInput,
      systemStatus: { message: 'Status: compacting', status: 'compacting' },
    });
    expect(state.type).toBe('system-message');
    if (state.type === 'system-message') {
      expect(state.message).toBe('Compacting context\u2026');
      // icon is still keyed on the final rendered string, so "compacting" hits RefreshCw
      expect(state.icon).toBe(RefreshCw);
    }
  });

  it('falls back to raw message when status is unknown', () => {
    const state = deriveStripState({
      ...baseInput,
      systemStatus: { message: 'Reading knowledge files…', status: null },
    });
    expect(state.type).toBe('system-message');
    if (state.type === 'system-message') {
      expect(state.message).toBe('Reading knowledge files…');
    }
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
// Group 2: deriveSystemIcon() tests
// ---------------------------------------------------------------------------

describe('deriveSystemIcon', () => {
  it('returns RefreshCw for compact messages', () => {
    expect(deriveSystemIcon('Compacting context...')).toBe(RefreshCw);
  });

  it('returns RefreshCw for uppercase compact messages', () => {
    expect(deriveSystemIcon('COMPACT OPERATION IN PROGRESS')).toBe(RefreshCw);
  });

  it('returns Shield for permission messages', () => {
    expect(deriveSystemIcon('Permission mode changed')).toBe(Shield);
  });

  it('returns Info for unknown messages', () => {
    expect(deriveSystemIcon('Some other status')).toBe(Info);
  });

  it('returns Info for empty string', () => {
    expect(deriveSystemIcon('')).toBe(Info);
  });
});

// ---------------------------------------------------------------------------
// Group 3: deriveStatusCopy() tests
// ---------------------------------------------------------------------------

describe('deriveStatusCopy', () => {
  it('returns null for requesting — Thinking is the rotating verb, not the strip (DOR-125)', () => {
    expect(deriveStatusCopy('requesting')).toBeNull();
  });

  it('returns "Compacting context…" for compacting', () => {
    expect(deriveStatusCopy('compacting')).toBe('Compacting context\u2026');
  });

  it('returns null for unknown status (forward-compat)', () => {
    expect(deriveStatusCopy('tool_waiting')).toBeNull();
  });

  it('returns null for null', () => {
    expect(deriveStatusCopy(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(deriveStatusCopy(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Group 4: ChatStatusStrip component rendering tests
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

  it('renders system message with contextual icon', () => {
    render(
      <ChatStatusStrip
        status="idle"
        streamStartTime={null}
        estimatedTokens={0}
        systemStatus={{ message: 'Compacting context...', status: null }}
      />
    );
    expect(screen.getByTestId('chat-status-strip-system-message')).toBeInTheDocument();
    expect(screen.getByText('Compacting context...')).toBeInTheDocument();
  });

  it('renders a session hook message in the strip (DOR-125)', () => {
    // Hooks are the real non-compaction state the strip surfaces. ('requesting'
    // is never forwarded — the rotating verb owns the thinking phase.)
    render(
      <ChatStatusStrip
        status="streaming"
        streamStartTime={Date.now()}
        estimatedTokens={0}
        systemStatus={{ message: 'Running hook "format"...', status: null }}
      />
    );
    expect(screen.getByTestId('chat-status-strip-system-message')).toHaveTextContent(
      'Running hook "format"...'
    );
  });
});

// ---------------------------------------------------------------------------
// Group 5: Lifecycle tests
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
