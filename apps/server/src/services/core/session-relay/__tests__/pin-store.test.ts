/**
 * @vitest-environment node
 *
 * What a computer keeps to reach its own hub: the pin and its signing key,
 * owner-only files in the data folder.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  clearRelayPin,
  computerPublicKey,
  computerSigningKey,
  readRelayPin,
  updateRelayPin,
  writeRelayPin,
  type RelayPin,
} from '../pin-store.js';
import { pinnableKey } from '../channel.js';

let home: string;

const PIN: RelayPin = {
  v: 2,
  computerId: 'computer-1',
  hubOrigin: 'https://dorian.hub.example.test',
  hubKey: randomBytes(32).toString('base64url'),
  relaySecret: randomBytes(32).toString('base64url'),
  pinnedAt: '2026-10-16T21:00:00.000Z',
  computerName: 'Studio Mac',
  level: 'chat',
  paused: false,
};

describe('the relay pin', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-relay-pin-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('is absent until the owner pins a hub', () => {
    expect(readRelayPin(home)).toBeNull();
  });

  it('round-trips, in an owner-only file', async () => {
    await writeRelayPin(PIN, home);
    expect(readRelayPin(home)).toEqual(PIN);
    const file = path.join(home, 'session-relay', 'pin.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['http://dorian.hub.example.test'],
    ['https://dorian.hub.example.test/path'],
    ['https://dorian.hub.example.test/'],
    ['https://user@dorian.hub.example.test'],
  ])('refuses to pin %s: only a bare https origin', async (hubOrigin) => {
    await expect(writeRelayPin({ ...PIN, hubOrigin }, home)).rejects.toThrow();
  });

  it('stays off, rather than dialing, when the file does not parse', async () => {
    await writeRelayPin(PIN, home);
    // Complete in every field but one: a plain-http origin.
    fs.writeFileSync(
      path.join(home, 'session-relay', 'pin.json'),
      JSON.stringify({ ...PIN, hubOrigin: 'http://dorian.hub.example.test' })
    );
    expect(readRelayPin(home)).toBeNull();
  });

  it('reads a format-1 pin as no pin, so the owner links again', () => {
    const { computerName: _n, level: _l, paused: _p, ...v1 } = PIN;
    fs.mkdirSync(path.join(home, 'session-relay'), { recursive: true });
    fs.writeFileSync(path.join(home, 'session-relay', 'pin.json'), JSON.stringify({ ...v1, v: 1 }));
    expect(readRelayPin(home)).toBeNull();
  });

  it('starts at Chat and unpaused when a writer leaves both out', async () => {
    const { level: _l, paused: _p, ...bare } = PIN;
    await writeRelayPin(bare, home);
    expect(readRelayPin(home)).toMatchObject({ level: 'chat', paused: false });
  });

  it('keeps the hub owner’s account when the hub named one', async () => {
    const owned = { ...PIN, issuer: 'https://accounts.dorkos.test', accountId: 'acct_1' };
    await writeRelayPin(owned, home);
    expect(readRelayPin(home)).toEqual(owned);
  });

  it('changes the level and the pause in place, and nothing else', async () => {
    await writeRelayPin(PIN, home);
    expect(await updateRelayPin({ level: 'full', paused: true }, home)).toEqual({
      ...PIN,
      level: 'full',
      paused: true,
    });
    expect(readRelayPin(home)).toEqual({ ...PIN, level: 'full', paused: true });
    const file = path.join(home, 'session-relay', 'pin.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('changes nothing when there is no pin', async () => {
    expect(await updateRelayPin({ paused: true }, home)).toBeNull();
    expect(readRelayPin(home)).toBeNull();
  });

  it('is forgotten at once, with no network involved, and closes an open connection', async () => {
    await writeRelayPin(PIN, home);
    const close = vi.fn();
    clearRelayPin(home, close);
    expect(readRelayPin(home)).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('the computer key', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-relay-key-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('is made once, kept owner-only, and stays the same', () => {
    const first = computerPublicKey(home);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(computerPublicKey(home)).toBe(first);
    expect(pinnableKey(computerSigningKey(home))).toBe(first);
    const file = path.join(home, 'session-relay', 'computer-key.pem');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('survives forgetting the pin, so linking again keeps the same identity', async () => {
    const key = computerPublicKey(home);
    await writeRelayPin(PIN, home);
    clearRelayPin(home);
    expect(computerPublicKey(home)).toBe(key);
  });
});
