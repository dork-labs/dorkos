/**
 * The docker {@link IsolationLauncher}: runs the DorkOS server inside a
 * CONTAINER, one per eval — the hardened tier for tool-executing judgment evals
 * that must not touch the host (spec `agent-trust`, task 3.4).
 *
 * The child-process tier already gives per-eval isolation of DorkOS's own state
 * (a fresh sandbox `DORK_HOME`, its own port). What it cannot bound is what the
 * AGENT does: a real credentialed turn runs a real `claude` binary with real
 * file tools, and nothing stops it from writing outside the sandbox, reaching the
 * network, or reaching the developer's own DorkOS on loopback. This tier closes
 * all three.
 *
 * ## What is actually contained (verified, not asserted)
 *
 * - **Filesystem**: exactly one bind mount, the throwaway sandbox (below).
 * - **Network**: `--network none`. The container gets a loopback interface and
 *   nothing else — no egress, and no route to the host, so an agent cannot reach
 *   `127.0.0.1:4242` (a developer's real cockpit, whose `DORK_HOME` is the real
 *   `~/.dork`) or exfiltrate the sandbox. Verified from a container launched with
 *   this exact flag set: `https://example.com` and `host.docker.internal:11434`
 *   are both unreachable, where on a default bridge both answered.
 * - **Privileges**: `--cap-drop=ALL` + `--security-opt=no-new-privileges`.
 * - **Resources**: `--memory` / `--memory-swap` (swap disabled) / `--pids-limit`
 *   / `--cpus`, so a runaway turn cannot take the host down.
 *
 * NOT contained: the container's root filesystem is writable (no `--read-only`).
 * A real agent turn writes outside the mount — the runtime's own caches and
 * `$HOME` — and no credentialed run has verified which of those paths the `claude`
 * binary needs, so adding `--read-only` would be an unverified claim that breaks
 * the tier. That is a deliberate gap, not an oversight: the container is
 * disposable, so a write to its own root fs dies with it.
 *
 * ## HOW THE HARNESS REACHES A `--network none` SERVER
 *
 * `--network none` and `--publish` are mutually exclusive in practice: docker
 * ACCEPTS both, then the published host port simply never answers (verified —
 * `curl` gets ECONNREFUSED while the in-container server logs `listening`). So
 * containment and reachability cannot both come from docker's networking.
 *
 * They come from the network NAMESPACE instead: {@link startNetnsProxy} listens on
 * the harness-allocated loopback port and, per TCP connection, relays bytes
 * through `docker exec -i <container> node -e <relay>` — which runs INSIDE the
 * container's namespace and connects to its loopback. Everything above the seam
 * (`baseUrl`, health polling, the drive loop, SSE) is unchanged; verified end to
 * end against the real eval image for both `GET /api/health` and a streaming
 * `GET /api/events`. `node` is guaranteed present: it is the image's own runtime.
 *
 * ## What is (and is not) mounted
 *
 * Exactly ONE bind mount: the eval's `mkdtemp` sandbox root (the parent of both
 * `dorkHome` and `projectCwd`) at `/eval` inside the container. Nothing from the
 * host home is mounted — no `~/.dork`, no `~/.claude`, no SSH keys, no repo.
 * The sandbox is created per eval and deleted after it (`runner/sandbox.ts`), so
 * mounting it is not a host-home mount; it is the same throwaway directory the
 * oracles already own.
 *
 * Mounting (rather than `docker cp`) is what makes the existing harness work
 * unchanged in both directions:
 * - **seeding**: `runEval` seeds the sandbox on the HOST before the server boots
 *   (`evalCase.seed(sandbox)`); the mount makes those files already present
 *   inside the container at boot, with no seeding-order change and no
 *   docker-specific seed path;
 * - **oracles**: they assert on the HOST sandbox paths after the run; the mount
 *   means everything the containerized server wrote is right there, so every
 *   existing filesystem oracle keeps working with no translation.
 * A `docker cp` design would need a copy-in before boot AND a copy-out before
 * oracles, i.e. a docker-aware fork of both halves of the harness. The mount is
 * the smaller, honest change.
 *
 * ## Path translation
 *
 * The container sees the sandbox at `/eval`, not at its host `mkdtemp` path, so
 * the server is booted with `DORK_HOME=/eval/.dork` and
 * `DORKOS_BOUNDARY=/eval` (the boundary env the Dockerfile deployment story
 * already uses, `lib/boundary.ts`). The drive loop's `?cwd=` must therefore be
 * the CONTAINER path — a host `mkdtemp` path would fall outside the container's
 * boundary. {@link LaunchedServer.projectCwd} carries that translation up to the
 * harness, which prefers it over the host path when driving turns. Oracles are
 * unaffected: they read the host side of the same mount.
 *
 * ## Image
 *
 * Uses the repo `Dockerfile`'s `runtime` target (the published product image:
 * the packed CLI on `PATH`, `ENTRYPOINT ["tini","--","dorkos"]`, binding
 * `0.0.0.0` with the in-container bind guard already opted out — harmless here,
 * since `--network none` leaves loopback as the only interface). The harness
 * never builds it implicitly — building is minutes and would silently dominate a
 * run — so the image is resolved from `DORKOS_EVAL_IMAGE` (default
 * {@link DEFAULT_EVAL_IMAGE}) and must already exist. {@link ensureDockerAvailable}
 * reports a clear, actionable message (including the exact build command) when
 * the daemon or the image is missing, and the caller SKIPS rather than failing.
 *
 * ## Teardown
 *
 * Containers are started detached WITHOUT `--rm` so a failed eval's container
 * and logs survive for debugging; {@link DockerLauncher.launch} removes the
 * container on `kill()` only when the eval succeeded — and `runEval` asks for no
 * retention at all on a QUARANTINED case, which fails by design every run and
 * would otherwise leak a stopped container per run. Every container carries a
 * `dorkos-eval=1` label plus the run id, so what a hard kill still leaves behind
 * is greppable AND actually swept: `runner/interrupt.ts` disposes on `SIGINT` /
 * `SIGTERM`, and `pnpm evals:sweep` (`runner/sweep.ts`) clears the rest.
 *
 * @module evals/runner/isolation/docker-launcher
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { IsolationLauncher, LaunchedServer, ServerExit, ServerLaunchSpec } from './types.js';
import {
  startNetnsProxy,
  execDockerChannel,
  relayCeilingFor,
  type NetnsProxy,
  type OpenNetnsChannel,
} from './netns-proxy.js';

/** The image the docker tier boots when `DORKOS_EVAL_IMAGE` is unset. */
export const DEFAULT_EVAL_IMAGE = 'dorkos-eval:latest';

