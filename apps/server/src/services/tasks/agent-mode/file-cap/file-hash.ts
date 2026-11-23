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

/** A line that opens a fenced code block (an info string may follow), and its fence. */
const FENCE = /^[ \t]*(`{3,}|~{3,})/;

/** A line that can close one: the fence alone, with nothing after it but spacing. */
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

/**
 * A body with only the spacing a formatter changes taken out (DOR-5060,
 * Security's ruling of Nov 22): CRLF read as LF, trailing ASCII spaces and
 * tabs dropped from every line, and, outside fenced code blocks, runs of blank
 * lines read as one. Nothing else: indentation still counts (it can move a
 * list item or a key), any other character counts, a Unicode space or a
 * zero-width one included, and a fenced block keeps its blank lines.
 *
 * @param body - The body the task reads.
 */
export function normalizedBody(body: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of body.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/[ \t]+$/, '');
    if (fence) {
      out.push(line);
      const close = FENCE_CLOSE.exec(line)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
      continue;
    }
    const marker = FENCE.exec(line)?.[1];
    if (marker) fence = marker;
    if (line === '' && out.at(-1) === '') continue;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * {@link bodyHash} of {@link normalizedBody}: what a cap compares, beside the
 * exact hash kept for the audit.
 *
 * @param body - The body the task reads.
 */
export function normalizedBodyHash(body: string): string {
  return bodyHash(normalizedBody(body));
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
