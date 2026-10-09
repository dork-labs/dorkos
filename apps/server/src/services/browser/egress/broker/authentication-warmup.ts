import { randomUUID } from 'node:crypto';
import type { RawRequest, FramedRequest } from './framing.js';
import type { OwnedSocket } from './transport.js';
import { BrokerError } from './errors.js';

const body =
  '<!doctype html><html><head><link rel="icon" href="data:,"></head><body></body></html>';
const response = Buffer.from(
  'HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ' +
    Buffer.byteLength(body) +
    "\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; img-src data:\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n" +
    body
);

/** Constructor-owned, one-shot local response; it supplies no DNS, dial or public destination grant. */
export function createOriginalAuthenticationWarmup(origin: string, check: () => unknown) {
  const parsed = new URL(origin);
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    !parsed.port ||
    parsed.pathname !== '/' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new BrokerError('AUTHORITY_REFUSED');
  const path = '/.dorkos-private-authentication/' + randomUUID();
  const url = origin + path;
  let first: Readonly<{ value: unknown }> | undefined;
  let challenge: Readonly<{ socket: OwnedSocket; returned: Promise<void> }> | undefined;
  let entered = false;
  let resolve!: () => void, reject!: (value: unknown) => void;
  const returned = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void returned.catch(() => {});
  const fail = (value: unknown) => {
    first ??= { value };
    reject(first.value);
  };
  const current = () => {
    if (first) throw first.value;
    check();
  };
  const terminal = (socket: OwnedSocket): Promise<void> => {
    const original = new Promise<void>((yes, no) => {
      let removeClose: (() => void) | undefined, removeError: (() => void) | undefined;
      let settled = false;
      const detach = (primary?: Readonly<{ value: unknown }>) => {
        let first = primary;
        const removals = [removeClose, removeError];
        removeClose = undefined;
        removeError = undefined;
        for (const remove of removals) {
          try {
            remove?.();
          } catch (value) {
            first ??= { value };
          }
        }
        return first;
      };
      const finish = (primary?: Readonly<{ value: unknown }>) => {
        if (settled) return;
        settled = true;
        const failure = detach(primary);
        if (failure) {
          fail(failure.value);
          no(failure.value);
        } else yes();
      };
      const complete = () => {
        try {
          if (!socket.observedClosed) throw new BrokerError('CLEANUP_UNVERIFIED');
          finish();
        } catch (value) {
          finish({ value });
        }
      };
      try {
        removeClose = socket.onClose(complete);
        if (settled) {
          const failed = detach();
          if (failed) fail(failed.value);
          return;
        }
        removeError = socket.onError(() =>
          finish({ value: new BrokerError('CLEANUP_UNVERIFIED') })
        );
        if (settled) {
          const failed = detach();
          if (failed) fail(failed.value);
          return;
        }
        if (socket.observedClosed) complete();
      } catch (value) {
        if (settled) {
          const failure = detach({ value });
          fail(failure ? failure.value : value);
        } else finish({ value });
      }
    });
    void original.catch(() => {});
    return original;
  };
  const capability = Object.freeze({
    url,
    confirm() {
      try {
        current();
        if (!entered) throw new BrokerError('UNAVAILABLE');
        return returned;
      } catch (value) {
        fail(value);
        const refused = Promise.reject(first ? first.value : value);
        void refused.catch(() => {});
        return refused;
      }
    },
  });
  return Object.freeze({
    capability,
    rejectDirect(raw: RawRequest) {
      if (raw.target === path) throw new BrokerError('FRAMING_REFUSED');
    },
    challenge(raw: RawRequest, socket: OwnedSocket) {
      if (raw.target !== url) return;
      current();
      if (
        challenge ||
        entered ||
        raw.method !== 'GET' ||
        raw.head.byteLength ||
        raw.rawHeaders.some(
          (value, index) =>
            index % 2 === 0 &&
            ['authorization', 'content-length', 'transfer-encoding', 'upgrade'].includes(
              value.toLowerCase()
            )
        )
      )
        throw new BrokerError('FRAMING_REFUSED');
      // Capture actual closure before the original 407 write/end can synchronously close.
      const closed = terminal(socket);
      let written!: () => void, failed!: (value: unknown) => void;
      const sent = new Promise<void>((yes, no) => {
        written = yes;
        failed = no;
      });
      void sent.catch(() => {});
      const complete = Promise.all([closed, sent]).then(() => {
        current();
      });
      void complete.catch(fail);
      challenge = Object.freeze({ socket, returned: complete });
      return Object.freeze({
        written,
        fail(value: unknown) {
          fail(value);
          failed(value);
        },
      });
    },
    enter(raw: RawRequest, framed: FramedRequest, socket: OwnedSocket) {
      if (framed.url !== url) return;
      current();
      if (
        entered ||
        (challenge && challenge.socket.identity === socket.identity) ||
        raw.target !== url ||
        framed.kind !== 'http' ||
        framed.method !== 'GET' ||
        framed.path !== path ||
        raw.head.byteLength ||
        (framed.contentLength !== undefined && framed.contentLength !== 0) ||
        framed.headers.authorization !== undefined
      )
        throw new BrokerError('AUTHORITY_REFUSED');
      // The persistent context may send host cookies regardless of this listener's port.
      // This exact private response never reads, reflects, forwards or persists Cookie values.
      entered = true;
      const closed = terminal(socket);
      return Object.freeze({
        ready: challenge?.returned ?? Promise.resolve(),
        closed,
        response,
        complete(observed: boolean) {
          try {
            current();
            if (!observed || !socket.observedClosed) throw new BrokerError('CLEANUP_UNVERIFIED');
            resolve();
          } catch (value) {
            fail(value);
            throw value;
          }
        },
        fail,
      });
    },
    fail,
    close() {
      fail(new BrokerError('CLOSED'));
    },
  });
}
