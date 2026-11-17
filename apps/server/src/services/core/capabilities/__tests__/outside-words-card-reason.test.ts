/**
 * A card a turn's outside words raised says why (DOR-3969), and never over a reason the card already
 * names: a paid run's `spend` (which the spending port reads as the person's yes to that run) and
 * the Wi-Fi reason stay what they were.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { ApprovalServiceAction } from '@dorkos/shared/approval-schemas';
import { ApprovalService } from '../../approvals/index.js';
import { eventFanOut } from '../../event-fan-out.js';
import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';
import {
  enforceCapabilityTier,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  type GatedAction,
} from '../tier-enforcement.js';
import type { CallPermission } from '../permission-enforcement.js';

const AGENT: AgentIdentity = {
  agentPath: '/agents/wren',
  displayName: 'Wren',
  createdAt: '2026-11-17T12:00:00.000Z',
};

const SEND: GatedAction = {
  id: 'connectors.execute_write',
  tier: 'act',
  title: 'Make a change in a connected app',
} as GatedAction;

const ACTION: ApprovalServiceAction = {
  serviceId: 'gmail',
  serviceName: 'Gmail',
  accountLabel: 'Work (work@example.com)',
  actionName: 'Send email',
  details: [{ label: 'To', value: 'ann@example.com' }],
};

/** A marked turn's ask, the way the permission gate returns it. */
const MARKED_ASK = {
  area: 'connections',
  state: 'ask',
  source: 'always-asks',
  layer: 'floor',
  forOutsideWords: true,
} as unknown as CallPermission;

describe("the card's reason in a marked turn", () => {
  let approvals: ApprovalService;

  beforeEach(() => {
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    approvals = new ApprovalService(createTestDb());
    initCapabilityTierGate({ approvals });
  });

  afterEach(() => {
    resetCapabilityTierGate();
    vi.restoreAllMocks();
  });

  /** Raise the card for one send; the reason it carries. */
  function reasonOf(serviceAction: ApprovalServiceAction) {
    enforceCapabilityTier({
      action: SEND,
      input: { body: 'Made up.' },
      permission: MARKED_ASK,
      identity: AGENT,
      retryChannel: 'mcp-argument',
      serviceAction,
    });
    return approvals.listPending()[0]?.serviceAction?.keptCardBecause;
  }

  it('says the turn read outside words when the card names no other reason', () => {
    expect(reasonOf(ACTION)).toBe('outside-words');
  });

  it("keeps a paid run's spend reason", () => {
    expect(reasonOf({ ...ACTION, keptCardBecause: 'spend' })).toBe('spend');
  });

  it('keeps the Wi-Fi reason', () => {
    expect(reasonOf({ ...ACTION, keptCardBecause: 'wifi-open' })).toBe('wifi-open');
  });
});
