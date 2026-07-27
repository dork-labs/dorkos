import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadAdapterConfig,
  saveAdapterConfig,
  parseAdapterConfigForPersist,
} from '../adapter-config.js';
import { AdapterError } from '../adapter-error.js';

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

/**
 * The full write path: validate as `addAdapter`/`updateConfig` now do, persist,
 * then load it back the way the server does at boot.
 */
async function persistAndLoad(config: Record<string, unknown>, type = 'slack') {
  const parsed = parseAdapterConfigForPersist({
    id: 'slack',
    type,
    enabled: true,
    builtin: false,
    config,
  });
  const persistedKey = 'dmPolicy' in (parsed.config as Record<string, unknown>);

  const dir = await mkdtemp(join(tmpdir(), 'dorkos-persist-'));
  const path = join(dir, 'adapters.json');
  await saveAdapterConfig(path, [parsed]);
  const loaded = await loadAdapterConfig(path);
  const effective = loaded[0].config as Record<string, unknown>;
  return { persistedKey, effective };
}

/**
 * Every shape a real caller sends, driven all the way to disk and back.
 *
 * `AdapterConfigSchema.config` ends in `z.record(z.string(), z.unknown())`, a
 * catch-all that accepts any object and materializes nothing. While validation
 * went through that union, a config that failed the Slack arm did not fail — it
 * fell through and persisted verbatim, so its defaults never existed and the
 * carry-forward read it as legacy and stamped `'open'`. Rows 2 and 3 below are
 * **working** configs that took that branch; row 3 is the setup wizard's own
 * payload.
 */
describe('every write shape lands on a closed dmPolicy (DOR-604 review)', () => {
  it('a valid config that names no dmPolicy', async () => {
    const { persistedKey, effective } = await persistAndLoad({ ...SECRETS });
    expect({ persistedKey, dmPolicy: effective.dmPolicy }).toEqual({
      persistedKey: true,
      dmPolicy: 'allowlist',
    });
  });

  it('a textarea dmAllowlist, which is what the client actually sends', async () => {
    const { persistedKey, effective } = await persistAndLoad({
      ...SECRETS,
      dmAllowlist: 'U01ABC\nU02DEF',
    });
    expect({ persistedKey, dmPolicy: effective.dmPolicy }).toEqual({
      persistedKey: true,
      dmPolicy: 'allowlist',
    });
    // And the newline shape is normalized, not just tolerated.
    expect(effective.dmAllowlist).toEqual(['U01ABC', 'U02DEF']);
  });

  it("the setup wizard's own payload, with every untouched field blank", async () => {
    const { persistedKey, effective } = await persistAndLoad({
      ...SECRETS,
      streaming: false,
      nativeStreaming: false,
      typingIndicator: '',
      respondMode: '',
      dmAllowlist: '',
      approverAllowlist: '',
      channelOverrides: '',
    });
    expect({ persistedKey, dmPolicy: effective.dmPolicy }).toEqual({
      persistedKey: true,
      dmPolicy: 'allowlist',
    });
    // The blanks resolve to their real defaults rather than persisting as ''.
    expect(effective.typingIndicator).toBe('reaction');
    expect(effective.respondMode).toBe('thread-aware');
    expect(effective.channelOverrides).toEqual({});
  });

  /**
   * The worst of the four: `''` is not nullish, so `?? 'allowlist'` missed it;
   * it is not `'allowlist'`, so the DM gate never engaged; and it is not
   * `'open'`, so the warning never fired. Effectively open and unwarned.
   */
  it('an empty-string dmPolicy from a client with no manifest default', async () => {
    const { effective } = await persistAndLoad({ ...SECRETS, dmPolicy: '' });
    expect(effective.dmPolicy).toBe('allowlist');
  });

  // On the way in, a value that is neither option is a broken request, so it is
  // refused outright — nothing reaches disk, which is closed by definition.
  it('an unrecognized dmPolicy is refused rather than persisted', () => {
    expect(() =>
      parseAdapterConfigForPersist({
        id: 'slack',
        type: 'slack',
        enabled: true,
        builtin: false,
        config: { ...SECRETS, dmPolicy: 'opne' },
      })
    ).toThrow(AdapterError);
  });

  // On the way out, refusing would take a working install down, so an
  // unreadable stored value is closed instead. `''` is the real-world case:
  // it satisfied neither the DM gate nor the warning, so it was open and silent.
  it.each([[''], ['opne'], [null]])(
    'a stored dmPolicy of %o loads as allowlist',
    async (stored) => {
      const config = await loadFixture([
        {
          id: 'slack',
          type: 'slack',
          enabled: true,
          builtin: false,
          config: { ...SECRETS, dmPolicy: stored },
        },
      ]);
      expect(config.dmPolicy).toBe('allowlist');
    }
  );

  it('keeps an explicit open, which is the one value that opens it', async () => {
    const { effective } = await persistAndLoad({ ...SECRETS, dmPolicy: 'open' });
    expect(effective.dmPolicy).toBe('open');
  });
});

describe('parseAdapterConfigForPersist validates by type, never by union order', () => {
  /**
   * The union tried Telegram first, so a Slack config carrying a `token` key
   * matched it and had its bot/app/signing secrets stripped on the way to disk.
   * Selecting the schema by `type` removes that branch.
   */
  it('does not let a Telegram-shaped key strip a Slack config of its secrets', async () => {
    const { effective } = await persistAndLoad({ ...SECRETS, token: 'not-a-telegram-adapter' });
    expect(effective.botToken).toBe('xoxb-1');
    expect(effective.appToken).toBe('xapp-1');
    expect(effective.signingSecret).toBe('sec');
  });

  it('refuses a genuinely broken config instead of swallowing it', () => {
    expect(() =>
      parseAdapterConfigForPersist({
        id: 'slack',
        type: 'slack',
        enabled: true,
        builtin: false,
        config: { appToken: 'xapp-1' }, // no botToken, no signingSecret
      })
    ).toThrow(AdapterError);
  });

  it('leaves a plugin config alone, since its shape is the plugin’s business', () => {
    const parsed = parseAdapterConfigForPersist({
      id: 'my-plugin',
      type: 'plugin',
      enabled: true,
      builtin: false,
      plugin: { package: 'some-pkg' },
      config: { anything: { nested: true } },
    });
    expect(parsed.config).toEqual({ anything: { nested: true } });
  });
});

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
