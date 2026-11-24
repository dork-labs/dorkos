import { describe, expect, it } from 'vitest';
import {
  RelayComputerFrameSchema,
  RelayRequestSchema,
  RelayWebFrameSchema,
  SESSION_RELAY_FEATURES,
  SESSION_RELAY_MAX_MESSAGE_LENGTH,
  decodeRelayFrame,
  encodeRelayFrame,
} from '../session-relay.js';
import {
  AGENT_COMPUTER_MAX_IDENTITY_FILE_BYTES,
  AGENT_COMPUTER_MAX_JSON_DEPTH,
  AGENT_COMPUTER_MAX_IDENTITY_FILES,
  AGENT_COMPUTER_MAX_MANIFEST_BYTES,
  AGENT_COMPUTER_MAX_TOOL_INPUT_BYTES,
  AGENT_COMPUTER_MAX_TOOL_OUTPUT_BYTES,
  AgentComputerFrameSchema,
  AgentComputerRequestSchema,
  AgentComputerWebFrameSchema,
  RELAY_CALL_FEATURES,
  RelayCallSchema,
  encodeAgentComputerRequestFrame,
  encodeRelayCallFrame,
  encodeRelayCallResultFrame,
  readRelayCallId,
  relayCallRefusalFrame,
  missingAgentComputerFeature,
  missingRelayCallFeature,
  negotiatedRelayCallFeatures,
  parseRelayCallResult,
  relayCallFeatureRefusal,
  type AgentComputerRequest,
  type RelayCall,
} from '../session-relay-agent-computer.js';

const SESSION = '3f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c';
const AGENT = '01KJXYKJYW4N8QGQ5W4GB6YM9J';

const SYNC = {
  op: 'agents.sync',
  agentId: AGENT,
  manifest: { name: 'Scout', runtime: 'opencode', capabilities: ['research'] },
  files: [
    { name: 'SOUL.md', text: '# Scout\nCurious and careful.' },
    { name: 'NOPE.md', text: 'Never push to main.' },
  ],
  packages: [{ name: '@dork-labs/flow', version: '1.4.0' }],
} as const;

const TURN = {
  op: 'turn.start',
  agentId: AGENT,
  sessionId: SESSION,
  content: 'Summarise the overnight runs.',
  origin: 'beat',
  originRef: 'beat:01KJXYKJYW',
  tier: 'owner',
} as const;

/** One valid hub-to-computer request of every kind. */
const EVERY_REQUEST: AgentComputerRequest[] = [
  SYNC as unknown as AgentComputerRequest,
  { op: 'agents.sync', agentId: AGENT, remove: true },
  TURN,
];

/** One valid call of every kind. */
const EVERY_CALL: RelayCall[] = [
  { op: 'tools.list', agentId: AGENT, sessionId: SESSION },
  {
    op: 'tools.call',
    agentId: AGENT,
    sessionId: SESSION,
    tool: 'memory_write',
    input: { action: 'add', text: 'Dorian prefers short reports.' },
  },
  { op: 'computer.status', busy: true, turns: [{ agentId: AGENT, sessionId: SESSION }] },
  { op: 'computer.status', busy: false, turns: [] },
];

/** A JSON object whose serialization is at least `bytes` UTF-8 bytes. */
const jsonOfBytes = (bytes: number) => ({ pad: 'x'.repeat(bytes) });

