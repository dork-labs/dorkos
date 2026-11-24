/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { CanvasChannelEventReceipt } from '@dorkos/shared/canvas-channel-schemas';
import { useWidgetChannelActions, type WidgetChannelPort } from '../model/widget-channel';

import { installWidgetChannelSuite, port, receipt, transport } from './widget-channel.fixtures';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

installWidgetChannelSuite();

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
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(
      new Error('Lost original response')
    );
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
    const inspectedReceipt = receipt(original);
    await act(async () => {
      resolve(inspectedReceipt);
      await nested;
    });
    expect(view.result.current.records[0]).toMatchObject({
      phase: 'accepted',
      receipt: inspectedReceipt,
    });
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
