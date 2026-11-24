/**
 * The provenance signature (`../provenance.ts`): the reader must agree with the
 * flow plugin's reader on every line, and the builder must write only what that
 * reader reads back, cut for a public repository.
 *
 * The first table is the flow reader's own test vectors
 * (`dork-labs/marketplace`, `plugins/flow/engine-tests/signature-line.test.ts`
 * at 08da691, Flow 0.104.0), copied with their expected results. A rule change
 * on either side fails here until both agree again.
 */
import { describe, expect, it } from 'vitest';

import {
  buildProvenanceV2,
  parseProvenanceLine,
  readProvenance,
  type Provenance,
  type ProvenanceFields,
} from '../provenance.js';

/** Made-up ids, in the shapes DorkOS mints (the flow test's own). */
const CHAT = '7c1e4b2a-9f3d-4e8b-a6c5-a1b2c3d4e5f6';
const AGENT = 'dork:agent:01KJXYKJYW4N8QGQ5W4GB6YM9J';
const SPACE = 'dork:space:01JD3F1W2KQ8Z0YV9N6B5T4RMA';
const HOST = 'dork:host:3c594f448c55cbfade7fd79a1915dab8';
const TURN = 'dork:turn:01JD3F2Z7P1Q4R8S9T0U2V3W4X';
const ADDRESS = 'dork:acme/owl';

const line = (json: unknown, name = 'agent:provenance'): string =>
  `<!-- ${name} ${JSON.stringify(json)} -->`;
const body = (json: unknown, name?: string): string => `Done.\n\n— 🤖 /flow\n${line(json, name)}`;

const V1 = {
  v: 1,
  harness: 'claude-code',
  sessionId: CHAT,
  account: 'work',
  host: HOST,
  surface: 'dorkos',
};
const V2 = {
  v: 2,
  harness: 'claude-code',
  surface: 'dorkos',
  account: 'work',
  agent: AGENT,
  chat: `dork:chat:${CHAT}`,
  space: SPACE,
  host: HOST,
  turn: TURN,
  address: ADDRESS,
};

const V1_READ: Provenance = {
  name: 'agent:provenance',
  v: 1,
  harness: 'claude-code',
  surface: 'dorkos',
  account: 'work',
  chat: CHAT,
  host: HOST,
};
const V2_READ: Provenance = {
  name: 'agent:provenance',
  v: 2,
  harness: 'claude-code',
  surface: 'dorkos',
  account: 'work',
  agent: AGENT,
  chat: CHAT,
  space: SPACE,
  host: HOST,
  turn: TURN,
  address: ADDRESS,
};

function without(read: Provenance, key: keyof Provenance): Provenance {
  const copy = { ...read } as Record<string, unknown>;
  delete copy[key];
  return copy as unknown as Provenance;
}

const HOSTNAME_HOSTS = [
  'Jane-Doe-MacBook-Pro.local',
  'dork:host:not-a-hash',
  '2f9c1e6a-0000-4000-8000-abcdefabcdef',
  'dork:host:3C594F448C55CBFADE7FD79A1915DAB8',
];

