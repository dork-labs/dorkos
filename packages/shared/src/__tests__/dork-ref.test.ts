import { describe, expect, it } from 'vitest';
import {
  AGENT_ID_PATTERN,
  DORK_KINDS,
  dorkLinkPath,
  dorkRef,
  dorkUriFromLink,
  formatDorkReference,
  isDorkKind,
  parseAnyDorkReference,
  parseDorkReference,
  publicChatReference,
  type DorkKind,
} from '../dork-ref.js';
import { RelayAgentIdSchema } from '../session-relay.js';

/** One id per kind, in the shape each kind is minted in. */
const SAMPLE_IDS: Record<DorkKind, string> = {
  space: '01JD3F1W2KQ8Z0YV9N6B5T4RMA',
  person: 'acct_9f3d4e8b',
  agent: '01KJXYKJYW4N8QGQ5W4GB6YM9J',
  host: '3c594f448c55cbfade7fd79a1915dab8',
  room: '01JD3G7P1Q4R8S9T0U2V3W4X5Y',
  entry: '01JD3G7Z7P1Q4R8S9T0U2V3W4X',
  chat: '7c1e4b2a-9f3d-4e8b-a6c5-a1b2c3d4e5f6',
  turn: '01JD3F2Z7P1Q4R8S9T0U2V3W4X',
  todo: '01JD3H0A1B2C3D4E5F6G7H8J9K',
  run: '01JD3H1A1B2C3D4E5F6G7H8J9K',
};

describe('dork: references round-trip', () => {
  it.each(DORK_KINDS)('%s: format, parse, link and desktop link agree', (kind) => {
    const ref = dorkRef(kind, SAMPLE_IDS[kind]);
    const uri = formatDorkReference(ref);
    expect(uri).toBe(`dork:${kind}:${SAMPLE_IDS[kind]}`);
    expect(parseDorkReference(uri)).toEqual({ ok: true, value: ref });
    expect(parseDorkReference(uri, kind)).toEqual({ ok: true, value: ref });
    expect(parseAnyDorkReference(uri)).toEqual({ ok: true, value: ref });

    const link = dorkLinkPath(ref);
    expect(link).toBe(`/r/${uri}`);
    expect(dorkUriFromLink(link)).toBe(uri);
    expect(dorkUriFromLink(`dorkos://r/${uri}`)).toBe(uri);
  });

  it('keeps the id case exactly as minted', () => {
    const upper = parseDorkReference('dork:agent:01KJXYKJYW4N8QGQ5W4GB6YM9J');
    const lower = parseDorkReference('dork:agent:01kjxykjyw4n8qgq5w4gb6ym9j');
    expect(upper.ok && lower.ok && upper.value.id !== lower.value.id).toBe(true);
  });

  it('accepts a 64-character id and a 16-letter kind word', () => {
    expect(parseDorkReference(`dork:chat:${'a'.repeat(64)}`).ok).toBe(true);
    expect(parseAnyDorkReference(`dork:${'a'.repeat(16)}:x`).ok).toBe(true);
  });

  it('cuts a public chat reference to the first eight characters of the id', () => {
    expect(publicChatReference(SAMPLE_IDS.chat)).toBe('dork:chat:7c1e4b2a');
  });
});

