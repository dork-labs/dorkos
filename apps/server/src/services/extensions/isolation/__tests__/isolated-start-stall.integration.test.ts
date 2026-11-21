/** Startup deadlines count host-awake time, just like the running watchdog. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, createHarness, makeHost, type Harness } from './isolation-harness.js';

describe('isolated startup after a host stall', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await cleanup(h);
  });

  it.each(['hello', 'load'] as const)(
    'reads the pending %s reply after the host resumes',
    async (phase) => {
      const marker = `STARTUP-${phase}`;
      const bootstrap = path.join(h.tmp, 'startup.cjs');
      const original = await fs.readFile(h.bootstrap, 'utf8');
      await fs.writeFile(
        bootstrap,
        phase === 'hello' ? `console.log('${marker}');\n${original}` : original
      );
      const bundle = path.join(h.tmp, 'bundles', 'startup.js');
      await fs.writeFile(
        bundle,
        `${phase === 'load' ? `console.log('${marker}');` : ''}
      module.exports.default = function register() {};`
      );
      let stalls = 0;
      const host = makeHost(h, {
        bundle,
        overrides: {
          bootstrapPath: bootstrap,
          timings: { helloTimeoutMs: 1_000, loadTimeoutMs: 1_000 },
          logger: {
            info: (message) => {
              h.logs.push({ level: 'info', message });
              if (message.includes(marker)) {
                stalls++;
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000);
              }
            },
            warn: (message) => h.logs.push({ level: 'warn', message }),
            error: (message) => h.logs.push({ level: 'error', message }),
          },
        },
      });

      expect(await host.start()).toEqual({ ok: true });
      expect(stalls).toBe(1);
      expect(host.running).toBe(true);
    },
    15_000
  );

  it('still refuses a child that never sends a self-check while the host is awake', async () => {
    const bootstrap = path.join(h.tmp, 'silent.cjs');
    await fs.writeFile(bootstrap, 'setInterval(() => {}, 1000);');
    const host = makeHost(h, {
      overrides: { bootstrapPath: bootstrap, timings: { helloTimeoutMs: 300 } },
    });
    expect(await host.start()).toMatchObject({ ok: false, code: 'isolation_unavailable' });
    expect(host.running).toBe(false);
  });

  it('still stops a bundle that never registers while the host is awake', async () => {
    const bundle = path.join(h.tmp, 'bundles', 'hung-start.js');
    await fs.writeFile(
      bundle,
      'module.exports.default = async function register() { await new Promise(() => {}); };'
    );
    const host = makeHost(h, { bundle, overrides: { timings: { loadTimeoutMs: 300 } } });
    expect(await host.start()).toMatchObject({ ok: false, code: 'server_start_timeout' });
    expect(host.running).toBe(false);
  });
});
