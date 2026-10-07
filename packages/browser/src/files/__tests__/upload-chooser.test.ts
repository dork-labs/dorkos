import { expect, it, onTestFinished, vi } from 'vitest';
import type { CDPSession } from 'playwright-core';
import { OwnedUploadChooser, type OwnedUploadLease } from '../upload-chooser.js';
import { parseBrowserBinding } from '../../contracts.js';
const binding = parseBrowserBinding({
  browserId: 'browser_upload_fixture_0001',
  browserGeneration: 1,
  tabId: 'tab_upload_fixture_00000001',
  navigationGeneration: 1,
  viewportVersion: 1,
  inputGeneration: 1,
  epoch: 1,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture(
  options: {
    arm?: () => Promise<void>;
    native?: () => Promise<void>;
    release?: () => void;
  } = {}
) {
  const originals: { owner?: OwnedUploadChooser } = {};
  onTestFinished(async () => {
    options.release?.();
    await originals.owner?.close().catch(() => undefined);
  });
  let listener: ((value: unknown) => void) | undefined,
    active = true,
    intercepted = false;
  const native = vi.fn(options.native ?? (async () => {}));
  const send = vi.fn(async (method: string, params?: { enabled?: boolean }) => {
    if (method === 'Page.getFrameTree')
      return { frameTree: { frame: { id: 'actual-main-frame' } } };
    if (method === 'Page.setInterceptFileChooserDialog') {
      if (params?.enabled) await options.arm?.();
      intercepted = params?.enabled === true;
      return {};
    }
    if (method === 'DOM.setFileInputFiles') {
      await native();
      return {};
    }
    throw new Error('UNEXPECTED_NATIVE_METHOD');
  });
  const session = {
    send,
    on: vi.fn((_name: string, callback: (value: unknown) => void) => {
      listener = callback;
    }),
    off: vi.fn(() => {
      listener = undefined;
    }),
  } as unknown as CDPSession;
  const consume = vi.fn(async () => ({
    path: '/private/test-staging/opaque/payload',
    byteLength: 12,
  }));
  const close = vi.fn(async () => {});
  const lease: OwnedUploadLease = {
    artifactId: 'artifact_upload_fixture_01',
    binding,
    consume,
    close,
    enter: async (effect) => {
      await effect();
    },
  };
  const owner = new OwnedUploadChooser(session, lease, () => active);
  originals.owner = owner;
  return {
    owner,
    send,
    native,
    consume,
    close,
    intercepted: () => intercepted,
    event: (frameId = 'actual-main-frame') =>
      listener?.({ frameId, backendNodeId: 73, mode: 'selectSingle' }),
    lose: () => {
      active = false;
    },
  };
}
// Protocol doubles establish genuine fixed method/receiver ordering and settlement, not native chooser acceptance.
it('awaits original interception ACK before click admission and uploads only the exact staged path/node once', async () => {
  const held = deferred<void>();
  const f = fixture({ arm: () => held.promise, release: () => held.resolve() });
  let admitted = false;
  const arming = f.owner.begin(new AbortController().signal).then(() => {
    admitted = true;
  });
  await vi.waitFor(() =>
    expect(f.send).toHaveBeenCalledWith('Page.setInterceptFileChooserDialog', {
      enabled: true,
    })
  );
  expect(admitted).toBe(false);
  expect(f.intercepted()).toBe(false);
  expect(f.native).not.toHaveBeenCalled();
  held.resolve();
  await arming;
  expect(f.intercepted()).toBe(true);
  f.event();
  await f.owner.complete(binding, new AbortController().signal);
  expect(f.send).toHaveBeenCalledWith('DOM.setFileInputFiles', {
    files: ['/private/test-staging/opaque/payload'],
    backendNodeId: 73,
  });
  expect(f.consume).toHaveBeenCalledOnce();
  expect(f.native).toHaveBeenCalledOnce();
  expect(() => f.owner.complete(binding, new AbortController().signal)).toThrow(
    'UPLOAD_REPLAY_REFUSED'
  );
  await f.owner.close();
  expect(f.intercepted()).toBe(false);
  expect(f.close).toHaveBeenCalledOnce();
});
it('refuses cross-frame original chooser without staged consumption or native file command', async () => {
  const f = fixture();
  await f.owner.begin(new AbortController().signal);
  f.event('foreign-frame');
  await expect(f.owner.complete(binding, new AbortController().signal)).rejects.toThrow(
    'UPLOAD_CHOOSER_REFUSED'
  );
  expect(f.consume).not.toHaveBeenCalled();
  expect(f.native).not.toHaveBeenCalled();
  await expect(f.owner.close()).rejects.toThrow('UPLOAD_CHOOSER_REFUSED');
});
it('close joins held original native file upload before interception disable and staging deletion', async () => {
  const held = deferred<void>();
  const f = fixture({
    native: () => held.promise,
    release: () => held.resolve(),
  });
  await f.owner.begin(new AbortController().signal);
  f.event();
  const original = f.owner.complete(binding, new AbortController().signal);
  void original.catch(() => undefined);
  await vi.waitFor(() => expect(f.native).toHaveBeenCalledOnce());
  let settled = false;
  const closing = f.owner.close();
  void closing.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(f.intercepted()).toBe(true);
  expect(f.close).not.toHaveBeenCalled();
  held.resolve();
  await expect(original).rejects.toThrow('UPLOAD_AUTHORITY_REFUSED');
  await expect(closing).rejects.toThrow('UPLOAD_AUTHORITY_REFUSED');
  expect(f.intercepted()).toBe(false);
  expect(f.close).toHaveBeenCalledOnce();
});
it('retains exact undefined native failure through independent original staging cleanup', async () => {
  const f = fixture({
    native: async () => {
      throw undefined;
    },
  });
  await f.owner.begin(new AbortController().signal);
  f.event();
  await expect(f.owner.complete(binding, new AbortController().signal)).rejects.toBeUndefined();
  await expect(f.owner.close()).rejects.toBeUndefined();
  expect(f.close).toHaveBeenCalledOnce();
});
it('revocation after native arming fences file consumption and still disables original interception', async () => {
  const f = fixture();
  await f.owner.begin(new AbortController().signal);
  f.lose();
  f.event();
  await expect(f.owner.complete(binding, new AbortController().signal)).rejects.toThrow(
    'UPLOAD_AUTHORITY_REFUSED'
  );
  expect(f.consume).not.toHaveBeenCalled();
  expect(f.native).not.toHaveBeenCalled();
  await expect(f.owner.close()).rejects.toThrow('UPLOAD_AUTHORITY_REFUSED');
  expect(f.intercepted()).toBe(false);
});
