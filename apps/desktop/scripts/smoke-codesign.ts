/**
 * Ad-hoc re-signing for the packaged smoke, moved out of `smoke-packaged.ts`
 * unchanged so that file stays under its line ratchet.
 *
 * @module scripts/smoke-codesign
 */
import { execFileSync, spawnSync } from 'child_process';

/**
 * Make an unsigned build launchable, without touching a signed one.
 *
 * `hardenedRuntime: true` turns on macOS **library validation**: every Mach-O
 * loaded into the process must share the main executable's signing identity.
 * A Developer ID build satisfies that — electron-builder signs the app, its
 * frameworks and its native modules with one identity. An unsigned build may
 * not: when electron-builder ad-hoc-signs each binary separately, the loader
 * refuses the app's own Electron Framework with
 *
 * > Library not loaded: @rpath/Electron Framework.framework/Electron Framework
 * > … mapping process and mapped file (non-platform) have different Team IDs
 *
 * and the app dies before `main` runs. Re-signing ad-hoc in one pass clears the
 * hardened-runtime flag and makes it load.
 *
 * This does not weaken what the smoke proves. Library validation is about
 * *code identity*, not about the packaged layout, the asar reads, the native
 * `dlopen`s or the server boot — the things under test here. The shipped build
 * keeps `hardenedRuntime: true` (with the entitlements that make it work), and
 * `desktop-release.yml`'s "Verify the macOS app bundle" step is what asserts its signature.
 *
 * Conditional, not unconditional, because it is not always needed — a local
 * pack hit this; the same pack on a GitHub macOS runner did not (electron-
 * builder left the Electron-signed binaries alone there). A build signed with a
 * real identity is left strictly alone either way: re-signing one would destroy
 * the signature the release is about to notarize.
 *
 * @param appPath - Absolute path to the `.app` bundle.
 * @returns Whether the app was re-signed.
 */
export function relaxAdhocLibraryValidation(appPath: string): boolean {
  // codesign writes its description to stderr, not stdout.
  const probe = spawnSync('codesign', ['-dvvv', appPath], { encoding: 'utf-8' });
  const description = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  const isAdhoc = /^Signature=adhoc$/m.test(description);
  const hasHardenedRuntime = /flags=\S*\(.*\bruntime\b.*\)/.test(description);
  if (!isAdhoc || !hasHardenedRuntime) return false;

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  return true;
}
