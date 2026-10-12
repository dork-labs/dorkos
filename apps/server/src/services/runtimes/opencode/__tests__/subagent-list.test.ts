/**
 * OpenCode's dispatchable agents become DorkOS subagents (DOR-2520): only
 * `subagent` and `all` modes, `model` as `providerID/modelID`, and an empty
 * list rather than a throw when the sidecar is not there.
 */
import { describe, it, expect, vi } from 'vitest';
import type { OpenCodeClientProvider } from '../sessions/session-mapper.js';
import { listOpenCodeSubagents } from '../subagent-list.js';

/** A provider whose sidecar answers `GET /agent` with `agents`. */
function providerListing(agents: unknown[]) {
  const agentsCall = vi.fn(async () => ({ data: agents }));
  const provider = {
    getClient: vi.fn(async () => ({ app: { agents: agentsCall } })),
  } as unknown as OpenCodeClientProvider;
  return { provider, agentsCall };
}

describe('listOpenCodeSubagents', () => {
  it('keeps subagent and all modes, and maps each to a DorkOS subagent', async () => {
    const { provider, agentsCall } = providerListing([
      { name: 'build', mode: 'primary', description: 'The main agent' },
      {
        name: 'reviewer',
        mode: 'subagent',
        description: 'Reviews a diff',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-5' },
      },
      { name: 'general', mode: 'all' },
    ]);

    expect(await listOpenCodeSubagents(provider, '/work/repo')).toEqual([
      { name: 'reviewer', description: 'Reviews a diff', model: 'anthropic/claude-sonnet-5' },
      { name: 'general', description: '' },
    ]);
    expect(agentsCall).toHaveBeenCalledWith({ query: { directory: expect.any(String) } });
  });

  it('answers an empty list, not a throw, when the sidecar is not running', async () => {
    const provider = {
      getClient: vi.fn(async () => {
        throw new Error('sidecar not running');
      }),
    } as unknown as OpenCodeClientProvider;

    await expect(listOpenCodeSubagents(provider, '/work/repo')).resolves.toEqual([]);
  });

  it('answers an empty list when the sidecar refuses the read', async () => {
    const provider = {
      getClient: vi.fn(async () => ({
        app: { agents: vi.fn(async () => ({ error: { message: 'nope' } })) },
      })),
    } as unknown as OpenCodeClientProvider;

    await expect(listOpenCodeSubagents(provider, '/work/repo')).resolves.toEqual([]);
  });
});
