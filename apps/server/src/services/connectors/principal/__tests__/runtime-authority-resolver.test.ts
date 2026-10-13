import { describe, expect, it, vi } from 'vitest';
import { CanonicalConnectorRuntimeAuthorityResolver } from '../runtime-authority-resolver.js';
import { ConnectorRuntimeAuthorityError } from '../runtime-principal-service.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;

describe('CanonicalConnectorRuntimeAuthorityResolver', () => {
  it('requires an exact durable runtime, session path, and live stable Mesh agent', async () => {
    const sessions = {
      resolveSessionRuntime: vi.fn(async () => ({ type: 'codex', bound: true })),
      getSessionAgentPath: vi.fn(async () => '/projects/a'),
    };
    const mesh = { getByPath: vi.fn(() => ({ id: 'agent-a' })) };
    const resolver = new CanonicalConnectorRuntimeAuthorityResolver({
      sessions,
      mesh,
      owner: OWNER,
    });
    const input = {
      runtime: 'codex' as const,
      canonicalSessionId: 'session-a',
      agentPath: '/projects/a',
      canonicalCwd: '/projects/a',
      signal: new AbortController().signal,
    };

    await expect(resolver.authorizeTurn(input)).resolves.toEqual({
      owner: OWNER,
      agentId: 'agent-a',
    });

    sessions.resolveSessionRuntime.mockResolvedValueOnce({ type: 'codex', bound: false });
    await expect(resolver.authorizeTurn(input)).rejects.toThrow(
      'Canonical runtime authority could not be verified.'
    );
    sessions.getSessionAgentPath.mockResolvedValueOnce('/projects/other');
    await expect(resolver.authorizeTurn(input)).rejects.toThrow(
      'Canonical runtime authority could not be verified.'
    );
    mesh.getByPath.mockReturnValueOnce({ id: 'agent-b' });
    await expect(
      resolver.revalidateTurn({
        kind: 'runtime',
        owner: OWNER,
        bindingId: 'binding-a',
        runtime: 'codex',
        canonicalSessionId: 'session-a',
        agentId: 'agent-a',
        agentPath: '/projects/a',
        canonicalCwd: '/projects/a',
      })
    ).resolves.toBe(false);
  });

  it('says a chat has no recorded agent apart from a real failure (DOR-2752)', async () => {
    const sessions = {
      resolveSessionRuntime: vi.fn(async () => ({ type: 'codex', bound: true })),
      getSessionAgentPath: vi.fn(async (): Promise<string | null> => null),
    };
    const resolver = new CanonicalConnectorRuntimeAuthorityResolver({
      sessions,
      mesh: { getByPath: vi.fn(() => ({ id: 'agent-a' })) },
      owner: OWNER,
    });
    const input = {
      runtime: 'codex' as const,
      canonicalSessionId: 'session-a',
      agentPath: '/projects/a',
      canonicalCwd: '/projects/a',
      signal: new AbortController().signal,
    };

    await expect(resolver.authorizeTurn(input)).rejects.toEqual(
      expect.objectContaining<Partial<ConnectorRuntimeAuthorityError>>({ code: 'agent_unrecorded' })
    );

    sessions.getSessionAgentPath.mockRejectedValueOnce(new Error('database is locked'));
    const failure = await resolver.authorizeTurn(input).catch((err: unknown) => err);
    expect(failure).not.toBeInstanceOf(ConnectorRuntimeAuthorityError);
  });
});
