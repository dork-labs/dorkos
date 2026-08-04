/**
 * Tests for the in-memory breadcrumb ring buffer (feedback-pipeline spec Part 1).
 *
 * Proves the load-bearing guarantees: bounded capacity (oldest evicted first),
 * never persisted (module-scoped array only), and `console.error`/`console.warn`
 * are WRAPPED not replaced — the original console call must still fire so
 * devtools output is unaffected.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addBreadcrumb,
  getBreadcrumbs,
  installBreadcrumbHandlers,
  __resetBreadcrumbsForTests,
} from '../breadcrumbs';
import { MAX_BREADCRUMBS, MAX_BREADCRUMB_MESSAGE_LEN } from '@dorkos/shared/telemetry-events';

afterEach(() => {
  __resetBreadcrumbsForTests();
  vi.restoreAllMocks();
});

describe('addBreadcrumb / getBreadcrumbs', () => {
  it('records a breadcrumb with an ISO timestamp', () => {
    addBreadcrumb('console_error', 'boom');
    const crumbs = getBreadcrumbs();
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0].kind).toBe('console_error');
    expect(crumbs[0].message).toBe('boom');
    expect(() => new Date(crumbs[0].at)).not.toThrow();
    expect(new Date(crumbs[0].at).toISOString()).toBe(crumbs[0].at);
  });

  it('preserves insertion order (oldest first)', () => {
    addBreadcrumb('console_error', 'first');
    addBreadcrumb('console_warn', 'second');
    addBreadcrumb('sse_disconnect', 'third');
    expect(getBreadcrumbs().map((c) => c.message)).toEqual(['first', 'second', 'third']);
  });

  it('truncates a message to MAX_BREADCRUMB_MESSAGE_LEN', () => {
    addBreadcrumb('console_error', 'x'.repeat(MAX_BREADCRUMB_MESSAGE_LEN + 50));
    expect(getBreadcrumbs()[0].message.length).toBe(MAX_BREADCRUMB_MESSAGE_LEN);
  });

  it('evicts the oldest entry once the buffer exceeds MAX_BREADCRUMBS', () => {
    for (let i = 0; i < MAX_BREADCRUMBS + 5; i++) {
      addBreadcrumb('console_error', `crumb-${i}`);
    }
    const crumbs = getBreadcrumbs();
    expect(crumbs).toHaveLength(MAX_BREADCRUMBS);
    // The first 5 were evicted; the buffer starts at crumb-5.
    expect(crumbs[0].message).toBe('crumb-5');
    expect(crumbs.at(-1)?.message).toBe(`crumb-${MAX_BREADCRUMBS + 4}`);
  });

  it('getBreadcrumbs returns a copy — mutating the result does not affect the buffer', () => {
    addBreadcrumb('console_error', 'one');
    const crumbs = getBreadcrumbs();
    crumbs.push({ at: new Date().toISOString(), kind: 'console_warn', message: 'injected' });
    expect(getBreadcrumbs()).toHaveLength(1);
  });

  it('is never persisted: __resetBreadcrumbsForTests clears everything', () => {
    addBreadcrumb('console_error', 'one');
    __resetBreadcrumbsForTests();
    expect(getBreadcrumbs()).toEqual([]);
  });
});

describe('installBreadcrumbHandlers', () => {
  it('records a console_error breadcrumb AND still calls the original console.error', () => {
    const originalError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const uninstall = installBreadcrumbHandlers();

    console.error('something broke', { detail: 42 });

    expect(getBreadcrumbs()).toHaveLength(1);
    expect(getBreadcrumbs()[0].kind).toBe('console_error');
    expect(getBreadcrumbs()[0].message).toContain('something broke');
    // Wrapped, not replaced: the original still fires.
    expect(originalError).toHaveBeenCalledWith('something broke', { detail: 42 });

    uninstall();
  });

  it('records a console_warn breadcrumb AND still calls the original console.warn', () => {
    const originalWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const uninstall = installBreadcrumbHandlers();

    console.warn('heads up');

    expect(getBreadcrumbs()).toHaveLength(1);
    expect(getBreadcrumbs()[0].kind).toBe('console_warn');
    expect(originalWarn).toHaveBeenCalledWith('heads up');

    uninstall();
  });

  it('uninstall restores the original console.error/console.warn (no more breadcrumbs)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const uninstall = installBreadcrumbHandlers();
    uninstall();

    console.error('after uninstall');
    expect(getBreadcrumbs()).toHaveLength(0);
  });
});
