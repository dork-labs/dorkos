/**
 * Which kind of DorkOS this server is: the Mac app, the Windows app, the npm
 * CLI, Homebrew, the Docker image, or a repo checkout.
 *
 * Agents need this to give the right advice. Updating the Mac app and updating
 * `npm i -g dorkos` are different steps, and some problems affect one kind
 * only. Before this, an agent could not tell them apart.
 *
 * ## Where the answer comes from
 *
 * Each launcher says what it is in `DORKOS_DISTRIBUTION`, and this module only
 * reads it. Nothing here guesses from folder names:
 *
 * - The desktop shell (`apps/desktop/src/main/server-spawn.ts`) sets `desktop`
 *   when packaged and `dev` when run from the repo, plus `DORKOS_DESKTOP_VERSION`.
 *   The platform decides Mac or Windows.
 * - The CLI (`packages/cli/src/cli.ts`) sets `npm`, `homebrew` or `dev` from
 *   where its own entry file lives, keeping only an inherited `docker`.
 * - The Docker image sets `docker` in its shared `served` stage.
 *
 * One fact overrides the variable: a server running from TypeScript source is a
 * checkout, whatever it inherited. That matters because agent shells inherit the
 * server's environment, so a `pnpm dev` started inside the Mac app would
 * otherwise call itself the Mac app. A bundle with no variable, or one this
 * build does not know, is `unknown`, never a guess.
 *
 * Read with {@link currentDistribution} at the moment of use. Every input is
 * fixed for the life of the process, so a restart onto a new version always
 * reports the new one, and nothing caches it anywhere else.
 *
 * @module lib/distribution
 */
import os from 'node:os';

import { env } from '../../env.js';
import { SERVER_VERSION } from '../version.js';

declare const __CLI_VERSION__: string | undefined;

/**
 * Whether this server runs from a built bundle (the CLI's or the desktop app's;
 * both inject `__CLI_VERSION__`) rather than from TypeScript source. Read here
 * rather than exported from `version.ts`, which many suites mock whole.
 */
const IS_BUNDLED_BUILD = typeof __CLI_VERSION__ !== 'undefined';

/** The kinds of DorkOS a server can be. */
export type DistributionKind =
  'desktop-mac' | 'desktop-windows' | 'npm' | 'homebrew' | 'docker' | 'dev' | 'unknown';

/** What this server knows about how it was installed. */
export interface Distribution {
  /** The install kind. */
  readonly kind: DistributionKind;
  /** The running server's version, the same one `get_server_info` reports. */
  readonly version: string;
  /** The CPU architecture, as Node names it (`arm64`, `x64`). */
  readonly arch: string;
  /** The desktop app's version, only when it differs from {@link version}. */
  readonly appVersion?: string;
  /** One plain line for people and agents, e.g. `DorkOS Mac app 0.126.3 (Apple Silicon)`. */
  readonly label: string;
}

/** The facts {@link resolveDistribution} decides from. Injected for tests. */
export interface DistributionFacts {
  /** `DORKOS_DISTRIBUTION` as the launcher set it. */
  readonly launcher: string | undefined;
  /** `DORKOS_DESKTOP_VERSION` as the desktop shell set it. */
  readonly desktopVersion: string | undefined;
  /** Whether the server runs from a built bundle rather than source. */
  readonly bundled: boolean;
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** `process.arch`. */
  readonly arch: string;
  /** The running server's version. */
  readonly version: string;
}

/** Launcher values that name a kind directly. `desktop` is mapped by platform. */
const DIRECT_KINDS: ReadonlySet<string> = new Set(['npm', 'homebrew', 'docker', 'dev']);

function kindFrom(facts: DistributionFacts): DistributionKind {
  if (!facts.bundled) return 'dev';
  const launcher = facts.launcher?.trim().toLowerCase();
  if (!launcher) return 'unknown';
  if (launcher === 'desktop') {
    if (facts.platform === 'darwin') return 'desktop-mac';
    if (facts.platform === 'win32') return 'desktop-windows';
    return 'unknown';
  }
  return DIRECT_KINDS.has(launcher) ? (launcher as DistributionKind) : 'unknown';
}

function archLabel(kind: DistributionKind, arch: string): string {
  if (kind === 'desktop-mac') {
    if (arch === 'arm64') return 'Apple Silicon';
    if (arch === 'x64') return 'Intel';
  }
  return arch;
}

const KIND_NAMES: Record<DistributionKind, string> = {
  'desktop-mac': 'DorkOS Mac app',
  'desktop-windows': 'DorkOS Windows app',
  npm: 'DorkOS npm package',
  homebrew: 'DorkOS Homebrew package',
  docker: 'DorkOS Docker image',
  dev: 'DorkOS dev checkout',
  unknown: 'DorkOS (install type unknown)',
};

/**
 * Decide the install kind from launcher facts. Pure: same facts, same answer.
 *
 * @param facts - What the launcher and the process say.
 * @returns The distribution, with its one-line label.
 */
export function resolveDistribution(facts: DistributionFacts): Distribution {
  const kind = kindFrom(facts);
  const isDesktop = kind === 'desktop-mac' || kind === 'desktop-windows';
  const desktopVersion = facts.desktopVersion?.trim();
  const appVersion =
    isDesktop && desktopVersion && desktopVersion !== facts.version ? desktopVersion : undefined;
  const label =
    `${KIND_NAMES[kind]} ${facts.version} (${archLabel(kind, facts.arch)})` +
    (appVersion ? `, app ${appVersion}` : '');
  return {
    kind,
    version: facts.version,
    arch: facts.arch,
    ...(appVersion ? { appVersion } : {}),
    label,
  };
}

/**
 * This server's distribution, read now from this process's own facts.
 *
 * @returns The distribution of the running server.
 */
export function currentDistribution(): Distribution {
  return resolveDistribution({
    launcher: env.DORKOS_DISTRIBUTION,
    desktopVersion: env.DORKOS_DESKTOP_VERSION,
    bundled: IS_BUNDLED_BUILD,
    platform: os.platform(),
    arch: os.arch(),
    version: SERVER_VERSION,
  });
}
