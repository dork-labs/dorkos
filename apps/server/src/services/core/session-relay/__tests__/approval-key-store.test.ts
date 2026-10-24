/**
 * @vitest-environment node
 *
 * The approvals passkeys a computer pins: an owner-only file, one relying
 * party, an audit entry for every key added or removed (never its key
 * material), a counter that only goes up, and "no keys" for any file that
 * cannot be read.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../../../lib/logger.js';
import type { RecordAuditInput } from '../../../audit/audit-trail.js';
import {
  ApprovalKeyStoreError,
  KEYS_READ_ERROR,
  UNREADABLE_KEYS_REFUSAL,
  addApprovalKey,
  approvalKeysPath,
  approvalKeysUnreadable,
  bumpSignCount,
  readApprovalKeys,
  removeApprovalKey,
  removeDamagedApprovalKeys,
  type ApprovalKey,
} from '../approval-key-store.js';
import { clearRelayPin, writeRelayPin } from '../pin-store.js';

const PARTY = {
  rpId: 'approve.dorkos.ai',
  origin: 'https://approve.dorkos.ai',
  userHandle: 'b3duZXI',
};

function key(over: Partial<ApprovalKey> = {}): ApprovalKey {
  return {
    credentialId: randomBytes(16).toString('base64url'),
    cosePublicKey: randomBytes(77).toString('base64url'),
    alg: -7,
    signCount: 0,
    label: 'MacBook Touch ID',
    addedAt: '2026-10-19T10:00:00.000Z',
    ...over,
  };
}

let home: string;
let audits: RecordAuditInput[];
const audit = () => ({
  owner: () => ({ accountId: 'acct-owner', kind: 'person' as const, name: 'Dorian' }),
  recordAudit: (input: RecordAuditInput) => {
    audits.push(input);
  },
});

describe('the approval key store', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-approval-keys-'));
    audits = [];
    vi.mocked(logger.warn).mockClear();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('has no keys until one is added', () => {
    expect(readApprovalKeys(home)).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('pins keys in an owner-only file, and audits each without its key material', async () => {
    const first = key();
    await addApprovalKey(PARTY, first, audit(), home);
    const second = key({ label: 'Phone', alg: -8 });
    await addApprovalKey(PARTY, second, audit(), home);
    expect(readApprovalKeys(home)).toEqual({ v: 1, ...PARTY, keys: [first, second] });
    expect(fs.statSync(approvalKeysPath(home)).mode & 0o777).toBe(0o600);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      action: 'relay.passkey.added',
      operation: 'create',
      outcome: 'ok',
      target: { type: 'passkey', id: first.credentialId },
      change: [{ field: 'label', after: 'MacBook Touch ID' }],
      source: { surface: 'relay' },
    });
    expect(JSON.stringify(audits)).not.toContain(first.cosePublicKey);
  });

  it('refuses a key twice, a key for another relying party, and a seventeenth key', async () => {
    const first = key();
    await addApprovalKey(PARTY, first, audit(), home);
    await expect(addApprovalKey(PARTY, first, audit(), home)).rejects.toThrow(
      ApprovalKeyStoreError
    );
    await expect(
      addApprovalKey(
        { ...PARTY, rpId: 'hub.example.test', origin: 'https://hub.example.test' },
        key(),
        audit(),
        home
      )
    ).rejects.toThrow('That passkey is for a different approve page.');
    for (let n = 2; n <= 16; n += 1) await addApprovalKey(PARTY, key(), audit(), home);
    await expect(addApprovalKey(PARTY, key(), audit(), home)).rejects.toThrow(
      'Remove a passkey before adding another.'
    );
    expect(readApprovalKeys(home)?.keys).toHaveLength(16);
  });

  it('removes a key with an audit entry, and the file with the last one', async () => {
    const first = key();
    const second = key({ label: 'Phone' });
    await addApprovalKey(PARTY, first, audit(), home);
    await addApprovalKey(PARTY, second, audit(), home);
    expect(await removeApprovalKey(first.credentialId, audit(), home)).toBe(true);
    expect(readApprovalKeys(home)?.keys).toEqual([second]);
    expect(audits.at(-1)).toMatchObject({
      action: 'relay.passkey.removed',
      operation: 'remove',
      target: { type: 'passkey', id: first.credentialId },
      change: [{ field: 'label', before: 'MacBook Touch ID' }],
    });
    expect(await removeApprovalKey('nope', audit(), home)).toBe(false);
    expect(await removeApprovalKey(second.credentialId, audit(), home)).toBe(true);
    expect(fs.existsSync(approvalKeysPath(home))).toBe(false);
    expect(readApprovalKeys(home)).toBeNull();
  });

  it('records a counter only as a compare-and-set against the checked one', async () => {
    const pinned = key();
    await addApprovalKey(PARTY, pinned, audit(), home);
    expect(await bumpSignCount(pinned.credentialId, 0, 7, home)).toBe(true);
    expect(readApprovalKeys(home)?.keys[0]?.signCount).toBe(7);
    // Checked against a stale counter, or going backwards: refused, nothing written.
    expect(await bumpSignCount(pinned.credentialId, 0, 9, home)).toBe(false);
    expect(await bumpSignCount(pinned.credentialId, 7, 7, home)).toBe(false);
    expect(await bumpSignCount(pinned.credentialId, 7, 0, home)).toBe(false);
    expect(readApprovalKeys(home)?.keys[0]?.signCount).toBe(7);
    // Two proofs checked against the same counter: one wins.
    const raced = await Promise.all(
      [8, 12].map((n) => bumpSignCount(pinned.credentialId, 7, n, home))
    );
    expect(raced.filter(Boolean)).toHaveLength(1);
    // A key that is gone never succeeds.
    expect(await bumpSignCount('gone', 0, 1, home)).toBe(false);
  });

  it('lets a passkey that keeps no counter through without writing', async () => {
    const pinned = key();
    await addApprovalKey(PARTY, pinned, audit(), home);
    expect(await bumpSignCount(pinned.credentialId, 0, 0, home)).toBe(true);
    expect(readApprovalKeys(home)?.keys[0]?.signCount).toBe(0);
  });

  it.each([
    ['not JSON', '{"v":1,'],
    ['the wrong shape', JSON.stringify({ v: 1, keys: [] })],
    [
      'an origin off its relying party',
      JSON.stringify({ v: 1, ...PARTY, origin: 'https://evil.example.test', keys: [key()] }),
    ],
  ])('reads a file that is %s as no keys, with a warning, and leaves it be', async (_, text) => {
    fs.mkdirSync(path.dirname(approvalKeysPath(home)), { recursive: true });
    fs.writeFileSync(approvalKeysPath(home), text);
    expect(readApprovalKeys(home)).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
    expect(await bumpSignCount('anything', 0, 5, home)).toBe(false);
    await removeApprovalKey('anything', audit(), home);
    expect(fs.readFileSync(approvalKeysPath(home), 'utf8')).toBe(text);
  });

  it('refuses to add a key over a file it cannot read, and leaves the file be', async () => {
    fs.mkdirSync(path.dirname(approvalKeysPath(home)), { recursive: true });
    fs.writeFileSync(approvalKeysPath(home), '{"v":1,');
    expect(approvalKeysUnreadable(home)).toBe(true);
    await expect(addApprovalKey(PARTY, key(), audit(), home)).rejects.toThrow(
      UNREADABLE_KEYS_REFUSAL
    );
    expect(fs.readFileSync(approvalKeysPath(home), 'utf8')).toBe('{"v":1,');
    expect(audits).toEqual([]);
    fs.rmSync(approvalKeysPath(home));
    expect(approvalKeysUnreadable(home)).toBe(false);
    await addApprovalKey(PARTY, key(), audit(), home);
    expect(readApprovalKeys(home)?.keys).toHaveLength(1);
  });

  it('refuses a key that signs with an algorithm outside ES256, EdDSA and RS256', async () => {
    await expect(
      addApprovalKey(PARTY, key({ alg: -65535 as ApprovalKey['alg'] }), audit(), home)
    ).rejects.toThrow();
    expect(readApprovalKeys(home)).toBeNull();
  });

  it('goes when the pin goes', async () => {
    await writeRelayPin(
      {
        v: 2,
        computerId: 'computer-1',
        hubOrigin: 'https://dorian.hub.example.test',
        hubKey: randomBytes(32).toString('base64url'),
        relaySecret: randomBytes(32).toString('base64url'),
        pinnedAt: '2026-10-16T21:00:00.000Z',
        computerName: 'Studio Mac',
      },
      home
    );
    await addApprovalKey(PARTY, key(), audit(), home);
    clearRelayPin(home);
    expect(fs.existsSync(approvalKeysPath(home))).toBe(false);
    expect(readApprovalKeys(home)).toBeNull();
  });
});

describe('a keys file that cannot be read just now', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-approval-keys-err-'));
    fs.mkdirSync(path.dirname(approvalKeysPath(home)), { recursive: true });
    fs.writeFileSync(approvalKeysPath(home), '{"v":1,');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('is an error, not damaged: nothing removes or replaces it', async () => {
    const realRead = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (file === approvalKeysPath(home)) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return (realRead as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    const sink = {
      owner: () => ({ accountId: 'a', kind: 'person' as const, name: 'A' }),
      recordAudit: vi.fn(),
    };
    expect(approvalKeysUnreadable(home)).toBe(false);
    expect(readApprovalKeys(home)).toBeNull();
    expect(await removeDamagedApprovalKeys(sink, home)).toBe('read-error');
    await expect(addApprovalKey(PARTY, key(), sink, home)).rejects.toThrow(KEYS_READ_ERROR);
    vi.restoreAllMocks();
    expect(fs.readFileSync(approvalKeysPath(home), 'utf8')).toBe('{"v":1,');
    expect(sink.recordAudit).not.toHaveBeenCalled();
    // Readable again, it is damaged, and only then removable.
    expect(await removeDamagedApprovalKeys(sink, home)).toBe('removed');
  });
});
