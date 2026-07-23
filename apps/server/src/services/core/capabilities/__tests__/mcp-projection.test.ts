/**
 * Byte-compatibility proof for the operator + marketplace MCP projection
 * (spec `capability-registry`, task 2.2).
 *
 * These assertions pin the migrated capabilities to the exact tool surface the
 * pre-migration descriptor tables produced: the same tool names on both MCP
 * servers, the same four-hint annotation matrix, and the same read-only
 * carve-out. If a future edit drifts any of these, this test fails rather than
 * the divergence reaching a server.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

import { operatorDomain } from '../../operator/operator-capabilities.js';
import { marketplaceDomain } from '../../../marketplace-mcp/marketplace-capabilities.js';
import {
  capabilitiesForMcpServer,
  deriveMcpAnnotations,
  readOnlyCarveOutToolNames,
} from '../mcp-projection.js';
import { composeRegistry } from '../index.js';
import { noopLogger } from '@dorkos/shared/logger';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';
import type { MarketplaceMcpDeps } from '../../../marketplace-mcp/marketplace-mcp-tools.js';

// Stub deps: this test inspects the static projection (tool names, annotations,
// carve-out), never invokes a handler — but each domain's boot-time `assertDeps`
// runs during composition, so supply empty bags to satisfy it.
const registry = composeRegistry([operatorDomain, marketplaceDomain], {
  logger: noopLogger,
  operatorDeps: {} as McpToolDeps,
  marketplaceDeps: {} as MarketplaceMcpDeps,
});

/** The exact tool set both MCP servers advertised before the migration. */
const EXPECTED_TOOL_NAMES = [
  'activity_list',
  'config_get',
  'check_update',
  'agents_recent_activity',
  'update_agent',
  'config_patch',
  'marketplace_search',
  'marketplace_get',
  'marketplace_list_marketplaces',
  'marketplace_list_installed',
  'marketplace_recommend',
  'marketplace_install',
  'marketplace_uninstall',
  'marketplace_create_package',
].sort();

/**
 * The exact four-hint annotation each tool carried under the phase-1 descriptor
 * tables (`ToolAnnotationPresets`). The migration must regenerate these from
 * tier + per-tool overrides without a single hint changing.
 */
const EXPECTED_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // readOnlyLocal
  activity_list: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  config_get: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  agents_recent_activity: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  marketplace_list_marketplaces: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  marketplace_list_installed: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  // readOnlyOpenWorld
  check_update: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  marketplace_search: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  marketplace_get: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  marketplace_recommend: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  // mutateUpdateLocal
  update_agent: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  config_patch: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  // mutateCreateOpenWorld
  marketplace_install: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  // mutateDeleteLocal
  marketplace_uninstall: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // mutateCreateLocal
  marketplace_create_package: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

/** The five marketplace + four operator read-only lookups in the carve-out. */
const EXPECTED_CARVE_OUT = [
  'activity_list',
  'config_get',
  'check_update',
  'agents_recent_activity',
  'marketplace_search',
  'marketplace_get',
  'marketplace_list_marketplaces',
  'marketplace_list_installed',
  'marketplace_recommend',
].sort();

describe('operator + marketplace MCP projection', () => {
  it('advertises the same 14 tools on the in-session server', () => {
    const names = capabilitiesForMcpServer(registry, 'in-session')
      .map((c) => c.surfaces.mcp!.toolName)
      .sort();
    expect(names).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('advertises the same 14 tools on the external server', () => {
    const names = capabilitiesForMcpServer(registry, 'external')
      .map((c) => c.surfaces.mcp!.toolName)
      .sort();
    expect(names).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('the two servers advertise identical tool sets', () => {
    const inSession = capabilitiesForMcpServer(registry, 'in-session')
      .map((c) => c.surfaces.mcp!.toolName)
      .sort();
    const external = capabilitiesForMcpServer(registry, 'external')
      .map((c) => c.surfaces.mcp!.toolName)
      .sort();
    expect(inSession).toEqual(external);
  });

  it('regenerates the exact phase-1 annotation matrix for every tool', () => {
    for (const cap of registry.capabilities) {
      const name = cap.surfaces.mcp!.toolName;
      expect(deriveMcpAnnotations(cap), name).toEqual(EXPECTED_ANNOTATIONS[name]);
    }
  });

  it('derives the read-only carve-out from readOnlyCarveOut flags', () => {
    const derived = [...readOnlyCarveOutToolNames(registry.capabilities)].sort();
    expect(derived).toEqual(EXPECTED_CARVE_OUT);
  });
});
