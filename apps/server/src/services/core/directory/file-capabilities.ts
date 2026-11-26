/**
 * The file browser's doors on `/api/files`, as one capability domain (DOR-4978):
 * reading a text file (`file-read-capabilities.ts`), the save
 * (`file-save-capability.ts`) and the changes to a folder
 * (`file-entry-capabilities.ts`). The media bytes, the two lists and the copy
 * stay hand routes in `routes/files.ts` and `routes/file-entries.ts`.
 *
 * @module services/core/directory/file-capabilities
 */
import type { CapabilityDomain } from '../capabilities/capability-definition.js';
import {
  filesCreateCapability,
  filesDeleteCapability,
  filesRenameCapability,
  filesRevealCapability,
} from './file-entry-capabilities.js';
import { filesReadTextCapability } from './file-read-capabilities.js';
import { filesSaveCapability } from './file-save-capability.js';

/** The file browser; on every server, since every chat has a folder. The save says so itself until boot hands it the writer. */
export const filesDomain: CapabilityDomain = {
  name: 'files',
  capabilities: [
    filesReadTextCapability,
    filesSaveCapability,
    filesCreateCapability,
    filesDeleteCapability,
    filesRenameCapability,
    filesRevealCapability,
  ],
};
