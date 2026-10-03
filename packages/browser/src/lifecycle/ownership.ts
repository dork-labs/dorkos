import type { BrowserContext } from 'playwright-core';
import type { BrowserStopGate } from './stop.js';
import { createBrowserStopGate } from './stop.js';
import type { BrowserRecord } from './records.js';
import type { InputOwnerSlot } from './input-owner.js';

/** Exact parent custody; a deadline bounds waiting, never the underlying acquisition. */
export interface BrowserLifetime {
  readonly gate: BrowserStopGate;
  readonly inputs: Map<object, InputOwnerSlot>;
  readonly pending: Set<Promise<void>>;
  readonly contextCloses: Map<BrowserContext, Promise<void>>;
  readonly proxyCloses: Map<object, Promise<void>>;
  retire?: () => void;
  parentEnd?: number;
  inputEnd?: number;
  uncertain: boolean;
  closeFailed: boolean;
  releasePending: boolean;
}

/** Install before the first acquisition; absence is never inferred as empty ownership. */
export function createBrowserLifetime(browserId: string, generation: number): BrowserLifetime {
  return {
    gate: createBrowserStopGate(browserId, generation),
    inputs: new Map(),
    pending: new Set(),
    contextCloses: new Map(),
    proxyCloses: new Map(),
    uncertain: false,
    closeFailed: false,
    releasePending: false,
  };
}

/** Register the unsettled slot before observing an external factory or invoking its method. */
export function ownOperation<T>(
  record: BrowserRecord,
  enter: () => T | PromiseLike<T>,
  accept?: (value: T) => void
): Promise<T> {
  const owner = record.lifetime;
  let settle!: () => void;
  const slot = new Promise<void>((done) => {
    settle = done;
  });
  owner.pending.add(slot);
  const done = () => {
    owner.pending.delete(slot);
    settle();
  };
  try {
    return Promise.resolve(enter()).then(
      (value) => {
        try {
          accept?.(value);
          return value;
        } finally {
          done();
        }
      },
      (error: unknown) => {
        done();
        throw error;
      }
    );
  } catch (error) {
    done();
    return Promise.reject(error);
  }
}

/** Attempt every exact owned close once, including handles returned after the parent wait. */
export function closeOwned(
  record: BrowserRecord,
  kind: 'context' | 'proxy',
  subject: BrowserContext | NonNullable<BrowserRecord['proxy']>
): Promise<void> {
  const owner = record.lifetime;
  const map: Map<object, Promise<void>> = kind === 'context'
    ? owner.contextCloses
    : owner.proxyCloses;
  const prior = map.get(subject);
  if (prior) return prior;
  let resolve!: () => void, reject!: (error: unknown) => void;
  const shared = new Promise<void>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  map.set(subject, shared);
  void shared.catch(() => {});
  void ownOperation(record, () => {
    const call = subject.close;
    return Reflect.apply(call, subject, []) as Promise<void>;
  }).then(resolve, (error: unknown) => {
    owner.closeFailed = true;
    reject(error);
  });
  return shared;
}

/** Late context possession cannot grant attribution rights or replace an installed close result. */
export function acceptContext(record: BrowserRecord, context: BrowserContext): void {
  record.context = context;
  if (record.status !== 'opening' || record.lifetime.gate.stopped) {
    record.lifetime.uncertain = true;
    void closeOwned(record, 'context', context).catch(() => {});
  }
}
