/**
 * DOR-3858, DOR-4453 F2: a marked agent turn cannot type a secret into a
 * connection, whatever its address, while the stranger-turn flag is on.
 */
import { describe, expect, it } from 'vitest';
import { WEBHOOK_MANIFEST } from '@dorkos/relay';
import {
  adapterAddressChanged,
  hasTypedAdapterSecret,
  markedTurnTypedSecretRefusal,
} from '../adapter-secret-policy.js';

const URL_A = 'https://first.example.test/hooks';
const URL_B = 'https://second.example.test/hooks';

describe('adapter address and typed-secret facts', () => {
  it('uses rule 3 address detection for adds, moves, and the same address', () => {
    const existing = { outbound: { url: URL_A } };

    expect(adapterAddressChanged(undefined, { outbound: { url: URL_A } }, WEBHOOK_MANIFEST)).toBe(
      true
    );
    expect(adapterAddressChanged(existing, { outbound: { url: URL_B } }, WEBHOOK_MANIFEST)).toBe(
      true
    );
    expect(adapterAddressChanged(existing, { outbound: { url: URL_A } }, WEBHOOK_MANIFEST)).toBe(
      false
    );
  });

  it('finds typed secrets after password header maps are normalized', () => {
    expect(
      hasTypedAdapterSecret(
        { outbound: { headers: '{"Authorization":"made-up-secret"}' } },
        WEBHOOK_MANIFEST
      )
    ).toBe(true);
    expect(
      hasTypedAdapterSecret(
        { outbound: { secret: '***', headers: '{"Authorization":"***","X-Key":""}' } },
        WEBHOOK_MANIFEST
      )
    ).toBe(false);
  });

  // DOR-4453 review: with no manifest nothing says which fields are secret, so it fails closed.
  it('counts any entered string as a typed secret when the type has no manifest', () => {
    expect(hasTypedAdapterSecret({ endpoint: { token: 'made-up-secret' } }, undefined)).toBe(true);
    expect(hasTypedAdapterSecret({ endpoint: { token: '***' }, note: '' }, undefined)).toBe(false);
  });
});

describe('markedTurnTypedSecretRefusal', () => {
  const blocked = {
    enabled: true,
    writer: 'agent' as const,
    turnMarked: true,
    typedSecret: true,
  };

  it('refuses the marked agent turn that types a secret, with no address to judge', () => {
    expect(markedTurnTypedSecretRefusal(blocked)).toEqual({
      error:
        "This turn followed a message DorkOS can't vouch for, so it can't enter a secret. Ask a person to enter it.",
      code: 'marked_turn_typed_secret',
    });
  });

  it('refuses an agent writer it cannot identify, saying so', () => {
    expect(
      markedTurnTypedSecretRefusal({ ...blocked, turnMarked: false, unidentified: true })
    ).toEqual({
      error:
        "DorkOS couldn't tell which agent sent this, so it can't enter a secret. Ask a person to enter it.",
      code: 'marked_turn_typed_secret',
    });
  });

  it.each([
    ['flag off', { enabled: false }],
    ['unidentified with the flag off', { unidentified: true, enabled: false }],
    ['person writer', { writer: 'person' as const }],
    ['unmarked turn', { turnMarked: false }],
    ['empty or masked secret', { typedSecret: false }],
    ['unidentified with no typed secret', { unidentified: true, typedSecret: false }],
  ])('allows %s', (_name, change) => {
    expect(markedTurnTypedSecretRefusal({ ...blocked, ...change })).toBeNull();
  });
});