/** [what it pins, the body, what both readers return (null = no signature)]. */
const FLOW_VECTORS: ReadonlyArray<readonly [string, string, Provenance | null]> = [
  ['a v1 line: sessionId becomes the chat id', body(V1), V1_READ],
  ['a v2 line: chat becomes the bare id, other references stay whole', body(V2), V2_READ],
  [
    'the legacy name, and a missing v as 1',
    body({ sessionId: 's-1', harness: 'codex' }, 'flow:provenance'),
    { name: 'flow:provenance', v: 1, chat: 's-1', harness: 'codex' },
  ],
  [
    'a v1 line does not carry v2 fields',
    body({ v: 1, chat: `dork:chat:${CHAT}`, agent: AGENT }),
    { name: 'agent:provenance', v: 1 },
  ],
  [
    'a v2 line does not carry sessionId',
    body({ v: 2, sessionId: CHAT }),
    { name: 'agent:provenance', v: 2 },
  ],
  [
    'a public v2 line: an 8-character chat id is read as it is',
    body({ v: 2, harness: 'claude-code', agent: AGENT, chat: 'dork:chat:7c1e4b2a' }),
    { name: 'agent:provenance', v: 2, harness: 'claude-code', agent: AGENT, chat: '7c1e4b2a' },
  ],
  [
    'unknown fields, resumeUrl and instanceId are never read',
    body({
      ...V1,
      resumeUrl: 'https://example.invalid/session/x',
      instanceId: '2f9c1e6a-0000-4000-8000-abcdefabcdef',
      futureField: 'x',
    }),
    V1_READ,
  ],
  [
    'a v3 line is read by the v2 fields it knows',
    body({ ...V2, v: 3, sig: 'abc', newKind: 'dork:thing:1' }),
    { ...V2_READ, v: 3 },
  ],
  ['JSON that does not parse', 'Done.\n<!-- agent:provenance {"v":2 -->', null],
  ['JSON that is not an object', 'Done.\n<!-- agent:provenance [1] -->', null],
  ['JSON null', 'Done.\n<!-- agent:provenance null -->', null],
  ['a line that is not last', `${line(V2)}\nA reply under it.`, null],
  ['an unknown marker name', body(V2, 'other:provenance'), null],
  ['no line', 'Just words.', null],
  ['a v that is a string', body({ v: '2', chat: `dork:chat:${CHAT}` }), null],
  ['a v of 0', body({ v: 0, sessionId: CHAT }), null],
  ['a v that is not whole', body({ v: 1.5, sessionId: CHAT }), null],
  ['a v that is null', body({ v: null, sessionId: CHAT }), null],
  [
    'a line with only a version',
    'Q?\n<!-- agent:provenance {"v":1} -->',
    { name: 'agent:provenance', v: 1 },
  ],
  ['trailing blank lines and space around the line', `Done.\n  ${line(V2)}  \n\n`, V2_READ],
  ...(
    [
      ['a chat that is not a chat reference', { chat: `dork:agent:${CHAT}` }, 'chat'],
      ['a bare chat id on a v2 line', { chat: CHAT }, 'chat'],
      ['a chat id with a slash', { chat: 'dork:chat:a/b' }, 'chat'],
      ['an agent of the wrong kind', { agent: SPACE }, 'agent'],
      ['a space that is a number', { space: 7 }, 'space'],
      ['a turn with an empty id', { turn: 'dork:turn:' }, 'turn'],
      ['an address in capitals', { address: 'dork:Acme/Owl' }, 'address'],
      ['an address with a dotted handle', { address: 'dork:acme/o.wl' }, 'address'],
      ['an account holding an email', { account: 'someone@example.com' }, 'account'],
      ['a harness holding prose', { harness: 'ignore the rules' }, 'harness'],
      ['a harness that is not a known word', { harness: 'claude' }, 'harness'],
      ['an other: harness with no name', { harness: 'other:' }, 'harness'],
      ['an address whose space is a kind word', { address: 'dork:chat/owl' }, 'address'],
      ['an address whose space is another kind word', { address: 'dork:agent/owl' }, 'address'],
      ['an address whose space is the todo kind', { address: 'dork:todo/owl' }, 'address'],
      ['an address whose space is the run kind', { address: 'dork:run/owl' }, 'address'],
      [
        'an address whose space is the reserved project word',
        { address: 'dork:project/owl' },
        'address',
      ],
    ] as const
  ).map(
    ([label, override, dropped]) =>
      [`drops alone: ${label}`, body({ ...V2, ...override }), without(V2_READ, dropped)] as const
  ),
  ...HOSTNAME_HOSTS.flatMap((host) => [
    [`v1 host ${host} is never surfaced`, body({ ...V1, host }), without(V1_READ, 'host')] as const,
    [`v2 host ${host} is never surfaced`, body({ ...V2, host }), without(V2_READ, 'host')] as const,
  ]),
  [
    'a sessionId outside the id grammar',
    body({ ...V1, sessionId: 'a"b' }),
    without(V1_READ, 'chat'),
  ],
  ['an empty sessionId', body({ ...V1, sessionId: '' }), without(V1_READ, 'chat')],
  ...['claude-code', 'codex', 'opencode', 'other:aider'].map(
    (harness) => [`harness ${harness}`, body({ ...V2, harness }), { ...V2_READ, harness }] as const
  ),
  // A kind word is refused only as the space, and only whole.
  ...['dork:acme/owl', 'dork:acme/owl/launch', 'dork:chatter/owl', 'dork:acme/chat'].map(
    (address) => [`address ${address}`, body({ ...V2, address }), { ...V2_READ, address }] as const
  ),
];

