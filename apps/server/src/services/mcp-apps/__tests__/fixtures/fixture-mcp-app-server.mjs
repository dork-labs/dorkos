#!/usr/bin/env node
/**
 * Minimal MCP Apps (SEP-1865) fixture server over stdio.
 *
 * Exposes one tool (`render_dashboard`) whose result carries the MCP-Apps
 * `_meta.ui.resourceUri` pointer (plus the deprecated flat `_meta["ui/resourceUri"]`
 * key), and one `ui://` HTML resource with the `text/html;profile=mcp-app`
 * mimetype. Used by:
 *   - the `_meta` survival spike (does the Claude Agent SDK preserve `_meta`?),
 *   - the mcp-apps service tests (resource read / scheme + mimetype enforcement).
 *
 * Kept dependency-light and JS (not TS) so it can be spawned directly by
 * `node <path>` as a stdio child in both spike and service tests.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const APP_URI = 'ui://dashboard/main';
const APP_MIME = 'text/html;profile=mcp-app';

const APP_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Fixture Dashboard</title></head>
  <body>
    <h1 id="title">Fixture Dashboard</h1>
    <p>Rendered by the MCP-Apps fixture server.</p>
    <script>
      // Announce readiness over the MCP-Apps postMessage bridge.
      window.parent.postMessage(
        { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} },
        '*'
      );
    </script>
  </body>
</html>`;

const server = new McpServer(
  { name: 'fixture-mcp-app', version: '0.0.1' },
  { capabilities: { tools: {}, resources: {} } }
);

// The ui:// app resource the tool result points at.
server.registerResource(
  'dashboard',
  APP_URI,
  {
    title: 'Fixture Dashboard',
    mimeType: APP_MIME,
    // MCP-Apps resource-level metadata the host reads for sandbox posture.
    _meta: {
      'ui/csp': "default-src 'none'; script-src 'self' 'unsafe-inline'",
      'ui/permissions': [],
    },
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: APP_MIME,
        text: APP_HTML,
        // Sandbox metadata the host reads off the resource contents (SEP-1865).
        _meta: {
          'ui/csp': "default-src 'none'; script-src 'self' 'unsafe-inline'",
          'ui/permissions': [],
        },
      },
    ],
  })
);

// The tool whose result references the ui:// resource via _meta.ui.
server.registerTool(
  'render_dashboard',
  {
    title: 'Render Dashboard',
    description: 'Render the fixture MCP-Apps dashboard. Call this to show the app.',
    inputSchema: { label: z.string().optional() },
  },
  async ({ label }) => ({
    content: [
      { type: 'text', text: `Dashboard ready${label ? `: ${label}` : ''}.` },
      // mcp-ui-style embedded UI resource (the de-facto pattern): the full app
      // HTML rides inline in the tool result content as an EmbeddedResource.
      {
        type: 'resource',
        resource: { uri: APP_URI, mimeType: APP_MIME, text: APP_HTML },
      },
      // A resource_link pointer variant (content-level, unlike _meta).
      { type: 'resource_link', uri: APP_URI, name: 'dashboard', mimeType: APP_MIME },
    ],
    _meta: {
      // Canonical nested form (SEP-1865, 2026-01-26).
      ui: { resourceUri: APP_URI, preferredDisplayMode: 'inline' },
      // Deprecated flat key — kept so the survival spike observes both shapes.
      'ui/resourceUri': APP_URI,
    },
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
