/**
 * Shutdown leaves no orphan subprocess (task 3.2, acceptance 4).
 *
 * The unit tests drive fakes, which can only prove the pump CALLED the right
 * seams. This one spawns real child processes, tears them down through the real
 * `shutdownSessionPumps()`, and then asks the operating system whether they are
 * still there. A test that trusted a spy here would keep passing on the day the
 * teardown stopped killing anything, which is exactly the failure worth
 * catching: a person's laptop quietly running CLI children after DorkOS exits.
 *
 * Both endings the pump has to handle are covered — the child that exits when
 * its stdin closes (the polite drain), and the one that ignores it (the
 * forceful close after the grace window).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SessionPumpRegistry, shutdownSessionPumps } from '../session-pump-registry.js';
import type { PumpLaunchInput, PumpQuery } from '../session-pump.js';

/** A child that exits as soon as its stdin closes — a well-behaved CLI. */
const POLITE_CHILD = 'process.stdin.on("end", () => process.exit(0)); process.stdin.resume();';

/** A child that ignores stdin EOF and has to be killed — a wedged CLI. */
const WEDGED_CHILD = 'process.stdin.resume(); setInterval(() => {}, 1000);';

/** Is this pid still a live process? Signal 0 tests existence without signalling. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const spawned: ChildProcess[] = [];

/**
 * A query over a REAL child process: the held prompt feeds its stdin, and
 * `close()` terminates it the way the SDK's `Query.close()` terminates the CLI.
 */
function launchRealChild(source: string) {
  return (input: PumpLaunchInput): PumpQuery => {
    const child = spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'ignore', 'ignore'] });
    spawned.push(child);
    // Drive the held prompt into the child's stdin, exactly as the SDK drives
    // it into the CLI's: each accepted message is written, and the stream
    // completing (a polite `close()`) is what closes stdin.
    void (async () => {
      try {
        for await (const message of input.prompt) {
          child.stdin?.write(`${JSON.stringify(message)}\n`);
        }
      } catch {
        /* the consumer walked away */
      }
      child.stdin?.end();
    })();
    let ended = false;
    child.once('exit', () => {
      ended = true;
    });
    return {
      close: () => {
        child.kill('SIGKILL');
      },
      // A bare node child has no SDK control channel. Rejecting is the honest
      // stand-in, and this suite is about process teardown, not accounting.
      getContextUsage: () => Promise.reject(new Error('no control channel')),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () =>
        Promise.reject(new Error('no control channel')),
      async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
        yield {
          type: 'system',
          subtype: 'init',
          apiKeySource: 'user',
          claude_code_version: '0.0.0-test',
          cwd: process.cwd(),
          tools: [],
          mcp_servers: [],
          model: 'test-model',
          permissionMode: 'default',
          slash_commands: [],
          output_style: 'default',
          skills: [],
          plugins: [],
          uuid: '00000000-0000-0000-0000-000000000000',
          session_id: input.sessionId,
        } as SDKMessage;
        // The process's output for the rest of its life: nothing, until it ends.
        while (!ended) {
          await new Promise<void>((resolve) => {
            child.once('exit', () => resolve());
            setTimeout(resolve, 25).unref?.();
          });
        }
      },
    };
  };
}

/** Wait for `check` to hold, or give up — no sleeps standing in for a signal. */
async function until(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

afterEach(async () => {
  await shutdownSessionPumps();
  for (const child of spawned.splice(0)) child.kill('SIGKILL');
});

describe('shutdownServices leaves no warm claude-code subprocess behind', () => {
  it('kills a child that exits on stdin close, and one that refuses to', async () => {
    const registry = new SessionPumpRegistry();
    const polite = registry.acquire('polite', {
      maxWarmSessions: 12,
      warmIdleMs: 5 * 60 * 1000,
      launch: launchRealChild(POLITE_CHILD),
      drainGraceMs: 2_000,
    });
    const wedged = registry.acquire('wedged', {
      maxWarmSessions: 12,
      warmIdleMs: 5 * 60 * 1000,
      launch: launchRealChild(WEDGED_CHILD),
      drainGraceMs: 200,
    });
    await polite.warm();
    await wedged.warm();

    const pids = spawned.map((child) => child.pid!);
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(isAlive(pid)).toBe(true);

    await shutdownSessionPumps();

    for (const pid of pids) {
      expect(await until(() => !isAlive(pid))).toBe(true);
    }
    expect(registry.size).toBe(0);
  });

  it('reaping one session leaves the process gone and the record untouched', async () => {
    const registry = new SessionPumpRegistry();
    const pump = registry.acquire('s1', {
      maxWarmSessions: 12,
      warmIdleMs: 5 * 60 * 1000,
      launch: launchRealChild(POLITE_CHILD),
      drainGraceMs: 2_000,
    });
    await pump.warm();
    const pid = spawned[0]!.pid!;

    await registry.reap('s1');

    expect(await until(() => !isAlive(pid))).toBe(true);
    expect(registry.warmth('s1')).toBe('cold');
  });
});
