import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CommunityConfig } from './config.js';

const purpose = 'community-invite-v1';

function canonical(parts: string[]): Buffer {
  return Buffer.from(parts.map((part) => `${Buffer.byteLength(part)}:${part}`).join(''), 'utf8');
}

function key(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), purpose, 32));
}

function mac(parts: string[], secret: string): Buffer {
  return createHmac('sha256', key(secret)).update(canonical(parts)).digest();
}

/** Issue a purpose- and community-bound, row-backed invite token. */
export function issueInvite(
  id: string,
  communityId: string,
  expiry: Date,
  config: CommunityConfig
) {
  const nonce = randomBytes(24).toString('base64url');
  const fields = ['1', config.inviteKeyId, id, String(expiry.getTime()), nonce];
  const signature = mac([purpose, communityId, ...fields], config.inviteSecret).toString(
    'base64url'
  );
  return [...fields, signature].join('.');
}

/** Verify the signature without trusting its embedded ID, expiry or key selector. */
export function inspectInvite(token: string, communityId: string, config: CommunityConfig) {
  if (token.length > 512) return null;
  const fields = token.split('.');
  if (fields.length !== 6 || fields[0] !== '1') return null;
  const [version, keyId, id, expiryText, nonce, signature] = fields;
  if (
    !/^[-\w]{1,32}$/.test(keyId) ||
    !/^[0-9a-f-]{36}$/.test(id) ||
    !/^\d{13}$/.test(expiryText) ||
    !/^[A-Za-z0-9_-]{32}$/.test(nonce) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature)
  )
    return null;
  const secret =
    keyId === config.inviteKeyId
      ? config.inviteSecret
      : config.invitePreviousKeyId === keyId
        ? config.invitePreviousSecret
        : undefined;
  if (!secret) return null;
  const actual = Buffer.from(signature, 'base64url');
  const expected = mac([purpose, communityId, version, keyId, id, expiryText, nonce], secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  const expiresAt = new Date(Number(expiryText));
  if (expiresAt.getTime() <= Date.now()) return null;
  return { id, expiresAt };
}
