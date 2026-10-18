import { describe, expect, it } from 'vitest';
import {
  RELAY_LINK_CODE_LENGTH,
  RelayLinkComputerIdSchema,
  RelayLinkRequestSchema,
  RelayLinkResponseSchema,
  formatRelayLinkCode,
  normalizeRelayLinkCode,
  parseRelayLinkCode,
  relayLinkRequestTranscript,
  relayLinkResponseTranscript,
  agentComputerRelayId,
  cloudComputerIdOf,
} from '../session-relay-link.js';
import { SESSION_RELAY_TRANSCRIPT_LABEL } from '../session-relay.js';

const CODE = '7K3MQ9TDX2HV8RNB';
const KEY = 'A'.repeat(43);
const HASH = 'B'.repeat(43);
const SIGNATURE = 'C'.repeat(86);

const input = {
  hubOrigin: 'https://me.dorkos.app',
  codeHash: HASH,
  computerId: 'mac-1',
  computerKey: KEY,
  secretHash: HASH,
};

describe('link codes', () => {
  it('carry 80 bits', () => {
    expect(RELAY_LINK_CODE_LENGTH * 5).toBeGreaterThanOrEqual(80);
  });

  it('format with the hub host and parse back to its origin', () => {
    const shown = formatRelayLinkCode(CODE, 'https://me.dorkos.app');
    expect(shown).toBe('7K3M-Q9TD-X2HV-8RNB@me.dorkos.app');
    expect(parseRelayLinkCode(shown)).toEqual({ origin: 'https://me.dorkos.app', code: CODE });
  });

  it('keep a port that is not 443, and drop 443', () => {
    expect(formatRelayLinkCode(CODE, 'https://hub.example:8443')).toBe(
      '7K3M-Q9TD-X2HV-8RNB@hub.example:8443'
    );
    expect(parseRelayLinkCode(`${CODE}@Hub.Example:443`)?.origin).toBe('https://hub.example');
  });

  it('read what a person pastes: spaces, lower case, look-alike letters', () => {
    expect(normalizeRelayLinkCode(' 7k3m q9td–x2hv-8rnb ')).toBe(CODE);
    expect(normalizeRelayLinkCode('OOOO-IIII-LLLL-0000')).toBe('0000111111110000');
  });

  it.each([
    ['no host', CODE],
    ['an empty code', '@me.dorkos.app'],
    ['a short code', '7K3M-Q9TD@me.dorkos.app'],
    ['a letter outside the alphabet', '7K3M-Q9TD-X2HV-8RNU@me.dorkos.app'],
    ['a path', `${CODE}@me.dorkos.app/evil`],
    ['a scheme', `${CODE}@http://me.dorkos.app`],
    ['a user name', `${CODE}@user@`],
    ['a query', `${CODE}@me.dorkos.app?x=1`],
    ['a port past 65535', `${CODE}@me.dorkos.app:70000`],
    ['a line break', `${CODE}@me.dorkos.app\nx`],
  ])('refuse %s', (_label, text) => {
    expect(parseRelayLinkCode(text)).toBeNull();
  });

  it('refuse to format anything but a bare https origin', () => {
    expect(() => formatRelayLinkCode(CODE, 'http://me.dorkos.app')).toThrow();
    expect(() => formatRelayLinkCode(CODE, 'https://me.dorkos.app/path')).toThrow();
  });
});

describe('link transcripts', () => {
  it('start with the relay label so the hub key can sign the answer', () => {
    const text = new TextDecoder().decode(
      relayLinkResponseTranscript(input, { hubKey: KEY, ownerAccountId: 'acct_1' })
    );
    expect(text.startsWith(`${SESSION_RELAY_TRANSCRIPT_LABEL}\nlink-response\n`)).toBe(true);
    expect(text.split('\n')).toEqual([
      SESSION_RELAY_TRANSCRIPT_LABEL,
      'link-response',
      input.hubOrigin,
      HASH,
      'mac-1',
      KEY,
      HASH,
      KEY,
      'acct_1',
      '',
    ]);
  });

  it('give the request and the answer different kind lines', () => {
    const request = new TextDecoder().decode(relayLinkRequestTranscript(input, 'Studio Mac'));
    expect(request.split('\n').slice(0, 2)).toEqual([
      SESSION_RELAY_TRANSCRIPT_LABEL,
      'link-request',
    ]);
    expect(request.endsWith('\nStudio Mac')).toBe(true);
  });

  it('refuse a field with a line break', () => {
    expect(() => relayLinkRequestTranscript(input, 'a\nb')).toThrow(/line break/);
    expect(() =>
      relayLinkRequestTranscript({ ...input, hubOrigin: 'https://a\r\nb' }, 'Mac')
    ).toThrow(/line break/);
  });
});

