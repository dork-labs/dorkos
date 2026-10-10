/** Ordinary per-interaction timer DATA; turn identity and stream custody stay with the caller. */
export function createRoomWaitingGrace<T>(graceMs: number, report: (waiting: T) => void) {
  const waitingOn = new Map<string, ReturnType<typeof setTimeout>>();
  const resolve = (id: string): void => {
    const grace = waitingOn.get(id);
    if (grace === undefined) return;
    clearTimeout(grace);
    waitingOn.delete(id);
  };
  const clear = (): void => {
    for (const grace of waitingOn.values()) clearTimeout(grace);
    waitingOn.clear();
  };
  const schedule = (id: string, waiting: T): void => {
    const grace = setTimeout(() => {
      waitingOn.delete(id);
      report(waiting);
    }, graceMs);
    grace.unref?.();
    waitingOn.set(id, grace);
  };
  return { schedule, resolve, clear };
}
