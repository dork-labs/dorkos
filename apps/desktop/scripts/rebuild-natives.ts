import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_PKG = path.resolve(__dirname, '..');

const NATIVE_MODULES = ['better-sqlite3', 'node-pty'];

/**
 * Rebuild the two native addons the packaged server needs — better-sqlite3
 * and node-pty — against Electron's own Node ABI, immediately before
 * packaging.
 *
 * Runs from the PACKAGING entry points only (`pack`/`dist` scripts and the
 * desktop-release workflow), never from `build`: the rebuilt binaries live
 * in the pnpm store shared by the whole monorepo, so flipping them to
 * Electron's ABI breaks vitest/dev for every other package under plain Node
 * until a manual `pnpm rebuild better-sqlite3 node-pty`. Keeping the flip
 * scoped to packaging means a bare `pnpm build` (root turbo) stays
 * side-effect-free. After packaging locally, run that `pnpm rebuild` to
 * restore the system-Node binaries.
 *
 * Why this exists instead of electron-builder's built-in `npmRebuild`: that
 * automated step (`@electron/rebuild` invoked internally by electron-builder)
 * was observed producing a better-sqlite3 binary that reported a plausible
 * size/hash yet still failed to `dlopen` at runtime with a misleading "wrong
 * NODE_MODULE_VERSION" error — Node's generic fallback message for a native
 * addon load failure it can't otherwise explain, even with electron-builder's
 * `buildDependenciesFromSource: true` forcing a from-source compile. The
 * `@electron/rebuild` CLI, invoked directly (this script, via `execFileSync`
 * — its JS API throws `paths[0] must be of type string` in this monorepo's
 * npm-config environment, a known issue with calling it as a library rather
 * than a subprocess), reliably produces a working binary: it fetches the
 * correct prebuilt from npm's `_prebuilds` cache
 * (`<module>-v<pkgVersion>-electron-v<abi>-<platform>-<arch>.tar.gz`) via
 * `prebuild-install`, unlike whatever path electron-builder's internal
 * wrapper was taking. Verified by extracting that exact cached tarball and
 * `require()`-ing it directly under `ELECTRON_RUN_AS_NODE=1` — it loads
 * fine. electron-builder.yml sets `npmRebuild: false` so electron-builder
 * packages this already-correct binary as-is instead of redoing (and
 * re-breaking) the work.
 */
function main(): void {
  const electronPkg = JSON.parse(
    readFileSync(path.join(DESKTOP_PKG, 'node_modules/electron/package.json'), 'utf-8')
  ) as { version: string };

  console.log(
    `Rebuilding ${NATIVE_MODULES.join(', ')} for Electron ${electronPkg.version} (${process.arch})...`
  );
  // On Windows the `.bin` shim is `electron-rebuild.cmd`; the extensionless
  // Unix shim doesn't exist there. Node also refuses to spawn a `.cmd` without
  // `shell: true` (CVE-2024-27980 hardening), so opt into a shell on Windows
  // only. The args are all trusted (a package.json version, a fixed arch, and
  // a hardcoded module list) — no untrusted input reaches the shell.
  const isWindows = process.platform === 'win32';
  const cli = path.join(
    DESKTOP_PKG,
    'node_modules/.bin',
    isWindows ? 'electron-rebuild.cmd' : 'electron-rebuild'
  );
  execFileSync(
    cli,
    ['-f', '-v', electronPkg.version, '-a', process.arch, '-w', NATIVE_MODULES.join(',')],
    { cwd: DESKTOP_PKG, stdio: 'inherit', shell: isWindows }
  );
  console.log('✓ Native addons rebuilt for Electron.');
}

main();
