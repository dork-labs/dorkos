/**
 * Registration test for the in-session operator tools (`getOperatorTools`).
 *
 * Proves the same six self-service & observability tools that back the external
 * `/mcp` server are registered on the in-session `dorkos` server, so the user's
 * own agent inside a DorkOS session gets them too.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';

import { getOperatorTools } from '../operator-tools.js';
import type { McpToolDeps } from '../types.js';

/** The six operator tools both servers must expose. */
const EXPECTED_TOOLS = [
  'activity_list',
  'config_get',
  'check_update',
  'agents_recent_activity',
  'update_agent',
  'config_patch',
] as const;

/** Minimal SDK tool-definition shape exercised by this test. */
interface SdkTool {
  name: string;
  description: string;
}

function buildDeps(): McpToolDeps {
  return {
    transcriptReader: {} as McpToolDeps['transcriptReader'],
    defaultCwd: '/tmp/test',
  };
}

describe('getOperatorTools — registration', () => {
  it('registers all six operator tools from the shared descriptors', () => {
    const tools = getOperatorTools(buildDeps()) as unknown as SdkTool[];
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('carries a non-empty description on every tool', () => {
    const tools = getOperatorTools(buildDeps()) as unknown as SdkTool[];
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
    }
  });
});
