/**
 * Docker isolation tier: the launcher's `docker` invocations, its containment
 * invariants, and the graceful SKIP when no daemon or image is present (spec
 * `agent-trust`, task 3.4). Every path is driven through the injectable
 * {@link DockerCli} seam, so these tests need no daemon.
 *
 * The load-bearing assertion is the containment one: the ONLY `--volume` is the
 * eval's throwaway sandbox, and nothing from the host home is ever mounted.
 */
import { describe, it, expect } from 'vitest';
import {
  DockerLauncher,
  ensureDockerAvailable,
  resolveEvalImage,
  DEFAULT_EVAL_IMAGE,
  CONTAINER_SANDBOX_ROOT,
  EVAL_CONTAINER_LABEL,
  type DockerCli,
} from '../docker-launcher.js';
import { createLauncherResolver, parseIsolationTier } from '../resolve-launcher.js';
import type { ServerLaunchSpec } from '../types.js';

/** One recorded `docker` invocation. */
type Invocation = string[];

/** A scripted docker CLI: per-subcommand canned results plus a call log. */
function fakeDocker(
  script: Partial<Record<string, { code: number | null; stdout?: string; stderr?: string }>> = {}
): { docker: DockerCli; calls: Invocation[] } {
  const calls: Invocation[] = [];
  const docker: DockerCli = {
    run: async (args) => {
      calls.push(args);
      // Key on the first two tokens so `image inspect` is distinguishable.
      const key = args[0] === 'image' ? `${args[0]} ${args[1]}` : args[0];
      const canned = script[key] ?? { code: 0, stdout: '', stderr: '' };
      return {
        code: canned.code,
        stdout: canned.stdout ?? '',
        stderr: canned.stderr ?? '',
      };
    },
  };
  return { docker, calls };
}

/** A healthy docker: daemon answers, image present, `run` mints a container id. */
function healthyDocker(containerId = 'c0ffee123'): ReturnType<typeof fakeDocker> {
  return fakeDocker({
    version: { code: 0, stdout: '29.5.2\n' },
    'image inspect': { code: 0, stdout: '[]' },
    run: { code: 0, stdout: `${containerId}\n` },
    wait: { code: 0, stdout: '0\n' },
    logs: { code: 0, stdout: 'server log' },
    rm: { code: 0 },
    stop: { code: 0 },
  });
}

/** A launch spec over a realistic host sandbox. */
function spec(overrides: Partial<ServerLaunchSpec> = {}): ServerLaunchSpec {
  return {
    dorkHome: '/private/var/folders/xy/dorkos-evals-AbC123/.dork',
    host: '127.0.0.1',
    port: 53511,
    env: { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_MODEL: 'claude-haiku-4-5' },
    ...overrides,
  };
}

/** The args of the first `docker run` invocation. */
function runArgs(calls: Invocation[]): string[] {
  const found = calls.find((c) => c[0] === 'run');
  if (!found) throw new Error('no `docker run` invocation was recorded');
  return found;
}

/** Every `--volume` value in a `docker run` arg list. */
function volumes(args: string[]): string[] {
  return args.flatMap((a, i) => (a === '--volume' ? [args[i + 1]] : []));
}

/** Every `-e KEY=VALUE` pair in a `docker run` arg list, as an object. */
function envOf(args: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  args.forEach((a, i) => {
    if (a !== '-e') return;
    const [key, ...rest] = args[i + 1].split('=');
    env[key] = rest.join('=');
  });
  return env;
}

describe('resolveEvalImage', () => {
  it('defaults to the built-in eval image', () => {
    expect(resolveEvalImage({})).toBe(DEFAULT_EVAL_IMAGE);
    expect(resolveEvalImage({ DORKOS_EVAL_IMAGE: '   ' })).toBe(DEFAULT_EVAL_IMAGE);
  });

  it('honors DORKOS_EVAL_IMAGE for image reuse', () => {
    expect(resolveEvalImage({ DORKOS_EVAL_IMAGE: 'ghcr.io/acme/dorkos:pinned' })).toBe(
      'ghcr.io/acme/dorkos:pinned'
    );
  });
});

