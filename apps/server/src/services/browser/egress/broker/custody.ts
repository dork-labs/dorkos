import type { BrokerIssuer } from './issuer.js';
import type { Charge } from './ledger.js';
import type { OwnedSocket } from './transport.js';
import { bounded } from './clock.js';
/** Cleanup requests never certify closure or forgive unsettled acquisitions. */
export function circuitCustody(issuer: BrokerIssuer, charge: Charge) {
  const sockets = new Map<object, { socket: OwnedSocket; closed: boolean }>();
  const waiting = new Set<() => void>();
  const released = new Set<() => void>();
  let stopped = false;
  let chargeReleased = false;
  let cleanupUncertain = false;
  let closing: Promise<boolean> | undefined;
  const settled = () => {
    if (chargeReleased) return true;
    if (issuer.ledger.release(charge)) {
      chargeReleased = true;
      for (const done of waiting) done();
      waiting.clear();
      for (const callback of released) callback();
      released.clear();
      return true;
    }
    return false;
  };
  const api = {
    onReleased(callback: () => void) {
      released.add(callback);
    },
    track(socket: OwnedSocket) {
      if (sockets.has(socket.identity)) return;
      const record = { socket, closed: false };
      sockets.set(socket.identity, record);
      const observed = issuer.ledger.socket(charge, socket.identity);
      socket.onClose(() => {
        record.closed = true;
        try {
          observed();
        } finally {
          // A registered endpoint's actual close synchronously retires circuit admission.
          if (stopped) settled();
          else void api.close();
        }
      });
      if (socket.observedClosed) {
        record.closed = true;
        observed();
        void api.close();
      }
      socket.onError(() => {
        void api.close();
      });
      if (stopped) {
        try {
          socket.destroy();
        } catch {
          cleanupUncertain = true;
          /* Retain exact socket custody. */
        }
      }
    },
    pending() {
      const done = issuer.ledger.pending(charge);
      return () => {
        done();
        if (stopped) settled();
      };
    },
    stopped: () => stopped,
    close(): Promise<boolean> {
      if (closing) return closing;
      stopped = true;
      let resolve!: (closed: boolean) => void;
      closing = new Promise<boolean>((done) => {
        resolve = done;
      });
      for (const { socket, closed } of sockets.values())
        if (!closed) {
          try {
            socket.destroy();
          } catch {
            cleanupUncertain = true;
            /* Continue every owned cleanup, retaining its charge. */
          }
        }
      if (settled()) {
        resolve(true);
        return closing;
      }
      const task = new Promise<void>((done) => waiting.add(done));
      bounded(task, issuer.limits.cleanupMs).then(
        () => resolve(true),
        () => {
          cleanupUncertain = true;
          resolve(false);
        }
      );
      return closing;
    },
    observed() {
      return stopped && sockets.size > 0 && [...sockets.values()].every((r) => r.closed);
    },
    isCustodyKnown() {
      return (
        !cleanupUncertain &&
        [...sockets.values()].every(
          (record) => record.closed || record.socket.isCustodyKnown?.() === true
        )
      );
    },
  };
  return api;
}
export type CircuitCustody = ReturnType<typeof circuitCustody>;
