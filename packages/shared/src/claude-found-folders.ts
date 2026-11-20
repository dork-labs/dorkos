/**
 * Claude account folders found on this computer that are not registered yet
 * (spec `claude-account-ui` §7.4). Re-exported from `@dorkos/shared/account-usage`.
 *
 * @module shared/claude-found-folders
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/**
 * A Claude account folder found on this computer that is not registered,
 * dismissed, or the machine's default account, as
 * `GET /api/runtimes/claude-code/accounts/found` serves it (spec
 * `claude-account-ui` §7.4). Settings offers it with an Add button; nothing is
 * registered until a person clicks it.
 */
export const FoundClaudeFolderSchema = z
  .object({
    /** The folder, absolute. */
    path: z.string(),
    /** The folder's own name (the path's last part), such as `.claude2`. */
    name: z.string(),
    /**
     * When the account was last used: the newest change among its `projects/`
     * folder, that folder's children and the files directly inside each child,
     * ISO-8601. `null` when none could be read.
     */
    lastUsedAt: z.string().nullable(),
    /** Whether the folder holds a file Claude Code saves when an organization manages the account. */
    orgManaged: z.boolean(),
    /** The name of that file, or `null` when there is none. */
    orgMarker: z.string().nullable(),
  })
  .openapi('FoundClaudeFolder');

/** Inferred type for {@link FoundClaudeFolderSchema}. */
export type FoundClaudeFolder = z.infer<typeof FoundClaudeFolderSchema>;

/**
 * The body of `POST /api/runtimes/claude-code/accounts/found/dismiss`: the
 * found folder to stop offering (spec `claude-account-ui` §7.4).
 */
export const DismissFoundFolderRequestSchema = z
  .object({
    /** The folder, as the found list gave it. */
    path: z.string().min(1),
  })
  .openapi('DismissFoundFolderRequest');

/** Inferred type for {@link DismissFoundFolderRequestSchema}. */
export type DismissFoundFolderRequest = z.infer<typeof DismissFoundFolderRequestSchema>;
