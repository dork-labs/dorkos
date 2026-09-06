import { describe, expect, it, vi } from 'vitest';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type { ConnectPoll } from '@dorkos/shared/connector-provider';
import { ConnectorFlowBindings } from '../flow-bindings.js';

describe('ConnectorFlowBindings', () => {
  it('caches only the schema-safe terminal DTO and polls the provider once', async () => {
    const provider = new FakeConnectorProvider({ type: 'oauth-fixture', custody: 'managed' });
    const { flowId } = await provider.startConnect('gmail');
    const connected = await provider.pollConnect(flowId);
    const providerResult = {
      ...connected,
      authorizeUrl: 'https://oauth.example/callback?code=secret',
      account: {
        ...connected.account!,
        accessToken: 'must-not-be-retained',
      },
    } as ConnectPoll;
    const pollConnect = vi.spyOn(provider, 'pollConnect').mockResolvedValue(providerResult);
    const bindings = new ConnectorFlowBindings();
    const publicFlowId = bindings.record(flowId, provider);

    const first = await bindings.poll(publicFlowId);
    const repeated = await bindings.poll(publicFlowId);

    expect(first).toEqual(repeated);
    expect(first).not.toHaveProperty('authorizeUrl');
    expect(first?.account).not.toHaveProperty('accessToken');
    expect(pollConnect).toHaveBeenCalledTimes(1);
  });

  it('shares one provider poll across concurrent callers', async () => {
    const provider = new FakeConnectorProvider({ type: 'oauth-fixture', custody: 'managed' });
    const { flowId } = await provider.startConnect('gmail');
    const connected = await provider.pollConnect(flowId);
    let finishPoll: ((result: ConnectPoll) => void) | undefined;
    const pollConnect = vi.spyOn(provider, 'pollConnect').mockImplementation(
      () =>
        new Promise<ConnectPoll>((resolve) => {
          finishPoll = resolve;
        })
    );
    const bindings = new ConnectorFlowBindings();
    const publicFlowId = bindings.record(flowId, provider);

    const first = bindings.poll(publicFlowId);
    const concurrent = bindings.poll(publicFlowId);
    expect(pollConnect).toHaveBeenCalledTimes(1);

    finishPoll?.(connected);
    await expect(Promise.all([first, concurrent])).resolves.toEqual([connected, connected]);
  });
});
