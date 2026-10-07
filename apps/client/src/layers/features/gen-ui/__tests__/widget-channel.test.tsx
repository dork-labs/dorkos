/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { WidgetDocument } from '@dorkos/shared/ui-widget';
import type { CanvasChannelEventReceipt, PageEvent } from '@dorkos/shared/canvas-channel-schemas';
import { useDocChannel } from '@/layers/features/canvas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { WidgetRenderer } from '../ui/WidgetRenderer';
import { useWidgetChannelActions, type WidgetChannelPort } from '../model/widget-channel';

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
let ownedChannel: WidgetChannelPort;
let disposeOwned: (() => void) | undefined;
function port(): WidgetChannelPort {
  return { ...ownedChannel };
}

function draw(doc = document, channel = port()) {
  return render(
    <TransportProvider transport={transport}>
      <WidgetRenderer document={doc} sessionId="session" channel={channel} />
    </TransportProvider>
  );
}
beforeEach(async () => {
  vi.resetAllMocks();
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
  vi.mocked(transport.getCanvasChannel).mockResolvedValue({
    events: [],
    state: {},
    stateRev: 0,
    highWatermark: 0,
    retentionFloor: 1,
    receiptRetentionFloor: 1,
    resetRequired: false,
    receipts: [],
    health: { status: 'ready', reasons: [] },
    routing: { enabled: true, destinationLabel: 'LifeOS', approvedEventTypes: ['widget.action'] },
    incarnation: {
      v: 1,
      documentId: 'doc-one',
      physicalOpenedAt: '2026-10-02T00:00:00Z',
      channelCreatedAt: '2026-10-02T00:00:01Z',
      generation: 'a'.repeat(64),
    },
  });
  const owned = renderHook(() => useDocChannel('doc-one'), {
    wrapper: ({ children }) => (
      <TransportProvider transport={transport}>{children}</TransportProvider>
    ),
  });
  disposeOwned = owned.unmount;
  await waitFor(() => expect(owned.result.current.channel.enabled).toBe(true));
  ownedChannel = owned.result.current.channel;
});
afterEach(() => {
  disposeOwned?.();
  disposeOwned = undefined;
  cleanup();
});
describe('native document widget actions', () => {
  it.each(['widget.action', 'widget.*'])(
    'normalizes an agent action through approved %s',
    async (pattern) => {
      const channel = { ...port(), approvedEventTypes: [pattern] };
      const { result } = renderHook(() => useWidgetChannelActions(channel));
      await act(() => result.current.dispatch({ kind: 'agent', id: 'save' }, 'control'));
      expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
      expect(vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1]).toMatchObject({
        type: 'widget.action',
        payload: { actionId: 'save', widget: { nodeId: 'control' } },
      });
      expect(transport.sendUiAction).not.toHaveBeenCalled();
    }
  );

  it.each([
    { pattern: 'task.*', enabled: true },
    { pattern: 'widget.action.*', enabled: true },
    { pattern: 'widget*', enabled: true },
    { pattern: '*', enabled: true },
    { pattern: 'widget.*', enabled: false },
  ])(
    'refuses normalized actions for $pattern with enabled=$enabled',
    async ({ pattern, enabled }) => {
      const channel = { ...port(), approvedEventTypes: [pattern], enabled };
      const doc: WidgetDocument = {
        version: 1,
        root: { type: 'button', label: 'Agent', action: { kind: 'agent', id: 'save' } },
      };
      draw(doc, channel);
      expect(screen.getByRole('button', { name: 'Agent' })).toHaveAttribute(
        'aria-disabled',
        'true'
      );
      await userEvent.setup().click(screen.getByRole('button', { name: 'Agent' }));
      const { result } = renderHook(() => useWidgetChannelActions(channel));
      await act(() => result.current.dispatch({ kind: 'agent', id: 'save' }, 'control'));
      expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
      expect(transport.sendUiAction).not.toHaveBeenCalled();
    }
  );

  it('keeps exact normalized identity after lost response and generic 404 without reposting', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('Lost response'));
    const { result } = renderHook(() =>
      useWidgetChannelActions({ ...port(), approvedEventTypes: ['widget.*'] })
    );
    await act(() => result.current.dispatch({ kind: 'agent', id: 'save' }, 'control'));
    const original = vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1];
    expect(result.current.pending('control')).toBe(true);
    await act(() => result.current.retry(original.id));
    expect(vi.mocked(transport.ingestCanvasEvent).mock.calls.map(([, event]) => event)).toEqual([
      original,
    ]);
    expect(result.current.records[0].event.id).toBe(original.id);
    expect(transport.getCanvasEventReceipt).toHaveBeenCalledWith(
      'doc-one',
      original.id,
      { expectedGeneration: 'a'.repeat(64) },
      expect.any(AbortSignal)
    );
    expect(result.current.pending('control')).toBe(true);
  });

  it.each(['approval', 'lookup'] as const)(
    'preserves uncertain normalized identity after changed %s',
    async (change) => {
      vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('Lost response'));
      let channel = { ...port(), approvedEventTypes: ['widget.*'] };
      const { result, rerender } = renderHook(() => useWidgetChannelActions(channel));
      const action = { kind: 'agent' as const, id: 'save' };
      await act(() => result.current.dispatch(action, 'control'));
      const original = vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1];
      if (change === 'approval') {
        channel = { ...channel, approvedEventTypes: ['widget.action.*'] };
        rerender();
      } else
        vi.mocked(transport.getCanvasEventReceipt).mockRejectedValueOnce(
          Object.assign(new Error('Denied'), { status: 403 })
        );
      await act(() => result.current.retry(original.id));
      expect(result.current.pending('control')).toBe(true);
      expect(result.current.records[0]).toMatchObject({
        phase: 'review',
        event: { id: original.id },
      });
      channel = { ...channel, approvedEventTypes: ['widget.*'] };
      rerender();
      await act(() => result.current.dispatch(action, 'control'));
      expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
      expect(result.current.records).toHaveLength(1);
      expect(JSON.stringify(result.current.records[0].event)).toBe(JSON.stringify(original));
    }
  );

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
  it('guards a direct new dispatch after a lost persisted response and forbidden lookup', async () => {
    const persisted: PageEvent[] = [];
    vi.mocked(transport.ingestCanvasEvent).mockImplementation(async (_id, event) => {
      persisted.push(event);
      throw new Error('Response lost AFTER persistence');
    });
    vi.mocked(transport.getCanvasEventReceipt).mockRejectedValue(
      Object.assign(new Error('Permission revoked'), { status: 403 })
    );
    const { result } = renderHook(() => useWidgetChannelActions(port()));
    const action = { kind: 'emit' as const, type: 'task.changed', payload: { task: 'same' } };
    await act(() => result.current.dispatch(action, 'control'));
    const original = result.current.records[0].event.id;
    await act(() => result.current.retry(original));
    expect(result.current.records[0].phase).toBe('review');
    expect(result.current.pending('control')).toBe(true);
    await act(() => result.current.dispatch(action, 'control'));
    expect(persisted).toHaveLength(1);
    expect(result.current.records).toHaveLength(1);
    expect(result.current.records[0].event.id).toBe(original);
  });
  it.each([401, 403, 409])(
    'keeps a lost persisted click pending after receipt lookup %s',
    async (status) => {
      const persisted: PageEvent[] = [];
      vi.mocked(transport.ingestCanvasEvent).mockImplementation(async (_id, event) => {
        persisted.push(event);
        throw new Error('Response lost after persistence');
      });
      vi.mocked(transport.getCanvasEventReceipt).mockRejectedValue(
        Object.assign(new Error('Lookup refused'), { status })
      );
      draw();
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'One' }));
      const id = screen.getByTestId('widget-action-status').getAttribute('data-event-id');
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(screen.getByRole('button', { name: 'One' })).toBeDisabled();
      expect(screen.getByTestId('widget-action-status')).toHaveAttribute('data-event-id', id);
      expect(screen.getByTestId('widget-action-status')).toHaveTextContent('Save not confirmed');
      await user.click(screen.getByRole('button', { name: 'One' }));
      expect(persisted).toHaveLength(1);
      expect(screen.getAllByTestId('widget-action-status')).toHaveLength(1);
    }
  );
  it('preserves the original uncertain identity after its genuine private owner retires', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValue(
      new Error('Response lost after persistence')
    );
    const channel = port();
    const view = draw(document, channel);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'One' }));
    const original = vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1];
    const originalBytes = JSON.stringify(original);
    act(() => {
      disposeOwned?.();
      disposeOwned = undefined;
    });
    expect(channel.current?.('read')).toBe(false);
    view.rerender(
      <TransportProvider transport={transport}>
        <WidgetRenderer document={document} channel={{ ...channel, enabled: false }} />
      </TransportProvider>
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    view.rerender(
      <TransportProvider transport={transport}>
        <WidgetRenderer document={document} channel={channel} />
      </TransportProvider>
    );
    expect(screen.getByRole('button', { name: 'One' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'One' }));
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('widget-action-status')).toHaveAttribute(
      'data-event-id',
      original.id
    );
    expect(transport.getCanvasEventReceipt).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1])).toBe(
      originalBytes
    );
  });
  it('keeps the original pending when generic receipt absence is unknown', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('Lost response'));
    draw();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'One' }));
    const original = vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1];
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('button', { name: 'One' })).toBeDisabled();
    expect(transport.getCanvasEventReceipt).toHaveBeenCalledWith(
      'doc-one',
      original.id,
      { expectedGeneration: 'a'.repeat(64) },
      expect.any(AbortSignal)
    );
    await user.click(screen.getByRole('button', { name: 'One' }));
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId('widget-action-status')).toHaveLength(1);
  });
  it('releases only a definitive original POST refusal for a fresh click', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(
      Object.assign(new Error('Refused before acceptance'), { status: 403 })
    );
    draw();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'One' }));
    expect(screen.getByRole('button', { name: 'One' })).not.toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'One' }));
    const calls = vi.mocked(transport.ingestCanvasEvent).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][1].id).not.toBe(calls[0][1].id);
  });
  it('blocks only the uncertain control and never reposts after an unknown receipt lookup', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('Offline'));
    draw();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'One' }));
    expect(screen.getByRole('button', { name: 'One' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Two' })).not.toBeDisabled();
    const original = vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1];
    await user.click(screen.getByTestId('widget-action-retry'));
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(transport.getCanvasEventReceipt).toHaveBeenCalledWith(
      'doc-one',
      original.id,
      { expectedGeneration: 'a'.repeat(64) },
      expect.any(AbortSignal)
    );
    expect(screen.getByRole('button', { name: 'One' })).toBeDisabled();
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
    expect(screen.getByText(/Save not confirmed/)).toBeVisible();
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
  it.each([
    ['handled', 'The destination reported that it handled this action.'],
    ['rejected', 'The destination could not handle this action.'],
    ['turn_started', 'The destination started working.'],
    ['turn_done', 'The destination finished. Handling is not confirmed yet.'],
    ['waiting', 'Saved; waiting for the destination.'],
  ] as const)(
    'keeps historical %s neutral when same-document routing changes',
    async (status, text) => {
      vi.mocked(transport.ingestCanvasEvent).mockImplementation(async (_id, event) =>
        receipt(event, status)
      );
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
      const input = screen.getByRole('textbox') as HTMLInputElement;
      await user.type(input, 'Original task');
      await user.click(screen.getByRole('button', { name: 'Save' }));
      const row = screen.getByTestId('widget-action-status');
      expect(row).toHaveTextContent(text);
      const originalId = row.getAttribute('data-event-id');
      expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
      expect(vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1].payload).toMatchObject({
        title: 'Original task',
      });
      await user.clear(input);
      await user.type(input, 'Next draft');
      input.setSelectionRange(3, 5);
      for (const destinationLabel of ['Approval needed', 'Another destination']) {
        view.rerender(
          <TransportProvider transport={transport}>
            <WidgetRenderer
              document={doc}
              channel={{ ...channel, enabled: false, destinationLabel }}
            />
          </TransportProvider>
        );
        expect(screen.getByTestId('widget-action-status')).toBe(row);
        expect(row).toHaveTextContent(text);
        expect(row).not.toHaveTextContent(destinationLabel);
        expect(row).toHaveAttribute('data-event-id', originalId);
        expect(screen.getByRole('textbox')).toBe(input);
        expect(input).toHaveValue('Next draft');
        expect(input).toHaveFocus();
        expect(input.selectionStart).toBe(3);
        expect(input.selectionEnd).toBe(5);
        expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
        expect(transport.getCanvasEventReceipt).not.toHaveBeenCalled();
      }
    }
  );
  it('does not assume complete history when the original receipt floor was unknown', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('offline'));
    const channel = port();
    channel.snapshot = undefined;
    draw(document, channel);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'One' }));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Save not confirmed/)).toBeVisible();
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
    expect(screen.getByText(/Save not confirmed/)).toBeVisible();
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

