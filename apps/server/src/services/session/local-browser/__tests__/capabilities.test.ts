import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';
import { noopLogger } from '@dorkos/shared/logger';
import { composeRegistry } from '../../../core/capabilities/index.js';
import {
  capabilitiesForMcpServer,
  capabilityInputShape,
  invokeCapabilityAsMcpResult,
} from '../../../core/capabilities/mcp-projection.js';
import type { CapabilityDeps, CapabilityHandlerContext } from '../../../core/capabilities/index.js';
import { createLocalBrowserDomain } from '../capabilities.js';
import { LocalBrowserError, type LocalBrowserService } from '../service.js';

function setup() {
  const state: LocalBrowserState = {
    connectionId: 'live',
    sessionId: 'chat-one',
    mode: 'new-window',
    status: 'connected',
    paused: false,
    selectedTabId: 'selected',
    revision: 3,
    preparation: null,
    tabs: [{ id: 'selected', url: 'http://fixture.test/', title: 'Chosen page' }],
  };
  const service = {
    requireProfileAccess: vi.fn(async () => undefined),
    requireSharedSession: vi.fn((id: string) => {
      if (id !== 'chat-one')
        throw new LocalBrowserError(
          'not_shared',
          'Open this chat’s browser to share it with your agent.'
        );
    }),
    agentState: vi.fn(async () => state),
    observe: vi.fn(async () => ({
      revision: 3,
      snapshot: '- button "Save"',
      url: 'http://fixture.test/',
      tabId: 'selected',
    })),
    screenshot: vi.fn(async () => ({
      data: 'cGl4ZWxz',
      mimeType: 'image/png',
      revision: 3,
      tabId: 'selected',
    })),
    action: vi.fn(async () => ({
      ...state,
      tabs: [
        ...state.tabs,
        { id: 'secret', url: 'https://other-tab.test/private', title: 'Private tab' },
      ],
    })),
  };
  const domain = createLocalBrowserDomain(service as unknown as LocalBrowserService);
  const deps = {} as CapabilityDeps;
  const context = (sessionId?: string) => ({ sessionId }) as CapabilityHandlerContext;
  return { service, domain, deps, context };
}

