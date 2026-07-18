/**
 * The ISOLATION SEAM: how the harness runs a credentialed DorkOS server as an
 * out-of-process, sandboxed unit the eval drives prompts against.
 *
 * Phase 2 ships one implementation — {@link IsolationLauncher} via a Node child
 * process (`child-process-launcher.ts`). The seam exists so a future
 * `--isolation docker` tier (founder decision 2026-07-18; the repo's
 * `smoke:docker` infra is the eventual substrate) drops in as a SECOND
 * implementation of this same interface — `docker run` to launch, `docker rm -f`
 * to kill, the container's mapped host port as `baseUrl` — rather than a rewrite
 * of the harness server + drive loop. Everything above the seam (health polling,
 * the drive loop, oracles) binds to these types, never to `node:child_process`.
 *
 * Isolation tiers (fast → hardened):
 * - `in-process` (test-mode, structural): `createApp()` in the harness process,
 *   no launcher — see `harness-server.ts`. Fastest; serial (shared singletons).
 * - `child-process` (default credentialed): a Node subprocess with its own
 *   sandbox `DORK_HOME` + port. Real per-eval isolation; the judgment tier.
 * - `docker` (future, hardened): a container per eval for tool-executing
 *   judgment evals that must not touch the host. Not built yet; this seam is
 *   why it will be additive.
 *
 * @module evals/runner/isolation/types
 */

/** Everything a launcher needs to boot one credentialed server against a sandbox. */
export interface ServerLaunchSpec {
  /** Sandbox `DORK_HOME` the launched server (and the eval's oracles) read/write. */
  dorkHome: string;
  /** Host the server binds and the harness reaches it on (loopback for local tiers). */
  host: string;
  /** Pre-allocated TCP port the server binds. */
  port: number;
  /**
   * Extra environment the launched server boots with — the credentialed tier's
   * `ANTHROPIC_API_KEY`, a cheap `ANTHROPIC_MODEL`, and any per-eval overrides.
   * A launcher merges these OVER the parent environment and strips the harness's
   * own `DORKOS_TEST_RUNTIME` flags, so a credentialed run never inherits
   * test-mode.
   */
  env: Record<string, string>;
}

/** How a launched server exited when it went down on its own (before `kill`). */
export interface ServerExit {
  /** Process exit code, or null when it was terminated by a signal. */
  code: number | null;
  /** Terminating signal, or null on a normal exit. */
  signal: NodeJS.Signals | null;
  /** A tail of the server's stderr, so a boot crash is diagnosable, not opaque. */
  stderr: string;
}

/** A launched server: reachable + disposable, independent of HOW it was launched. */
export interface LaunchedServer {
  /** Base URL the harness reaches the launched server on (e.g. `http://127.0.0.1:53511`). */
  baseUrl: string;
  /**
   * Kill the launched server and free every resource it holds — the OS process
   * (and its descendant runtime binaries) or the container, and its port.
   * Idempotent; MUST succeed even mid-boot, before the server is healthy.
   */
  kill: () => Promise<void>;
  /**
   * Resolves if the server exits on its OWN, before {@link kill} — carrying the
   * exit code/signal and a stderr tail so a boot crash surfaces as a diagnosable
   * error rather than only a health-poll timeout. Never rejects.
   */
  exited: Promise<ServerExit>;
}

/**
 * The isolation launcher: boots the DorkOS server as an out-of-process sandboxed
 * unit. The child-process implementation spawns a Node subprocess; a future
 * `docker` implementation satisfies this same interface with `docker run` /
 * `docker rm -f`. The harness server + drive loop depend on THIS, never on a
 * concrete launcher.
 */
export interface IsolationLauncher {
  /** Stable id for the isolation tier this launcher provides (`child-process`, `docker`). */
  readonly id: string;
  /**
   * Launch the DorkOS server per `spec` and return a reachable, disposable
   * handle. Resolves once the process/container is SPAWNED (not yet healthy) —
   * the caller polls `/api/health`. Rejects only if the launch itself fails
   * (e.g. the server entry cannot be resolved).
   */
  launch: (spec: ServerLaunchSpec) => Promise<LaunchedServer>;
}
