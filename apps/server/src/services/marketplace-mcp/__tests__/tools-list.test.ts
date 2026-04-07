/**
 * Smoke test: every marketplace MCP tool is discoverable via the standard
 * MCP `tools/list` capability.
 *
 * Catches accidental tool name typos and missing registrations in
 * {@link registerMarketplaceTools}. Unlike `marketplace-mcp-tools.test.ts`
 * (which mocks `McpServer.tool()` and asserts on the recorded call list),
 * this test stands up a REAL {@link McpServer} and verifies the tools land
 * in the SDK's internal `_registeredTools` registry — the same registry the
 * SDK consults when responding to a standard MCP `tools/list` request.
 *
 * The dependency bundle is intentionally a stub whose every method throws if
 * invoked. This proves we are checking REGISTRATION metadata, not handler
 * behavior — if a future change accidentally invokes a deps method during
 * registration, the test fails loudly instead of silently masking the bug.
 *
 * @module services/marketplace-mcp/__tests__/tools-list
 */
import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerMarketplaceTools, type MarketplaceMcpDeps } from '../marketplace-mcp-tools.js';

/**
 * Names of every marketplace MCP tool that `registerMarketplaceTools()` is
 * required to expose to MCP clients via `tools/list`. Kept in lockstep with
 * the canonical list in `marketplace-mcp-tools.test.ts`.
 */
const EXPECTED_TOOLS = [
  'marketplace_search',
  'marketplace_get',
  'marketplace_list_marketplaces',
  'marketplace_list_installed',
  'marketplace_recommend',
  'marketplace_install',
  'marketplace_uninstall',
  'marketplace_create_package',
] as const;

/**
 * Internal SDK shape used to introspect registered tools. The MCP SDK stores
 * tools in a private `_registeredTools` record keyed by tool name. This is the
 * same shape used by the integration test (`integration.test.ts`); if a future
 * SDK version moves the registry, both call sites need updating.
 *
 * Note: `_registeredTools` is a `Record<string, unknown>`, NOT a `Map`, so we
 * test membership via the `in` operator (or property access) rather than
 * `.has()`.
 */
interface RegisteredToolsContainer {
  _registeredTools: Record<string, unknown>;
}

/**
 * Build a stub `MarketplaceMcpDeps` whose every method throws if invoked.
 *
 * Tool registration in `registerMarketplaceTools()` only reads tool names,
 * descriptions, and Zod input schemas — it never invokes a deps method. Wiring
 * the stubs as throwing `vi.fn()` spies turns any future regression that
 * touches deps during registration into an immediate test failure rather than
 * a silent dependency leak.
 *
 * @returns A stub deps bundle suitable for registration-only smoke testing.
 */
function buildStubDeps(): MarketplaceMcpDeps {
  const explode = (method: string) => () => {
    throw new Error(
      `MarketplaceMcpDeps stub method '${method}' was invoked during tool registration; ` +
        `tools-list smoke test only checks REGISTRATION metadata, not handler behavior.`
    );
  };

  return {
    dorkHome: '/tmp/.dork-test-tools-list',
    installer: {
      preview: vi.fn(explode('installer.preview')),
      install: vi.fn(explode('installer.install')),
      update: vi.fn(explode('installer.update')),
    } as unknown as MarketplaceMcpDeps['installer'],
    sourceManager: {
      listSources: vi.fn(explode('sourceManager.listSources')),
      getSource: vi.fn(explode('sourceManager.getSource')),
      addSource: vi.fn(explode('sourceManager.addSource')),
      removeSource: vi.fn(explode('sourceManager.removeSource')),
      setEnabled: vi.fn(explode('sourceManager.setEnabled')),
    } as unknown as MarketplaceMcpDeps['sourceManager'],
    fetcher: {
      fetchMarketplaceJson: vi.fn(explode('fetcher.fetchMarketplaceJson')),
    } as unknown as MarketplaceMcpDeps['fetcher'],
    cache: {
      get: vi.fn(explode('cache.get')),
      set: vi.fn(explode('cache.set')),
    } as unknown as MarketplaceMcpDeps['cache'],
    uninstallFlow: {
      uninstall: vi.fn(explode('uninstallFlow.uninstall')),
    } as unknown as MarketplaceMcpDeps['uninstallFlow'],
    confirmationProvider: {
      requestInstallConfirmation: vi.fn(explode('confirmationProvider.requestInstallConfirmation')),
      resolve: vi.fn(explode('confirmationProvider.resolve')),
    } as unknown as MarketplaceMcpDeps['confirmationProvider'],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

describe('marketplace MCP tools/list discovery', () => {
  it('registers all 8 marketplace tools on a real McpServer', () => {
    const server = new McpServer({ name: 'tools-list-smoke', version: '1.0.0' });
    const deps = buildStubDeps();

    registerMarketplaceTools(server, deps);

    // Inspect the SDK's internal `_registeredTools` record. The MCP SDK uses
    // this same record to respond to standard `tools/list` requests, so an
    // entry being present here is equivalent to the tool being discoverable
    // by an external MCP client (Claude Code, Cursor, Codex).
    const registered = (server as unknown as RegisteredToolsContainer)._registeredTools;

    for (const toolName of EXPECTED_TOOLS) {
      expect(toolName in registered, `Expected tool '${toolName}' to be registered`).toBe(true);
    }
  });

  it('registers exactly the expected set with no stragglers from earlier suites', () => {
    const server = new McpServer({ name: 'tools-list-smoke', version: '1.0.0' });
    const deps = buildStubDeps();

    registerMarketplaceTools(server, deps);

    const registered = (server as unknown as RegisteredToolsContainer)._registeredTools;
    const registeredNames = Object.keys(registered).sort();
    const expectedNames = [...EXPECTED_TOOLS].sort();

    expect(registeredNames).toEqual(expectedNames);
  });

  it('does not invoke any deps method during registration', () => {
    const server = new McpServer({ name: 'tools-list-smoke', version: '1.0.0' });
    const deps = buildStubDeps();

    // If registration accidentally touches a deps method, the throwing stubs
    // turn the side effect into a synchronous failure here. The assertion is
    // `not.toThrow()` so the failure message in CI surfaces the offending
    // method name from the stub's error string.
    expect(() => registerMarketplaceTools(server, deps)).not.toThrow();
  });
});
