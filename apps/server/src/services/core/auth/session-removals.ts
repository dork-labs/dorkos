/** Session removals stay inside the server; authentication ids never enter global streams. */
type RemovedSession = Readonly<{ sessionId: string; userId: string }>;

/** Private lifecycle subscribers notified after Better Auth removes a stored session. */
export class AuthSessionRemovals {
  private readonly listeners = new Set<(session: RemovedSession) => void>();

  subscribe(listener: (session: RemovedSession) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Notify every retained subscriber, preserving the first original failure, including falsy. */
  remove(session: RemovedSession): void {
    const original = Object.freeze({ sessionId: session.sessionId, userId: session.userId });
    let failure: { value: unknown } | undefined;
    for (const listener of [...this.listeners]) {
      try {
        listener(original);
      } catch (value) {
        failure ??= { value };
      }
    }
    if (failure) throw failure.value;
  }
}

export const authSessionRemovals = new AuthSessionRemovals();
