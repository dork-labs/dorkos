/**
 * The bridge that lets the harness drive a server inside a `--network none`
 * container: a loopback TCP listener on the host that relays each connection
 * through the CONTAINER'S OWN network namespace.
 *
 * ## Why this exists
 *
 * The hardened isolation tier's whole point is that a real agent turn cannot
 * reach the network or the host — including the developer's own DorkOS on
 * `127.0.0.1:4242`, whose `DORK_HOME` is the real `~/.dork`. Only
 * `--network none` gives that. But docker cannot publish a port out of a
 * network-less container: it accepts `--publish` alongside `--network none` and
 * then the host port silently never answers (verified — `curl` gets
 * ECONNREFUSED while the in-container server logs `listening`). Containment and
 * reachability therefore cannot both come from docker's networking.
 *
 * So reachability comes from the namespace instead. `docker exec` runs a process
 * INSIDE the container's namespaces, where the server's loopback is reachable.
 * Each inbound host connection spawns one `docker exec -i` relay whose stdin and
 * stdout are piped to the socket, making the container's loopback port appear on
 * the host's loopback with no interface bridging the two.
 *
 * The relay body is `node -e`, not `socat`/`nc`: `node` is the eval image's own
 * runtime, so it is guaranteed present, while a coreutils tool is not.
 *
 * ## What this is not
 *
 * Not a general-purpose proxy. It is connection-scoped and does no HTTP parsing,
 * no pooling, and no HTTP/2. What it IS verified to carry is what the harness
 * sends: request/response HTTP/1.1 and a long-lived SSE response, including a
 * client that half-closes after its request. One `docker exec` per connection
 * costs roughly a couple hundred milliseconds — irrelevant beside a model turn.
 *
 * Two limits are deliberate rather than incidental:
 *
 * - **Concurrency is capped** at {@link relayCeilingFor} and a connection past it
 *   is REFUSED, not queued. Each relay is a container process costing about
 *   {@link PIDS_PER_RELAY} pids out of the container's `--pids-limit`, so past
 *   roughly 64 simultaneous connections `docker exec` cannot fork and the client
 *   gets an accepted socket that never answers. A 60-second hang in this harness
 *   reads as model latency; a reset reads as what it is.
 * - **The pids budget is shared** with the workload it bounds — the DorkOS server
 *   and whatever the agent's turn spawns. That is why the ceiling reserves
 *   {@link PIDS_RESERVED_FOR_WORKLOAD} rather than spending the whole limit, and
 *   why the two constants live next to each other instead of being independently
 *   tuned in two files.
 *
 * @module evals/runner/isolation/netns-proxy
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import type { Readable, Writable } from 'node:stream';

/**
 * Pids one relay costs inside the container.
 *
 * Each relay is a full `node` process in the container's cgroup, and measurement
 * puts it at roughly 7 pids (50 concurrent relays peaked at 416). This is the
 * constant that ties this file to `docker-launcher.ts`'s `--pids-limit`: the
 * resource ceiling meant to bound a runaway AGENT is also the budget the
 * reachability mechanism spends from, and it is shared with the `claude` binary's
 * own subprocesses. Neither file used to say so.
 */
export const PIDS_PER_RELAY = 7;

/**
 * Pids held back for the workload itself — the DorkOS server plus whatever the
 * agent's turn spawns. The relay ceiling is computed from what is left, so the
 * transport can never starve the thing under test.
 */
export const PIDS_RESERVED_FOR_WORKLOAD = 256;

/**
 * The `--pids-limit` assumed when a caller does not name one. Matches
 * `docker-launcher.ts`'s `CONTAINER_LIMITS.pidsLimit`; the launcher always passes
 * its own value, so this only covers a direct `startNetnsProxy` call.
 */
export const DEFAULT_ASSUMED_PIDS_LIMIT = 512;

