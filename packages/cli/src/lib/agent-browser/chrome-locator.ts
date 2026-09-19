/**
 * Find the Google Chrome (or Chromium) the agent browser runs on.
 *
 * The agent browser is the person's own system Chrome on a dedicated profile,
 * never a bundled or downloaded browser: that is what lets their password
 * manager's extension work normally while they sign in. So there is nothing to
 * install, only something to find, and a clear error when it is not there.
 *
 * Pure over an injected environment so every platform's search order is
 * testable on any machine.
 *
 * @module lib/agent-browser/chrome-locator
 */
import path from 'node:path';

/** What the locator reads from the machine. Injected so tests can describe any platform. */
export interface ChromeLocatorEnv {
  /** `process.platform`. */
  platform: NodeJS.Platform;
  /** The person's home directory (for per-user installs on macOS). */
  homeDir: string;
  /** `PATH`, used on Linux. */
  pathVar?: string;
  /** Windows `%LOCALAPPDATA%`. */
  localAppData?: string;
  /** Windows `%PROGRAMFILES%`. */
  programFiles?: string;
  /** Windows `%PROGRAMFILES(X86)%`. */
  programFilesX86?: string;
  /** Whether a file exists (and, for PATH lookups, is the thing we want). */
  exists: (file: string) => boolean;
}

/** Thrown when no Chrome is found. Its message is written for the person running the command. */
export class ChromeNotFoundError extends Error {
  constructor(
    /** Every place that was checked, in order. */
    readonly searched: string[]
  ) {
    super(
      [
        'Could not find Google Chrome on this computer.',
        'The agent browser is your own Chrome with its own profile, so your password manager works in it.',
        'Install Chrome from https://www.google.com/chrome/ and run this again,',
        'or point at a Chrome (or Chromium) you already have with --chrome <path>.',
        '',
        'Looked in:',
        ...searched.map((p) => `  ${p}`),
      ].join('\n')
    );
    this.name = 'ChromeNotFoundError';
  }
}

/**
 * Every place Chrome is looked for on this platform, in the order checked.
 * Google Chrome comes before Chromium: it is what most people have, and the
 * one their password manager is set up in.
 *
 * @param env - The machine to describe.
 */
export function chromeCandidates(env: ChromeLocatorEnv): string[] {
  if (env.platform === 'darwin') {
    const apps = [
      ['Google Chrome.app', 'Google Chrome'],
      ['Chromium.app', 'Chromium'],
    ];
    return apps.flatMap(([app, binary]) => [
      path.posix.join('/Applications', app!, 'Contents', 'MacOS', binary!),
      path.posix.join(env.homeDir, 'Applications', app!, 'Contents', 'MacOS', binary!),
    ]);
  }
  if (env.platform === 'win32') {
    const roots = [env.localAppData, env.programFiles, env.programFilesX86].filter(
      (root): root is string => Boolean(root)
    );
    return [
      ...roots.map((root) =>
        path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')
      ),
      ...roots.map((root) => path.win32.join(root, 'Chromium', 'Application', 'chrome.exe')),
    ];
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  const dirs = (env.pathVar ?? '').split(path.posix.delimiter).filter(Boolean);
  return [
    ...names.flatMap((name) => dirs.map((dir) => path.posix.join(dir, name))),
    '/opt/google/chrome/chrome',
  ];
}

/**
 * The Chrome to run: the one the person named, or the first standard install.
 *
 * @param env - The machine to search.
 * @param explicit - A path from `--chrome`, which wins when it exists.
 * @returns The absolute path to the Chrome executable.
 * @throws {ChromeNotFoundError} When nothing is found (or `explicit` does not exist).
 */
export function findChrome(env: ChromeLocatorEnv, explicit?: string): string {
  if (explicit) {
    if (env.exists(explicit)) return explicit;
    throw new ChromeNotFoundError([explicit]);
  }
  const candidates = chromeCandidates(env);
  const found = candidates.find((candidate) => env.exists(candidate));
  if (!found) throw new ChromeNotFoundError(candidates);
  return found;
}
