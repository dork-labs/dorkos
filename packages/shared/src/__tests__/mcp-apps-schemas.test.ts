import { describe, it, expect } from 'vitest';
import {
  McpAppRefSchema,
  McpAppResourceRequestSchema,
  McpAppResourceResponseSchema,
  McpAppPermissionSchema,
  UiCanvasContentSchema,
  ToolCallEventSchema,
  ToolCallPartSchema,
} from '../schemas.js';

/** MCP Apps (SEP-1865) schema round-trips — spec `mcp-apps-host` §2.2. */
describe('MCP Apps schemas', () => {
  it('McpAppRefSchema accepts a bare resourceUri and an optional display mode', () => {
    expect(McpAppRefSchema.parse({ resourceUri: 'ui://a/b' })).toEqual({ resourceUri: 'ui://a/b' });
    expect(
      McpAppRefSchema.parse({ resourceUri: 'ui://a/b', preferredDisplayMode: 'fullscreen' })
    ).toMatchObject({ preferredDisplayMode: 'fullscreen' });
  });

  it('ToolCallEvent and ToolCallPart carry an optional ui reference', () => {
    const ui = { resourceUri: 'ui://dash/main' };
    expect(
      ToolCallEventSchema.parse({ toolCallId: 't', toolName: 'x', status: 'complete', ui }).ui
    ).toEqual(ui);
    expect(
      ToolCallPartSchema.parse({
        type: 'tool_call',
        toolCallId: 't',
        toolName: 'x',
        status: 'complete',
        ui,
      }).ui
    ).toEqual(ui);
    // ui is optional — omitting it parses fine (codex/opencode path).
    expect(
      ToolCallEventSchema.parse({ toolCallId: 't', toolName: 'x', status: 'complete' }).ui
    ).toBeUndefined();
  });

  it('UiCanvasContent has an mcp_app variant', () => {
    const parsed = UiCanvasContentSchema.parse({
      type: 'mcp_app',
      serverName: 'fixture-app',
      uri: 'ui://dash/main',
      title: 'Dashboard',
    });
    expect(parsed).toMatchObject({ type: 'mcp_app', serverName: 'fixture-app' });
  });

  it('McpAppResourceRequest requires serverName and uri', () => {
    expect(McpAppResourceRequestSchema.safeParse({ serverName: 's', uri: 'ui://a' }).success).toBe(
      true
    );
    expect(McpAppResourceRequestSchema.safeParse({ serverName: '', uri: 'ui://a' }).success).toBe(
      false
    );
  });

  it('McpAppResourceResponse defaults permissions to an empty array', () => {
    const parsed = McpAppResourceResponseSchema.parse({ mimeType: 'text/html', text: '<html>' });
    expect(parsed.permissions).toEqual([]);
  });

  it('McpAppPermission is limited to the four feature-policy directives', () => {
    expect(McpAppPermissionSchema.safeParse('camera').success).toBe(true);
    expect(McpAppPermissionSchema.safeParse('clipboard-write').success).toBe(true);
    expect(McpAppPermissionSchema.safeParse('payment').success).toBe(false);
  });
});