/** Mount point of the eval sandbox inside the container. */
export const CONTAINER_SANDBOX_ROOT = '/eval';

/** Label every eval container carries, so strays are greppable and sweepable. */
export const EVAL_CONTAINER_LABEL = 'dorkos-eval';

/** Cap on the retained log tail (bytes) — enough to diagnose a boot crash. */
const LOG_TAIL_BYTES = 8_192;

/** Grace period (ms) to wait for `docker rm -f` before giving up. */
const REMOVE_GRACE_MS = 10_000;

/** How long (ms) to allow a `docker` CLI probe before treating it as unavailable. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Resource ceilings for one eval container. Generous enough for a real
 * credentialed turn (a Node server plus the `claude` binary), tight enough that a
 * runaway turn cannot take the developer's machine or a CI runner with it.
 * `--memory-swap` equals `--memory`, which DISABLES swap — a container allowed to
 * swap can blow past its memory ceiling in wall-clock cost instead of failing.
 */
const CONTAINER_LIMITS = {
  /** Total memory (and, with swap disabled, the hard ceiling). */
  memory: '4g',
  /** CPU quota, as a fraction of host cores. */
  cpus: '2',
  /**
   * Process/thread cap — a fork bomb's ceiling.
   *
   * COUPLED to the namespace proxy: every relay is a container process costing
   * about `PIDS_PER_RELAY` pids from this same budget, alongside the server and
   * the agent's own subprocesses. `relayCeilingFor` derives the proxy's
   * concurrency cap from this number, so raising it raises that too and the two
   * cannot silently drift apart. Lower it below `PIDS_RESERVED_FOR_WORKLOAD` and
   * the proxy is squeezed to its floor of one connection.
   */
  pidsLimit: 512,
} as const;

/**
 * The seam through which this launcher shells out to `docker`, injectable so
 * unit tests can drive every path (available/unavailable, boot, crash, teardown)
 * without a daemon. The real implementation is {@link execDocker}.
 */
