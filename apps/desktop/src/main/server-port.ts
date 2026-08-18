import net from 'node:net';
import path from 'node:path';
import log from 'electron-log';
import { resolveDataDirectory } from './dork-home';
import { readUserConfig } from './user-config';

/**
 * Choosing the port the desktop app's server listens on.
 *
 * The port is not an implementation detail here. It is the address in the MCP
 * client config, in the `curl` example, in the bookmark — DorkOS documents
 * `http://localhost:4242` throughout, and an address that changes every launch
 * is one nobody can write down. So the shell asks for the same port the CLI
 * uses, every time, and moves off it only when something else is holding it.
 *
 * **A pin and a default get opposite answers.** 4242 is a starting guess, so a
 * conflict there steps up to the next free port. A port someone *chose* —
 * `DORKOS_PORT`, or a `server.port` that differs from the schema default — is a
 * commitment to an address other tools are already configured against, so a
 * conflict there refuses and says so, exactly as the CLI does (the `EADDRINUSE`
 * handler in `apps/server/src/index.ts`). Quietly serving a pinned-5000 install
 * on 5001 would break every MCP client the person had set up, with nothing
 * anywhere reporting that anything went wrong.
 *
 * **Scanning on the default is a deliberate divergence from the CLI, not an
 * inconsistency to tidy up.** The CLI is strict in both cases, and it can
 * afford to be: someone who hits "port in use" reads it in the terminal they
 * just typed into and retries with `--port` a second later. A desktop user gets
 * a dialog and no app, with no equivalent affordance and often no terminal at
 * all. So the rule is about who expressed a preference rather than about which
 * surface you are on: when nobody has, the GUI adapts; when somebody has, both
 * surfaces are strict. Please do not "fix" the asymmetry by making the desktop
 * refuse on 4242.
 *
 * A random high port used to be the one thing making the desktop app harder to
 * reach than the CLI. That is no longer load-bearing: `/api` is behind a `Host`
 * guard (ADR 260726-232221) and the local-only routes read the socket peer
 * (ADR 260726-232222), so the port can now be chosen for people rather than for
 * obscurity.
 *
 * **This module decides a port; it does not decide whether the server may run.**
 * Two DorkOS servers sharing one data directory is a different question with a
 * different answer — the single-instance lock (ADR 260726-234122), which is
 * scoped to the directory, not the port. Someone running `dorkos` in a terminal
 * and then opening the app skips 4242 here, starts a child on 4243, and is
 * refused *there*, in the server's own words, naming the directory and the
 * process holding it. Nothing in this module second-guesses that: the scan is
 * silent on the success path and logs rather than dialogs, so the only
 * conflict a person is ever shown is the one that actually stopped them.
 *
 * @module main/server-port
 */

/**
 * The port DorkOS asks for when nobody has chosen one.
 *
 * The CLI's default, and the one the docs, the marketplace links, and every MCP
 * setup snippet name. Duplicated from `DEFAULT_PORT` in
 * `@dorkos/shared/constants` rather than imported, the same way
 * `packages/cli/src/cleanup-command.ts` duplicates it: electron-vite aliases
 * that package's subpath exports for the renderer bundle only, so the main
 * process is the wrong place to depend on them resolving.
 *
 * **It must stay equal to `UserConfigSchema`'s `server.port` default**
 * (`packages/shared/src/config-schema.ts`). {@link readPinnedPort} tells a
 * chosen port from an unchosen one by comparing against this value, so if the
 * two ever drift, every install's written-out default starts reading as a
 * deliberate pin.
 */
export const PREFERRED_SERVER_PORT = 4242;

/**
 * How many consecutive ports to try, counting the default one.
 *
 * Only ever applies to {@link PREFERRED_SERVER_PORT}; a pinned port is tried
 * once and then refused. Ten is chosen to be past the plausible and short of
 * the pointless. The realistic conflicts are a CLI server, a second DorkOS
 * against another data directory, and a dev instance — a handful, not a
 * hundred. Beyond that the problem is not "DorkOS is busy", it is "something is
 * occupying this range", and the honest answer is to say so.
 *
 * Deliberately *not* followed by an operating-system-assigned port as a last
 * resort. That is the behaviour this change removes; reinstating it in the
 * failure case would make the failure invisible and silently break the MCP
 * config the person had already written.
 */
