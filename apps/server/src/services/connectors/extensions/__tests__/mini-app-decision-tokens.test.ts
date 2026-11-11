/** One-time tokens for the mini app access page (DOR-3547). Made-up data. */
import { describe, expect, it } from 'vitest';
import {
  DECISION_TOKEN_TTL_MS,
  MiniAppDecisionTokens,
  type DecisionTicket,
} from '../mini-app-decision-tokens.js';

const TICKET: DecisionTicket = {
  extensionId: 'flow-owner',
  service: 'linear',
  filesDigest: 'sha256:files-1',
  sessionKey: 'local',
};

describe('mini app decision tokens', () => {
  it('redeems once, with its cookie and session', () => {
    const tokens = new MiniAppDecisionTokens();
    const { token, cookie } = tokens.issue(TICKET);
    expect(tokens.redeem(token, cookie, 'local')).toEqual(TICKET);
    expect(tokens.redeem(token, cookie, 'local')).toBeUndefined();
  });

  it.each([
    ['another cookie', (cookie: string) => [cookie + 'x', 'local']],
    ['no cookie', () => [undefined, 'local']],
    ['another session', (cookie: string) => [cookie, 'user-b']],
  ])('refuses %s, and the token is spent anyway', (_case, args) => {
    const tokens = new MiniAppDecisionTokens();
    const { token, cookie } = tokens.issue(TICKET);
    const [sentCookie, session] = args(cookie) as [string | undefined, string];
    expect(tokens.redeem(token, sentCookie, session)).toBeUndefined();
    expect(tokens.redeem(token, cookie, 'local')).toBeUndefined();
  });

  it('runs out after five minutes', () => {
    let now = 0;
    const tokens = new MiniAppDecisionTokens(() => now);
    const { token, cookie } = tokens.issue(TICKET);
    now = DECISION_TOKEN_TTL_MS;
    expect(tokens.redeem(token, cookie, 'local')).toBeUndefined();
  });

  it('never keeps the token itself', () => {
    const tokens = new MiniAppDecisionTokens();
    const { token, cookie } = tokens.issue(TICKET);
    const kept = JSON.stringify([
      ...(tokens as unknown as { stored: Map<string, unknown> }).stored,
    ]);
    expect(kept).not.toContain(token);
    expect(kept).not.toContain(cookie);
  });
});
