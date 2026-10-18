import { describe, expect, it } from 'vitest';
import {
  RelayComputerFrameSchema,
  RelayRequestSchema,
  RelayWebFrameSchema,
  SESSION_RELAY_FEATURES,
  SESSION_RELAY_MAX_FRAME_LENGTH,
  SESSION_RELAY_MAX_MESSAGE_LENGTH,
  SESSION_RELAY_VERSIONS,
  decodeRelayFrame,
  encodeRelayFrame,
} from '../session-relay.js';
import {
  AGENT_COMPUTER_MAX_IDENTITY_FILE_LENGTH,
  AGENT_COMPUTER_MAX_IDENTITY_FILES,
  AGENT_COMPUTER_MAX_MANIFEST_BYTES,
  AGENT_COMPUTER_MAX_TOOL_INPUT_BYTES,
  AGENT_COMPUTER_MAX_TOOL_OUTPUT_BYTES,
  AGENT_COMPUTER_RELAY_FEATURES,
  AgentComputerFrameSchema,
  AgentComputerRequestSchema,
  AgentComputerWebFrameSchema,
  RELAY_CALL_FEATURES,
  RelayCallFrameSchema,
  RelayCallSchema,
  hubFeaturesFrameFor,
  missingAgentComputerFeature,
  missingRelayCallFeature,
  negotiatedRelayCallFeatures,
  parseAgentComputerResult,
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
  it('takes an identity copy and a removal', () => {
    for (const request of EVERY_REQUEST.slice(0, 2)) {
      expect(AgentComputerRequestSchema.safeParse(request).success).toBe(true);
    }
  });

  it.each([['../SOUL.md'], ['agents/SOUL.md'], ['SOUL.txt'], ['.env.md'], ['SOUL.md\u0000'], ['']])(
    'refuses an identity file named %j',
    (name) => {
      const request = { ...SYNC, files: [{ name, text: 'x' }] };
      expect(AgentComputerRequestSchema.safeParse(request).success).toBe(false);
    }
  );

  it('refuses one file named twice', () => {
    const request = {
      ...SYNC,
      files: [
        { name: 'SOUL.md', text: 'a' },
        { name: 'SOUL.md', text: 'b' },
      ],
    };
    expect(AgentComputerRequestSchema.safeParse(request).success).toBe(false);
  });

  it('refuses, never cuts, an identity file or a manifest past its cap', () => {
    const longFile = {
      ...SYNC,
      files: [{ name: 'SOUL.md', text: 'x'.repeat(AGENT_COMPUTER_MAX_IDENTITY_FILE_LENGTH + 1) }],
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

  it('measures the manifest itself, in bytes, rather than trusting a length', () => {
    // A third of the cap in characters, but three bytes each in UTF-8.
    const chars = Math.ceil(AGENT_COMPUTER_MAX_MANIFEST_BYTES / 3) + 10;
    const wide = { ...SYNC, manifest: { pad: '€'.repeat(chars) } };
    expect(AgentComputerRequestSchema.safeParse(wide).success).toBe(false);
    const claimed = { ...SYNC, manifest: { length: 1, pad: 'x'.repeat(100_000) } };
    expect(AgentComputerRequestSchema.safeParse(claimed).success).toBe(false);
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
});

describe('turn.start', () => {
  it('takes a turn with an origin and a tier', () => {
    expect(AgentComputerRequestSchema.safeParse(TURN).success).toBe(true);
    const { originRef: _originRef, ...bare } = TURN;
    expect(AgentComputerRequestSchema.safeParse({ ...bare, origin: 'chat' }).success).toBe(true);
  });

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

  it('names the turn in its result', () => {
    expect(parseAgentComputerResult('turn.start', { sessionId: SESSION, turnId: 't1' })).toEqual({
      sessionId: SESSION,
      turnId: 't1',
    });
    expect(parseAgentComputerResult('turn.start', { sessionId: SESSION })).toBeNull();
    expect(parseAgentComputerResult('agents.sync', { agentId: AGENT })).toEqual({ agentId: AGENT });
    expect(parseAgentComputerResult('agents.sync', { sessionId: SESSION })).toBeNull();
  });
});

describe('calls from the computer', () => {
  it('accepts one valid call of every kind', () => {
    for (const call of EVERY_CALL) {
      expect(RelayCallSchema.safeParse(call).success, JSON.stringify(call)).toBe(true);
    }
  });

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

  it('lists tools with their input schemas, bounded', () => {
    const tool = {
      name: 'memory_write',
      description: 'Save a note.',
      inputSchema: { type: 'object' },
    };
    expect(parseRelayCallResult('tools.list', { tools: [tool] })).toEqual({ tools: [tool] });
    const noSchema = { name: 'memory_write', description: 'Save a note.' };
    expect(parseRelayCallResult('tools.list', { tools: [noSchema] })).toBeNull();
    const bigSchema = { ...tool, inputSchema: jsonOfBytes(16 * 1024) };
    expect(parseRelayCallResult('tools.list', { tools: [bigSchema] })).toBeNull();
  });

  it('answers a tool call with JSON, text, or a failure', () => {
    expect(
      parseRelayCallResult('tools.call', { ok: true, output: { saved: true } })
    ).not.toBeNull();
    expect(parseRelayCallResult('tools.call', { ok: true, output: 'Saved.' })).not.toBeNull();
    const failed = { ok: false, code: 'refused', message: 'Blocked for this agent.' };
    expect(parseRelayCallResult('tools.call', failed)).toEqual(failed);
    expect(parseRelayCallResult('tools.call', { ok: false, message: 'no code' })).toBeNull();
  });

  it('refuses, never cuts, a tool output past its cap', () => {
    const output = 'x'.repeat(AGENT_COMPUTER_MAX_TOOL_OUTPUT_BYTES);
    expect(parseRelayCallResult('tools.call', { ok: true, output })).toBeNull();
  });

  it('acknowledges a status report and nothing more', () => {
    expect(parseRelayCallResult('computer.status', { ok: true })).toEqual({ ok: true });
    expect(parseRelayCallResult('computer.status', { ok: true, stop: true })).toBeNull();
  });
});

describe('features are negotiated', () => {
  it('keeps the chat features a Mac advertises apart from the agent-computer ones', () => {
    // Pinned on purpose: a new op is a new feature, chosen deliberately.
    expect(AGENT_COMPUTER_RELAY_FEATURES).toEqual([
      'agents.sync',
      'turn.start',
      'tools.list',
      'tools.call',
      'computer.status',
    ]);
    expect(RELAY_CALL_FEATURES).toEqual(['tools.list', 'tools.call', 'computer.status']);
    for (const feature of AGENT_COMPUTER_RELAY_FEATURES) {
      expect(SESSION_RELAY_FEATURES as readonly string[]).not.toContain(feature);
    }
    expect(SESSION_RELAY_VERSIONS).toEqual({ min: 1, max: 1 });
  });

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

  it('sends the hub features frame only to a computer that named a call', () => {
    expect(hubFeaturesFrameFor([...SESSION_RELAY_FEATURES], [...RELAY_CALL_FEATURES])).toBeNull();
    expect(hubFeaturesFrameFor(['agents.sync', 'turn.start'], [...RELAY_CALL_FEATURES])).toBeNull();
    expect(hubFeaturesFrameFor(['tools.call'], ['tools.call', 'tools.list'])).toEqual({
      type: 'features',
      features: ['tools.call', 'tools.list'],
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
  it('round-trip every call through the relay framing', () => {
    for (const [i, call] of EVERY_CALL.entries()) {
      const frame = { type: 'call', id: `c${i}`, call } as const;
      const text = encodeRelayFrame(frame);
      expect(text, JSON.stringify(frame)).not.toBeNull();
      expect(decodeRelayFrame(text!, AgentComputerFrameSchema)).toEqual(frame);
      expect(decodeRelayFrame(text!, RelayCallFrameSchema)).toEqual(frame);
    }
  });

  it('still carries every frame a Mac sends, under the agent-computer schema', () => {
    const frames = [
      { type: 'result', id: 'r1', ok: true, body: { sessionId: SESSION } },
      { type: 'stream.end', streamId: 's1' },
      { type: 'heartbeat' },
    ];
    for (const frame of frames) {
      expect(decodeRelayFrame(encodeRelayFrame(frame as never)!, AgentComputerFrameSchema)).toEqual(
        frame
      );
    }
  });

  it('round-trip every hub-to-computer frame', () => {
    const error = { status: 501, code: 'needs_update', message: 'Not yet.', feature: 'tools.list' };
    const frames = [
      ...EVERY_REQUEST.map((request, i) => ({ type: 'request', id: `r${i}`, request })),
      { type: 'request', id: 'r9', request: { op: 'chats.list', agentId: AGENT } },
      { type: 'features', features: ['tools.call'] },
      { type: 'call.result', id: 'c1', ok: true, body: { ok: true } },
      { type: 'call.result', id: 'c1', ok: false, error },
      { type: 'viewers', count: 1 },
      { type: 'heartbeat' },
    ];
    for (const frame of frames) {
      const text = encodeRelayFrame(frame as never);
      expect(text, JSON.stringify(frame)).not.toBeNull();
      expect(decodeRelayFrame(text!, AgentComputerWebFrameSchema)).toEqual(frame);
    }
  });

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

  it('will not encode a call the hub would drop for its size', () => {
    const call = {
      ...EVERY_CALL[1],
      input: 'x'.repeat(SESSION_RELAY_MAX_FRAME_LENGTH),
    } as RelayCall;
    expect(encodeRelayFrame({ type: 'call', id: 'c1', call })).toBeNull();
  });
});
