import { describe, expect, it } from 'vitest';
import { connectorExecutionDomain } from '../execution-capabilities.js';

/** Run one capability with no verified caller and return what the agent reads. */
async function refusalWithoutCaller(id: string, context: object = {}): Promise<unknown> {
  const capability = connectorExecutionDomain.capabilities.find((entry) => entry.id === id)!;
  const deps = {
    connectorExecutionDeps: { authorization: { preflight: () => undefined } },
  } as never;
  const run = capability.preflight ?? capability.invoke;
  try {
    await run(deps, {} as never, context as never);
  } catch (error) {
    return (error as { payload?: unknown }).payload;
  }
  throw new Error('expected a refusal');
}

describe('connector execution refusals without a verified caller', () => {
  it('say what happened in plain words, never "principal"', async () => {
    await expect(refusalWithoutCaller('connectors.execute_read')).resolves.toEqual({
      error: 'DorkOS couldn’t tell who is asking, so it didn’t do this.',
      code: 'CONNECTOR_PRINCIPAL_REQUIRED',
    });
    // A caller that isn't an agent's chat turn can't list what that turn may use.
    const notATurn = { serverPrincipal: { claims: { kind: 'agent', agentId: 'a' } } };
    await expect(
      refusalWithoutCaller('connectors.list_granted_connections', notATurn)
    ).resolves.toEqual({
      error:
        'DorkOS couldn’t tell which agent in which chat is asking, so it can’t list connected apps here.',
      code: 'CONNECTOR_PRINCIPAL_REQUIRED',
    });
  });
});
