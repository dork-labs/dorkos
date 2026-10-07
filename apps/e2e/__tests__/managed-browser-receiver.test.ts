import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { expect, it, vi } from 'vitest';
import type { ManagedReceiver } from '../fixtures/managed-browser-receiver';

type OriginalFixture = (
  context: { page: { evaluate(): Promise<void> } },
  use: (receiver: ManagedReceiver) => Promise<void>
) => Promise<void>;
const registration = vi.hoisted(() => ({ fixture: undefined as OriginalFixture | undefined }));
// Capture only Playwright's registration boundary. The fixture creates its genuine
// HTTP listener, request handlers, original sockets and cleanup duties unchanged.
vi.mock('../fixtures/index', async () => {
  const originalAssertions = await import('vitest');
  return {
    expect: originalAssertions.expect,
    test: {
      extend(definitions: { managedReceiver: OriginalFixture }) {
        registration.fixture = definitions.managedReceiver;
        return {};
      },
    },
  };
});
import '../fixtures/managed-browser-receiver';

async function openOriginalReceiver(receiver: ManagedReceiver) {
  const response = await fetch(receiver.url);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('Acceptance field');
  expect(receiver.visits).toEqual([{ cookieReturned: false }]);
  const url = new URL(receiver.url);
  const socket = createConnection({ host: url.hostname, port: Number(url.port) });
  const errors: Error[] = [];
  socket.on('error', (value) => errors.push(value));
  const closed = new Promise<void>((yes) => socket.once('close', () => yes()));
  await once(socket, 'connect');
  return { socket, closed, errors };
}
async function expectOriginalClosed(
  url: string,
  original: { socket: Socket; closed: Promise<unknown>; errors: Error[] }
) {
  await original.closed;
  expect(original.socket.destroyed).toBe(true);
  expect(original.errors.every((value) => 'code' in value && value.code === 'ECONNRESET')).toBe(
    true
  );
  await expect(fetch(url)).rejects.toThrow();
}

it.each([false, undefined])(
  'original body failure %j survives later Off failure and genuine HTTP/socket cleanup',
  async (cause) => {
    let url!: string, original!: Awaited<ReturnType<typeof openOriginalReceiver>>;
    const evaluate = vi.fn(async () => {
      throw new Error('later controlled Off');
    });
    const result = registration.fixture!({ page: { evaluate } }, async (receiver) => {
      url = receiver.url;
      original = await openOriginalReceiver(receiver);
      throw cause;
    });
    await expect(result).rejects.toBe(cause);
    expect(evaluate).toHaveBeenCalledOnce();
    await expectOriginalClosed(url, original);
  }
);
it.each([false, undefined])(
  'held Off cannot prevent genuine receiver close after original body failure %j',
  async (cause) => {
    let url!: string, original!: Awaited<ReturnType<typeof openOriginalReceiver>>;
    let rejectOff!: (cause: unknown) => void, offEntered!: () => void;
    const entered = new Promise<void>((yes) => {
      offEntered = yes;
    });
    const off = new Promise<void>((_yes, no) => {
      rejectOff = no;
    });
    const evaluate = vi.fn(() => {
      offEntered();
      return off;
    });
    let settled = false;
    const result = registration.fixture!({ page: { evaluate } }, async (receiver) => {
      url = receiver.url;
      original = await openOriginalReceiver(receiver);
      throw cause;
    });
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await entered;
    await expectOriginalClosed(url, original);
    expect(settled).toBe(false);
    rejectOff(new Error('later controlled Off return'));
    await expect(result).rejects.toBe(cause);
    expect(evaluate).toHaveBeenCalledOnce();
  }
);
it.each([false, undefined])(
  'original Off failure %j is retained after successful real receiver observations',
  async (cause) => {
    let url!: string, original!: Awaited<ReturnType<typeof openOriginalReceiver>>;
    const evaluate = vi.fn(async () => {
      throw cause;
    });
    const result = registration.fixture!({ page: { evaluate } }, async (receiver) => {
      url = receiver.url;
      original = await openOriginalReceiver(receiver);
      const observation = {
        width: 1280,
        height: 720,
        value: 'actual-controlled-marker',
        focused: true,
      };
      const response = await fetch(receiver.url + '/observe', {
        method: 'POST',
        body: JSON.stringify(observation),
      });
      expect(response.status).toBe(204);
      await response.arrayBuffer();
      expect(receiver.observations).toEqual([observation]);
    });
    await expect(result).rejects.toBe(cause);
    expect(evaluate).toHaveBeenCalledOnce();
    await expectOriginalClosed(url, original);
  }
);
