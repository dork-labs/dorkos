import { afterEach, describe, expect, it } from 'vitest';
import { FakeAppServerHost, type FakeAppServer } from '../../__tests__/fake-app-server.js';
import {
  APP_SERVER_ARGS,
  CodexAppServerPool,
  CodexCrashLoopError,
  environmentFingerprint,
  processKeyOf,
  type CodexProcessSpec,
} from '../process-pool.js';

const PERSON: CodexProcessSpec = {
  binary: '/opt/codex',
  codexHome: '/home/me/.codex',
  env: { PATH: '/usr/bin', CODEX_HOME: '/home/me/.codex' },
};
const CREDITS: CodexProcessSpec = {
  binary: '/opt/codex',
  codexHome: '/dork/credits',
  env: { PATH: '/usr/bin', CODEX_HOME: '/dork/credits' },
};

const pools: CodexAppServerPool[] = [];
function makePool(host = new FakeAppServerHost(), now = () => Date.now()) {
  const pool = new CodexAppServerPool({
    spawn: host.spawn,
    now,
    timing: { shutdownStepMs: 20, idleMs: 1_000, crashCooldownMs: 30_000 },
  });
  pools.push(pool);
  return { pool, host };
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('keying', () => {
  it('fingerprints the environment by value without holding a value in the key', () => {
    const a = environmentFingerprint({ B: '2', A: '1' });
    expect(a).toBe(environmentFingerprint({ A: '1', B: '2' }));
    expect(a).not.toBe(environmentFingerprint({ A: '1', B: '3' }));
    const key = processKeyOf({ ...PERSON, env: { SECRET: 'sk-very-secret' } });
    expect(key).not.toContain('sk-very-secret');
  });

  it('gives each home its own process and reuses it', async () => {
    const { pool, host } = makePool();
    const one = await pool.acquire(PERSON);
    const again = await pool.acquire(PERSON);
    const credits = await pool.acquire(CREDITS);
    expect(again).toBe(one);
    expect(credits).not.toBe(one);
    expect(host.spawns).toHaveLength(2);
  });
});

describe('spawning', () => {
  it('spawns exactly `app-server --listen stdio://` in the home, with the experimental API', async () => {
    const { pool, host } = makePool();
    const proc = await pool.acquire(PERSON);
    expect(host.spawns[0]!.args).toEqual([...APP_SERVER_ARGS]);
    expect(host.spawns[0]!.env).toEqual({ RUST_LOG: 'warn', ...PERSON.env });
    const init = host.processes[0]!.requestsOf('initialize')[0]!;
    expect(init).toMatchObject({
      clientInfo: { name: 'dorkos', title: 'DorkOS' },
      capabilities: { experimentalApi: true },
    });
    expect(host.processes[0]!.received.map((m) => m.method)).toEqual(['initialize', 'initialized']);
    expect(proc.version).toBe('0.154.0');
    expect(pool.lastSeenVersion).toBe('0.154.0');
  });

  it('keeps an operator-set RUST_LOG', async () => {
    const { pool, host } = makePool();
    await pool.acquire({ ...PERSON, env: { ...PERSON.env, RUST_LOG: 'debug' } });
    expect(host.spawns[0]!.env.RUST_LOG).toBe('debug');
  });

  it('shares one in-flight boot between concurrent callers', async () => {
    const { pool, host } = makePool();
    const [a, b, c] = await Promise.all([
      pool.acquire(PERSON),
      pool.acquire(PERSON),
      pool.acquire(PERSON),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(host.spawns).toHaveLength(1);
  });

  it('drains the old process when the key for its home moves on', async () => {
    const { pool, host } = makePool();
    const old = await pool.acquire(PERSON);
    const release = old.hold();
    const next = await pool.acquire({ ...PERSON, binary: '/opt/codex-new' });
    expect(next).not.toBe(old);
    expect(old.stale).toBe(true);
    await pool.reapOnce();
    // Still held, so still running.
    expect(host.processes[0]!.hasExited).toBe(false);
    release();
    await pool.reapOnce();
    expect(host.processes[0]!.hasExited).toBe(true);
    expect(host.processes[1]!.hasExited).toBe(false);
  });
});

describe('crashes', () => {
  it('tells everyone waiting on the connection when the process stops on its own', async () => {
    const { pool, host } = makePool();
    const proc = await pool.acquire(PERSON);
    const exits: string[] = [];
    proc.onExit((close) => exits.push(`${close.kind}:${close.detail}`));
    const pending = proc.client.request('config/read', { cwd: '/p' });
    // A config/read is answered at once by the fake; crash before it is.
    host.processes[0]!.exit(137);
    await expect(pending)
      .resolves.toBeDefined()
      .catch(() => undefined);
    await tick();
    await tick();
    expect(exits).toEqual(['exited:exit code 137']);
    expect(pool.list()).toEqual([]);
    // The next acquire respawns lazily.
    const again = await pool.acquire(PERSON);
    expect(again).not.toBe(proc);
    expect(host.spawns).toHaveLength(2);
  });

  it('refuses a respawn for a while after three crashes in a minute', async () => {
    let clock = 1_000_000;
    const { pool, host } = makePool(new FakeAppServerHost(), () => clock);
    for (let crash = 0; crash < 3; crash += 1) {
      await pool.acquire(PERSON);
      host.processes[crash]!.exit(1);
      await tick();
      await tick();
      clock += 5_000;
    }
    await expect(pool.acquire(PERSON)).rejects.toBeInstanceOf(CodexCrashLoopError);
    await expect(pool.acquire(PERSON)).rejects.toThrow(
      'Codex keeps stopping. Try again in a minute.'
    );
    // Another home is unaffected.
    await expect(pool.acquire(CREDITS)).resolves.toBeDefined();
    clock += 30_000;
    await expect(pool.acquire(PERSON)).resolves.toBeDefined();
  });

  it('treats a protocol fault as a crash and stops the child it spawned', async () => {
    const { pool, host } = makePool();
    const proc = await pool.acquire(PERSON);
    const exits: string[] = [];
    proc.onExit((close) => exits.push(close.kind));
    host.processes[0]!.stdout.write('not json at all\n');
    await tick();
    await tick();
    expect(exits).toEqual(['protocol-fault']);
    expect(host.processes[0]!.killSignals).toEqual(['SIGTERM']);
  });

  it('counts a failed initialize as a crash and rethrows it', async () => {
    const host = new FakeAppServerHost();
    const spawn: typeof host.spawn = (binary, args, options) => {
      const server = host.spawn(binary, args, options);
      // Answer initialize with a refusal.
      server.stdin.removeAllListeners('data');
      server.stdin.on('data', (chunk: Buffer) => {
        const message = JSON.parse(chunk.toString().trim()) as { id: number };
        server.send({ id: message.id, error: { code: -32600, message: 'Already initialized' } });
      });
      return server;
    };
    const pool = new CodexAppServerPool({ spawn, timing: { shutdownStepMs: 20 } });
    pools.push(pool);
    await expect(pool.acquire(PERSON)).rejects.toThrow(/Already initialized/);
    expect(host.processes[0]!.killSignals).toEqual(['SIGTERM']);
    expect(pool.list()).toEqual([]);
  });
});

describe('idle reaping', () => {
  it('never reaps a held process, and reaps one idle past the window', async () => {
    let clock = 0;
    const { pool, host } = makePool(new FakeAppServerHost(), () => clock);
    const proc = await pool.acquire(PERSON);
    const release = proc.hold();
    clock += 10_000;
    await pool.reapOnce();
    expect(host.processes[0]!.hasExited).toBe(false);
    release();
    clock += 999;
    await pool.reapOnce();
    expect(host.processes[0]!.hasExited).toBe(false);
    clock += 1;
    await pool.reapOnce();
    expect(host.processes[0]!.hasExited).toBe(true);
    expect(pool.list()).toEqual([]);
  });

  it('recycles a stale process as soon as nothing holds it', async () => {
    const { pool, host } = makePool();
    const proc = await pool.acquire(PERSON);
    proc.stale = true;
    await pool.reapOnce();
    expect(host.processes[0]!.hasExited).toBe(true);
  });
});

describe('shutdown', () => {
  it('ends stdin first, and a process that exits on EOF is never signalled', async () => {
    const { pool, host } = makePool();
    await pool.acquire(PERSON);
    await pool.shutdown();
    expect(host.processes[0]!.hasExited).toBe(true);
    expect(host.processes[0]!.killSignals).toEqual([]);
  });

  it('escalates to SIGTERM then SIGKILL for a process that ignores EOF and SIGTERM', async () => {
    const host = new FakeAppServerHost();
    const stubborn: FakeAppServer[] = [];
    const spawn: typeof host.spawn = (binary, args, options) => {
      const server = host.spawn(binary, args, options);
      server.stdin.removeAllListeners('finish');
      const realKill = server.kill.bind(server);
      // Ignores everything but SIGKILL (which the real kill records).
      server.kill = (signal: NodeJS.Signals | number = 'SIGTERM') => {
        if (signal === 'SIGKILL') return realKill('SIGKILL');
        server.killSignals.push(String(signal));
        return true;
      };
      stubborn.push(server);
      return server;
    };
    const pool = new CodexAppServerPool({ spawn, timing: { shutdownStepMs: 10 } });
    await pool.acquire(PERSON);
    await pool.shutdown();
    expect(stubborn[0]!.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(stubborn[0]!.hasExited).toBe(true);
  });
});

describe('review fixes', () => {
  it('never orphans a stale-but-held process: shutdown still stops it', async () => {
    const { pool, host } = makePool();
    const old = await pool.acquire(PERSON);
    const release = old.hold();
    old.stale = true;
    const next = await pool.acquire(PERSON);
    expect(next).not.toBe(old);
    expect(pool.list()).toContain(old);
    await pool.reapOnce();
    expect(host.processes[0]!.hasExited).toBe(false);
    await pool.shutdown();
    expect(host.processes[0]!.hasExited).toBe(true);
    expect(host.processes[1]!.hasExited).toBe(true);
    release();
  });

  it('closes a draining process the moment its last hold releases', async () => {
    const { pool, host } = makePool();
    const old = await pool.acquire(PERSON);
    const release = old.hold();
    old.stale = true;
    await pool.acquire(PERSON);
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.processes[0]!.hasExited).toBe(true);
    expect(pool.list()).toHaveLength(1);
  });

  it('does not reap a process whose liveness probe reports background work', async () => {
    let clock = 0;
    const { pool, host } = makePool(new FakeAppServerHost(), () => clock);
    const proc = await pool.acquire(PERSON);
    let busy = true;
    proc.addLivenessProbe(async () => busy);
    clock += 10_000;
    await pool.reapOnce();
    expect(host.processes[0]!.hasExited).toBe(false);
    busy = false;
    await pool.reapOnce();
    expect(host.processes[0]!.hasExited).toBe(true);
  });

  it('stays shut after shutdown: nothing respawns', async () => {
    const { pool, host } = makePool();
    await pool.acquire(PERSON);
    await pool.shutdown();
    await expect(pool.acquire(PERSON)).rejects.toThrow(/shutting down/);
    expect(host.spawns).toHaveLength(1);
  });
});
