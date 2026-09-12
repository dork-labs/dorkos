/**
 * The before-and-after counter for auto mode's stops on DorkOS tools
 * (spec `auto-mode-classifier-context`).
 *
 * The whole feature is a claim that fewer stops happen. A claim like that is
 * worth nothing without a number, so this counter is part of the change rather
 * than a follow-up — and the numbers have to be divisible by each other, which
 * is why stops and assertions are counted by one module with one `since`.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  autoModeStopStats,
  recordAutoModeStop,
  recordClassifierAssertion,
  resetAutoModeStops,
} from '../auto-mode-stops.js';

beforeEach(() => {
  resetAutoModeStops();
});

describe('counting stops', () => {
  it('starts at nothing', () => {
    const stats = autoModeStopStats();
    expect(stats.stops).toBe(0);
    expect(stats.assertions).toBe(0);
    expect(stats.stopsByTool).toEqual({});
    expect(stats.since).toEqual(expect.any(String));
  });

  it('counts per tool and per session', () => {
    recordAutoModeStop({ sessionId: 's1', toolName: 'mcp__dorkos__tasks_delete' });
    recordAutoModeStop({ sessionId: 's1', toolName: 'mcp__dorkos__tasks_delete' });
    recordAutoModeStop({ sessionId: 's2', toolName: 'mcp__dorkos__mesh_unregister' });

    const stats = autoModeStopStats();
    expect(stats.stops).toBe(3);
    expect(stats.stopsByTool).toEqual({
      mcp__dorkos__tasks_delete: 2,
      mcp__dorkos__mesh_unregister: 1,
    });
    expect(stats.stopSessions).toBe(2);
  });
});

describe('counting assertions', () => {
  it('splits by tier', () => {
    recordClassifierAssertion({ sessionId: 's1', tool: 'mesh_list', tier: 'observe' });
    recordClassifierAssertion({ sessionId: 's1', tool: 'relay_send', tier: 'act' });
    recordClassifierAssertion({ sessionId: 's1', tool: 'tasks_delete', tier: 'destructive' });

    const stats = autoModeStopStats();
    expect(stats.assertions).toBe(3);
    expect(stats.assertionsByTier).toEqual({ observe: 1, act: 1, destructive: 1 });
  });

  it('does not let a caller mutate the counters it reads', () => {
    recordClassifierAssertion({ sessionId: 's1', tool: 'mesh_list', tier: 'observe' });
    const stats = autoModeStopStats();
    stats.assertionsByTier.observe = 99;
    stats.stopsByTool['whatever'] = 99;
    expect(autoModeStopStats().assertionsByTier.observe).toBe(1);
    expect(autoModeStopStats().stopsByTool).toEqual({});
  });
});

describe('resetting', () => {
  it('forgets everything, including the sessions', () => {
    recordAutoModeStop({ sessionId: 's1', toolName: 'mcp__dorkos__tasks_delete' });
    recordClassifierAssertion({ sessionId: 's1', tool: 'mesh_list', tier: 'observe' });
    resetAutoModeStops();

    expect(autoModeStopStats()).toMatchObject({
      stops: 0,
      stopSessions: 0,
      assertions: 0,
      assertionsByTier: { observe: 0, act: 0, destructive: 0 },
    });
  });
});
