import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Everything the two-Desktop Community acceptance run reads from its
 * environment, resolved once and validated before anything is built, launched
 * or created.
 *
 * The run builds and launches two packaged apps, starts two Community servers
 * and creates Postgres databases in Docker, so it refuses to do any of that
 * unless the person asked for it by name: {@link OPT_IN_VARIABLE} must be `1`.
 * Nothing in `pnpm test`, `pnpm verify` or CI sets it.
 *
 * With {@link HANDOFF_VARIABLE} it runs in remote mode instead: against a
 * community the live gate made and is holding, described by the gate's
 * `handoff.json`. Then it starts no Postgres and no Community server.
 *
 * @module community-two-desktop/config
 */

/** The variable that must be exactly `1` before the run does anything. */
export const OPT_IN_VARIABLE = 'DORKOS_TWO_DESKTOP_ACCEPTANCE';

/**
 * The variable that points a run at a held live community's `handoff.json`.
 * Read only after {@link OPT_IN_VARIABLE} is `1`.
 */
export const HANDOFF_VARIABLE = 'DORKOS_TWO_DESKTOP_COMMUNITY_HANDOFF';

/** The repository root, derived from this file's own location. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The resolved settings for one run. */
export interface RunConfig {
  /** The packaged DorkOS executable both people launch. */
  executablePath: string;
  /** Build the packaged app and the Community server before running. */
  build: boolean;
  /** Borrow this existing Postgres container instead of creating a throwaway one. */
  postgresContainer: string | null;
  /** Where each run's evidence folder is written. */
  outputRoot: string;
  /** Where each person's temporary home directory is created. */
  homeRoot: string;
  /** Keep the temporary homes after the run, for diagnosis. */
  keepHomes: boolean;
  /** The Playwright browser channel for the people's browsers (`''` = bundled Chromium). */
  browserChannel: string;
  /** The held community to run against, or `null` to start the run's own. */
  remote: RemoteHandoff | null;
  /** Whether the run starts Postgres and Community servers; never in remote mode. */
  startsInfra: boolean;
}

/** One account on the held community. */
export interface HandoffAccount {
  email: string;
  password: string;
}

/**
 * The live gate's `handoff.json`: a community it made and is holding, its
 * owner (person A here) and a second member (person B), both already in.
 */
export interface RemoteHandoff {
  /** The community's https origin. */
  origin: string;
  communityId: string;
  /** The channel both people already share. */
  channelId: string;
  owner: HandoffAccount;
  member: HandoffAccount;
  /** The invite the member joined with; only ever redacted, never used. */
  inviteLink: string;
}

/** An open handoff file: what it is, read through the same descriptor. */
export interface OpenedHandoff {
  isFile(): boolean;
  mode: number;
  read(): string;
  close(): void;
}

/** The file-system reads {@link readHandoff} makes, injectable for tests. */
export interface HandoffFs {
  /**
   * Open the file without following a symbolic link at its last component, so
   * the modes checked and the bytes read belong to one and the same file.
   * Throws `ELOOP` for a link.
   */
  open: (file: string) => OpenedHandoff;
  stat: (file: string) => { isDirectory(): boolean; mode: number };
}

