import type {
  InstallationConfiguration,
  InspectOptions,
  RuntimeInstallationStatus,
} from './contracts.js';
import { createInstallationFilesystem } from './filesystem.js';

/** Files-only historical observation; constructing this facade performs no I/O. */
export function createRuntimeStatus(configuration: InstallationConfiguration): {
  inspectExisting(options?: InspectOptions): Promise<RuntimeInstallationStatus>;
} {
  const filesystem = createInstallationFilesystem(configuration);
  return Object.freeze({
    async inspectExisting(options?: InspectOptions): Promise<RuntimeInstallationStatus> {
      return (await filesystem.inspectExisting(options)).status;
    },
  });
}
