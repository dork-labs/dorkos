/**
 * DOR-3858: a marked agent turn cannot pair a typed secret with a new address
 * while the stranger-turn flag is on.
 */
import { describe, expect, it } from 'vitest';
import { WEBHOOK_MANIFEST } from '@dorkos/relay';
import {
  adapterAddressChanged,
  hasTypedAdapterSecret,
  markedTurnSecretToNewAddressRefusal,
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
});

describe('markedTurnSecretToNewAddressRefusal', () => {
  const blocked = {
    enabled: true,
    writer: 'agent' as const,
    turnMarked: true,
    typedSecret: true,
    addressChanged: true,
  };

  it('refuses only the marked agent turn that types a secret for a new address', () => {
    expect(markedTurnSecretToNewAddressRefusal(blocked)).toEqual({
      error:
        "This turn followed a message DorkOS can't vouch for, so it can't send a secret to a new address. Ask a person to enter it.",
      code: 'marked_turn_secret_to_new_address',
    });
  });

  it('refuses an agent writer it cannot identify, saying so', () => {
    expect(
      markedTurnSecretToNewAddressRefusal({ ...blocked, turnMarked: false, unidentified: true })
    ).toEqual({
      error:
        "DorkOS couldn't tell which agent sent this, so it can't send a secret to a new address. Ask a person to enter it.",
      code: 'marked_turn_secret_to_new_address',
    });
  });

  it.each([
    ['flag off', { enabled: false }],
    ['unidentified with the flag off', { unidentified: true, enabled: false }],
    ['unidentified at the same address', { unidentified: true, addressChanged: false }],
    ['person writer', { writer: 'person' as const }],
    ['unmarked turn', { turnMarked: false }],
    ['empty or masked secret', { typedSecret: false }],
    ['same saved address', { addressChanged: false }],
  ])('allows %s', (_name, change) => {
    expect(markedTurnSecretToNewAddressRefusal({ ...blocked, ...change })).toBeNull();
  });
});
