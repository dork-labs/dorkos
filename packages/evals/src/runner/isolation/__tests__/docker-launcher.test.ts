/**
 * Docker isolation tier: the launcher's `docker` invocations, its containment
 * invariants, and the graceful SKIP when no daemon or image is present (spec
 * `agent-trust`, task 3.4). Every path is driven through the injectable
 * {@link DockerCli} seam plus a fake namespace channel, so these tests need no
 * daemon.
 *
 * The load-bearing assertions are the containment ones, and they are the ones
 * that were missing: the ONLY `--volume` is the eval's throwaway sandbox, AND the
 * container has no network at all, no capabilities, and bounded resources. A
 * container on the default bridge could reach the internet and the developer's
 * own DorkOS on host loopback — verified by hand before this was fixed — while
 * the tier's own docstring claimed it "must not touch the host".
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  DockerLauncher,
  ensureDockerAvailable,
  resolveEvalImage,
  DEFAULT_EVAL_IMAGE,
  CONTAINER_SANDBOX_ROOT,
  EVAL_CONTAINER_LABEL,
  type DockerCli,
} from '../docker-launcher.js';
import type { NetnsChannel, OpenNetnsChannel } from '../netns-proxy.js';
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

/**
 * A namespace channel that opens nothing.
 *
 * `launch()` binds a real loopback listener (that is how a `--network none`
 * container is reachable at all), but the CHANNEL into the container is faked:
 * these tests assert the docker arguments and the teardown, not byte relaying,
 * which `netns-proxy.test.ts` covers end to end.
 */
function fakeChannel(): { open: OpenNetnsChannel; opened: { id: string; port: number }[] } {
  const opened: { id: string; port: number }[] = [];
  const open: OpenNetnsChannel = (id, port) => {
    opened.push({ id, port });
    const channel: NetnsChannel = {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      close: () => {},
    };
    return channel;
  };
  return { open, opened };
}

/**
 * Build a launcher whose namespace channel is faked and whose proxy binds a
 * genuinely free loopback port, so tests never collide with each other or with a
 * real service.
 */
async function launcherOn(
  docker: DockerCli,
  opts: { runId?: string; retainOnFailure?: boolean } = {}
): Promise<{ launcher: DockerLauncher; port: number }> {
  const { open } = fakeChannel();
  const port = await freePort();
  return {
    launcher: new DockerLauncher({ docker, openChannel: open, ...opts }),
    port,
  };
}