export const PORT_SCAN_ATTEMPTS = 10;

/** Highest port number a TCP socket can bind. */
const MAX_PORT = 65535;

/**
 * Lowest port a normal user process may bind. Below this the operating system
 * wants administrator rights, and it is the floor `UserConfigSchema` already
 * enforces on `server.port`.
 */
const LOWEST_UNPRIVILEGED_PORT = 1024;

/**
 * The host the probe binds, matching what the child binds.
 *
 * The server listens on `DORKOS_HOST`, which the shell never sets, so it is
 * always `localhost` here. Probing the same name is what makes the answer
 * meaningful: a wildcard probe would report a port busy because some unrelated
 * interface holds it, and a probe of one fixed address could miss a holder that
 * `localhost` happens to resolve to.
 */
const PROBE_HOST = 'localhost';

/**
 * What a probe found.
 *
 * `forbidden` is kept apart from `in-use` because the two need different words
 * in front of a person: "quit whatever is using it" is unfollowable advice when
 * nothing is using it and the operating system simply will not hand it over.
 */
type PortAvailability = 'free' | 'in-use' | 'forbidden';

/** Where a preferred port came from. */
type PortSource = 'DORKOS_PORT' | 'config.json' | 'default';

/** The port DorkOS wants, and how strictly it wants it. */
export interface PreferredPort {
  /** The port itself. */
  port: number;
  /** Where it came from. `'default'` means nobody chose it. */
  source: PortSource;
}

/**
 * A start-up failure this module can explain completely.
 *
 * Every message thrown from here names the port, why it could not be had, and
 * the setting that changes it. The shell's generic "DorkOS couldn't start" box
 * otherwise leads with *"Try restarting the app"*, which is true of a crash and
 * flatly wrong here: a port someone pinned is still taken on the next launch,
 * and the whole premise of refusing was that this will not fix itself. `index.ts`
 * checks for this type and drops the lead-in rather than argue with the sentence
 * printed underneath it.
 */
export class PortUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortUnavailableError';
  }
}

/** Whether `value` is a port number a server could actually listen on. */
function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_PORT;
}

/**
 * Parse a port out of an environment variable.
 *
 * Accepts the full 1–65535 range `apps/server/src/env.ts` accepts for
 * `DORKOS_PORT`, privileged ports included. Someone who exports a value that
 * low has said something deliberate, and gets an accurate answer about it from
 * {@link claimPinnedPort} rather than having it quietly discarded.
 *
 * @param raw - The raw value, or `undefined` when it is not set.
 * @returns The port, or `null` when unset or not a usable port number.
 */
function parsePortEnv(raw: string | undefined): number | null {
  if (!raw) return null;
  const port = Number(raw);
  return isValidPort(port) ? port : null;
}

