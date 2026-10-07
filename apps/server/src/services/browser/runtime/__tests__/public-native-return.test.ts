import { expect, it, vi } from 'vitest';
import { joinOriginalPublicNativeReturn } from './public-native-return.js';
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
it.each([false, undefined])(
  'joins close and physical read after exact original body failure %s',
  async (value) => {
    const close = vi.fn(async () => {
      throw new Error('LATER_CLOSE_FAILURE');
    });
    const observe = vi.fn(async () => {
      throw new Error('LATER_NATIVE_UNKNOWN');
    });
    await expect(
      joinOriginalPublicNativeReturn({ body: Promise.reject(value), close, observe })
    ).rejects.toBe(value);
    expect(close).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledOnce();
  }
);
it.each([false, undefined])(
  'retains close failure %s and still consumes independent physical read',
  async (value) => {
    const observe = vi.fn(async () => {});
    await expect(
      joinOriginalPublicNativeReturn({
        body: Promise.resolve(),
        close: async () => {
          throw value;
        },
        observe,
      })
    ).rejects.toBe(value);
    expect(observe).toHaveBeenCalledOnce();
  }
);
it('a held original close prevents physical reads or claimed completion', async () => {
  let release!: () => void;
  const held = new Promise<void>((yes) => {
    release = yes;
  });
  const observe = vi.fn(async () => {});
  let returned = false;
  const owner = joinOriginalPublicNativeReturn({
    body: Promise.reject(false),
    close: () => held,
    observe,
  }).finally(() => {
    returned = true;
  });
  const failed = expect(owner).rejects.toBe(false);
  await turn();
  expect(observe).not.toHaveBeenCalled();
  expect(returned).toBe(false);
  release();
  await failed;
  expect(observe).toHaveBeenCalledOnce();
});
it('a successful body and close still refuses actual unknown physical evidence', async () => {
  const unknown = new Error('ORIGINAL_PROCESS_UNKNOWN');
  await expect(
    joinOriginalPublicNativeReturn({
      body: Promise.resolve(),
      close: async () => {},
      observe: async () => {
        throw unknown;
      },
    })
  ).rejects.toBe(unknown);
});
it('captures original close and observation receivers before body settlement', async () => {
  let release!: () => void;
  const held = new Promise<void>((yes) => {
    release = yes;
  });
  const close = vi.fn(async () => {}),
    observe = vi.fn(async () => {});
  type ReturnOptions = Parameters<typeof joinOriginalPublicNativeReturn>[0];
  const options: { -readonly [K in keyof ReturnOptions]: ReturnOptions[K] } = {
    body: held,
    close,
    observe,
  };
  const owner = joinOriginalPublicNativeReturn(options);
  options.close = async () => {
    throw false;
  };
  options.observe = async () => {
    throw undefined;
  };
  release();
  await owner;
  expect(close).toHaveBeenCalledOnce();
  expect(observe).toHaveBeenCalledOnce();
});
