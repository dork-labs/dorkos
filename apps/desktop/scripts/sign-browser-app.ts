import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import restoreBrowserLibrary from './restore-browser-library';

type Options = Readonly<{
  app: string;
  identity?: string;
  keychain?: string;
  ignore?: (file: string) => boolean;
}>;
type Packager = { appInfo: { productFilename: string }; info: { appDir: string } };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function boundedFile(filename: string, cap: number) {
  const stat = lstatSync(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > cap ||
    realpathSync(filename) !== filename
  )
    throw new Error('Desktop signing original is not a bounded real file.');
  const bytes = readFileSync(filename);
  const after = lstatSync(filename);
  if (
    stat.ino !== after.ino ||
    stat.dev !== after.dev ||
    stat.size !== after.size ||
    stat.mtimeMs !== after.mtimeMs ||
    stat.ctimeMs !== after.ctimeMs
  )
    throw new Error('Desktop signing original changed.');
  return bytes;
}
/** Preserve the original signing filter and exclude only the already-signed exact observer. */
export function retainDesktopSigningIgnore(
  binary: string,
  originalIgnore?: (file: string) => boolean
) {
  return (file: string) => file === binary || originalIgnore?.(file) === true;
}
/** Run only from electron-builder's original signing owner, before its unchanged recursive app signer. */
export default async function signBrowserApp(original: Options, packager: Packager) {
  if (!original.identity)
    throw new Error('Desktop browser signing requires the original app signing identity.');
  const app = realpathSync(original.app);
  const root = path.join(app, 'Contents/Resources/app.asar.unpacked');
  const native = path.join(root, 'dist/browser/native');
  const binary = path.join(native, 'darwin-process-observer');
  const manifestFile = path.join(native, 'darwin-process-observer.manifest.json');
  const packageFile = path.join(native, 'package-manifest.json');
  const manifest = JSON.parse(boundedFile(manifestFile, 16384).toString());
  const packaged = JSON.parse(boundedFile(packageFile, 16384).toString());
  const before = boundedFile(binary, 4 * 1024 * 1024);
  if (
    manifest.availability !== 'available' ||
    manifest.platform !== 'darwin' ||
    manifest.arch !== 'arm64' ||
    manifest.binary?.name !== 'darwin-process-observer' ||
    manifest.binary.sha256 !== digest(before) ||
    manifest.binary.bytes !== before.length ||
    packaged.nativeManifestSHA256 !== digest(boundedFile(manifestFile, 16384))
  )
    throw new Error('Desktop original native manifest does not match the compiler output.');
  const args = ['--force', '--sign', original.identity, '--timestamp', '--options', 'runtime'];
  if (original.keychain) args.push('--keychain', original.keychain);
  execFileSync('/usr/bin/codesign', [...args, binary], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', binary], { stdio: 'inherit' });
  const signed = boundedFile(binary, 4 * 1024 * 1024);
  manifest.binary.sha256 = digest(signed);
  manifest.binary.bytes = signed.length;
  const sealed = Buffer.from(JSON.stringify(manifest) + '\n');
  writeFileSync(manifestFile, sealed);
  packaged.nativeManifestSHA256 = digest(sealed);
  writeFileSync(packageFile, JSON.stringify(packaged) + '\n');
  await restoreBrowserLibrary({
    appOutDir: path.dirname(app),
    electronPlatformName: 'darwin',
    packager,
  });
  const retained = [binary, manifestFile, packageFile].map((filename) => ({
    filename,
    hash: digest(boundedFile(filename, 4 * 1024 * 1024)),
  }));
  // Resolve the actual default signer from the declared builder, preserving its retry/options policy.
  const require = createRequire(path.join(packager.info.appDir, 'package.json'));
  const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
  const module = builderRequire('app-builder-lib/out/codeSign/macCodeSign.js');
  const defaultSign = module.sign;
  if (typeof defaultSign !== 'function') throw new Error('Desktop original app signer is missing.');
  const originalIgnore = original.ignore;
  await defaultSign({
    ...original,
    ignore: retainDesktopSigningIgnore(binary, originalIgnore),
  });
  for (const row of retained)
    if (digest(boundedFile(row.filename, 4 * 1024 * 1024)) !== row.hash)
      throw new Error('Desktop app signing changed a sealed native original.');
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', binary], { stdio: 'inherit' });
}
