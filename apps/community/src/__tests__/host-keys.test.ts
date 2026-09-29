import { describe, expect, it } from 'vitest';
import { parseHostKeyCommand } from '../host-keys.js';
import {
  HOST_API_KEY_PATTERN,
  bearerCredential,
  isHostApiKeyBearer,
  mintHostApiKeySecret,
} from '../security.js';

describe('parseHostKeyCommand', () => {
  // Purpose: the offline command is the headless way in; a typo must never issue a wider key.
  it('parses an issue with repeated scopes and an expiry', () => {
    expect(
      parseHostKeyCommand([
        'issue',
        '--label',
        ' Provisioner ',
        '--scope',
        'communities:read',
        '--scope',
        'communities:write',
        '--expires-in-days',
        '30',
      ])
    ).toEqual({
      kind: 'issue',
      label: 'Provisioner',
      scopes: ['communities:read', 'communities:write'],
      expiresInDays: 30,
    });
  });

  // Purpose: fails if the offline command cannot issue the takedown scope a host needs first.
  it('issues the takedown scope', () => {
    expect(
      parseHostKeyCommand(['issue', '--label', 'Reports', '--scope', 'communities:takedown'])
    ).toMatchObject({ scopes: ['communities:takedown'] });
  });

  it('parses list and revoke', () => {
    expect(parseHostKeyCommand(['list'])).toEqual({ kind: 'list' });
    expect(parseHostKeyCommand(['revoke', 'A0000000-0000-4000-8000-000000000000'])).toEqual({
      kind: 'revoke',
      keyId: 'a0000000-0000-4000-8000-000000000000',
    });
  });

  it.each([
    [['issue', '--label', 'X']],
    [['issue', '--scope', 'communities:read']],
    [['issue', '--label', 'X', '--scope', 'members:read']],
    [['issue', '--label', 'X', '--scope', 'communities:read', '--expires-in-days', '0']],
    [['issue', '--label', 'X', '--scope', 'communities:read', '--expires-in-days', '366']],
    [['issue', '--label', 'X', '--scope']],
    [['issue', '--label', 'X', '--scope', 'communities:read', '--admin', 'yes']],
    [['revoke', 'not-an-id']],
    [['list', 'extra']],
    [[]],
  ])('refuses %j', (argv) => {
    expect(() => parseHostKeyCommand(argv)).toThrow();
  });
});

describe('host API key secrets', () => {
  // Purpose: the dkh_ prefix is how content routes refuse a key unread and how scanners find one.
  it('mints 32 random bytes behind the dkh_ prefix', () => {
    const secret = mintHostApiKeySecret();
    expect(secret).toMatch(HOST_API_KEY_PATTERN);
    expect(mintHostApiKeySecret()).not.toBe(secret);
    expect(isHostApiKeyBearer(`Bearer ${secret}`)).toBe(true);
    expect(isHostApiKeyBearer('Bearer member-grant')).toBe(false);
    expect(isHostApiKeyBearer(undefined)).toBe(false);
    // Auth scheme names are case-insensitive (RFC 9110), so casing cannot smuggle a key past.
    expect(isHostApiKeyBearer(`bearer ${secret}`)).toBe(true);
    expect(isHostApiKeyBearer(`BEARER   ${secret}`)).toBe(true);
    expect(bearerCredential(`bearer ${secret}`)).toBe(secret);
    expect(bearerCredential('Basic abc')).toBeNull();
  });
});