describe('link request and response shapes', () => {
  const request = {
    v: 1,
    code: CODE,
    computerId: 'mac-1',
    computerKey: KEY,
    secretHash: HASH,
    computerName: 'Studio Mac',
    signature: SIGNATURE,
  };

  it('accept a well-formed request, and keep the name exactly as signed', () => {
    const parsed = RelayLinkRequestSchema.safeParse(request);
    expect(parsed.success && parsed.data.computerName).toBe('Studio Mac');
    expect(RelayLinkRequestSchema.safeParse({ ...request, computerName: 'Café Mac' }).success).toBe(
      true
    );
  });

  it.each([
    ['an extra field', { ...request, secret: 'x' }],
    ['a name with a line break', { ...request, computerName: 'a\nb' }],
    ['a name past 64 characters', { ...request, computerName: 'x'.repeat(65) }],
    ['a name with leading whitespace', { ...request, computerName: ' Studio Mac' }],
    ['a name with trailing whitespace', { ...request, computerName: 'Studio Mac ' }],
    ['a name of only spaces', { ...request, computerName: '   ' }],
    ['a name with a direction mark', { ...request, computerName: 'Studio\u202eMac' }],
    ['a name with a zero-width joiner', { ...request, computerName: 'Studio\u200dMac' }],
    ['a name with a line separator', { ...request, computerName: 'Studio\u2028Mac' }],
    ['a name with a paragraph separator', { ...request, computerName: 'Studio\u2029Mac' }],
    ['a computer id with a slash', { ...request, computerId: 'a/b' }],
    ['a short key', { ...request, computerKey: 'A'.repeat(42) }],
    ['another version', { ...request, v: 2 }],
  ])('refuse a request with %s', (_label, body) => {
    expect(RelayLinkRequestSchema.safeParse(body).success).toBe(false);
  });

  it('accept an answer with or without an owner, and refuse a non-https issuer', () => {
    const answer = { v: 1, hubKey: KEY, signature: SIGNATURE };
    expect(RelayLinkResponseSchema.safeParse(answer).success).toBe(true);
    expect(
      RelayLinkResponseSchema.safeParse({
        ...answer,
        ownerAccountId: 'acct_1',
        issuer: 'https://id.dorkos.ai',
      }).success
    ).toBe(true);
    expect(
      RelayLinkResponseSchema.safeParse({ ...answer, issuer: 'http://id.dorkos.ai' }).success
    ).toBe(false);
  });
});

describe('agent computer relay ids (DOR-2940)', () => {
  it('puts a cloud computer id behind the reserved prefix, and reads it back', () => {
    expect(agentComputerRelayId('cmp_01HZX.a-b')).toBe('ac:cmp_01HZX.a-b');
    expect(cloudComputerIdOf('ac:cmp_01HZX.a-b')).toBe('cmp_01HZX.a-b');
    expect(RelayLinkComputerIdSchema.safeParse(agentComputerRelayId('x'.repeat(61))).success).toBe(
      true
    );
  });

  it.each(['', 'has space', 'a:b', 'x'.repeat(62), 'é'])(
    'refuses %j rather than rewrite it',
    (id) => {
      expect(agentComputerRelayId(id)).toBeNull();
    }
  );

  it('reads no cloud id from a person`s computer id, or a malformed one', () => {
    expect(cloudComputerIdOf('mac-abc')).toBeNull();
    expect(cloudComputerIdOf('ac:')).toBeNull();
    expect(cloudComputerIdOf('ac:a:b')).toBeNull();
  });
});
