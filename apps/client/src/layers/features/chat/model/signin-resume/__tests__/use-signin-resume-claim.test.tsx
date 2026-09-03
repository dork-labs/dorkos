/**
 * @vitest-environment jsdom
 *
 * The cross-window half of the sign-in auto-resume (DOR-1650).
 *
 * A person who presses Sign in in two windows gets BOTH windows' callbacks off
 * one server-side attempt — the second request joins the first's promise, so
 * they resolve together, before either has sent anything. Without a claim
 * announced between them that is a guaranteed double-send, because nothing on
 * the send path deduplicates. These pin the announcement, the stand-down, and
 * the degradation where `BroadcastChannel` does not exist.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSigninResumeClaim } from '../use-signin-resume-claim';

const SESSION_ID = 's1';

/**
 * A fake `BroadcastChannel` that fans a post out to every OTHER instance,
 * mirroring the real one: a context never receives what it posted itself.
 */
function installFakeBroadcastChannel() {
  const instances: FakeChannel[] = [];

  class FakeChannel {
    listeners = new Set<(event: MessageEvent) => void>();
    closed = false;
    constructor(public name: string) {
      instances.push(this);
    }
    postMessage(data: unknown): void {
      for (const other of instances) {
        if (other === this || other.closed || other.name !== this.name) continue;
        for (const listener of other.listeners) listener({ data } as MessageEvent);
      }
    }
    addEventListener(_type: string, handler: (event: MessageEvent) => void): void {
      this.listeners.add(handler);
    }
    removeEventListener(_type: string, handler: (event: MessageEvent) => void): void {
      this.listeners.delete(handler);
    }
    close(): void {
      this.closed = true;
    }
  }

  const original = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = FakeChannel as unknown as typeof BroadcastChannel;
  return () => {
    globalThis.BroadcastChannel = original;
  };
}

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
  vi.restoreAllMocks();
});

describe('useSigninResumeClaim', () => {
  it('stands a second window down once the first announces its resume', () => {
    restore = installFakeBroadcastChannel();
    const windowA = renderHook(() => useSigninResumeClaim());
    const windowB = renderHook(() => useSigninResumeClaim());

    // Before anything is announced, both windows would go ahead.
    expect(windowA.result.current.claimedElsewhere(SESSION_ID)).toBe(false);
    expect(windowB.result.current.claimedElsewhere(SESSION_ID)).toBe(false);

    act(() => windowA.result.current.claim(SESSION_ID));

    expect(windowB.result.current.claimedElsewhere(SESSION_ID)).toBe(true);
  });

  it('does not stand the announcing window down on its own claim', () => {
    // Two cards in ONE window share a QueryClient and therefore one attempt and
    // one report — there is nothing to arbitrate, and a window that heard its
    // own claim would refuse the send it just decided to make.
    restore = installFakeBroadcastChannel();
    const windowA = renderHook(() => useSigninResumeClaim());
    renderHook(() => useSigninResumeClaim());

    act(() => windowA.result.current.claim(SESSION_ID));

    expect(windowA.result.current.claimedElsewhere(SESSION_ID)).toBe(false);
  });

  it('keeps claims to the session they were made for', () => {
    restore = installFakeBroadcastChannel();
    const windowA = renderHook(() => useSigninResumeClaim());
    const windowB = renderHook(() => useSigninResumeClaim());

    act(() => windowA.result.current.claim(SESSION_ID));

    expect(windowB.result.current.claimedElsewhere('some-other-session')).toBe(false);
  });

  it('expires a claim, so a later sign-in is judged on its own', () => {
    restore = installFakeBroadcastChannel();
    const windowA = renderHook(() => useSigninResumeClaim());
    const windowB = renderHook(() => useSigninResumeClaim());

    act(() => windowA.result.current.claim(SESSION_ID));
    expect(windowB.result.current.claimedElsewhere(SESSION_ID)).toBe(true);

    // The TTL only has to outlive the moment two joined sign-ins settle. A
    // sign-in a minute later is a different event and must not inherit this.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    expect(windowB.result.current.claimedElsewhere(SESSION_ID)).toBe(false);
  });

  it('stops listening once its window is gone', () => {
    restore = installFakeBroadcastChannel();
    const windowA = renderHook(() => useSigninResumeClaim());
    const windowB = renderHook(() => useSigninResumeClaim());
    const claimB = windowB.result.current;

    windowB.unmount();
    act(() => windowA.result.current.claim(SESSION_ID));

    // A closed window neither hears nor speaks: no listener leak, and a `claim`
    // through the stale handle is inert rather than throwing.
    expect(claimB.claimedElsewhere(SESSION_ID)).toBe(false);
    expect(() => claimB.claim(SESSION_ID)).not.toThrow();
  });

  it('degrades to every-window-for-itself where BroadcastChannel is absent', () => {
    // Some browsers and jsdom have none. `createChannel` no-ops there, which
    // lands on the behaviour that shipped before this existed — each window
    // decides for itself — rather than on an exception.
    const original = globalThis.BroadcastChannel;
    // @ts-expect-error -- deliberately removing for this test
    delete globalThis.BroadcastChannel;
    restore = () => {
      globalThis.BroadcastChannel = original;
    };

    const windowA = renderHook(() => useSigninResumeClaim());
    const windowB = renderHook(() => useSigninResumeClaim());

    expect(() => act(() => windowA.result.current.claim(SESSION_ID))).not.toThrow();
    expect(windowB.result.current.claimedElsewhere(SESSION_ID)).toBe(false);
  });
});
