import {
  createRuntimeInstallation,
  resolveInstalledRuntimeConfiguration,
  type RuntimeInstallation,
} from '@dorkos/browser/runtime-installation';
import { resolveDorkHome } from '../dork-home.js';

/** Lazy actual packaged composition; neither resolution nor construction downloads or activates browsing. */
export async function resolveBrowserRuntimeInstallation(): Promise<RuntimeInstallation> {
  return createRuntimeInstallation(
    await resolveInstalledRuntimeConfiguration(import.meta.url, resolveDorkHome())
  );
}
