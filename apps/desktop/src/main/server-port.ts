import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import log from 'electron-log';
import { resolveDataDirectory } from './dork-home';

/**
 * Choosing the port the desktop app's server listens on.
 *
 * The port is not an implementation detail here. It is the address in the MCP
 * client config, in the `curl` example, in the bookmark — DorkOS documents
 * `http://localhost:4242` throughout, and an address that changes every launch
 * is one nobody can write down. So the shell asks for the same port the CLI
 * uses, every time, and moves off it only when something else is holding it.
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
 * The port DorkOS asks for first.
 *
 * The CLI's default, and the one the docs, the marketplace links, and every MCP
 * setup snippet name. Duplicated from `DEFAULT_PORT` in
 * `@dorkos/shared/constants` rather than imported, the same way
 * `packages/cli/src/cleanup-command.ts` duplicates it: electron-vite aliases
 * that package's subpath exports for the renderer bundle only, so the main
 * process is the wrong place to depend on them resolving.
 */
export const PREFERRED_SERVER_PORT = 4242;

/**
 * How many consecutive ports to try, counting the preferred one.
 *
 * Ten is chosen to be past the plausible and short of the pointless. The
 * realistic conflicts are a CLI server, a second DorkOS against another data
 * directory, and a dev instance — a handful, not a hundred. Beyond that the
 * problem is not "DorkOS is busy", it is "something is occupying this range",
 * and the honest answer is to say so.
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
 * The host the probe binds, matching what the child binds.
 *
 * The server listens on `DORKOS_HOST`, which the shell never sets, so it is
 * always `localhost` here. Probing the same name is what makes the answer
 * meaningful: a wildcard probe would report a port busy because some unrelated
 * interface holds it, and a probe of one fixed address could miss a holder that
 * `localhost` happens to resolve to.
 */
const PROBE_HOST = 'localhost';

/** Whether `value` is a port number a server could actually listen on. */
function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_PORT;
}

/**
 * Parse a port out of an environment variable.
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
 * Read the pinned port out of the data directory's `config.json`.
 *
 * This is the same `server.port` key the CLI reads (`packages/cli/src/cli.ts`),
 * on purpose: pinning a port is one setting with one meaning, whichever way
 * DorkOS was started. It is read straight off disk rather than through the
 * server's config manager, which lives in the child process and has not started
 * yet when the port has to be chosen.
 *
 * @param dorkHome - The data directory to read from.
 * @returns The pinned port, or `null` when there is no usable one.
 */
function readPinnedPort(dorkHome: string): number | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dorkHome, 'config.json'), 'utf8'));
    const port = (parsed as { server?: { port?: unknown } } | null)?.server?.port;
    return typeof port === 'number' && isValidPort(port) ? port : null;
  } catch {
    // No config file yet (first launch), or one nothing can parse. Neither is a
    // reason to refuse to start, and the default is a good answer.
    return null;
  }
}

/**
 * The port DorkOS would like, before anything is known about what is free.
 *
 * Precedence matches the CLI's — environment variable, then `config.json`, then
 * the default — minus the `--port` flag, which a windowed app has no equivalent
 * of.
 *
 * @returns The preferred port.
 */
export function resolvePreferredPort(): number {
  return (
    parsePortEnv(process.env.DORKOS_PORT) ??
    readPinnedPort(resolveDataDirectory()) ??
    PREFERRED_SERVER_PORT
  );
}

/**
 * Whether a port can be bound right now.
 *
 * There is an unavoidable gap between this answering `true` and the child
 * binding — the port could be taken in between. Handing the listening socket to
 * the child would close it, but neither a UtilityProcess nor a tsx-run fork can
 * inherit one portably. What we can do is make a lost race cheap: the child
 * fails to bind, exits immediately, and the supervisor settles `startServer` on
 * that exit (see `server-process.ts`) rather than waiting out the health-poll
 * window.
 *
 * @param port - The port to test.
 * @returns `true` when the port is free, `false` when something holds it or the
 *   operating system will not let us have it.
 * @throws If the probe fails for a reason that is not about availability.
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      // Close before answering: an open probe socket would hold the very port
      // it was asked about, which is the opposite of the point.
      probe.close(() => {
        // EACCES is a privileged port (below 1024) rather than a busy one, but
        // it is just as unusable, so it reads the same to the scan.
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(false);
        else reject(err);
      });
    });
    probe.listen(port, PROBE_HOST, () => {
      probe.close((err) => (err ? reject(err) : resolve(true)));
    });
  });
}

/**
 * The first free port at or after `preferred`.
 *
 * @param preferred - The port to try first.
 * @param attempts - How many consecutive ports to try, counting `preferred`.
 * @returns The port that was free a moment ago.
 * @throws If every candidate is taken. The message names the range and the way
 *   to move DorkOS somewhere else, because a person who hits this cannot fix it
 *   from inside the app.
 */
export async function findAvailablePort(preferred: number, attempts: number): Promise<number> {
  const last = Math.min(preferred + attempts - 1, MAX_PORT);
  for (let port = preferred; port <= last; port++) {
    if (await isPortFree(port)) return port;
  }
  const configPath = path.join(resolveDataDirectory(), 'config.json');
  throw new Error(
    `Every port from ${preferred} to ${last} is already in use on this computer, so DorkOS has ` +
      'nowhere to listen. Quit whatever is using one of them and open DorkOS again, or pick a ' +
      `different port by setting "server": { "port": <number> } in ${configPath}.`
  );
}

/**
 * Pick the port this launch's server will listen on.
 *
 * @returns The chosen port.
 * @throws If no port in the scanned range is free (see {@link findAvailablePort}).
 */
export async function chooseServerPort(): Promise<number> {
  const preferred = resolvePreferredPort();
  const port = await findAvailablePort(preferred, PORT_SCAN_ATTEMPTS);
  if (port !== preferred) {
    // A log line, never a dialog. The address is on screen in Settings →
    // Server, and the only start-up conflict worth interrupting someone for is
    // the one that actually stops them — which is the data directory's, not
    // this one (see the module doc).
    log.info(
      `[server] Port ${preferred} is in use, so this session is on ${port}. ` +
        'Settings → Server shows the address.'
    );
  }
  return port;
}
