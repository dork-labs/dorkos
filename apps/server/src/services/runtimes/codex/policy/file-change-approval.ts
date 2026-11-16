/** The shared protected-file backstop for one native Codex patch approval. */
import fs from 'node:fs';
import path from 'node:path';
import { isSameOrInside } from '@dorkos/shared/directory-grants';
import type { ServerRequestTurnView, MappedServerRequest } from '../app-server/server-requests.js';
import { PATCH_TOOL_NAME } from '../event-mapper.js';
import {
  isProtectedPath,
  protectedPathSpellings,
  type ProtectedPathRoots,
} from '../../shared/policy/protected-path-check.js';

/**
 * Compare existing ancestor identities as well as spellings. A missing child can still
 * name an existing case alias; lowercasing would instead deny distinct POSIX directories.
 * Stat errors other than a missing child propagate to the whole-patch refusal.
 */
function isReadOnlyGit(target: string, directories: readonly string[]): boolean {
  if (directories.length === 0) return false;
  if (directories.some((dir) => isSameOrInside(target, dir))) return true;
  const identities = directories.map((dir) => fs.statSync(dir, { bigint: true }));
  let ancestor = target;
  for (;;) {
    try {
      const found = fs.statSync(ancestor, { bigint: true });
      if (identities.some((entry) => entry.dev === found.dev && entry.ino === found.ino))
        return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return false;
    ancestor = parent;
  }
}

/**
 * Whether every source and destination of a recorded native patch may be offered for approval.
 * Missing or unfamiliar changes refuse the whole patch, never a guessed subset.
 *
 * @param input - The fileChange item's recorded input, not request-supplied paths.
 * @param roots - The active turn's captured native protected-file policy roots.
 * @param readOnlyGit - The native profile's Git metadata restrictions, empty only at Full.
 */
export function fileChangeMayAsk(
  input: string | undefined,
  roots: ProtectedPathRoots | undefined,
  readOnlyGit: readonly string[] = []
): boolean {
  if (!input || !roots) return false;
  try {
    const { changes } = JSON.parse(input) as { changes?: unknown };
    if (!Array.isArray(changes) || changes.length === 0) return false;
    return changes.every((change: unknown) => {
      if (
        !change ||
        typeof change !== 'object' ||
        Array.isArray(change) ||
        Object.keys(change).some((key) => !['path', 'kind', 'diff'].includes(key))
      )
        return false;
      if (typeof (change as { diff?: unknown }).diff !== 'string') return false;
      const { path, kind } = change as {
        path?: unknown;
        kind?: { type?: unknown; move_path?: unknown };
      };
      if (
        typeof path !== 'string' ||
        path.trim() === '' ||
        !kind ||
        typeof kind !== 'object' ||
        Array.isArray(kind) ||
        Object.keys(kind).some((key) => !['type', 'move_path'].includes(key)) ||
        !['add', 'update', 'delete'].includes(String(kind.type))
      )
        return false;
      if (kind.type !== 'update' && 'move_path' in kind) return false;
      const paths = [path];
      if (kind.move_path !== undefined && kind.move_path !== null) {
        if (
          kind.type !== 'update' ||
          typeof kind.move_path !== 'string' ||
          kind.move_path.trim() === ''
        )
          return false;
        paths.push(kind.move_path);
      }
      return paths.every(
        (file) =>
          !isProtectedPath(file, 'write', roots) &&
          !isProtectedPath(file, 'read', roots) &&
          !protectedPathSpellings(file, roots.cwd).some((target) =>
            isReadOnlyGit(target, readOnlyGit)
          )
      );
    });
  } catch {
    return false;
  }
}

/**
 * Refuse an unsafe patch before it becomes an answerable card or remembered decision.
 * @param params - Request metadata, never authority for file roots or mode.
 * @param turn - The actual open turn's item inputs and native policy.
 */
export function fileChangeApproval(
  params: Record<string, unknown>,
  turn: ServerRequestTurnView
): MappedServerRequest {
  const itemId =
    typeof params.itemId === 'string' && params.itemId !== '' ? params.itemId : undefined;
  const input = itemId ? turn.inputOf(itemId) : undefined;
  if (!fileChangeMayAsk(input, turn.fileChangeRoots, turn.fileChangeReadOnlyGit)) {
    return { refuse: { decision: 'decline' }, why: 'protected or unattributable file change' };
  }
  return {
    kind: 'approval',
    interactionId:
      typeof params.approvalId === 'string' && params.approvalId ? params.approvalId : itemId!,
    toolName: PATCH_TOOL_NAME,
    card: {
      type: 'approval_required',
      data: {
        toolName: PATCH_TOOL_NAME,
        input,
        ...(typeof params.reason === 'string' && params.reason
          ? { decisionReason: params.reason }
          : {}),
        ...(typeof params.grantRoot === 'string' && params.grantRoot
          ? { blockedPath: params.grantRoot }
          : {}),
        hasSuggestions: true,
        alwaysAllowScope: 'session',
      },
    },
    replies: {
      approve: (alwaysAllow) => ({ decision: alwaysAllow ? 'acceptForSession' : 'accept' }),
      deny: { decision: 'decline' },
      expired: { decision: 'decline' },
      cancelled: { decision: 'cancel' },
    },
  };
}