/** Allocate a free loopback port by binding `:0` and releasing it. */
async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
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

  it('SKIPS with the build command when the image is really missing', async () => {
    const { docker } = fakeDocker({
      version: { code: 0, stdout: '29.5.2' },
      'image inspect': { code: 1, stderr: 'No such image' },
      'image ls': { code: 0, stdout: '' },
    });
    const verdict = await ensureDockerAvailable({ docker, image: 'dorkos-eval:latest' });
    expect(verdict.available).toBe(false);
    expect(verdict.reason).toMatch(/is not present locally/);
    expect(verdict.reason).toMatch(/docker build -t dorkos-eval:latest \./);
  });

  it('does NOT skip when `image inspect` flakes but `image ls` finds the image', async () => {
    // Observed on Docker 29 + the containerd image store: `image inspect <tag>`
    // intermittently answers "No such image" for an image `image ls` lists and
    // `docker run` starts. A false negative here silently demotes a destructive
    // eval from a container to the bare host.
    const { docker } = fakeDocker({
      version: { code: 0, stdout: '29.5.2' },
      'image inspect': { code: 1, stderr: 'Error response from daemon: No such image' },
      'image ls': { code: 0, stdout: 'b3d8385e5c23\n' },
    });
    const verdict = await ensureDockerAvailable({ docker, image: 'dorkos-eval:latest' });
    expect(verdict.available).toBe(true);
    expect(verdict.reason).toBeUndefined();
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
    const { launcher, port } = await launcherOn(docker);
    const launched = await launcher.launch(spec({ port }));

    const mounts = volumes(runArgs(calls));
    expect(mounts).toEqual([
      `/private/var/folders/xy/dorkos-evals-AbC123:${CONTAINER_SANDBOX_ROOT}`,
    ]);
    // The one mount is the sandbox root; no home, no ~/.dork, no ~/.claude, no repo.
    const joined = runArgs(calls).join(' ');
    expect(joined).not.toMatch(/\/Users\//);
    expect(joined).not.toMatch(/\$HOME|\/home\/[a-z]/);
    await launched.kill();
  });

  it('gives the container NO NETWORK, and never asks docker to publish a port', async () => {
    const { docker, calls } = healthyDocker();
    const { launcher, port } = await launcherOn(docker);
    const launched = await launcher.launch(spec({ port }));

    const args = runArgs(calls);
    // The containment claim. On the default bridge, a container launched with the
    // old flag set reached https://example.com AND host.docker.internal — i.e. the
    // developer's own DorkOS on 127.0.0.1, whose DORK_HOME is the real ~/.dork.
    expect(args.join(' ')).toContain('--network none');
    // `--publish` is not merely unnecessary here, it is a lie: docker accepts it
    // alongside `--network none` and the host port then never answers.
    expect(args).not.toContain('--publish');
    await launched.kill();
  });

  it('drops every capability and bounds memory, swap, CPU, and pids', async () => {
    const { docker, calls } = healthyDocker();
    const { launcher, port } = await launcherOn(docker);
    const launched = await launcher.launch(spec({ port }));

    const args = runArgs(calls);
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges');
    const memory = args.find((a) => a.startsWith('--memory='));
    const swap = args.find((a) => a.startsWith('--memory-swap='));
    // Swap must equal memory: a container allowed to swap trades the ceiling for
    // wall-clock instead of failing.
    expect(swap?.replace('--memory-swap=', '')).toBe(memory?.replace('--memory=', ''));
    expect(args.some((a) => a.startsWith('--cpus='))).toBe(true);
    expect(args.some((a) => a.startsWith('--pids-limit='))).toBe(true);
    await launched.kill();
  });

  it('injects container-scoped DORK_HOME and a boundary confined to the mount', async () => {
    const { docker, calls } = healthyDocker();
    const { launcher, port } = await launcherOn(docker);
    const launched = await launcher.launch(spec({ port }));

    const env = envOf(runArgs(calls));
    expect(env.DORK_HOME).toBe(`${CONTAINER_SANDBOX_ROOT}/.dork`);
    expect(env.DORKOS_BOUNDARY).toBe(CONTAINER_SANDBOX_ROOT);
    // Credentials ride env, never a mounted credential file.
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(env.ANTHROPIC_MODEL).toBe('claude-haiku-4-5');
    // Binding all interfaces is harmless with no network: loopback is the only one.
    expect(env.DORKOS_PORT).toBe(String(port));
    expect(env.DORKOS_HOST).toBe('0.0.0.0');
    await launched.kill();
  });

  it('reaches the network-less container through a loopback namespace proxy', async () => {
    const { docker } = healthyDocker('abc123');
    const { open, opened } = fakeChannel();
    const port = await freePort();
    const launched = await new DockerLauncher({ docker, openChannel: open }).launch(spec({ port }));

    expect(launched.baseUrl).toBe(`http://127.0.0.1:${String(port)}`);
    // The proxy is bound and answering TCP before launch() resolves, so the
    // caller's first health poll has something to connect to.
    const net = await import('node:net');
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', reject);
    });
    // The server's 'connection' event lands on a later tick than connect().
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Each connection is relayed into THIS container, at the server's own port.
    expect(opened).toEqual([{ id: 'abc123', port }]);
    await launched.kill();
  });

  it('reports the CONTAINER project cwd so the drive loop passes a boundary-valid path', async () => {
    const { docker } = healthyDocker();
    const { launcher, port } = await launcherOn(docker);
    const launched = await launcher.launch(spec({ port }));
    expect(launched.projectCwd).toBe(`${CONTAINER_SANDBOX_ROOT}/project`);
    await launched.kill();
  });

  it('labels the container (and the run) so strays are greppable, and starts detached without --rm', async () => {
    const { docker, calls } = healthyDocker();
    const { launcher, port } = await launcherOn(docker, { runId: 'run-42' });
    const launched = await launcher.launch(spec({ port }));

    const args = runArgs(calls);
    expect(args).toContain('--detach');
    // No --rm: a failed eval's container must survive for `docker logs`.
    expect(args).not.toContain('--rm');
    expect(args.join(' ')).toContain(`--label ${EVAL_CONTAINER_LABEL}=1`);
    expect(args.join(' ')).toContain(`--label ${EVAL_CONTAINER_LABEL}-run=run-42`);
    await launched.kill();
  });

  it('surfaces a docker run failure as a thrown, diagnosable error', async () => {
    const { docker } = fakeDocker({ run: { code: 125, stderr: 'no such image' } });
    const { open } = fakeChannel();
    await expect(
      new DockerLauncher({ docker, image: 'missing:tag', openChannel: open }).launch(spec())
    ).rejects.toThrow(/docker run failed \(exit 125\).*missing:tag.*no such image/s);
  });

  it('removes the container when the namespace proxy cannot bind, rather than orphaning it', async () => {
    const { docker, calls } = healthyDocker('abc123');
    const { open } = fakeChannel();
    // Occupy the port so the proxy's listen() fails.
    const net = await import('node:net');
    const port = await freePort();
    const squatter = net.createServer();
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', () => resolve()));

    try {
      await expect(
        new DockerLauncher({ docker, openChannel: open }).launch(spec({ port }))
      ).rejects.toThrow(/namespace proxy/);
      // The caller never got a handle, so the launcher itself must clean up.
      expect(calls.find((c) => c[0] === 'rm')).toEqual(['rm', '--force', 'abc123']);
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });
});

