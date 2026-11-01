/**
 * The plain sign-in window: DorkOS's own Chromium on a profile folder, started
 * with no debugging channel at all, so no agent can drive or read it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readlinkSync, existsSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** How a plain Chromium ended. A spawn error reads as no code and no signal. */
export interface PlainChromiumExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** One running plain window. */
export interface PlainChromium {
  /** Resolves once the process has exited. */
  exited: Promise<PlainChromiumExit>;
  /** Quit the way a person would, so Chromium writes the profile out. */
  quit(): void;
}

/** Starts a plain Chromium. Tests swap it for a fake; nothing here launches Chrome in a test. */
export type PlainChromiumSpawner = (executable: string, args: string[]) => PlainChromium;

/** Flags that would open a debugging or automation channel. None may ever reach the window. */
export const FORBIDDEN_PLAIN_FLAGS = [
  '--remote-debugging-port',
  '--remote-debugging-pipe',
  '--remote-debugging-address',
  '--remote-allow-origins',
  '--enable-automation',
  '--headless',
] as const;

/**
 * The exact command line for a sign-in window.
 *
 * `--use-mock-keychain` and `--password-store=basic` are the same pair Playwright
 * passes the agent window, so both read the same cookies and neither touches the
 * macOS Keychain.
 *
 * @param profileFolder - The profile's folder under `browser-profiles/`.
 * @param url - The page to open, already checked.
 * @param site - The page's host, taken from `url`, for the window title.
 */
export function plainChromiumArgs(profileFolder: string, url: string, site: string): string[] {
  return [
    `--user-data-dir=${profileFolder}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    '--password-store=basic',
    `--window-name=Sign in to ${site} · DorkOS`,
    url,
  ];
}

/**
 * Turn off password saving in a profile, keeping its other preferences.
 *
 * With `--password-store=basic`, a saved password is readable from `Login Data`,
 * so the sign-in window must never save one. Cookies are unaffected.
 *
 * @param profileFolder - The profile's folder.
 */
export async function disablePasswordSaving(profileFolder: string): Promise<void> {
  const folder = path.join(profileFolder, 'Default');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, 'Preferences');
  let prefs: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      prefs = parsed as Record<string, unknown>;
  } catch {
    // No preferences yet, or unreadable ones: start from an empty set.
  }
  const profile =
    prefs.profile && typeof prefs.profile === 'object' && !Array.isArray(prefs.profile)
      ? (prefs.profile as Record<string, unknown>)
      : {};
  prefs.credentials_enable_service = false;
  prefs.profile = { ...profile, password_manager_enabled: false };
  await writeFile(file, JSON.stringify(prefs), { mode: 0o600 });
}

/**
 * Whether a Chromium still holds a profile.
 *
 * Chromium marks a held profile with `SingletonLock`, a symlink to
 * `<hostname>-<pid>` on macOS and Linux. A link left by a crash names a dead
 * pid and reads as free. Windows keeps `lockfile` open instead, so there the
 * test is whether it can be removed. Mirrors `packages/cli`'s `profileLock`,
 * which the server can't import.
 *
 * @param profileFolder - The profile's folder.
 * @param platform - Test seam for `process.platform`.
 */
export function profileHeld(
  profileFolder: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform === 'win32') {
    const lockfile = path.join(profileFolder, 'lockfile');
    if (!existsSync(lockfile)) return false;
    try {
      rmSync(lockfile);
      return false;
    } catch {
      return true;
    }
  }
  let target: string;
  try {
    target = readlinkSync(path.join(profileFolder, 'SingletonLock'));
  } catch {
    return false;
  }
  const pid = Number(target.slice(target.lastIndexOf('-') + 1));
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process is alive but not ours.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Start a real plain Chromium. Its output is ignored, and it gets no pipe beyond stdio. */
export const spawnPlainChromium: PlainChromiumSpawner = (executable, args) => {
  const child = spawn(executable, args, { stdio: 'ignore' });
  const exited = new Promise<PlainChromiumExit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null }));
  });
  return {
    exited,
    quit() {
      if (child.pid === undefined || child.exitCode !== null) return;
      // POSIX Chromium treats SIGTERM as quit and writes its profile out.
      // Windows has no SIGTERM, so ask it to close its windows instead.
      if (process.platform === 'win32')
        spawnSync('taskkill', ['/PID', String(child.pid)], { stdio: 'ignore' });
      else child.kill('SIGTERM');
    },
  };
};
