/**
 * The SKILL file of a scheduled task, as M4 compares it (DOR-3703): the body
 * the task reads when it runs, hashed. Content, never file times: a save that
 * writes the same bytes changes nothing.
 *
 * @module services/tasks/agent-mode/file-cap/file-hash
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseSkillFile } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { readScheduleFromSkill } from '../../skills-root-discovery.js';

/** The longest body kept beside its hash, for the diff a cap lift shows. */
export const KEPT_BODY_CHARS = 16_000;

/** A SKILL file's body as the task reads it, and its hash. */
export interface FileState {
  /** The body the task sends when it runs. */
  body: string;
  /** {@link bodyHash} of it. */
  hash: string;
}

/**
 * The hash a body is attested by: `sha256:<base64url>`, the form the audit
 * log shows (it hides long hex runs as possible tokens).
 *
 * @param body - The body the task reads.
 */
export function bodyHash(body: string): string {
  return `sha256:${createHash('sha256').update(body).digest('base64url')}`;
}

/**
 * The first eight characters of a hash, as a notice names it.
 *
 * @param hash - From {@link bodyHash}, or `null` for a file that could not be read.
 */
export function shortFileHash(hash: string | null): string {
  return hash ? hash.slice('sha256:'.length, 'sha256:'.length + 8) : 'unreadable';
}

/**
 * Read a task's SKILL file the way the sync does and answer its body and
 * hash, or `null` when it is missing, does not parse, or holds no schedule.
 *
 * @param filePath - The task's SKILL.md.
 */
export async function readFileState(
  filePath: string | null | undefined
): Promise<FileState | null> {
  if (!filePath) return null;
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseSkillFile(filePath, content, SkillFrontmatterSchema, {
    requireNameMatch: false,
  });
  if (!parsed.ok) return null;
  const discovered = readScheduleFromSkill(parsed.definition, {
    scope: 'project',
    projectPath: path.dirname(filePath),
    resolvedPath: filePath,
  });
  if (!discovered) return null;
  const body = discovered.def.body;
  return { body, hash: bodyHash(body) };
}
