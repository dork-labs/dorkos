import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MANAGED_APPROVALS_HEADER,
  MANAGED_APPROVALS_HEADER_VALUE,
  MANAGED_CONNECTOR_ERROR_CODES,
  ManagedConnectorApprovalRefSchema,
  ManagedConnectorAuthorityCommandStatusSchema,
  ManagedConnectorExecutionReceiptSchema,
  ManagedConnectorExecutionReceiptStatusSchema,
  ManagedConnectorExecutionResponseSchema,
  ManagedConnectorExecutionAttributionSchema,
  ManagedConnectorInstanceApprovalListSchema,
  managedRequestHash,
  mayResendHeld,
  safeApproveUrl,
  type ManagedConnectorExecutionRequest,
} from '../connector-managed-schemas.js';

// The awaiting-owner-approval contract (DOR-3265), contract-first for CLD-403.

const ORIGIN = 'https://cloud.example.com';
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

function ref(over: Record<string, unknown> = {}) {
  return {
    approvalId: '4b0f6f3e-9a2c-4d71-8c1e-2f5a6b7c8d9e',
    approveUrl: `${ORIGIN}/approvals/4b0f6f3e-9a2c-4d71-8c1e-2f5a6b7c8d9e`,
    expiresAt: inAnHour(),
    ...over,
  };
}

const commandBase = {
  version: 1,
  commandId: 'cmd-1',
  managedConnectionId: 'mc-1',
  scopeVersion: 3,
} as const;

describe('the approval request header', () => {
  it('is one opt-in request header with one value', () => {
    expect(MANAGED_APPROVALS_HEADER).toBe('DorkOS-Managed-Approvals');
    expect(MANAGED_APPROVALS_HEADER_VALUE).toBe('1');
  });
});

