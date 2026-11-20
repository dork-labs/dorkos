/**
 * What the permission gate does with a paid run (DOR-4204 PR 2, spec §4.1):
 * a card when it must ask, a refusal with no card past the limit or on an
 * outsider-marked turn, and a quiet run when a known price fits.
 *
 * Real registry, tier gate and approval service; the connector preflight's
 * spend answer is supplied, the broker is a spy. Names and amounts are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import { createTestDb } from '@dorkos/test-utils/db';
import { ApprovalService } from '../../../core/approvals/index.js';
import {
  CapabilityGateRefusal,
  composeRegistry,
  initCapabilityTierGate,
  initPermissionGate,
  resetCapabilityTierGate,
  resetPermissionGate,
} from '../../../core/capabilities/index.js';
import { CapabilityToolError } from '../../../core/capabilities/mcp-envelope.js';
import { approvalMessage } from '../../../core/capabilities/approval-wording.js';
import { createCapabilityAuthorityBinding } from '../../principal/capability-authority-binding.js';
import { createServerPrincipal } from '../../principal/server-principal.js';
import { connectorExecutionDomain } from '../execution-capabilities.js';
import { spendPreflightOf, type SpendPreflight } from '../../spending/spend-decision.js';
import { spendCardLookupFrom } from '../../spending/spending-port.js';

const TARGET = {
  connectionId: 'connection-acme-search',
  operationRevisionId: 'revision-search',
  arguments: { query: 'Northwind pricing' },
};
const DIGEST = 'spend-digest';
const CARD = {
  priceMicro: null,
  priceSource: null,
  limitMicro: null,
  leftMicro: null,
  currency: 'USD',
} as const;

describe('a paid run at the permission gate', () => {
  let spend: SpendPreflight | undefined;
  const execute = vi.fn(async () => ({
    logicalOperationId: 'logical-1',
    attemptCount: 1,
    result: { status: 'success' as const, data: {} },
  }));
  let approvals: ApprovalService;
  let request: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execute.mockClear();
    spend = { kind: 'ask', reason: 'no-limit', card: CARD };
    // Full: the loosest preset, so any card here is the spend gate's own.
    initPermissionGate({
      readConfig: () => ({ preset: 'full', defaults: { areas: {}, actions: {} } }),
    });
    approvals = new ApprovalService(createTestDb());
    request = vi.spyOn(approvals, 'request');
    initCapabilityTierGate({ approvals });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetPermissionGate();
  });

  function registry() {
    return composeRegistry([connectorExecutionDomain], {
      logger: noopLogger,
      connectorExecutionDeps: {
        authorization: {
          preflight: vi.fn(async () => ({
            authorityBinding: createCapabilityAuthorityBinding({
              digest: DIGEST,
              ownerKind: 'local_install',
              ownerId: 'install-a',
              agentId: 'agent-kestrel',
              sessionId: 'session-a',
              connectionId: TARGET.connectionId,
              operationRevisionId: TARGET.operationRevisionId,
            }),
            approvalServiceAction: {
              serviceId: 'tavily',
              serviceName: 'Acme Search',
              accountLabel: 'Work',
              actionName: 'Search the web',
              details: [],
            },
            ...(spend ? { spend } : {}),
          })),
        } as never,
        broker: { execute } as never,
        access: {} as never,
      },
    });
  }

  function call(approvalToken?: string, id = 'connectors.execute_read') {
    return registry().invoke(id, TARGET, {
      identity: {
        agentPath: '/agents/kestrel',
        displayName: 'Kestrel',
        createdAt: '2026-11-01T00:00:00.000Z',
      },
      serverPrincipal: createServerPrincipal({
        kind: 'runtime',
        owner: { kind: 'local_install', installationId: 'install-a' },
        bindingId: 'binding-a',
        runtime: 'claude-code',
        canonicalSessionId: 'session-a',
        agentId: 'agent-kestrel',
        agentPath: '/agents/kestrel',
        canonicalCwd: '/agents/kestrel',
      }),
      sessionId: 'session-a',
      ...(approvalToken ? { approvalToken } : {}),
    });
  }

  it('raises a spend card for a paid read with no limit set, and runs nothing (spec §13 #1)', async () => {
    await expect(call()).rejects.toSatisfy(
      (error) =>
        error instanceof CapabilityGateRefusal && error.decision.outcome === 'approval_required'
    );
    expect(execute).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        authorityBindingDigest: DIGEST,
        serviceAction: expect.objectContaining({ keptCardBecause: 'spend', spend: CARD }),
      })
    );
  });

  it('raises a card on Trusted too: auto-share and Trusted never stand in for a yes to spend (Security Must 2)', async () => {
    initPermissionGate({
      readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
    });
    await expect(call()).rejects.toBeInstanceOf(CapabilityGateRefusal);
    expect(request).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('raises a card when the price is unknown, even with plenty left (spec §13 #3)', async () => {
    spend = {
      kind: 'ask',
      reason: 'unknown-price',
      card: { ...CARD, limitMicro: '40000000', leftMicro: '27600000' },
    };
    await expect(call()).rejects.toBeInstanceOf(CapabilityGateRefusal);
    expect(request).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  /** The message an agent reads when its call is held for a card. */
  async function heldMessage(id?: string): Promise<string> {
    const error = await call(undefined, id).catch((caught: unknown) => caught);
    if (
      !(error instanceof CapabilityGateRefusal) ||
      error.decision.outcome !== 'approval_required'
    ) {
      throw error;
    }
    return (error.decision.payload as { message: string }).message;
  }

  describe('what the agent is told (DOR-4447)', () => {
    const DOLLAR = 1_000_000;
    const facts = {
      paid: true,
      outsider: false,
      limitMicro: 40 * DOLLAR,
      priceMicro: 300_000,
      usedMicro: 12 * DOLLAR,
      resetsAt: new Date('2026-12-01T00:00:00Z'),
    } as const;

    it('names spending and the monthly limit when no limit is set', async () => {
      spend = spendPreflightOf({ ...facts, limitMicro: null });
      expect(await heldMessage()).toBe(
        '"Read from a connected app" costs money. No monthly spending limit is set, so each paid ' +
          'action needs a yes. DorkOS has asked the person to allow it. They can set a monthly ' +
          "limit and this app's price per run in Connections, so paid actions inside the limit " +
          'stop asking about cost.'
      );
    });

    it('names the missing price when the app has none', async () => {
      spend = spendPreflightOf({ ...facts, priceMicro: null });
      expect(await heldMessage()).toBe(
        '"Read from a connected app" costs money. This app has no price per run set, so the ' +
          "monthly limit can't count it. DorkOS has asked the person to allow it. They can set " +
          "this app's price per run in Connections, so it counts against the limit instead of asking."
      );
    });

    it('keeps the high-risk reason and leaves the fix out when a limit would not stop the card', async () => {
      spend = spendPreflightOf({ ...facts, limitMicro: null });
      expect(await heldMessage('connectors.execute_destructive')).toBe(
        '"Take a high-risk action in a connected app" is high risk and costs money. No monthly ' +
          'spending limit is set, so each paid action needs a yes. DorkOS has asked the person ' +
          'to allow it.'
      );
    });

    it('keeps "set to ask" and leaves the fix out when the permission asks anyway', () => {
      expect(
        approvalMessage('no_approval', 'Send a message', 'act', 'connectors.execute_write', false, {
          reason: 'unknown-price',
          only: false,
        })
      ).toBe(
        '"Send a message" is set to ask a person first and costs money. This app has no price ' +
          "per run set, so the monthly limit can't count it. DorkOS has asked the person to allow it."
      );
    });

    it('names an unreadable meter without promising a fix', async () => {
      spend = spendPreflightOf({ ...facts, usedMicro: 'unreadable' });
      expect(await heldMessage()).toBe(
        '"Read from a connected app" costs money. This month\'s spending can\'t be read right now. ' +
          'DorkOS has asked the person to allow it.'
      );
    });

    it('at the limit raises no card: the refusal names spending, the reset day and Connections', async () => {
      spend = spendPreflightOf({ ...facts, usedMicro: 40 * DOLLAR, priceMicro: null });
      const error = await call().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CapabilityToolError);
      expect((error as CapabilityToolError).payload).toMatchObject({
        code: 'SPEND_LIMIT',
        error:
          "This month's spending limit is reached. Paid actions stop until Dec 1. " +
          'Ask the person to raise the limit in Connections, or wait.',
      });
      expect(request).not.toHaveBeenCalled();
    });

    it('leaves the card a person sees exactly as it was: the reason reaches only the agent', async () => {
      spend = { kind: 'ask', reason: 'no-limit', card: CARD };
      await heldMessage();
      spend = { kind: 'ask', reason: 'unknown-price', card: CARD };
      await heldMessage();
      expect(request).toHaveBeenCalledTimes(2);
      // Everything the card is built from: same request, whichever reason held it.
      const [first, second] = request.mock.calls.map((call: unknown[]) => call[0]);
      expect(second).toEqual(first);
      expect(JSON.stringify(first)).not.toMatch(/costs money|Connections|price per run/);
    });
  });

  it('refuses past the limit with no card (spec §4.1)', async () => {
    spend = {
      kind: 'refuse',
      code: 'SPEND_LIMIT',
      message: 'This run would pass the monthly spending limit. $0.20 is left.',
    };
    await expect(call()).rejects.toSatisfy(
      (error) =>
        error instanceof CapabilityToolError &&
        (error.payload as { code?: string }).code === 'SPEND_LIMIT'
    );
    expect(request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses an outsider-marked turn with no card (Security Must 1)', async () => {
    spend = {
      kind: 'refuse',
      code: 'SPEND_OUTSIDER',
      message: 'Paid actions are off for this turn. It read outside content.',
    };
    await expect(call()).rejects.toSatisfy(
      (error) =>
        error instanceof CapabilityToolError &&
        (error.payload as { code?: string }).code === 'SPEND_OUTSIDER'
    );
    expect(request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('runs quietly when a known price fits under the limit', async () => {
    spend = { kind: 'run' };
    await expect(call()).resolves.toMatchObject({ result: { status: 'success' } });
    expect(request).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('runs once after a person allows the card, and the token is spent', async () => {
    const first = await call().catch((error: unknown) => error);
    if (
      !(first instanceof CapabilityGateRefusal) ||
      first.decision.outcome !== 'approval_required'
    ) {
      throw first;
    }
    const { approvalId, approvalToken } = first.decision.payload as {
      approvalId: string;
      approvalToken: string;
    };
    expect(approvals.grant(approvalId)).toBeUndefined();
    await expect(call(approvalToken)).resolves.toMatchObject({ result: { status: 'success' } });
    await expect(call(approvalToken)).rejects.toBeInstanceOf(CapabilityGateRefusal);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ approval: expect.objectContaining({ approvalId }) })
    );
    // The broker reads this to take the yes as the owner's yes to spend.
    expect(spendCardLookupFrom(approvals)(approvalId)).toBe(true);
  });

  it('never reads a yes on an ordinary card as a yes to spend (Security Must 2)', () => {
    const ordinary = approvals.request({
      capabilityId: 'connectors.execute_write',
      inputHash: 'input-hash',
      summary: 'Send a message.',
      serviceAction: {
        serviceId: 'tavily',
        serviceName: 'Acme Search',
        accountLabel: 'Work',
        actionName: 'Search the web',
        details: [],
      },
    } as never);
    approvals.grant(ordinary.approvalId);
    const isSpendCard = spendCardLookupFrom(approvals);
    expect(isSpendCard(ordinary.approvalId)).toBe(false);
    expect(isSpendCard('approval-nobody-made')).toBe(false);
  });
});
