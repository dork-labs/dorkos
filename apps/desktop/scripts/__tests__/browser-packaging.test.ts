import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { expect, it } from 'vitest';
import { assertDesktopBrowserPackaging } from '../browser-packaging';
const manifest = { dependencies: { 'playwright-core': '1.63.0' } };
const config = {
  files: ['package.json', 'dist/**'],
  mac: { sign: 'dist/browser/sign-browser-app.cjs' },
  asarUnpack: [
    'package.json',
    'dist/server/server-entry.mjs',
    'dist/browser/**',
    'dist/drizzle/**',
    '**/node_modules/**',
  ],
};
it('requires one reachable real-file controller/library/assets tree', () => {
  expect(() => assertDesktopBrowserPackaging(manifest, config)).not.toThrow();
});
it.each(config.asarUnpack)('refuses missing real-file declaration %s', (path) => {
  expect(() =>
    assertDesktopBrowserPackaging(manifest, {
      ...config,
      asarUnpack: config.asarUnpack.filter((value) => value !== path),
    })
  ).toThrow('unpack declaration is missing');
});
it('refuses a duplicate unreachable extraResources copy', () => {
  expect(() =>
    assertDesktopBrowserPackaging(manifest, {
      ...config,
      extraResources: [{ from: 'dist/browser', to: 'browser' }],
    })
  ).toThrow('single-copy');
});
it('VM packaging needs no host library and refuses the obsolete restore hook', () => {
  expect(() => assertDesktopBrowserPackaging({ dependencies: {} }, config)).not.toThrow();
  expect(() =>
    assertDesktopBrowserPackaging(manifest, {
      ...config,
      afterPack: 'dist/browser/restore-library.cjs',
    })
  ).toThrow('superseded');
  expect(() =>
    assertDesktopBrowserPackaging(manifest, { ...config, files: ['package.json'] })
  ).toThrow('package files');
});

it('checks the actual release YAML rather than a constructed signing configuration', () => {
  const actual = parse(
    readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8')
  );
  expect(() => assertDesktopBrowserPackaging(manifest, actual)).not.toThrow();
  expect(actual.mac.sign).toBe('dist/browser/sign-browser-app.cjs');
  expect(actual.dmg.sign).toBe(true);
});
