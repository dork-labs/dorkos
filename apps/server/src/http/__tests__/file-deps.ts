/**
 * The file browser's deps for a route test (`services/core/directory/file-deps.ts`),
 * wired as boot wires them: a person's save through a writer.
 *
 * @module http/__tests__/file-deps
 */
import type { CapabilityDeps } from '../../services/core/capabilities/index.js';
import { savePersonFile } from '../../services/canvas/doc-channel/writes/person-file-save.js';
import { InstallationFileWrites } from '../../services/canvas/doc-channel/writes/installation-file-writes.js';

/**
 * The deps, over `writes` (a writer with no document channel by default: ordinary saves only).
 *
 * @param writes - The installation's file writer.
 */
export function testFileDeps(
  writes: InstallationFileWrites = new InstallationFileWrites()
): Pick<CapabilityDeps, 'fileDeps'> {
  return {
    fileDeps: { save: (input, owner) => savePersonFile(writes, input, owner) },
  };
}
