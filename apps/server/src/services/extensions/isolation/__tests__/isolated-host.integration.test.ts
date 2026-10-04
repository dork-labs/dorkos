/**
 * IsolatedExtensionHost against real child processes (DOR-2686 tasks 3.1 and
 * 3.3): the fixed grants hold, the environment is scrubbed, the assets folder
 * cannot link out, the self-check fails closed, and `stop()` always ends the
 * child. Every refusal is paired with a control that shows the same probe
 * succeeding where nothing stops it, so none of these can pass vacuously.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isolatedFilesDir } from '../grants.js';
import {
  cleanup,
  createHarness,
  makeHost,
  probe,
  runControl,
  startOk,
  type Harness,
} from './isolation-harness.js';

const ACCESS_DENIED = 'ERR_ACCESS_DENIED';

describe('IsolatedExtensionHost (real child processes)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await cleanup(h);
  });

  // Purpose: the happy path — a real child passes the self-check under the
  // real flags, loads the bundle, and answers a probe.
  it('starts a child that passes the self-check and loads its bundle', async () => {
    const host = makeHost(h);
    await startOk(host);
    expect(host.running).toBe(true);
    const flags = await probe(host, 'argvFlags');
    expect(flags.value).toEqual(
      expect.arrayContaining(['--permission', '--max-old-space-size=256'])
    );
    expect((flags.value as string[]).some((f) => f.startsWith('--allow-child-process'))).toBe(
      false
    );
  });

  // Purpose: fail closed (D7). Without --permission the child reports the
  // model absent, and the host refuses — never runs it anyway.
  it('refuses to run a child whose permission model is off', async () => {
    const host = makeHost(h, { overrides: { testSeams: { probes: true, omitPermission: true } } });
    const result = await host.start();
    expect(result).toEqual({
      ok: false,
      code: 'isolation_unavailable',
      message: "Probe couldn't start with its limits on this computer, so DorkOS left it off.",
    });
    expect(host.running).toBe(false);
    expect(h.logs.some((l) => l.message.includes('self-check failed'))).toBe(true);
  });

  // Purpose: a child that dies before its self-check is the same refusal,
  // never a hang and never a start.
  it('refuses when the child dies before its self-check', async () => {
    // A bootstrap that exits at once stands in for any child that cannot start.
    const dead = path.join(h.tmp, 'dead.cjs');
    await fs.writeFile(dead, 'process.exit(3);\n');
    const host = makeHost(h, { overrides: { bootstrapPath: dead } });
    expect(await host.start()).toMatchObject({ ok: false, code: 'isolation_unavailable' });
    expect(host.running).toBe(false);
  });

  // Purpose: the child cannot read DorkOS's data directory (config.json is
  // where secrets and tokens live); the control reads it fine.
  it("can't read DorkOS's config", async () => {
    const config = path.join(h.dorkHome, 'config.json');
    await fs.writeFile(config, '{"secret":"x"}');
    const host = makeHost(h);
    await startOk(host);
    const refused = await probe(host, 'readFile', config);
    expect(refused).toMatchObject({ ok: false, code: ACCESS_DENIED });
    expect(await runControl(h, 'readFile', config)).toMatchObject({
      ok: true,
      value: '{"secret":"x"}',
    });
  });

  // Purpose: writes land only in its own files folder: inside it works,
  // anywhere else (even next to it) is denied; the control can write there.
  it('writes only inside its files folder', async () => {
    const host = makeHost(h, { id: 'writer' });
    await startOk(host);
    const files = isolatedFilesDir(h.dorkHome, 'writer');
    expect(await probe(host, 'writeFile', path.join(files, 'ok.txt'), 'hi')).toEqual({
      ok: true,
      value: true,
    });
    expect(await fs.readFile(path.join(files, 'ok.txt'), 'utf8')).toBe('hi');
    const outside = path.join(h.dorkHome, 'extension-data', 'writer', 'data.json');
    expect(await probe(host, 'writeFile', outside, 'x')).toMatchObject({
      ok: false,
      code: ACCESS_DENIED,
    });
    expect(await runControl(h, 'writeFile', outside, 'x')).toMatchObject({ ok: true });
  });

  // Purpose: the escape routes the network guard depends on are closed by
  // Node itself — processes (around the shim), workers, internal bindings.
  it('cannot start processes or workers, or reach internal bindings', async () => {
    const host = makeHost(h);
    await startOk(host);
    expect(await probe(host, 'realExecSync')).toMatchObject({ ok: false, code: ACCESS_DENIED });
    expect(await probe(host, 'worker')).toMatchObject({ ok: false, code: ACCESS_DENIED });
    expect(await probe(host, 'binding')).toMatchObject({ ok: false, code: ACCESS_DENIED });
    expect(await runControl(h, 'realExecSync')).toMatchObject({ ok: true, value: 'hi' });
    expect(await runControl(h, 'worker')).toMatchObject({ ok: true, value: 'started' });
    expect(await runControl(h, 'binding')).toMatchObject({ ok: true, value: 'object' });
  });

  // Purpose: the environment is built from nothing — no PATH, no
  // NODE_OPTIONS, no keys or tokens — even when the host has them.
  it('gets a scrubbed environment', async () => {
    const saved = { ...process.env };
    process.env.ANTHROPIC_API_KEY = 'sk-test-secret';
    process.env.DORKOS_AGENT_TOKEN_TEST = 'tok';
    process.env.NODE_OPTIONS = '--max-old-space-size=99';
    process.env.LC_ALL = 'en_US.UTF-8';
    try {
      const host = makeHost(h, { id: 'envy' });
      await startOk(host);
      const report = await probe(host, 'env');
      const env = report.value as Record<string, string>;
      expect(env.PATH).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.DORKOS_AGENT_TOKEN_TEST).toBeUndefined();
      expect(env.LC_ALL).toBe('en_US.UTF-8');
      const files = isolatedFilesDir(h.dorkHome, 'envy');
      expect(env.HOME).toBe(files);
      expect(env.TMPDIR).toBe(path.join(files, '.tmp'));
      expect(env.DORKOS_EXT_ID).toBe('envy');
    } finally {
      process.env = saved;
    }
  });

  // Purpose: Node follows symlinks outside granted paths, so an assets link
  // leaving assets/ must stop the start; a link that stays inside is fine.
  it('refuses to start when assets/ links outside itself', async () => {
    const extDir = path.join(h.tmp, 'ext', 'linky');
    await fs.mkdir(path.join(extDir, 'assets', 'nested'), { recursive: true });
    await fs.writeFile(path.join(extDir, 'assets', 'a.txt'), 'a');
    await fs.symlink(path.join(extDir, 'assets', 'a.txt'), path.join(extDir, 'assets', 'inside'));
    const inside = makeHost(h, { id: 'linky', extensionDir: extDir });
    await startOk(inside);
    expect(await probe(inside, 'readFile', path.join(extDir, 'assets', 'a.txt'))).toMatchObject({
      ok: true,
      value: 'a',
    });
    await inside.stop();

    await fs.symlink(h.dorkHome, path.join(extDir, 'assets', 'nested', 'escape'));
    const escaping = makeHost(h, { id: 'linky', extensionDir: extDir });
    expect(await escaping.start()).toEqual({
      ok: false,
      code: 'isolation_unavailable',
      message: "Probe couldn't start: its assets folder links outside itself.",
    });
    expect(escaping.running).toBe(false);
  });

  // Purpose: a bundle that asks for a package it did not bundle fails with
  // the exact author-facing message, at load, not later.
  it('refuses a dependency the bundle did not include', async () => {
    const bundle = path.join(h.tmp, 'bundles', 'needs-lodash.js');
    await fs.writeFile(bundle, "require('lodash');\n");
    const host = makeHost(h, { bundle });
    expect(await host.start()).toEqual({
      ok: false,
      code: 'server_start_failed',
      message: "Probe couldn't start: Isolated extensions must bundle their dependencies: lodash.",
    });
    const host2 = makeHost(h);
    await startOk(host2);
    expect(await probe(host2, 'requireOther', 'left-pad')).toMatchObject({
      ok: false,
      message: 'Isolated extensions must bundle their dependencies: left-pad',
    });
  });

  // Purpose: stop() ends a child that cannot process `stop` (a blocked event
  // loop) by killing it after the grace period, and reports it as stopped.
  it('kills a child that ignores stop', async () => {
    const exits: string[] = [];
    const host = makeHost(h, {
      onExit: (exit) => exits.push(exit.reason),
      overrides: { timings: { stopGraceMs: 500 }, testSeams: { probes: true } },
    });
    await startOk(host);
    await host.probe('hang');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    await host.stop();
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(host.running).toBe(false);
    expect(exits).toEqual(['stopped']);
  });
});
