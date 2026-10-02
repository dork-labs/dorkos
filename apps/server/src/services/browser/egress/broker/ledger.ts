import { BrokerError } from './errors.js';
import type { BrokerLimits } from './limits.js';
/** Opaque accounting identity; a copied object has no ledger authority. */
export interface Charge {
  readonly kind: 'broker-charge';
}
type Class = 'unauthenticated' | 'circuit' | 'listener' | 'principal' | 'permit';
interface RecordEntry {
  category: Class;
  browser?: object | string;
  pending: number;
  sockets: Map<object, boolean>;
  released: boolean;
}
/** Shared issuer custody; pending callbacks and unobserved close retain every reservation. */
export function createLedger(limits: Readonly<Record<keyof BrokerLimits, number>>) {
  const records = new Map<Charge, RecordEntry>();
  const browsers = new WeakMap<object, string>();
  const namespace = (browser?: object | string) =>
    typeof browser === 'object' ? (browsers.get(browser) ?? browser) : browser;
  const count = (category: Class, browser?: object | string) =>
    [...records.values()].filter(
      (r) => r.category === category && (!browser || r.browser === browser)
    ).length;
  const allowed = (category: Class, browser?: object | string) => {
    const cap =
      category === 'circuit'
        ? limits.globalCircuits
        : category === 'unauthenticated'
          ? limits.unauthenticated
          : category === 'listener'
            ? limits.listeners
            : category === 'principal'
              ? limits.principals
              : limits.permits;
    if (
      count(category) >= cap ||
      (category === 'circuit' && count(category, browser) >= limits.browserCircuits)
    )
      throw new BrokerError('QUOTA');
  };
  const get = (charge: Charge) => {
    const record = records.get(charge);
    if (!record || record.released) throw new BrokerError('CLOSED');
    return record;
  };
  const release = (charge: Charge) => {
    const r = records.get(charge);
    if (!r || r.released) return false;
    if (r.pending || [...r.sockets.values()].some((closed) => !closed)) return false;
    r.released = true;
    records.delete(charge);
    return true;
  };
  return Object.freeze({
    bindBrowser(handle: object, lifetime: string) {
      if (browsers.has(handle)) throw new BrokerError('CLOSED');
      browsers.set(handle, lifetime);
    },
    reserve(category: Class, browser?: object | string): Charge {
      browser = namespace(browser);
      allowed(category, browser);
      const charge = Object.freeze({ kind: 'broker-charge' as const });
      records.set(charge, { category, browser, pending: 0, sockets: new Map(), released: false });
      return charge;
    },
    transfer(charge: Charge, browser: object) {
      const r = get(charge);
      if (r.category !== 'unauthenticated') throw new BrokerError('CLOSED');
      const key = namespace(browser);
      allowed('circuit', key);
      r.category = 'circuit';
      r.browser = key;
    },
    pending(charge: Charge) {
      const r = get(charge);
      r.pending++;
      let settled = false;
      return () => {
        if (settled) return;
        settled = true;
        r.pending--;
      };
    },
    socket(charge: Charge, socket: object) {
      const r = get(charge);
      if (r.sockets.has(socket)) throw new BrokerError('CLOSED');
      r.sockets.set(socket, false);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        r.sockets.set(socket, true);
      };
    },
    release,
    ownedCircuits(browser: object) {
      return [...records.values()].filter(
        (r) =>
          r.browser === namespace(browser) &&
          (r.category === 'circuit' || r.category === 'unauthenticated')
      ).length;
    },
    snapshot() {
      return Object.freeze({
        charged: records.size,
        unauthenticated: count('unauthenticated'),
        circuits: count('circuit'),
        listeners: count('listener'),
        principals: count('principal'),
        permits: count('permit'),
        pending: [...records.values()].reduce((n, r) => n + r.pending, 0),
        unclosed: [...records.values()].reduce(
          (n, r) => n + [...r.sockets.values()].filter((c) => !c).length,
          0
        ),
      });
    },
  });
}
export type BrokerLedger = ReturnType<typeof createLedger>;
