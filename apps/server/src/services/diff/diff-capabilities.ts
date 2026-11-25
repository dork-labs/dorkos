/**
 * The diff review's JSON routes as capabilities (DOR-212, ADR 261123-170830):
 * a file's text diff base, the files a chat has unreviewed edits in, marking a
 * file reviewed, and restoring a file's earlier bytes. The capability mount
 * serves them on `/api/diff/*`; agents reach them through `dorkos call`.
 *
 * Every one names a chat, and a caller that may not read that chat is told it
 * does not exist (`session_not_found`), the same answer as the session routes
 * (spec `audit-trail` §3.4): a person's own chat's edits are theirs. Every path
 * is confined to `cwd` by {@link resolveWithinCwd}, the guard the file routes
 * use. The baseline's raw image bytes stay a hand route (`routes/diff.ts`).
 *
 * @module services/diff/diff-capabilities
 */
import path from 'node:path';
import { z } from 'zod';
import {
  AdvanceDiffBaselineRequestSchema,
  DiffBaselineQuerySchema,
  DiffBaselineResponseSchema,
  DiffPendingQuerySchema,
  type DiffPendingResponse,
  RevertDiffBaselineRequestSchema,
} from '@dorkos/shared/schemas';

import { validateBoundary } from '../../lib/boundary.js';
import { resolveWithinCwd } from '../../lib/file-route-guards.js';
import { logger } from '../../lib/logger.js';
import { readerFor } from '../audit/audit-capabilities.js';
import { auditTrail } from '../audit/audit-trail.js';
import { readableSessionIds } from '../audit/session-visibility.js';
import {
  CapabilityToolError,
  defineCapability,
  type CapabilityDomain,
  type CapabilityHandlerContext,
} from '../core/capabilities/index.js';
import { boundaryToolError, pathToolError } from '../core/directory/path-refusal.js';
import { editBaselineStore, resolveTextBaseline, revertToBaseline } from './index.js';

/** What a write answers when it is done. */
const DiffOkSchema = z.object({ ok: z.literal(true) });

/**
 * Refuse a caller that may not read the chat, in the words an unknown chat
 * gets, so a private one's existence is not confirmed.
 *
 * @param context - Who is calling.
 * @param sessionId - The chat named.
 */
function assertCanReadSession(context: CapabilityHandlerContext, sessionId: string): void {
  const reader = readerFor({ accounts: auditTrail()?.accounts }, context);
  if (readableSessionIds(reader, [sessionId]).has(sessionId)) return;
  throw new CapabilityToolError({ error: 'No chat with that id.', code: 'DIFF_SESSION_NOT_FOUND' });
}

/**
 * Resolve `relPath` inside `cwd`, refusing a path outside it as the file routes do.
 *
 * @param cwd - The chat's folder.
 * @param relPath - The file, relative to `cwd` or absolute.
 * @param what - The step, for the log.
 */
async function confined(cwd: string, relPath: string, what: string) {
  try {
    return await resolveWithinCwd(cwd, relPath);
  } catch (err) {
    const refusal = pathToolError(err);
    if (refusal) throw refusal;
    logger.error(`[diff] ${what} boundary failed`, { err, cwd, path: relPath });
    throw err;
  }
}

/** `diff.baseline`: a file's text diff base beside its current text. */
export const diffBaselineCapability = defineCapability({
  id: 'diff.baseline',
  title: 'Read a file’s diff base',
  description:
    'The text a file is diffed against in a chat, beside its current text, each with a hash. ' +
    'By default the base is the file before the chat’s first edit, else its git HEAD, else ' +
    'empty; mode `head` compares with git HEAD. Pass the chat’s `cwd`, the file’s `path` and ' +
    'the chat’s `sessionId`. Large and binary files have no text diff.',
  tier: 'observe',
  area: null,
  areaNote: 'reading a file in a chat the caller may read',
  input: DiffBaselineQuerySchema,
  output: DiffBaselineResponseSchema,
  surfaces: { http: { method: 'get', path: '/api/diff/baseline' } },
  invoke: async (_deps, input, context) => {
    assertCanReadSession(context, input.sessionId);
    const { validatedCwd, resolved } = await confined(input.cwd, input.path, 'baseline');
    const result = await resolveTextBaseline(validatedCwd, resolved, input.sessionId, input.mode);
    if (result.ok) return result.response;
    if (result.error === 'TOO_LARGE') {
      throw new CapabilityToolError({
        error: 'This file is too large to diff here.',
        code: 'DIFF_FILE_TOO_LARGE',
      });
    }
    if (result.error === 'NOT_A_FILE') {
      throw new CapabilityToolError({
        error: 'This path is a folder, not a file.',
        code: 'DIFF_NOT_A_FILE',
      });
    }
    throw new CapabilityToolError({
      error: 'This file isn’t text, so it has no text diff.',
      code: 'DIFF_BINARY_FILE',
    });
  },
});

