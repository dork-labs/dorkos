declare global {
  interface Window {
    __takeDorkosInviteFragment?: () => string | null;
  }
}

/** Consume the synchronously captured invitation from ephemeral page memory. */
export function takeInviteFragment(): string | null {
  return window.__takeDorkosInviteFragment?.() ?? null;
}
