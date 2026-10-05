/**
 * Codex's own sleep inhibitor as a second layer under DorkOS's hold (spec
 * `keep-awake`): on exactly while the setting is on and the computer can be
 * held awake, and spelled the way the installed SDK puts it on the command line.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Codex } from '@openai/codex-sdk';
import { keepAwakeService } from '../../../core/keep-awake/index.js';
import { buildCodexOptions } from '../codex-options.js';
import { APP_SERVER_ARGS } from '../app-server/process-pool.js';
import { makeAppServerHarness, PERSON_HOME } from './app-server-harness.js';

const harnesses: Array<ReturnType<typeof makeAppServerHarness>> = [];
function harness(): ReturnType<typeof makeAppServerHarness> {
  const h = makeAppServerHarness();
  harnesses.push(h);
  return h;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(harnesses.splice(0).map((h) => h.pool.shutdown()));
});

describe('Codex prevent_idle_sleep', () => {
  it('is absent while keep-awake does not apply', () => {
    vi.spyOn(keepAwakeService, 'preventsIdleSleep').mockReturnValue(false);
    expect(buildCodexOptions('/bin/codex')).not.toHaveProperty('config');
  });

  it('is set beside the MCP servers while keep-awake applies', () => {
    vi.spyOn(keepAwakeService, 'preventsIdleSleep').mockReturnValue(true);
    expect(buildCodexOptions('/bin/codex').config).toEqual({
      features: { prevent_idle_sleep: true },
    });
    const managed = { servers: { files: { command: 'npx' } }, env: {} };
    expect(buildCodexOptions('/bin/codex', undefined, managed).config).toEqual({
      mcp_servers: { files: { command: 'npx' } },
      features: { prevent_idle_sleep: true },
    });
  });

  it.skipIf(process.platform === 'win32')(
    'reaches the codex command line as --config features.prevent_idle_sleep=true',
    async () => {
      // The REAL SDK, pointed at a stand-in binary that records its argv: this
      // pins the flattening the installed SDK actually does, not our guess at it.
      vi.spyOn(keepAwakeService, 'preventsIdleSleep').mockReturnValue(true);
      const dir = await mkdtemp(path.join(tmpdir(), 'codex-argv-'));
      try {
        const fake = path.join(dir, 'codex');
        await writeFile(fake, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$0.argv"\n');
        await chmod(fake, 0o755);

        const thread = new Codex(buildCodexOptions(fake)).startThread();
        await thread.run('hello').catch(() => undefined);

        const argv = (await readFile(`${fake}.argv`, 'utf8')).split('\n');
        const flag = argv.indexOf('features.prevent_idle_sleep=true');
        expect(flag).toBeGreaterThan(0);
        expect(argv[flag - 1]).toBe('--config');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );
});

describe('Codex prevent_idle_sleep on app-server', () => {
  // The app-server argv is fixed, so the flag rides the thread's load config
  // (stdin), never the command line.
  const loadConfig = (h: ReturnType<typeof makeAppServerHarness>) =>
    h.host.home(PERSON_HOME).processes[0]!.requestsOf('thread/start')[0]!.config as Record<
      string,
      unknown
    >;

  it('loads the thread with features.prevent_idle_sleep while keep-awake applies', async () => {
    vi.spyOn(keepAwakeService, 'preventsIdleSleep').mockReturnValue(true);
    const h = harness();
    await h.run(h.request({ sessionId: 's1' }));
    expect(loadConfig(h).features).toEqual({ prevent_idle_sleep: true });
    expect(h.host.spawns[0]!.args).toEqual([...APP_SERVER_ARGS]);
  });

  it('leaves it out while keep-awake does not apply', async () => {
    vi.spyOn(keepAwakeService, 'preventsIdleSleep').mockReturnValue(false);
    const h = harness();
    await h.run(h.request({ sessionId: 's1' }));
    expect(loadConfig(h)).not.toHaveProperty('features');
  });

  it('marks the process stale when the setting changes under a loaded thread', async () => {
    const applies = vi.spyOn(keepAwakeService, 'preventsIdleSleep').mockReturnValue(false);
    const h = harness();
    await h.run(h.request({ sessionId: 's1' }));
    const threadId = h.bindings[0]!.threadId;
    expect(h.pool.list()[0]!.stale).toBe(false);
    applies.mockReturnValue(true);
    await h.run(h.request({ sessionId: 's1', boundThreadId: threadId }));
    expect(h.pool.list()[0]!.stale).toBe(true);
  });
});
