import {
  browserVMAssetNames,
  verifyBrowserVMRelease,
} from '../../../scripts/browser-vm-release-copy.mjs';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

type Options = Readonly<{
  app: string;
  identity?: string;
  keychain?: string;
  ignore?: (file: string) => boolean;
}>;
type Packager = { appInfo: { productFilename: string }; info: { appDir: string } };
/** Preserve the builder's original filter and exactly the independently pre-signed VM assets. */
export function retainDesktopSigningIgnore(
  originalIgnore: ((file: string) => boolean) | undefined,
  retainedVMAssets: readonly string[]
) {
  return (file: string) => retainedVMAssets.includes(file) || originalIgnore?.(file) === true;
}
/** Publisher-time original electron-builder sign owner; no customer signer/compiler. */
export default async function signBrowserApp(original: Options, packager: Packager) {
  if (!original.identity)
    throw new Error('Desktop signing requires the original app signing identity.');
  // This hook is bundled CommonJS. appDir is the original desktop package selected
  // by electron-builder; do not use import.meta in that emitted format.
  const appDir = realpathSync(packager.info.appDir);
  const repositoryRoot = realpathSync(path.resolve(appDir, '../..'));
  const app = realpathSync(original.app);
  const directory = path.join(app, 'Contents/Resources/app.asar.unpacked/dist/browser/vm');
  const before = await verifyBrowserVMRelease(repositoryRoot, directory);
  const retained = before.available
    ? browserVMAssetNames.map((name) => path.join(directory, name))
    : [];
  if (before.available)
    for (const name of [
      'qemu-system-aarch64',
      'atomic-child.node',
      'managed-browser-catalogue.dylib',
    ])
      execFileSync('/usr/bin/codesign', ['--verify', '--strict', path.join(directory, name)], {
        stdio: 'inherit',
      });
  const require = createRequire(path.join(appDir, 'package.json'));
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
  const defaultSign = builderRequire('app-builder-lib/out/codeSign/macCodeSign.js').sign;
  if (typeof defaultSign !== 'function') throw new Error('Desktop original app signer is missing.');
  let first: { value: unknown } | undefined;
  try {
    await defaultSign({
      ...original,
      ignore: retainDesktopSigningIgnore(original.ignore, retained),
    });
  } catch (value) {
    first = { value };
  }
  // Preserve the signing cause even if independent post-sign verification fails.
  try {
    await verifyBrowserVMRelease(repositoryRoot, directory);
  } catch (value) {
    first ??= { value };
  }
  if (first) throw first.value;
}
