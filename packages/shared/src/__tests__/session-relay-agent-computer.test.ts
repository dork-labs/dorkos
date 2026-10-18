import { describe, expect, it } from 'vitest';
import {
  RelayComputerFrameSchema,
  RelayRequestSchema,
  RelayWebFrameSchema,
  SESSION_RELAY_FEATURES,
  SESSION_RELAY_MAX_FRAME_LENGTH,
  SESSION_RELAY_MAX_INNER_FRAME_BYTES,
  SESSION_RELAY_MAX_MESSAGE_LENGTH,
  SESSION_RELAY_VERSIONS,
  decodeRelayFrame,
  encodeRelayFrame,
} from '../session-relay.js';
import {
  AGENT_COMPUTER_IDENTITY_FILES,
  AGENT_COMPUTER_MAX_BODY_BYTES,
  AGENT_COMPUTER_MAX_IDENTITY_FILE_BYTES,
  AGENT_COMPUTER_MAX_JSON_DEPTH,
  AGENT_COMPUTER_MAX_PACKAGES,
  AGENT_COMPUTER_MAX_TOOL_SCHEMA_BYTES,
  AGENT_COMPUTER_MAX_TOOLS,
  AGENT_COMPUTER_MAX_IDENTITY_FILES,
  AGENT_COMPUTER_MAX_MANIFEST_BYTES,
  AGENT_COMPUTER_MAX_TOOL_INPUT_BYTES,
  AGENT_COMPUTER_MAX_TOOL_OUTPUT_BYTES,
  AGENT_COMPUTER_RELAY_FEATURES,
  AgentComputerFrameSchema,
  AgentComputerRequestSchema,
  AgentComputerWebFrameSchema,
  RELAY_CALL_FEATURES,
  agentComputerManifestOf,
  RelayCallFrameSchema,
  RelayCallSchema,
  encodeAgentComputerRequestFrame,
  encodeRelayCallFrame,
  encodeRelayCallResultFrame,
  readRelayCallId,
  relayCallRefusalFrame,
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
  permissionMode: 'default',
  outsiderCapped: false,
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

  it('carries only the manifest fields an agent computer may hold', () => {
    const secrets = {
      mcpServers: [
        {
          name: 'linear',
          connection: { env: { LINEAR_API_KEY: 'lin_123' }, headers: { Authorization: 'x' } },
        },
      ],
      account: 'claude-work',
      permissions: { areas: { packages: 'allowed' } },
      workspace: { mode: 'home' },
      registeredBy: 'dorkos',
      apiKey: 'sk-123',
    };
    for (const [field, value] of Object.entries(secrets)) {
      const request = { ...SYNC, manifest: { ...SYNC.manifest, [field]: value } };
      expect(AgentComputerRequestSchema.safeParse(request).success, field).toBe(false);
    }
    const cut = agentComputerManifestOf({ ...SYNC.manifest, ...secrets });
    expect(cut).toEqual(SYNC.manifest);
    expect(AgentComputerRequestSchema.safeParse({ ...SYNC, manifest: cut }).success).toBe(true);
    expect(JSON.stringify(cut)).not.toMatch(/lin_123|sk-123|Authorization/);
  });

  it('carries exactly the identity files, by name', () => {
    expect([...AGENT_COMPUTER_IDENTITY_FILES]).toEqual([
      'SOUL.md',
      'NOPE.md',
      'MEMORY.md',
      'HEARTBEAT.md',
    ]);
    expect(AGENT_COMPUTER_MAX_IDENTITY_FILES).toBe(AGENT_COMPUTER_IDENTITY_FILES.length);
    for (const name of AGENT_COMPUTER_IDENTITY_FILES) {
      const request = { ...SYNC, files: [{ name, text: 'x' }] };
      expect(AgentComputerRequestSchema.safeParse(request).success, name).toBe(true);
    }
  });

  it.each([
    // Secrets an agent's folder can hold.
    ['.env'],
    ['.env.md'],
    ['secrets.json'],
    ['id_ed25519'],
    ['id_ed25519.pub'],
    ['pin.json'],
    ['computer-key.pem'],
    ['credentials.json'],
    ['tokens.json'],
    ['mcp-tokens.json'],
    ['oauth-tokens.json'],
    ['agent.json'],
    // Markdown that is not an identity file, and identity names bent out of shape.
    ['README.md'],
    ['AGENTS.md'],
    ['CLAUDE.md'],
    ['notes.md'],
    ['soul.md'],
    ['SOUL.MD'],
    ['../SOUL.md'],
    ['.dork/SOUL.md'],
    ['agents/SOUL.md'],
    ['memory/today.md'],
    ['SOUL.txt'],
    ['SOUL.md\u0000'],
    [''],
  ])('refuses a file named %j', (name) => {
    const request = { ...SYNC, files: [{ name, text: 'x' }] };
    expect(AgentComputerRequestSchema.safeParse(request).success).toBe(false);
  });

  it('counts an identity file in bytes, escapes included, not in characters', () => {
    // A third of the cap in characters, three bytes each in UTF-8.
    const cjk = '中'.repeat(Math.ceil(AGENT_COMPUTER_MAX_IDENTITY_FILE_BYTES / 3) + 1);
    expect(
      AgentComputerRequestSchema.safeParse({ ...SYNC, files: [{ name: 'SOUL.md', text: cjk }] })
        .success
    ).toBe(false);
    // A control character serializes to six bytes.
    const escaped = '\u0001'.repeat(Math.ceil(AGENT_COMPUTER_MAX_IDENTITY_FILE_BYTES / 6) + 1);
    expect(
      AgentComputerRequestSchema.safeParse({ ...SYNC, files: [{ name: 'SOUL.md', text: escaped }] })
        .success
    ).toBe(false);
  });

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
      files: [{ name: 'SOUL.md', text: 'x'.repeat(AGENT_COMPUTER_MAX_IDENTITY_FILE_BYTES) }],
    };
    expect(AgentComputerRequestSchema.safeParse(longFile).success).toBe(false);
    const manyFiles = {
      ...SYNC,
      files: [...AGENT_COMPUTER_IDENTITY_FILES, 'SOUL.md'].map((name) => ({ name, text: 'x' })),
    };
    expect(AgentComputerRequestSchema.safeParse(manyFiles).success).toBe(false);
    const bigManifest = {
      ...SYNC,
      manifest: { persona: 'x'.repeat(AGENT_COMPUTER_MAX_MANIFEST_BYTES) },
    };
    expect(AgentComputerRequestSchema.safeParse(bigManifest).success).toBe(false);
  });

  it('measures the manifest itself, in bytes, rather than trusting a length', () => {
    // A third of the cap in characters, but three bytes each in UTF-8.
    const chars = Math.ceil(AGENT_COMPUTER_MAX_MANIFEST_BYTES / 3) + 10;
    const wide = { ...SYNC, manifest: { persona: '€'.repeat(chars) } };
    expect(AgentComputerRequestSchema.safeParse(wide).success).toBe(false);
    const claimed = { ...SYNC, manifest: { name: 'x', persona: 'x'.repeat(100_000) } };
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

  it('carries the permission mode and the outsider cap the hub decided', () => {
    const capped = { ...TURN, permissionMode: 'plan', outsiderCapped: true };
    expect(AgentComputerRequestSchema.parse(capped)).toMatchObject({
      permissionMode: 'plan',
      outsiderCapped: true,
    });
  });

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
    ['permissionMode', 'yolo'],
    ['permissionMode', undefined],
    ['outsiderCapped', undefined],
    ['outsiderCapped', 'false'],
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

  it('measures an inner frame in UTF-8 bytes, the way sealing does', () => {
    // Fewer characters than the frame limit, but more bytes than a sealed box holds.
    const chars = Math.floor(SESSION_RELAY_MAX_INNER_FRAME_BYTES / 3) + 100;
    expect(chars).toBeLessThan(SESSION_RELAY_MAX_FRAME_LENGTH);
    const body = { text: '中'.repeat(chars) };
    expect(encodeRelayFrame({ type: 'result', id: 'r1', ok: true, body })).toBeNull();
    // What seals: a 16-byte tag, base64url, and 64 characters of sealed-frame JSON.
    const sealedLength = Math.ceil(((SESSION_RELAY_MAX_INNER_FRAME_BYTES + 16) * 4) / 3) + 64;
    expect(sealedLength).toBeLessThanOrEqual(SESSION_RELAY_MAX_FRAME_LENGTH);
  });
});

