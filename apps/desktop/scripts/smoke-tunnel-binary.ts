import { existsSync, statSync } from 'fs';
import path from 'path';

/**
 * The tunnel binary, as the packaged app has to carry it.
 *
 * macOS/arm64 because this smoke only ever runs against a `.app` bundle (see
 * `main`). The Windows counterpart (`…-win32-x64-msvc/ngrok.win32-x64-msvc.node`)
 * is NOT checked anywhere: `desktop-release.yml`'s "Verify the Windows installer" step only
 * silent-installs the `.exe` and confirms `DorkOS.exe` landed, and never looks
 * in `app.asar.unpacked`.
 */
export const TUNNEL_BINARY = path.join(
  'node_modules',
  '@ngrok',
  'ngrok-darwin-arm64',
  'ngrok.darwin-arm64.node'
);

/** Smallest the tunnel binary could plausibly be — it is ~9 MB in practice. */
const TUNNEL_BINARY_MIN_BYTES = 1_000_000;

/**
 * Assert the ngrok binary Remote Access loads is really on disk, outside the
 * asar.
 *
 * This is the one family of the four whose absence no runtime assertion in the
 * packaged smoke can see: Claude and Codex show up as unregistered runtimes, esbuild as a
 * failed marketplace compilation, but a missing tunnel binary is invisible
 * until someone turns Remote Access on — which needs an ngrok account and a
 * network, so it cannot be part of a hermetic smoke. What CAN be checked
 * without either is that the file the loader will `dlopen` exists and is a
 * binary rather than a stub.
 *
 * Checked against the packaged app rather than the config, deliberately.
 * `scripts/build-server.ts` already proves `package.json` and
 * `electron-builder.yml` agree — 0.66.0's failure was one level below that:
 * the configuration was answerable and the copier still put nothing in the
 * app, and only the artifact can tell you so (#1458).
 *
 * @param appPath - Absolute path to the `.app` bundle.
 * @throws If the binary is missing or implausibly small.
 */
export function assertTunnelBinaryUnpacked(appPath: string): void {
  const binary = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', TUNNEL_BINARY);
  if (!existsSync(binary)) {
    throw new Error(
      `Packaged app has no tunnel binary at app.asar.unpacked/${TUNNEL_BINARY}. Remote Access ` +
        `would fail the moment it is switched on, with "Failed to load native binding" and a ` +
        `bare 500 — the app boots and looks healthy either way (#1458). Check that ` +
        `@ngrok/ngrok-darwin-arm64 is in package.json's optionalDependencies AND has an ` +
        `asarUnpack glob in electron-builder.yml.`
    );
  }
  const { size } = statSync(binary);
  if (size < TUNNEL_BINARY_MIN_BYTES) {
    throw new Error(
      `The packaged tunnel binary is ${size} bytes (expected at least ` +
        `${TUNNEL_BINARY_MIN_BYTES}). That is not a Mach-O library — a placeholder or a ` +
        `truncated copy would pass an existence check and still fail to dlopen.`
    );
  }
}
