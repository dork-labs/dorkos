import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAdapterConfig } from '../adapter-config.js';

/**
 * The write → disk → read seam for `adapters.json`, crossed with a real file.
 *
 * DOR-604 turned on a carry-forward that reads "no `dmPolicy` key" as "written
 * before the field existed, keep it on `'open'`". That premise is only true if
 * every writer records the field, and `addAdapter` did not — it cast the
 * caller's raw request body and pushed it unparsed, so a brand-new integration
 * landed on `'open'` on its next restart. `adapter-manager.test.ts` covers the
 * write half (the payload now carries `dmPolicy`); this covers the read half for
 * both populations, which is the seam no test crossed.
 */
async function loadFixture(adapters: unknown[]): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(join(tmpdir(), 'dorkos-adapters-'));
  const path = join(dir, 'adapters.json');
  await writeFile(path, JSON.stringify({ adapters }, null, 2), 'utf-8');
  const loaded = await loadAdapterConfig(path);
  return loaded[0].config as Record<string, unknown>;
}

const SECRETS = { botToken: 'xoxb-1', appToken: 'xapp-1', signingSecret: 'sec' };

describe('adapters.json write -> disk -> load (DOR-604)', () => {
  it('a Slack integration written by this build stays on its allowlist', async () => {
    // Exactly what `AdapterManager.parseForPersist` now puts on disk: the schema
    // default materialized at write time.
    const config = await loadFixture([
      {
        id: 'slack',
        type: 'slack',
        enabled: true,
        builtin: false,
        config: { ...SECRETS, dmPolicy: 'allowlist', dmAllowlist: [] },
      },
    ]);

    expect(config.dmPolicy).toBe('allowlist');
  });

  it('a Slack integration written before this build keeps answering DMs', async () => {
    // What an older build left on disk: no `dmPolicy` key at all. Carrying it
    // forward at 'open' is what stops a live integration going silent on upgrade.
    const config = await loadFixture([
      { id: 'slack', type: 'slack', enabled: true, builtin: false, config: SECRETS },
    ]);

    expect(config.dmPolicy).toBe('open');
  });

  it('an explicit choice survives the round trip either way', async () => {
    const opened = await loadFixture([
      {
        id: 'slack',
        type: 'slack',
        enabled: true,
        builtin: false,
        config: { ...SECRETS, dmPolicy: 'open' },
      },
    ]);
    expect(opened.dmPolicy).toBe('open');

    const listed = await loadFixture([
      {
        id: 'slack',
        type: 'slack',
        enabled: true,
        builtin: false,
        config: { ...SECRETS, dmPolicy: 'allowlist', dmAllowlist: ['U1'] },
      },
    ]);
    expect(listed.dmPolicy).toBe('allowlist');
    expect(listed.dmAllowlist).toEqual(['U1']);
  });
});
