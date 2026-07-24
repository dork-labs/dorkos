/**
 * Isolation-tier RESOLUTION: turn a `--isolation` request (plus each case's own
 * preference) into a concrete {@link IsolationLauncher}, degrading gracefully
 * when docker is unavailable (spec `agent-trust`, task 3.4).
 *
 * The rule, in one line: **docker is used when it is asked for AND it works;
 * otherwise the run continues on the child-process tier with a clear message.**
 * A missing daemon or a missing image is never a hard failure — a machine
 * without docker must still run the whole suite, just less hardened.
 *
 * Two things can ask for docker:
 * - the operator, with `--isolation docker` (an explicit request: if docker is
 *   unavailable the run still proceeds, but the message says so loudly);
 * - a CASE, with `preferDocker: true` — the destructive-scenario evals and the
 *   marketplace install case, whose turns actually execute tools and mutate a
 *   filesystem. Under the default `--isolation auto` these opt INTO a container
 *   when one is available, and silently fall back when it is not.
 *
 * Availability is probed ONCE per run and memoized: `docker version` +
 * `docker image inspect` cost a subprocess each, and a suite re-probing per eval
 * would add seconds for no new information.
 *
 * @module evals/runner/isolation/resolve-launcher
 */
import type { IsolationLauncher } from './types.js';
import { ChildProcessLauncher } from './child-process-launcher.js';
import {
  DockerLauncher,
  ensureDockerAvailable,
  type DockerAvailability,
  type DockerCli,
} from './docker-launcher.js';

/**
 * The isolation tiers an operator can request with `--isolation`.
 *
 * - `auto` (default): use docker for cases that ask for it (`preferDocker`) when
 *   docker works; everything else runs child-process.
 * - `child-process`: never use docker, even for `preferDocker` cases.
 * - `docker`: use docker for EVERY credentialed eval, degrading with a message
 *   when it is unavailable.
 */
export const ISOLATION_TIERS = ['auto', 'child-process', 'docker'] as const;

/** An isolation tier request. One of {@link ISOLATION_TIERS}. */
export type IsolationTier = (typeof ISOLATION_TIERS)[number];

/** Parse a `--isolation` value, falling back to `auto` for an unknown/absent one. */
export function parseIsolationTier(value: string | undefined): IsolationTier {
  return (ISOLATION_TIERS as readonly string[]).includes(value ?? '')
    ? (value as IsolationTier)
    : 'auto';
}

/** Options for {@link createLauncherResolver}. */
export interface LauncherResolverOptions {
  /** The requested tier (from `--isolation`). Defaults to `auto`. */
  isolation?: IsolationTier;
  /** The docker CLI seam, for tests. Defaults to the real `docker` binary. */
  docker?: DockerCli;
  /** Run id stamped onto eval containers, so a run's strays are greppable. */
  runId?: string;
  /** Sink for the one-time availability notice. Defaults to `process.stderr`. */
  notify?: (message: string) => void;
}

/**
 * Resolves the launcher for each eval, probing docker at most once per run.
 * Returned by {@link createLauncherResolver}.
 */
export interface LauncherResolver {
  /**
   * The launcher for one case, or `undefined` to use the harness default
   * (child-process). Probes docker on first use when the tier could need it.
   *
   * @param opts.preferDocker - The case asked for a container (a
   *   tool-executing/destructive case).
   * @returns The launcher to boot with, or `undefined` for the default tier.
   */
  forCase(opts: { preferDocker?: boolean }): Promise<IsolationLauncher | undefined>;
  /** The memoized docker probe result, or `undefined` if docker was never needed. */
  availability(): DockerAvailability | undefined;
}

/**
 * Build a per-run launcher resolver implementing the tier policy above.
 *
 * @param opts - Requested tier, docker seam, run id, notifier; see
 *   {@link LauncherResolverOptions}.
 * @returns The {@link LauncherResolver} for this run.
 */
export function createLauncherResolver(opts: LauncherResolverOptions = {}): LauncherResolver {
  const isolation = opts.isolation ?? 'auto';
  const notify =
    opts.notify ??
    ((message: string) => {
      process.stderr.write(`${message}\n`);
    });

  let probe: DockerAvailability | undefined;
  let notified = false;

  /** Probe docker once per run and announce the verdict once. */
  const probeOnce = async (): Promise<DockerAvailability> => {
    if (!probe) {
      probe = await ensureDockerAvailable({ ...(opts.docker ? { docker: opts.docker } : {}) });
    }
    if (!probe.available && !notified) {
      notified = true;
      // An EXPLICIT `--isolation docker` deserves the loud reason; under `auto`
      // the fallback is expected on machines without docker, so keep it terse.
      notify(
        isolation === 'docker'
          ? `${probe.reason} Falling back to the child-process tier for this run.`
          : `${probe.reason} Cases preferring docker run on the child-process tier.`
      );
    }
    return probe;
  };

  return {
    async forCase({ preferDocker = false }) {
      if (isolation === 'child-process') return undefined;
      if (isolation === 'auto' && !preferDocker) return undefined;

      const verdict = await probeOnce();
      if (!verdict.available) return undefined;
      return new DockerLauncher({
        image: verdict.image,
        ...(opts.docker ? { docker: opts.docker } : {}),
        ...(opts.runId ? { runId: opts.runId } : {}),
      });
    },
    availability: () => probe,
  };
}

/** The default (non-docker) launcher, exported so callers can name the fallback. */
export { ChildProcessLauncher };
