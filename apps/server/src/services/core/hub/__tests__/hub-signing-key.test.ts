/**
 * A hub's own Ed25519 signing key (`hub-signing-key.ts`): made once, kept on
 * disk for this user only, never replaced, and used for relay transcripts and
 * nothing else.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPublicKey, verify } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const role = vi.hoisted(() => ({ value: 'hub' as 'computer' | 'hub' }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));

const key = await import('../hub-signing-key.js');
const serving = await import('../hub-serving.js');

/** A serving state, as after a confirmed assignment. */
const SERVING = {
  state: 'serving',
  assignment: {
    state: 'assigned',
    assignmentId: 'asg_1',
    assignedAt: '2026-11-03T09:00:00Z',
    ownerAccountId: 'acct_1',
    issuer: 'https://accounts.example.invalid',
    address: 'https://hub.example.invalid',
    frontDoorProof: { header: 'x-example-proof', secret: 's'.repeat(40) },
  },
} as const;

/** A relay transcript, as `@dorkos/shared` builds one. */
const TRANSCRIPT = new TextEncoder().encode(
  [
    'dorkos-session-relay/v1',
    'welcome',
    'https://hub.example.invalid',
    '{"hello":1}',
    '1',
    'k',
  ].join('\n')
);

let home: string;

beforeEach(() => {
  role.value = 'hub';
  key.resetHubSigningKeyForTests();
  serving.resetHubServingStateForTests();
  serving.setHubServingState(SERVING);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-hub-key-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** Verify a signature against a base64url raw public key. */
function verifies(publicKey: string, data: Uint8Array, signature: Buffer): boolean {
  const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
  return verify(null, data, pub, signature);
}

describe('the hub signing key', () => {
  it('does not exist until the hub first confirms', () => {
    expect(key.loadHubSigningKey(home)).toBe(false);
    expect(() => key.hubSigningPublicKey()).toThrow(/no signing key yet/);
    expect(() => key.signWithHubKey(TRANSCRIPT)).toThrow(/no signing key yet/);
  });

  it('is made once, as raw 32-byte base64url, and kept for this user only', () => {
    const publicKey = key.ensureHubSigningKey(home)!;
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key.hubSigningPublicKey()).toBe(publicKey);
    const file = path.join(home, key.HUB_SIGNING_KEY_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(home)).toEqual([key.HUB_SIGNING_KEY_FILE]);
    // A restart reads the same key back; it is never replaced.
    key.resetHubSigningKeyForTests();
    expect(key.loadHubSigningKey(home)).toBe(true);
    expect(key.ensureHubSigningKey(home)).toBe(publicKey);
  });

  it('signs a relay transcript, and the signature checks against the public half', () => {
    const publicKey = key.ensureHubSigningKey(home)!;
    const signature = key.signWithHubKey(TRANSCRIPT);
    expect(signature).toHaveLength(64);
    expect(verifies(publicKey, TRANSCRIPT, signature)).toBe(true);
  });

  it('signs nothing that is not a relay transcript', () => {
    key.ensureHubSigningKey(home);
    for (const text of [
      'hello',
      'dorkos-session-relay/v1',
      'dorkos-session-relay/v2\nwelcome',
      'x\ndorkos-session-relay/v1\n',
    ]) {
      expect(() => key.signWithHubKey(new TextEncoder().encode(text)), text).toThrow(
        /relay transcripts only/
      );
    }
  });

  it('is never there on a person`s own computer', () => {
    key.ensureHubSigningKey(home);
    role.value = 'computer';
    expect(() => key.hubSigningPublicKey()).toThrow(/Only a hub/);
    expect(() => key.signWithHubKey(TRANSCRIPT)).toThrow(/Only a hub/);
  });

  it('never makes a key when it may not, and leaves no stray partial file', () => {
    expect(key.ensureHubSigningKey(home, false)).toBeNull();
    expect(fs.readdirSync(home)).toEqual([]);
    fs.writeFileSync(path.join(home, `${key.HUB_SIGNING_KEY_FILE}.999.tmp`), 'half a key');
    key.ensureHubSigningKey(home);
    expect(fs.readdirSync(home)).toEqual([key.HUB_SIGNING_KEY_FILE]);
  });

  it('signs nothing once the hub stops serving', () => {
    key.ensureHubSigningKey(home);
    serving.setHubServingState({ state: 'ended' });
    expect(() => key.signWithHubKey(TRANSCRIPT)).toThrow(/does not serve/);
    expect(() => key.hubSigningPublicKey()).toThrow(/does not serve/);
  });

  it('refuses a key file that does not hold an Ed25519 key', () => {
    fs.writeFileSync(path.join(home, key.HUB_SIGNING_KEY_FILE), 'not a key');
    expect(() => key.loadHubSigningKey(home)).toThrow();
  });
});
