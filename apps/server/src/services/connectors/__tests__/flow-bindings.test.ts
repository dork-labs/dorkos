import { describe, expect, it } from 'vitest';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type { ConnectorConnectPollResponse } from '@dorkos/shared/connector-provider';
import type { ConnectorProviderInstanceId } from '@dorkos/shared/connector-schemas';
import { ConnectorFlowBindings, type ConnectorProviderFlowPoll } from '../flow-bindings.js';

describe('ConnectorFlowBindings', () => {
  it('keeps colliding provider flow ids bound to the exact provider instance', () => {
    // The injected factory also collides once, proving a public ID never
    // replaces an existing route even when its entropy source repeats.
    const ids = ['public-flow-a', 'public-flow-a', 'public-flow-b'];
    const bindings = new ConnectorFlowBindings(() => ids.shift()!);
    const firstProvider = new FakeConnectorProvider({
      instanceId: 'composio-personal' as ConnectorProviderInstanceId,
    });
    const secondProvider = new FakeConnectorProvider({
      instanceId: 'composio-work' as ConnectorProviderInstanceId,
    });

    const first = bindings.record('provider-flow-1', firstProvider);
    const second = bindings.record('provider-flow-1', secondProvider);

    expect(first).not.toBe(second);
    expect(bindings.providerFor(first)).toEqual({
      state: 'active',
      provider: firstProvider,
      providerFlowId: 'provider-flow-1',
    });
    expect(bindings.providerFor(second)).toEqual({
      state: 'active',
      provider: secondProvider,
      providerFlowId: 'provider-flow-1',
    });
  });

  it('retains terminal replay while evicting the least recently used bounded entry', () => {
    const ids = ['public-a', 'public-b', 'public-c'];
    const bindings = new ConnectorFlowBindings(() => ids.shift()!, 2);
    const provider = new FakeConnectorProvider({
      instanceId: 'composio-personal' as ConnectorProviderInstanceId,
    });
    const first = bindings.record('private-a', provider);
    const second = bindings.record('private-b', provider);
    const firstBinding = bindings.providerFor(first)!;
    expect(firstBinding.state).toBe('active');
    if (firstBinding.state !== 'active') throw new Error('expected active flow');
    bindings.recordTerminal(first, firstBinding, {
      status: 'failed',
      error: 'Authorization was denied.',
    });
    expect(bindings.providerFor(first)).toEqual({
      state: 'terminal',
      result: { status: 'failed', error: 'Authorization was denied.' },
    });

    const third = bindings.record('private-c', provider);
    expect(bindings.providerFor(second)).toBeUndefined();
    expect(bindings.providerFor(first)).toMatchObject({ state: 'terminal' });
    expect(bindings.providerFor(third)).toMatchObject({
      state: 'active',
      providerFlowId: 'private-c',
    });
  });

  it('rejects a provider result that returns after its active binding was evicted', () => {
    const ids = ['public-a', 'public-b'];
    const bindings = new ConnectorFlowBindings(() => ids.shift()!, 1);
    const provider = new FakeConnectorProvider({
      instanceId: 'composio-personal' as ConnectorProviderInstanceId,
    });
    const first = bindings.record('private-a', provider);
    const captured = bindings.providerFor(first)!;
    if (captured.state !== 'active') throw new Error('expected active flow');
    bindings.record('private-b', provider);

    expect(
      bindings.recordTerminal(first, captured, {
        status: 'failed',
        error: 'late result',
      })
    ).toBe(false);
    expect(bindings.providerFor(first)).toBeUndefined();
  });

  it('coalesces concurrent polls and protects them from LRU eviction', async () => {
    const ids = ['public-a', 'public-b'];
    const bindings = new ConnectorFlowBindings(() => ids.shift()!, 1);
    const provider = new FakeConnectorProvider({
      instanceId: 'composio-personal' as ConnectorProviderInstanceId,
    });
    const first = bindings.record('private-a', provider);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const poller = async () => {
      calls += 1;
      await blocked;
      return { status: 'failed' as const, error: 'Authorization was denied.' };
    };
    const publicize = ({ result }: ConnectorProviderFlowPoll): ConnectorConnectPollResponse => ({
      status: result.status,
      ...(result.error && { error: result.error }),
    });

    const firstPoll = bindings.poll(first, poller, publicize);
    const concurrentPoll = bindings.poll(first, poller, publicize);
    expect(() => bindings.record('private-b', provider)).toThrow(/already in progress/i);
    release();

    await expect(firstPoll).resolves.toEqual({
      status: 'failed',
      error: 'Authorization was denied.',
    });
    await expect(concurrentPoll).resolves.toEqual({
      status: 'failed',
      error: 'Authorization was denied.',
    });
    expect(calls).toBe(1);
  });

  it('strips extra provider-shaped fields before retaining a public terminal replay', () => {
    const bindings = new ConnectorFlowBindings(() => 'public-a');
    const provider = new FakeConnectorProvider({
      instanceId: 'composio-personal' as ConnectorProviderInstanceId,
    });
    const flowId = bindings.record('private-flow', provider);
    const active = bindings.providerFor(flowId)!;
    if (active.state !== 'active') throw new Error('expected active flow');

    bindings.recordTerminal(flowId, active, {
      status: 'connected',
      account: {
        id: 'connection-a',
        toolkit: 'gmail',
        label: 'work',
        status: 'active',
        custody: 'managed',
        disclosure: 'Stored by the provider.',
        externalAccountRef: 'private-account',
        url: 'https://private.example/mcp',
      },
      providerSession: 'private-session',
    } as never);

    expect(bindings.providerFor(flowId)).toEqual({
      state: 'terminal',
      result: {
        status: 'connected',
        account: {
          id: 'connection-a',
          toolkit: 'gmail',
          label: 'work',
          status: 'active',
          custody: 'managed',
          disclosure: 'Stored by the provider.',
        },
      },
    });
  });
});
