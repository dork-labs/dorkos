/**
 * `node:sqlite` in an isolated extension's child (DOR-3547, Security M3 and
 * Q4). The module ignores `--permission`, so without a guard a child could
 * open DorkOS's own database and write itself a row. The child runs with
 * `--no-experimental-sqlite`, the injected `require` refuses it by name, and
 * the self-check fails closed if the module loads anyway.
 *
 * Every refusal is paired with the same probe succeeding in an unrestricted
 * control process, and the database the child attacks is first written by the
 * control, so none of these can pass by not running.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { SQLITE_REFUSAL } from '../child/load-bundle.js';
import {
  cleanup,
  createHarness,
  makeHost,
  probe,
  runControl,
  startOk,
  type Harness,
} from './isolation-harness.js';

describe('node:sqlite in an isolated child', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await cleanup(h);
  });

  // Purpose: the child starts with the flag, and says which Node proved it
  // (Q4 asks for the proof on the Node CI runs).
  it('starts the child with --no-experimental-sqlite', async () => {
    const host = makeHost(h);
    await startOk(host);
    const flags = await probe(host, 'argvFlags');
    expect(flags.value).toEqual(
      expect.arrayContaining(['--permission', '--no-experimental-sqlite'])
    );
    const versions = await probe(host, 'versions');
    console.info(
      `[sqlite-guard] child ran on Node ${String((versions.value as { node: string }).node)}`
    );
  });

  // Purpose: every route to the module fails in the child and works in the
  // control: require by both names, require around the injected one,
  // import(), getBuiltinModule and the internal binding.
  it('refuses every way of loading node:sqlite', async () => {
    const host = makeHost(h);
    await startOk(host);

    for (const name of ['node:sqlite', 'sqlite']) {
      expect(await probe(host, 'sqliteRequire', name)).toMatchObject({
        ok: false,
        code: 'ERR_EXTENSION_BUILTIN_REFUSED',
        message: SQLITE_REFUSAL,
      });
    }
    expect(await runControl(h, 'sqliteRequire', 'node:sqlite')).toEqual({
      ok: true,
      value: 'function',
    });

    expect(await probe(host, 'sqliteMainModule')).toMatchObject({
      ok: false,
      code: 'ERR_UNKNOWN_BUILTIN_MODULE',
    });
    expect(await runControl(h, 'sqliteMainModule')).toEqual({ ok: true, value: 'function' });

    expect(await probe(host, 'sqliteImport')).toMatchObject({ ok: false });
    expect(await runControl(h, 'sqliteImport')).toEqual({ ok: true, value: 'function' });

    expect(await probe(host, 'sqliteGetBuiltin')).toMatchObject({
      ok: false,
      code: 'ERR_UNKNOWN_BUILTIN_MODULE',
    });
    expect(await runControl(h, 'sqliteGetBuiltin')).toEqual({ ok: true, value: 'function' });

    // The internal binding is closed by the permission model itself (M3).
    expect(await probe(host, 'sqliteBinding')).toMatchObject({
      ok: false,
      code: 'ERR_ACCESS_DENIED',
    });
    // This route has no positive control, and this says why: even unrestricted
    // Node has no `sqlite` binding (checked on 22.23, 24.14 and Electron's
    // 24.19). If a future Node adds one, this fails and the refusal above needs
    // a real control.
    expect(await runControl(h, 'sqliteBinding')).toMatchObject({
      ok: false,
      message: 'No such module: sqlite',
    });
  });

  // Purpose: the attack itself. The control writes one row into a dork.db in
  // the data directory (proof the file is writable when nothing stops it);
  // the child's forged row never lands.
  it("can't open or write DorkOS's database", async () => {
    const db = path.join(h.dorkHome, 'dork.db');
    expect(await runControl(h, 'sqliteWrite', db)).toEqual({ ok: true, value: 1 });

    const host = makeHost(h);
    await startOk(host);
    expect(await probe(host, 'sqliteWrite', db)).toMatchObject({
      ok: false,
      code: 'ERR_UNKNOWN_BUILTIN_MODULE',
    });

    // Still one row: the control's second write is the second row.
    expect(await runControl(h, 'sqliteWrite', db)).toEqual({ ok: true, value: 2 });
  });

  // Purpose: fail closed. A child started without the flag reports that
  // node:sqlite loads, and the host refuses to run it rather than trusting
  // the require guard alone.
  it('refuses to run a child where node:sqlite loads', async () => {
    const host = makeHost(h, {
      overrides: { testSeams: { probes: true, omitSqliteOff: true } },
    });
    expect(await host.start()).toEqual({
      ok: false,
      code: 'isolation_unavailable',
      message: "Probe couldn't start with its limits on this computer, so DorkOS left it off.",
    });
    expect(host.running).toBe(false);
    expect(h.logs.some((l) => l.message.includes('self-check failed'))).toBe(true);
  });
});