describe('private native row operation lifetimes', () => {
  it('ignores late success and rejection after the actual owner is replaced', async () => {
    for (const rejectOld of [false, true]) {
      let resolve!: (receipt: CanvasChannelEventReceipt) => void;
      let reject!: (error: Error) => void;
      const oldOwner = Object.freeze({});
      let channel = { ...port(), submissionOwner: oldOwner };
      vi.mocked(transport.ingestCanvasEvent).mockReturnValueOnce(
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        })
      );
      const view = renderHook(() => useWidgetChannelActions(channel));
      let sending!: Promise<void>;
      act(() => {
        sending = view.result.current.dispatch({ kind: 'emit', type: 'task.changed' }, 'one');
      });
      const original = vi.mocked(transport.ingestCanvasEvent).mock.calls.at(-1)![1];
      const originalSignal = vi.mocked(transport.ingestCanvasEvent).mock.calls.at(-1)![3];
      channel = { ...channel, submissionOwner: Object.freeze({}) };
      view.rerender();
      expect(originalSignal.aborted).toBe(true);
      await act(async () => {
        if (rejectOld) reject(new Error('Late failure'));
        else resolve(receipt(original));
        await sending;
      });
      expect(view.result.current.records[0].receipt).toBeUndefined();
      expect(view.result.current.records[0].phase).not.toBe('accepted');
      view.unmount();
    }
  });
  it('recovers the original receipt once under the same stable owner without reposting', async () => {
    const owner = Object.freeze({});
    let channel = { ...port(), submissionOwner: owner };
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(
      new Error('Lost accepted response')
    );
    const view = renderHook(() => useWidgetChannelActions(channel));
    await act(() =>
      view.result.current.dispatch(
        { kind: 'emit', type: 'task.changed', payload: { draft: 'stable' } },
        'one'
      )
    );
    const first = vi.mocked(transport.ingestCanvasEvent).mock.calls.at(-1)!;
    channel = { ...channel, destinationLabel: 'Canonical destination' };
    view.rerender();
    vi.mocked(transport.getCanvasEventReceipt).mockResolvedValueOnce(receipt(first[1]));
    await act(() => view.result.current.retry(first[1].id));
    const inspection = vi.mocked(transport.getCanvasEventReceipt).mock.calls.at(-1)!;
    expect(inspection[1]).toBe(first[1].id);
    expect(inspection[2]).toEqual(first[2]);
    expect(inspection[3]).not.toBe(first[3]);
    expect(first[3].aborted).toBe(true);
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(view.result.current.records[0]).toMatchObject({ phase: 'accepted', event: first[1] });
    view.unmount();
  });
  it('lets a reentrant newer same-owner recovery keep its receipt and signal', async () => {
    const owner = Object.freeze({});
    let enter = false;
    let nested: Promise<void> | undefined;
    let startNested: () => Promise<void> = async () => {};
    const channel = {
      ...port(),
      submissionOwner: owner,
      current: () => {
        if (enter) {
          enter = false;
          nested = startNested();
        }
        return true;
      },
    };
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('Lost response'));
    const view = renderHook(() => useWidgetChannelActions(channel));
    await act(() => view.result.current.dispatch({ kind: 'emit', type: 'task.changed' }, 'one'));
    const original = vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1];
    startNested = () => view.result.current.retry(original.id);
    const acceptedReceipt = receipt(original);
    vi.mocked(transport.getCanvasEventReceipt).mockResolvedValueOnce(acceptedReceipt);
    enter = true;
    await act(async () => {
      await view.result.current.retry(original.id);
      await nested;
    });
    expect(transport.getCanvasEventReceipt).toHaveBeenCalledTimes(1);
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(view.result.current.records[0]).toMatchObject({
      phase: 'accepted',
      receipt: acceptedReceipt,
    });
    view.unmount();
  });
  it('uses a fresh inspect signal and retains original bytes after generic 404 with no resend', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('Lost response'));
    const channel = { ...port(), submissionOwner: Object.freeze({}) };
    const view = renderHook(() => useWidgetChannelActions(channel));
    await act(() =>
      view.result.current.dispatch(
        { kind: 'emit', type: 'task.changed', payload: { draft: 'frozen' } },
        'one'
      )
    );
    const original = vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1];
    await act(() => view.result.current.retry(original.id));
    const inspection = vi.mocked(transport.getCanvasEventReceipt).mock.calls[0];
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(view.result.current.records[0].event.id).toBe(original.id);
    expect(JSON.stringify(view.result.current.records[0].event)).toBe(JSON.stringify(original));
    expect(inspection[3]).toBeInstanceOf(AbortSignal);
    expect(inspection[2]).toEqual({ expectedGeneration: 'a'.repeat(64) });
    view.unmount();
  });
});

