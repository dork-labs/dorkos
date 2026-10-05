/** @vitest-environment jsdom */
/** Nonissuing sequencing controls. Genuine owner tests remain in frame-admission.test. */
import { afterEach, expect, it, vi } from 'vitest';
import { FrameLifetimeController } from '@/layers/shared/lib/canvas-doc-frame';
import { DocChannelFrameResources } from '../model/doc-channel-frame-resources';
import { prepareDocFrameLoad, attachDocFramePort } from '../model/doc-channel-frame-admission';
afterEach(() => document.body.replaceChildren());
function observation() {
  const element = document.createElement('iframe');
  document.body.append(element);
  const controller = new FrameLifetimeController();
  const observed = controller.observeHostContext({
    frame: element.contentWindow,
    documentId: 'mechanics',
    resolvedSource: '/mechanics',
    logicalUrl: '/mechanics',
    reloadKey: 'one',
    sessionId: 'session',
    eligibility: 'served-document',
    exactOrigin: 'null',
    transportOwner: {},
    publisherEpoch: 1,
  })!;
  return { controller, observed };
}
it('performs a captured load once and delegates association without accepting authority DTOs', () => {
  const f = observation(),
    resources = new DocChannelFrameResources(),
    ticket = resources.begin();
  const complete = vi.fn(() => f.controller.observeLoaded(f.observed)),
    accept = vi.fn(() => true);
  const operation = prepareDocFrameLoad(resources, ticket, {
    current: () => true,
    complete,
    accept,
  });
  const loaded = operation.completeLoad()!;
  expect(loaded.loaded).toBe(true);
  expect(accept).toHaveBeenCalledWith(loaded);
  expect(operation.completeLoad()).toBeNull();
  expect(complete).toHaveBeenCalledTimes(1);
  f.controller.retire();
});
it.each(['current', 'complete', 'accept'] as const)(
  'nested ticket at %s prevents stale load publication',
  (phase) => {
    const f = observation(),
      resources = new DocChannelFrameResources(),
      ticket = resources.begin();
    const complete = vi.fn(() => {
      if (phase === 'complete') resources.begin();
      return f.controller.observeLoaded(f.observed);
    });
    const accept = vi.fn(() => {
      if (phase === 'accept') resources.begin();
      return true;
    });
    const operation = prepareDocFrameLoad(resources, ticket, {
      current: () => {
        if (phase === 'current') resources.begin();
        return true;
      },
      complete,
      accept,
    });
    expect(operation.completeLoad()).toBeNull();
    if (phase === 'current') expect(complete).not.toHaveBeenCalled();
    if (phase === 'complete') expect(accept).not.toHaveBeenCalled();
    expect(resources.current(ticket)).toBe(false);
    f.controller.retire();
  }
);

// Mechanics only: genuine HTTP + issuer ownership is covered by owner and lifetime controls.
it.each(['current', 'bindingCurrent', 'createPort', 'portCurrent'] as const)(
  'post-acquisition %s throw releases the captured envelope and retains undefined',
  (phase) => {
    const resources = new DocChannelFrameResources(),
      ticket = resources.begin();
    const release = vi.fn(() => {
      throw new Error('cleanup');
    });
    const binding = {} as import('@/layers/shared/lib/canvas-doc-frame').FrameDocBinding;
    const port = {} as import('@/layers/shared/lib/canvas-doc-frame').BoundDocPort;
    let acquired = false;
    const invoke = (name: string) => {
      if (acquired && phase === name) throw undefined;
      return true;
    };
    let caught = false,
      cause: unknown = 'not thrown';
    try {
      attachDocFramePort(resources, ticket, {
        current: () => invoke('current'),
        acquire: () => {
          acquired = true;
          return { binding, release };
        },
        bindingCurrent: () => invoke('bindingCurrent'),
        createPort: () => {
          invoke('createPort');
          return port;
        },
        portCurrent: () => invoke('portCurrent'),
      });
    } catch (error) {
      caught = true;
      cause = error;
    }
    expect(caught).toBe(true);
    expect(cause).toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
  }
);
it('successful resource transfer releases once on retirement rather than either provisional finally', () => {
  const resources = new DocChannelFrameResources(),
    ticket = resources.begin();
  const release = vi.fn();
  const binding = {} as import('@/layers/shared/lib/canvas-doc-frame').FrameDocBinding;
  const port = {} as import('@/layers/shared/lib/canvas-doc-frame').BoundDocPort;
  expect(
    attachDocFramePort(resources, ticket, {
      current: () => true,
      acquire: () => ({ binding, release }),
      bindingCurrent: () => true,
      createPort: () => port,
      portCurrent: () => true,
    })
  ).toBe(port);
  expect(release).not.toHaveBeenCalled();
  resources.begin();
  resources.begin();
  expect(release).toHaveBeenCalledOnce();
});

it.each(['primary', 'refused'] as const)(
  'propagates the exact %s failure after independently releasing a provisional resource',
  (kind) => {
    const resources = new DocChannelFrameResources();
    const ticket = resources.begin();
    const primary = new Error('primary operation');
    const cleanup = new Error('sole cleanup');
    const release = vi.fn(() => {
      throw cleanup;
    });
    const binding = {} as import('@/layers/shared/lib/canvas-doc-frame').FrameDocBinding;
    const createPort = vi.fn(() => {
      throw primary;
    });
    let caught = false;
    let cause: unknown;
    try {
      attachDocFramePort(resources, ticket, {
        current: () => true,
        acquire: () => ({ binding, release }),
        bindingCurrent: () => kind !== 'refused',
        createPort,
        portCurrent: () => true,
      });
    } catch (error) {
      caught = true;
      cause = error;
    }
    expect(caught).toBe(true);
    expect(cause).toBe(kind === 'primary' ? primary : cleanup);
    expect(release).toHaveBeenCalledOnce();
    expect(createPort).toHaveBeenCalledTimes(kind === 'primary' ? 1 : 0);
  }
);
