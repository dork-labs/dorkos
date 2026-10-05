/**
 * Where keep-awake is running, and which holder (if any) fits.
 *
 * Containers are detected up front, because a holder inside one holds nothing
 * that matters: the host decides when it sleeps. Whether the OS tool exists is
 * NOT checked here. It is learned by trying (an ENOENT on spawn), so there is
 * one truth about it rather than a `which` that can disagree with the spawn.
 *
 * @module keep-awake/environment
 */
import { existsSync, readFileSync } from 'node:fs';
import { caffeinateCommand } from './holders/macos-caffeinate.js';
import { systemdInhibitCommand } from './holders/linux-systemd-inhibit.js';
import { windowsExecutionStateCommand } from './holders/windows-execution-state.js';
import type { HolderCommand, Mechanism, UnsupportedReason } from './holders/types.js';

/** What {@link detectEnvironment} found. */
export interface EnvironmentReport {
  /** The operating system. */
  platform: NodeJS.Platform;
  /** Whether this looks like a container. */
  container: boolean;
  /** The mechanism that would hold the assertion, or `none`. */
  mechanism: Mechanism;
  /** Why nothing can hold it, when `mechanism` is `none`. */
  reason?: UnsupportedReason;
}

/** Injection seams for {@link detectEnvironment}. All default to the real thing. */
export interface EnvironmentOptions {
  /** The operating system. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Whether a path exists. */
  fileExists?: (path: string) => boolean;
  /** A file's contents, or null when it cannot be read. */
  readFile?: (path: string) => string | null;
  /** The environment variables. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Words in `/proc/1/cgroup` that mean PID 1 lives in a container. */
const CONTAINER_CGROUP_MARKERS = ['docker', 'containerd', 'kubepods', 'lxc'] as const;

/** The mechanism each supported platform uses. */
const MECHANISM_BY_PLATFORM: Partial<Record<NodeJS.Platform, Exclude<Mechanism, 'none'>>> = {
  darwin: 'caffeinate',
  linux: 'systemd-inhibit',
  win32: 'windows-execution-state',
};

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Whether this process runs inside a container: `/.dockerenv` exists, PID 1's
 * cgroup names a container runtime, or `$container` is set (podman,
 * systemd-nspawn).
 *
 * @param options - Injection seams.
 */
export function isContainer(options: EnvironmentOptions = {}): boolean {
  const fileExists = options.fileExists ?? existsSync;
  const readFile = options.readFile ?? readFileOrNull;
  // A library with no env.ts of its own: `$container` is the container
  // runtime's signal, read raw, and `options.env` is the seam tests use.
  // eslint-disable-next-line no-restricted-syntax
  const env = options.env ?? process.env;
  if (fileExists('/.dockerenv')) return true;
  if ((env.container ?? '').trim() !== '') return true;
  const cgroup = readFile('/proc/1/cgroup');
  return cgroup !== null && CONTAINER_CGROUP_MARKERS.some((marker) => cgroup.includes(marker));
}

/**
 * Work out which holder fits this computer, without spawning anything.
 *
 * @param options - Injection seams.
 */
export function detectEnvironment(options: EnvironmentOptions = {}): EnvironmentReport {
  const platform = options.platform ?? process.platform;
  if (isContainer(options)) {
    return { platform, container: true, mechanism: 'none', reason: 'container' };
  }
  const mechanism = MECHANISM_BY_PLATFORM[platform];
  if (!mechanism) return { platform, container: false, mechanism: 'none', reason: 'platform' };
  return { platform, container: false, mechanism };
}

/**
 * The command line for one holder of `mechanism`.
 *
 * @param mechanism - Which mechanism, from {@link detectEnvironment}.
 * @param watchPid - The process whose death must end the assertion.
 * @param ttlSec - caffeinate only: how long one holder lives before renewal.
 */
export function holderCommandFor(
  mechanism: Exclude<Mechanism, 'none'>,
  watchPid: number,
  ttlSec: number
): HolderCommand {
  switch (mechanism) {
    case 'caffeinate':
      return caffeinateCommand(watchPid, ttlSec);
    case 'systemd-inhibit':
      return systemdInhibitCommand(watchPid);
    case 'windows-execution-state':
      return windowsExecutionStateCommand(watchPid);
  }
}
