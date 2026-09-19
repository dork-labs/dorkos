/**
 * Reading the signed-in session out of a running agent browser, and keeping it
 * on disk as the Playwright storage-state file agents start from.
 *
 * The file holds live cookies. It is written `0600`, atomically (a reader sees
 * the old file or the new one, never half of one), and nothing in this module
 * ever prints a value from it.
 *
 * @module lib/agent-browser/storage-state
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  StorageStateSchema,
  type StorageState,
  type StorageStateCookie,
  type StorageStateOrigin,
} from '@dorkos/shared/agent-browser';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import type { CdpPipe } from './cdp-pipe.js';

/** A cookie as Chrome's `Storage.getCookies` reports it (the fields used here). */
export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  session?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
}

/**
 * Convert one Chrome cookie to Playwright's storage-state shape, exactly as
 * Playwright's own Chromium `storageState()` does, so the file loads the same
 * way a Playwright-written one would: a missing `sameSite` reads as `Lax`, a
 * session cookie keeps `expires: -1`, and a partitioned cookie keeps its
 * top-level site.
 *
 * @param cookie - The cookie from `Storage.getCookies`.
 */
export function toStorageStateCookie(cookie: CdpCookie): StorageStateCookie {
  const copy: StorageStateCookie = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.session || cookie.expires <= 0 ? -1 : cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite ?? 'Lax',
  };
  if (cookie.partitionKey) {
    copy.partitionKey = cookie.partitionKey.topLevelSite;
    copy._crHasCrossSiteAncestor = cookie.partitionKey.hasCrossSiteAncestor;
  }
  return copy;
}

/** The expression run in each open tab: its origin and its `localStorage`, as JSON. */
const READ_PAGE_STORAGE = `JSON.stringify({
  origin: location.origin,
  localStorage: Object.keys(localStorage).map((name) => ({ name, value: localStorage.getItem(name) ?? '' })),
})`;

/**
 * Read the page storage (`localStorage`) of every open web tab. A page's own
 * storage can only be read from inside a page at that origin, which is why the
 * agent browser is saved while it is open: tabs closed before saving take
 * their page storage with them (cookies are unaffected).
 *
 * A tab that refuses (a crashed renderer, a page that navigated away mid-read)
 * is skipped rather than failing the save.
 */
async function readOpenTabStorage(cdp: CdpPipe): Promise<StorageStateOrigin[]> {
  const { targetInfos } = await cdp.send<{
    targetInfos: Array<{ targetId: string; type: string; url: string }>;
  }>('Target.getTargets');
  const origins = new Map<string, StorageStateOrigin>();
  for (const target of targetInfos) {
    if (target.type !== 'page' || !/^https?:\/\//.test(target.url)) continue;
    let sessionId: string | undefined;
    try {
      ({ sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      }));
      const { result } = await cdp.send<{ result: { value?: string } }>(
        'Runtime.evaluate',
        { expression: READ_PAGE_STORAGE, returnByValue: true },
        sessionId,
        5_000
      );
      if (!result.value) continue;
      const read = JSON.parse(result.value) as StorageStateOrigin;
      if (read.localStorage.length > 0 && !origins.has(read.origin)) {
        origins.set(read.origin, read);
      }
    } catch {
      // Skipped: see the function doc.
    } finally {
      if (sessionId) await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
  }
  return [...origins.values()];
}

/**
 * Read the whole signed-in session from a running agent browser: every cookie
 * in the profile, and the page storage of every open web tab.
 *
 * @param cdp - The agent browser's debugging pipe.
 * @param options - `pageStorage: false` skips the tabs (a background pass has none).
 */
export async function collectStorageState(
  cdp: CdpPipe,
  options: { pageStorage?: boolean } = {}
): Promise<StorageState> {
  const { cookies } = await cdp.send<{ cookies: CdpCookie[] }>('Storage.getCookies');
  const origins = options.pageStorage === false ? [] : await readOpenTabStorage(cdp);
  return { cookies: cookies.map(toStorageStateCookie), origins };
}

/**
 * Write the saved session: `0600`, atomically, parent folder `0700`.
 *
 * @param file - The storage-state path.
 * @param state - What to save.
 */
export async function writeStorageState(file: string, state: StorageState): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** Thrown when the saved session file exists but cannot be read as one. */
export class UnreadableStorageStateError extends Error {
  constructor(file: string) {
    super(
      `The saved session file at ${file} is not a browser session DorkOS can read. ` +
        'Run `dorkos browser login` to save a fresh one (it replaces this file).'
    );
    this.name = 'UnreadableStorageStateError';
  }
}

/**
 * Read the saved session, or `null` when there is none yet.
 *
 * @param file - The storage-state path.
 * @throws {UnreadableStorageStateError} When the file is there but is not a session.
 */
export function readStorageState(file: string): StorageState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return StorageStateSchema.parse(JSON.parse(raw));
  } catch {
    throw new UnreadableStorageStateError(file);
  }
}
