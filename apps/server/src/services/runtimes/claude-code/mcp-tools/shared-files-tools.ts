/**
 * The two DorkOS tools a teammate's turn lists and searches the space's shared folder with
 * (DOR-2956): the runtime's own `Glob`, `Grep` and `LS` stay refused, because they would walk
 * wherever a link leads. These walk the folder on the server, checking every file's realpath
 * against the folder and leaving out what is never shared (`core/turn-power/shared-folder.ts`).
 *
 * They answer only inside a teammate's turn in a space that shares a folder; anywhere else they
 * say so and read nothing. Reading one file is the runtime's own `Read`, which the teammate tier
 * allows for a shared file by its resolved path.
 *
 * @module services/runtimes/claude-code/mcp-tools/shared-files-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { listSharedFiles, searchSharedFiles } from '../../../core/turn-power/shared-folder.js';
import type { McpToolSession } from './types.js';
import { jsonContent } from './types.js';

/** The answer when there is nothing to read. */
const NO_SHARED_FOLDER = {
  error: 'There is no shared folder for this turn. Only a teammate’s turn in a space reads one.',
  code: 'NO_SHARED_FOLDER',
};

/**
 * The shared-folder tools, bound to the session they run in.
 *
 * @param session - The session, read at call time for its teammate tier.
 */
export function getSharedFilesTools(session: Pick<McpToolSession, 'teammateTier'> | undefined) {
  const folder = () => session?.teammateTier?.sharedFolder ?? null;
  return [
    tool(
      'shared_files_list',
      'List the files of the shared folder a teammate in this space may read, with their sizes. Optionally only those under a path inside it. Open one with Read by its full path.',
      { path: z.string().optional().describe('A folder inside the shared folder, e.g. docs') },
      async ({ path }) => {
        const root = folder();
        if (!root) return jsonContent(NO_SHARED_FOLDER, true);
        return jsonContent({ folder: root, ...(await listSharedFiles(root, path)) });
      }
    ),
    tool(
      'shared_files_search',
      'Search the readable files of the shared folder for a piece of text, ignoring case. Returns each matching line with its file and line number.',
      {
        query: z.string().min(1).max(200).describe('The text to look for'),
        path: z
          .string()
          .optional()
          .describe('Only files under this folder inside the shared folder'),
      },
      async ({ query, path }) => {
        const root = folder();
        if (!root) return jsonContent(NO_SHARED_FOLDER, true);
        return jsonContent({ folder: root, ...(await searchSharedFiles(root, query, path)) });
      }
    ),
  ];
}
