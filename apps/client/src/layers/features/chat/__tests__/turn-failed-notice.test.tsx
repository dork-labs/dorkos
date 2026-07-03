// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { MessagePart } from '@dorkos/shared/types';
import type { ChatMessage, TransportErrorInfo } from '../model/chat-types';

// The notice resolves the session's runtime from the session-list row to name
// it in the failure copy. Controllable per test; undefined = no row yet.
const mockSessionRuntime = vi.fn<() => string | undefined>(() => undefined);
vi.mock('@/layers/entities/session', () => ({
  useSessionRuntime: () => mockSessionRuntime(),
}));

import { shouldShowTurnFailedNotice } from '../model/stream/turn-failure';
import { TurnFailedNotice } from '../ui/status/TurnFailedNotice';

afterEach(() => {
  cleanup();
  mockSessionRuntime.mockReturnValue(undefined);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function msg(role: 'user' | 'assistant', parts: MessagePart[] = [], id = 'm'): ChatMessage {
  return {
    id: `${id}-${role}-${parts.length}`,
    role,
    content: '',
    parts,
    timestamp: new Date().toISOString(),
  };
}

const errorPart: MessagePart = {
  type: 'error',
  message: 'boom',
  category: 'execution_error',
} as MessagePart;

const transportError: TransportErrorInfo = {
  heading: 'Connection failed',
  message: 'offline',
  retryable: true,
};

// ---------------------------------------------------------------------------
// shouldShowTurnFailedNotice
// ---------------------------------------------------------------------------

describe('shouldShowTurnFailedNotice', () => {
  it('is false unless the rendered status is error', () => {
    expect(shouldShowTurnFailedNotice('idle', null, [msg('user')])).toBe(false);
    expect(shouldShowTurnFailedNotice('streaming', null, [msg('user')])).toBe(false);
  });

  it('is true when a turn fails with no other error surface visible', () => {
    const messages = [msg('user', [], 'a'), msg('assistant', [], 'b')];
    expect(shouldShowTurnFailedNotice('error', null, messages)).toBe(true);
  });

  it('is true when the failed turn produced no assistant message at all', () => {
    expect(shouldShowTurnFailedNotice('error', null, [msg('user')])).toBe(true);
    expect(shouldShowTurnFailedNotice('error', null, [])).toBe(true);
  });

  it('is suppressed while the transport-error banner is showing', () => {
    expect(shouldShowTurnFailedNotice('error', transportError, [msg('user')])).toBe(false);
  });

  it('is suppressed when the failed turn already rendered an inline error part', () => {
    const messages = [msg('user', [], 'a'), msg('assistant', [errorPart], 'b')];
    expect(shouldShowTurnFailedNotice('error', null, messages)).toBe(false);
  });

  it('is NOT suppressed by error parts from earlier turns', () => {
    const messages = [
      msg('user', [], 'a'),
      msg('assistant', [errorPart], 'b'),
      msg('user', [], 'c'),
      msg('assistant', [], 'd'),
    ];
    expect(shouldShowTurnFailedNotice('error', null, messages)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TurnFailedNotice
// ---------------------------------------------------------------------------

describe('TurnFailedNotice', () => {
  it('renders the failure copy with a working Retry button', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<TurnFailedNotice sessionId="s1" onRetry={onRetry} />);

    expect(screen.getByTestId('turn-failed-notice')).toBeInTheDocument();
    expect(screen.getByText('Agent stopped unexpectedly')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders without a Retry button when there is nothing to resend', () => {
    render(<TurnFailedNotice sessionId="s1" />);

    expect(screen.getByTestId('turn-failed-notice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('names the runtime in the heading for a Codex session', () => {
    mockSessionRuntime.mockReturnValue('codex');
    render(<TurnFailedNotice sessionId="s-codex" />);

    expect(screen.getByText('Codex stopped unexpectedly')).toBeInTheDocument();
    expect(screen.getByText('The turn ended before completing.')).toBeInTheDocument();
    expect(screen.queryByText('Agent stopped unexpectedly')).not.toBeInTheDocument();
  });

  it('names the runtime in the heading for an OpenCode session', () => {
    mockSessionRuntime.mockReturnValue('opencode');
    render(<TurnFailedNotice sessionId="s-oc" />);

    expect(screen.getByText('OpenCode stopped unexpectedly')).toBeInTheDocument();
  });

  it('names the runtime in the heading for a Claude Code session', () => {
    mockSessionRuntime.mockReturnValue('claude-code');
    render(<TurnFailedNotice sessionId="s-cc" />);

    expect(screen.getByText('Claude Code stopped unexpectedly')).toBeInTheDocument();
  });

  it('falls back to the runtime-neutral heading when the session row is not listed yet', () => {
    mockSessionRuntime.mockReturnValue(undefined);
    render(<TurnFailedNotice sessionId="s-new" />);

    expect(screen.getByText('Agent stopped unexpectedly')).toBeInTheDocument();
  });
});
