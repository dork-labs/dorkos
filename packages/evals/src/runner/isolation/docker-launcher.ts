/**
 * The docker {@link IsolationLauncher}: runs the DorkOS server inside a
 * CONTAINER, one per eval — the hardened tier for tool-executing judgment evals
 * that must not touch the host (spec `agent-trust`, task 3.4).
 *
 * The child-process tier already gives per-eval isolation of DorkOS's own state
 * (a fresh sandbox `DORK_HOME`, its own port). What it cannot bound is what the
 * AGENT does: a real credentialed turn runs a real `claude` binary with real
 * file tools, and nothing stops it from writing outside the sandbox. This tier
 * closes that: the server and every tool it spawns live in a container whose
 * ONLY writable window onto the host is the throwaway sandbox directory.
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
 * `0.0.0.0` with the in-container bind guard already opted out). The harness
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
 * container on `kill()` only when the eval succeeded. Every container carries a
 * `dorkos-eval=1` label plus the run id, so an interrupted harness leaves a
 * greppable, sweepable set (`docker ps -aq --filter label=dorkos-eval=1`).
 *
 * @module evals/runner/isolation/docker-launcher
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { IsolationLauncher, LaunchedServer, ServerExit, ServerLaunchSpec } from './types.js';

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
 * Probe whether the docker tier can run: the daemon must answer and the eval
 * image must already exist locally. Never throws and never builds anything — a
 * missing daemon or image is a SKIP with a clear message, not a hard failure
 * (the acceptance requirement for environments without docker).
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

  const inspect = await docker.run(['image', 'inspect', image], { timeoutMs: PROBE_TIMEOUT_MS });
  if (inspect.code !== 0) {
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

  /**
   * Construct a docker launcher.
   *
   * @param opts - Docker seam, image, run id, retention; see
   *   {@link DockerLauncherOptions}. Every field defaults, so
   *   `new DockerLauncher()` runs the resolved eval image through the real CLI.
   */
  constructor(opts: DockerLauncherOptions = {}) {
    this.docker = opts.docker ?? execDocker;
    this.image = opts.image ?? resolveEvalImage();
    this.runId = opts.runId;
    this.retainOnFailure = opts.retainOnFailure ?? true;
  }

  /**
   * Start a container running the DorkOS server against the sandbox and return a
   * {@link LaunchedServer}. Resolves as soon as the container is STARTED — the
   * caller polls `/api/health` and watches `exited` for an early crash.
   *
   * The sandbox root (the parent of `spec.dorkHome`) is bind-mounted at
   * {@link CONTAINER_SANDBOX_ROOT}; `DORK_HOME` and `DORKOS_BOUNDARY` are set to
   * container paths, and `projectCwd` carries the translated project directory
   * back to the harness.
   *
   * @param spec - The launch spec; see {@link ServerLaunchSpec}.
   * @returns The reachable, disposable launched-server handle.
   * @throws {Error} If `docker run` fails to start the container.
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
      // Bind all interfaces so the published port reaches the server; the
      // container owns its network boundary, so opt out of the loopback guard.
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
      // Publish onto the harness-allocated port on loopback only.
      '--publish',
      `${spec.host}:${spec.port}:${spec.port}`,
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

    let disposed = false;
    const kill = async (opts: { failed?: boolean } = {}): Promise<void> => {
      if (disposed) return;
      disposed = true;
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
      baseUrl: `http://${spec.host}:${spec.port}`,
      // The container sees the sandbox at /eval, so the drive loop must use the
      // CONTAINER project path; oracles keep reading the host side of the mount.
      projectCwd: `${CONTAINER_SANDBOX_ROOT}/project`,
      containerId,
      kill,
      exited,
    };
  }
}
