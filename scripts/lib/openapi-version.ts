/**
 * The product version the committed OpenAPI document carries.
 *
 * `scripts/export-openapi.ts` runs the server from source, where the server's
 * own version is the `0.0.0` dev sentinel, so it passes the repo's `VERSION`
 * file instead. A missing or malformed `VERSION` is an error, never a quiet
 * fall back to `0.0.0`: the document would then claim a version nobody
 * shipped. A release bumps `VERSION` and regenerates the document in the same
 * PR (`.claude/commands/system/release.md`, Phase 6).
 *
 * @module scripts/lib/openapi-version
 */
import { readFileSync } from 'node:fs';

/** A plain semver version, with an optional pre-release and build part. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Read and check the product version from a `VERSION` file.
 *
 * @param versionPath - Path to the `VERSION` file.
 * @returns The trimmed version.
 * @throws If the file is missing, or its contents are not a semver version.
 */
export function readProductVersion(versionPath: string): string {
  let text: string;
  try {
    text = readFileSync(versionPath, 'utf8');
  } catch (cause) {
    throw new Error(
      `Cannot read ${versionPath}. The API document takes its version from it; run this from the repo root.`,
      { cause }
    );
  }
  const version = text.trim();
  if (!SEMVER.test(version)) {
    throw new Error(`${versionPath} holds "${version}", which is not a version like 1.2.3.`);
  }
  return version;
}
