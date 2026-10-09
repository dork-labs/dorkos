import { expect, it } from 'vitest';
import type { ConnectOverCDPTransport } from 'playwright-core';
import { readSupervisorOriginalCatalog } from '../supervisor-original-catalog.js';

it('preserves original undefined rejection while independently removing both original receivers', async () => {
  let message: ConnectOverCDPTransport['onmessage'];
  let close: ConnectOverCDPTransport['onclose'];
  let messageRemovals = 0,
    closeRemovals = 0;
  const transport = {
    get onmessage() {
      return message;
    },
    set onmessage(value: ConnectOverCDPTransport['onmessage']) {
      if (value === undefined) {
        messageRemovals++;
        throw false;
      }
      message = value;
    },
    get onclose() {
      return close;
    },
    set onclose(value: ConnectOverCDPTransport['onclose']) {
      if (value === undefined) closeRemovals++;
      close = value;
    },
    send(value: object) {
      message?.({ id: (value as { id: number }).id, error: undefined });
    },
    close() {},
  } as ConnectOverCDPTransport;
  await expect(readSupervisorOriginalCatalog(transport)).rejects.toBeUndefined();
  expect(messageRemovals).toBe(1);
  expect(closeRemovals).toBe(1);
});

it('refuses an original preexisting context before querying or lending a target', async () => {
  const methods: string[] = [];
  const transport: ConnectOverCDPTransport = {
    send(value) {
      const original = value as { id: number; method: string };
      methods.push(original.method);
      transport.onmessage?.({ id: original.id, result: { browserContextIds: ['foreign'] } });
    },
    close() {},
  };
  await expect(readSupervisorOriginalCatalog(transport)).rejects.toThrow(
    'SUPERVISOR_CATALOG_PREEXISTING_CONTEXT'
  );
  expect(methods).toEqual(['Target.getBrowserContexts']);
  expect(transport.onmessage).toBeUndefined();
  expect(transport.onclose).toBeUndefined();
});
