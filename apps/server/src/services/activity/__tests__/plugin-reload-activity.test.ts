import { describe, it, expect, vi } from 'vitest';
import type { ActivityService } from '../activity-service.js';
import { createPluginReloadActivityWriter } from '../plugin-reload-activity.js';
import type { PaidPluginReload } from '../../runtimes/claude-code/messaging/plugin-reload-policy.js';

/** A feed writer that records what it was handed. */
function fakeActivity() {
  const emit = vi.fn().mockResolvedValue(undefined);
  return { service: { emit } as unknown as ActivityService, emit };
}

const BASE: PaidPluginReload = {
  sessionId: 'sess-1',
  deferred: false,
  heldMs: 0,
  release: undefined,
  contextTokens: 42_000,
  impact: {
    mcpServersAdded: ['plugin:flow:linear'],
    mcpServersRemoved: [],
    lspToolChange: 'adds',
  },
};

describe('createPluginReloadActivityWriter', () => {
  it('records a reload paid on the spot', () => {
    const { service, emit } = fakeActivity();

    createPluginReloadActivityWriter(service)(BASE);

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'system',
        category: 'system',
        eventType: 'plugins.reloaded',
        resourceType: 'session',
        resourceId: 'sess-1',
        summary: 'Switched on new plugins in a chat',
      })
    );
  });

  it('carries the estimate the session never sees', () => {
    const { service, emit } = fakeActivity();

    createPluginReloadActivityWriter(service)(BASE);

    expect(emit.mock.calls[0]?.[0].metadata).toEqual({
      contextTokens: 42_000,
      deferred: false,
      heldMs: 0,
      release: null,
      mcpServersAdded: 1,
      mcpServersRemoved: 0,
      lspToolChange: 'adds',
    });
  });

  it('says a reload the runtime finally applied for nothing cost nothing', () => {
    const { service, emit } = fakeActivity();

    createPluginReloadActivityWriter(service)({
      ...BASE,
      deferred: true,
      heldMs: 7 * 60_000,
      release: 'cache-cold',
    });

    expect(emit.mock.calls[0]?.[0].summary).toBe(
      'Switched on new plugins in a chat once it was free, 7 min later'
    );
  });

  it('never rounds a real wait down to zero minutes', () => {
    const { service, emit } = fakeActivity();

    createPluginReloadActivityWriter(service)({
      ...BASE,
      deferred: true,
      heldMs: 900,
      release: 'ceiling',
    });

    expect(emit.mock.calls[0]?.[0].summary).toContain('1 min');
  });

  it('does not claim a reload paid at the ceiling was free', () => {
    const { service, emit } = fakeActivity();

    createPluginReloadActivityWriter(service)({
      ...BASE,
      deferred: true,
      heldMs: 15 * 60_000,
      release: 'ceiling',
    });

    const summary = emit.mock.calls[0]?.[0].summary as string;
    expect(summary).toBe(
      'Switched on new plugins in a chat after waiting 15 min for a quiet moment'
    );
    expect(summary).not.toContain('free');
  });

  it('says a hand-triggered reload was asked for, not waited out', () => {
    const { service, emit } = fakeActivity();

    createPluginReloadActivityWriter(service)({
      ...BASE,
      deferred: true,
      heldMs: 60_000,
      release: 'hand-triggered',
    });

    expect(emit.mock.calls[0]?.[0].summary).toBe(
      'Switched on new plugins in a chat because you asked for them now'
    );
  });

  it('records an unknown conversation size as unknown, not as zero', () => {
    const { service, emit } = fakeActivity();

    createPluginReloadActivityWriter(service)({ ...BASE, contextTokens: undefined });

    expect(emit.mock.calls[0]?.[0].metadata?.contextTokens).toBeNull();
  });

  it('links to the session the reload happened in', () => {
    const { service, emit } = fakeActivity();

    createPluginReloadActivityWriter(service)({ ...BASE, sessionId: 'a b/c' });

    expect(emit.mock.calls[0]?.[0].linkPath).toBe('/session?session=a%20b%2Fc');
  });

  it('puts no money in the words a person reads', () => {
    const { service, emit } = fakeActivity();

    createPluginReloadActivityWriter(service)({ ...BASE, deferred: true, release: 'cache-cold' });

    expect(emit.mock.calls[0]?.[0].summary).not.toMatch(/\$|usd|cent|token|cache/i);
  });
});
