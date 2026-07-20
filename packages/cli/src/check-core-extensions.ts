import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the bundled core-extension source tree, mirroring how the
 * bundled server resolves `CORE_SOURCE_DIR`
 * (`apps/server/src/services/core-extensions/ensure-core-extensions.ts`):
 * `path.resolve(__dirname, '../../core-extensions')`.
 *
 * Both the compiled CLI entry (`dist/bin/cli.js`) and the bundled server
 * (`dist/server/index.js`) sit two directories below the package root, so the
 * same `../../core-extensions` traversal lands both at the same location — a
 * `core-extensions/` directory sitting alongside `dist/`, not inside it (see
 * `packages/cli/scripts/build.ts` and DOR-245).
 */
const CORE_EXTENSIONS_DIR = path.resolve(__dirname, '../../core-extensions');

/**
 * Verify the bundled core extensions (hello-world, linear-issues,
 * marketplace) shipped alongside this install.
 *
 * A missing or empty `core-extensions/` directory means the published
 * package was built or packed incorrectly (DOR-245) — every core extension,
 * including the `defaultEnabled: true` Marketplace nav entry, would
 * silently never install for this user. Unlike {@link checkClaude} this is
 * a packaging invariant, not an optional runtime dependency, so callers
 * should treat a `false` result as fatal.
 *
 * @returns true if at least one core extension directory is present.
 */
export function checkCoreExtensions(): boolean {
  try {
    return readdirSync(CORE_EXTENSIONS_DIR, { withFileTypes: true }).some((entry) =>
      entry.isDirectory()
    );
  } catch {
    return false;
  }
}