describe('DockerLauncher teardown', () => {
  it('REMOVES the container after a successful eval', async () => {
    const { docker, calls } = healthyDocker('abc123');
    const { launcher, port } = await launcherOn(docker);
    const launched = await launcher.launch(spec({ port }));
    await launched.kill();

    const rm = calls.find((c) => c[0] === 'rm');
    expect(rm).toEqual(['rm', '--force', 'abc123']);
    expect(calls.some((c) => c[0] === 'stop')).toBe(false);
  });

  it('RETAINS the container (stop, not remove) after a FAILED eval, for debugging', async () => {
    const { docker, calls } = healthyDocker('abc123');
    const { launcher, port } = await launcherOn(docker);
    const launched = await launcher.launch(spec({ port }));
    await launched.kill({ failed: true });

    expect(calls.find((c) => c[0] === 'stop')).toEqual(['stop', '--timeout', '5', 'abc123']);
    expect(calls.some((c) => c[0] === 'rm')).toBe(false);
    // The id is exposed so the retained container is findable via `docker logs`.
    expect(launched.containerId).toBe('abc123');
  });

  it('frees the harness port even when the container is RETAINED', async () => {
    const { docker } = healthyDocker('abc123');
    const { launcher, port } = await launcherOn(docker);
    const launched = await launcher.launch(spec({ port }));
    await launched.kill({ failed: true });

    // A retained container must not hold the loopback port hostage: the next eval
    // may be handed the same one.
    const net = await import('node:net');
    const rebound = net.createServer();
    await new Promise<void>((resolve, reject) => {
      rebound.once('error', reject);
      rebound.listen(port, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve) => rebound.close(() => resolve()));
  });

  it('removes on failure when retention is disabled', async () => {
    const { docker, calls } = healthyDocker('abc123');
    const { launcher, port } = await launcherOn(docker, { retainOnFailure: false });
    const launched = await launcher.launch(spec({ port }));
    await launched.kill({ failed: true });
    expect(calls.some((c) => c[0] === 'rm')).toBe(true);
  });

  it('kill() is idempotent — a second call issues no further docker commands', async () => {
    const { docker, calls } = healthyDocker();
    const { launcher, port } = await launcherOn(docker);
    const launched = await launcher.launch(spec({ port }));
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
    const { open } = fakeChannel();
    const port = await freePort();
    const launched = await new DockerLauncher({ docker, openChannel: open }).launch(spec({ port }));
    const exit = await launched.exited;
    expect(exit.code).toBe(3);
    expect(exit.stderr).toContain('boom: boot crashed');
    await launched.kill();
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

  it('auto: declines docker when the credential is one a container cannot be given', async () => {
    // The machine's `claude` sign-in lives in its keychain and home folder, so a
    // container cannot use it. Under `auto` that has to behave like a missing
    // daemon: degrade with a message. Erroring instead would mean HAVING docker
    // installed makes an ordinary local run fail where a machine without docker
    // succeeds, which is backwards.
    const { docker, calls } = healthyDocker();
    const messages: string[] = [];
    const resolver = createLauncherResolver({
      isolation: 'auto',
      docker,
      credentialIsPortable: false,
      notify: (m) => messages.push(m),
    });

    expect(await resolver.forCase({ preferDocker: true })).toBeUndefined();
    expect(await resolver.forCase({ preferDocker: true })).toBeUndefined();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/a container cannot see/i);
    // It never even probed: the answer could not depend on docker's health.
    expect(calls).toEqual([]);
  });

  it('explicit docker: still hands back the launcher, so the run refuses loudly', async () => {
    // Someone who typed `--isolation docker` asked for containment by name. The
    // honest answer is the runner error naming the two variables, NOT a silent
    // downgrade that runs a destructive turn outside the container they asked for.
    const { docker } = healthyDocker();
    const resolver = createLauncherResolver({
      isolation: 'docker',
      docker,
      credentialIsPortable: false,
      notify: () => {},
    });
    expect((await resolver.forCase({ preferDocker: true }))?.id).toBe('docker');
  });

  it('probes docker at most once per run (memoized across cases)', async () => {
    const { docker, calls } = healthyDocker();
    const resolver = createLauncherResolver({ isolation: 'docker', docker, notify: () => {} });
    await resolver.forCase({ preferDocker: true });
    await resolver.forCase({ preferDocker: true });
    expect(calls.filter((c) => c[0] === 'version')).toHaveLength(1);
    expect(calls.filter((c) => c[0] === 'image')).toHaveLength(1);
  });
});
