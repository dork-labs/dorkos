/**
 * Where the pinned OpenCode platform package (`opencode-<platform>-<arch>`)
 * is installed. This package owns the pin, as an optional dependency, because
 * the binary is test-only: on `@dorkos/server` it would ship with the server
 * and make the desktop build treat the server as a per-platform package.
 * pnpm installs it beside this package only, so it is resolved from here.
 *
 * @module test-utils/opencode-binary
 */
import { createRequire } from 'node:module';

/**
 * The path of the installed `opencode-<key>/package.json`. Throws when the
 * package for this platform is not installed.
 *
 * @param key - `<platform>-<arch>`, for example `darwin-arm64`.
 */
export function resolveOpenCodePlatformManifest(key: string): string {
  return createRequire(import.meta.url).resolve(`opencode-${key}/package.json`);
}