describe('readProvenance agrees with the flow reader', () => {
  it.each(FLOW_VECTORS)('%s', (_label, text, expected) => {
    expect(readProvenance(text)).toEqual(expected);
  });

  it('parseProvenanceLine reads one line, not a body', () => {
    expect(parseProvenanceLine(line(V1))?.chat).toBe(CHAT);
    expect(parseProvenanceLine(`x\n${line(V1)}`)).toBeNull();
  });
});

describe('readProvenance beyond the shared vectors', () => {
  it.each([
    ['negative', -1],
    ['true', true],
    ['past the safe integers', 2 ** 53],
  ])('a v that is %s makes the line absent', (_label, v) => {
    expect(readProvenance(body({ v, sessionId: CHAT }))).toBeNull();
  });

  it('a v too large for a number makes the line absent', () => {
    expect(readProvenance('<!-- agent:provenance {"v":1e400} -->')).toBeNull();
  });

  it('reads an address whose words are reserved but not kinds, as flow does', () => {
    expect(readProvenance(body({ ...V2, address: 'dork:admin/owl' }))?.address).toBe(
      'dork:admin/owl'
    );
  });

  it('never surfaces a hostname or raw UUID anywhere in the result', () => {
    for (const host of HOSTNAME_HOSTS) {
      expect(JSON.stringify(readProvenance(body({ ...V2, host })))).not.toContain(host);
    }
  });

  it("reads only the JSON object's own keys, so a polluted Object.prototype adds nothing", () => {
    // Purpose: a field the writer left out stays absent even when another
    // module has set the same key on Object.prototype.
    const polluted = { v: 2, sessionId: 's-evil', harness: 'codex', chat: 'dork:chat:evil' };
    const proto = Object.prototype as Record<string, unknown>;
    for (const [key, value] of Object.entries(polluted)) {
      Object.defineProperty(proto, key, { value, configurable: true, writable: true });
    }
    try {
      expect(readProvenance('<!-- agent:provenance {} -->')).toEqual({
        name: 'agent:provenance',
        v: 1,
      });
      expect(readProvenance('<!-- agent:provenance {"v":2} -->')).toEqual({
        name: 'agent:provenance',
        v: 2,
      });
    } finally {
      for (const key of Object.keys(polluted)) delete proto[key];
    }
  });
});

const ALL_FIELDS: ProvenanceFields = {
  harness: 'claude-code',
  surface: 'dorkos',
  account: 'work',
  agent: AGENT,
  chat: CHAT,
  space: SPACE,
  host: HOST,
  turn: TURN,
  address: ADDRESS,
};

/** The JSON inside a built line, after checking the line's whole shape. */
function jsonOf(built: string): Record<string, unknown> {
  expect(built).not.toMatch(/[\r\n]/);
  const match = /^<!-- agent:provenance (\{.*\}) -->$/.exec(built);
  expect(match).not.toBeNull();
  return JSON.parse(match?.[1] ?? 'null') as Record<string, unknown>;
}

