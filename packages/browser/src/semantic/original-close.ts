/** Original native acquisitions/commands only; reply writes never imply native work. */
export class SemanticNativeWork {
  private readonly entered = new Set<Promise<unknown>>();
  /** Preregister before an original producer may synchronously reenter closure. */
  run<T>(producer: () => Promise<T>): Promise<T> {
    let accept!: (value: T) => void, refuse!: (reason: unknown) => void;
    const original = new Promise<T>((resolve, reject) => {
      accept = resolve;
      refuse = reject;
    });
    this.entered.add(original);
    try {
      Promise.resolve(producer()).then(accept, refuse);
    } catch (reason) {
      refuse(reason);
    }
    void original.then(
      () => this.entered.delete(original),
      () => this.entered.delete(original)
    );
    return original;
  }
  /** Observe only whether an exact original native operation has not returned. */
  pending(): boolean {
    return this.entered.size !== 0;
  }
}

/**
 * Private worker closure order. The captured SDK close disconnects only this
 * semantic connection; it does not end the independently owned native browser.
 */
export async function settleSemanticOriginals(
  entered: boolean,
  tail: Promise<unknown>,
  originals: readonly Promise<unknown>[],
  metadataClose: () => Promise<unknown>,
  readerClose: () => Promise<unknown>,
  connectionClose: () => Promise<unknown>
): Promise<readonly PromiseSettledResult<unknown>[]> {
  // Reserve before the original receiver may reenter; never wait for a command
  // which itself requires this connection interruption to return.
  const interrupted = entered ? Promise.resolve().then(connectionClose) : undefined;
  const returned = await Promise.allSettled([
    tail,
    ...originals,
    ...(interrupted ? [interrupted] : []),
  ]);
  const cleanup = await Promise.allSettled([
    Promise.resolve().then(metadataClose),
    Promise.resolve().then(readerClose),
  ]);
  const disconnected = interrupted
    ? []
    : await Promise.allSettled([Promise.resolve().then(connectionClose)]);
  return [...returned, ...cleanup, ...disconnected];
}