it('leaves a newer same-owner receipt intact when the old finally abort listener starts recovery', async () => {
  const channel = { ...port(), submissionOwner: Object.freeze({}) };
  const view = renderHook(() => useWidgetChannelActions(channel));
  let nested: Promise<void> | undefined;
  vi.mocked(transport.ingestCanvasEvent).mockImplementationOnce(
    async (_doc, event, _condition, signal) => {
      signal.addEventListener(
        'abort',
        () => {
          nested = view.result.current.retry(event.id);
        },
        { once: true }
      );
      throw new Error('Lost response');
    }
  );
  vi.mocked(transport.getCanvasEventReceipt).mockImplementationOnce(async (_doc, eventId) =>
    receipt({ v: 1, id: eventId, type: 'task.changed', payload: {} })
  );
  await act(async () => {
    await view.result.current.dispatch({ kind: 'emit', type: 'task.changed' }, 'one');
    await nested;
  });
  expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
  expect(transport.getCanvasEventReceipt).toHaveBeenCalledTimes(1);
  expect(view.result.current.records[0].phase).toBe('accepted');
  expect(view.result.current.pending('one')).toBe(false);
  view.unmount();
});

it('reserves its start sentinel before abort and never overwrites a nested newer recovery', async () => {
  const channel = { ...port(), submissionOwner: Object.freeze({}) };
  const view = renderHook(() => useWidgetChannelActions(channel));
  vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('Lost original response'));
  await act(() => view.result.current.dispatch({ kind: 'emit', type: 'task.changed' }, 'one'));
  const original = vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1];
  const acceptedReceipt = receipt(original);
  let nested: Promise<void> | undefined;
  let oldInspectSignal!: AbortSignal;
  let resolveOld!: (value: CanvasChannelEventReceipt) => void;
  vi.mocked(transport.getCanvasEventReceipt)
    .mockImplementationOnce((_doc, _id, _condition, signal) => {
      oldInspectSignal = signal;
      signal.addEventListener(
        'abort',
        () => {
          nested = view.result.current.retry(original.id);
        },
        { once: true }
      );
      return new Promise((yes) => {
        resolveOld = yes;
      });
    })
    .mockResolvedValueOnce(acceptedReceipt);
  let firstRecovery!: Promise<void>;
  act(() => {
    firstRecovery = view.result.current.retry(original.id);
  });
  await act(async () => {
    await view.result.current.retry(original.id);
    await nested;
  });
  expect(oldInspectSignal.aborted).toBe(true);
  expect(transport.getCanvasEventReceipt).toHaveBeenCalledTimes(2);
  expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
  expect(view.result.current.records[0].phase).toBe('accepted');
  await act(async () => {
    resolveOld(receipt(original, 'failed'));
    await firstRecovery;
  });
  expect(view.result.current.records[0]).toMatchObject({
    phase: 'accepted',
    receipt: acceptedReceipt,
  });
  expect(view.result.current.pending('one')).toBe(false);
  view.unmount();
});