describe('ensureDockerAvailable', () => {
  it('reports available when the daemon answers and the image exists', async () => {
    const { docker } = healthyDocker();
    const verdict = await ensureDockerAvailable({ docker, image: 'dorkos-eval:latest' });
    expect(verdict.available).toBe(true);
    expect(verdict.reason).toBeUndefined();
  });

  it('SKIPS with a clear message when no daemon is reachable (never throws)', async () => {
    const { docker } = fakeDocker({ version: { code: 1, stderr: 'Cannot connect to the daemon' } });
    const verdict = await ensureDockerAvailable({ docker, image: 'dorkos-eval:latest' });
    expect(verdict.available).toBe(false);
    expect(verdict.reason).toMatch(/no reachable Docker daemon/i);
    expect(verdict.reason).toMatch(/Other tiers are unaffected/i);
  });

  it('SKIPS with the build command when the image is missing', async () => {
    const { docker } = fakeDocker({
      version: { code: 0, stdout: '29.5.2' },
      'image inspect': { code: 1, stderr: 'No such image' },
    });
    const verdict = await ensureDockerAvailable({ docker, image: 'dorkos-eval:latest' });
    expect(verdict.available).toBe(false);
    expect(verdict.reason).toMatch(/is not present locally/);
    expect(verdict.reason).toMatch(/docker build -t dorkos-eval:latest \./);
  });

  it('treats a missing `docker` binary as unavailable, not an exception', async () => {
    const docker: DockerCli = {
      run: async () => ({ code: null, stdout: '', stderr: 'spawn docker ENOENT' }),
    };
    const verdict = await ensureDockerAvailable({ docker, image: 'x' });
    expect(verdict.available).toBe(false);
  });
});

