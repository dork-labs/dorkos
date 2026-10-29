/**
 * The OpenCode binary the real-binary tests run: the platform package
 * (`opencode-<platform>-<arch>`) that `packages/test-utils/package.json` pins
 * at an exact version (test-only, so it never ships with the server), checked byte for byte against the SHA-256 recorded here
 * before anything runs it.
 *
 * Before this, those tests looked for an `opencode` on PATH and skipped when
 * there was none, so in CI (which has none) they never ran. A pinned package
 * runs the same binary everywhere, and the hash means a changed or swapped file
 * is refused, never run: the lockfile's integrity hash covers the download,
 * this covers what is on disk when a test starts it. The platform packages are
 * used rather than the `opencode-ai` wrapper, which carries an install script
 * and an `opencode` command that would shadow a person's own on `PATH`.
 *
 * The version is the one DorkOS provisions for people (`OPENCODE_PACKAGE_VERSION`
 * in `providers/provision.ts`), so the tests run what ships. Updating OpenCode:
 * bump that constant, `@opencode-ai/sdk` and both platform packages in
 * `packages/test-utils/package.json` together, then record each `bin/opencode` SHA-256
 * below (`shasum -a 256` on the file from `npm pack opencode-<platform>@<version>`).
 *
 * @module services/runtimes/opencode/__tests__/pinned-opencode
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveOpenCodePlatformManifest } from '@dorkos/test-utils/opencode-binary';
import { OPENCODE_PACKAGE_VERSION } from '../providers/provision.js';

/** The pinned version, and the SHA-256 of `bin/opencode` for each platform it runs on. */
export const OPENCODE_PIN = {
  version: OPENCODE_PACKAGE_VERSION,
  sha256: {
    'darwin-arm64': '6d3e6458fce4b649edf974c19959d5dbfe1e7f255a503dcfc01215b24ad3ea5b',
    'linux-x64': '179ca421d61eefeadfa0c50e084a6e79c1623734732f0f4593f81ccfd3ab7ee9',
  } as Record<string, string>,
} as const;

/**
 * Proxy settings that send every address but this machine's to a port nobody
 * answers, in every spelling a client might read, so a real-binary test fails
 * rather than quietly reaching the internet.
 */
export const OFFLINE_PROXY_ENV: Readonly<Record<string, string>> = {
  HTTPS_PROXY: 'http://127.0.0.1:9',
  HTTP_PROXY: 'http://127.0.0.1:9',
  ALL_PROXY: 'http://127.0.0.1:9',
  https_proxy: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9',
  all_proxy: 'http://127.0.0.1:9',
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
};

/** Binaries already verified in this process, so each is hashed once. */
const verified = new Map<string, string>();

/** A file's SHA-256, read a megabyte at a time. */
function sha256Of(file: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1 << 20);
  const fd = fs.openSync(file, 'r');
  try {
    for (let read = fs.readSync(fd, buffer); read > 0; read = fs.readSync(fd, buffer)) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * The pinned `opencode` binary for this machine, verified, or `null` when this
 * platform has no recorded hash (the tests skip there).
 *
 * Throws, never returns a path, when the installed package is another version
 * or the file's bytes differ from the pin: a test must fail rather than run a
 * binary nobody recorded.
 *
 * @param platform - `process.platform`, overridable for tests.
 * @param arch - `process.arch`, overridable for tests.
 */
export function pinnedOpenCode(
  platform: string = process.platform,
  arch: string = process.arch
): string | null {
  const key = `${platform}-${arch}`;
  const expected = OPENCODE_PIN.sha256[key];
  if (!expected) return null;
  const cached = verified.get(key);
  if (cached) return cached;
  const manifestPath = resolveOpenCodePlatformManifest(key);
  const { version } = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version: string };
  if (version !== OPENCODE_PIN.version) {
    throw new Error(`opencode-${key} is ${version}, pinned ${OPENCODE_PIN.version}`);
  }
  const binary = path.join(path.dirname(manifestPath), 'bin', 'opencode');
  if (sha256Of(binary) !== expected) {
    throw new Error(`${binary} does not match its pinned SHA-256; refusing to run it`);
  }
  verified.set(key, binary);
  return binary;
}
