/**
 * A shared sign-out and public-computer barrier. Storage is checked at the actual write, so a tab
 * whose storage event has not run yet cannot put the previous person's data back.
 * The generation also rejects saves queued before a later sign-in.
 * @module shared/lib/boot-cache-session
 */
import type { QueryClient } from '@tanstack/react-query';
import { clearBootCache, isBootQueryKey } from './boot-cache-keys';

/** Shared by every tab on this origin; survives an idle reload. */
export const BOOT_CACHE_SESSION_KEY = 'dorkos:boot-cache-session';
const SESSION_EVENT = 'dorkos:boot-cache-session-change';

/** Read the persistence generation, refusing storage that cannot be read. */
export function bootCacheSession(storage: Storage): string {
  try {
    return storage.getItem(BOOT_CACHE_SESSION_KEY) ?? '';
  } catch {
    return 'signed-out:unavailable';
  }
}

/** Whether a snapshot belongs to the current ordinary session, which may save data. */
export function canWriteBootCache(storage: Storage, generation: string): boolean {
  return (
    !generation.startsWith('signed-out:') &&
    !generation.startsWith('public:') &&
    bootCacheSession(storage) === generation
  );
}

/** Cancel reads before removing their answers; late completions cannot refill the cache. */
function removeBootQueries(queryClient: QueryClient): void {
  const predicate = (query: { queryKey: readonly unknown[] }) => isBootQueryKey(query.queryKey);
  void queryClient.cancelQueries({ predicate });
  // removeQueries alone leaves mounted observers holding their old result.
  // Reset first so the visible panel loses that result in the same turn.
  for (const query of queryClient.getQueryCache().findAll({ predicate })) query.reset();
  queryClient.removeQueries({ predicate });
}

function changeSession(
  queryClient: QueryClient,
  state: 'signed-out' | 'signed-in' | 'public'
): void {
  // randomUUID is unavailable on plain-HTTP Wi-Fi; this is a version,
  // not a credential, and getRandomValues works in that browser context too.
  const generation = `${state}:${crypto.getRandomValues(new Uint32Array(4)).join('-')}`;
  const mark = () => localStorage.setItem(BOOT_CACHE_SESSION_KEY, generation);
  try {
    // Set the barrier BEFORE removal events can trigger another persistence save.
    mark();
  } catch {
    // A full quota may prevent even this tiny marker. Free the old blob and
    // retry; permanently blocked storage still gets the in-memory cleanup.
    try {
      clearBootCache();
      mark();
    } catch {
      /* No usable storage. */
    }
  }
  // A public session can keep using its live answers; only disk persistence ends.
  if (state !== 'public') removeBootQueries(queryClient);
  try {
    clearBootCache();
  } catch {
    /* No usable storage to erase. */
  }
  window.dispatchEvent(new Event(SESSION_EVENT));
}

/** The single boot-cache cleanup used by manual and idle sign-out. */
export function forgetBootCacheOnSignOut(queryClient: QueryClient): void {
  changeSession(queryClient, 'signed-out');
}

/** Start fresh only after sign-in succeeds, never with the previous owner's answers. */
export function resumeBootCacheAfterSignIn(queryClient: QueryClient): void {
  // First owner setup has no previous session to forget. Resetting its live
  // config here would unmount the setup flow before it can finish enabling login.
  let generation: string;
  try {
    generation = bootCacheSession(window.localStorage);
  } catch {
    return;
  }
  if (generation.startsWith('signed-out:')) {
    changeSession(queryClient, 'signed-in');
  }
}

/**
 * Apply auth-generation changes before accepting new writes. Public sessions
 * retain live queries; other session changes clear them. Storage events cover
 * other tabs; the local event covers the tab that changed the session.
 */
export function observeBootCacheSession(
  queryClient: QueryClient,
  changed: () => void,
  storage: Storage = window.localStorage
): () => void {
  const onChange = () => {
    if (!bootCacheSession(storage).startsWith('public:')) removeBootQueries(queryClient);
    changed();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === BOOT_CACHE_SESSION_KEY || event.key === null) onChange();
  };
  window.addEventListener(SESSION_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(SESSION_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * Verify a redirect sign-in against a fresh session response. An older request
 * cannot lift a newer sign-out barrier, even when it returns a formerly valid cookie.
 */
export function bootCacheSignInCheck(queryClient: QueryClient): (publicComputer?: boolean) => void {
  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return () => {};
  }
  const generation = bootCacheSession(storage);
  return (publicComputer = false) => {
    if (generation !== bootCacheSession(storage)) return;
    if (publicComputer) {
      if (!generation.startsWith('public:')) changeSession(queryClient, 'public');
    } else if (generation.startsWith('public:')) {
      // Password success alone cannot lift a public barrier: only the server's
      // fresh session read proves that the new session may persist again.
      changeSession(queryClient, 'signed-in');
    } else if (generation.startsWith('signed-out:')) {
      resumeBootCacheAfterSignIn(queryClient);
    }
  };
}
