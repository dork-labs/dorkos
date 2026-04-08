import { describe, it, expect, vi } from 'vitest';

import { registerMarketplaceTools, type MarketplaceMcpDeps } from '../marketplace-mcp-tools.js';
import { AutoApproveConfirmationProvider } from '../confirmation-provider.js';

/**
 * Build a stub `McpServer`-like object that records `tool()` registrations so
 * later phases can assert against the dispatch table without pulling in the
 * real `@modelcontextprotocol/sdk` runtime.
 */
function createStubMcpServer() {
  const tool = vi.fn();
  const stub = { tool } as unknown as Parameters<typeof registerMarketplaceTools>[0];
  return { stub, tool };
}

/**
 * Build a deps bundle with vi.fn()-backed stubs for every collaborator. The
 * stub objects are intentionally cast through `unknown` because phase 1 only
 * exercises the wiring scaffold — phase 2/3 handlers will pass real services.
 */
function createStubDeps(): MarketplaceMcpDeps {
  return {
    dorkHome: '/tmp/.dork-test',
    installer: {} as MarketplaceMcpDeps['installer'],
    sourceManager: {} as MarketplaceMcpDeps['sourceManager'],
    fetcher: {} as MarketplaceMcpDeps['fetcher'],
    cache: {} as MarketplaceMcpDeps['cache'],
    uninstallFlow: {} as MarketplaceMcpDeps['uninstallFlow'],
    confirmationProvider: new AutoApproveConfirmationProvider(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

/**
 * Names of every marketplace MCP tool that `registerMarketplaceTools()` is
 * required to register. Kept in one place so the smoke test in
 * `tools-list.test.ts` and this dispatch-table test stay in lockstep.
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

describe('registerMarketplaceTools', () => {
  it('is callable with a stub McpServer and stub deps without throwing', () => {
    const { stub } = createStubMcpServer();
    const deps = createStubDeps();

    expect(() => registerMarketplaceTools(stub, deps)).not.toThrow();
  });

  it('registers every marketplace tool against the supplied server', () => {
    const { stub, tool } = createStubMcpServer();
    const deps = createStubDeps();

    registerMarketplaceTools(stub, deps);

    expect(tool).toHaveBeenCalledTimes(EXPECTED_TOOLS.length);
    const registeredNames = tool.mock.calls.map((call) => call[0] as string);
    for (const name of EXPECTED_TOOLS) {
      expect(registeredNames).toContain(name);
    }
  });

  it('passes a non-empty description string for every tool', () => {
    const { stub, tool } = createStubMcpServer();
    const deps = createStubDeps();

    registerMarketplaceTools(stub, deps);

    for (const call of tool.mock.calls) {
      const [, description] = call;
      expect(typeof description).toBe('string');
      expect((description as string).length).toBeGreaterThan(0);
    }
  });

  it('returns void', () => {
    const { stub } = createStubMcpServer();
    const deps = createStubDeps();

    const result = registerMarketplaceTools(stub, deps);

    expect(result).toBeUndefined();
  });
});

describe('MarketplaceMcpDeps', () => {
  it('exposes the dependency fields needed by phase 2/3 tool handlers', () => {
    const deps = createStubDeps();

    // Compile-time guarantees expressed at runtime: every collaborator the
    // phase 2/3 tasks plan to consume must be reachable through this bundle.
    expect(deps).toHaveProperty('dorkHome');
    expect(deps).toHaveProperty('installer');
    expect(deps).toHaveProperty('sourceManager');
    expect(deps).toHaveProperty('fetcher');
    expect(deps).toHaveProperty('cache');
    expect(deps).toHaveProperty('uninstallFlow');
    expect(deps).toHaveProperty('confirmationProvider');
    expect(deps).toHaveProperty('logger');
  });
});
