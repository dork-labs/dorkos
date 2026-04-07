/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDeepLinkScroll } from '../use-deep-link-scroll';

/**
 * Flush a single requestAnimationFrame tick. The hook defers its DOM lookup
 * via `requestAnimationFrame`, so tests must advance one frame before asserting.
 */
async function flushRaf() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

describe('useDeepLinkScroll', () => {
  let scrollIntoViewSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollIntoViewSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewSpy;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('does nothing when section is null', async () => {
    const target = document.createElement('div');
    target.setAttribute('data-section', 'foo');
    document.body.appendChild(target);

    const onMatch = vi.fn();
    renderHook(() => useDeepLinkScroll(null, onMatch));
    await flushRaf();

    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    expect(onMatch).not.toHaveBeenCalled();
  });

  it('calls scrollIntoView on the matched element', async () => {
    const target = document.createElement('div');
    target.setAttribute('data-section', 'foo');
    document.body.appendChild(target);

    renderHook(() => useDeepLinkScroll('foo'));
    await flushRaf();

    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('calls onMatch callback with the section id', async () => {
    const target = document.createElement('div');
    target.setAttribute('data-section', 'foo');
    document.body.appendChild(target);

    const onMatch = vi.fn();
    renderHook(() => useDeepLinkScroll('foo', onMatch));
    await flushRaf();

    expect(onMatch).toHaveBeenCalledTimes(1);
    expect(onMatch).toHaveBeenCalledWith('foo');
  });

  it('does not throw when no element matches', async () => {
    const onMatch = vi.fn();
    renderHook(() => useDeepLinkScroll('missing', onMatch));

    await expect(flushRaf()).resolves.not.toThrow();
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    expect(onMatch).not.toHaveBeenCalled();
  });

  it('re-runs when section changes', async () => {
    const fooEl = document.createElement('div');
    fooEl.setAttribute('data-section', 'foo');
    document.body.appendChild(fooEl);

    const barEl = document.createElement('div');
    barEl.setAttribute('data-section', 'bar');
    document.body.appendChild(barEl);

    const onMatch = vi.fn();
    const { rerender } = renderHook(
      ({ section }: { section: string | null }) => useDeepLinkScroll(section, onMatch),
      { initialProps: { section: 'foo' as string | null } }
    );
    await flushRaf();

    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
    expect(onMatch).toHaveBeenLastCalledWith('foo');

    rerender({ section: 'bar' });
    await flushRaf();

    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(2);
    expect(onMatch).toHaveBeenLastCalledWith('bar');
  });

  it('strips unsafe characters from section before querying', async () => {
    const target = document.createElement('div');
    target.setAttribute('data-section', 'foo');
    document.body.appendChild(target);

    const querySelectorSpy = vi.spyOn(document, 'querySelector');
    const onMatch = vi.fn();

    // Section contains injection-style characters that should be stripped to "foo"
    renderHook(() => useDeepLinkScroll('foo"]/script', onMatch));
    await flushRaf();

    // Selector receives the sanitized value only
    expect(querySelectorSpy).toHaveBeenCalledWith('[data-section="fooscript"]');
    // Sanitization stripped the slash + quote, so the safe value differs from "foo"
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    expect(onMatch).not.toHaveBeenCalled();

    // Sanity-check: a fully-unsafe section becomes empty and short-circuits
    querySelectorSpy.mockClear();
    renderHook(() => useDeepLinkScroll('"]><>!@#$%', onMatch));
    await flushRaf();
    expect(querySelectorSpy).not.toHaveBeenCalled();
  });
});