describe('dork: reference refusals', () => {
  it.each([
    ['not-a-string', 42],
    ['not-a-string', null],
    ['no-scheme', 'chat:abc'],
    ['no-scheme', ' dork:chat:abc'],
    ['no-scheme', 'DORK:chat:abc'],
    ['no-kind', 'dork:chat'],
    ['no-kind', 'dork://chat/abc'],
    ['bad-kind', 'dork://chat:abc'],
    ['bad-kind', 'dork:Chat:abc'],
    ['bad-kind', 'dork::abc'],
    ['bad-kind', `dork:${'a'.repeat(17)}:abc`],
    ['bad-id', 'dork:chat:'],
    ['bad-id', `dork:chat:${'a'.repeat(65)}`],
    ['bad-id', 'dork:chat:a.b'],
    ['bad-id', 'dork:chat:a/b'],
    ['bad-id', 'dork:chat:a:b'],
    ['bad-id', 'dork:chat:abc '],
    ['bad-id', 'dork:chat:café'],
  ])('%s: %j', (reason, input) => {
    expect(parseAnyDorkReference(input)).toEqual({ ok: false, reason });
    expect(parseDorkReference(input)).toEqual({ ok: false, reason });
  });

  it('keeps an unknown kind in parseAnyDorkReference and refuses it in parseDorkReference', () => {
    expect(parseAnyDorkReference('dork:widget:abc')).toEqual({
      ok: true,
      value: { kind: 'widget', id: 'abc' },
    });
    expect(parseDorkReference('dork:widget:abc')).toEqual({ ok: false, reason: 'unknown-kind' });
    expect(isDorkKind('widget')).toBe(false);
  });

  it('has no project kind: a project name is not an opaque id', () => {
    expect(DORK_KINDS).toEqual([
      'space',
      'person',
      'agent',
      'host',
      'room',
      'entry',
      'chat',
      'turn',
      'todo',
      'run',
    ]);
    expect(parseDorkReference('dork:project:dorkos')).toEqual({
      ok: false,
      reason: 'unknown-kind',
    });
  });

  it('refuses a known kind that is not the expected one', () => {
    expect(parseDorkReference('dork:room:abc', 'chat')).toEqual({
      ok: false,
      reason: 'wrong-kind',
    });
  });

  it('refuses to build or spell a reference that would not parse back', () => {
    expect(() => dorkRef('chat', '')).toThrow(TypeError);
    expect(() => dorkRef('chat', 'a/b')).toThrow(TypeError);
    expect(() => dorkRef('widget' as DorkKind, 'abc')).toThrow(TypeError);
    expect(() => formatDorkReference({ kind: 'Chat', id: 'abc' })).toThrow(TypeError);
    expect(() => formatDorkReference({ kind: 'chat', id: 'a'.repeat(65) })).toThrow(TypeError);
  });
});

describe('dorkUriFromLink', () => {
  it('drops a query string or fragment after the URI', () => {
    expect(dorkUriFromLink('/r/dork:room:abc?seq=4')).toBe('dork:room:abc');
    expect(dorkUriFromLink('dorkos://r/dork:room:abc#top')).toBe('dork:room:abc');
  });

  it('answers null for anything that is not a /r/ link to a dork: URI', () => {
    expect(dorkUriFromLink('/session?session=abc')).toBeNull();
    expect(dorkUriFromLink('/r/chat:abc')).toBeNull();
    expect(dorkUriFromLink('dorkos://session?session=abc')).toBeNull();
    expect(dorkUriFromLink('r/dork:chat:abc')).toBeNull();
  });

  it('decodes a web and a desktop link the same way, exactly once', () => {
    for (const prefix of ['/r/', 'dorkos://r/']) {
      expect(dorkUriFromLink(`${prefix}dork%3Achat%3Aabc`)).toBe('dork:chat:abc');
      expect(dorkUriFromLink(`${prefix}dork%3achat%3aabc?x=1`)).toBe('dork:chat:abc');
      expect(dorkUriFromLink(`${prefix}dork%253Achat%253Aabc`)).toBeNull();
      expect(dorkUriFromLink(`${prefix}dork:chat:a%2525b`)).toBeNull();
      expect(dorkUriFromLink(`${prefix}dork:chat:%E0%A4%A`)).toBeNull();
    }
  });
});

describe('AGENT_ID_PATTERN', () => {
  const valid = ['01KJXYKJYW4N8QGQ5W4GB6YM9J', '7ZZZZZZZZZZZZZZZZZZZZZZZZZ', '0'.repeat(26)];
  const invalid = [
    '01KJXYKJYW4N8QGQ5W4GB6YM9', // 25
    '01KJXYKJYW4N8QGQ5W4GB6YM9JA', // 27
    '01kjxykjyw4n8qgq5w4gb6ym9j', // lower case
    '01KJXYKJYW4N8QGQ5W4GB6YM9I', // I is not Crockford
    '01KJXYKJYW4N8QGQ5W4GB6YM9L',
    '01KJXYKJYW4N8QGQ5W4GB6YM9O',
    '01KJXYKJYW4N8QGQ5W4GB6YM9U',
    'dorkbot',
  ];

  it.each(valid)('accepts %s, as RelayAgentIdSchema does', (id) => {
    expect(AGENT_ID_PATTERN.test(id)).toBe(true);
    expect(RelayAgentIdSchema.safeParse(id).success).toBe(true);
  });

  it.each(invalid)('refuses %s, as RelayAgentIdSchema does', (id) => {
    expect(AGENT_ID_PATTERN.test(id)).toBe(false);
    expect(RelayAgentIdSchema.safeParse(id).success).toBe(false);
  });
});
