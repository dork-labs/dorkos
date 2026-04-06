/**
 * External MCP setup snippet builders.
 *
 * Pure helpers that produce the per-client configuration JSON shown in the
 * External MCP card's "Setup Instructions" block. Extracted from
 * `ExternalMcpCard.tsx` so the snippet shapes can be unit-tested independently
 * and reused without pulling in React.
 *
 * @module features/settings/lib/external-mcp-snippets
 */

/**
 * Setup instruction snippets for the External MCP server, keyed by client.
 *
 * Each value is a copy-pasteable string: JSON for editor configs, or a shell
 * command for the Claude Code CLI.
 */
export interface ExternalMcpSnippets {
  /** JSON config block for Claude Code's `~/.claude.json` `mcpServers` map. */
  claudeCode: string;
  /** Shell command for `claude mcp add-json` to register the server via the CLI. */
  claudeCodeCli: string;
  /** JSON config block for Cursor's `mcp.json`. */
  cursor: string;
  /** JSON config block for Windsurf's `mcp_config.json`. */
  windsurf: string;
}

/**
 * Build the per-client setup snippets for the External MCP endpoint.
 *
 * When `apiKey` is provided, the actual key is embedded in the `Authorization`
 * header. Otherwise a `dork_mcp_YOUR_API_KEY` placeholder is used so the user
 * can copy the snippet shape and fill in their own key later.
 *
 * @param endpoint - Fully-qualified URL of the DorkOS external MCP endpoint.
 * @param apiKey - Generated API key, or `null` to render a placeholder.
 * @returns Snippet strings keyed by client.
 */
export function buildSnippets(endpoint: string, apiKey: string | null): ExternalMcpSnippets {
  const authHeader = apiKey ? `Bearer ${apiKey}` : 'Bearer dork_mcp_YOUR_API_KEY';

  return {
    claudeCode: JSON.stringify(
      {
        mcpServers: {
          'dorkos-external': {
            type: 'http',
            url: endpoint,
            headers: { Authorization: authHeader },
          },
        },
      },
      null,
      2
    ),
    claudeCodeCli: `claude mcp add-json dorkos-external '${JSON.stringify({
      type: 'http',
      url: endpoint,
      headers: { Authorization: authHeader },
    })}'`,
    cursor: JSON.stringify(
      {
        mcpServers: {
          'dorkos-external': {
            url: endpoint,
            headers: { Authorization: authHeader },
          },
        },
      },
      null,
      2
    ),
    windsurf: JSON.stringify(
      {
        mcpServers: {
          'dorkos-external': {
            serverUrl: endpoint,
            headers: { Authorization: authHeader },
          },
        },
      },
      null,
      2
    ),
  };
}
