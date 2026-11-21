import { LocalBrowserError } from '../errors.js';
import type { BrowserPageClosing } from '../leases/page-closing.js';

interface Identity {
  lifecycle: number;
  connectionId: string | null;
  sessionId: string | null;
  profileId: string | null;
  status: string;
}
interface Host {
  closing: BrowserPageClosing;
  identity(): Identity;
  disconnect(): Promise<unknown>;
  assertAuthority(): void;
}

/** Server-only close proof for one admitted Page; a disconnected state alone proves nothing. */
export interface HandoffCloseProof {
  completed(): boolean;
  close(): Promise<void>;
  assertClosed(): void;
}

/** Capture before waiting; only this lease's clean close may clear its connection and chat. */
export function captureHandoffClose(
  host: Host,
  expected: Pick<Identity, 'connectionId' | 'sessionId' | 'profileId'> = host.identity()
): HandoffCloseProof {
  const admitted = Object.freeze(host.identity());
  if (
    admitted.status !== 'connected' ||
    !admitted.connectionId ||
    admitted.connectionId !== expected.connectionId ||
    admitted.sessionId !== expected.sessionId ||
    admitted.profileId !== expected.profileId
  )
    throw changed();
  let receipt = host.closing.capture();
  let lifecycle = admitted.lifecycle;
  const assertClosed = () => {
    const current = host.identity();
    if (
      !receipt?.() ||
      current.lifecycle !== lifecycle ||
      current.connectionId !== null ||
      current.sessionId !== null ||
      current.status !== 'disconnected' ||
      current.profileId !== admitted.profileId
    )
      throw changed();
    host.assertAuthority();
  };
  return Object.freeze({
    completed() {
      if (!receipt?.()) return false;
      assertClosed();
      return true;
    },
    async close() {
      if (!receipt) {
        const current = host.identity();
        if (
          current.lifecycle !== admitted.lifecycle ||
          current.connectionId !== admitted.connectionId ||
          current.sessionId !== admitted.sessionId ||
          current.profileId !== admitted.profileId ||
          current.status !== 'connected'
        )
          throw changed();
        host.assertAuthority();
        const closing = host.disconnect();
        receipt = host.closing.capture();
        lifecycle = admitted.lifecycle + 1;
        await closing;
      }
      assertClosed();
    },
    assertClosed,
  });
}

function changed() {
  return new LocalBrowserError('site_changed', 'The page changed. Read it again before acting.');
}
