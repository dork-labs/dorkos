/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDocumentTitle } from '../use-document-title';

const defaults = { isStreaming: false, isWaitingForUser: false };

describe('useDocumentTitle', () => {
  beforeEach(() => {
    document.title = '';
  });

  it('sets title with emoji and directory name', () => {
    renderHook(() => useDocumentTitle({ cwd: '/Users/test/myproject', activeForm: null, ...defaults }));
    expect(document.title).toMatch(/^.{1,2} myproject \u2014 DorkOS$/);
  });

  it('includes activeForm in title when present', () => {
    renderHook(() => useDocumentTitle({ cwd: '/test/proj', activeForm: 'Running tests', ...defaults }));
    expect(document.title).toContain('Running tests');
    expect(document.title).toContain('\u2014 DorkOS');
  });

  it('truncates long activeForm at 40 chars', () => {
    const longForm = 'A'.repeat(50);
    renderHook(() => useDocumentTitle({ cwd: '/test', activeForm: longForm, ...defaults }));
    expect(document.title).toContain('\u2026');
    expect(document.title.length).toBeLessThan(100);
  });

  it('falls back to default title when cwd is null', () => {
    renderHook(() => useDocumentTitle({ cwd: null, activeForm: null, ...defaults }));
    expect(document.title).toBe('DorkOS');
  });

  it('uses last path segment as directory name', () => {
    renderHook(() => useDocumentTitle({ cwd: '/a/b/c/deep-project', activeForm: null, ...defaults }));
    expect(document.title).toContain('deep-project');
    expect(document.title).not.toContain('/a/b/c');
  });

  it('updates when activeForm changes', () => {
    const { rerender } = renderHook(
      ({ activeForm }) => useDocumentTitle({ cwd: '/test', activeForm, ...defaults }),
      { initialProps: { activeForm: null as string | null } },
    );
    expect(document.title).not.toContain('\u2014 Running');

    rerender({ activeForm: 'Running tests' });
    expect(document.title).toContain('Running tests');
  });
});

describe('status prefixes', () => {
  beforeEach(() => {
    document.title = '';
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  it('shows 🔔 prefix when isWaitingForUser is true', () => {
    renderHook(() => useDocumentTitle({
      cwd: '/test', activeForm: null, isStreaming: false, isWaitingForUser: true,
    }));
    expect(document.title).toMatch(/^🔔 /);
  });

  it('does not show 🔔 when isWaitingForUser is false', () => {
    renderHook(() => useDocumentTitle({
      cwd: '/test', activeForm: null, isStreaming: false, isWaitingForUser: false,
    }));
    expect(document.title).not.toMatch(/^🔔/);
  });

  it('shows 🏁 when streaming ends while tab is hidden', () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    const { rerender } = renderHook(
      ({ isStreaming }) => useDocumentTitle({
        cwd: '/test', activeForm: null, isStreaming, isWaitingForUser: false,
      }),
      { initialProps: { isStreaming: true } },
    );
    rerender({ isStreaming: false });
    expect(document.title).toMatch(/^🏁 /);
  });

  it('clears 🏁 when tab becomes visible', () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    const { rerender } = renderHook(
      ({ isStreaming }) => useDocumentTitle({
        cwd: '/test', activeForm: null, isStreaming, isWaitingForUser: false,
      }),
      { initialProps: { isStreaming: true } },
    );
    rerender({ isStreaming: false });
    expect(document.title).toMatch(/^🏁 /);

    // User returns
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.title).not.toMatch(/^🏁/);
  });

  it('🔔 takes priority over 🏁', () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    const { rerender } = renderHook(
      ({ isStreaming, isWaitingForUser }) => useDocumentTitle({
        cwd: '/test', activeForm: null, isStreaming, isWaitingForUser,
      }),
      { initialProps: { isStreaming: true, isWaitingForUser: false } },
    );
    // Streaming ends while hidden (sets unseen flag)
    rerender({ isStreaming: false, isWaitingForUser: false });
    expect(document.title).toMatch(/^🏁 /);

    // Now also waiting for user
    rerender({ isStreaming: false, isWaitingForUser: true });
    expect(document.title).toMatch(/^🔔 /);
    expect(document.title).not.toContain('🏁');
  });

  it('no prefix when cwd is null (embedded mode)', () => {
    renderHook(() => useDocumentTitle({
      cwd: null, activeForm: null, isStreaming: false, isWaitingForUser: true,
    }));
    expect(document.title).toBe('DorkOS');
  });

  it('preserves activeForm with prefix', () => {
    renderHook(() => useDocumentTitle({
      cwd: '/test', activeForm: 'Running tests', isStreaming: false, isWaitingForUser: true,
    }));
    expect(document.title).toMatch(/^🔔 /);
    expect(document.title).toContain('Running tests');
    expect(document.title).toContain('— DorkOS');
  });

  it('preserves 🔔 when user returns while still waiting', () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    const { rerender } = renderHook(
      ({ isStreaming, isWaitingForUser }) => useDocumentTitle({
        cwd: '/test', activeForm: null, isStreaming, isWaitingForUser,
      }),
      { initialProps: { isStreaming: true, isWaitingForUser: false } },
    );
    // Streaming ends while hidden — sets unseen flag
    rerender({ isStreaming: false, isWaitingForUser: false });
    expect(document.title).toMatch(/^🏁 /);

    // AI now waiting for user
    rerender({ isStreaming: false, isWaitingForUser: true });
    expect(document.title).toMatch(/^🔔 /);

    // User returns — 🔔 should remain since still waiting
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.title).toMatch(/^🔔 /);
  });
});