describe('local browser scoped tool projection', () => {
  it('offers observation and action only on the in-session surface', () => {
    const { domain } = setup();
    expect(domain.capabilities.map((item) => item.id)).toEqual([
      'local_browser.state',
      'local_browser.observe',
      'local_browser.screenshot',
      'local_browser.act',
    ]);
    for (const item of domain.capabilities)
      expect(item.surfaces.mcp?.servers).toEqual(['in-session']);
    expect(domain.capabilities.map((item) => item.surfaces.mcp?.toolName)).not.toContain(
      'local_browser_open'
    );
  });
  it('projects every actual MCP tool and validates every action variant before dispatch', async () => {
    const { domain, service } = setup();
    const registry = composeRegistry([domain], { logger: noopLogger });
    const tools = capabilitiesForMcpServer(registry, 'in-session');
    const schemas = tools.map((tool) => ({
      id: tool.id,
      input: z.object(capabilityInputShape(tool)),
    }));
    expect(schemas).toHaveLength(4);
    expect(capabilitiesForMcpServer(registry, 'external')).toEqual([]);
    const projected = schemas.find((tool) => tool.id === 'local_browser.act')!.input;
    const valid = [
      { kind: 'navigate', revision: 3, url: 'https://fixture.test/' },
      { kind: 'click', revision: 3, role: 'button', name: 'Save' },
      { kind: 'fill', revision: 3, role: 'textbox', name: 'Email', text: 'hello' },
      { kind: 'press', revision: 3, key: 'Enter' },
      { kind: 'scroll', revision: 3, deltaX: 0, deltaY: 600 },
    ];
    for (const action of valid) expect(projected.parse({ action })).toEqual({ action });
    const malformed = [
      { kind: 'navigate', revision: 3 },
      { kind: 'navigate', revision: 3, url: 'not-a-url' },
      { kind: 'click', revision: 3, role: 'button' },
      { kind: 'fill', revision: 3, role: 'textbox', name: 'Email' },
      { kind: 'click', revision: -1, role: 'button', name: 'Save' },
      { kind: 'click', revision: 3, role: 'button', name: 'Save', text: 'extra' },
      { kind: 'press', revision: 3, key: 'UnsupportedKey' },
      { kind: 'scroll', revision: 3, deltaY: 600 },
    ];
    for (const action of malformed) {
      expect(projected.safeParse({ action }).success).toBe(false);
      await expect(
        registry.invoke('local_browser.act', { action }, { sessionId: 'chat-one' })
      ).rejects.toBeInstanceOf(z.ZodError);
    }
    expect(service.action).not.toHaveBeenCalled();
    await registry.invoke('local_browser.act', { action: valid[0] }, { sessionId: 'chat-one' });
    expect(service.action).toHaveBeenCalledExactlyOnceWith(valid[0]);
  });
  it('projects screenshot pixels as a real MCP image block', async () => {
    const { domain } = setup();
    const registry = composeRegistry([domain], { logger: noopLogger });
    const result = await invokeCapabilityAsMcpResult(
      registry,
      'local_browser.screenshot',
      {},
      { sessionId: 'chat-one' }
    );
    expect(result.content[0]).toEqual({ type: 'image', data: 'cGl4ZWxz', mimeType: 'image/png' });
    expect(result.content[1]).toMatchObject({ type: 'text' });
  });
  it('refuses session-less and other-chat access before reading or acting', async () => {
    const { domain, service, deps, context } = setup();
    for (const item of domain.capabilities) {
      const input =
        item.id === 'local_browser.act'
          ? { action: { kind: 'click', revision: 3, role: 'button', name: 'Save' } }
          : {};
      expect(() => item.invoke(deps, input, context())).toThrow();
      expect(() => item.invoke(deps, input, context('chat-two'))).toThrow();
    }
    expect(service.agentState).not.toHaveBeenCalled();
    expect(service.observe).not.toHaveBeenCalled();
    expect(service.action).not.toHaveBeenCalled();
  });
  it('refuses an answer when sharing changed while the page was being read', async () => {
    const { domain, service, deps, context } = setup();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.observe.mockImplementationOnce(async () => {
      await pending;
      return {
        revision: 3,
        snapshot: 'private old page',
        url: 'http://fixture.test/',
        tabId: 'selected',
      };
    });
    const read = domain.capabilities.find((item) => item.id === 'local_browser.observe')!;
    const result = read.invoke(deps, {}, context('chat-one'));
    service.requireSharedSession.mockImplementation(() => {
      throw new LocalBrowserError(
        'not_shared',
        'Open this chat’s browser to share it with your agent.'
      );
    });
    release();
    await expect(result).rejects.toThrow();
  });
  it('refuses an agent not added to the profile before reading, on every tool', async () => {
    const { domain, deps, context, service } = setup();
    service.requireProfileAccess.mockRejectedValue(
      new LocalBrowserError('profile_not_allowed', 'This agent can’t use this browser profile.')
    );
    for (const capability of domain.capabilities) {
      await expect(
        capability.invoke(
          deps,
          capability.id === 'local_browser.act'
            ? { action: { kind: 'click', revision: 3, role: 'button', name: 'Save' } }
            : {},
          context('chat-one')
        )
      ).rejects.toThrow();
    }
    expect(service.observe).not.toHaveBeenCalled();
    expect(service.action).not.toHaveBeenCalled();
    expect(service.screenshot).not.toHaveBeenCalled();
    expect(service.agentState).not.toHaveBeenCalled();
  });
  it('holds back the answer when access ended while the call ran', async () => {
    const { domain, deps, context, service } = setup();
    service.requireProfileAccess
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new LocalBrowserError('profile_not_allowed', 'No.'));
    const read = domain.capabilities.find((item) => item.id === 'local_browser.observe')!;
    await expect(read.invoke(deps, {}, context('chat-one'))).rejects.toThrow();
    expect(service.observe).toHaveBeenCalledOnce();
  });
  it('returns selected-only state after an action, never the human tab chooser', async () => {
    const { domain, deps, context } = setup();
    const act = domain.capabilities.find((item) => item.id === 'local_browser.act')!;
    const result = await act.invoke(
      deps,
      { action: { kind: 'click', revision: 3, role: 'button', name: 'Save' } },
      context('chat-one')
    );
    expect(result).toMatchObject({ tabs: [{ id: 'selected' }] });
    expect(JSON.stringify(result)).not.toContain('other-tab.test');
  });
});
