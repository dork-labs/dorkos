import { afterEach, expect, it, vi } from 'vitest';
import { BrowserRuntimeClassSchema, readOriginalBrowserRuntimeClass } from '../runtime-class.js';
afterEach(() => vi.unstubAllGlobals());
it('reads original process version/ABI/platform and freezes the observed availability surface', () => {
  const original = readOriginalBrowserRuntimeClass();
  expect(original.nodeVersion).toBe(process.versions.node);
  expect(original.modulesABI).toBe(process.versions.modules);
  expect(original.platform).toBe(process.platform);
  expect(original.arch).toBe(process.arch);
  expect(original.electronVersion).toBe(process.versions.electron ?? null);
  expect(Object.isFrozen(original)).toBe(true);
  expect(Object.isFrozen(original.surface)).toBe(true);
});
it('refuses missing original primitive availability rather than replacing it with a declared class', () => {
  vi.stubGlobal('AbortSignal', { any: undefined, timeout: () => {} });
  expect(() => readOriginalBrowserRuntimeClass()).toThrow();
});
it('refuses unsupported versions, missing ABI and mismatched Electron runtime kind', () => {
  const original = readOriginalBrowserRuntimeClass();
  expect(() => BrowserRuntimeClassSchema.parse({ ...original, nodeVersion: '22.22.2' })).toThrow();
  expect(() => BrowserRuntimeClassSchema.parse({ ...original, modulesABI: '' })).toThrow();
  expect(() =>
    BrowserRuntimeClassSchema.parse({ ...original, kind: 'node', electronVersion: '40.0.0' })
  ).toThrow();
});

it('class identity is independent of executable location while refusing caller-supplied extra binary fields', () => {
  const original = readOriginalBrowserRuntimeClass();
  const capturedProcess = process;
  vi.stubGlobal(
    'process',
    new Proxy(capturedProcess, {
      get(target, key, receiver) {
        if (key === 'execPath') return '/owned/alternate-build/node';
        return Reflect.get(target, key, receiver);
      },
    })
  );
  expect(readOriginalBrowserRuntimeClass()).toEqual(original);
  expect(() =>
    BrowserRuntimeClassSchema.parse({ ...original, nodeExecutableSHA256: 'a'.repeat(64) })
  ).toThrow();
});
