import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_RUNTIME_AUTHORIZATION_HEADER,
  CONNECTOR_RUNTIME_CWD_HEADER,
  CONNECTOR_RUNTIME_HEADER_ENV,
  CONNECTOR_RUNTIME_KIND_HEADER,
  CONNECTOR_RUNTIME_MCP_SERVER_NAME,
  connectorRuntimeHeaders,
} from '../../connector-tools.js';
import { buildCodexOptions } from '../codex-options.js';

describe('Codex connector runtime MCP injection', () => {
  it('keeps every header value out of config and visible argv material', () => {
    const secret = 'runtime-bearer-must-not-enter-argv';
    const cwd = '/repo with spaces';
    const injection = {
      url: 'http://127.0.0.1:4341/mcp',
      agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
      headers: connectorRuntimeHeaders({ bearer: secret, runtime: 'codex', canonicalCwd: cwd }),
    };

    const options = buildCodexOptions('/bin/codex', undefined, undefined, null, injection);
    const configText = JSON.stringify(options.config);
    const server = (
      options.config?.mcp_servers as Record<
        string,
        { url: string; env_http_headers: Record<string, string> }
      >
    )[CONNECTOR_RUNTIME_MCP_SERVER_NAME];

    expect(configText).not.toContain(secret);
    expect(configText).not.toContain(cwd);
    expect(server).toEqual({
      url: injection.url,
      env_http_headers: {
        [CONNECTOR_RUNTIME_AUTHORIZATION_HEADER]: CONNECTOR_RUNTIME_HEADER_ENV.authorization,
        [CONNECTOR_RUNTIME_KIND_HEADER]: CONNECTOR_RUNTIME_HEADER_ENV.runtime,
        [CONNECTOR_RUNTIME_CWD_HEADER]: CONNECTOR_RUNTIME_HEADER_ENV.cwd,
      },
    });
    expect(options.env).toMatchObject({
      [CONNECTOR_RUNTIME_HEADER_ENV.authorization]: `Bearer ${secret}`,
      [CONNECTOR_RUNTIME_HEADER_ENV.runtime]: 'codex',
      [CONNECTOR_RUNTIME_HEADER_ENV.cwd]: encodeURIComponent(cwd),
    });
  });

  it('fails closed instead of putting an unmapped header into config', () => {
    expect(() =>
      buildCodexOptions('/bin/codex', undefined, undefined, null, {
        url: 'http://127.0.0.1:4341/mcp',
        agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
        headers: { 'X-Unmapped-Secret': 'secret' },
      })
    ).toThrow(/no environment variable is defined/);
  });
});
