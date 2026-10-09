import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const originalModuleURL = import.meta.url;
/** Fixed publisher build entry locations only. No env, argv, cwd, data file or
 * caller-selected directory is a package-location authority. Bundling preserves
 * this single module graph; the seven signed assets live in browser/vm. */
export function originalInstalledVMDirectory() {
  const path = fileURLToPath(originalModuleURL),
    home = dirname(path);
  if (path.endsWith('/app.asar/dist/server/server-entry.mjs'))
    return (
      path.slice(0, -'/app.asar/dist/server/server-entry.mjs'.length) +
      '/app.asar.unpacked/dist/browser/vm'
    );
  if (path.endsWith('/server/index.js') || path.endsWith('/server/server-entry.mjs'))
    return join(home, '../browser/vm');
  if (path.endsWith('/services/browser/runtime/installed-location.mjs'))
    return join(home, '../../../browser/vm');
  throw new Error('INSTALLED_VM_PACKAGE_LOCATION');
}
