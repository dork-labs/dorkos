/**
 * The owner-only grants file (DOR-2939 part 6): where it lives, its mode, its
 * atomic writes, what an unreadable file grants, and that nothing an agent can
 * call writes it.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  NO_SETUP_GRANTS,
  allowAgentPair,
  readSetupGrants,
  removeAgentPair,
  setDorkBotSetupGrant,
  setupGrantsPath,
} from '../setup-grants-store.js';
import { tierForCrossComputerTurn } from '../pair-allowance.js';

const SCOUT = '01KJXYKJYW4N8QGQ5W4GB6YM9J';
const ATLAS = '01KJXYKJYW4N8QGQ5W4GB6YM9K';
const NOW = () => new Date('2026-10-18T12:00:00.000Z');

let dorkHome: string;

beforeEach(() => {
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-grants-'));
});

afterEach(() => {
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

describe('the grants file', () => {
  it('lives in the data folder under hub/, never in config', () => {
    expect(setupGrantsPath(dorkHome)).toBe(path.join(dorkHome, 'hub', 'setup-grants.json'));
  });

  it('grants nothing until the owner writes it', () => {
    expect(readSetupGrants(dorkHome)).toEqual(NO_SETUP_GRANTS);
  });

  it('is written owner-only, 0600', async () => {
    await setDorkBotSetupGrant(true, { dorkHome, now: NOW });
    const mode = fs.statSync(setupGrantsPath(dorkHome)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('keeps 0600 when an existing file was looser', async () => {
    fs.mkdirSync(path.join(dorkHome, 'hub'), { recursive: true });
    fs.writeFileSync(setupGrantsPath(dorkHome), '{}', { mode: 0o644 });
    await setDorkBotSetupGrant(true, { dorkHome, now: NOW });
    expect(fs.statSync(setupGrantsPath(dorkHome)).mode & 0o777).toBe(0o600);
  });

  it('writes atomically: the old file stays whole when the new one cannot be written', async () => {
    await setDorkBotSetupGrant(true, { dorkHome, now: NOW });
    const before = fs.readFileSync(setupGrantsPath(dorkHome), 'utf8');
    const folder = path.join(dorkHome, 'hub');
    // The file stays writable, its folder does not: an in-place write would
    // still land, a temp file renamed into place cannot be made.
    fs.chmodSync(folder, 0o500);
    try {
      await expect(allowAgentPair(SCOUT, ATLAS, { dorkHome, now: NOW })).rejects.toThrow();
    } finally {
      fs.chmodSync(folder, 0o700);
    }
    expect(fs.readFileSync(setupGrantsPath(dorkHome), 'utf8')).toBe(before);
    expect(fs.readdirSync(folder)).toEqual(['setup-grants.json']);
  });

  it('never loses a change to a concurrent one', async () => {
    await Promise.all([
      setDorkBotSetupGrant(true, { dorkHome, now: NOW }),
      allowAgentPair(SCOUT, ATLAS, { dorkHome, now: NOW }),
      allowAgentPair(ATLAS, SCOUT, { dorkHome, now: NOW }),
    ]);
    const grants = readSetupGrants(dorkHome);
    expect(grants.dorkbotSetup).toBe(true);
    expect(grants.pairs).toHaveLength(2);
  });

  it('grants nothing when the file cannot be read', () => {
    fs.mkdirSync(path.join(dorkHome, 'hub'), { recursive: true });
    for (const text of ['not json', '{"v":1,"dorkbotSetup":"yes"}', '{"dorkbotSetup":true}']) {
      fs.writeFileSync(setupGrantsPath(dorkHome), text);
      expect(readSetupGrants(dorkHome), text).toEqual(NO_SETUP_GRANTS);
    }
  });

  it('dates DorkBot`s grant, and clears the date when it is taken back', async () => {
    const on = await setDorkBotSetupGrant(true, { dorkHome, now: NOW });
    expect(on).toMatchObject({ dorkbotSetup: true, dorkbotSetupGrantedAt: NOW().toISOString() });
    const off = await setDorkBotSetupGrant(false, { dorkHome });
    expect(off).toMatchObject({ dorkbotSetup: false, dorkbotSetupGrantedAt: null });
    expect(readSetupGrants(dorkHome)).toEqual(off);
  });
});

describe('pair allowances', () => {
  it('are one-way, kept once, and taken back', async () => {
    await allowAgentPair(SCOUT, ATLAS, { dorkHome, now: NOW });
    await allowAgentPair(SCOUT, ATLAS, { dorkHome, now: () => new Date('2027-01-01') });
    const grants = readSetupGrants(dorkHome);
    expect(grants.pairs).toEqual([{ from: SCOUT, to: ATLAS, grantedAt: NOW().toISOString() }]);
    expect(tierForCrossComputerTurn(SCOUT, ATLAS, grants)).toBe('owner');
    expect(tierForCrossComputerTurn(ATLAS, SCOUT, grants)).toBe('teammate');
    const removed = await removeAgentPair(SCOUT, ATLAS, { dorkHome });
    expect(tierForCrossComputerTurn(SCOUT, ATLAS, removed)).toBe('teammate');
  });

  it('runs a cross-computer turn at the teammate tier when nothing is allowed', () => {
    expect(tierForCrossComputerTurn(SCOUT, ATLAS, NO_SETUP_GRANTS)).toBe('teammate');
  });

  it('refuses an agent paired with itself, or an id that is not an agent id', async () => {
    await expect(allowAgentPair(SCOUT, SCOUT, { dorkHome })).rejects.toThrow();
    await expect(allowAgentPair('../etc', ATLAS, { dorkHome })).rejects.toThrow();
    expect(readSetupGrants(dorkHome)).toEqual(NO_SETUP_GRANTS);
  });
});

describe('who can write it', () => {
  const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

  /** Every non-test source file under `apps/server/src` that names the store or the barrel. */
  function importers(): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
        } else if (/\.tsx?$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          const store =
            /from '[^']*(setup-grants-store|core\/tool-bridge|tool-bridge\/index)(\.js)?'/;
          if (store.test(text)) {
            found.push(path.relative(serverSrc, full));
          }
        }
      }
    };
    walk(serverSrc);
    return found.sort();
  }

  it('is reached only by the owner`s routes and the bridge itself', () => {
    expect(importers()).toEqual(
      [
        'routes/hub-agent-grants.ts',
        'services/core/tool-bridge/agent-grants-openapi.ts',
        'services/core/tool-bridge/index.ts',
        'services/core/tool-bridge/pair-allowance.ts',
      ].sort()
    );
  });
});
