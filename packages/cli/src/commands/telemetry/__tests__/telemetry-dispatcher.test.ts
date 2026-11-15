/**
 * DOR-4414: `dorkos telemetry enable errors`, typed without `--channel`, turned
 * every channel on. Through the real dispatcher and config manager, in a
 * throwaway data directory: a bare channel word changes nothing and prints the
 * flag to use, and `--channel errors` still turns on crash reports alone.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initConfigManager } from '../../../../server/services/core/config-manager.js';
import { runTelemetryDispatcher } from '../telemetry.js';

let dorkHome: string;
const errors: string[] = [];

beforeAll(() => {
  vi.stubEnv('DORKOS_TEST_RUNTIME', 'true');
  vi.stubEnv('DO_NOT_TRACK', '');
  vi.stubEnv('DORKOS_TELEMETRY_DISABLED', '');
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dor4414-dork-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
    errors.push(String(message));
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

/** The four channel flags and the decision gate, as the config file holds them. */
function flags() {
  const store = initConfigManager(dorkHome) as unknown as { getDot: (key: string) => unknown };
  return {
    install: store.getDot('telemetry.install'),
    heartbeat: store.getDot('telemetry.heartbeat'),
    usage: store.getDot('telemetry.usage'),
    errorReporting: store.getDot('telemetry.errorReporting'),
    userHasDecided: store.getDot('telemetry.userHasDecided'),
  };
}

describe('dorkos telemetry enable/disable (DOR-4414)', () => {
  it('refuses a bare channel word, changes nothing, and names the flag', async () => {
    const before = flags();
    expect(await runTelemetryDispatcher(dorkHome, 'enable', ['errors'])).toBe(1);
    expect(flags()).toEqual(before);
    expect(errors.join('\n')).toContain('Did you mean `--channel errors`?');
  });

  it('refuses a bare channel word on disable too', async () => {
    const before = flags();
    expect(await runTelemetryDispatcher(dorkHome, 'disable', ['heartbeat'])).toBe(1);
    expect(flags()).toEqual(before);
  });

  it('refuses --channel with no name, and changes nothing', async () => {
    const before = flags();
    expect(await runTelemetryDispatcher(dorkHome, 'enable', ['--channel'])).toBe(1);
    expect(flags()).toEqual(before);
  });

  it('turns on crash reports alone with --channel errors', async () => {
    expect(await runTelemetryDispatcher(dorkHome, 'disable', [])).toBe(0);
    expect(await runTelemetryDispatcher(dorkHome, 'enable', ['--channel', 'errors'])).toBe(0);
    expect(flags()).toEqual({
      install: false,
      heartbeat: false,
      usage: false,
      errorReporting: true,
      userHasDecided: true,
    });
  });
});
