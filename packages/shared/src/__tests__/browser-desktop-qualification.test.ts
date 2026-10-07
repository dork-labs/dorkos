import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  readOriginalDesktopFrame,
  writeOriginalDesktopFrame,
  DesktopQualificationReplySchema,
  DesktopQualificationRuntimeClassSchema,
} from '../browser-desktop-qualification.js';

describe('original desktop qualification pipe', () => {
  it('joins the original request and exact prefixed parent hello through real streams', async () => {
    const request = new PassThrough(),
      response = new PassThrough();
    const signal = new AbortController();
    const originalRequest = readOriginalDesktopFrame(request, signal.signal);
    const originalHello = readOriginalDesktopFrame(response, signal.signal, 'owned ');
    try {
      await writeOriginalDesktopFrame(request, { type: 'request' });
      expect(await originalRequest).toEqual({ type: 'request' });
      response.write('ordinary startup log\n');
      await writeOriginalDesktopFrame(response, { type: 'hello' }, 'owned ');
      expect(await originalHello).toEqual({ type: 'hello' });
      expect(request.listenerCount('data')).toBe(0);
      expect(response.listenerCount('data')).toBe(0);
    } finally {
      signal.abort();
      request.destroy();
      response.destroy();
      await Promise.allSettled([originalRequest, originalHello]);
    }
  });
  for (const cause of [false, undefined])
    it(`preserves original abort ${String(cause)}`, async () => {
      const input = new PassThrough();
      const signal = new AbortController();
      const original = readOriginalDesktopFrame(input, signal.signal);
      // Native AbortController replaces an undefined reason; emit the genuine
      // original stream error for that primitive instead.
      input.emit('error', cause);
      await expect(original).rejects.toBe(cause);
      input.destroy();
    });
  it('retains held original write completion', async () => {
    let release: (() => void) | undefined;
    const returnOriginal = () => {
      const done = release;
      release = undefined; // Publish consumption before reentrant original callback.
      done?.();
    };
    const output = new Writable({
      write(_chunk, _encoding, done) {
        release = done;
      },
    });
    const original = writeOriginalDesktopFrame(output, { type: 'request' });
    let returned = false;
    void original.then(() => {
      returned = true;
    });
    try {
      await Promise.resolve();
      expect(returned).toBe(false);
      expect(release).toBeTypeOf('function');
      returnOriginal();
      await original;
    } finally {
      returnOriginal();
      output.destroy();
      await Promise.allSettled([original]);
    }
  });
  for (const cause of [false, undefined])
    it(`keeps callback-success then original write throw ${String(cause)}`, async () => {
      const output = new PassThrough();
      output.write = new Proxy(output.write, {
        apply(_target, _receiver, args) {
          const done = args[1];
          if (typeof done !== 'function') throw new Error('ORIGINAL_WRITE_CALLBACK_REQUIRED');
          done();
          throw cause;
        },
      });
      await expect(writeOriginalDesktopFrame(output, { type: 'request' })).rejects.toBe(cause);
      output.destroy();
    });
  it('refuses an extra frame and never treats raw JSON as qualification', async () => {
    const input = new PassThrough();
    const signal = new AbortController();
    const original = readOriginalDesktopFrame(input, signal.signal);
    input.write('{}\n{}\n');
    await expect(original).rejects.toThrow('DESKTOP_QUALIFICATION_EXTRA_FRAME');
    expect(() =>
      DesktopQualificationReplySchema.parse({ nonce: 'a'.repeat(48), grant: {} })
    ).toThrow();
    input.destroy();
  });
});

// Exact toy original-runtime descriptor exercises the data boundary, not runtime acceptance.
const originalRuntime = {
  kind: 'electron',
  nodeVersion: '24.14.1',
  modulesABI: '137',
  v8Version: '13.6.233.10',
  opensslVersion: '3.5.2',
  uvVersion: '1.51.0',
  electronVersion: '40.0.0',
  platform: 'darwin',
  arch: 'arm64',
  featureContract: 'browser-owner-runtime-v1',
  surface: {
    abortSignalAny: true,
    abortSignalTimeout: true,
    workerThreads: true,
    callbackDnsCancel: true,
    bigint: true,
  },
};
describe('desktop qualification runtime-class boundary', () => {
  it('preserves an exact nested original descriptor through serialization', () => {
    const original = DesktopQualificationRuntimeClassSchema.parse(originalRuntime);
    expect(
      DesktopQualificationRuntimeClassSchema.parse(JSON.parse(JSON.stringify(original)))
    ).toEqual(original);
  });
  it('refuses missing surface facts, non-desktop runtime kinds and unsupported original feature facts', () => {
    expect(
      DesktopQualificationRuntimeClassSchema.safeParse({
        ...originalRuntime,
        kind: 'node',
        electronVersion: null,
      }).success
    ).toBe(false);
    expect(
      DesktopQualificationRuntimeClassSchema.safeParse({
        ...originalRuntime,
        surface: { ...originalRuntime.surface, callbackDnsCancel: false },
      }).success
    ).toBe(false);
    const { uvVersion: _uv, ...incomplete } = originalRuntime;
    expect(DesktopQualificationRuntimeClassSchema.safeParse(incomplete).success).toBe(false);
  });
});