/** `diff.advance_baseline`: mark a file reviewed, so later edits diff from now. */
export const diffAdvanceBaselineCapability = defineCapability({
  id: 'diff.advance_baseline',
  title: 'Mark a file’s changes reviewed',
  description:
    'Move a file’s diff base to what is on disk now, so the chat’s later edits diff from ' +
    'the reviewed state. Changes no file. Does nothing when the chat has no base for it.',
  // A review mark that changes no file and no power, so it is allowed from
  // Wi-Fi like a read cursor (`wifi-level-census.test.ts`).
  tier: 'observe',
  area: null,
  areaNote: 'a review mark that changes no file',
  input: AdvanceDiffBaselineRequestSchema,
  output: DiffOkSchema,
  surfaces: { http: { method: 'post', path: '/api/diff/baseline/advance' } },
  invoke: async (_deps, input, context) => {
    assertCanReadSession(context, input.sessionId);
    const { resolved } = await confined(input.cwd, input.path, 'advance');
    await editBaselineStore.advance(input.sessionId, resolved);
    return { ok: true as const };
  },
});

/** `diff.pending`: the files a chat has unreviewed edits in. */
export const diffPendingCapability = defineCapability({
  id: 'diff.pending',
  title: 'List files with unreviewed changes',
  description:
    'The files, relative to `cwd`, that a chat changed and nobody has reviewed yet (their ' +
    'diff base still differs from disk). Pass the chat’s `cwd` and `sessionId`.',
  tier: 'observe',
  area: null,
  areaNote: 'reading file names in a chat the caller may read',
  input: DiffPendingQuerySchema,
  // Documented as unknown until the list pages by cursor (the API lint's list rule).
  output: z.unknown(),
  surfaces: { http: { method: 'get', path: '/api/diff/pending' } },
  invoke: async (_deps, input, context) => {
    assertCanReadSession(context, input.sessionId);
    let validatedCwd: string;
    try {
      validatedCwd = await validateBoundary(input.cwd);
    } catch (err) {
      const refusal = boundaryToolError(err);
      if (refusal) throw refusal;
      logger.error('[diff] pending boundary failed', { err, cwd: input.cwd });
      throw err;
    }
    // Baselines are captured with confined absolute paths; anything outside
    // `cwd` is dropped all the same.
    const files = (await editBaselineStore.listPending(input.sessionId))
      .map((abs) => path.relative(validatedCwd, abs))
      .filter((rel) => rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel))
      .map((rel) => rel.split(path.sep).join('/'));
    return { files } satisfies DiffPendingResponse;
  },
});

/** `diff.revert`: put a file's earlier bytes back, whole. */
export const diffRevertCapability = defineCapability({
  id: 'diff.revert',
  title: 'Restore a file’s earlier version',
  description:
    'Write a file’s earlier version back to disk, whole: its bytes before the chat’s first ' +
    'edit, else its git HEAD. Only the server’s own copy is written, never bytes you send. ' +
    'A file the chat created has no earlier version, and is never deleted.',
  tier: 'act',
  // Whole-file restore writes only the file's own earlier bytes, from the
  // server's snapshot or git HEAD: no caller-supplied content, so nothing to
  // switch beyond the act tier.
  area: null,
  areaNote: 'restores a file’s own earlier bytes, never new content',
  input: RevertDiffBaselineRequestSchema,
  output: DiffOkSchema,
  surfaces: { http: { method: 'post', path: '/api/diff/revert' } },
  invoke: async (_deps, input, context) => {
    assertCanReadSession(context, input.sessionId);
    const { validatedCwd, resolved } = await confined(input.cwd, input.path, 'revert');
    let outcome: Awaited<ReturnType<typeof revertToBaseline>>;
    try {
      outcome = await revertToBaseline(validatedCwd, resolved, input.sessionId);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EACCES') {
        throw new CapabilityToolError({
          error: 'DorkOS isn’t allowed to write this file.',
          code: 'DIFF_WRITE_NOT_ALLOWED',
        });
      }
      logger.error('[diff] revert failed', { err, resolved });
      throw err;
    }
    if (outcome === 'no-baseline') {
      throw new CapabilityToolError({
        error: 'This file has no earlier version to restore.',
        code: 'DIFF_NO_EARLIER_VERSION',
      });
    }
    return { ok: true as const };
  },
});

/** The diff review; on every server, since every chat can be reviewed. */
export const diffDomain: CapabilityDomain = {
  name: 'diff',
  capabilities: [
    diffBaselineCapability,
    diffAdvanceBaselineCapability,
    diffPendingCapability,
    diffRevertCapability,
  ],
};
