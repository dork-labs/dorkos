/**
 * The ISOLATION SEAM: how the harness runs a credentialed DorkOS server as an
 * out-of-process, sandboxed unit the eval drives prompts against.
 *
 * Phase 2 shipped one implementation — {@link IsolationLauncher} via a Node child
 * process (`child-process-launcher.ts`) — and the `docker` tier landed as a
 * SECOND implementation of this same interface rather than a rewrite of the
 * harness server + drive loop. Everything above the seam (health polling, the
 * drive loop, oracles) binds to these types, never to `node:child_process`.
 *
 * The seam earned its keep: the docker tier's `baseUrl` is NOT a mapped host
 * port. Its container runs with `--network none` (the containment claim), which
 * makes docker's own port publishing inert, so the launcher stands up a loopback
 * proxy that relays into the container's network namespace and reports THAT as
 * `baseUrl` (`docker-launcher.ts` + `netns-proxy.ts`). Nothing above the seam
 * noticed.
 *
 * Isolation tiers (fast → hardened):
 * - `in-process` (test-mode, structural): `createApp()` in the harness process,
 *   no launcher — see `harness-server.ts`. Fastest; serial (shared singletons).
 * - `child-process` (default credentialed): a Node subprocess with its own
 *   sandbox `DORK_HOME` + port. Real per-eval isolation of DorkOS's own state,
 *   but NOT of what the agent does: its file tools and network reach the host.
 * - `docker` (hardened, `docker-launcher.ts`): a container per eval for
 *   tool-executing judgment evals that must not touch the host. One host mount
 *   (the throwaway sandbox), no network, no capabilities, bounded resources.
 *
 * Which tier an eval actually got is recorded on `EvalResult.isolation`, because
 * a `preferDocker` case degrades silently when no daemon or image is present.
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
   * The controlled `CLAUDE_CONFIG_DIR` the launched server's runtime must read
   * its USER-level Claude configuration from — the sandbox's seeded config dir
   * (`runner/claude-config.ts`). Absent when the run declined to pin one because
   * the operator's real directory is also their sign-in.
   *
   * Present ALSO means the launcher moves the child's `HOME` onto the sandbox
   * root. The two are one decision: this variable answers what the model reads,
   * `HOME` answers what the server ENUMERATES (`resolveClaudeRootSet()` unions in
   * `~/.claude` unconditionally, so a pinned config dir alone still left session
   * listing and search reading the operator's real transcripts — DOR-1779), and
   * moving `HOME` is safe on exactly the rows where this pin was safe.
   *
   * Only `child-process` acts on it, and that asymmetry is the containment story
   * rather than an omission: the docker tier mounts nothing from the host home,
   * so its container's `~/.claude` is already the image's empty one and there is
   * no operator config to displace.
   */
  claudeConfigDir?: string;
  /**
   * Extra environment the launched server boots with — the credentialed tier's
   * `ANTHROPIC_API_KEY`, a cheap `ANTHROPIC_MODEL`, and any per-eval overrides.
   *
   * How a launcher APPLIES these is tier-specific, and the difference is a
   * containment property rather than an implementation detail:
   *
   * - `child-process` merges them over the parent environment (it is a host
   *   process; it inherits the developer's env either way) and strips the
   *   harness's own `DORKOS_TEST_RUNTIME` flags so a credentialed run never
   *   inherits test-mode.
   * - `docker` does NOT merge. The container receives exactly these keys plus the
   *   handful the launcher adds for path translation — no `process.env` spread —
   *   so nothing from the developer's shell (tokens, proxies, cloud credentials)
   *   can reach an agent's turn by accident.
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
  /**
   * Base URL the harness reaches the launched server on (e.g.
   * `http://127.0.0.1:53511`). Always loopback, but not always the server's own
   * listener: the docker tier's container has no network, so this addresses a
   * host-side proxy that relays into the container's namespace.
   */
  baseUrl: string;
  /**
   * The path the LAUNCHED SERVER sees for the sandbox project directory, when it
   * differs from the host path. Local tiers (in-process, child-process) run in
   * the host filesystem and omit it; the docker tier mounts the sandbox at a
   * container path and reports that here, so the drive loop's `?cwd=` is a path
   * the server can actually validate against its own boundary. Oracles always
   * read the HOST sandbox paths and ignore this.
   */
  projectCwd?: string;
  /**
   * Identifier of the underlying isolation unit, when it is externally
   * inspectable — the docker tier's container id, so a retained container can be
   * found with `docker logs <id>`. Omitted by tiers with nothing to expose.
   */
  containerId?: string;
  /**
   * Kill the launched server and free every resource it holds — the OS process
   * (and its descendant runtime binaries) or the container, and its port.
   * Idempotent; MUST succeed even mid-boot, before the server is healthy.
   *
   * @param opts.failed - True when the eval FAILED. A tier that can retain
   *   post-mortem state (the docker tier keeps the stopped container and its
   *   logs) honors it; tiers with nothing to retain ignore it.
   */
  kill: (opts?: { failed?: boolean }) => Promise<void>;
  /**
   * Resolves if the server exits on its OWN, before {@link kill} — carrying the
   * exit code/signal and a stderr tail so a boot crash surfaces as a diagnosable
   * error rather than only a health-poll timeout. Never rejects.
   */
  exited: Promise<ServerExit>;
}

/**
 * The isolation launcher: boots the DorkOS server as an out-of-process sandboxed
 * unit. The child-process implementation spawns a Node subprocess; the `docker`
 * implementation satisfies this same interface with `docker run` / `docker rm -f`
 * plus its namespace proxy. The harness server + drive loop depend on THIS, never
 * on a concrete launcher.
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