describe('agents.sync', () => {
  it.each([['../SOUL.md'], ['agents/SOUL.md'], ['SOUL.txt'], ['.env.md'], ['SOUL.md\u0000'], ['']])(
    'refuses an identity file named %j',
    (name) => {
      const request = { ...SYNC, files: [{ name, text: 'x' }] };
      expect(AgentComputerRequestSchema.safeParse(request).success).toBe(false);
    }
  );

  it('refuses one file named twice, whatever its case', () => {
    const request = {
      ...SYNC,
      files: [
        { name: 'SOUL.md', text: 'a' },
        { name: 'soul.md', text: 'b' },
      ],
    };
    expect(AgentComputerRequestSchema.safeParse(request).success).toBe(false);
  });

  it('refuses, never cuts, an identity file or a manifest past its cap', () => {
    const longFile = {
      ...SYNC,
      files: [{ name: 'SOUL.md', text: 'x'.repeat(AGENT_COMPUTER_MAX_IDENTITY_FILE_BYTES) }],
    };
    expect(AgentComputerRequestSchema.safeParse(longFile).success).toBe(false);
    const manyFiles = {
      ...SYNC,
      files: Array.from({ length: AGENT_COMPUTER_MAX_IDENTITY_FILES + 1 }, (_, i) => ({
        name: `F${i}.md`,
        text: 'x',
      })),
    };
    expect(AgentComputerRequestSchema.safeParse(manyFiles).success).toBe(false);
    const bigManifest = { ...SYNC, manifest: jsonOfBytes(AGENT_COMPUTER_MAX_MANIFEST_BYTES) };
    expect(AgentComputerRequestSchema.safeParse(bigManifest).success).toBe(false);
  });

  it('refuses a manifest that is not a plain JSON object', () => {
    for (const manifest of [[], 'agent.json', null, { __proto__: { x: 1 }, constructor: 1 }]) {
      const request = { ...SYNC, manifest };
      expect(AgentComputerRequestSchema.safeParse(request).success, String(manifest)).toBe(false);
    }
  });

  it.each([
    ['name', '../evil'],
    ['name', 'Has Spaces'],
    ['version', '1.0.0; rm -rf /'],
    ['version', ''],
  ])('refuses a package whose %s is %j', (field, value) => {
    const pkg = { name: '@dork-labs/flow', version: '1.4.0', [field]: value };
    expect(AgentComputerRequestSchema.safeParse({ ...SYNC, packages: [pkg] }).success).toBe(false);
  });

  it('refuses a removal that also carries a copy, or a field it does not name', () => {
    const both = { ...SYNC, remove: true };
    expect(AgentComputerRequestSchema.safeParse(both).success).toBe(false);
    const extra = { ...SYNC, cwd: '/Users/someone' };
    expect(AgentComputerRequestSchema.safeParse(extra).success).toBe(false);
    const notTrue = { op: 'agents.sync', agentId: AGENT, remove: false };
    expect(AgentComputerRequestSchema.safeParse(notTrue).success).toBe(false);
  });

  it('takes an identity copy and a removal', () => {
    for (const request of EVERY_REQUEST.slice(0, 2)) {
      expect(AgentComputerRequestSchema.safeParse(request).success).toBe(true);
    }
  });
});

describe('turn.start', () => {
  it.each(['room', 'task', 'beat'])(
    'refuses a %s turn that does not say where it came from',
    (origin) => {
      const { originRef: _originRef, ...bare } = TURN;
      expect(AgentComputerRequestSchema.safeParse({ ...bare, origin }).success).toBe(false);
    }
  );

  it.each([
    ['origin', 'webhook'],
    ['tier', 'full'],
    ['tier', undefined],
    ['content', ''],
    ['content', 'x'.repeat(SESSION_RELAY_MAX_MESSAGE_LENGTH + 1)],
    ['sessionId', '../x'],
    ['agentId', AGENT.toLowerCase()],
    ['originRef', 'room/../../etc'],
    ['permissionMode', 'bypassPermissions'],
  ])('refuses a turn whose %s is %j', (field, value) => {
    expect(AgentComputerRequestSchema.safeParse({ ...TURN, [field]: value }).success).toBe(false);
  });
});

describe('calls from the computer', () => {
  it('refuses a call outside the three it knows', () => {
    for (const op of ['config.patch', 'agents.sync', 'turn.start', 'session.send']) {
      expect(RelayCallSchema.safeParse({ op, agentId: AGENT, sessionId: SESSION }).success).toBe(
        false
      );
    }
  });

  it('refuses, never cuts, a tool input past its cap', () => {
    const call = { ...EVERY_CALL[1], input: jsonOfBytes(AGENT_COMPUTER_MAX_TOOL_INPUT_BYTES) };
    expect(RelayCallSchema.safeParse(call).success).toBe(false);
  });

  it.each(['../../bin/sh', 'a b', '', 'x'.repeat(129)])('refuses a tool named %j', (tool) => {
    expect(RelayCallSchema.safeParse({ ...EVERY_CALL[1], tool }).success).toBe(false);
  });

  it('refuses a tool call that claims its own tier or a person', () => {
    for (const claim of [{ tier: 'owner' }, { userId: 'u1' }, { local: true }]) {
      expect(RelayCallSchema.safeParse({ ...EVERY_CALL[1], ...claim }).success).toBe(false);
    }
  });

  it('refuses an idle computer that reports turns', () => {
    const call = {
      op: 'computer.status',
      busy: false,
      turns: [{ agentId: AGENT, sessionId: SESSION }],
    };
    expect(RelayCallSchema.safeParse(call).success).toBe(false);
  });

  it('refuses, never cuts, a tool output past its cap', () => {
    const output = 'x'.repeat(AGENT_COMPUTER_MAX_TOOL_OUTPUT_BYTES);
    expect(parseRelayCallResult('tools.call', { ok: true, output })).toBeNull();
  });
});