/**
 * How many concurrent relays a container with `pidsLimit` can support.
 *
 * Derived rather than hardcoded so the two coupled constants cannot drift: raise
 * `--pids-limit` in `docker-launcher.ts` and this rises with it. At the shipped
 * limit of 512 this is about 36, comfortably above the handful of connections a
 * drive loop opens (a POST, an SSE stream, health polls) and comfortably below
 * the ~64 at which forking actually starts to fail.
 *
 * @param pidsLimit - The container's `--pids-limit`.
 * @param reserve - Pids kept for the server and the agent's own subprocesses.
 * @returns The concurrent-relay ceiling (at least 1).
 */
export function relayCeilingFor(
  pidsLimit: number,
  reserve: number = PIDS_RESERVED_FOR_WORKLOAD
): number {
  return Math.max(1, Math.floor((pidsLimit - reserve) / PIDS_PER_RELAY));
}

/** One bidirectional byte channel into a container's network namespace. */
export interface NetnsChannel {
  /** Bytes to hand the in-container server. */
  readonly stdin: Writable;
  /** Bytes the in-container server sent back. */
  readonly stdout: Readable;
  /** Diagnostics from the relay itself (a refused in-container connect). */
  readonly stderr: Readable;
  /** Tear the channel down. Idempotent. */
  close(): void;
}

/**
 * Opens a {@link NetnsChannel} to `port` on the loopback of `containerId`.
 * Injectable so the launcher's unit tests drive every path without a daemon.
 */
export type OpenNetnsChannel = (containerId: string, port: number) => NetnsChannel;

/**
 * The in-container relay: connect to the server on this container's loopback and
 * pipe it to the exec session's stdio. Written as a single `node -e` expression
 * because that is the only interpreter the eval image is guaranteed to have.
 *
 * @param port - The port the in-container server listens on.
 * @returns The `node -e` program source.
 */
function relaySource(port: number): string {
  return [
    "const net=require('net');",
    `const s=net.connect(${String(port)},'127.0.0.1');`,
    // A connect refused before the server is listening must end the session, not
    // hang: the harness's health poll retries, and a hung relay would eat one
    // connection per poll.
    "s.on('error',(e)=>{process.stderr.write(String(e&&e.message));process.exit(1);});",
    'process.stdin.pipe(s);s.pipe(process.stdout);',
    "s.on('close',()=>process.exit(0));",
  ].join('');
}