/** A string of `bytes` UTF-8 bytes once serialized (quotes included), in CJK. */
const cjkOfBytes = (bytes: number) => '中'.repeat(Math.floor((bytes - 2) / 3));

/** A JSON object of about `bytes` serialized bytes, in CJK. */
const cjkObjectOfBytes = (bytes: number) => ({ p: cjkOfBytes(bytes - 8) });

/** A manifest of about `bytes` serialized bytes, in CJK, in a field it may carry. */
const cjkManifestOfBytes = (bytes: number) => ({ persona: cjkOfBytes(bytes - 14) });

describe('the largest legal frame of each kind still seals', () => {
  /** Accepted by its schema, and so encodes within what one sealed frame carries. */
  function expectFits(encoded: { ok: boolean }, text?: string | null) {
    expect(encoded.ok).toBe(true);
    if (text !== undefined) expect(text).not.toBeNull();
  }

  it('agents.sync at every field cap at once', () => {
    const sync = {
      op: 'agents.sync',
      agentId: AGENT,
      manifest: cjkManifestOfBytes(AGENT_COMPUTER_MAX_MANIFEST_BYTES),
      files: AGENT_COMPUTER_IDENTITY_FILES.map((name) => ({
        name,
        text: cjkOfBytes(AGENT_COMPUTER_MAX_IDENTITY_FILE_BYTES),
      })),
      packages: Array.from({ length: AGENT_COMPUTER_MAX_PACKAGES }, (_, i) => ({
        name: `@${'a'.repeat(100)}/${'b'.repeat(100)}${i}`,
        version: '1'.repeat(64),
      })),
    } as unknown as AgentComputerRequest;
    expect(AgentComputerRequestSchema.safeParse(sync).success).toBe(true);
    expectFits(encodeAgentComputerRequestFrame('r'.repeat(64), sync));
  });

  it('agents.sync with an oversized manifest is refused as too large, not malformed', () => {
    const sync = {
      op: 'agents.sync',
      agentId: AGENT,
      manifest: cjkManifestOfBytes(AGENT_COMPUTER_MAX_MANIFEST_BYTES + 6000),
      files: [],
      packages: [],
    } as unknown as AgentComputerRequest;
    expect(encodeAgentComputerRequestFrame('r1', sync)).toEqual({
      ok: false,
      error: expect.objectContaining({ status: 413 }),
    });
  });

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

  it('tools.call: the largest input, and the largest output', () => {
    const call = {
      ...EVERY_CALL[1],
      input: cjkObjectOfBytes(AGENT_COMPUTER_MAX_TOOL_INPUT_BYTES),
    } as RelayCall;
    expectFits(encodeRelayCallFrame('c'.repeat(64), call));
    const output = cjkOfBytes(AGENT_COMPUTER_MAX_TOOL_OUTPUT_BYTES);
    const text = encodeRelayCallResultFrame('c'.repeat(64), 'tools.call', { ok: true, output });
    expect(decodeRelayFrame(text, AgentComputerWebFrameSchema)).toMatchObject({ ok: true });
  });

  it('tools.list: a list that fits is legal, and one that cannot is refused, never sent', () => {
    const tool = (i: number) => ({
      name: `tool_${i}`,
      description: 'd'.repeat(4_000),
      inputSchema: cjkObjectOfBytes(AGENT_COMPUTER_MAX_TOOL_SCHEMA_BYTES),
    });
    const perTool = 4_000 + AGENT_COMPUTER_MAX_TOOL_SCHEMA_BYTES + 64;
    const fits = Math.floor(AGENT_COMPUTER_MAX_BODY_BYTES / perTool);
    const legal = { tools: Array.from({ length: fits }, (_, i) => tool(i)) };
    const text = encodeRelayCallResultFrame('c1', 'tools.list', legal);
    expect(decodeRelayFrame(text, AgentComputerWebFrameSchema)).toMatchObject({ ok: true });
    // Every tool at its own cap, all of them: past one frame, so a refusal goes instead.
    const all = { tools: Array.from({ length: AGENT_COMPUTER_MAX_TOOLS }, (_, i) => tool(i)) };
    expect(parseRelayCallResult('tools.list', all)).toBeNull();
    const refused = encodeRelayCallResultFrame('c1', 'tools.list', all);
    expect(decodeRelayFrame(refused, AgentComputerWebFrameSchema)).toEqual(
      relayCallRefusalFrame('c1', expect.objectContaining({ status: 413 }))
    );
  });

  it('every body these schemas accept leaves room for its frame', () => {
    expect(AGENT_COMPUTER_MAX_BODY_BYTES).toBeLessThan(SESSION_RELAY_MAX_INNER_FRAME_BYTES);
    const maxEnvelope = JSON.stringify({
      type: 'call.result',
      id: 'c'.repeat(64),
      ok: true,
      body: null,
    }).length;
    expect(AGENT_COMPUTER_MAX_BODY_BYTES + maxEnvelope).toBeLessThanOrEqual(
      SESSION_RELAY_MAX_INNER_FRAME_BYTES
    );
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
    [
      'a manifest',
      (v: object) =>
        AgentComputerRequestSchema.safeParse({
          ...SYNC,
          manifest: { behavior: (v as { a: unknown }).a },
        }),
    ],
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
