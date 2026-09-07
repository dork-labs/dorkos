import { describe, expect, it, vi } from 'vitest';
import { AdapterBindingSchema } from '@dorkos/shared/relay-schemas';
import type { PrivateNotificationOptions } from '@dorkos/relay';
import { ConnectorEventNativeDestination } from '../channel-destination.js';
import type { ActiveEventSubscription } from '../subscription-store.js';

function fixture() {
  const binding = AdapterBindingSchema.parse({
    id: '10000000-0000-4000-8000-000000000001',
    adapterId: 'telegram-one',
    agentId: 'receive-only-agent',
    chatId: '-100123',
    channelType: 'group',
    canInitiate: true,
    createdAt: '2026-09-07T00:00:00Z',
    updatedAt: '2026-09-07T00:00:00Z',
  });
  const scope = {
    destinationKind: 'channel',
    destinationId: binding.id,
    agentId: binding.agentId,
  } as ActiveEventSubscription;
  const bindings = { getById: vi.fn(() => binding), resolve: vi.fn(() => binding) };
  const adapters = [{ config: { id: binding.adapterId, type: 'telegram', enabled: true } }];
  const deliver = vi.fn(
    async (_subject: string, _text: string, options: PrivateNotificationOptions) =>
      options.authorizeDispatch()
        ? { state: 'delivered' as const, receiptId: 'telegram:-100123:7' }
        : { state: 'refused' as const }
  );
  const destination = new ConnectorEventNativeDestination({
    bindings: () => bindings,
    adapters: () => adapters,
    agentSubject: () => 'relay.agent.team.receive-only-agent',
    relay: { deliverPrivateNotification: deliver },
  });
  return { binding, scope, bindings, adapters, deliver, destination };
}
const content = { version: 1 as const, title: 'New mail', text: 'Private content' };

describe('exact native event destination', () => {
  it('uses the selected receive-only agent binding and sends one visibly bounded message', async () => {
    const f = fixture();
    expect(
      await f.destination.deliver(f.scope, { ...content, text: 'x'.repeat(10_000) }, () => true)
    ).toEqual({ state: 'delivered', receiptId: 'telegram:-100123:7' });
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.deliver.mock.calls[0][0]).toBe('relay.human.telegram.telegram-one.group.-100123');
    expect(f.deliver.mock.calls[0][1]).toHaveLength(4_000);
    expect(f.deliver.mock.calls[0][1]).toMatch(/\[Notification shortened\]$/);
  });

  it.each(['paused', 'rebound', 'disabled', 'superseded'] as const)(
    'refuses a %s binding after asynchronous preparation',
    async (change) => {
      const f = fixture();
      f.deliver.mockImplementationOnce(async (_subject, _text, options) => {
        await Promise.resolve();
        if (change === 'paused') f.binding.canInitiate = false;
        if (change === 'rebound') f.binding.chatId = '-999';
        if (change === 'disabled') f.adapters[0].config.enabled = false;
        if (change === 'superseded')
          f.bindings.resolve.mockReturnValue({
            ...f.binding,
            id: '20000000-0000-4000-8000-000000000002',
          });
        return options.authorizeDispatch()
          ? { state: 'delivered', receiptId: 'wrong' }
          : { state: 'refused' };
      });
      const claim = vi.fn(() => true);
      expect(await f.destination.deliver(f.scope, content, claim)).toEqual({ state: 'refused' });
      expect(claim).not.toHaveBeenCalled();
    }
  );

  it('refuses source revocation and never falls back to another chat', async () => {
    const f = fixture();
    expect(await f.destination.deliver(f.scope, content, () => false)).toEqual({
      state: 'refused',
    });
    f.bindings.getById.mockReturnValue(undefined as never);
    expect(await f.destination.deliver(f.scope, content, () => true)).toEqual({ state: 'refused' });
    expect(f.deliver).toHaveBeenCalledTimes(1);
  });
});
