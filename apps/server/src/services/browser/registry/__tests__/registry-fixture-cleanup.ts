type Resource = {
  readonly original: object;
  readonly enter: () => Promise<unknown>;
  operation: Promise<unknown> | null;
  state: 'unentered' | 'pending' | 'settled' | 'failed';
};

/** Private fixture cleanup owns exact originals, enters peers independently and never retries raw closes. */
export function ownRegistryFixtureCleanup() {
  const resources = new Map<object, Resource>();
  let stopping = false,
    held = false,
    failed = false,
    first: unknown;
  let finishPromise: Promise<ReturnType<typeof snapshot>> | undefined;
  const fail = (error: unknown) => {
    held = true;
    if (!failed) {
      failed = true;
      first = error;
    }
  };
  const snapshot = () => ({
    stopping,
    held,
    failed,
    first,
    pending: [...resources.values()].filter(
      (entry) => entry.state === 'pending' || entry.state === 'unentered'
    ).length,
    resources: resources.size,
  });
  const enter = (entry: Resource) => {
    if (entry.operation) return;
    entry.state = 'pending';
    entry.operation = Promise.resolve().then(entry.enter);
    void entry.operation.then(
      () => {
        entry.state = 'settled';
      },
      (error) => {
        entry.state = 'failed';
        fail(error);
      }
    );
  };
  return Object.freeze({
    adopt(original: object, close: () => Promise<unknown>): void {
      if (resources.has(original)) return;
      const entry: Resource = { original, enter: close, operation: null, state: 'unentered' };
      resources.set(original, entry);
      if (stopping) {
        held = true;
        enter(entry); // A late original closes immediately, without restoring an earlier positive.
      }
    },
    isStopping: () => stopping,
    snapshot,
    finish(milliseconds = 5000): Promise<ReturnType<typeof snapshot>> {
      if (finishPromise) return finishPromise;
      stopping = true;
      for (const entry of resources.values()) enter(entry);
      const operations = [...resources.values()].map((entry) => entry.operation!);
      finishPromise = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.allSettled(operations),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('REGISTRY_ORIGINAL_CLEANUP_HELD')),
                milliseconds
              );
            }),
          ]);
        } catch (error) {
          fail(error);
        } finally {
          clearTimeout(timer);
        }
        // An acquisition delivered after entry may still own a pending original close.
        if (snapshot().pending > 0) fail(new Error('REGISTRY_ORIGINAL_CLEANUP_PENDING'));
        return snapshot();
      })();
      return finishPromise;
    },
  });
}
