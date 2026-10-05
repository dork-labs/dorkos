import type { BrowserContext } from 'playwright-core';

const retainedOwners = new Set<object>();
/** Test-only original context custody. A bounded wait never discards an original. */
export function createFixtureContextCustody() {
  const contexts = new Map<BrowserContext, Promise<void> | null>();
  const launches = new Set<Promise<BrowserContext>>();
  let retiring = false,
    failed = false,
    firstCause: unknown,
    cleanupEnd: number | undefined;
  const fail = (error: unknown) => {
    if (!failed) firstCause = error;
    failed = true;
  };
  const close = (context: BrowserContext): Promise<void> => {
    if (!contexts.has(context)) throw new Error('FOREIGN_FIXTURE_CONTEXT');
    const prior = contexts.get(context);
    if (prior) return prior;
    const original = Promise.resolve().then(() => context.close());
    contexts.set(context, original);
    void original.then(() => contexts.delete(context), fail);
    return original;
  };
  const owner = {
    acquire(factory: () => Promise<BrowserContext>): Promise<BrowserContext> {
      if (retiring || failed) return Promise.reject(new Error('FIXTURE_ACQUISITION_CLOSED'));
      // Register before invoking the actual launch factory, including reentrant timeout cleanup.
      const original = Promise.resolve().then(factory);
      launches.add(original);
      void original.then(
        (context) => {
          contexts.set(context, null);
          launches.delete(original);
          if (retiring) void close(context).catch(() => {});
        },
        (error) => {
          launches.delete(original);
          fail(error);
        }
      );
      return original;
    },
    close,
    async cleanup(waitMilliseconds = 2000) {
      retiring = true;
      cleanupEnd ??= performance.now() + waitMilliseconds;
      for (const context of contexts.keys()) void close(context).catch(() => {});
      const originals = Promise.allSettled(
        [...launches, ...contexts.values()].filter((value) => value !== null)
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          originals,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.max(0, cleanupEnd! - performance.now()));
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const state =
        !failed && launches.size === 0 && contexts.size === 0
          ? ('closed' as const)
          : ('held' as const);
      if (state === 'closed') retainedOwners.delete(owner);
      return { state, firstCause };
    },
  };
  retainedOwners.add(owner);
  return owner;
}