it('requires current original-row read ownership after an observable callback before accepting replay receipts', async () => {
  let reads = 0;
  let challenge = false;
  let channel: WidgetChannelPort = {
    ...port(),
    submissionOwner: Object.freeze({}),
    current: () => !challenge || ++reads === 1,
  };
  vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('Lost response'));
  const view = renderHook(() => useWidgetChannelActions(channel));
  try {
    await act(() => view.result.current.dispatch({ kind: 'emit', type: 'task.changed' }, 'one'));
    const original = vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1];
    challenge = true;
    channel = { ...channel, snapshot: { ...channel.snapshot!, receipts: [receipt(original)] } };
    view.rerender();
    expect(reads).toBe(2);
    expect(view.result.current.records[0]).toMatchObject({ phase: 'retry', event: original });
    expect(view.result.current.records[0].receipt).toBeUndefined();
    expect(transport.getCanvasEventReceipt).not.toHaveBeenCalled();
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
  }
});

it('leaves a reentrant newer same-owner inspection intact instead of accepting an older snapshot receipt', async () => {
  let challenge = false;
  let nested: Promise<void> | undefined;
  let recover = async () => {};
  let channel: WidgetChannelPort = {
    ...port(),
    submissionOwner: Object.freeze({}),
    current: () => {
      if (challenge) {
        challenge = false;
        nested = recover();
      }
      return true;
    },
  };
  vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('Lost response'));
  const view = renderHook(() => useWidgetChannelActions(channel));
  try {
    await act(() => view.result.current.dispatch({ kind: 'emit', type: 'task.changed' }, 'one'));
    const original = vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1];
    let resolve!: (value: CanvasChannelEventReceipt) => void;
    vi.mocked(transport.getCanvasEventReceipt).mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes;
      })
    );
    recover = () => view.result.current.retry(original.id);
    challenge = true;
    channel = {
      ...channel,
      snapshot: { ...channel.snapshot!, receipts: [receipt(original, 'failed')] },
    };
    view.rerender();
    expect(transport.getCanvasEventReceipt).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(transport.getCanvasEventReceipt).mock.calls[0][3];
    expect(signal.aborted).toBe(false);
    expect(view.result.current.records[0].receipt).toBeUndefined();
    const inspected = receipt(original);
    await act(async () => {
      resolve(inspected);
      await nested;
    });
    expect(view.result.current.records[0]).toMatchObject({
      phase: 'accepted',
      receipt: inspected,
    });
    expect(view.result.current.records[0].receipt).toEqual(inspected);
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
  }
});

