import { describe, it, expect, beforeEach, vi } from 'vitest';

// Steer esbuild resolution + transform per test. `createRequire` is mocked so
// the real esbuild never runs — the guard's branches are exercised in isolation.
const h = vi.hoisted(() => ({
  resolveThrows: false as boolean,
  transform: (async () => ({ code: 'export const ok = true;' })) as (
    source: string,
    opts: unknown
  ) => Promise<{ code: string }>,
}));

vi.mock('node:module', () => ({
  createRequire: () => (id: string) => {
    if (id !== 'esbuild') throw new Error(`unexpected require: ${id}`);
    if (h.resolveThrows) throw new Error('Cannot find module esbuild');
    return { transform: h.transform };
  },
}));

// Must import after mock setup.
const { checkExtensionCompilation } = await import('../check-extension-compilation.js');

describe('checkExtensionCompilation', () => {
  beforeEach(() => {
    h.resolveThrows = false;
    h.transform = async () => ({ code: 'export const ok = true;' });
  });

  it('returns true when esbuild resolves and transpiles TypeScript', async () => {
    await expect(checkExtensionCompilation()).resolves.toBe(true);
  });

  it('returns false when esbuild is not installed (require throws)', async () => {
    h.resolveThrows = true;
    await expect(checkExtensionCompilation()).resolves.toBe(false);
  });

  it('returns false when esbuild resolves but its native binary cannot run', async () => {
    h.transform = async () => {
      throw new Error('The esbuild JavaScript API cannot be bundled');
    };
    await expect(checkExtensionCompilation()).resolves.toBe(false);
  });

  it('returns false when transform output lacks the compiled symbol', async () => {
    h.transform = async () => ({ code: '' });
    await expect(checkExtensionCompilation()).resolves.toBe(false);
  });
});
