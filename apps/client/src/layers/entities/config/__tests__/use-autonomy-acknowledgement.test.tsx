/**
 * The standing Full-autonomy acknowledgement hook (spec `trust-dial`, decision
 * 5) — and in particular `canRemember`, which is the answer to "could this
 * install even keep the choice we are about to offer?".
 *
 * That question exists because of Obsidian. There the cockpit runs on the
 * in-process `DirectTransport`, whose `updateConfig` is a documented no-op and
 * whose `getConfig` builds no `ui` block at all. Offering "don't show this
 * again" against that backend produces the worst shape a setting can take: it
 * ticks, saves nothing, raises no error, and asks again forever.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ServerConfig } from '@dorkos/shared/types';

let mockConfig: Partial<ServerConfig> | undefined;
vi.mock('../model/use-config', () => ({
  useConfig: () => ({ data: mockConfig }),
}));

const mutate = vi.fn();
vi.mock('../model/use-update-config', () => ({
  useUpdateConfig: () => ({ mutate, isPending: false }),
}));

import { useAutonomyAcknowledgement } from '../model/use-autonomy-acknowledgement';

beforeEach(() => {
  mockConfig = undefined;
  mutate.mockClear();
});

describe('canRemember', () => {
  it('is false against a backend that returns no ui block (Obsidian)', () => {
    // Exactly what `DirectTransport.getConfig` builds: a full-looking config
    // with no `ui` in it. Nothing about the shape says "embedded" — the absence
    // is the whole signal, which is why the hook reads the answer rather than
    // asking which transport it is talking to.
    mockConfig = { version: '0.1.0', runtimes: ['claude-code'] } as Partial<ServerConfig>;

    const { result } = renderHook(() => useAutonomyAcknowledgement());

    expect(result.current.canRemember).toBe(false);
  });

  it('is false before the config has arrived', () => {
    // The honest direction for the frame before the answer: offering the choice
    // and withdrawing it a tick later is worse than letting it appear.
    mockConfig = undefined;

    const { result } = renderHook(() => useAutonomyAcknowledgement());

    expect(result.current.canRemember).toBe(false);
  });

  it('is true against a server that carries a ui block, even an empty-ish one', () => {
    mockConfig = { ui: { autonomyAcknowledgedAt: null } } as Partial<ServerConfig>;

    const { result } = renderHook(() => useAutonomyAcknowledgement());

    expect(result.current.canRemember).toBe(true);
  });
});

describe('reading and writing the record', () => {
  it('reports no acknowledgement when the field is null', () => {
    mockConfig = { ui: { autonomyAcknowledgedAt: null } } as Partial<ServerConfig>;

    expect(renderHook(() => useAutonomyAcknowledgement()).result.current.acknowledgedAt).toBeNull();
  });

  it('reports the date on file', () => {
    mockConfig = {
      ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' },
    } as Partial<ServerConfig>;

    expect(renderHook(() => useAutonomyAcknowledgement()).result.current.acknowledgedAt).toBe(
      '2026-08-01T09:30:00.000Z'
    );
  });

  it('stamps the moment of consent, not a bare true', () => {
    mockConfig = { ui: { autonomyAcknowledgedAt: null } } as Partial<ServerConfig>;

    renderHook(() => useAutonomyAcknowledgement()).result.current.acknowledge();

    const patch = mutate.mock.calls[0]?.[0] as {
      ui: { autonomyAcknowledgedAt: string };
    };
    // A real instant, so Settings can show WHEN — the whole reason this is not a
    // boolean.
    expect(Number.isNaN(Date.parse(patch.ui.autonomyAcknowledgedAt))).toBe(false);
  });

  it('clears back to null, which is what brings the dialog back', () => {
    mockConfig = {
      ui: { autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' },
    } as Partial<ServerConfig>;

    renderHook(() => useAutonomyAcknowledgement()).result.current.clear();

    expect(mutate).toHaveBeenCalledWith({ ui: { autonomyAcknowledgedAt: null } });
  });
});
