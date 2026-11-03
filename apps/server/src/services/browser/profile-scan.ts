/** Tap-only browser metadata discovery. No browser profile contents are opened. */
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { browserUserHome } from './browser-user-home.js';
import type {
  YourBrowserKind,
  YourBrowserProfile,
  YourBrowserScan,
} from '@dorkos/shared/your-browser';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PROFILES = 100;
const DIRECTORIES = /^(?:Default|Profile [0-9]+)(?![\s\S])/;
const BROWSERS: YourBrowserKind[] = ['chrome', 'edge', 'brave'];

/** Fixed paths only: no field in Local State can choose a file to read. */
export function browserStatePaths(home: string, platform: string): string[] {
  const roots: Record<string, string[]> = {
    darwin: [
      'Library/Application Support/Google/Chrome',
      'Library/Application Support/Microsoft Edge',
      'Library/Application Support/BraveSoftware/Brave-Browser',
    ],
    win32: [
      'AppData/Local/Google/Chrome/User Data',
      'AppData/Local/Microsoft/Edge/User Data',
      'AppData/Local/BraveSoftware/Brave-Browser/User Data',
    ],
    linux: [
      '.config/google-chrome',
      '.config/microsoft-edge',
      '.config/BraveSoftware/Brave-Browser',
    ],
  };
  return (roots[platform] ?? []).map((root) => path.join(home, root, 'Local State'));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bound and strip control characters; these fields are untrusted display text. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = value
    // eslint-disable-next-line no-control-regex -- intentionally remove untrusted control characters from display text
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    .slice(0, max);
  return result || undefined;
}

/** Parse metadata without following avatar URLs or opening any profile files. */
export function parseBrowserState(json: string, browser: YourBrowserKind): YourBrowserProfile[] {
  const state: unknown = JSON.parse(json);
  if (!record(state) || !record(state.profile) || !record(state.profile.info_cache)) return [];
  const profiles: YourBrowserProfile[] = [];
  for (const [directory, metadata] of Object.entries(state.profile.info_cache)) {
    if (directory.length > 64 || !DIRECTORIES.test(directory) || !record(metadata)) continue;
    const email = text(metadata.user_name, 254);
    profiles.push({
      browser,
      directory,
      displayName: text(metadata.name, 120) ?? directory,
      ...(email ? { email } : {}),
    });
    if (profiles.length === MAX_PROFILES) break;
  }
  return profiles;
}

/** Bounded regular-file read. Refuse a symlink or device instead of following it. */
async function readLocalState(filename: string, home: string): Promise<string> {
  // Canonicalize the home prefix (e.g. macOS /var -> /private/var), but allow
  // no redirection below it, including a symlink in an ancestor browser folder.
  const expectedPath = path.join(await realpath(home), path.relative(home, filename));
  if ((await realpath(filename)) !== expectedPath) throw new Error('Browser metadata redirected');
  const expected = await lstat(filename);
  if (!expected.isFile() || expected.isSymbolicLink() || expected.size > MAX_BYTES)
    throw new Error('Unreadable browser metadata');
  const file = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = await file.stat();
    // Read the exact file inspected above, even on platforms without O_NOFOLLOW.
    if (
      !stat.isFile() ||
      stat.size > MAX_BYTES ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino
    )
      throw new Error('Browser metadata changed');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used > MAX_BYTES) throw new Error('Browser metadata too large');
    return buffer.subarray(0, used).toString('utf8');
  } finally {
    await file.close();
  }
}

/** Called only by the person-only POST route, never at startup or on a timer. */
export async function scanBrowserProfiles(
  options: {
    home?: string;
    platform?: string;
    read?: (filename: string) => Promise<string>;
  } = {}
): Promise<YourBrowserScan> {
  const home = options.home ?? browserUserHome();
  const paths = browserStatePaths(home, options.platform ?? process.platform);
  const result: YourBrowserScan = { supported: paths.length > 0, profiles: [], unreadable: [] };
  for (const [index, filename] of paths.entries()) {
    const browser = BROWSERS[index];
    try {
      result.profiles.push(
        ...parseBrowserState(
          await (options.read ? options.read(filename) : readLocalState(filename, home)),
          browser
        )
      );
    } catch (error) {
      // Missing browsers are ordinary; malformed/inaccessible ones get a safe, path-free notice.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.unreadable.push(browser);
    }
  }
  return result;
}
