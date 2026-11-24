const pending = new Map<string, Promise<boolean>>();

/** The confirmation a first turn must wait for, if a settings write is in flight. */
export function getPendingSessionSettings(sessionId: string): Promise<boolean> | undefined {
  return pending.get(sessionId);
}

/** Keep concurrent settings writes independent, but let a first send wait for all of them. */
export function trackSessionSettings<T>(sessionId: string, request: Promise<T>): Promise<T> {
  const previous = pending.get(sessionId);
  const saved = request.then(
    () => true,
    () => false
  );
  const confirmation = previous
    ? Promise.all([previous, saved]).then((results) => results.every(Boolean))
    : saved;
  pending.set(sessionId, confirmation);
  void confirmation.then(() => {
    if (pending.get(sessionId) === confirmation) pending.delete(sessionId);
  });
  return request;
}
