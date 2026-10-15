/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDocumentTitle, type DocumentTitleState } from '../use-document-title';

/** A format that spells the window state out, so a test can read it back. */
const spell = ({ hidden, unseenReply }: DocumentTitleState) =>
  `page${hidden ? ' hidden' : ''}${unseenReply ? ' unseen' : ''}`;

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('useDocumentTitle', () => {
  beforeEach(() => {
    document.title = '';
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  it('writes what the format builds', () => {
    renderHook(() => useDocumentTitle(spell, false));
    expect(document.title).toBe('page');
  });

  it('rewrites the title when the format’s answer changes', () => {
    const { rerender } = renderHook(({ name }) => useDocumentTitle(() => name, false), {
      initialProps: { name: 'Home — DorkOS' },
    });
    rerender({ name: 'Scout · Fix the login bug — DorkOS' });
    expect(document.title).toBe('Scout · Fix the login bug — DorkOS');
  });

  it('tells the format when the window is hidden, and when it is back', () => {
    renderHook(() => useDocumentTitle(spell, false));
    setHidden(true);
    expect(document.title).toBe('page hidden');
    setHidden(false);
    expect(document.title).toBe('page');
  });

  it('flags a reply that finished while the window was hidden', () => {
    const { rerender } = renderHook(({ streaming }) => useDocumentTitle(spell, streaming), {
      initialProps: { streaming: true },
    });
    setHidden(true);
    rerender({ streaming: false });
    expect(document.title).toBe('page hidden unseen');
  });

  it('clears the flag once the window is looked at again', () => {
    const { rerender } = renderHook(({ streaming }) => useDocumentTitle(spell, streaming), {
      initialProps: { streaming: true },
    });
    setHidden(true);
    rerender({ streaming: false });
    setHidden(false);
    expect(document.title).toBe('page');
  });

  it('does not flag a reply that finished while you were watching', () => {
    const { rerender } = renderHook(({ streaming }) => useDocumentTitle(spell, streaming), {
      initialProps: { streaming: true },
    });
    rerender({ streaming: false });
    expect(document.title).toBe('page');
  });
});
