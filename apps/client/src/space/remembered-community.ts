const LAST_COMMUNITY_KEY = 'communityLastAuthorizedId';

/** Read one browser-storage value, treating blocked or missing storage as empty. */
export function readStorage(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

/** Write or remove one browser-storage value; without storage nothing is remembered. */
export function writeStorage(storage: () => Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {
    /* Without storage the chooser simply remembers nothing. */
  }
}

/** The community this browser last entered, a convenience that is never authority. */
export function readRememberedCommunity(): string | null {
  return readStorage(() => localStorage, LAST_COMMUNITY_KEY);
}

/** Remember an authorized canonical selection without treating it as authority. */
export function rememberCommunity(communityId: string): void {
  writeStorage(() => localStorage, LAST_COMMUNITY_KEY, communityId);
}

/** Forget the remembered community, as when it is gone or this browser signs out. */
export function forgetCommunity(): void {
  writeStorage(() => localStorage, LAST_COMMUNITY_KEY, null);
}
