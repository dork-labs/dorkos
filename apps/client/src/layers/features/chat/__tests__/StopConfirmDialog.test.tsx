/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StopConfirmDialog } from '../ui/input/StopConfirmDialog';

/** Open the dialog with the given counts. */
function open(queuedCount: number, fromChatCount?: number) {
  render(
    <StopConfirmDialog
      open
      onOpenChange={() => undefined}
      queuedCount={queuedCount}
      {...(fromChatCount !== undefined ? { fromChatCount } : {})}
      onConfirm={() => undefined}
    />
  );
}

// DOR-3060: Stop hands back only the person's words. Other chats' messages are
// cancelled, and the dialog says so rather than promising to put them back.
describe('StopConfirmDialog', () => {
  it('promises back only the person’s own messages, and names the rest as cancelled', () => {
    open(1, 2);
    expect(screen.getByText('Stop, and put 1 queued message back?')).toBeTruthy();
    expect(screen.getByText('2 from other chats are cancelled.')).toBeTruthy();
  });

  it('asks about cancelling when only other chats’ messages wait', () => {
    open(0, 1);
    expect(screen.getByText('Stop, and cancel 1 message from other chats?')).toBeTruthy();
    expect(screen.getByText('The agent stops. Those messages are not delivered.')).toBeTruthy();
  });

  it('reads as before when only the person’s messages wait', () => {
    open(2);
    expect(screen.getByText('Stop, and put 2 queued messages back?')).toBeTruthy();
    expect(screen.queryByText(/from other chats/)).toBeNull();
  });
});
