declare global {
  interface Window {
    __readDorkosInviteFragment?: () => string | null;
    __clearDorkosInviteFragment?: () => void;
  }
}

/** Read the synchronously captured invitation while the same-page exchange may still retry. */
export function readInviteFragment(): string | null {
  return window.__readDorkosInviteFragment?.() ?? null;
}

/** Erase the invitation from ephemeral page memory after the server accepts preflight. */
export function clearInviteFragment(): void {
  window.__clearDorkosInviteFragment?.();
}