describe('DockerLauncher.launch — containment invariants', () => {
  it('mounts ONLY the throwaway sandbox root, nothing from the host home', async () => {
    const { docker, calls } = healthyDocker();
    const launcher = new DockerLauncher({ docker, image: 'dorkos-eval:latest' });
    await launcher.launch(spec());

    const mounts = volumes(runArgs(calls));
    expect(mounts).toEqual([
      `/private/var/folders/xy/dorkos-evals-AbC123:${CONTAINER_SANDBOX_ROOT}`,
    ]);
    // The one mount is the sandbox root; no home, no ~/.dork, no ~/.claude, no repo.
    const joined = runArgs(calls).join(' ');
    expect(joined).not.toMatch(/\/Users\//);
    expect(joined).not.toMatch(/\$HOME|\/home\/[a-z]/);
  });

  it('injects container-scoped DORK_HOME and a boundary confined to the mount', async () => {
    const { docker, calls } = healthyDocker();
    await new DockerLauncher({ docker }).launch(spec());

    const env = envOf(runArgs(calls));
    expect(env.DORK_HOME).toBe(`${CONTAINER_SANDBOX_ROOT}/.dork`);
    expect(env.DORKOS_BOUNDARY).toBe(CONTAINER_SANDBOX_ROOT);
    // Credentials ride env, never a mounted credential file.
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(env.ANTHROPIC_MODEL).toBe('claude-haiku-4-5');
    // The container binds all interfaces on the harness-allocated port.
    expect(env.DORKOS_PORT).toBe('53511');
    expect(env.DORKOS_HOST).toBe('0.0.0.0');
  });

  it('publishes the allocated port on loopback and reports the matching baseUrl', async () => {
    const { docker, calls } = healthyDocker();
    const launched = await new DockerLauncher({ docker }).launch(spec());

    const args = runArgs(calls);
    const publishIdx = args.indexOf('--publish');
    expect(args[publishIdx + 1]).toBe('127.0.0.1:53511:53511');
    expect(launched.baseUrl).toBe('http://127.0.0.1:53511');
  });

  it('reports the CONTAINER project cwd so the drive loop passes a boundary-valid path', async () => {
    const { docker } = healthyDocker();
    const launched = await new DockerLauncher({ docker }).launch(spec());
    expect(launched.projectCwd).toBe(`${CONTAINER_SANDBOX_ROOT}/project`);
  });

  it('labels the container (and the run) so strays are greppable, and starts detached without --rm', async () => {
    const { docker, calls } = healthyDocker();
    await new DockerLauncher({ docker, runId: 'run-42' }).launch(spec());

    const args = runArgs(calls);
    expect(args).toContain('--detach');
    // No --rm: a failed eval's container must survive for `docker logs`.
    expect(args).not.toContain('--rm');
    expect(args.join(' ')).toContain(`--label ${EVAL_CONTAINER_LABEL}=1`);
    expect(args.join(' ')).toContain(`--label ${EVAL_CONTAINER_LABEL}-run=run-42`);
  });

  it('surfaces a docker run failure as a thrown, diagnosable error', async () => {
    const { docker } = fakeDocker({ run: { code: 125, stderr: 'no such image' } });
    await expect(
      new DockerLauncher({ docker, image: 'missing:tag' }).launch(spec())
    ).rejects.toThrow(/docker run failed \(exit 125\).*missing:tag.*no such image/s);
  });
});

describe('DockerLauncher teardown', () => {
  it('REMOVES the container after a successful eval', async () => {
    const { docker, calls } = healthyDocker('abc123');
    const launched = await new DockerLauncher({ docker }).launch(spec());
    await launched.kill();

    const rm = calls.find((c) => c[0] === 'rm');
    expect(rm).toEqual(['rm', '--force', 'abc123']);
    expect(calls.some((c) => c[0] === 'stop')).toBe(false);
  });

  it('RETAINS the container (stop, not remove) after a FAILED eval, for debugging', async () => {
    const { docker, calls } = healthyDocker('abc123');
    const launched = await new DockerLauncher({ docker }).launch(spec());
    await launched.kill({ failed: true });

    expect(calls.find((c) => c[0] === 'stop')).toEqual(['stop', '--timeout', '5', 'abc123']);
    expect(calls.some((c) => c[0] === 'rm')).toBe(false);
    // The id is exposed so the retained container is findable via `docker logs`.
    expect(launched.containerId).toBe('abc123');
  });

  it('removes on failure when retention is disabled', async () => {
    const { docker, calls } = healthyDocker('abc123');
    const launched = await new DockerLauncher({ docker, retainOnFailure: false }).launch(spec());
    await launched.kill({ failed: true });
    expect(calls.some((c) => c[0] === 'rm')).toBe(true);
  });

  it('kill() is idempotent — a second call issues no further docker commands', async () => {
    const { docker, calls } = healthyDocker();
    const launched = await new DockerLauncher({ docker }).launch(spec());
    await launched.kill();
    const afterFirst = calls.length;
    await launched.kill();
    expect(calls.length).toBe(afterFirst);
  });

  it('exited resolves with the container exit code and a log tail (never rejects)', async () => {
    const { docker } = fakeDocker({
      run: { code: 0, stdout: 'deadbeef\n' },
      wait: { code: 0, stdout: '3\n' },
      logs: { code: 0, stdout: 'boom: boot crashed' },
    });
    const launched = await new DockerLauncher({ docker }).launch(spec());
    const exit = await launched.exited;
    expect(exit.code).toBe(3);
    expect(exit.stderr).toContain('boom: boot crashed');
  });
});

describe('isolation tier resolution', () => {
  it('parses the --isolation flag, defaulting unknown/absent to auto', () => {
    expect(parseIsolationTier('docker')).toBe('docker');
    expect(parseIsolationTier('child-process')).toBe('child-process');
    expect(parseIsolationTier(undefined)).toBe('auto');
    expect(parseIsolationTier('nonsense')).toBe('auto');
  });

  it('auto: containerizes ONLY the cases that ask for it', async () => {
    const { docker } = healthyDocker();
    const resolver = createLauncherResolver({ isolation: 'auto', docker, notify: () => {} });

    expect(await resolver.forCase({ preferDocker: false })).toBeUndefined();
    expect((await resolver.forCase({ preferDocker: true }))?.id).toBe('docker');
  });

  it('docker: containerizes every case', async () => {
    const { docker } = healthyDocker();
    const resolver = createLauncherResolver({ isolation: 'docker', docker, notify: () => {} });
    expect((await resolver.forCase({ preferDocker: false }))?.id).toBe('docker');
  });

  it('child-process: never containerizes, even a preferDocker case (and never probes)', async () => {
    const { docker, calls } = healthyDocker();
    const resolver = createLauncherResolver({
      isolation: 'child-process',
      docker,
      notify: () => {},
    });
    expect(await resolver.forCase({ preferDocker: true })).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('degrades to the default tier with ONE clear message when docker is unavailable', async () => {
    const { docker } = fakeDocker({ version: { code: 1, stderr: 'daemon down' } });
    const messages: string[] = [];
    const resolver = createLauncherResolver({
      isolation: 'docker',
      docker,
      notify: (m) => messages.push(m),
    });

    expect(await resolver.forCase({ preferDocker: true })).toBeUndefined();
    expect(await resolver.forCase({ preferDocker: true })).toBeUndefined();
    // Announced once, not once per eval, and it says the run continues.
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/no reachable Docker daemon/i);
    expect(messages[0]).toMatch(/Falling back to the child-process tier/i);
  });

  it('probes docker at most once per run (memoized across cases)', async () => {
    const { docker, calls } = healthyDocker();
    const resolver = createLauncherResolver({ isolation: 'docker', docker, notify: () => {} });
    await resolver.forCase({ preferDocker: true });
    await resolver.forCase({ preferDocker: true });
    expect(calls.filter((c) => c[0] === 'version')).toHaveLength(1);
    expect(calls.filter((c) => c[0] === 'image')).toHaveLength(1);
    expect(resolver.availability()?.available).toBe(true);
  });
});
