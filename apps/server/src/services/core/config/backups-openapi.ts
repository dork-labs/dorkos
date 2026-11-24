/**
 * OpenAPI entries for Settings → Backups (DOR-4253): list this computer's
 * database copies, and remove or move an older one.
 *
 * @module services/core/config/backups-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { problemResponse as error } from '../openapi/problem-openapi.js';

/** The bar every route here carries, said once. */
const PERSON_BAR =
  'Person-only: a caller naming itself an agent, an approval token, a program credential, ' +
  'another site, or a request from another computer (except the owner over an encrypted ' +
  'connection) is refused before anything is read. There is no MCP tool for this.';

const BackupCopySchema = z
  .object({
    name: z.string().describe('The file name inside the backup folder; the id every action takes.'),
    kind: z.enum(['daily', 'pre-upgrade']).describe('What the copy was taken for.'),
    managed: z.boolean().describe('True for `dork-auto-` copies, which DorkOS prunes on its own.'),
    sizeBytes: z.number().int().nonnegative(),
    createdAt: z.string().describe('When the copy was taken, from its name (ISO 8601, UTC).'),
    busy: z.boolean().describe('A write is in progress next to it, so it cannot be acted on now.'),
  })
  .openapi('BackupCopy');

const BackupListSchema = z
  .object({
    folder: z.string().describe('The backup folder, `<data dir>/backups`.'),
    copies: z.array(BackupCopySchema).describe('Newest first.'),
    totalBytes: z.number().int().nonnegative(),
  })
  .openapi('BackupList');

const name = z.object({ name: z.string().describe('A listed copy’s file name.') });

/**
 * Register the Backups routes.
 *
 * @param registry - The OpenAPI registry.
 */
export function registerConfigBackupsOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/config/backups',
    tags: ['Config'],
    summary: 'List the database backup copies on this computer',
    description:
      'Every copy a DorkOS writer made in `<data dir>/backups`: daily and before-update copies, ' +
      'both the `dork-auto-` ones DorkOS prunes and older `dork-` ones it never touches. Only ' +
      'regular files with a writer’s name are listed; symbolic links never are. ' +
      PERSON_BAR,
    responses: {
      200: {
        description: 'The copies and their total size',
        content: { 'application/json': { schema: BackupListSchema } },
      },
      401: error('Login is enabled and the caller is not signed in'),
      403: error(
        'Refused: only a person can see this (`person_only`), or only at this computer (`operator_only`)'
      ),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/config/backups/{name}',
    tags: ['Config'],
    summary: 'Remove an older backup copy',
    description:
      'Deletes one older `dork-` copy. The file is re-checked right before it is deleted: a ' +
      'regular file in the real backup folder, unchanged, with no write in progress. ' +
      PERSON_BAR,
    request: { params: name },
    responses: {
      200: {
        description: 'Removed',
        content: { 'application/json': { schema: z.object({ success: z.literal(true) }) } },
      },
      401: error('Login is enabled and the caller is not signed in'),
      403: error(
        'Refused: only a person can remove a backup (`person_only`), or only at this computer ' +
          '(`operator_only`)'
      ),
      404: error('No such older copy (`not_found`)'),
      409: error('`conflict`: DorkOS manages it, a write is in progress, or it changed'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/config/backups/{name}/move',
    tags: ['Config'],
    summary: 'Move an older backup copy to another folder',
    description:
      'Copies one older `dork-` copy into an existing folder inside the directory boundary or ' +
      'on an external drive (`/Volumes/<drive>/…`), never the data folder. The destination is ' +
      'resolved once to its real path, so a link is followed and every check reads the folder ' +
      'written to. Nothing there is overwritten. The copy must match in size and pass SQLite’s ' +
      '`integrity_check`; only then is the original removed, and only if unchanged. A failed ' +
      'check deletes the new file and keeps the original. ' +
      PERSON_BAR,
    request: {
      params: name,
      body: {
        content: {
          'application/json': {
            schema: z
              .object({ destination: z.string().describe('An existing absolute folder.') })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Moved',
        content: {
          'application/json': { schema: z.object({ destinationPath: z.string() }) },
        },
      },
      400: error(
        '`invalid_request`: the destination does not exist, is neither inside the directory ' +
          'boundary nor on an external drive, is the data folder or inside it, or is the ' +
          'backup folder'
      ),
      401: error('Login is enabled and the caller is not signed in'),
      403: error(
        'Refused: only a person can move a backup (`person_only`), or only at this computer ' +
          '(`operator_only`); or DorkOS cannot write to the destination ' +
          '(`forbidden`). The original stays.'
      ),
      404: error('No such older copy (`not_found`)'),
      409: error(
        '`conflict`: DorkOS manages it, it is busy or changed, a file of that name is already ' +
          'there, the copy could not be written, or it failed its check. The original stays.'
      ),
      507: error('The destination’s disk is full (`internal_error`). The original stays.'),
    },
  });
}