/**
 * Read the port someone chose out of the data directory's `config.json`.
 *
 * This is the same `server.port` key the CLI reads (`packages/cli/src/cli.ts`),
 * on purpose: pinning a port is one setting with one meaning, whichever way
 * DorkOS was started. It is read straight off disk (see `user-config.ts`)
 * rather than through the server's config manager, which lives in the child
 * process and has not started yet when the port has to be chosen.
 *
 * **Present in the file is not the same as chosen.** `conf` materializes
 * defaults to disk — `config-manager.ts` hands it both `defaults` and
 * `migrations`, and its migration pass writes the whole defaulted tree back
 * whenever the file differs from it — so `~/.dork/config.json` on any machine
 * that has booted once already contains `"server": { "port": 4242, … }`,
 * written by the library and typed by nobody. Reading that as a pin made the
 * step-up branch below dead for essentially every install: opening the app
 * while `dorkos` held 4242 refused, told the person DorkOS "is set to use port
 * 4242" — a setting they never made — and sent them to
 * `dorkos config set server.port`, which leads to the data-directory lock
 * refusing them all over again.
 *
 * So a value equal to {@link PREFERRED_SERVER_PORT} is read as the absence of
 * an opinion, because that is exactly what the schema's default means
 * (`config-schema.ts`), and a library persisting a default is not a person
 * making a choice. Someone who deliberately runs
 * `dorkos config set server.port 4242` is indistinguishable from that and gets
 * the scanning behaviour; for a GUI, starting on 4243 beats refusing to start,
 * and 4242 is the address they asked for anyway.
 *
 * The 1024 floor is repeated here for the same reason the value is read here at
 * all: `UserConfigSchema` enforces it, but nothing has applied the schema yet. A
 * lower value could not have been written through the config manager, so it is
 * malformed input rather than a choice, and is treated the way an unparseable
 * file is — warned about, and ignored.
 *
 * @param dorkHome - The data directory to read from.
 * @returns The chosen port, or `null` when nobody chose one.
 */
function readPinnedPort(dorkHome: string): number | null {
  // No config file yet (first launch), or one nothing can parse, both come back
  // as null here. Neither is a reason to refuse to start, and the default is a
  // good answer.
  const port = readUserConfig(dorkHome)?.server?.port;
  if (typeof port !== 'number' || !isValidPort(port)) return null;
  // The schema default, however it got onto disk: no opinion, so no pin.
  if (port === PREFERRED_SERVER_PORT) return null;
  if (port < LOWEST_UNPRIVILEGED_PORT) {
    log.warn(
      `[server] Ignoring server.port ${port} in config.json: DorkOS cannot use a port below ` +
        `${LOWEST_UNPRIVILEGED_PORT} without administrator rights. Starting from ` +
        `${PREFERRED_SERVER_PORT} instead.`
    );
    return null;
  }
  return port;
}

/**
 * The port DorkOS would like, before anything is known about what is free.
 *
 * Precedence matches the CLI's — environment variable, then `config.json`, then
 * the default — minus the `--port` flag, which a windowed app has no equivalent
 * of.
 *
 * @returns The preferred port and where it came from.
 */
export function resolvePreferredPort(): PreferredPort {
  const fromEnv = parsePortEnv(process.env.DORKOS_PORT);
  if (fromEnv !== null) return { port: fromEnv, source: 'DORKOS_PORT' };

  const pinned = readPinnedPort(resolveDataDirectory());
  if (pinned !== null) return { port: pinned, source: 'config.json' };

  return { port: PREFERRED_SERVER_PORT, source: 'default' };
}

/**
 * Whether a port can be bound right now.
 *
 * There is an unavoidable gap between this answering `free` and the child
 * binding — the port could be taken in between. Handing the listening socket to
 * the child would close it, but neither a UtilityProcess nor a tsx-run fork can
 * inherit one portably. What we can do is make a lost race cheap: the child
 * fails to bind, exits immediately, and the supervisor settles `startServer` on
 * that exit (see `server-process.ts`) rather than waiting out the health-poll
 * window.
 *
 * @param port - The port to test.
 * @returns What the operating system said about it.
 * @throws If the probe fails for a reason that is not about availability.
 */
function probePort(port: number): Promise<PortAvailability> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      // Close before answering: an open probe socket would hold the very port
      // it was asked about, which is the opposite of the point.
      probe.close(() => {
        if (err.code === 'EADDRINUSE') resolve('in-use');
        else if (err.code === 'EACCES') resolve('forbidden');
        else reject(err);
      });
    });
    probe.listen(port, PROBE_HOST, () => {
      probe.close((err) => (err ? reject(err) : resolve('free')));
    });
  });
}

/**
 * How to choose a different port, worded for where the current one came from.
 *
 * Every refusal ends with this, because someone who hits one cannot fix it from
 * inside the app.
 *
 * @param source - Where the port DorkOS tried came from.
 */
