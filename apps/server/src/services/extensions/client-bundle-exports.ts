import vm from 'node:vm';
import { EXTENSION_BUNDLE_GLOBAL } from '@dorkos/extension-api';

/**
 * Evaluate a compiled client bundle and return what it exports.
 *
 * Client bundles are classic scripts that assign their exports to
 * {@link EXTENSION_BUNDLE_GLOBAL} (DOR-3293), so they cannot be `import()`ed.
 * The script runs inside a function so that name stays local and nothing is
 * left on this process's globals. Same trust as the `import()` it replaced:
 * only an approved bundle reaches here.
 *
 * @param code - The compiled bundle text.
 * @param filename - The name stack traces show for the bundle.
 * @returns The bundle's exports, or an empty object when it assigned none.
 */
export function clientBundleExports(code: string, filename: string): Record<string, unknown> {
  const run = vm.runInThisContext(
    `(function () {\n${code}\n;return typeof ${EXTENSION_BUNDLE_GLOBAL} === 'undefined' ? undefined : ${EXTENSION_BUNDLE_GLOBAL};\n})`,
    { filename }
  ) as () => unknown;
  const exports = run();
  return exports && typeof exports === 'object' ? (exports as Record<string, unknown>) : {};
}
