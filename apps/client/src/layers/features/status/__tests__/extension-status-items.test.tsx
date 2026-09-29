/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import type { StatusBarSlotContext } from '@dorkos/extension-api';
import type { StatusBarContribution } from '@/layers/shared/model';
import { evaluateExtensionStatusItems } from '../model/extension-status-items';
import { getStatusBarItem, isPinnable } from '../model/status-bar-registry';

const CTX: StatusBarSlotContext = {
  sessionId: 's1',
  cwd: '/repo',
  project: { root: '/repo', name: 'repo' },
  trackerItems: [],
  compact: false,
};

function item(id: string, overrides: Partial<StatusBarContribution> = {}): StatusBarContribution {
  return {
    id: `ext:${id}`,
    extensionId: 'ext',
    label: id,
    priority: 100,
    component: ({ project }) => <span>{`${id} in ${project?.name ?? 'none'}`}</span>,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('evaluateExtensionStatusItems (spec flow-multiproject §6.6)', () => {
  it('shows an item with no when(), and orders the shown ones by priority', () => {
    const result = evaluateExtensionStatusItems(
      [item('late', { priority: 200 }), item('early', { priority: 10 }), item('mid')],
      CTX
    );
    expect(result.visible.map((i) => i.label)).toEqual(['early', 'mid', 'late']);
  });

  it('passes the chat’s context to when() and urgent()', () => {
    const when = vi.fn((ctx: StatusBarSlotContext) => ctx.cwd === '/repo');
    const urgent = vi.fn(() => true);
    const result = evaluateExtensionStatusItems([item('a', { when, urgent })], CTX);
    expect(when).toHaveBeenCalledWith(CTX);
    expect(result.promotion).toEqual([{ id: 'ext:a', visible: true, urgent: true }]);
  });

  it('is never urgent while hidden', () => {
    const urgent = vi.fn(() => true);
    const result = evaluateExtensionStatusItems([item('a', { when: () => false, urgent })], CTX);
    expect(result.promotion).toEqual([{ id: 'ext:a', visible: false, urgent: false }]);
    expect(urgent).not.toHaveBeenCalled();
  });

  it('hides an item whose rule throws, and says so once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = item('broken', {
      when: () => {
        throw new Error('boom');
      },
    });
    evaluateExtensionStatusItems([broken, item('fine')], CTX);
    const result = evaluateExtensionStatusItems([broken, item('fine')], CTX);

    expect(result.visible.map((i) => i.label)).toEqual(['fine']);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('reports a broken rule again after the extension reloads (a new registration)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const when = () => {
      throw new Error('boom');
    };
    evaluateExtensionStatusItems([item('broken', { when })], CTX);
    evaluateExtensionStatusItems([item('broken', { when })], CTX);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a Promise', () => Promise.resolve(true)],
    ['a truthy object', () => ({ show: true })],
    ['a string', () => 'yes'],
  ])('reads a when() that returns %s as hidden, and says why once', (_label, when) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = item('bad', { when: when as unknown as () => boolean });
    evaluateExtensionStatusItems([bad], CTX);
    const result = evaluateExtensionStatusItems([bad], CTX);
    expect(result.visible).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toMatch(/must return true or false/);
  });

  it('reads an urgent() that returns a non-boolean as not urgent', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = evaluateExtensionStatusItems(
      [item('a', { urgent: (() => 'very') as unknown as () => boolean })],
      CTX
    );
    expect(result.promotion).toEqual([{ id: 'ext:a', visible: true, urgent: false }]);
  });

  it('reads a throwing urgent() as not urgent, and keeps the item', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = evaluateExtensionStatusItems(
      [
        item('a', {
          urgent: () => {
            throw new Error('boom');
          },
        }),
      ],
      CTX
    );
    expect(result.promotion).toEqual([{ id: 'ext:a', visible: true, urgent: false }]);
  });
});

describe('the Add-ons status item', () => {
  it('cannot be pinned, like the account chip', () => {
    const config = getStatusBarItem('extensions')!;
    expect(config.group).toBeNull();
    expect(isPinnable(config)).toBe(false);
  });

  it('promotes only when an item is shown, and ranks an urgent one with an account that needs you', () => {
    const config = getStatusBarItem('extensions')!;
    const account = getStatusBarItem('account')!;
    const base = {
      cwd: null,
      git: null,
      contextPercent: null,
      connectionState: 'connected' as const,
      permissionMode: 'default',
      permissionDescriptor: null,
      plan: null,
      runtime: null,
      usage: null,
      usageStale: false,
      subagentsInFlight: 0,
    };
    const quiet = { ...base, account: null, extensionItems: [] };
    expect(config.promote(quiet)).toBe(false);

    const shown = { ...quiet, extensionItems: [{ id: 'a', visible: true, urgent: false }] };
    const urgent = { ...quiet, extensionItems: [{ id: 'a', visible: true, urgent: true }] };
    expect(config.promote(shown)).toBe(true);
    expect(config.severity(urgent)).toBeGreaterThan(config.severity(shown));
    expect(config.severity(urgent)).toBe(
      account.severity({ ...quiet, account: { chipState: 'out' } })
    );
  });
});
