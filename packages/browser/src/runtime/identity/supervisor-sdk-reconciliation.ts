import type { CDPSession } from 'playwright-core';

/** Exact original default Page validation. Cleanup is preregistered before session birth;
 * it never changes identity metadata or substitutes a returned SDK context. */
export async function acquireAndReconcileSupervisorOriginalSDK(
  acquireSession: () => Promise<CDPSession>,
  catalog: Readonly<{ id: string; context?: string }>,
  track: <T>(label: string, producer: () => Promise<T> | T) => Promise<T>,
  guard: () => void,
  note: (cause: unknown) => void,
  registerCleanup: (close: () => Promise<void>) => void
): Promise<void> {
  let session: CDPSession | undefined, detached: Promise<void> | undefined;
  let detachOriginal: (() => Promise<void>) | undefined;
  let sendOriginal: CDPSession['send'] | undefined;
  let acquisitionSettled!: () => void;
  const acquired = new Promise<void>((resolve) => {
    acquisitionSettled = resolve;
  });
  const close = () => {
    detached ??= track('whole.originalSDK.reconciliationCleanup', async () => {
      // A deadline cannot discharge the actual late acquisition or its exact original session.
      await acquired;
      if (session) {
        if (!detachOriginal) throw new Error('SUPERVISOR_SDK_DETACH_UNCAPTURED');
        await track('originalSDK.reconciliationDetach', detachOriginal);
      }
    });
    return detached;
  };
  registerCleanup(close); // The actual owner owns this route before any session producer.
  let first: Readonly<{ value: unknown }> | undefined;
  try {
    guard();
    session = await track('originalSDK.reconciliationSession', () => {
      guard();
      return acquireSession();
    });
    const detach = session.detach,
      send = session.send;
    if (typeof detach !== 'function' || typeof send !== 'function')
      throw new Error('SUPERVISOR_SDK_SESSION_UNAVAILABLE');
    detachOriginal = detach.bind(session);
    sendOriginal = send.bind(session);
    acquisitionSettled(); // Retain the returned session and originals before the freshness fence.
    guard();
    const observed = await track('originalSDK.Target.getTargetInfo', () => {
      guard();
      return sendOriginal!('Target.getTargetInfo');
    });
    guard();
    if (
      observed.targetInfo.targetId !== catalog.id ||
      observed.targetInfo.browserContextId !== catalog.context ||
      observed.targetInfo.url !== 'about:blank'
    )
      throw new Error('CHROME_FIXTURE_ORIGINAL_CONTEXT_CHANGED');
  } catch (value) {
    first = { value };
    note(value);
  } finally {
    acquisitionSettled();
  }
  try {
    await close();
  } catch (value) {
    if (!first) {
      first = { value };
      note(value);
    }
  }
  if (first) throw first.value;
}
