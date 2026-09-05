import { describe, it, expect, vi } from 'vitest';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { enumerateOpenCodeMcpServers } from '../mcp/mcp-status.js';

const CWD = '/projects/demo';

/**
 * Minimal fake sidecar client exposing only the two endpoints
 * {@link enumerateOpenCodeMcpServers} touches. `statusResult`/`configResult`
 * are the raw `{ data }` (or thrown) responses each call returns.
 */
function fakeClient(opts: {
  status: () => Promise<{ data?: unknown; error?: unknown }>;
  config?: () => Promise<{ data?: unknown; error?: unknown }>;
}) {
  const status = vi.fn(opts.status);
  const config = vi.fn(opts.config ?? (async () => ({ data: {} })));
  return {
    client: { mcp: { status }, config: { get: config } } as unknown as OpencodeClient,
    status,
    config,
  };
}

describe('enumerateOpenCodeMcpServers', () => {
  it('joins live status with config transport type, keyed by directory', async () => {
    const { client, status, config } = fakeClient({
      status: async () => ({
        data: {
          fs: { status: 'connected' },
          remotey: { status: 'connected' },
        },
      }),
      config: async () => ({
        data: {
          mcp: {
            fs: { type: 'local', command: ['fs-server'] },
            remotey: { type: 'remote', url: 'https://example.com/mcp' },
          },
        },
      }),
    });

    const servers = await enumerateOpenCodeMcpServers(client, CWD);

    expect(servers).toEqual([
      { name: 'fs', type: 'stdio', status: 'connected' },
      { name: 'remotey', type: 'http', status: 'connected' },
    ]);
    expect(status).toHaveBeenCalledWith({ query: { directory: CWD } });
    expect(config).toHaveBeenCalledWith({ query: { directory: CWD } });
  });

  it('maps every OpenCode status discriminant to the neutral status + error', async () => {
    const { client } = fakeClient({
      status: async () => ({
        data: {
          up: { status: 'connected' },
          off: { status: 'disabled' },
          auth: { status: 'needs_auth' },
          reg: { status: 'needs_client_registration', error: 'register the client' },
          bad: { status: 'failed', error: 'boom' },
        },
      }),
    });

    const servers = await enumerateOpenCodeMcpServers(client, CWD);

    expect(servers).toEqual([
      { name: 'up', type: 'stdio', status: 'connected' },
      { name: 'off', type: 'stdio', status: 'disabled' },
      { name: 'auth', type: 'stdio', status: 'needs-auth' },
      { name: 'reg', type: 'stdio', status: 'needs-auth', error: 'register the client' },
      { name: 'bad', type: 'stdio', status: 'failed', error: 'boom' },
    ]);
  });

  it('returns [] when no servers are configured', async () => {
    const { client } = fakeClient({ status: async () => ({ data: {} }) });
    expect(await enumerateOpenCodeMcpServers(client, CWD)).toEqual([]);
  });

  it('returns null when the status read throws (sidecar unreachable)', async () => {
    const { client } = fakeClient({
      status: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(await enumerateOpenCodeMcpServers(client, CWD)).toBeNull();
  });

  it('returns null when the status response carries no data', async () => {
    const { client } = fakeClient({ status: async () => ({ error: 'nope' }) });
    expect(await enumerateOpenCodeMcpServers(client, CWD)).toBeNull();
  });

  it('defaults transports to stdio when the config read fails', async () => {
    const { client, config } = fakeClient({
      status: async () => ({ data: { fs: { status: 'connected' }, r: { status: 'connected' } } }),
      config: async () => {
        throw new Error('config unavailable');
      },
    });

    const servers = await enumerateOpenCodeMcpServers(client, CWD);

    expect(servers).toEqual([
      { name: 'fs', type: 'stdio', status: 'connected' },
      { name: 'r', type: 'stdio', status: 'connected' },
    ]);
    expect(config).toHaveBeenCalled();
  });

  it('defaults a server with no matching config entry to stdio', async () => {
    const { client } = fakeClient({
      status: async () => ({ data: { orphan: { status: 'connected' } } }),
      config: async () => ({ data: { mcp: { somethingElse: { type: 'remote', url: 'x' } } } }),
    });

    expect(await enumerateOpenCodeMcpServers(client, CWD)).toEqual([
      { name: 'orphan', type: 'stdio', status: 'connected' },
    ]);
  });
});
