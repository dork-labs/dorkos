import { expect, it, vi } from 'vitest';
import { retainDesktopSigningIgnore } from '../sign-browser-app';
it('preserves original signing policy and exempts exactly selected pre-signed VM assets', () => {
  const directory = '/original/DorkOS.app/Contents/Resources/app.asar.unpacked/dist/browser/vm';
  const assets = [
    'qemu-system-aarch64',
    'atomic-child.node',
    'managed-browser-catalogue.dylib',
    'kernel.Image',
    'root-init.cpio',
    'root.raw',
    'blank-profile.raw',
  ].map((name) => `${directory}/${name}`);
  const original = vi.fn((file: string) => file.endsWith('.kext'));
  const ignore = retainDesktopSigningIgnore(original, assets);
  for (const file of assets) expect(ignore(file)).toBe(true);
  expect(original).not.toHaveBeenCalled();
  expect(ignore(`${assets[0]}-foreign`)).toBe(false);
  expect(ignore('/foreign/qemu-system-aarch64')).toBe(false);
  expect(ignore('/original/driver.kext')).toBe(true);
  expect(original.mock.calls.map(([file]) => file)).toEqual([
    `${assets[0]}-foreign`,
    '/foreign/qemu-system-aarch64',
    '/original/driver.kext',
  ]);
});
