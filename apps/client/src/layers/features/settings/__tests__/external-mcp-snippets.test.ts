import { describe, it, expect } from 'vitest';
import { buildSnippets } from '../lib/external-mcp-snippets';

const ENDPOINT = 'http://localhost:6242/mcp';
const TOKEN = 'dork_mcp_local_abc123def456';

describe('buildSnippets', () => {
  it('embeds the real token in every client snippet when a token is provided', () => {
    // Purpose: a paste-ready config carries the actual Bearer token so the user
    // does not have to hand-edit a placeholder.
    const snippets = buildSnippets(ENDPOINT, TOKEN);
    for (const snippet of Object.values(snippets)) {
      expect(snippet).toContain(`Bearer ${TOKEN}`);
      expect(snippet).not.toContain('dork_mcp_YOUR_API_KEY');
    }
  });

  it('falls back to the placeholder when no token is available', () => {
    // Purpose: token-less callers still get a copyable shape to fill in later.
    const snippets = buildSnippets(ENDPOINT, null);
    for (const snippet of Object.values(snippets)) {
      expect(snippet).toContain('Bearer dork_mcp_YOUR_API_KEY');
      expect(snippet).not.toContain(TOKEN);
    }
  });

  it('embeds the endpoint URL in every snippet', () => {
    // Purpose: each client config points at this instance's MCP endpoint.
    const snippets = buildSnippets(ENDPOINT, TOKEN);
    for (const snippet of Object.values(snippets)) {
      expect(snippet).toContain(ENDPOINT);
    }
  });
});
