import { expect, it, vi } from 'vitest';
import { retainDesktopSigningIgnore } from '../sign-browser-app';
it('preserves the original signing filter and exempts only the exact previously signed observer', () => {
  const binary =
    '/original/DorkOS.app/Contents/Resources/app.asar.unpacked/dist/browser/native/darwin-process-observer';
  const original = vi.fn((file: string) => file.endsWith('.kext'));
  const ignore = retainDesktopSigningIgnore(binary, original);
  expect(ignore(binary)).toBe(true);
  expect(original).not.toHaveBeenCalled();
  expect(ignore(`${binary}-foreign`)).toBe(false);
  expect(ignore('/foreign/darwin-process-observer')).toBe(false);
  expect(ignore('/original/driver.kext')).toBe(true);
  expect(original.mock.calls.map(([file]) => file)).toEqual([
    `${binary}-foreign`,
    '/foreign/darwin-process-observer',
    '/original/driver.kext',
  ]);
});
