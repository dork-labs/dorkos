import {
  createRuntimeInstallation,
  resolveInstalledRuntimeConfiguration,
  type RuntimeInstallation,
  type InstallationConfiguration,
} from '@dorkos/browser/runtime-installation';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Production packaged-runtime producer. Dev/standalone or missing assets refuse; no fixture fallback.
 * Resolution checks actual Node/controller/verifier/library/source-vintage originals.
 * Constructing the installation owner does not install, verify, grant authority or activate browsing. */
export async function resolveServerBrowserRuntimePackage(): Promise<
  Readonly<{
    configuration: InstallationConfiguration;
    installation: RuntimeInstallation;
  }>
> {
  // The server is a separately bundled module; only the actual process entry names the packaged CLI.
  const entry = process.argv[1];
  if (!entry) throw new Error('The managed browser needs the packaged DorkOS command.');
  const configuration = await resolveInstalledRuntimeConfiguration(
    pathToFileURL(resolve(entry)),
    resolveDorkHome()
  );
  return Object.freeze({
    configuration,
    installation: createRuntimeInstallation(configuration),
  });
}

/** Resolve the actual package without acquiring installation or native mode authority. */
export async function resolveServerBrowserRuntimeInstallation(): Promise<RuntimeInstallation> {
  return (await resolveServerBrowserRuntimePackage()).installation;
}
