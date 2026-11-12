/**
 * While a person has the browser, the card says the agent "can't see or use this
 * window" (DOR-3111). These tests hold every runtime's own tool path to that: each
 * browser tool is refused mid-handoff, and the page is never read.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';
import { noopLogger } from '@dorkos/shared/logger';
import { composeRegistry } from '../../../core/capabilities/index.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { capabilityMcpTools } from '../../../runtimes/claude-code/mcp-tools/capability-mcp-tools.js';
import { createAgentRuntimeMcpServer } from '../../../runtimes/connector-mcp/agent-runtime-server.js';
import { createLocalBrowserDomain } from '../capabilities.js';
import { BrowserHandover } from '../handover.js';
import type { SignInWindow } from '../sign-in-window.js';
import type { LocalBrowserService } from '../service.js';

const CHAT = 'chat-one';

/** The agent's input for each tool, so a refusal can't be a schema error. */
const TOOL_INPUTS: Record<string, unknown> = {
  local_browser_state: {},
  local_browser_observe: {},
  local_browser_screenshot: {},
  local_browser_act: { action: { kind: 'click', revision: 3, role: 'button', name: 'Save' } },
};

/** A browser shared with {@link CHAT}, handed to a person through the real handover. */
async function handedOver() {
  const state: LocalBrowserState = {
    connectionId: 'live',
    sessionId: CHAT,
    mode: 'new-window',
    status: 'connected',
    paused: false,
    selectedTabId: 'selected',
    revision: 3,
    preparation: null,
    tabs: [{ id: 'selected', url: 'https://wall.example/check', title: 'Check' }],
  };
  const service = {
    requireProfileAccess: vi.fn(async () => undefined),
    requireNotFullScreen: vi.fn(async () => undefined),
    requireSharedSession: vi.fn(() => undefined),
    agentState: vi.fn(async () => state),
    observe: vi.fn(async () => ({ revision: 3, snapshot: '- heading "Private"', tabId: 'x' })),
    screenshot: vi.fn(async () => ({ data: 'cGl4', mimeType: 'image/png', revision: 3 })),
    action: vi.fn(async () => state),
    handover: undefined as unknown as BrowserHandover,
  };
  const browser = {
    state: async () => state,
    currentProfileId: () => null,
    profileExists: () => true,
    capabilities: () => ({ newWindow: true }),
    open: vi.fn(async () => state),
    selectTab: vi.fn(async () => state),
    navigate: vi.fn(async () => state),
    pause: vi.fn(async () => state),
    resume: vi.fn(async () => state),
    disconnect: vi.fn(async () => state),
  };
  const signIns = { current: null, active: false, holds: () => false } as unknown as SignInWindow;
  service.handover = new BrowserHandover(browser, signIns, () => '/tmp/unused');
  service.handover.useOutsideTurnCheck(async () => false);
  await service.handover.ask(CHAT, 'wall', { name: 'Atlas', folder: '/agents/atlas' });
  const registry = composeRegistry(
    [createLocalBrowserDomain(service as unknown as LocalBrowserService)],
    { logger: noopLogger }
  );
  return { service, registry };
}

/** The page was never read or touched. */
function expectPageUntouched(service: Awaited<ReturnType<typeof handedOver>>['service']) {
  expect(service.observe).not.toHaveBeenCalled();
  expect(service.screenshot).not.toHaveBeenCalled();
  expect(service.action).not.toHaveBeenCalled();
  expect(service.agentState).not.toHaveBeenCalled();
}

/** One MCP result's text, which carries the refusal's code. */
function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return content?.map((item) => item.text ?? '').join('') ?? '';
}

describe('a browser handed to a person refuses its agent on every runtime', () => {
  it('Claude Code: every in-session browser tool is refused', async () => {
    const { service, registry } = await handedOver();
    const tools = capabilityMcpTools(registry, 'in-session', async () => ({ sessionId: CHAT }));
    for (const [name, input] of Object.entries(TOOL_INPUTS)) {
      const tool = tools.find((item) => (item as { name?: string }).name === name);
      expect(tool, name).toBeDefined();
      const result = await (
        tool as unknown as { handler: (args: unknown, extra: unknown) => Promise<unknown> }
      ).handler(input, {});
      expect((result as { isError?: boolean }).isError, name).toBe(true);
      expect(resultText(result), name).toContain('handed_to_person');
    }
    expectPageUntouched(service);
  });

  it.each(['codex', 'opencode', 'doe'] as const)(
    '%s: every browser tool on the runtime tool server is refused',
    async (runtime) => {
      const { service, registry } = await handedOver();
      const principal = createServerPrincipal({
        kind: 'runtime',
        owner: { kind: 'local_install', installationId: 'install-a' },
        bindingId: `binding-${runtime}`,
        runtime,
        canonicalSessionId: CHAT,
        agentId: 'agent-atlas',
        agentPath: '/agents/atlas',
        canonicalCwd: '/work/atlas',
      });
      const server = createAgentRuntimeMcpServer(registry, principal, {
        agentPath: '/agents/atlas',
        displayName: 'Atlas',
        createdAt: '2026-11-11T00:00:00.000Z',
      });
      const client = new Client({ name: 'handoff-test', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      try {
        for (const [name, input] of Object.entries(TOOL_INPUTS)) {
          const result = await client.callTool({
            name,
            arguments: input as Record<string, unknown>,
          });
          expect(result.isError, name).toBe(true);
          expect(resultText(result), name).toContain('handed_to_person');
        }
      } finally {
        await client.close();
      }
      expectPageUntouched(service);
    }
  );
});