export interface DockerCli {
  /**
   * Run `docker` with `args`, resolving with its exit code and captured output.
   *
   * @param args - Arguments after the `docker` executable.
   * @param opts.timeoutMs - Kill the invocation after this long.
   * @returns The exit code (null if killed), stdout, and stderr.
   */
  run(
    args: string[],
    opts?: { timeoutMs?: number }
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

/** The real {@link DockerCli}: spawns the `docker` binary from `PATH`. */
export const execDocker: DockerCli = {
  run(args, opts = {}) {
    return new Promise((resolve) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (c: Buffer) => {
        stdout += c.toString();
      });
      child.stderr?.on('data', (c: Buffer) => {
        stderr = (stderr + c.toString()).slice(-LOG_TAIL_BYTES);
      });
      const timer =
        opts.timeoutMs !== undefined
          ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
          : undefined;
      child.once('error', (err) => {
        clearTimeout(timer);
        // `docker` not on PATH resolves as an unavailable daemon, never a throw.
        resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}` });
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  },
};

/** Whether the docker tier can run here, and if not, why (in operator language). */
export interface DockerAvailability {
  /** True when the daemon answers AND the eval image is present locally. */
  available: boolean;
  /** A clear, actionable reason when `available` is false; omitted when true. */
  reason?: string;
  /** The image the check resolved (whether or not it was found). */
  image: string;
}

/** Resolve the eval image: `DORKOS_EVAL_IMAGE`, else {@link DEFAULT_EVAL_IMAGE}. */
export function resolveEvalImage(env?: Record<string, string | undefined>): string {
  // eslint-disable-next-line no-restricted-syntax -- the eval image is a harness/CI knob read once here (the harness env carve-out pattern), not an app config value.
  const source = env ?? process.env;
  const configured = source.DORKOS_EVAL_IMAGE;
  return configured && configured.trim() !== '' ? configured.trim() : DEFAULT_EVAL_IMAGE;
}

/**
 * Whether `image` exists locally, asked two ways.
 *
 * `docker image inspect <tag>` is the direct question, but it is not reliable on
 * its own: on Docker 29 with the containerd image store, tag resolution
 * INTERMITTENTLY answers `No such image` for an image that `docker image ls`
 * lists and `docker run` starts fine (observed repeatedly on macOS, in bursts
 * right after container removals). A false "image missing" here silently demotes a
 * destructive eval from a container to the bare host, so the cheap second opinion
 * is worth its subprocess. Presence is claimed only if one of the two finds it.
 *
 * @param docker - The docker CLI seam.
 * @param image - The image reference to look for.
 * @returns True when either probe finds the image.
 */
async function imagePresent(docker: DockerCli, image: string): Promise<boolean> {
  const inspect = await docker.run(['image', 'inspect', image], { timeoutMs: PROBE_TIMEOUT_MS });
  if (inspect.code === 0) return true;
  const listed = await docker.run(['image', 'ls', '--quiet', image], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return listed.code === 0 && listed.stdout.trim() !== '';
}

/**
 * Probe whether the docker tier can run: the daemon must answer and the eval
 * image must already exist locally (see {@link imagePresent}). Never throws and
 * never builds anything — a missing daemon or image is a SKIP with a clear
 * message, not a hard failure (the acceptance requirement for environments
 * without docker).
 *
 * @param opts.docker - The docker CLI seam (defaults to {@link execDocker}).
 * @param opts.image - Image to require (defaults to {@link resolveEvalImage}).
 * @returns The availability verdict; see {@link DockerAvailability}.
 */
export async function ensureDockerAvailable(
  opts: { docker?: DockerCli; image?: string } = {}
): Promise<DockerAvailability> {
  const docker = opts.docker ?? execDocker;
  const image = opts.image ?? resolveEvalImage();

  const info = await docker.run(['version', '--format', '{{.Server.Version}}'], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (info.code !== 0) {
    return {
      available: false,
      image,
      reason:
        'Docker isolation tier skipped: no reachable Docker daemon ' +
        '(is Docker Desktop running?). Other tiers are unaffected.',
    };
  }

  if (!(await imagePresent(docker, image))) {
    return {
      available: false,
      image,
      reason:
        `Docker isolation tier skipped: image '${image}' is not present locally. ` +
        'Build it once with: pnpm --filter=dorkos run build && ' +
        'cd packages/cli && pnpm pack --pack-destination ../../ && cd ../.. && ' +
        `docker build -t ${image} .` +
        ' (or point DORKOS_EVAL_IMAGE at an existing image).',
    };
  }

  return { available: true, image };
}

/** Options for {@link DockerLauncher}. */
export interface DockerLauncherOptions {
  /** The docker CLI seam. Defaults to {@link execDocker}. */
  docker?: DockerCli;
  /** Image to run. Defaults to {@link resolveEvalImage}. */
  image?: string;
  /** Run id stamped as a container label, so a run's strays are greppable. */
  runId?: string;
  /**
   * Retain the container (and its logs) after a FAILED eval for debugging.
   * Defaults to true; a successful eval always removes its container.
   */
  retainOnFailure?: boolean;
  /**
   * How the harness opens a byte channel into the container's network namespace
   * (see `netns-proxy.ts`). Defaults to `docker exec`; injectable so the
   * launcher's tests need no daemon.
   */
  openChannel?: OpenNetnsChannel;
}

/**
 * Launches the DorkOS server inside a per-eval container — the hardened
 * isolation tier. Satisfies the same {@link IsolationLauncher} seam as the
 * child-process tier, so nothing above the seam (health polling, the drive loop,
 * oracles) changes.
 */
export class DockerLauncher implements IsolationLauncher {
  readonly id = 'docker';

  private readonly docker: DockerCli;
  private readonly image: string;
  private readonly runId: string | undefined;
  private readonly retainOnFailure: boolean;
  private readonly openChannel: OpenNetnsChannel;

  /**
   * Construct a docker launcher.
   *
   * @param opts - Docker seam, image, run id, retention, namespace channel; see
   *   {@link DockerLauncherOptions}. Every field defaults, so
   *   `new DockerLauncher()` runs the resolved eval image through the real CLI.
   */
  constructor(opts: DockerLauncherOptions = {}) {
    this.docker = opts.docker ?? execDocker;
    this.image = opts.image ?? resolveEvalImage();
    this.runId = opts.runId;
    this.retainOnFailure = opts.retainOnFailure ?? true;
    this.openChannel = opts.openChannel ?? execDockerChannel;
  }

  /**
   * Start a container running the DorkOS server against the sandbox and return a
   * {@link LaunchedServer}. Resolves as soon as the container is STARTED and the
   * namespace proxy is listening — the caller polls `/api/health` and watches
   * `exited` for an early crash.
   *
   * The sandbox root (the parent of `spec.dorkHome`) is bind-mounted at
   * {@link CONTAINER_SANDBOX_ROOT}; `DORK_HOME` and `DORKOS_BOUNDARY` are set to
   * container paths, and `projectCwd` carries the translated project directory
   * back to the harness. The container runs with NO network, so `baseUrl` points
   * at the host-side namespace proxy rather than a published port (see the module
   * TSDoc and `netns-proxy.ts`).
   *
   * @param spec - The launch spec; see {@link ServerLaunchSpec}.
   * @returns The reachable, disposable launched-server handle.
   * @throws {Error} If `docker run` fails to start the container, or the
   *   host-side proxy cannot bind its loopback port.
   */
  async launch(spec: ServerLaunchSpec): Promise<LaunchedServer> {
    // The sandbox ROOT is the parent of dorkHome (`<root>/.dork`), and also
    // holds `<root>/project` — mounting the root gives the container both, and
    // nothing else from the host.
    const sandboxRoot = path.dirname(spec.dorkHome);
    const dorkHomeName = path.basename(spec.dorkHome);
    const containerDorkHome = `${CONTAINER_SANDBOX_ROOT}/${dorkHomeName}`;

    const env: Record<string, string> = {
      ...spec.env,
      DORK_HOME: containerDorkHome,
      // Confine the container's filesystem boundary to the mounted sandbox, so a
      // sandbox project cwd validates while nothing else in the container is
      // reachable through the API.
      DORKOS_BOUNDARY: CONTAINER_SANDBOX_ROOT,
      DORKOS_PORT: String(spec.port),
      // With `--network none` the container has ONLY loopback, so binding all
      // interfaces binds nothing reachable from outside it — the namespace proxy
      // connects from inside. These two are what the product image already sets;
      // naming them keeps the boot legible rather than dependent on the image.
      DORKOS_HOST: '0.0.0.0',
      DORKOS_ALLOW_INSECURE_BIND: 'true',
    };
    // A credentialed run uses the real runtime — never the harness's in-process
    // test-mode flags, unless a caller explicitly asked for test-mode.
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

    const labels = [`${EVAL_CONTAINER_LABEL}=1`];
    if (this.runId) labels.push(`${EVAL_CONTAINER_LABEL}-run=${this.runId}`);
    const labelArgs = labels.flatMap((l) => ['--label', l]);

    const args = [
      'run',
      '--detach',
      // No --rm: a failed eval's container + logs must survive for debugging.
      //
      // NO NETWORK AT ALL. This is the containment claim: no egress, and no route
      // to the host, so an agent turn cannot reach the developer's own DorkOS on
      // loopback or ship the sandbox anywhere. There is deliberately no
      // `--publish` — it does not work on a network-less container, and the
      // harness reaches the server through the container's namespace instead
      // (`netns-proxy.ts`).
      '--network',
      'none',
      // Drop every Linux capability and forbid regaining any: an eval agent has
      // no business with CAP_NET_RAW, CAP_CHOWN, or a setuid escalation.
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      // Bound a runaway turn. `--memory-swap` == `--memory` disables swap, so the
      // ceiling is real rather than something the container can trade for time.
      `--memory=${CONTAINER_LIMITS.memory}`,
      `--memory-swap=${CONTAINER_LIMITS.memory}`,
      `--cpus=${CONTAINER_LIMITS.cpus}`,
      `--pids-limit=${String(CONTAINER_LIMITS.pidsLimit)}`,
      // The ONLY host mount: the throwaway sandbox. No host home, ever.
      '--volume',
      `${sandboxRoot}:${CONTAINER_SANDBOX_ROOT}`,
      ...labelArgs,
      ...envArgs,
      this.image,
    ];

    const started = await this.docker.run(args);
    if (started.code !== 0) {
      throw new Error(
        `docker run failed (exit ${String(started.code)}) for image '${this.image}': ${started.stderr.trim()}`
      );
    }
    const containerId = started.stdout.trim();
    if (containerId === '') {
      throw new Error(`docker run returned no container id for image '${this.image}'.`);
    }

    // `docker wait` resolves when the container exits ON ITS OWN, carrying the
    // exit code; the logs give the stderr tail a boot crash needs. This mirrors
    // the child-process launcher's `exited` contract and never rejects.
    const exited: Promise<ServerExit> = this.docker.run(['wait', containerId]).then(async (res) => {
      const code = Number.parseInt(res.stdout.trim(), 10);
      const logs = await this.docker.run(['logs', '--tail', '200', containerId]);
      return {
        code: Number.isNaN(code) ? null : code,
        signal: null,
        stderr: `${logs.stdout}\n${logs.stderr}`.slice(-LOG_TAIL_BYTES),
      };
    });
    // Nothing awaits `exited` on the happy path; keep a rejection from surfacing
    // as an unhandledRejection (the promise itself never rejects by contract).
    void exited.catch(() => {});

    // The only way into a `--network none` container: relay each host connection
    // through the container's own namespace. Bound BEFORE returning, so the
    // caller's first health poll has something to connect to.
    let proxy: NetnsProxy;
    try {
      proxy = await startNetnsProxy({
        host: spec.host,
        port: spec.port,
        containerId,
        open: this.openChannel,
        // Derived from THIS container's own pids budget, so the two constants
        // cannot drift: the relays and the workload spend from one limit.
        maxConcurrent: relayCeilingFor(CONTAINER_LIMITS.pidsLimit),
      });
    } catch (err) {
      // A proxy that cannot bind leaves a running container behind unless we
      // remove it here — the caller never got a handle to kill.
      await this.docker.run(['rm', '--force', containerId], { timeoutMs: REMOVE_GRACE_MS });
      throw new Error(
        `Could not open the container namespace proxy on ${spec.host}:${String(spec.port)}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }

    let disposed = false;
    const kill = async (opts: { failed?: boolean } = {}): Promise<void> => {
      if (disposed) return;
      disposed = true;
      // Always close the proxy: its listener holds the harness-allocated port,
      // which a retained container must not keep hostage.
      await proxy.close();
      const retain = this.retainOnFailure && opts.failed === true;
      if (retain) {
        // Stop it but KEEP the container so `docker logs <id>` still works.
        await this.docker.run(['stop', '--timeout', '5', containerId], {
          timeoutMs: REMOVE_GRACE_MS,
        });
        return;
      }
      await this.docker.run(['rm', '--force', containerId], { timeoutMs: REMOVE_GRACE_MS });
    };

    return {
      baseUrl: proxy.baseUrl,
      // The container sees the sandbox at /eval, so the drive loop must use the
      // CONTAINER project path; oracles keep reading the host side of the mount.
      projectCwd: `${CONTAINER_SANDBOX_ROOT}/project`,
      containerId,
      kill,
      exited,
    };
  }
}
