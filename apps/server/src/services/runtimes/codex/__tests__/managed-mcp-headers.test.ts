/**
 * Where a managed MCP server's HTTP headers travel on a Codex turn (DOR-993).
 *
 * The Codex SDK flattens `CodexOptions.config` into `--config key=value`
 * arguments on the `codex exec` command line, so a header value written into
 * `http_headers` is an entry in the spawned process's argv — readable by any
 * process running as this user with a bare `ps`. Managed servers routinely carry
 * credentials there: the OAuth bearer DorkOS merges in for a signed-in server
 * (`agent-mcp-server-service.mergeOAuthHeaders`), and whatever API key the
 * operator typed into a static header.
 *
 * These drive the REAL runtime seam — a resolver in, the options the `Codex`
 * constructor actually received out — so a redirection that is implemented but
 * never wired fails here.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type {
  ManagedMcpServerResolver,
  McpAppServerConnection,
} from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CodexRuntime } from '../codex-runtime.js';
import { CodexThreadMap } from '../thread-map.js';
import { codexSimpleTurn, makeMockThread } from './codex-scenarios.js';

vi.mock('../check-dependencies.js', () => ({ checkCodexDependencies: vi.fn(() => []) }));
vi.mock('../enumerate-mcp-servers.js', () => ({
  enumerateCodexMcpServers: vi.fn(async () => null),
}));
vi.mock('../scan-skill-commands.js', () => ({ scanSkillCommands: vi.fn(() => []) }));

/** Records every `Codex` construction, which is what these tests read. */
const sdkMocks = vi.hoisted(() => ({
  constructorOptions: [] as (Record<string, unknown> | undefined)[],
}));

vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options?: Record<string, unknown>) {
      sdkMocks.constructorOptions.push(options);
    }
    startThread(): unknown {
      return {
        id: 'codex-thread-0001',
        runStreamed: async () => ({ events: makeMockThread(codexSimpleTurn('ok')).runStreamed() }),
      };
    }
    resumeThread(): unknown {
      return this.startThread();
    }
  },
}));

const CWD = '/projects/demo';
const BEARER = 'Bearer ya29.a0-live-oauth-access-token';

/** A resolver handing every cwd the given servers. */
function resolverFor(servers: Record<string, McpAppServerConnection>): ManagedMcpServerResolver {
  return { injectableServersForCwd: () => servers };
}

/** A runtime wired to `servers`, driven through one turn. */
async function turnWith(servers: Record<string, McpAppServerConnection>): Promise<{
  config: unknown;
  env: Record<string, string> | undefined;
  mcpServers: Record<string, Record<string, unknown>>;
}> {
  const runtime = new CodexRuntime({
    threadMap: new CodexThreadMap(createTestDb()),
    resolveBinary: async () => '/bin/codex',
    defaultCwd: CWD,
  });
  runtime.setManagedMcpServers(resolverFor(servers));
  await drain(runtime.sendMessage('s1', 'hello', { cwd: CWD }));

  const options = (sdkMocks.constructorOptions.at(-1) ?? {}) as {
    config?: { mcp_servers?: Record<string, Record<string, unknown>> };
    env?: Record<string, string>;
  };
  return {
    config: options.config,
    env: options.env,
    mcpServers: options.config?.mcp_servers ?? {},
  };
}

/** Drain a sendMessage generator, discarding the events. */
async function drain(gen: AsyncGenerator<StreamEvent>): Promise<void> {
  for await (const _event of gen) {
    // The constructor options are what these tests read.
  }
}

describe('a managed MCP server carrying credentials on a Codex turn', () => {
  beforeEach(() => {
    sdkMocks.constructorOptions.length = 0;
  });

  it('keeps an OAuth bearer out of the config the SDK flattens into argv', async () => {
    // The vulnerability itself. Asserted by serialising the WHOLE config and
    // searching it rather than by checking the one key the value used to live
    // under: the SDK flattens nested config, so a value could reappear under
    // any path and a key-specific check would not notice.
    const { config } = await turnWith({
      notion: {
        transport: 'http',
        url: 'https://mcp.notion.com/mcp',
        headers: { Authorization: BEARER },
      },
    });

    const serialized = JSON.stringify(config ?? {});
    expect(serialized).not.toContain(BEARER);
    expect(serialized).not.toContain('Bearer ');
  });

  it('still delivers the header — the env carries the value, the config only its variable name', async () => {
    const { mcpServers, env } = await turnWith({
      notion: {
        transport: 'http',
        url: 'https://mcp.notion.com/mcp',
        headers: { Authorization: BEARER },
      },
    });

    const entry = mcpServers['notion'];
    expect(entry?.['url']).toBe('https://mcp.notion.com/mcp');
    expect(entry?.['http_headers']).toBeUndefined();

    const names = entry?.['env_http_headers'] as Record<string, string> | undefined;
    const varName = names?.['Authorization'];
    expect(varName).toEqual(expect.any(String));
    expect(env?.[varName as string]).toBe(BEARER);
  });

  it('gives an operator-set static header the same treatment', async () => {
    // A static header is not obviously less sensitive than an OAuth one — the
    // field is where people paste API keys — so there is no header this path
    // leaves on `http_headers`.
    const { config, mcpServers, env } = await turnWith({
      internal: {
        transport: 'http',
        url: 'https://internal.example.com/mcp',
        headers: { 'X-Api-Key': 'sk-static-operator-key' },
      },
    });

    expect(JSON.stringify(config ?? {})).not.toContain('sk-static-operator-key');
    const names = mcpServers['internal']?.['env_http_headers'] as
      Record<string, string> | undefined;
    expect(env?.[names?.['X-Api-Key'] as string]).toBe('sk-static-operator-key');
  });

  it('leaves a headerless server byte-identical, and adds no env for it', async () => {
    // The discriminator: the redirection must not reshape servers that carry
    // nothing to protect, nor cost the turn its shared-client path.
    const { mcpServers, env } = await turnWith({
      files: { transport: 'stdio', command: 'npx', args: ['-y', 'server-filesystem'] },
      plain: { transport: 'http', url: 'https://example.com/mcp' },
    });

    expect(mcpServers['files']).toEqual({ command: 'npx', args: ['-y', 'server-filesystem'] });
    expect(mcpServers['plain']).toEqual({ url: 'https://example.com/mcp' });
    expect(Object.keys(env ?? {}).filter((key) => key.startsWith('DORKOS_MCP_HDR_'))).toEqual([]);
  });

  it('gives two servers distinct variables even when their names sanitise alike', async () => {
    // `my-server` and `my_server` both reduce to MY_SERVER. One variable for
    // two credentials would silently send one server the other's token.
    const { mcpServers, env } = await turnWith({
      'my-server': {
        transport: 'http',
        url: 'https://a.example.com/mcp',
        headers: { Authorization: 'Bearer aaa' },
      },
      my_server: {
        transport: 'http',
        url: 'https://b.example.com/mcp',
        headers: { Authorization: 'Bearer bbb' },
      },
    });

    const first = (mcpServers['my-server']?.['env_http_headers'] as Record<string, string>)[
      'Authorization'
    ];
    const second = (mcpServers['my_server']?.['env_http_headers'] as Record<string, string>)[
      'Authorization'
    ];
    expect(first).not.toBe(second);
    expect(env?.[first as string]).toBe('Bearer aaa');
    expect(env?.[second as string]).toBe('Bearer bbb');
  });
});
