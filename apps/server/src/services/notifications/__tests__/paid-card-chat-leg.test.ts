/**
 * A paid run's card on a chat app or a lock screen (DOR-4204 spec 1.1,
 * Security Must 2): only a person answers it, in DorkOS. So what reaches
 * Telegram or Slack is plain words saying where to answer, never a yes to
 * tap, and it never says "cannot be undone", which a paid search is not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations } from '@dorkos/db';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { NotificationStore } from '../notification-store.js';
import { EscalationService } from '../escalation-service.js';
import { notificationEntry } from '../notification-registry.js';
import { capabilityApprovalPayload } from '../emitters/capability-approval.js';
import type { WebPushChannel } from '../channels/web-push.js';
import type { RelayChannelDeps } from '../channels/relay.js';

const ONE_MINUTE = 60 * 1000;

function paidCard(spend: boolean): PendingApproval {
  return {
    approvalId: '01JZPAID000000000000000001',
    capabilityId: 'connectors.execute_read',
    capabilityTitle: 'Run an app action',
    tier: 'act',
    summary: 'Acme Search: Search the web for "Northwind pricing".',
    requestedBy: 'Kestrel',
    hasAgentPath: false,
    area: null,
    alwaysOffered: false,
    requestedAt: '2026-11-14T12:00:00.000Z',
    expiresAt: '2026-11-14T12:05:00.000Z',
    serviceAction: {
      serviceId: 'tavily',
      serviceName: 'Acme Search',
      accountLabel: 'Team account',
      actionName: 'Search the web',
      details: [{ label: 'Query', value: 'Northwind pricing' }],
      ...(spend
        ? {
            keptCardBecause: 'spend' as const,
            spend: {
              priceMicro: '300000',
              priceSource: 'person' as const,
              limitMicro: null,
              leftMicro: null,
              currency: 'USD',
            },
          }
        : {}),
    },
  };
}

let publish: ReturnType<typeof vi.fn>;
let sendToAll: ReturnType<typeof vi.fn>;

function relayDeps(): RelayChannelDeps {
  publish = vi.fn().mockResolvedValue({ deliveredTo: 1, messageId: 'm-1' });
  return {
    isRelayEnabled: () => true,
    relayCore: { publish } as unknown as RelayChannelDeps['relayCore'],
    bindingStore: {
      getAll: () => [
        {
          id: 'binding-1',
          agentId: 'agent-kestrel',
          adapterId: 'telegram-main',
          enabled: true,
          canInitiate: true,
          notifyOnTaskComplete: true,
          chatId: 'chat-1',
          updatedAt: '2026-11-14T00:00:00.000Z',
        },
      ],
    } as unknown as RelayChannelDeps['bindingStore'],
    bindingRouter: {
      getSessionsByBinding: () => [
        { scope: 'chat' as const, chatId: 'chat-1', sessionId: 's', lastActivityAt: 10 },
      ],
    },
    adapterManager: {
      listAdapters: () => [{ config: { id: 'telegram-main', type: 'telegram' } }],
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a paid run’s card outside the app', () => {
  it('marks the notice as a paid run, from the card the server built', () => {
    expect(capabilityApprovalPayload(paidCard(true)).spend).toBe(true);
    expect(capabilityApprovalPayload(paidCard(false)).spend).toBeUndefined();
  });

  it('says where to answer, and never that it cannot be undone', () => {
    const entry = notificationEntry('approval.pending');
    const payload = capabilityApprovalPayload(paidCard(true));
    expect(entry.title(payload)).toBe('Kestrel wants to run a paid action');
    expect(entry.body?.(payload)).toBe(
      'Search the web in Acme Search spends money. Answer in DorkOS.'
    );
    // An ordinary card keeps its own words.
    expect(entry.body?.(capabilityApprovalPayload(paidCard(false)))).toContain('cannot be undone');
  });

  it('reaches a chat app as plain words with no yes to tap (Security Must 2)', async () => {
    sendToAll = vi.fn().mockResolvedValue({ delivered: 1, pruned: 0, outcomes: [] });
    const db = createDb(':memory:');
    runMigrations(db);
    const service = new EscalationService({
      store: new NotificationStore(db),
      push: { sendToAll } as unknown as WebPushChannel,
      relay: () => relayDeps(),
      readDelay: () => 1,
    });
    service.arm('approval.pending', {
      ...capabilityApprovalPayload(paidCard(true)),
      agentId: 'agent-kestrel',
    });

    await vi.advanceTimersByTimeAsync(ONE_MINUTE + 1);

    expect(publish).toHaveBeenCalledTimes(1);
    const [, message] = publish.mock.calls[0]!;
    // A string, not a card with buttons: nothing in a chat can answer it.
    expect(typeof message).toBe('string');
    expect(message).toBe(
      'Kestrel wants to run a paid action\nSearch the web in Acme Search spends money. Answer in DorkOS.'
    );
    expect(message).not.toMatch(/Allow|Approve/);
  });
});
