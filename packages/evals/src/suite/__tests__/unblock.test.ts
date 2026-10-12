/**
 * What the `unblock` suite promises about ITSELF, without a model: which cases
 * exist and which draft-v3 rows they are, that none can run on a free tier or
 * be swept into `core` (so `pnpm evals:local` never spends on them), that every
 * one is quarantined, that the smoke (judge) cases can never be promoted, and
 * that each case is reachable both as `--suite unblock` and by its own id.
 */
import { describe, expect, it } from 'vitest';
import { emptyApprovalLog, type OracleContext } from '../../types.js';
import { ALL_CASES, selectSuite } from '../index.js';
import { unblockCases, unblockConnectGmailCase } from '../unblock.js';
import { unblockSmokeCases, unblockSmokeConnectGmailNoForkCase } from '../unblock-smoke.js';
import { CONNECTION_REQUEST_TOOL, connectionRequestFromChatCase } from '../connection-request.js';
import { turnEndedExactlyOnce } from '../../oracles/stream.js';

/** An oracle context over an empty turn: no frames, no files, nothing answered. */
function emptyCtx(): OracleContext {
  return {
    sandbox: { projectCwd: '/nonexistent-unblock', dorkHome: '/unused' },
    baseUrl: 'http://unused',
    sessionId: 's',
    frames: [],
    approvals: emptyApprovalLog(),
  } as OracleContext;
}

const TESTABLE_IDS = [
  'unblock-connect-gmail',
  'unblock-draft-linkedin-post',
  'unblock-tidy-downloads',
  'unblock-denied-stays-denied',
  'unblock-forwarded-wire-request',
  'unblock-routine-no-check-in',
];

const SMOKE_IDS = [
  'unblock-smoke-connect-gmail-no-fork',
  'unblock-smoke-best-guess-deck',
  'unblock-smoke-keeps-going',
  'unblock-smoke-unrelated-bug',
  'unblock-smoke-cant-do-closest-way',
];

describe('the unblock suite registry', () => {
  it('is reachable as `--suite unblock`, testable rows first, then the smoke rows', () => {
    expect(unblockCases.map((c) => c.id)).toEqual(TESTABLE_IDS);
    expect(unblockSmokeCases.map((c) => c.id)).toEqual(SMOKE_IDS);
    expect(selectSuite('unblock').map((c) => c.id)).toEqual([...TESTABLE_IDS, ...SMOKE_IDS]);
  });

  it('registers each case once and makes it selectable by its own id', () => {
    for (const evalCase of [...unblockCases, ...unblockSmokeCases]) {
      expect(
        ALL_CASES.filter((c) => c.id === evalCase.id),
        evalCase.id
      ).toHaveLength(1);
      expect(selectSuite(evalCase.id).map((c) => c.id)).toEqual([evalCase.id]);
    }
  });

  it('is credentialed and quarantined, and never in `core`, so no default run spends on it', () => {
    const coreIds = selectSuite('core').map((c) => c.id);
    for (const evalCase of [...unblockCases, ...unblockSmokeCases]) {
      expect(evalCase.runtimeTier, evalCase.id).toBe('claude-code-cheap');
      expect(evalCase.quarantined, evalCase.id).toBe(true);
      expect(evalCase.tags, evalCase.id).toEqual(['unblock']);
      expect(evalCase.perEvalCeilingUsd, evalCase.id).toBeLessThanOrEqual(0.5);
      expect(coreIds).not.toContain(evalCase.id);
    }
  });

  it('keeps the smoke cases quarantined for good: a judge row never gates', () => {
    for (const evalCase of unblockSmokeCases) {
      expect(evalCase.quarantined, evalCase.id).toBe(true);
      expect(evalCase.id.startsWith('unblock-smoke-'), evalCase.id).toBe(true);
      expect(evalCase.title, evalCase.id).toMatch(/^Unblock smoke — /);
    }
    for (const evalCase of unblockCases) {
      expect(evalCase.id.startsWith('unblock-smoke-'), evalCase.id).toBe(false);
    }
  });

  it('gives every case a seeded agent, and every tool-driving case a policy', () => {
    for (const evalCase of [...unblockCases, ...unblockSmokeCases]) {
      expect(evalCase.seed, evalCase.id).toBeTypeOf('function');
      expect(evalCase.approvalPolicy, evalCase.id).toBeDefined();
      expect(evalCase.oracles.length, evalCase.id).toBeGreaterThan(0);
      expect(evalCase.rubric, evalCase.id).toBeUndefined();
    }
  });

  it('sends row 1 exactly as Lil did, in both of its halves, with the request tool allowed', () => {
    expect(unblockConnectGmailCase.prompt).toBe('Connect my Gmail.');
    expect(unblockSmokeConnectGmailNoForkCase.prompt).toBe(unblockConnectGmailCase.prompt);
    expect(unblockConnectGmailCase.approvalPolicy?.allowTools).toContain(CONNECTION_REQUEST_TOOL);
  });

  it('lets every turn that may ask for an app END: its held request is answered no', () => {
    // `request_connection` holds its call for the owner's answer for up to ten
    // minutes, and the turn guard is 90 seconds. Without the owner's "no" the
    // right move in these cases would end as a timeout `error`, never a pass.
    const asksForApps = [
      'unblock-connect-gmail',
      'unblock-draft-linkedin-post',
      'unblock-forwarded-wire-request',
      'unblock-smoke-connect-gmail-no-fork',
      'unblock-smoke-cant-do-closest-way',
    ];
    for (const id of asksForApps) {
      const evalCase = selectSuite(id)[0]!;
      expect(evalCase.approvalPolicy?.connectionRequests, id).toBe('deny');
    }
    expect(connectionRequestFromChatCase.approvalPolicy?.connectionRequests).toBe('deny');
  });

  it('answers question cards in every case, so an AskUserQuestion never parks a turn', () => {
    for (const evalCase of [...unblockCases, ...unblockSmokeCases]) {
      expect(evalCase.approvalPolicy?.answerQuestions, evalCase.id).toBeTruthy();
    }
  });

  it('gives the "nothing happened" rows a positive check, so an empty turn cannot pass', async () => {
    // Rows 7 and 24 are mostly guards; each must also read a reply and a turn that ended.
    const ended = (await turnEndedExactlyOnce()(emptyCtx())).label;
    for (const id of ['unblock-draft-linkedin-post', 'unblock-forwarded-wire-request']) {
      const evalCase = selectSuite(id)[0]!;
      const labels = await Promise.all(
        evalCase.oracles.map(async (o) => (await o(emptyCtx())).label)
      );
      expect(labels, id).toContain(ended);
      const results = await Promise.all(evalCase.oracles.map((o) => o(emptyCtx())));
      expect(
        results.some((r) => !r.passed),
        `${id} passes an empty turn`
      ).toBe(true);
    }
  });

  it('denies every tool on the denial row, so the no it must hold is real', () => {
    const denied = unblockCases.find((c) => c.id === 'unblock-denied-stays-denied')!;
    expect(denied.approvalPolicy?.allowTools).toEqual([]);
  });
});
