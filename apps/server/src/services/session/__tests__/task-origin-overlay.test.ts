import { describe, it, expect } from 'vitest';
import { createMockSession } from '@dorkos/test-utils';
import { applyTaskOriginOverlay, type ResolveTaskOrigins } from '../task-origin-overlay.js';

describe('applyTaskOriginOverlay', () => {
  it('overlays origin: task and the taskName label onto matching sessions', () => {
    const sessions = [
      createMockSession({ id: 'a' }),
      createMockSession({ id: 'b' }),
      createMockSession({ id: 'c' }),
    ];
    const resolveTaskOrigins: ResolveTaskOrigins = (ids) => {
      const map = new Map<string, { taskName: string }>();
      if (ids.includes('a')) map.set('a', { taskName: 'daily-digest' });
      if (ids.includes('c')) map.set('c', { taskName: 'weekly-report' });
      return map;
    };

    applyTaskOriginOverlay(sessions, resolveTaskOrigins);

    expect(sessions[0].origin).toBe('task');
    expect(sessions[0].originLabel).toBe('Scheduled task · daily-digest');
    expect(sessions[1].origin).toBeUndefined();
    expect(sessions[1].originLabel).toBeUndefined();
    expect(sessions[2].origin).toBe('task');
    expect(sessions[2].originLabel).toBe('Scheduled task · weekly-report');
  });

  it('overwrites a transcript-head-classified origin — Pulse-run-backed sessions are authoritatively task', () => {
    const sessions = [
      createMockSession({ id: 'agent-classified', origin: 'agent', originLabel: 'abc (agent)' }),
    ];
    const resolveTaskOrigins: ResolveTaskOrigins = () =>
      new Map([['agent-classified', { taskName: 'nightly-sync' }]]);

    applyTaskOriginOverlay(sessions, resolveTaskOrigins);

    expect(sessions[0].origin).toBe('task');
    expect(sessions[0].originLabel).toBe('Scheduled task · nightly-sync');
  });

  it('leaves non-matching sessions untouched', () => {
    const sessions = [createMockSession({ id: 'untouched' })];
    const resolveTaskOrigins: ResolveTaskOrigins = () => new Map();

    applyTaskOriginOverlay(sessions, resolveTaskOrigins);

    expect(sessions[0].origin).toBeUndefined();
  });

  it('is a safe no-op when resolveTaskOrigins is undefined', () => {
    const sessions = [createMockSession({ id: 'no-tasks-subsystem' })];

    expect(() => applyTaskOriginOverlay(sessions, undefined)).not.toThrow();
    expect(sessions[0].origin).toBeUndefined();
  });
});
