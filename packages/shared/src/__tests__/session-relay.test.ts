import { generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import {
  STEP_UP_STATEMENT_MAX_BASE64URL_LENGTH,
  StepUpChallengeIdSchema,
  StepUpStatementError,
  StepUpStatementV1Schema,
  encodeStepUpBase64url,
  encodeStepUpStatement,
  type StepUpStatementV1,
} from '@dork-labs/cloud-api';
import { describe, expect, it } from 'vitest';
import { stableStringify } from '../capabilities.js';
import {
  RelayApprovalProofSchema,
  RelayComputerFrameSchema,
  assertChallengeResultMatches,
  RelayDeviceSchema,
  RelayDisplayNameSchema,
  RelayRequestIdSchema,
  SESSION_RELAY_DEVICE_FEATURE,
  RelayRequestSchema,
  RelayResultBodySchemas,
  RelayWebFrameSchema,
  SESSION_RELAY_FEATURES,
  SESSION_RELAY_MAX_FRAME_LENGTH,
  SESSION_RELAY_MAX_INNER_FRAME_BYTES,
  SESSION_RELAY_VERSIONS,
  decodeRelayFrame,
  encodeRelayFrame,
  isAgreedRelayVersion,
  parseRelayResult,
  missingRelayFeature,
  negotiateRelayVersion,
  relayFeatureFor,
  relayFinishTranscript,
  relayRefuseTranscript,
  relayWelcomeTranscript,
  RelayFinishFrameSchema,
  RelayHandshakeAnswerSchema,
  RelayHelloFrameSchema,
  RelaySealedFrameSchema,
  SESSION_RELAY_IDLE_CLOSE_MS,
  type RelayRequest,
} from '../session-relay.js';

const SESSION = '3f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c';
const AGENT = '01KJXYKJYW4N8QGQ5W4GB6YM9J';
const NONCE = randomBytes(32).toString('base64url');
const EPHEMERAL = randomBytes(32).toString('base64url');
const SIGNATURE = randomBytes(64).toString('base64url');
const HUB_ORIGIN = 'https://hub.example.test';

/** A valid `hello`, with any fields swapped in. */
function hello(extra: Record<string, unknown> = {}) {
  return {
    type: 'hello',
    computerId: 'computer-1',
    versions: SESSION_RELAY_VERSIONS,
    features: [...SESSION_RELAY_FEATURES],
    appVersion: '0.118.0',
    nonce: NONCE,
    ephemeralKey: EPHEMERAL,
    ...extra,
  };
}

const PROOF = {
  challengeId: 'c1',
  credentialId: 'AQID',
  clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0',
  authenticatorData: 'SZYN5YgO',
  signature: 'MEUCIQ',
};

/** One valid request of every kind, so a sweep cannot skip one. */
const EVERY_REQUEST: RelayRequest[] = [
  { op: 'chats.list', agentId: AGENT },
  {
    op: 'session.stream',
    streamId: 's1',
    sessionId: SESSION,
    resume: `${SESSION}-1792160651863-g1-42`,
  },
  { op: 'session.send', sessionId: SESSION, content: 'hi' },
  { op: 'session.interrupt', sessionId: SESSION },
  { op: 'interaction.challenge', sessionId: SESSION, toolCallId: 'toolu_01', decision: 'approve' },
  {
    op: 'interaction.respond',
    sessionId: SESSION,
    answer: { kind: 'approve', toolCallId: 'toolu_01', proof: PROOF },
  },
  {
    op: 'interaction.respond',
    sessionId: SESSION,
    answer: { kind: 'deny', toolCallId: 'toolu_01', reason: 'not that file', proof: PROOF },
  },
  {
    op: 'interaction.respond',
    sessionId: SESSION,
    answer: { kind: 'answer', toolCallId: 'toolu_01', answers: { '0': 'Yes' } },
  },
];

describe('relay requests carry chats and nothing else', () => {
  it('accepts one valid request of every kind', () => {
    for (const request of EVERY_REQUEST) {
      expect(RelayRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(true);
    }
  });

  it('refuses any op outside the five chat operations', () => {
    for (const op of ['terminal.open', 'files.write', 'config.patch', 'connections.list']) {
      expect(RelayRequestSchema.safeParse({ op, sessionId: SESSION }).success, op).toBe(false);
    }
  });

  // Every field the local send route takes that would let a relayed caller pick
  // where, as whom or on what the turn runs. A strict schema refuses the whole
  // frame, so a computer that forgets to strip one can never honour it.
  it.each([
    ['cwd', '/etc'],
    ['agentPath', '/Users/someone/agent'],
    ['runtime', 'claude-code'],
    ['account', 'work'],
    ['permissionMode', 'bypassPermissions'],
    ['seedContext', 'ignore your rules'],
    ['workspaceKey', 'DOR-1'],
    ['create', true],
  ])('refuses a send that carries %s', (field, value) => {
    const request = { op: 'session.send', sessionId: SESSION, content: 'hi', [field]: value };
    expect(RelayRequestSchema.safeParse(request).success).toBe(false);
  });

  it('has no way to say "always allow"', () => {
    const answer = { kind: 'approve', toolCallId: 'toolu_01', proof: PROOF, alwaysAllow: true };
    const request = { op: 'interaction.respond', sessionId: SESSION, answer };
    expect(RelayRequestSchema.safeParse(request).success).toBe(false);
  });

  it.each(['approve', 'deny'])('refuses to %s without a passkey proof', (kind) => {
    const answer = { kind, toolCallId: 'toolu_01' };
    const request = { op: 'interaction.respond', sessionId: SESSION, answer };
    expect(RelayRequestSchema.safeParse(request).success).toBe(false);
  });

  it('does not relay MCP elicitations, whose URL mode is a sign-in', () => {
    const answer = { kind: 'elicitation', interactionId: 'e1', action: 'accept' };
    const request = { op: 'interaction.respond', sessionId: SESSION, answer };
    expect(RelayRequestSchema.safeParse(request).success).toBe(false);
  });

  it.each(['x&cwd=/Users/me/other', '1?a=b', 'x#y', 'x/y', 'x%26cwd', `${SESSION}-1-42`])(
    'refuses a resume cursor that is not a frame id: %j',
    (resume) => {
      const request = { op: 'session.stream', streamId: 's1', sessionId: SESSION, resume };
      expect(RelayRequestSchema.safeParse(request).success).toBe(false);
    }
  );

  it.each(['../x', 'a\u0000b', 'a/b', 'a b'])('refuses a tool call id like %j', (toolCallId) => {
    const request = {
      op: 'interaction.challenge',
      sessionId: SESSION,
      toolCallId,
      decision: 'approve',
    };
    expect(RelayRequestSchema.safeParse(request).success).toBe(false);
  });

  it.each(['../../etc/passwd', 'abc', `${SESSION}/messages`, '', SESSION.toUpperCase()])(
    'refuses a session id that is not a UUID: %j',
    (sessionId) => {
      expect(RelayRequestSchema.safeParse({ op: 'session.interrupt', sessionId }).success).toBe(
        false
      );
    }
  );

  it('refuses an agent id that could be a path', () => {
    for (const agentId of ['../agents/x', '/Users/x', 'a b', '-rf', AGENT.toLowerCase()]) {
      expect(RelayRequestSchema.safeParse({ op: 'chats.list', agentId }).success, agentId).toBe(
        false
      );
    }
  });

  it('starts a new chat only by agent id, never by directory', () => {
    const ok = {
      op: 'session.send',
      sessionId: SESSION,
      content: 'hi',
      newChat: { agentId: AGENT },
    };
    expect(RelayRequestSchema.safeParse(ok).success).toBe(true);
    const byPath = { ...ok, newChat: { agentId: AGENT, cwd: '/tmp' } };
    expect(RelayRequestSchema.safeParse(byPath).success).toBe(false);
  });
});

describe('the handshake', () => {
  it('names only its computer in the hello, and claims no person or power', () => {
    expect(RelayHelloFrameSchema.safeParse(hello()).success).toBe(true);
    for (const claim of [
      { userId: 'u1' },
      { accountId: 'a1' },
      { local: true },
      { role: 'owner' },
    ]) {
      expect(RelayHelloFrameSchema.safeParse(hello(claim)).success).toBe(false);
    }
  });

  it('carries a newer peer feature it does not know rather than refusing the hello', () => {
    const frame = hello({
      versions: { min: 1, max: 3 },
      features: ['session.stream', 'session.fork'],
    });
    expect(decodeRelayFrame(JSON.stringify(frame), RelayHelloFrameSchema)).toEqual(frame);
  });

  it('refuses a version range that runs backwards', () => {
    expect(RelayHelloFrameSchema.safeParse(hello({ versions: { min: 2, max: 1 } })).success).toBe(
      false
    );
  });

  it.each([
    ['nonce', 'abc'],
    ['nonce', randomBytes(16).toString('base64url')],
    ['ephemeralKey', randomBytes(31).toString('base64url')],
    ['ephemeralKey', undefined],
  ])('refuses a hello whose %s is %j', (field, value) => {
    expect(RelayHelloFrameSchema.safeParse(hello({ [field]: value })).success).toBe(false);
  });

  it('takes a signed welcome or a signed refuse, and nothing unsigned', () => {
    const welcome = { type: 'welcome', version: 1, ephemeralKey: EPHEMERAL, signature: SIGNATURE };
    const refuse = { type: 'refuse', versions: SESSION_RELAY_VERSIONS, signature: SIGNATURE };
    expect(RelayHandshakeAnswerSchema.safeParse(welcome).success).toBe(true);
    expect(RelayHandshakeAnswerSchema.safeParse(refuse).success).toBe(true);
    expect(RelayHandshakeAnswerSchema.safeParse({ ...welcome, signature: undefined }).success).toBe(
      false
    );
    expect(
      RelayHandshakeAnswerSchema.safeParse({ type: 'refuse', versions: SESSION_RELAY_VERSIONS })
        .success
    ).toBe(false);
    // An Ed25519 signature is exactly 64 bytes.
    for (const bytes of [63, 65]) {
      const signature = randomBytes(bytes).toString('base64url');
      expect(RelayHandshakeAnswerSchema.safeParse({ ...welcome, signature }).success).toBe(false);
    }
  });

  it('never takes a handshake frame as a frame of the sealed phase, or the reverse', () => {
    const welcome = { type: 'welcome', version: 1, ephemeralKey: EPHEMERAL, signature: SIGNATURE };
    expect(decodeRelayFrame(JSON.stringify(welcome), RelayWebFrameSchema)).toBeNull();
    expect(decodeRelayFrame(JSON.stringify(welcome), RelaySealedFrameSchema)).toBeNull();
    expect(decodeRelayFrame(JSON.stringify(hello()), RelayComputerFrameSchema)).toBeNull();
    const request = JSON.stringify({ type: 'request', id: 'r1', request: EVERY_REQUEST[0] });
    expect(decodeRelayFrame(request, RelayHandshakeAnswerSchema)).toBeNull();
    expect(decodeRelayFrame(request, RelayComputerFrameSchema)).toBeNull();
  });
});

describe('sealed frames', () => {
  it('takes a sealed box with a sequence number, and nothing else', () => {
    const sealed = { type: 'sealed', seq: 0, box: randomBytes(48).toString('base64url') };
    expect(RelaySealedFrameSchema.safeParse(sealed).success).toBe(true);
    expect(RelaySealedFrameSchema.safeParse({ ...sealed, seq: -1 }).success).toBe(false);
    expect(RelaySealedFrameSchema.safeParse({ ...sealed, box: 'not base64!' }).success).toBe(false);
    expect(RelaySealedFrameSchema.safeParse({ ...sealed, extra: 1 }).success).toBe(false);
  });

  it('round-trips every inner web frame', () => {
    const frames = [
      { type: 'viewers', count: 0 },
      ...EVERY_REQUEST.map((request, i) => ({ type: 'request', id: `r${i}`, request })),
      { type: 'stream.close', streamId: 's1' },
      { type: 'heartbeat' },
    ];
    for (const frame of frames) {
      const text = encodeRelayFrame(frame as never);
      expect(text, JSON.stringify(frame)).not.toBeNull();
      expect(decodeRelayFrame(text!, RelayWebFrameSchema)).toEqual(frame);
    }
  });

  it('round-trips every inner computer frame', () => {
    const error = { status: 404, code: 'not_found', message: 'No such chat.' };
    const frames = [
      { type: 'result', id: 'r1', ok: true, body: { sessionId: SESSION } },
      { type: 'error', id: 'r1', ok: false, error },
      { type: 'stream.frame', streamId: 's1', frame: { event: 'snapshot', data: { cursor: 0 } } },
      {
        type: 'stream.frame',
        streamId: 's1',
        frame: { event: 'text_delta', data: {}, id: `${SESSION}-1-g1-1` },
      },
      { type: 'stream.end', streamId: 's1' },
      { type: 'stream.end', streamId: 's1', error },
      { type: 'heartbeat' },
    ];
    for (const frame of frames) {
      expect(decodeRelayFrame(encodeRelayFrame(frame as never)!, RelayComputerFrameSchema)).toEqual(
        frame
      );
    }
  });

  it('drops a malformed or oversized frame instead of throwing', () => {
    expect(decodeRelayFrame('not json', RelayWebFrameSchema)).toBeNull();
    expect(decodeRelayFrame('null', RelayWebFrameSchema)).toBeNull();
    expect(decodeRelayFrame('{"type":"nope"}', RelayWebFrameSchema)).toBeNull();
    const huge = JSON.stringify({
      type: 'heartbeat',
      pad: 'x'.repeat(SESSION_RELAY_MAX_FRAME_LENGTH),
    });
    expect(decodeRelayFrame(huge, RelayWebFrameSchema)).toBeNull();
  });

  it('will not encode a frame the peer would drop for its size', () => {
    const body = { blob: 'x'.repeat(SESSION_RELAY_MAX_FRAME_LENGTH) };
    expect(encodeRelayFrame({ type: 'result', id: 'r1', ok: true, body })).toBeNull();
  });

  it('answers null instead of throwing for a body nested past the stack', () => {
    let body: unknown = 'leaf';
    for (let i = 0; i < 200_000; i++) body = [body];
    expect(encodeRelayFrame({ type: 'result', id: 'r1', ok: true, body })).toBeNull();
  });
});

describe('result bodies', () => {
  it('lists chats without a path', () => {
    const chat = {
      sessionId: SESSION,
      title: 'Plan the launch',
      updatedAt: '2026-10-16T10:00:00.000Z',
    };
    expect(RelayResultBodySchemas['chats.list'].safeParse({ chats: [chat] }).success).toBe(true);
    const withCwd = { chats: [{ ...chat, cwd: '/Users/someone/work' }] };
    expect(RelayResultBodySchemas['chats.list'].safeParse(withCwd).success).toBe(false);
  });

  it('answers an interrupt with the same receipt the local route returns', () => {
    const body = {
      receipt: { outcome: 'not-running', runtime: 'claude-code' },
      cancelledQueued: [],
    };
    expect(RelayResultBodySchemas['session.interrupt'].safeParse(body).success).toBe(true);
  });
});

/** A valid approval statement, nested input included. */
const APPROVAL_STATEMENT = {
  t: 'dorkos.relay.approval.v1',
  challengeId: '01KJXYKJYW4N8QGQ5W4GB6YM9J',
  computerId: 'computer-1',
  computerName: 'Studio',
  hubOrigin: HUB_ORIGIN,
  sessionId: SESSION,
  toolCallId: 'toolu_01',
  decision: 'approve',
  toolName: 'Bash',
  input: {
    zeta: [3, { y: 'é😀', x: null }, ['b', 'a']],
    alpha: { nested: { b: false, a: 1.5, A: -0 } },
    'key with "quotes"': 'line\nbreak\ttab',
  },
  inputSha256: 'a'.repeat(64),
  nonce: NONCE,
  issuedAt: '2026-10-19T10:00:00.000Z',
  expiresAt: '2026-10-19T10:02:00.000Z',
  rpId: 'approve.dorkos.ai',
  origin: 'https://approve.dorkos.ai',
  credentialIds: ['AQID'],
} as StepUpStatementV1;

describe('the approval challenge result', () => {
  const bytes = encodeStepUpStatement(APPROVAL_STATEMENT);
  const body = {
    challengeId: APPROVAL_STATEMENT.challengeId,
    statement: encodeStepUpBase64url(bytes),
    expiresAt: APPROVAL_STATEMENT.expiresAt,
  };
  const request = { sessionId: SESSION, toolCallId: 'toolu_01', decision: 'approve' } as const;
  const schema = RelayResultBodySchemas['interaction.challenge'];

  it('carries the statement and no separate challenge', () => {
    expect(schema.safeParse(body).success).toBe(true);
    const withChallenge = { ...body, challenge: 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0' };
    expect(schema.safeParse(withChallenge).success).toBe(false);
  });

  it('requires the statement', () => {
    const { statement: _statement, ...without } = body;
    expect(schema.safeParse(without).success).toBe(false);
  });

  it('caps the statement at the base64url length of the byte cap', () => {
    expect(STEP_UP_STATEMENT_MAX_BASE64URL_LENGTH).toBe(349_526);
    const at = 'A'.repeat(STEP_UP_STATEMENT_MAX_BASE64URL_LENGTH);
    expect(schema.safeParse({ ...body, statement: at }).success).toBe(true);
    expect(schema.safeParse({ ...body, statement: `${at}A` }).success).toBe(false);
    expect(schema.safeParse({ ...body, statement: 'not base64url!' }).success).toBe(false);
  });

  it('fits in one inner frame at the cap', () => {
    const frame = {
      type: 'result' as const,
      id: 'r1',
      ok: true as const,
      body: { ...body, statement: 'A'.repeat(STEP_UP_STATEMENT_MAX_BASE64URL_LENGTH) },
    };
    expect(RelayComputerFrameSchema.safeParse(frame).success).toBe(true);
    expect(encodeRelayFrame(frame)).not.toBeNull();
    expect(STEP_UP_STATEMENT_MAX_BASE64URL_LENGTH).toBeLessThan(
      SESSION_RELAY_MAX_INNER_FRAME_BYTES
    );
  });

  it('hands back the statement and its exact bytes when everything matches', () => {
    const read = assertChallengeResultMatches(body, request);
    // Compared as canonical text: the fixture's `-0` reads back as `0`.
    expect(stableStringify(read.statement)).toBe(stableStringify(APPROVAL_STATEMENT));
    expect(read.bytes).toEqual(bytes);
  });

  it('catches a challenge id or expiry that differs from the statement', () => {
    for (const mismatched of [
      { ...body, challengeId: '01KJXYKJYW4N8QGQ5W4GB6YM9K' },
      { ...body, expiresAt: '2026-10-19T11:00:00.000Z' },
    ]) {
      expect(() => assertChallengeResultMatches(mismatched)).toThrow(StepUpStatementError);
    }
  });

  it('catches a statement for another chat, tool call or decision', () => {
    for (const other of [
      { ...request, sessionId: '00000000-0000-4000-8000-000000000000' },
      { ...request, toolCallId: 'toolu_02' },
      { ...request, decision: 'deny' as const },
    ]) {
      expect(() => assertChallengeResultMatches(body, other)).toThrow(StepUpStatementError);
    }
  });

  it('refuses a statement that is not a canonical approval statement', () => {
    const notCanonical = encodeStepUpBase64url(
      new TextEncoder().encode(JSON.stringify(APPROVAL_STATEMENT, null, 1))
    );
    expect(() => assertChallengeResultMatches({ ...body, statement: notCanonical })).toThrow(
      StepUpStatementError
    );
    const enrol = encodeStepUpStatement({
      t: 'dorkos.relay.passkey-enrol.v1',
      challengeId: body.challengeId,
      computerId: 'computer-1',
      computerName: 'Studio',
      accountId: 'acct_1',
      userHandle: 'dXNlcg',
      nonce: NONCE,
      issuedAt: APPROVAL_STATEMENT.issuedAt,
      expiresAt: body.expiresAt,
      rpId: 'approve.dorkos.ai',
      origin: 'https://approve.dorkos.ai',
      returnTo: 'http://127.0.0.1:4242/relay-passkey',
      excludeCredentialIds: [],
    });
    expect(() =>
      assertChallengeResultMatches({ ...body, statement: encodeStepUpBase64url(enrol) })
    ).toThrow(StepUpStatementError);
  });
});

describe('the approval proof is the step-up assertion', () => {
  it('is one definition, shared with the approve page', () => {
    expect(RelayApprovalProofSchema.safeParse(PROOF).success).toBe(true);
    expect(RelayApprovalProofSchema.safeParse({ ...PROOF, alwaysAllow: true }).success).toBe(false);
  });

  it('takes the same challenge ids as a relay request id', () => {
    for (const id of ['c1', '01KJXYKJYW4N8QGQ5W4GB6YM9J', 'a.b:c-d_e', 'x'.repeat(64)]) {
      expect(StepUpChallengeIdSchema.safeParse(id).success, id).toBe(true);
      expect(RelayRequestIdSchema.safeParse(id).success, id).toBe(true);
    }
    for (const id of ['', 'a/b', '../x', 'a b', 'a?b', 'x'.repeat(65)]) {
      expect(StepUpChallengeIdSchema.safeParse(id).success, id).toBe(false);
      expect(RelayRequestIdSchema.safeParse(id).success, id).toBe(false);
    }
  });
});

describe('the step-up statement agrees with this package', () => {
  const statement = APPROVAL_STATEMENT;

  it('writes the same canonical bytes stableStringify writes', () => {
    // The computer hashes tool input with stableStringify; the statement's own
    // canonical writer lives in @dork-labs/cloud-api, which depends on nothing
    // here. They must agree on plain JSON, nested objects and arrays included.
    const bytes = encodeStepUpStatement(statement);
    expect(new TextDecoder().decode(bytes)).toBe(stableStringify(statement));
  });

  it('takes a computer name the relay takes, and refuses one it refuses', () => {
    for (const name of ['Studio', 'Dorian’s MacBook', 'x'.repeat(64)]) {
      expect(RelayDisplayNameSchema.safeParse(name).success, name).toBe(true);
      expect(
        StepUpStatementV1Schema.safeParse({ ...statement, computerName: name }).success,
        name
      ).toBe(true);
    }
    for (const name of ['', ' Studio', 'Stu\u0000dio', 'Stu\u202edio', 'x'.repeat(65)]) {
      expect(RelayDisplayNameSchema.safeParse(name).success, name).toBe(false);
      expect(
        StepUpStatementV1Schema.safeParse({ ...statement, computerName: name }).success,
        name
      ).toBe(false);
    }
  });
});

describe('reading a result for the op that was asked', () => {
  it('accepts the body its op defines', () => {
    expect(parseRelayResult('session.send', { sessionId: SESSION })).toEqual({
      sessionId: SESSION,
    });
  });

  it('refuses a body meant for another op', () => {
    expect(parseRelayResult('chats.list', { sessionId: SESSION })).toBeNull();
    expect(parseRelayResult('interaction.respond', { chats: [] })).toBeNull();
  });
});

describe('version handshake', () => {
  it('accepts a welcome only for a version this build speaks', () => {
    expect(isAgreedRelayVersion({ min: 1, max: 2 }, 2)).toBe(true);
    expect(isAgreedRelayVersion({ min: 1, max: 2 }, 3)).toBe(false);
    expect(isAgreedRelayVersion({ min: 2, max: 3 }, 1)).toBe(false);
    expect(isAgreedRelayVersion({ min: 1, max: 2 }, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(isAgreedRelayVersion({ min: 1, max: 2 }, 1.5)).toBe(false);
  });

  it('agrees on the highest version both speak', () => {
    expect(negotiateRelayVersion({ min: 1, max: 3 }, { min: 2, max: 5 })).toEqual({
      ok: true,
      version: 3,
    });
    expect(negotiateRelayVersion(SESSION_RELAY_VERSIONS, SESSION_RELAY_VERSIONS)).toEqual({
      ok: true,
      version: SESSION_RELAY_VERSIONS.max,
    });
  });

  it('names the computer as the one to update when it is too old', () => {
    expect(negotiateRelayVersion({ min: 3, max: 4 }, { min: 1, max: 2 })).toEqual({
      ok: false,
      outdated: 'peer',
    });
  });

  it('names itself as the one to update when the computer is newer', () => {
    expect(negotiateRelayVersion({ min: 1, max: 2 }, { min: 3, max: 4 })).toEqual({
      ok: false,
      outdated: 'self',
    });
  });
});

describe('needs an update for one feature', () => {
  it('maps every request to a feature this version defines', () => {
    for (const request of EVERY_REQUEST) {
      expect(SESSION_RELAY_FEATURES).toContain(relayFeatureFor(request));
    }
  });

  it('every feature but the optional device field is reachable by some request', () => {
    const reached = new Set(EVERY_REQUEST.map(relayFeatureFor));
    const requestFeatures = SESSION_RELAY_FEATURES.filter((f) => f !== 'request.device');
    expect([...reached].sort()).toEqual([...requestFeatures].sort());
  });

  it('names the one feature a computer lacks and passes the ones it has', () => {
    const advertised = ['session.stream', 'session.send', 'interaction.approval'];
    const question = EVERY_REQUEST.find(
      (r) => r.op === 'interaction.respond' && r.answer.kind === 'answer'
    )!;
    expect(missingRelayFeature(advertised, question)).toBe('interaction.question');
    const approve = EVERY_REQUEST.find(
      (r) => r.op === 'interaction.respond' && r.answer.kind === 'approve'
    )!;
    expect(missingRelayFeature(advertised, approve)).toBeNull();
    expect(missingRelayFeature([], EVERY_REQUEST[0])).toBe('chats.list');
  });
});

describe('the hub proves itself to the computer', () => {
  const helloText = JSON.stringify(hello());
  const input = { helloText, hubOrigin: HUB_ORIGIN };

  it('signs exactly these bytes, so every hub and computer agree', () => {
    // A known answer: changing the label or the layout breaks self-hosted hubs.
    expect(new TextDecoder().decode(relayWelcomeTranscript(input, 1, EPHEMERAL))).toBe(
      ['dorkos-session-relay/v1', 'welcome', HUB_ORIGIN, helloText, '1', EPHEMERAL].join('\n')
    );
    expect(new TextDecoder().decode(relayRefuseTranscript(input, { min: 2, max: 3 }))).toBe(
      ['dorkos-session-relay/v1', 'refuse', HUB_ORIGIN, helloText, '2-3'].join('\n')
    );
  });

  it('verifies only for the same hello, version, hub key and origin', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const signature = sign(null, relayWelcomeTranscript(input, 1, EPHEMERAL), privateKey);
    const verifies = (bytes: Uint8Array) => verify(null, bytes, publicKey, signature);

    expect(verifies(relayWelcomeTranscript(input, 1, EPHEMERAL))).toBe(true);
    // A replay to a new hello (another nonce), a downgrade, a swapped key, another hub.
    const otherHello = {
      ...input,
      helloText: JSON.stringify(hello({ nonce: randomBytes(32).toString('base64url') })),
    };
    expect(verifies(relayWelcomeTranscript(otherHello, 1, EPHEMERAL))).toBe(false);
    expect(verifies(relayWelcomeTranscript(input, 2, EPHEMERAL))).toBe(false);
    expect(verifies(relayWelcomeTranscript(input, 1, randomBytes(32).toString('base64url')))).toBe(
      false
    );
    expect(
      verifies(
        relayWelcomeTranscript({ ...input, hubOrigin: 'https://evil.example' }, 1, EPHEMERAL)
      )
    ).toBe(false);
    // A welcome signature never passes as a refuse.
    expect(verifies(relayRefuseTranscript(input, SESSION_RELAY_VERSIONS))).toBe(false);
  });

  it('signs the computer finish under its own line, so it never passes as a welcome', () => {
    expect(new TextDecoder().decode(relayFinishTranscript(input, 1, EPHEMERAL))).toBe(
      ['dorkos-session-relay/v1', 'finish', HUB_ORIGIN, helloText, '1', EPHEMERAL].join('\n')
    );
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const signature = sign(null, relayFinishTranscript(input, 1, EPHEMERAL), privateKey);
    expect(verify(null, relayWelcomeTranscript(input, 1, EPHEMERAL), publicKey, signature)).toBe(
      false
    );
    const finish = { type: 'finish', signature: signature.toString('base64url') };
    expect(RelayFinishFrameSchema.safeParse(finish).success).toBe(true);
  });

  it('refuses to sign an origin with a line break in it', () => {
    const broken = { helloText, hubOrigin: 'https://a\nhttps://b' };
    expect(() => relayWelcomeTranscript(broken, 1, EPHEMERAL)).toThrow();
  });

  it('closes an idle relay after three minutes, so a hub can sleep', () => {
    expect(SESSION_RELAY_IDLE_CLOSE_MS).toBe(3 * 60 * 1000);
    expect(RelayWebFrameSchema.safeParse({ type: 'viewers', count: -1 }).success).toBe(false);
  });
});

describe('the browser a request names', () => {
  const frame = {
    type: 'request',
    id: 'r1',
    request: { op: 'chats.list', agentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
  };

  it('is optional on a request frame, and checked when present', () => {
    expect(RelayWebFrameSchema.safeParse(frame).success).toBe(true);
    const device = { id: 'browser-id-0001', label: 'Safari on iPhone' };
    expect(RelayWebFrameSchema.safeParse({ ...frame, device }).success).toBe(true);
    for (const bad of [
      { id: 'short', label: 'Safari' },
      { id: 'browser-id/0001', label: 'Safari' },
      { id: 'browser-id-0001', label: 'x'.repeat(65) },
      { id: 'browser-id-0001', label: 'Safari\non iPhone' },
      { id: 'browser-id-0001', label: 'Safari\u202Eon iPhone' },
      { id: 'browser-id-0001', label: ' Safari' },
      { id: 'browser-id-0001', label: 'Safari', token: 'x' },
    ]) {
      expect(RelayDeviceSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('is advertised as its own feature, so a hub sends it only to a computer that reads it', () => {
    expect(SESSION_RELAY_FEATURES).toContain(SESSION_RELAY_DEVICE_FEATURE);
    expect(SESSION_RELAY_DEVICE_FEATURE).toBe('request.device');
  });
});