describe('features are negotiated', () => {
  it('refuses a hub-to-computer request the computer did not advertise', () => {
    expect(missingAgentComputerFeature([...SESSION_RELAY_FEATURES], TURN)).toBe('turn.start');
    expect(missingAgentComputerFeature(['turn.start'], EVERY_REQUEST[0])).toBe('agents.sync');
    expect(missingAgentComputerFeature(['agents.sync', 'turn.start'], TURN)).toBeNull();
  });

  it('allows a call only when both sides advertised it', () => {
    const negotiated = negotiatedRelayCallFeatures(
      ['tools.list', 'tools.call', 'session.fork'],
      ['tools.call', 'computer.status']
    );
    expect(negotiated).toEqual(['tools.call']);
    expect(missingRelayCallFeature(negotiated, EVERY_CALL[1])).toBeNull();
    expect(missingRelayCallFeature(negotiated, EVERY_CALL[0])).toBe('tools.list');
    expect(missingRelayCallFeature(negotiated, EVERY_CALL[2])).toBe('computer.status');
    // Before the hub's features frame arrives, the computer may ask nothing.
    expect(negotiatedRelayCallFeatures([...RELAY_CALL_FEATURES], [])).toEqual([]);
  });

  it('refuses an unnegotiated call naming the feature, so a newer computer can say why', () => {
    expect(relayCallFeatureRefusal(['tools.call'], EVERY_CALL[1])).toBeNull();
    expect(relayCallFeatureRefusal(['tools.call'], EVERY_CALL[0])).toEqual({
      status: 501,
      code: 'needs_update',
      message: expect.any(String),
      feature: 'tools.list',
    });
  });

  it('never lets a Mac parse an agent-computer frame, so it keeps today’s behaviour', () => {
    for (const request of EVERY_REQUEST) {
      expect(RelayRequestSchema.safeParse(request).success, request.op).toBe(false);
      const text = encodeRelayFrame({ type: 'request', id: 'r1', request });
      expect(decodeRelayFrame(text!, RelayWebFrameSchema)).toBeNull();
    }
    const features = encodeRelayFrame({ type: 'features', features: ['tools.call'] });
    expect(decodeRelayFrame(features!, RelayWebFrameSchema)).toBeNull();
    const call = encodeRelayFrame({ type: 'call', id: 'c1', call: EVERY_CALL[0] });
    expect(decodeRelayFrame(call!, RelayComputerFrameSchema)).toBeNull();
  });
});

describe('call frames', () => {
  it('refuses a call result that is half answer and half error', () => {
    const torn = {
      type: 'call.result',
      id: 'c1',
      ok: true,
      error: { status: 500, code: 'internal', message: 'x' },
    };
    expect(decodeRelayFrame(JSON.stringify(torn), AgentComputerWebFrameSchema)).toBeNull();
    const badId = { type: 'call', id: '../c1', call: EVERY_CALL[0] };
    expect(decodeRelayFrame(JSON.stringify(badId), AgentComputerFrameSchema)).toBeNull();
  });
});