const realFs: HandoffFs = {
  open: (file) => {
    // O_NONBLOCK: opening a named pipe for reading would otherwise wait for a
    // writer forever. Nonblocking changes nothing for a regular file, and the
    // isFile() check refuses anything else before a byte is read.
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let info;
    try {
      info = fstatSync(fd);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    return {
      isFile: () => info.isFile(),
      mode: info.mode,
      read: () => readFileSync(fd, 'utf8'),
      close: () => closeSync(fd),
    };
  },
  stat: (file) => statSync(file),
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Read and check the live gate's handoff file. It holds two passwords, so it
 * must be exactly as private as the gate made it: a regular file (not a link)
 * with mode `0600`, in a directory with mode `0700`. The file is opened once
 * with `O_NOFOLLOW` and checked through that descriptor, so the file whose
 * modes pass is the file that is read.
 *
 * The origin must be https. The one exception is a loopback origin
 * (`127.0.0.1`, `localhost`, `[::1]`), which is how the driver's own local
 * dry run exercises remote mode; nothing sent there leaves the machine.
 *
 * @param file - The handoff file's absolute path.
 * @param fs - The file-system reads, injectable for tests.
 * @throws Naming what is wrong, never the file's contents.
 */
export function readHandoff(file: string, fs: HandoffFs = realFs): RemoteHandoff {
  const refuse = (why: string) =>
    new Error(`Refusing ${HANDOFF_VARIABLE}: ${why}. Nothing was started.`);
  if (!path.isAbsolute(file)) throw refuse('the path must be absolute');
  let entry: OpenedHandoff;
  try {
    entry = fs.open(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // O_NOFOLLOW refuses a link at the last component with ELOOP (EMLINK on some BSDs).
    if (code === 'ELOOP' || code === 'EMLINK') throw refuse(`${file} is not a regular file`);
    throw refuse(`there is no file at ${file}`);
  }
  let raw: unknown;
  try {
    if (!entry.isFile()) throw refuse(`${file} is not a regular file`);
    const fileMode = entry.mode & 0o777;
    if (fileMode !== 0o600)
      throw refuse(`${file} has mode ${fileMode.toString(8).padStart(4, '0')}; it must be 0600`);
    const dir = path.dirname(file);
    const folder = fs.stat(dir);
    const dirMode = folder.mode & 0o777;
    if (!folder.isDirectory() || dirMode !== 0o700)
      throw refuse(`${dir} has mode ${dirMode.toString(8).padStart(4, '0')}; it must be 0700`);
    const text = entry.read();
    try {
      raw = JSON.parse(text);
    } catch {
      throw refuse(`${file} is not valid JSON`);
    }
  } finally {
    entry.close();
  }
  const body = (raw ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
  const account = (value: unknown) => {
    const record = (value ?? {}) as Record<string, unknown>;
    const email = text(record.email);
    const password = text(record.password);
    return email && password ? { email, password } : null;
  };
  const handoff = {
    origin: text(body.origin),
    communityId: text(body.communityId),
    channelId: text(body.channelId),
    owner: account(body.owner),
    member: account(body.member),
    inviteLink: text(body.inviteLink),
  };
  const missing = Object.entries(handoff)
    .filter(([, value]) => value === null)
    .map(([key]) => key);
  if (missing.length) throw refuse(`the file lacks ${missing.join(', ')}`);
  let origin: URL;
  try {
    origin = new URL(handoff.origin!);
  } catch {
    throw refuse('origin is not a URL');
  }
  const loopback = origin.protocol === 'http:' && LOOPBACK_HOSTS.has(origin.hostname);
  if (origin.protocol !== 'https:' && !loopback)
    throw refuse(`origin must be https, not ${origin.protocol.replace(':', '')}`);
  return { ...(handoff as RemoteHandoff), origin: origin.origin };
}

/**
 * Refuse unless the run was asked for explicitly.
 *
 * @param env - The environment to read.
 * @throws When the opt-in variable is anything but `1`.
 */
export function assertOptedIn(env: NodeJS.ProcessEnv): void {
  if (env[OPT_IN_VARIABLE] !== '1')
    throw new Error(
      `Refusing to run: this builds and launches two packaged DorkOS apps and uses Docker. ` +
        `Set ${OPT_IN_VARIABLE}=1 to run it on purpose.`
    );
}

/**
 * Resolve the run's settings from its environment and arguments.
 *
 * @param env - The environment to read.
 * @param argv - Command-line arguments after the script name.
 * @param platform - The host platform and architecture, injectable for tests.
 * @param fs - The file-system reads the handoff check makes, injectable for tests.
 * @throws When the run was not opted into, the handoff file is unsafe or
 *   incomplete, or no packaged app can exist here.
 */
export function readRunConfig(
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
  platform: { os: NodeJS.Platform; arch: string } = { os: process.platform, arch: process.arch },
  fs: HandoffFs = realFs
): RunConfig {
  assertOptedIn(env);
  const handoffPath = env[HANDOFF_VARIABLE]?.trim();
  const remote = handoffPath ? readHandoff(handoffPath, fs) : null;
  const customApp = env.DORKOS_TWO_DESKTOP_APP?.trim();
  if (!customApp && (platform.os !== 'darwin' || platform.arch !== 'arm64'))
    throw new Error(
      'The default packaged app is the macOS Apple Silicon build. On another machine, ' +
        'set DORKOS_TWO_DESKTOP_APP to a packaged DorkOS executable.'
    );
  return {
    executablePath: path.resolve(
      customApp ||
        path.join(REPO_ROOT, 'apps/desktop/release/mac-arm64/DorkOS.app/Contents/MacOS/DorkOS')
    ),
    build: argv.includes('--build') || env.DORKOS_TWO_DESKTOP_BUILD === '1',
    postgresContainer: env.DORKOS_TWO_DESKTOP_PG_CONTAINER?.trim() || null,
    outputRoot: path.resolve(
      env.DORKOS_TWO_DESKTOP_OUT?.trim() || path.join(REPO_ROOT, '.temp/community-two-desktop')
    ),
    // Homes live outside the repository on purpose: an ancestor package.json
    // with "type": "module" changes how the packaged server loads extension code.
    homeRoot: path.resolve(env.DORKOS_TWO_DESKTOP_HOME_ROOT?.trim() || os.tmpdir()),
    keepHomes: env.DORKOS_TWO_DESKTOP_KEEP_HOMES === '1',
    browserChannel: env.DORKOS_TWO_DESKTOP_BROWSER_CHANNEL ?? 'chrome',
    remote,
    startsInfra: remote === null,
  };
}
