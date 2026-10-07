/** @vitest-environment jsdom */
import { act, renderHook, cleanup } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useNativeCheckboxWrite } from '../model/use-native-checkbox-write';
import type { CanvasChannelCheckboxRequest } from '@dorkos/shared/canvas-channel-schemas';
afterEach(cleanup);
const input = {
  line: 1,
  done: true,
  textHash: 'a'.repeat(64),
  expectedFileVersion: 'b'.repeat(64),
};
it('lost response retains the exact original event and byte evidence on explicit retry', async () => {
  const seen: CanvasChannelCheckboxRequest[] = [];
  const transport = createMockTransport({
    toggleCanvasCheckbox: async (request) => {
      seen.push(request);
      if (seen.length === 1) throw new Error('Lost writer response');
      return {
        status: 'changed',
        fileVersion: 'c'.repeat(64),
        receipt: { id: request.eventId, docSeq: 1, status: 'recorded' },
      };
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TransportProvider transport={transport}>{children}</TransportProvider>
  );
  const { result } = renderHook(() => useNativeCheckboxWrite('document'), { wrapper });
  await act(async () => {
    await expect(result.current.write(input)).rejects.toThrow('Lost writer response');
  });
  expect(result.current.state).toBe('error');
  await act(async () => {
    await expect(result.current.write({ ...input, done: false })).rejects.toThrow(
      'pending checkbox'
    );
  });
  expect(seen).toHaveLength(1);
  await act(async () => {
    await result.current.retry();
  });
  expect(seen).toHaveLength(2);
  expect(seen[1]).toBe(seen[0]);
  expect(seen[0]).toMatchObject({ ...input, documentId: 'document' });
  expect(result.current.state).toBe('saved');
  expect(result.current.receipt?.status).toBe('changed');
});
it.each(['conflict', 'in_doubt'] as const)(
  'surfaces %s without automatically repeating an uncertain mutation',
  async (status) => {
    let calls = 0;
    const transport = createMockTransport({
      toggleCanvasCheckbox: async (request) => {
        calls++;
        return status === 'conflict'
          ? { status, eventId: request.eventId, action: 'reload' }
          : { status, eventId: request.eventId, action: 'review' };
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TransportProvider transport={transport}>{children}</TransportProvider>
    );
    const { result } = renderHook(() => useNativeCheckboxWrite('document'), { wrapper });
    await act(async () => {
      await result.current.write(input);
    });
    expect(result.current.state).toBe(status === 'conflict' ? 'conflict' : 'review');
    await act(async () => {
      await expect(result.current.retry()).rejects.toThrow('Reload or review');
    });
    expect(calls).toBe(1);
  }
);

it('refuses a valid foreign receipt and retains the original request for explicit retry', async () => {
  const seen: CanvasChannelCheckboxRequest[] = [];
  const transport = createMockTransport({
    toggleCanvasCheckbox: async (request) => {
      seen.push(request);
      return {
        status: 'no_op',
        eventId: seen.length === 1 ? '11111111-2222-4333-8444-555555555555' : request.eventId,
        fileVersion: request.expectedFileVersion,
      };
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TransportProvider transport={transport}>{children}</TransportProvider>
  );
  const { result } = renderHook(() => useNativeCheckboxWrite('document'), { wrapper });
  await act(async () => {
    await expect(result.current.write(input)).rejects.toThrow('does not match');
  });
  expect(result.current.state).toBe('error');
  expect(result.current.receipt).toBeNull();
  await act(async () => {
    await result.current.retry();
  });
  expect(seen[1]).toBe(seen[0]);
  expect(result.current.state).toBe('saved');
});
it('keeps a held old-document operation separate and permits a new document write', async () => {
  let settle!: (
    value: Awaited<ReturnType<ReturnType<typeof createMockTransport>['toggleCanvasCheckbox']>>
  ) => void;
  const seen: CanvasChannelCheckboxRequest[] = [];
  const transport = createMockTransport({
    toggleCanvasCheckbox: (request) => {
      seen.push(request);
      if (request.documentId === 'A')
        return new Promise((resolve) => {
          settle = resolve;
        });
      return Promise.resolve({
        status: 'no_op',
        eventId: request.eventId,
        fileVersion: request.expectedFileVersion,
      });
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TransportProvider transport={transport}>{children}</TransportProvider>
  );
  const { result, rerender } = renderHook(({ id }) => useNativeCheckboxWrite(id), {
    initialProps: { id: 'A' },
    wrapper,
  });
  let old!: Promise<unknown>;
  await act(async () => {
    old = result.current.write(input);
    await Promise.resolve();
  });
  rerender({ id: 'B' });
  expect(result.current.state).toBe('idle');
  expect(result.current.receipt).toBeNull();
  await act(async () => {
    settle({ status: 'no_op', eventId: seen[0].eventId, fileVersion: seen[0].expectedFileVersion });
    await old;
  });
  expect(result.current.state).toBe('idle');
  expect(result.current.receipt).toBeNull();
  await act(async () => {
    await result.current.write(input);
  });
  expect(seen.map((request) => request.documentId)).toEqual(['A', 'B']);
  expect(result.current.state).toBe('saved');
});

it('never renders a completed old-document receipt during a new-document render', async () => {
  const transport = createMockTransport();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TransportProvider transport={transport}>{children}</TransportProvider>
  );
  const renders: { id: string; state: string; receipt: unknown }[] = [];
  const { result, rerender } = renderHook(
    ({ id }) => {
      const value = useNativeCheckboxWrite(id);
      renders.push({ id, state: value.state, receipt: value.receipt });
      return value;
    },
    { initialProps: { id: 'A' }, wrapper }
  );
  await act(async () => {
    await result.current.write(input);
  });
  expect(result.current.state).toBe('saved');
  rerender({ id: 'B' });
  expect(
    renders
      .filter((value) => value.id === 'B')
      .every((value) => value.state === 'idle' && value.receipt === null)
  ).toBe(true);
});

it.each(['conflict', 'in_doubt'] as const)(
  'explicit reload retires only a verified conflict, preserving %s ownership',
  async (status) => {
    const requests: CanvasChannelCheckboxRequest[] = [];
    const transport = createMockTransport({
      toggleCanvasCheckbox: async (request) => {
        requests.push(request);
        return status === 'conflict'
          ? { status, eventId: request.eventId, action: 'reload' }
          : { status, eventId: request.eventId, action: 'review' };
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TransportProvider transport={transport}>{children}</TransportProvider>
    );
    const { result } = renderHook(() => useNativeCheckboxWrite('document'), { wrapper });
    await act(async () => {
      await result.current.write(input);
    });
    await act(async () => {
      expect(result.current.resolveConflictReload('another-event')).toBe(false);
      expect(result.current.resolveConflictReload(requests[0].eventId)).toBe(status === 'conflict');
    });
    if (status === 'conflict') {
      await act(async () => {
        await result.current.write({ ...input, expectedFileVersion: 'c'.repeat(64) });
      });
      expect(requests).toHaveLength(2);
      expect(requests[1].eventId).not.toBe(requests[0].eventId);
    } else {
      await act(async () => {
        await expect(result.current.write(input)).rejects.toThrow('pending checkbox');
      });
      expect(requests).toHaveLength(1);
      expect(result.current.state).toBe('review');
    }
  }
);