describe('the largest legal frame of each kind still seals', () => {
  /** Accepted by its schema, and so encodes within what one sealed frame carries. */
  function expectFits(encoded: { ok: boolean }, text?: string | null) {
    expect(encoded.ok).toBe(true);
    if (text !== undefined) expect(text).not.toBeNull();
  }

  it('turn.start: the longest message fits, or is refused before it is sent', () => {
    const wide = { ...TURN, content: '中'.repeat(SESSION_RELAY_MAX_MESSAGE_LENGTH) };
    expectFits(encodeAgentComputerRequestFrame('r'.repeat(64), wide));
    // Two hundred thousand control characters serialize to 1.2 MB.
    const escaped = { ...TURN, content: '\u0001'.repeat(SESSION_RELAY_MAX_MESSAGE_LENGTH) };
    expect(AgentComputerRequestSchema.safeParse(escaped).success).toBe(false);
    expect(encodeAgentComputerRequestFrame('r1', escaped)).toEqual({
      ok: false,
      error: expect.objectContaining({ status: 413 }),
    });
  });
});

describe('one bad call never drops the link', () => {
  it('fails an oversized tool input on the computer, before anything is sent', () => {
    const call = { ...EVERY_CALL[1], input: { pad: 'x'.repeat(300 * 1024) } } as RelayCall;
    // It would encode: the frame is not the problem, the hub's schema is.
    expect(encodeRelayFrame({ type: 'call', id: 'c1', call })).not.toBeNull();
    expect(encodeRelayCallFrame('c1', call)).toEqual({
      ok: false,
      error: expect.objectContaining({ status: 413, code: 'invalid' }),
    });
    expect(encodeRelayCallFrame('c1', EVERY_CALL[1])).toMatchObject({ ok: true });
  });

  it('refuses a malformed call as malformed, not as too large', () => {
    const call = { ...EVERY_CALL[1], tool: '../sh' } as RelayCall;
    expect(encodeRelayCallFrame('c1', call)).toEqual({
      ok: false,
      error: expect.objectContaining({ status: 400 }),
    });
  });

  it('lets the hub answer a call it cannot decode, by its id', () => {
    const oversized = JSON.stringify({
      type: 'call',
      id: 'c7',
      call: { ...EVERY_CALL[1], input: { pad: 'x'.repeat(300 * 1024) } },
    });
    expect(decodeRelayFrame(oversized, AgentComputerFrameSchema)).toBeNull();
    expect(readRelayCallId(oversized)).toBe('c7');
    expect(readRelayCallId(JSON.stringify({ type: 'call', id: 'c8', call: { op: 'nope' } }))).toBe(
      'c8'
    );
    // Anything that is not a call, or has no usable id, still closes the connection.
    expect(readRelayCallId(JSON.stringify({ type: 'result', id: 'r1' }))).toBeNull();
    expect(readRelayCallId(JSON.stringify({ type: 'call', id: '../c1' }))).toBeNull();
    expect(readRelayCallId('not json')).toBeNull();
  });

  it('answers a hub-side answer of the wrong shape with a refusal for the same call', () => {
    const text = encodeRelayCallResultFrame('c1', 'computer.status', { ok: false });
    expect(decodeRelayFrame(text, AgentComputerWebFrameSchema)).toEqual(
      relayCallRefusalFrame('c1', expect.objectContaining({ status: 500, code: 'internal' }))
    );
  });
});

describe('opaque JSON has a depth limit', () => {
  /** An object nested `depth` levels below the top. */
  const nested = (depth: number) => {
    let value: Record<string, unknown> = {};
    for (let i = 0; i < depth; i++) value = { a: value };
    return value;
  };

  it.each([
    ['a tool input', (v: object) => RelayCallSchema.safeParse({ ...EVERY_CALL[1], input: v })],
    ['a manifest', (v: object) => AgentComputerRequestSchema.safeParse({ ...SYNC, manifest: v })],
    [
      'a tool output',
      (v: object) => ({
        success: parseRelayCallResult('tools.call', { ok: true, output: v }) !== null,
      }),
    ],
    [
      'an input schema',
      (v: object) => ({
        success:
          parseRelayCallResult('tools.list', {
            tools: [{ name: 't', description: '', inputSchema: v }],
          }) !== null,
      }),
    ],
  ])('takes %s at the limit and refuses one level deeper', (_label, parse) => {
    expect(parse(nested(AGENT_COMPUTER_MAX_JSON_DEPTH)).success).toBe(true);
    expect(parse(nested(AGENT_COMPUTER_MAX_JSON_DEPTH + 1)).success).toBe(false);
  });
});