/** The real {@link OpenNetnsChannel}: one `docker exec -i` per connection. */
export const execDockerChannel: OpenNetnsChannel = (containerId, port) => {
  const child = spawn('docker', ['exec', '-i', containerId, 'node', '-e', relaySource(port)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    close: () => {
      child.kill('SIGKILL');
    },
  };
};

/** A running namespace proxy: where it listens, and how to stop it. */
export interface NetnsProxy {
  /** Base URL the harness drives the containerized server on. */
  baseUrl: string;
  /** Close the listener and kill every live relay. Idempotent. */
  close(): Promise<void>;
}

/** Options for {@link startNetnsProxy}. */
export interface StartNetnsProxyOptions {
  /** Loopback host to listen on (the harness-allocated one). */
  host: string;
  /** Port to listen on AND to reach inside the container (they are the same). */
  port: number;
  /** The container whose namespace connections are relayed into. */
  containerId: string;
  /** The channel opener. Defaults to {@link execDockerChannel}. */
  open?: OpenNetnsChannel;
  /**
   * Concurrent-relay ceiling. Past it a connection is REFUSED rather than
   * accepted and left to hang. Defaults to {@link relayCeilingFor} at the
   * launcher's `--pids-limit`; the launcher passes its own value so the two stay
   * coupled.
   */
  maxConcurrent?: number;
}

/**
 * Start the host-side listener that relays into a container's network namespace.
 *
 * @param opts - Listen address, container, channel opener; see
 *   {@link StartNetnsProxyOptions}.
 * @returns The listening {@link NetnsProxy}.
 * @throws {Error} If the loopback listener cannot bind.
 */
export async function startNetnsProxy(opts: StartNetnsProxyOptions): Promise<NetnsProxy> {
  const open = opts.open ?? execDockerChannel;
  const maxConcurrent = opts.maxConcurrent ?? relayCeilingFor(DEFAULT_ASSUMED_PIDS_LIMIT);
  /** Idempotent teardowns for every live connection (relay + socket). */
  const live = new Set<() => void>();

  // `allowHalfOpen: true` is the OTHER half of surviving a half-closing client,
  // and the load-bearing one. `net.Server` defaults to false, which means a peer
  // FIN makes Node end this socket's WRITABLE side automatically — the response
  // is dropped before it can be written, no matter what the request-side pipe
  // does. With half-open allowed, the socket stays writable until the relay's
  // stdout ends it (see the pipe below).
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    // Refuse LOUDLY past the ceiling rather than accepting a connection the
    // container cannot serve. Over the pids limit, `docker exec` cannot fork, and
    // the client sees an accepted socket that simply never answers — measured as a
    // 60-second hang, which in this harness reads as model latency. That is the
    // exact "false red that looks like model behavior" class this harness exists
    // to eliminate, so a reset here is strictly better than silence.
    if (live.size >= maxConcurrent) {
      process.stderr.write(
        `[netns-proxy] refusing connection ${String(live.size + 1)} to container ` +
          `${opts.containerId.slice(0, 12)}: at the ${String(maxConcurrent)}-relay ceiling ` +
          `(see PIDS_PER_RELAY / relayCeilingFor). The container's --pids-limit cannot fork ` +
          `another relay; a hung connection would look like a slow model.\n`
      );
      socket.destroy();
      return;
    }

    const channel = open(opts.containerId, opts.port);

    /** Drop both ends exactly once, however the pairing ended. */
    const teardown = (): void => {
      if (!live.delete(teardown)) return;
      channel.close();
      socket.destroy();
    };
    // The registry holds TEARDOWNS, not channels, so `close()` can drop the
    // SOCKET as well as the relay. With `allowHalfOpen` a half-closed socket
    // lingers, and `server.close()` waits for every connection — closing only the
    // channels would hang the proxy shutdown (and with it the whole eval).
    live.add(teardown);

    // `end: false` is load-bearing. With pipe's default the client's FIN would
    // end the exec session's stdin, tearing the attach down BEFORE the response
    // came back — a half-closing client got zero bytes where a normal one got a
    // full 200. HTTP/1.1 framing (Content-Length / the chunked terminator) already
    // tells the in-container server the request is complete, so it never needs the
    // EOF; the session is closed by `teardown` instead.
    socket.pipe(channel.stdin, { end: false });
    // Default `end: true` here IS wanted: it ends the socket GRACEFULLY when the
    // response finishes, flushing whatever is still queued. Nothing may listen for
    // stdout's `end` to call `teardown` — `socket.destroy()` would run right after
    // that graceful `end()` and discard a backed-up body. The socket's own `close`
    // (below) is the safe place to reclaim the channel, because it fires only once
    // the flush is actually done.
    channel.stdout.pipe(socket);
    // Relay stderr is diagnostic only; a refused in-container connect is the
    // NORMAL pre-ready case (the health poll retries), so it is not surfaced.
    channel.stderr.resume();

    socket.on('error', teardown);
    socket.on('close', teardown);
    channel.stdin.on('error', teardown);
    channel.stdout.on('error', teardown);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  // The listener must not hold the event loop open: the harness is always awaiting
  // its own work (a fetch, a health-poll timer), and a proxy someone forgot to
  // close should not turn "the run finished" into "the process hangs".
  server.unref();

  let closed = false;
  return {
    baseUrl: `http://${opts.host}:${opts.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const teardown of [...live]) teardown();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
