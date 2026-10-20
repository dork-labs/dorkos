/**
 * The step-up statement: one canonical set of bytes per statement, refused in
 * any other spelling, and the messages the hub's page and the approve page
 * pass to each other.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  PasskeyEnrolStatementV1Schema,
  STEP_UP_STATEMENT_MAX_BASE64URL_LENGTH,
  STEP_UP_STATEMENT_MAX_BYTES,
  STEP_UP_STATEMENT_MAX_DEPTH,
  StepUpLoopbackReturnToSchema,
  StepUpMessageSchema,
  StepUpStatementError,
  StepUpStatementV1Schema,
  decodeStepUpBase64url,
  decodeStepUpStatement,
  encodeStepUpBase64url,
  encodeStepUpStatement,
  isStatementExpired,
  stepUpChallenge,
  type PasskeyEnrolStatementV1,
  type StepUpStatementV1,
} from '../index.js';

const NONCE = 'A'.repeat(42) + 'E';
const CREDENTIAL = 'AQIDBAUGBwg';

function approval(extra: Partial<Record<keyof StepUpStatementV1, unknown>> = {}) {
  return {
    t: 'dorkos.relay.approval.v1',
    challengeId: '01KJXYKJYW4N8QGQ5W4GB6YM9J',
    computerId: 'computer-1',
    computerName: 'Dorian’s MacBook',
    hubOrigin: 'https://hub.example.test',
    sessionId: '3f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c',
    toolCallId: 'toolu_01',
    decision: 'approve',
    toolName: 'Bash',
    displayName: 'Run a command',
    input: { command: 'ls -la', nested: { z: [1, 'two', { b: true, a: null }], a: 'é😀' } },
    inputSha256: 'a'.repeat(64),
    nonce: NONCE,
    issuedAt: '2026-10-19T10:00:00.000Z',
    expiresAt: '2026-10-19T10:02:00.000Z',
    rpId: 'approve.dorkos.ai',
    origin: 'https://approve.dorkos.ai',
    credentialIds: [CREDENTIAL],
    ...extra,
  } as StepUpStatementV1;
}

function enrol(extra: Partial<Record<keyof PasskeyEnrolStatementV1, unknown>> = {}) {
  return {
    t: 'dorkos.relay.passkey-enrol.v1',
    challengeId: '01KJXYKJYW4N8QGQ5W4GB6YM9K',
    computerId: 'computer-1',
    computerName: 'Studio',
    accountId: 'acct_123',
    userHandle: 'dXNlci1oYW5kbGU',
    nonce: NONCE,
    issuedAt: '2026-10-19T10:00:00.000Z',
    expiresAt: '2026-10-19T10:02:00.000Z',
    rpId: 'approve.dorkos.ai',
    origin: 'https://approve.dorkos.ai',
    returnTo: 'http://127.0.0.1:4242/relay-passkey',
    excludeCredentialIds: [],
    ...extra,
  } as PasskeyEnrolStatementV1;
}

const utf8 = (text: string) => new TextEncoder().encode(text);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function refused(bytes: Uint8Array): void {
  expect(() => decodeStepUpStatement(bytes)).toThrow(StepUpStatementError);
}

describe('encoding and decoding a statement', () => {
  it('round-trips an approval and an enrolment byte for byte', () => {
    for (const statement of [approval(), enrol()]) {
      const bytes = encodeStepUpStatement(statement);
      expect(decodeStepUpStatement(bytes)).toEqual(statement);
      expect(encodeStepUpStatement(decodeStepUpStatement(bytes))).toEqual(bytes);
    }
  });

  it('writes keys sorted at every depth, with no whitespace', () => {
    const written = text(encodeStepUpStatement(approval({ input: { b: { d: 1, c: [2] }, a: 0 } })));
    expect(written.startsWith('{"challengeId":')).toBe(true);
    expect(written).toContain('"input":{"a":0,"b":{"c":[2],"d":1}}');
    expect(written).not.toMatch(/\s(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  });

  it('carries non-JSON input as the raw string', () => {
    const bytes = encodeStepUpStatement(approval({ input: 'not { json' }));
    expect(decodeStepUpStatement(bytes)).toMatchObject({ input: 'not { json' });
  });

  it('refuses a statement with its keys reordered', () => {
    const value = JSON.parse(text(encodeStepUpStatement(approval()))) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(value).reverse());
    refused(utf8(JSON.stringify(reordered)));
  });

  it('refuses whitespace anywhere, including padding around the object', () => {
    const canonical = text(encodeStepUpStatement(approval()));
    refused(utf8(` ${canonical}`));
    refused(utf8(`${canonical}\n`));
    refused(utf8(JSON.stringify(JSON.parse(canonical), null, 2)));
  });

  it('refuses a key given twice, whichever copy a parser would keep', () => {
    const canonical = text(encodeStepUpStatement(approval()));
    refused(
      utf8(canonical.replace('"decision":"approve"', '"decision":"deny","decision":"approve"'))
    );
    refused(
      utf8(canonical.replace('"decision":"approve"', '"decision":"approve","decision":"approve"'))
    );
  });

  it('refuses an extra key, at the top or as an extra statement field', () => {
    const canonical = text(encodeStepUpStatement(approval()));
    refused(utf8(canonical.replace('{"challengeId"', '{"alwaysAllow":true,"challengeId"')));
    expect(() => encodeStepUpStatement({ ...approval(), extra: 1 } as StepUpStatementV1)).toThrow(
      StepUpStatementError
    );
  });

  it('refuses a needless escape that decodes to the same text', () => {
    const canonical = text(encodeStepUpStatement(approval()));
    refused(utf8(canonical.replace('"toolName":"Bash"', '"toolName":"\\u0042ash"')));
  });

  it('refuses bytes that are not valid UTF-8', () => {
    const canonical = encodeStepUpStatement(approval());
    const at = text(canonical).indexOf('Bash');
    const broken = new Uint8Array(canonical);
    broken[at] = 0xff;
    refused(broken);
    // A surrogate half written as UTF-8 bytes (CESU-8) is invalid UTF-8 too.
    refused(
      new Uint8Array([...canonical.slice(0, at), 0xed, 0xa0, 0x80, ...canonical.slice(at + 1)])
    );
  });

  it('refuses a leading byte-order mark', () => {
    refused(new Uint8Array([0xef, 0xbb, 0xbf, ...encodeStepUpStatement(approval())]));
  });

  it('refuses an unpaired surrogate, escaped or not', () => {
    expect(() => encodeStepUpStatement(approval({ input: { a: '\ud800' } }))).toThrow(
      StepUpStatementError
    );
    const canonical = text(encodeStepUpStatement(approval({ input: { a: 'x' } })));
    refused(utf8(canonical.replace('"a":"x"', '"a":"\\ud800"')));
  });

  it('refuses a __proto__ key, which a canonical hash would silently drop', () => {
    const input = JSON.parse('{"__proto__":{"admin":true},"a":1}') as unknown;
    expect(() => encodeStepUpStatement(approval({ input }))).toThrow(StepUpStatementError);
    const canonical = text(encodeStepUpStatement(approval({ input: { a: 1 } })));
    refused(
      utf8(canonical.replace('"input":{"a":1}', '"input":{"__proto__":{"admin":true},"a":1}'))
    );
  });

  it('refuses a statement over the byte cap, writing or reading', () => {
    const big = approval({ input: 'x'.repeat(STEP_UP_STATEMENT_MAX_BYTES) });
    expect(() => encodeStepUpStatement(big)).toThrow(/larger than 262144 bytes/);
    refused(new Uint8Array(STEP_UP_STATEMENT_MAX_BYTES + 1));
  });

  it('refuses nesting past the depth cap the same way on every engine', () => {
    let deep: unknown = 1;
    for (let i = 0; i < STEP_UP_STATEMENT_MAX_DEPTH; i += 1) deep = [deep];
    expect(() => encodeStepUpStatement(approval({ input: deep }))).toThrow(/nest deeper/);
  });

  it.each([5_000, 100_000])(
    'refuses %i levels of nesting on read without overflowing the stack',
    (depth) => {
      const canonical = text(encodeStepUpStatement(approval({ input: 0 })));
      const deep = canonical.replace(
        '"input":0',
        `"input":${'['.repeat(depth)}${']'.repeat(depth)}`
      );
      const bytes = utf8(deep);
      expect(bytes.byteLength).toBeLessThanOrEqual(STEP_UP_STATEMENT_MAX_BYTES);
      expect(() => decodeStepUpStatement(bytes)).toThrow(StepUpStatementError);
      expect(() => decodeStepUpStatement(bytes)).toThrow(/nest deeper/);
    }
  );

  it('counts nesting only outside strings', () => {
    const brackets = '[{'.repeat(STEP_UP_STATEMENT_MAX_DEPTH) + '\\"[';
    const bytes = encodeStepUpStatement(approval({ input: brackets }));
    expect(decodeStepUpStatement(bytes)).toMatchObject({ input: brackets });
  });

  it('refuses a 5,000-deep value on write without overflowing the stack', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 5_000; i += 1) deep = { a: deep };
    expect(() => encodeStepUpStatement(approval({ input: deep }))).toThrow(StepUpStatementError);
    expect(() => encodeStepUpStatement(approval({ input: deep }))).toThrow(/nest deeper/);
  });

  it('accepts nesting right up to the cap', () => {
    // The statement is one level and `input` itself one more.
    let deep: unknown = 1;
    for (let i = 0; i < STEP_UP_STATEMENT_MAX_DEPTH - 1; i += 1) deep = [deep];
    const bytes = encodeStepUpStatement(approval({ input: deep }));
    expect(decodeStepUpStatement(bytes)).toMatchObject({ input: deep });
  });

  it('takes times only as toISOString writes them, with milliseconds', () => {
    for (const time of [
      '2026-10-19T10:00:00Z',
      '2026-10-19T10:00:00.0000Z',
      '2026-10-19T11:00:00.000+01:00',
    ]) {
      expect(StepUpStatementV1Schema.safeParse(approval({ issuedAt: time })).success, time).toBe(
        false
      );
    }
    expect(new Date('2026-10-19T10:00:00Z').toISOString()).toBe('2026-10-19T10:00:00.000Z');
  });

  it('refuses an expiry that is not after the issue time', () => {
    expect(
      StepUpStatementV1Schema.safeParse(approval({ expiresAt: '2026-10-19T10:00:00.000Z' })).success
    ).toBe(false);
  });
});

describe('origins and the way back', () => {
  it('refuses an origin or hub origin with a path, a trailing slash, or plain http', () => {
    for (const bad of [
      'https://hub.example.test/',
      'https://hub.example.test/chat',
      'http://hub.example.test',
      'https://HUB.example.test',
    ]) {
      expect(StepUpStatementV1Schema.safeParse(approval({ hubOrigin: bad })).success, bad).toBe(
        false
      );
    }
    for (const bad of ['https://approve.dorkos.ai/', 'https://approve.dorkos.ai/x']) {
      expect(StepUpStatementV1Schema.safeParse(approval({ origin: bad })).success, bad).toBe(false);
    }
  });

  it('refuses a relying party id that is not the origin`s own host', () => {
    expect(StepUpStatementV1Schema.safeParse(approval({ rpId: 'dorkos.ai' })).success).toBe(false);
    expect(
      StepUpStatementV1Schema.safeParse(approval({ origin: 'https://evil.example' })).success
    ).toBe(false);
  });

  it('accepts a loopback return page with an explicit port', () => {
    for (const ok of [
      'http://127.0.0.1:4242/relay-passkey',
      'http://[::1]:6242/relay-passkey?state=abc',
    ]) {
      expect(StepUpLoopbackReturnToSchema.safeParse(ok).success, ok).toBe(true);
    }
  });

  it('keeps the bracketed IPv6 loopback exactly as written', () => {
    const value = 'http://[::1]:4242/relay-passkey';
    expect(new URL(value).href).toBe(value);
    expect(PasskeyEnrolStatementV1Schema.safeParse(enrol({ returnTo: value })).success).toBe(true);
  });

  it('refuses every return page that is not this computer`s loopback', () => {
    for (const bad of [
      'https://evil.example/',
      'https://127.0.0.1:4242/relay-passkey',
      'http://127.0.0.1.evil.example/',
      'http://127.0.0.1.evil.example:4242/',
      'http://localhost.evil.example:4242/',
      'http://localhost:4242/relay-passkey',
      'http://LOCALHOST:4242/relay-passkey',
      'http://[::ffff:127.0.0.1]:4242/relay-passkey',
      'http://[0:0:0:0:0:0:0:1]:4242/relay-passkey',
      'http://[::0:1]:4242/relay-passkey',
      'http://[::1]/relay-passkey',
      'http://[::1]:4242',
      'http://127.0.0.1/relay-passkey',
      'http://127.0.0.1:4242',
      'http://127.0.0.1:4242/relay-passkey#frag',
      'http://user@127.0.0.1:4242/',
      'http://127.0.0.1:4242/a/../b',
      'http://LOCALHOST:4242/',
      'http://2130706433:4242/',
    ]) {
      expect(StepUpLoopbackReturnToSchema.safeParse(bad).success, bad).toBe(false);
      expect(PasskeyEnrolStatementV1Schema.safeParse(enrol({ returnTo: bad })).success, bad).toBe(
        false
      );
    }
  });
});

describe('the challenge', () => {
  it('is base64url SHA-256 of the exact bytes', async () => {
    // FIPS 180-2 test vector: SHA-256("abc").
    const challenge = await stepUpChallenge(utf8('abc'));
    expect(challenge).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
    expect(challenge).toHaveLength(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('matches Node`s own hash of a statement', async () => {
    const bytes = encodeStepUpStatement(approval());
    expect(await stepUpChallenge(bytes)).toBe(
      createHash('sha256').update(bytes).digest('base64url')
    );
  });
});

describe('base64url', () => {
  it('round-trips against Node`s encoder at every length mod 3', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 31, 32, 33]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 97 + 13) & 0xff);
      const encoded = encodeStepUpBase64url(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString('base64url'));
      expect(decodeStepUpBase64url(encoded)).toEqual(bytes);
    }
  });

  it('refuses padding, other alphabets and stray trailing bits', () => {
    for (const bad of ['AQ==', 'A+/=', 'A', 'AR', 'AQJ']) {
      expect(() => decodeStepUpBase64url(bad), bad).toThrow(StepUpStatementError);
    }
  });

  it('caps a statement`s base64url at the byte cap', () => {
    expect(STEP_UP_STATEMENT_MAX_BASE64URL_LENGTH).toBe(349_526);
    expect(encodeStepUpBase64url(new Uint8Array(STEP_UP_STATEMENT_MAX_BYTES))).toHaveLength(
      STEP_UP_STATEMENT_MAX_BASE64URL_LENGTH
    );
  });
});

describe('expiry', () => {
  it('is expired at and after expiresAt, not before', () => {
    const statement = approval();
    expect(isStatementExpired(statement, new Date('2026-10-19T10:01:59.999Z'))).toBe(false);
    expect(isStatementExpired(statement, new Date('2026-10-19T10:02:00.000Z'))).toBe(true);
    expect(isStatementExpired(statement, new Date('2026-10-19T11:00:00.000Z'))).toBe(true);
  });
});

describe('messages between the pages', () => {
  const assertion = {
    challengeId: 'c1',
    credentialId: CREDENTIAL,
    clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0',
    authenticatorData: 'SZYN5YgO',
    signature: 'MEUCIQ',
  };
  const every = [
    { type: 'dorkos.stepup.ready' },
    { type: 'dorkos.stepup.request', v: 1, statement: 'eyJ0IjoiZG9ya29zIn0' },
    { type: 'dorkos.stepup.result', challengeId: 'c1', assertion },
    { type: 'dorkos.stepup.cancel', challengeId: 'c1', reason: 'dismissed' },
    { type: 'dorkos.stepup.cancel', challengeId: 'c1', reason: 'expired' },
    { type: 'dorkos.stepup.cancel', challengeId: 'c1', reason: 'not-allowed' },
  ];

  it('parses every kind', () => {
    for (const message of every) {
      expect(StepUpMessageSchema.safeParse(message).success, message.type).toBe(true);
    }
  });

  it('refuses an extra key on every kind', () => {
    for (const message of every) {
      expect(StepUpMessageSchema.safeParse({ ...message, origin: '*' }).success, message.type).toBe(
        false
      );
    }
    expect(
      StepUpMessageSchema.safeParse({ ...every[2], assertion: { ...assertion, extra: 1 } }).success
    ).toBe(false);
  });

  it('refuses an unknown type, another version and another cancel reason', () => {
    expect(StepUpMessageSchema.safeParse({ type: 'dorkos.stepup.approve' }).success).toBe(false);
    expect(StepUpMessageSchema.safeParse({ ...every[1], v: 2 }).success).toBe(false);
    expect(StepUpMessageSchema.safeParse({ ...every[3], reason: 'timeout' }).success).toBe(false);
  });

  it('refuses a result whose assertion is for another challenge', () => {
    expect(StepUpMessageSchema.safeParse({ ...every[2], challengeId: 'c2' }).success).toBe(false);
  });

  it('caps the statement it carries', () => {
    const at = 'A'.repeat(STEP_UP_STATEMENT_MAX_BASE64URL_LENGTH);
    expect(StepUpMessageSchema.safeParse({ ...every[1], statement: at }).success).toBe(true);
    expect(StepUpMessageSchema.safeParse({ ...every[1], statement: `${at}A` }).success).toBe(false);
  });
});