it.each(['document', 'owner'] as const)(
  'refuses submit when current callback replaces the %s without a rerender',
  async (replacement) => {
    const channel: WidgetChannelPort = {
      ...port(),
      submissionOwner: Object.freeze({}),
      current: (_purpose: 'read' | 'submit') => true,
    };
    channel.current = () => {
      if (replacement === 'document') channel.documentId = 'doc-two';
      else channel.submissionOwner = Object.freeze({});
      return true;
    };
    const view = renderHook(() => useWidgetChannelActions(channel));
    try {
      await act(() =>
        view.result.current.dispatch(
          { kind: 'emit', type: 'task.changed', payload: { draft: 'kept' } },
          'one'
        )
      );
      expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
      expect(transport.getCanvasEventReceipt).not.toHaveBeenCalled();
      expect(view.result.current.records[0]).toMatchObject({
        documentId: 'doc-one',
        event: { type: 'task.changed', payload: { draft: 'kept' } },
      });
    } finally {
      view.unmount();
    }
  }
);

it.each(['document', 'owner'] as const)(
  'refuses uncertain inspect when current callback replaces the %s without a rerender',
  async (replacement) => {
    let mutate = false;
    const channel: WidgetChannelPort = {
      ...port(),
      submissionOwner: Object.freeze({}),
      current: (_purpose: 'read' | 'submit') => {
        if (mutate) {
          if (replacement === 'document') channel.documentId = 'doc-two';
          else channel.submissionOwner = Object.freeze({});
        }
        return true;
      },
    };
    const view = renderHook(() => useWidgetChannelActions(channel));
    try {
      vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(
        new Error('lost original response')
      );
      await act(() =>
        view.result.current.dispatch(
          { kind: 'emit', type: 'task.changed', payload: { draft: 'kept' } },
          'one'
        )
      );
      const original = vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1];
      mutate = true;
      await act(() => view.result.current.retry(original.id));
      expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
      expect(transport.getCanvasEventReceipt).not.toHaveBeenCalled();
      expect(view.result.current.records[0]).toMatchObject({
        documentId: 'doc-one',
        event: { id: original.id, payload: { draft: 'kept' } },
      });
    } finally {
      view.unmount();
    }
  }
);

it('refuses a structural port without closed original capture before any POST', async () => {
  const channel = { ...port(), captureOriginal: undefined };
  const view = renderHook(() => useWidgetChannelActions(channel));
  await act(() => view.result.current.dispatch({ kind: 'emit', type: 'task.changed' }, 'one'));
  expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
  expect(view.result.current.records).toEqual([]);
});
