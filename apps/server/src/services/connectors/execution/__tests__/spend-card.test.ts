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
import { createCapabilityAuthorityBinding } from '../../principal/capability-authority-binding.js';
import { createServerPrincipal } from '../../principal/server-principal.js';
import { connectorExecutionDomain } from '../execution-capabilities.js';
import type { SpendPreflight } from '../../spending/spend-decision.js';

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

  function call(approvalToken?: string) {
    return registry().invoke('connectors.execute_read', TARGET, {
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

  it('refuses past the limit with no card (spec §4.1)', async () => {
    spend = { kind: 'refuse', code: 'SPEND_LIMIT', message: 'This run would pass the monthly spending limit. $0.20 is left.' };
    await expect(call()).rejects.toSatisfy(
      (error) => error instanceof CapabilityToolError && error.fields.code === 'SPEND_LIMIT'
    );
    expect(request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses an outsider-marked turn with no card (Security Must 1)', async () => {
    spend = { kind: 'refuse', code: 'SPEND_OUTSIDER', message: 'Paid actions are off for this turn. It read outside content.' };
    await expect(call()).rejects.toSatisfy(
      (error) => error instanceof CapabilityToolError && error.fields.code === 'SPEND_OUTSIDER'
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
    if (!(first instanceof CapabilityGateRefusal) || first.decision.outcome !== 'approval_required') {
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
  });
});
