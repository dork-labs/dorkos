import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLinkTelemetryInstanceId } from '../link-telemetry.js';
import { INSTANCE_ID_FILENAME } from '../../../../lib/instance-id.js';

/** A throwaway dorkHome so the per-install id file is written in isolation. */
function makeDorkHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dork-link-telemetry-'));
}

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    fs.rmSync(created.pop()!, { recursive: true, force: true });
  }
});

describe('resolveLinkTelemetryInstanceId', () => {
  it('returns the per-install id when opted in and no env kill switch is set', async () => {
    const dorkHome = makeDorkHome();
    created.push(dorkHome);
    const id = await resolveLinkTelemetryInstanceId({
      linkAnalyticsToAccount: true,
      dorkHome,
      env: {},
    });
    expect(id).toBeTruthy();
    // The resolved id is the same one persisted to the install-id file.
    const onDisk = fs.readFileSync(path.join(dorkHome, INSTANCE_ID_FILENAME), 'utf8').trim();
    expect(id).toBe(onDisk);
  });

  it('returns undefined when the operator has not opted in', async () => {
    const dorkHome = makeDorkHome();
    created.push(dorkHome);
    const id = await resolveLinkTelemetryInstanceId({
      linkAnalyticsToAccount: false,
      dorkHome,
      env: {},
    });
    expect(id).toBeUndefined();
    // No opt-in means the install-id file is never even created here.
    expect(fs.existsSync(path.join(dorkHome, INSTANCE_ID_FILENAME))).toBe(false);
  });

  it('DO_NOT_TRACK suppresses the id even when opted in', async () => {
    const dorkHome = makeDorkHome();
    created.push(dorkHome);
    const id = await resolveLinkTelemetryInstanceId({
      linkAnalyticsToAccount: true,
      dorkHome,
      env: { DO_NOT_TRACK: '1' },
    });
    expect(id).toBeUndefined();
  });

  it('DORKOS_TELEMETRY_DISABLED suppresses the id even when opted in', async () => {
    const dorkHome = makeDorkHome();
    created.push(dorkHome);
    const id = await resolveLinkTelemetryInstanceId({
      linkAnalyticsToAccount: true,
      dorkHome,
      env: { DORKOS_TELEMETRY_DISABLED: 'true' },
    });
    expect(id).toBeUndefined();
  });
});
