/**
 * `files.read_text`: `GET /api/files/content`, a text file and its hash, as a
 * capability the mount serves (DOR-4978, ADR 261123-170830).
 *
 * It reads only what the boundary already lets every caller reach, so it sits on
 * the `observe` tier with no permission area, as the folder picker and the diff
 * review's reads do; an agent reaches it through `dorkos call`, as it reached
 * the hand route. A file's text can come from anywhere, so it is classed
 * `outside` (`dorkos-tool-reads.ts`). The media bytes (`GET /api/files/raw`) and
 * the two lists (`GET /api/files`, `GET /api/files/tree`, until they page) stay
 * hand routes in `routes/files.ts`.
 *
 * @module services/core/directory/file-read-capabilities
 */
import fs from 'node:fs/promises';
import { FileContentQuerySchema, FileContentResponseSchema } from '@dorkos/shared/schemas';

import { FILE_LIMITS } from '../../../config/constants.js';
import { resolveWithinCwd, sha256 } from '../../../lib/file-route-guards.js';
import { logger } from '../../../lib/logger.js';
import { CapabilityToolError, defineCapability } from '../capabilities/capability-definition.js';
import { errnoOf, FILE_SENTENCES as S, fileRefusal, pathCheckRefusal } from './file-refusals.js';
import { PATH_REFUSAL_CODES } from './path-refusal.js';

/** Why the read has no permission area. */
const AREA_NOTE = 'reading a file inside the folders DorkOS may use, as the file browser does';

/** `files.read_text`: a text file's words and their hash, the baseline for a save. */
export const filesReadTextCapability = defineCapability({
  id: 'files.read_text',
  title: 'Read a text file',
  description:
    'A UTF-8 text file under `cwd` and the SHA-256 of its text (`hash`), which a later save ' +
    'sends back to detect a change underneath. Large files and files that are not text are ' +
    'refused.',
  tier: 'observe',
  area: null,
  areaNote: AREA_NOTE,
  input: FileContentQuerySchema,
  output: FileContentResponseSchema,
  surfaces: { http: { method: 'get', path: '/api/files/content' } },
  httpErrors: {
    400: {
      description:
        '`invalid_request` (a path with a NUL byte or one that cannot be followed) or ' +
        '`not_a_file` (the path is a folder)',
    },
    403: { description: '`outside_boundary`: the path leaves the working directory' },
    404: { description: '`not_found`: no file at that path' },
    413: { description: '`too_large`: the file is too large to open as text' },
    415: { description: '`binary_file`: the file is not text' },
  },
  invoke: async (_deps, { cwd, path: relPath }) => {
    let resolved: string;
    try {
      ({ resolved } = await resolveWithinCwd(cwd, relPath));
    } catch (err) {
      throw pathCheckRefusal(err, 'read', { cwd, path: relPath });
    }
    let buffer: Buffer;
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) throw fileRefusal('FILE_PATH_IS_FOLDER', S.folderNotFile);
      if (stat.size > FILE_LIMITS.MAX_TEXT_FILE_BYTES) {
        throw fileRefusal('FILE_TOO_LARGE_FOR_TEXT', S.tooLargeForText);
      }
      buffer = await fs.readFile(resolved);
    } catch (err) {
      if (err instanceof CapabilityToolError) throw err;
      const code = errnoOf(err);
      if (code === 'ENOENT') throw fileRefusal('FILE_MISSING', S.fileMissing);
      if (code === 'ELOOP' || code === 'ENOTDIR') {
        throw new CapabilityToolError({
          error: 'That path can’t be followed.',
          code: PATH_REFUSAL_CODES.unfollowable,
        });
      }
      logger.error('[files] read failed', { err, resolved });
      throw fileRefusal('FILE_ACTION_FAILED', S.readFailed);
    }
    // A NUL byte is the standard binary-file heuristic (git uses the same test).
    if (buffer.includes(0)) throw fileRefusal('FILE_NOT_TEXT', S.notText);
    const content = buffer.toString('utf8');
    return { content, hash: sha256(content), encoding: 'utf-8' as const };
  },
});
