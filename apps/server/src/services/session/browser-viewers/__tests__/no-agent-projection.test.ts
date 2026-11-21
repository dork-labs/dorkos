import { describe, expect, it } from 'vitest';
import { composeCapabilityRegistryForDocs } from '../../../core/self-description/dorkos-registry.js';
import { capabilitiesForMcpServer } from '../../../core/capabilities/mcp-projection.js';
import { MCP_TOOL_TIERS } from '../../../core/mcp-tool-tiers.js';

const viewerSurface = /browser[_.-]?viewers?|screencast|page[_.-]?stream/i;

describe('person viewer projection boundary', () => {
  it('keeps viewing out of the complete capability catalog and both MCP projections', () => {
    const registry = composeCapabilityRegistryForDocs();
    // Prove the browser domain was included rather than passing on an empty registry.
    expect(registry.get('local_browser.observe')).toBeDefined();
    expect(
      registry.capabilities.filter((cap) =>
        viewerSurface.test(JSON.stringify({ id: cap.id, surfaces: cap.surfaces }))
      )
    ).toEqual([]);
    for (const server of ['in-session', 'external'] as const) {
      const projected = capabilitiesForMcpServer(registry, server);
      expect(projected.length).toBeGreaterThan(0);
      expect(projected.filter((cap) => viewerSurface.test(JSON.stringify(cap.surfaces)))).toEqual(
        []
      );
    }
    const handRegistered = Object.keys(MCP_TOOL_TIERS);
    expect(handRegistered.length).toBeGreaterThan(0);
    expect(handRegistered.filter((name) => viewerSurface.test(name))).toEqual([]);
  });
});
