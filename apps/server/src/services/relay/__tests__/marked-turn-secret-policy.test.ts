/**
 * DOR-3858, DOR-4453 F2: a marked agent turn cannot type a secret into a
 * connection, whatever its address, while the stranger-turn flag is on.
 */
import { describe, expect, it } from 'vitest';
import { TELEGRAM_MANIFEST, WEBHOOK_MANIFEST } from '@dorkos/relay';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { adapterAddressChanged, hasTypedAdapterSecret } from '../adapter-secret-policy.js';
import { markedTurnSecretRefusal, movesStoredSecrets } from '../secrets/marked-turn-secret-gate.js';

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

describe('markedTurnSecretRefusal', () => {
  const blocked = {
    enabled: true,
    writer: 'agent' as const,
    turnMarked: true,
    typedSecret: true,
  };

  it('refuses the marked agent turn that types a secret, with no address to judge', () => {
    expect(markedTurnSecretRefusal(blocked)).toEqual({
      error:
        "This turn followed a message DorkOS can't vouch for, so it can't enter a secret. Ask a person to enter it.",
      code: 'marked_turn_typed_secret',
    });
  });

  it('refuses an agent writer it cannot identify, saying so', () => {
    expect(markedTurnSecretRefusal({ ...blocked, turnMarked: false, unidentified: true })).toEqual({
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
    expect(markedTurnSecretRefusal({ ...blocked, ...change })).toBeNull();
  });
});

// DOR-4453 review: on a connection holding a stored secret, any change counts, declared or not, of
// any type, so a plugin's endpoint can't carry the saved token along wherever the plugin reads it.
const PLUGIN_MANIFEST = {
  configFields: [
    { key: 'endpoint', type: 'text', label: 'Endpoint' },
    { key: 'retries', type: 'number', label: 'Retries' },
    { key: 'token', type: 'password', label: 'Token', required: true },
  ],
} as unknown as AdapterManifest;
const STORED = {
  endpoint: 'https://owner.example.test/in',
  retries: 3,
  target: 'https://owner.example.test/undeclared',
  token: 'file:relay-adapter:p:token',
};
const OUTSIDE = 'https://outside.example.test/in';

describe('movesStoredSecrets', () => {
  it.each([
    ['a text endpoint', { endpoint: OUTSIDE, token: '***' }],
    ['a number field', { retries: 4 }],
    ['a key the manifest never declares', { target: OUTSIDE }],
  ])('counts a change to %s on a connection holding a stored secret', (_name, incoming) => {
    expect(movesStoredSecrets(STORED, incoming, PLUGIN_MANIFEST)).toBe(true);
  });

  it('counts every key for a type with no manifest, and an unchanged one as no change', () => {
    expect(movesStoredSecrets(STORED, { target: OUTSIDE }, undefined)).toBe(true);
    expect(movesStoredSecrets(STORED, { target: STORED.target }, undefined)).toBe(false);
  });

  it.each([
    ['the same values', { endpoint: STORED.endpoint, retries: 3, token: '***' }],
    ['no keys but the masked secret', { token: '***' }],
  ])('is false for %s', (_name, incoming) => {
    expect(movesStoredSecrets(STORED, incoming, PLUGIN_MANIFEST)).toBe(false);
  });

  it('is false for an add, which has nothing stored', () => {
    expect(movesStoredSecrets(undefined, { endpoint: OUTSIDE }, PLUGIN_MANIFEST)).toBe(false);
  });

  it('is false when nothing secret is stored', () => {
    expect(
      movesStoredSecrets({ endpoint: STORED.endpoint }, { endpoint: OUTSIDE }, PLUGIN_MANIFEST)
    ).toBe(false);
  });

  // Re-review nit 1: lists and JSON maps are compared by content once the form shapes resolve.
  describe('the whole Telegram form saved back', () => {
    const saved = {
      token: 'file:relay-adapter:tg:token',
      mode: 'polling',
      webhookPort: 8443,
      dmPolicy: 'allowlist',
      dmAllowlist: ['111', '222'],
      approverAllowlist: ['111'],
    };
    const form = {
      token: '***',
      mode: 'polling',
      webhookUrl: '',
      webhookPort: 8443,
      webhookSecret: '',
      dmPolicy: 'allowlist',
      dmAllowlist: '111\n222',
      approverAllowlist: '111',
    };

    it('is no change when nothing was edited', () => {
      expect(movesStoredSecrets(saved, form, TELEGRAM_MANIFEST)).toBe(false);
    });

    it('is a change when the approver list was edited', () => {
      expect(
        movesStoredSecrets(saved, { ...form, approverAllowlist: '111\n999' }, TELEGRAM_MANIFEST)
      ).toBe(true);
    });
  });

  it('refuses the move for a marked turn, and says why', () => {
    expect(
      markedTurnSecretRefusal({
        enabled: true,
        writer: 'agent',
        turnMarked: true,
        typedSecret: false,
        movesSecrets: true,
      })
    ).toMatchObject({ code: 'marked_turn_moves_secret' });
    expect(
      markedTurnSecretRefusal({
        enabled: true,
        writer: 'agent',
        turnMarked: false,
        typedSecret: false,
        movesSecrets: true,
      })
    ).toBeNull();
  });
});
