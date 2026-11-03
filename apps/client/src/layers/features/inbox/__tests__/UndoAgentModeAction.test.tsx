/**
 * The Undo on an agent's schedule mode notice (DOR-3703): drawn only where the
 * notice offers it, it asks the server to put the old mode back, and says on
 * the button whether that worked.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { createTestQueryClient } from '@dorkos/test-utils/react-helpers';
import { TransportProvider } from '@/layers/shared/model';
import { InboxRow } from '../ui/InboxRow';

afterEach(cleanup);

const MODE_NOTICE: NotificationDTO = {
  id: '01JZR0000000000000000009',
  kind: 'schedule.armed_by_agent',
  tier: 'notable',
  subject: { type: 'task', id: 'task-1' },
  title: 'a set nightly-sweep to Bypass permissions',
  body: 'Was Accept edits. Started by you.',
  actions: [
    { id: 'undo-mode', label: 'Undo', style: 'neutral' },
    { id: 'open', label: 'Open', style: 'primary' },
  ],
  createdAt: new Date().toISOString(),
};

function renderRow(notification: NotificationDTO, overrides: Partial<Transport> = {}) {
  const transport = createMockTransport(overrides);
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <TransportProvider transport={transport}>
        <InboxRow notification={notification} onOpen={() => {}} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('Undo on an agent’s schedule mode notice', () => {
  it('puts the old mode back for this schedule, and says it did', async () => {
    const undo = vi.fn().mockResolvedValue({ id: 'task-1' });
    renderRow(MODE_NOTICE, { undoAgentTaskMode: undo });

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: 'Undone' })).toBeDisabled();
    expect(undo).toHaveBeenCalledWith('task-1', '01JZR0000000000000000009');
  });

  it('refused: the button goes, the reason fills the notice, and focus moves to its link (M9)', async () => {
    renderRow(MODE_NOTICE, {
      // As the transport throws a 409: the headline as the message, the body beside it.
      undoAgentTaskMode: vi.fn().mockRejectedValue(
        Object.assign(new Error('Nothing to undo'), {
          status: 409,
          code: 'nothing_to_undo',
          body: {
            error: 'Nothing to undo',
            code: 'nothing_to_undo',
            message: 'Not undone: this task changed since this notice. It now runs as Default.',
          },
        })
      ),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(
      'Not undone: this task changed since this notice. It now runs as Default. Open it to check.'
    );
    expect(status.className).toContain('basis-full');
    const link = screen.getByRole('button', { name: 'Open it to check.' });
    await waitFor(() => expect(link).toHaveFocus());
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
    expect(screen.queryByText(/^Nothing to undo/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Undo puts that back/);
  });

  it.each([
    ['with Undo', MODE_NOTICE],
    ['with no action, like a capped-file notice', { ...MODE_NOTICE, actions: [] }],
  ])('reads in full %s: neither title nor body is ever cut off', (_label, notice) => {
    renderRow(notice);
    for (const slot of ['inbox-row-title', 'inbox-row-body']) {
      const classes = document.querySelector(`[data-slot="${slot}"]`)!.className.split(/\s+/);
      expect(classes).toContain('break-words');
      expect(classes.some((c) => /(^|:)(truncate|line-clamp-\d+)$/.test(c))).toBe(false);
    }
    expect(screen.getByText('Was Accept edits. Started by you.')).toBeInTheDocument();
  });

  it('is not drawn on a notice that does not offer it', () => {
    renderRow({ ...MODE_NOTICE, actions: [{ id: 'pause', label: 'Pause', style: 'neutral' }] });
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});
