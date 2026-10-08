import { expect, it, vi } from 'vitest';
import { observeOriginalSDKIframeSessions } from './original-iframe-session-observer.fixture.js';
import type { createControllerProxyAuthentication } from '../../../../../../../../packages/browser/src/runtime/identity/controller-proxy-authentication.js';
type Transport = Parameters<typeof createControllerProxyAuthentication>[0];
const url = 'https://owned.example/oopif/fa71cdd8-4c56-41ec-8c62-9f540884fc88/positive';
function fixture() {
  const wire: Transport = { send: vi.fn(), close: vi.fn() };
  const current = vi.fn();
  const owner = observeOriginalSDKIframeSessions(wire, 'default', 'page-target', current);
  const forwarded = vi.fn();
  owner.transport.onmessage = forwarded;
  const emit = (packet: object) => wire.onmessage!(packet);
  const page = () =>
    emit({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'page-session',
        targetInfo: {
          type: 'page',
          targetId: 'page-target',
          browserContextId: 'default',
          url: 'https://owned.example',
        },
      },
    });
  const frame = (parent = 'page-session', context = 'default', type = 'iframe') =>
    emit({
      method: 'Target.attachedToTarget',
      sessionId: parent,
      params: {
        sessionId: 'iframe-session',
        targetInfo: { type, targetId: 'iframe-target', browserContextId: context, url },
      },
    });
  return { wire, owner, current, emit, page, frame, forwarded };
}
it('requires actual SDK iframe attachment under original page session before accepting URL', () => {
  const f = fixture();
  expect(() => f.owner.requireOriginalFrame(url)).toThrow();
  f.page();
  f.frame();
  expect(f.owner.requireOriginalFrame(url)).toEqual({
    target: 'iframe-target',
    session: 'iframe-session',
    parent: 'page-session',
    url,
  });
  expect(f.forwarded).toHaveBeenCalledTimes(2);
  expect(f.wire.send).not.toHaveBeenCalled();
});
it.each([
  ['foreign', 'default', 'iframe'],
  ['page-session', 'foreign', 'iframe'],
  ['page-session', 'default', 'page'],
])('DOM URL without original frame attribution refuses %s/%s/%s', (parent, context, type) => {
  const f = fixture();
  f.page();
  f.frame(parent, context, type);
  expect(() => f.owner.requireOriginalFrame(url)).toThrow('ORIGINAL_LIVE_OOPIF_SESSION_REQUIRED');
});
it('detached original session cannot qualify a live frame', () => {
  const f = fixture();
  f.page();
  f.frame();
  f.emit({
    method: 'Target.detachedFromTarget',
    sessionId: 'page-session',
    params: { sessionId: 'iframe-session' },
  });
  expect(() => f.owner.requireOriginalFrame(url)).toThrow();
});
it.each([false, undefined])(
  'original currentness rejection retains exact falsy cause %s',
  (value) => {
    const f = fixture();
    f.page();
    f.frame();
    f.current.mockImplementation(() => {
      throw value;
    });
    let first: { value: unknown } | undefined;
    try {
      f.owner.requireOriginalFrame(url);
    } catch (reason) {
      first = { value: reason };
    }
    expect(first).toEqual({ value });
  }
);

it('a foreign parent detach does not replace the retained original frame relationship', () => {
  const f = fixture();
  f.page();
  f.frame();
  f.emit({
    method: 'Target.detachedFromTarget',
    sessionId: 'foreign-parent',
    params: { sessionId: 'iframe-session' },
  });
  expect(f.owner.requireOriginalFrame(url).parent).toBe('page-session');
});
