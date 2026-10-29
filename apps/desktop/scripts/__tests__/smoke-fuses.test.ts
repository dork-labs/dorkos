import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FuseV1Options } from '@electron/fuses';

import { EXPECTED_EFFECTS, PACKAGED_FUSES, readEffects, wrongFuses } from '../smoke-fuses';

/**
 * The packaged fuse check, tested where it can be (DOR-3053 PR 1).
 *
 * Reading a packaged app's fuses and launching it need a packaged `.app`, so
 * they belong to `desktop-smoke.yml`. What can be pinned here: the check and
 * `electron-builder.yml` name the same fuses, the wire reader names a wrong
 * fuse, and the probe readers tell "it ran" from "it didn't".
 */

const CONFIG = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'electron-builder.yml'
);

/** The `electronFuses:` block of electron-builder.yml, as key to boolean. */
function configuredFuses(): Record<string, boolean> {
  const lines = readFileSync(CONFIG, 'utf-8').split('\n');
  const start = lines.indexOf('electronFuses:');
  expect(start, 'electron-builder.yml has no electronFuses block').toBeGreaterThan(-1);
  const fuses: Record<string, boolean> = {};
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^ {2}(\w+): (true|false)$/);
    if (!match) break;
    fuses[match[1]] = match[2] === 'true';
  }
  return fuses;
}

/** A wire with every packaged fuse as the app sets it. */
function packagedWire(): Record<number, number> {
  return {
    [FuseV1Options.RunAsNode]: 0x31,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: 0x30,
    [FuseV1Options.EnableNodeCliInspectArguments]: 0x30,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: 0x31,
    [FuseV1Options.OnlyLoadAppFromAsar]: 0x31,
  };
}

describe('the packaged fuse check', () => {
  // Purpose: the check reads back exactly what the build sets, so neither can
  // change alone.
  it('expects the fuses electron-builder.yml sets', () => {
    const { resetAdHocDarwinSignature, ...fuses } = configuredFuses();
    expect(resetAdHocDarwinSignature).toBe(true);
    expect(fuses).toEqual(PACKAGED_FUSES);
  });

  // Purpose: run-as-node stays on as a named residual until DOR-3358, and the
  // other two ways in stay shut.
  it('expects run-as-node to run and NODE_OPTIONS and --inspect to do nothing', () => {
    expect(EXPECTED_EFFECTS).toEqual({ runAsNode: true, nodeOptions: false, inspect: false });
  });

  it('passes a wire that matches and names each fuse that does not', () => {
    expect(wrongFuses(packagedWire())).toEqual([]);
    const wire = packagedWire();
    wire[FuseV1Options.EnableNodeCliInspectArguments] = 0x31;
    delete wire[FuseV1Options.OnlyLoadAppFromAsar];
    expect(wrongFuses(wire)).toEqual([
      'enableNodeCliInspectArguments: expected off, got on',
      'onlyLoadAppFromAsar: expected on, got undefined',
    ]);
  });

  it('reads each probe as having worked only when its marker is there', () => {
    expect(
      readEffects({
        runAsNode: 'dorkos-fuse-probe-ran',
        nodeOptions: 'dorkos-fuse-probe-preloadeddorkos-fuse-probe-ran',
        inspect: 'Debugger listening on ws://127.0.0.1:9229/abc\nFor help, see: https://nodejs.org',
      })
    ).toEqual({ runAsNode: true, nodeOptions: true, inspect: true });
    expect(
      readEffects({
        runAsNode: '',
        nodeOptions: 'dorkos-fuse-probe-ran',
        inspect: 'DorkOS refused a debugging switch: --inspect',
      })
    ).toEqual({ runAsNode: false, nodeOptions: false, inspect: false });
  });
});
