// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { MessagePart } from '@dorkos/shared/types';
import type { ChatMessage, TransportErrorInfo } from '../model/chat-types';
import { shouldShowTurnFailedNotice } from '../model/stream/turn-failure';
import { TurnFailedNotice } from '../ui/status/TurnFailedNotice';

afterEach(cleanup);

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
    render(<TurnFailedNotice onRetry={onRetry} />);

    expect(screen.getByTestId('turn-failed-notice')).toBeInTheDocument();
    expect(screen.getByText('Agent stopped unexpectedly')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders without a Retry button when there is nothing to resend', () => {
    render(<TurnFailedNotice />);

    expect(screen.getByTestId('turn-failed-notice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });
});
