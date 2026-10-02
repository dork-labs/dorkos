/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { WidgetDocument } from '@dorkos/shared/ui-widget';
import type { CanvasChannelEventReceipt, PageEvent } from '@dorkos/shared/canvas-channel-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { WidgetRenderer } from '../ui/WidgetRenderer';
import type { WidgetChannelPort } from '../model/widget-channel';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
const transport = createMockTransport();
const document: WidgetDocument = {
  version: 1,
  title: 'Tasks',
  root: {
    type: 'stack',
    direction: 'vertical',
    children: [
      {
        type: 'button',
        label: 'One',
        action: { kind: 'emit', type: 'task.changed', payload: { task: 'one' } },
      },
      {
        type: 'button',
        label: 'Two',
        action: { kind: 'emit', type: 'task.changed', payload: { task: 'two' } },
      },
    ],
  },
};
function receipt(
  event: PageEvent,
  status: CanvasChannelEventReceipt['deliveries'][number]['status'] = 'waiting'
): CanvasChannelEventReceipt {
  return {
    receipt: { id: event.id, status: 'recorded', docSeq: 1 },
    deliveries: [
      {
        eventId: event.id,
        routeId: 'tasks',
        batchId: 'batch',
        status,
        turnId: null,
        reason: null,
        updatedAt: new Date().toISOString(),
      },
    ],
  };
}
function port(): WidgetChannelPort {
  return {
    documentId: 'doc-one',
    enabled: true,
    destinationLabel: 'LifeOS',
    approvedEventTypes: ['widget.action'],
    snapshot: {
      state: {},
      stateRev: 0,
      receipts: [],
      retentionFloor: 1,
      receiptRetentionFloor: 1,
      resetRequired: false,
    },
    submit: (event) => transport.ingestCanvasEvent('doc-one', event),
    inspect: (id) => transport.getCanvasEventReceipt('doc-one', id),
  };
}
function draw(doc = document, channel = port()) {
  return render(
    <TransportProvider transport={transport}>
      <WidgetRenderer document={doc} sessionId="session" channel={channel} />
    </TransportProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  vi.mocked(transport.ingestCanvasEvent).mockImplementation(async (_id, event) => receipt(event));
  vi.mocked(transport.getCanvasEventReceipt).mockRejectedValue(
    Object.assign(new Error('Missing'), { status: 404 })
  );
});
afterEach(cleanup);
describe('native document widget actions', () => {
  it('freezes per-click host IDs and node metadata, enabling independent new clicks after acceptance', async () => {
    draw();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'One' }));
    await user.click(screen.getByRole('button', { name: 'One' }));
    await user.click(screen.getByRole('button', { name: 'Two' }));
    const inputs = vi.mocked(transport.ingestCanvasEvent).mock.calls.map((call) => call[1]);
    expect(new Set(inputs.map((input) => input.id)).size).toBe(3);
    expect(inputs[0].payload).toMatchObject({
      task: 'one',
      widget: { documentId: 'doc-one', nodeId: 'root.children.0', title: 'Tasks' },
    });
    expect(inputs[2].payload).toMatchObject({ widget: { nodeId: 'root.children.1' } });
    expect(transport.sendUiAction).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('widget-action-status')).toHaveLength(3);
  });
  it('blocks only the unaccepted control, preserves the exact envelope on a network retry', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('Offline'));
    draw();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'One' }));
    expect(screen.getByRole('button', { name: 'One' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Two' })).not.toBeDisabled();
    const original = vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1];
    await user.click(screen.getByTestId('widget-action-retry'));
    expect(vi.mocked(transport.ingestCanvasEvent).mock.calls[1][1]).toEqual(original);
    expect(screen.getByRole('button', { name: 'One' })).not.toBeDisabled();
  });
  it('looks up uncertain acceptance first and never reposts an already recorded click', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('Response lost'));
    vi.mocked(transport.getCanvasEventReceipt).mockImplementation(async (_doc, id) =>
      receipt({ v: 1, id, type: 'task.changed', payload: {} })
    );
    draw();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'One' }));
    await user.click(screen.getByTestId('widget-action-retry'));
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'One' })).not.toBeDisabled();
  });
  it('refuses uncertain retry across a receipt floor', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('Offline'));
    const channel = port();
    const view = draw(document, channel);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'One' }));
    channel.snapshot = {
      state: {},
      stateRev: 1,
      receipts: [],
      retentionFloor: 4,
      receiptRetentionFloor: 4,
      resetRequired: true,
    };
    view.rerender(
      <TransportProvider transport={transport}>
        <WidgetRenderer document={document} channel={channel} />
      </TransportProvider>
    );
    await user.click(screen.getByTestId('widget-action-retry'));
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/saved history changed/)).toBeVisible();
    expect(screen.queryByTestId('widget-action-retry')).toBeNull();
  });
  it('never falls back to inline execution without an approved current normalization route', async () => {
    const doc: WidgetDocument = {
      version: 1,
      root: { type: 'button', label: 'Agent', action: { kind: 'agent', id: 'save' } },
    };
    const channel = { ...port(), approvedEventTypes: [] };
    const view = draw(doc, channel);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Agent' }));
    expect(transport.sendUiAction).not.toHaveBeenCalled();
    expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
    expect(screen.getByText(/approved document route/)).toBeVisible();
    view.rerender(
      <TransportProvider transport={transport}>
        <WidgetRenderer document={doc} channel={port()} />
      </TransportProvider>
    );
    await user.click(screen.getByRole('button', { name: 'Agent' }));
    expect(vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1]).toMatchObject({
      type: 'widget.action',
      payload: { actionId: 'save' },
    });
    expect(transport.sendUiAction).not.toHaveBeenCalled();
  });
  it.each([
    'pending',
    'turn_started',
    'turn_done',
    'failed',
    'expired',
    'in_doubt',
    'handled',
    'rejected',
  ] as const)('shows truthful %s without blocking another accepted click', async (status) => {
    vi.mocked(transport.ingestCanvasEvent).mockImplementation(async (_id, event) =>
      receipt(event, status)
    );
    draw();
    await userEvent.setup().click(screen.getByRole('button', { name: 'One' }));
    expect(screen.getByRole('button', { name: 'One' })).not.toBeDisabled();
    const text = screen.getByTestId('widget-action-status').textContent;
    const expected = {
      pending: 'Saved; waiting',
      turn_started: 'started working',
      turn_done: 'Handling is not confirmed',
      failed: 'request failed',
      expired: 'expired',
      in_doubt: 'outcome unknown',
      handled: 'reported that it handled',
      rejected: 'could not handle',
    };
    expect(text).toContain(expected[status]);
  });
  it('does not assume complete history when the original receipt floor was unknown', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('offline'));
    const channel = port();
    channel.snapshot = undefined;
    draw(document, channel);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'One' }));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/saved history changed/)).toBeVisible();
  });
  it('closes the same-tick double-click window before acceptance', async () => {
    let accept!: (value: CanvasChannelEventReceipt) => void;
    vi.mocked(transport.ingestCanvasEvent).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        })
    );
    draw();
    const button = screen.getByRole('button', { name: 'One' });
    act(() => {
      button.click();
      button.click();
    });
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    const event = vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1];
    await act(async () => accept(receipt(event)));
    expect(button).not.toBeDisabled();
  });
  it('rechecks the current history floor after a missing receipt lookup awaits', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('offline'));
    let missing!: (error: Error) => void;
    vi.mocked(transport.getCanvasEventReceipt).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          missing = reject;
        })
    );
    const channel = port();
    const view = draw(document, channel);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'One' }));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    view.rerender(
      <TransportProvider transport={transport}>
        <WidgetRenderer
          document={document}
          channel={{
            ...channel,
            snapshot: {
              state: {},
              stateRev: 1,
              receipts: [],
              retentionFloor: 9,
              receiptRetentionFloor: 9,
              resetRequired: true,
            },
          }}
        />
      </TransportProvider>
    );
    await act(async () => missing(Object.assign(new Error('missing'), { status: 404 })));
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/saved history changed/)).toBeVisible();
  });
  it('bounds the complete assembled envelope before any submission', async () => {
    const doc: WidgetDocument = {
      version: 1,
      root: {
        type: 'button',
        label: 'Large',
        action: { kind: 'emit', type: 'task.changed', payload: { text: 'x'.repeat(16_384) } },
      },
    };
    draw(doc);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Large' }));
    expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
    const { toast } = await import('sonner');
    expect(toast.error).toHaveBeenCalled();
  });
  it('does not resend an uncertain click through another document host', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('offline'));
    const channel = port();
    const view = draw(document, channel);
    await userEvent.setup().click(screen.getByRole('button', { name: 'One' }));
    channel.documentId = 'doc-two';
    view.rerender(
      <TransportProvider transport={transport}>
        <WidgetRenderer document={document} channel={channel} />
      </TransportProvider>
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(transport.getCanvasEventReceipt).not.toHaveBeenCalled();
  });
  it('requires native form fields and preserves the same input/focus/caret across state and receipt updates', async () => {
    const doc: WidgetDocument = {
      version: 1,
      root: {
        type: 'form',
        children: [{ type: 'input', name: 'title', label: 'Title', required: true }],
        submit: { label: 'Save', action: { kind: 'emit', type: 'task.changed' } },
      },
    };
    const channel = port();
    const view = draw(doc, channel);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter Title.');
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.type(input, 'my draft');
    input.setSelectionRange(3, 3);
    channel.snapshot = {
      state: { reply: 'new' },
      stateRev: 2,
      receipts: [],
      retentionFloor: 1,
      receiptRetentionFloor: 1,
      resetRequired: false,
    };
    view.rerender(
      <TransportProvider transport={transport}>
        <WidgetRenderer document={doc} channel={channel} />
      </TransportProvider>
    );
    expect(screen.getByRole('textbox')).toBe(input);
    expect(input).toHaveValue('my draft');
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(3);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1].payload).toMatchObject({
      title: 'my draft',
    });
  });
});