describe('an approval reference', () => {
  it('parses a random id, a link and a future expiry, and round-trips', () => {
    const parsed = ManagedConnectorApprovalRefSchema.parse(ref());
    expect(ManagedConnectorApprovalRefSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(
      parsed
    );
  });

  it('refuses a missing or already-past expiry instead of defaulting one', () => {
    // Purpose: fails if an approval with no deadline, or a dead one, reads as waiting.
    const { expiresAt: _drop, ...noExpiry } = ref();
    expect(ManagedConnectorApprovalRefSchema.safeParse(noExpiry).success).toBe(false);
    const past = ref({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    expect(ManagedConnectorApprovalRefSchema.safeParse(past).success).toBe(false);
  });

  it('refuses an id that is not a random uuid, and any extra key', () => {
    expect(ManagedConnectorApprovalRefSchema.safeParse(ref({ approvalId: '42' })).success).toBe(
      false
    );
    expect(ManagedConnectorApprovalRefSchema.safeParse(ref({ owner: 'x' })).success).toBe(false);
  });
});

describe('a command awaiting approval', () => {
  it('parses, round-trips, and keeps the shape an older client is given', () => {
    const awaiting = ManagedConnectorAuthorityCommandStatusSchema.parse({
      ...commandBase,
      state: 'awaiting_approval',
      ...ref(),
    });
    expect(
      ManagedConnectorAuthorityCommandStatusSchema.parse(JSON.parse(JSON.stringify(awaiting)))
    ).toEqual(awaiting);
    // Without the header the service refuses in the shape every client already parses.
    expect(
      ManagedConnectorAuthorityCommandStatusSchema.parse({
        ...commandBase,
        state: 'rejected',
        rejectionCode: 'permission_upgrade_required',
      })
    ).toMatchObject({ state: 'rejected', rejectionCode: 'permission_upgrade_required' });
  });

  it('names how an approval ended when it was refused', () => {
    for (const rejectionCode of ['approval_denied', 'approval_expired', 'approval_limit_reached'])
      expect(
        ManagedConnectorAuthorityCommandStatusSchema.parse({
          ...commandBase,
          state: 'rejected',
          rejectionCode,
        })
      ).toMatchObject({ rejectionCode });
  });

  it('is never read as applied by a client that does not know the state', () => {
    // Purpose: fails if an older client (its union without the new branch) could read the new
    // state as anything but a parse failure, the safe side of "never as success".
    const older = z.discriminatedUnion(
      'state',
      ManagedConnectorAuthorityCommandStatusSchema.options.filter(
        (option) => option.shape.state.value !== 'awaiting_approval'
      ) as unknown as [z.ZodObject<{ state: z.ZodLiteral<string> }>]
    );
    expect(older.safeParse({ ...commandBase, state: 'awaiting_approval', ...ref() }).success).toBe(
      false
    );
  });
});

describe('an execution held for approval', () => {
  const held = (approval: 'awaiting' | 'approved') => ({
    state: 'held',
    attemptId: 'attempt-1',
    approval,
    requestHash: 'a'.repeat(64),
    ...ref(),
  });

  it('parses in the execution response and the receipt poll, and round-trips', () => {
    for (const schema of [
      ManagedConnectorExecutionResponseSchema,
      ManagedConnectorExecutionReceiptStatusSchema,
    ]) {
      for (const approval of ['awaiting', 'approved'] as const) {
        const parsed = schema.parse(held(approval));
        expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
      }
    }
  });

  it('refuses a held execution with no expiry, a past one, or an unknown approval word', () => {
    const { expiresAt: _drop, ...noExpiry } = held('awaiting');
    expect(ManagedConnectorExecutionResponseSchema.safeParse(noExpiry).success).toBe(false);
    expect(
      ManagedConnectorExecutionResponseSchema.safeParse({
        ...held('awaiting'),
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }).success
    ).toBe(false);
    expect(
      ManagedConnectorExecutionResponseSchema.safeParse({ ...held('awaiting'), approval: 'yes' })
        .success
    ).toBe(false);
  });

  it('ends a never-approved action as a cancelled receipt with its reason', () => {
    for (const errorCode of ['APPROVAL_DENIED', 'APPROVAL_EXPIRED', 'APPROVAL_CANCELLED'])
      expect(
        ManagedConnectorExecutionReceiptSchema.parse({
          version: 1,
          receiptId: 'r-1',
          logicalOperationId: 'op-1',
          attemptId: 'attempt-1',
          attemptIndex: 1,
          outcome: 'cancelled',
          errorCode,
          completedAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
        })
      ).toMatchObject({ outcome: 'cancelled', errorCode });
  });

  it('adds the two refusal codes a held action can meet', () => {
    expect(MANAGED_CONNECTOR_ERROR_CODES.approvalLimitReached).toBe('approval_limit_reached');
    expect(MANAGED_CONNECTOR_ERROR_CODES.argumentsTooLargeToReview).toBe(
      'arguments_too_large_to_review'
    );
  });
});

describe('an instance’s open approvals', () => {
  it('parses each kind and round-trips', () => {
    const list = ManagedConnectorInstanceApprovalListSchema.parse({
      version: 1,
      approvals: [
        { kind: 'grant', managedConnectionId: 'mc-1', commandId: 'cmd-1', ...ref() },
        { kind: 'grant_review', managedConnectionId: 'mc-1', ...ref() },
        { kind: 'execution', managedConnectionId: 'mc-2', attemptId: 'attempt-1', ...ref() },
      ],
    });
    expect(
      ManagedConnectorInstanceApprovalListSchema.parse(JSON.parse(JSON.stringify(list)))
    ).toEqual(list);
  });
});

describe('which approval link a client may open', () => {
  it('opens the service’s own https link', () => {
    expect(safeApproveUrl(`${ORIGIN}/approvals/x`, ORIGIN)).toBe(`${ORIGIN}/approvals/x`);
    expect(safeApproveUrl(`${ORIGIN}/approvals/x`, `${ORIGIN}/`)).toBe(`${ORIGIN}/approvals/x`);
  });

  it('falls back on a lookalike origin, a different port or host, http, or user info', () => {
    // Purpose: fails if anything but an exact origin match opens a link (Security, L7).
    for (const url of [
      'https://cloud.example.com.evil.com/approvals/x',
      'https://evil.com/https://cloud.example.com/approvals/x',
      'https://cloud.example.com:8443/approvals/x',
      'https://other.example.com/approvals/x',
      'http://cloud.example.com/approvals/x',
      'https://user@cloud.example.com/approvals/x',
      'https://user:pass@cloud.example.com/approvals/x',
      'not a url',
    ])
      expect(safeApproveUrl(url, ORIGIN), url).toBeNull();
  });

  it('falls back when the configured origin itself cannot be read', () => {
    expect(safeApproveUrl(`${ORIGIN}/approvals/x`, 'nonsense')).toBeNull();
  });
});

// #3196 review, S1: the resend is bound to the exact request the owner approved.
describe('resending a held request', () => {
  const request: ManagedConnectorExecutionRequest = {
    version: 1,
    logicalOperationId: 'op-1',
    attemptId: 'attempt-1',
    attemptIndex: 1,
    managedConnectionId: 'mc-1',
    agentId: 'agent-a',
    grantScopeVersion: 4,
    attribution: { surface: 'mcp', actorKind: 'agent', actorId: 'agent-a' },
    revision: {
      hostedRevisionId: '10000000-0000-4000-8000-000000000001',
      operationSlug: 'GMAIL_SEND_EMAIL',
      toolkitVersion: '1',
      schemaHash: 'schema-1',
    },
    arguments: { to: 'owner@example.com', body: 'hello' },
  };
  const approved = (requestHash: string, attemptId = 'attempt-1') =>
    ({ attemptId, approval: 'approved', requestHash }) as const;

  it('hashes the same request the same way whatever its key order', () => {
    const reordered = Object.fromEntries(Object.entries(request).reverse());
    expect(managedRequestHash(reordered as ManagedConnectorExecutionRequest)).toBe(
      managedRequestHash(request)
    );
    expect(managedRequestHash(request)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resends only the approved request, by attempt and hash', () => {
    expect(mayResendHeld(approved(managedRequestHash(request)), request)).toBe(true);
  });

  it('never resends when the hash differs: other arguments, or a forged hash', () => {
    // Purpose: fails if a resend could carry arguments the owner never approved.
    const changed = { ...request, arguments: { to: 'attacker@example.com', body: 'hello' } };
    expect(mayResendHeld(approved(managedRequestHash(request)), changed)).toBe(false);
    expect(mayResendHeld(approved('b'.repeat(64)), request)).toBe(false);
  });

  it('never resends for another attempt, or before the owner approved', () => {
    expect(mayResendHeld(approved(managedRequestHash(request), 'attempt-2'), request)).toBe(false);
    expect(
      mayResendHeld({ ...approved(managedRequestHash(request)), approval: 'awaiting' }, request)
    ).toBe(false);
  });

  it('refuses a held response with no hash, or one that is not a sha-256', () => {
    const base = { state: 'held', attemptId: 'attempt-1', approval: 'approved', ...ref() };
    expect(ManagedConnectorExecutionResponseSchema.safeParse(base).success).toBe(false);
    expect(
      ManagedConnectorExecutionResponseSchema.safeParse({ ...base, requestHash: 'nope' }).success
    ).toBe(false);
  });
});

// #3196 review, S2: the owner's approval card can say what the calling turn carried.
describe('the calling turn’s marks', () => {
  const attribution = { surface: 'mcp', actorKind: 'agent', actorId: 'agent-a' } as const;

  it('carries the known marks, and still parses without any', () => {
    expect(
      ManagedConnectorExecutionAttributionSchema.parse({
        ...attribution,
        marks: ['outsider', 'tool_read', 'teammate'],
      }).marks
    ).toEqual(['outsider', 'tool_read', 'teammate']);
    expect(ManagedConnectorExecutionAttributionSchema.parse(attribution).marks).toBeUndefined();
  });

  it('refuses an unknown mark', () => {
    expect(
      ManagedConnectorExecutionAttributionSchema.safeParse({ ...attribution, marks: ['trusted'] })
        .success
    ).toBe(false);
  });
});
