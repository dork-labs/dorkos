import type { BrokerIssuer, RunHandle } from './issuer.js';
import type { OwnedSocket } from './transport.js';
import { circuitCustody, type CircuitCustody } from './custody.js';
import type { Charge } from './ledger.js';
/** A pre-acquisition charge, accepted only by the issuing broker's identity map. */
export interface SocketAdmission {
  readonly kind: 'socket-admission';
}
/** All prepared subjects remain owned until actual settlement and every socket close. */
export interface ClientRecord {
  charge: Charge;
  custody: CircuitCustody;
  started: boolean;
  local: boolean;
  close: () => Promise<boolean>;
  timers: Set<ReturnType<typeof setTimeout>>;
}
/**
 * Per-client admission reserves before injected socket acquisition. A Node
 * listener-owned intake separately retains accepted originals before this call;
 * its aggregate listener charge survives refusal until every original closes.
 */
export function createIntake(options: {
  issuer: BrokerIssuer;
  run: RunHandle;
  check: () => unknown;
  isStopped: () => boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  schedule: (ms: number, action: () => void) => ReturnType<typeof setTimeout>;
}) {
  const { issuer, run, check, isStopped, timers, schedule } = options;
  const clients = new Map<object, ClientRecord>(),
    prepared = new Map<SocketAdmission, ClientRecord>();
  const records = new WeakMap<
    SocketAdmission,
    { record: ClientRecord; done: () => void; discovered: () => void; socket?: object }
  >();
  return {
    clients,
    prepared,
    closeLocal() {
      for (const c of prepared.values()) if (c.local) void c.close();
    },
    checkLocal(coverage: () => void) {
      if (![...prepared.values()].some((c) => c.local)) return;
      try {
        coverage();
      } catch {
        for (const c of prepared.values()) if (c.local) void c.close();
      }
    },
    reserve(): SocketAdmission | undefined {
      let charge: Charge;
      try {
        check();
        if (isStopped()) return undefined;
        charge = issuer.ledger.reserve('unauthenticated', run);
      } catch {
        return undefined;
      }
      const custody = circuitCustody(issuer, charge),
        done = custody.pending(),
        discovered = issuer.ledger.socket(charge, {});
      const record: ClientRecord = {
        charge,
        custody,
        started: false,
        local: false,
        close: () => custody.close(),
        timers: new Set(),
      };
      const slot = Object.freeze({ kind: 'socket-admission' as const });
      prepared.set(slot, record);
      records.set(slot, { record, done, discovered });
      custody.onReleased(() => {
        prepared.delete(slot);
        for (const [key, value] of clients) if (value === record) clients.delete(key);
        for (const timer of record.timers) {
          clearTimeout(timer);
          timers.delete(timer);
        }
        record.timers.clear();
      });
      record.timers.add(
        schedule(issuer.limits.headerMs, () => {
          if (!record.started) void record.close();
        })
      );
      return slot;
    },
    register(slot: SocketAdmission, socket: OwnedSocket): boolean {
      const subject = records.get(slot);
      if (!subject) return false;
      if (subject.socket) {
        if (subject.socket !== socket.identity) void subject.record.close();
        return false;
      }
      subject.socket = socket.identity;
      const { record } = subject;
      clients.set(socket.identity, record);
      try {
        record.custody.track(socket);
        socket.onClose(() => {
          void record.close();
        });
        subject.discovered();
      } catch {
        void record.close();
      } finally {
        subject.done();
      }
      if (isStopped() || record.custody.stopped()) {
        void record.close();
        return false;
      }
      return true;
    },
  };
}
