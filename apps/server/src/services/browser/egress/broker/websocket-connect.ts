import type { OwnedSocket } from './transport.js';
import type { BrokerLimits } from './limits.js';
import { frameRequest, type FramedRequest } from './framing.js';
import { BrokerError } from './errors.js';
import { guardedCall } from './flow.js';

const heldReaders = new Set<object>();
/** Plaintext WS CONNECT is a separate exact-endpoint capability, not opaque consent. */
export function readWebSocketConnectHandshake(options: {
  client: OwnedSocket;
  head: Uint8Array;
  outer: FramedRequest;
  limits: Readonly<Record<keyof BrokerLimits, number>>;
  check: () => void;
}): Promise<FramedRequest> {
  const { client, outer, limits, check } = options;
  if (heldReaders.size >= limits.globalCircuits) return Promise.reject(new BrokerError('QUOTA'));
  const owner = { client, detach: [] as Array<() => void>, bytes: Buffer.alloc(0) };
  heldReaders.add(owner); // Retain exact client/subscriptions before producer callbacks.
  return new Promise((resolve, reject) => {
    let settled = false;
    let registering = true;
    let deferred: { value?: FramedRequest; primary?: unknown } | undefined;
    const done = (value?: FramedRequest, primary?: unknown) => {
      if (settled) return;
      if (registering) {
        deferred ??= { value, primary };
        return;
      }
      settled = true;
      let failed = value === undefined;
      let first = primary;
      let cleanupKnown = true;
      for (const detach of owner.detach) {
        try {
          detach();
        } catch (error) {
          cleanupKnown = false;
          if (!failed) first = error;
          failed = true;
        }
      }
      try {
        // Cleanup pause emits no bytes and remains possible after revocation.
        // Actual original close already ends the producer; never invent a pause ACK.
        const pause = client.pause;
        if (!client.observedClosed) Reflect.apply(pause, client, []);
      } catch (error) {
        cleanupKnown = false;
        if (!failed) first = error;
        failed = true;
      }
      if (cleanupKnown) heldReaders.delete(owner);
      if (failed) reject(first);
      else resolve(value!);
    };
    const data = (bytes: Uint8Array) => {
      if (settled) return;
      try {
        check();
        if (owner.bytes.length + bytes.byteLength > limits.headerBytes)
          throw new BrokerError('BYTE_LIMIT');
        owner.bytes = Buffer.concat([owner.bytes, bytes]);
        if (
          [...owner.bytes].some(
            (value) => value > 127 || (value < 32 && ![9, 10, 13].includes(value))
          )
        )
          throw new BrokerError('UPGRADE_REFUSED');
        const end = owner.bytes.indexOf('\r\n\r\n');
        if (end < 0) return;
        if (end + 4 !== owner.bytes.length) throw new BrokerError('UPGRADE_REFUSED');
        const lines = owner.bytes.toString('ascii').slice(0, end).split('\r\n');
        const request = /^GET (\/[^ ]*) HTTP\/1\.1$/.exec(lines.shift() ?? '');
        if (!request || request[1]!.startsWith('//')) throw new BrokerError('UPGRADE_REFUSED');
        const headers: string[] = [];
        for (const line of lines) {
          const field = /^([^\s:]+):[ \t]*(.*)$/.exec(line);
          if (
            !field ||
            /^(proxy-authorization|authorization|content-length|transfer-encoding)$/i.test(
              field[1]!
            )
          )
            throw new BrokerError('UPGRADE_REFUSED');
          headers.push(field[1]!, field[2]!);
        }
        const framed = frameRequest(
          {
            method: 'GET',
            target: `ws://${outer.destination.authority}${request[1]}`,
            rawHeaders: [...headers, 'Proxy-Authorization', `Bearer ${outer.credential}`],
            head: new Uint8Array(),
          },
          limits
        );
        if (
          framed.kind !== 'websocket' ||
          framed.destination.authority !== outer.destination.authority
        )
          throw new BrokerError('UPGRADE_REFUSED');
        check();
        done(framed);
      } catch (error) {
        done(undefined, error);
      }
    };
    try {
      owner.detach.push(client.onClose(() => done(undefined, new BrokerError('CLOSED'))));
      owner.detach.push(client.onError(() => done(undefined, new BrokerError('CLOSED'))));
      owner.detach.push(client.onData(data));
      registering = false;
      if (deferred) {
        done(deferred.value, deferred.primary);
        return;
      }
      if (client.observedClosed) throw new BrokerError('CLOSED');
      data(options.head);
      if (!settled) guardedCall(client, 'resume', check);
    } catch (error) {
      registering = false;
      done(undefined, error);
    }
  });
}