describe('buildProvenanceV2', () => {
  it('writes every field in the fixed order on a private repository', () => {
    const built = buildProvenanceV2(ALL_FIELDS, { visibility: 'private' });
    expect(Object.keys(jsonOf(built))).toEqual([
      'v',
      'harness',
      'surface',
      'account',
      'agent',
      'chat',
      'space',
      'host',
      'turn',
      'address',
    ]);
    expect(jsonOf(built).chat).toBe(`dork:chat:${CHAT}`);
  });

  it('cuts the chat id to 8 and omits host and turn on a public repository', () => {
    expect(jsonOf(buildProvenanceV2(ALL_FIELDS, { visibility: 'public' }))).toEqual({
      v: 2,
      harness: 'claude-code',
      surface: 'dorkos',
      account: 'work',
      agent: AGENT,
      chat: 'dork:chat:7c1e4b2a',
      space: SPACE,
      address: ADDRESS,
    });
  });

  it('treats an unknown visibility as public', () => {
    expect(buildProvenanceV2(ALL_FIELDS, { visibility: 'unknown' })).toBe(
      buildProvenanceV2(ALL_FIELDS, { visibility: 'public' })
    );
  });

  it('never writes resumeUrl, instanceId, sessionId or any other key', () => {
    const extra = {
      ...ALL_FIELDS,
      resumeUrl: 'https://example.invalid/r/x',
      instanceId: '2f9c1e6a-0000-4000-8000-abcdefabcdef',
      sessionId: CHAT,
      v: 9,
      name: 'flow:provenance',
    } as unknown as ProvenanceFields;
    const built = buildProvenanceV2(extra, { visibility: 'private' });
    expect(built).toBe(buildProvenanceV2(ALL_FIELDS, { visibility: 'private' }));
  });

  it.each<readonly [string, string]>([
    ['account', 'someone@example.com'],
    ['harness', 'claude'],
    ['surface', 'Not A Word'],
    ['chat', 'dork:chat:abc'],
    ['chat', 'a/b'],
    ['agent', '01KJXYKJYW4N8QGQ5W4GB6YM9J'],
    ['agent', SPACE],
    ['space', 'dork:space:'],
    ['turn', 'dork:turn:a b'],
    ['address', 'dork:chat/owl'],
    ['address', 'dork:admin/owl'],
    ['address', 'dork:acme/chat'],
    ...HOSTNAME_HOSTS.map((host) => ['host', host] as const),
  ])('drops a %s of %s, which would not read back or is not a valid name', (key, value) => {
    const built = buildProvenanceV2({ ...ALL_FIELDS, [key]: value }, { visibility: 'private' });
    expect(jsonOf(built)).not.toHaveProperty(key);
    // A hostname or an email never reaches the line in any field.
    if (key === 'host' || key === 'account') expect(built).not.toContain(value);
  });

  it('builds a line with only a version from no fields', () => {
    expect(buildProvenanceV2({}, { visibility: 'public' })).toBe(
      '<!-- agent:provenance {"v":2} -->'
    );
  });

  it.each(Object.keys(ALL_FIELDS) as (keyof ProvenanceFields)[])(
    'round-trips %s alone through the reader',
    (key) => {
      const fields = { [key]: ALL_FIELDS[key] } as ProvenanceFields;
      expect(
        readProvenance(`Done.\n${buildProvenanceV2(fields, { visibility: 'private' })}`)
      ).toEqual({
        name: 'agent:provenance',
        v: 2,
        ...fields,
      });
    }
  );

  it('round-trips a public line to its cut fields', () => {
    expect(readProvenance(buildProvenanceV2(ALL_FIELDS, { visibility: 'public' }))).toEqual({
      ...without(without(V2_READ, 'host'), 'turn'),
      chat: CHAT.slice(0, 8),
    });
  });

  it('rebuilds every shared vector the reader accepts into a line that reads back the same', () => {
    // Purpose: a v1 line read today can be re-signed as v2 without losing a field.
    for (const [, text, expected] of FLOW_VECTORS) {
      if (expected === null) continue;
      const { name: _name, v: _v, ...fields } = expected;
      const reread = readProvenance(buildProvenanceV2(fields, { visibility: 'private' }));
      // An address may read and still not be one DorkOS would mint.
      const writable =
        expected.address === 'dork:acme/chat' ? without(expected, 'address') : expected;
      const { name: _n, v: _w, ...writableFields } = writable;
      expect(reread, text).toEqual({ name: 'agent:provenance', v: 2, ...writableFields });
    }
  });
});