function howToChangeThePort(source: PortSource): string {
  if (source === 'DORKOS_PORT') {
    return 'To use a different one, change the DORKOS_PORT setting in the environment DorkOS starts in.';
  }
  const configPath = path.join(resolveDataDirectory(), 'config.json');
  return (
    'To use a different one, run `dorkos config set server.port <number>`, or set ' +
    `"server": { "port": <number> } in ${configPath}.`
  );
}

/**
 * Take a port someone chose, or refuse.
 *
 * No scanning: see the module doc. The alternative is an install pinned to 5000
 * quietly coming up on 5001, where every client configured against 5000 stops
 * resolving and nothing reports a fault.
 *
 * @param preferred - The pinned port and its source.
 * @returns The port, once confirmed free.
 * @throws If something already holds it, or the operating system will not allow
 *   it. The message says which of the two, because "quit whatever is using it"
 *   is unfollowable advice when nothing is.
 */
async function claimPinnedPort({ port, source }: PreferredPort): Promise<number> {
  const availability = await probePort(port);
  if (availability === 'free') return port;

  if (availability === 'forbidden') {
    const why =
      port < LOWEST_UNPRIVILEGED_PORT
        ? `Ports below ${LOWEST_UNPRIVILEGED_PORT} need administrator rights.`
        : 'Another program on this computer may have reserved it.';
    throw new PortUnavailableError(
      `DorkOS is set to use port ${port}, but this computer will not let it listen there. ` +
        `${why} ${howToChangeThePort(source)}`
    );
  }

  throw new PortUnavailableError(
    `DorkOS is set to use port ${port}, and something else on this computer already has it. ` +
      'DorkOS will not quietly move to another port, because anything you pointed at this one ' +
      `would stop working. Quit whatever is using port ${port} and open DorkOS again. ` +
      howToChangeThePort(source)
  );
}

/**
 * The first free port at or after `preferred`.
 *
 * Only used for the unpinned default; a chosen port goes through
 * {@link claimPinnedPort} instead.
 *
 * @param preferred - The port to try first.
 * @param attempts - How many consecutive ports to try, counting `preferred`.
 * @returns The port that was free a moment ago.
 * @throws If every candidate is taken. The message tells ports that are in use
 *   apart from ports the operating system refuses, which are not the same
 *   problem and do not have the same fix.
 */
export async function findAvailablePort(preferred: number, attempts: number): Promise<number> {
  const last = Math.min(preferred + attempts - 1, MAX_PORT);
  let anyForbidden = false;
  for (let port = preferred; port <= last; port++) {
    const availability = await probePort(port);
    if (availability === 'free') return port;
    if (availability === 'forbidden') anyForbidden = true;
  }
  const problem = anyForbidden
    ? `DorkOS could not get any port from ${preferred} to ${last}: they are in use, or this ` +
      'computer will not let DorkOS listen on them. Free one of them and open DorkOS again.'
    : `Every port from ${preferred} to ${last} is already in use on this computer, so DorkOS has ` +
      'nowhere to listen. Quit whatever is using one of them and open DorkOS again.';
  throw new PortUnavailableError(`${problem} ${howToChangeThePort('default')}`);
}

/**
 * Pick the port this launch's server will listen on.
 *
 * @returns The chosen port.
 * @throws If a pinned port is unavailable, or if no port in the scanned range
 *   is free (see {@link claimPinnedPort} and {@link findAvailablePort}).
 */
export async function chooseServerPort(): Promise<number> {
  const preferred = resolvePreferredPort();
  if (preferred.source !== 'default') return claimPinnedPort(preferred);

  const port = await findAvailablePort(preferred.port, PORT_SCAN_ATTEMPTS);
  if (port !== preferred.port) {
    // A log line, never a dialog. Moving off the default is a small,
    // self-correcting accommodation: the address is on screen in Settings →
    // Server, and the only start-up conflict worth interrupting someone for is
    // the one that actually stops them — which is the data directory's, not
    // this one (see the module doc).
    log.info(
      `[server] Port ${preferred.port} is in use, so this session is on ${port}. ` +
        'Settings → Server shows the address.'
    );
  }
  return port;
}
