/** Retain each original synchronous cleanup outcome, including a falsy throw. */
export function retainCleanup(cleanup: () => void): () => void {
  let attempted = false;
  let first: { value: unknown } | undefined;
  return () => {
    if (!attempted) {
      attempted = true;
      try {
        cleanup();
      } catch (value) {
        first = { value };
      }
    }
    if (first) throw first.value;
  };
}

/** Enter every independent cleanup before propagating the first exact failure. */
export function releaseTogether(cleanups: readonly (() => void)[]): void {
  let first: { value: unknown } | undefined;
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (value) {
      first ??= { value };
    }
  }
  if (first) throw first.value;
}
