/**
 * Reading, seeding and diffing an agent's `HEARTBEAT.md` (spec `heartbeats` §2).
 *
 * The file is skill-shaped: frontmatter read with `@dorkos/skills`' parser and
 * validated by `HeartbeatFrontmatterSchema`, and a free markdown body. It is
 * read by beats only; nothing here is ever injected into an ordinary turn.
 *
 * @module services/heartbeats/heartbeat-file
 */
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from '@dorkos/skills/frontmatter';
import { CONVENTION_DIR, CONVENTION_FILES } from '@dorkos/shared/convention-files';
import {
  readConventionFile,
  writeConventionFileIfAbsent,
} from '@dorkos/shared/convention-files-io';
import {
  HeartbeatFrontmatterSchema,
  type HeartbeatFrontmatter,
  type HeartbeatTemplateId,
} from '@dorkos/shared/heartbeat-schemas';
import type { AuditChange } from '@dorkos/shared/audit-schemas';
import { renderHeartbeatTemplate } from '@dorkos/operating-skills';
import { recordAudit } from '../audit/audit-trail.js';
import { heartbeatFileChanged } from './event-wakes.js';

/** What one read of `HEARTBEAT.md` found. */
export type HeartbeatFileRead =
  | { kind: 'absent' }
  | {
      kind: 'valid';
      frontmatter: HeartbeatFrontmatter;
      body: string;
      hash: string;
      mtimeMs: number;
    }
  | { kind: 'invalid'; error: string; body: string; hash: string; mtimeMs: number };

/**
 * A stable hash of a frontmatter value, so the runner can tell whether the
 * last valid one changed without storing the file.
 *
 * @param value - The frontmatter (or any JSON value).
 */
export function hashFrontmatter(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/**
 * Parse `HEARTBEAT.md` text. Never throws: a broken header is `invalid` with a
 * plain reason.
 *
 * @param text - The whole file.
 */
export function parseHeartbeatText(
  text: string
):
  | { ok: true; frontmatter: HeartbeatFrontmatter; body: string }
  | { ok: false; error: string; body: string } {
  let data: Record<string, unknown>;
  let body: string;
  try {
    const parsed = parseFrontmatter(text);
    data = parsed.data;
    body = parsed.content.trim();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), body: text };
  }
  const result = HeartbeatFrontmatterSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    return { ok: false, error: `${where}${issue?.message ?? 'invalid frontmatter'}`, body };
  }
  return { ok: true, frontmatter: result.data, body };
}

/**
 * Read an agent's `HEARTBEAT.md`, with its mtime so the runner applies edits at
 * the next beat (OpenClaw #51542).
 *
 * @param agentPath - The agent's home directory.
 */
export async function readHeartbeatFile(agentPath: string): Promise<HeartbeatFileRead> {
  const text = await readConventionFile(agentPath, CONVENTION_FILES.heartbeat);
  if (text === null) return { kind: 'absent' };
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(path.join(agentPath, CONVENTION_DIR, CONVENTION_FILES.heartbeat)))
      .mtimeMs;
  } catch {
    // Removed between the read and the stat: the text we hold still stands.
  }
  const parsed = parseHeartbeatText(text);
  if (!parsed.ok) {
    return {
      kind: 'invalid',
      error: parsed.error,
      body: parsed.body,
      hash: hashFrontmatter(text),
      mtimeMs,
    };
  }
  return {
    kind: 'valid',
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    hash: hashFrontmatter(parsed.frontmatter),
    mtimeMs,
  };
}

/** What decides an agent's starting `HEARTBEAT.md`. */
export interface HeartbeatSeedChoice {
  /** The template its type names, when one was given. */
  template?: HeartbeatTemplateId;
  /** Its runtime, for the fallback. */
  runtime?: string;
}

/**
 * Which template a new agent starts with (spec §2): the one its type names,
 * else `lead` for a Doe agent, else none — a timed beat on a person's own plan
 * spends that plan, so other runtimes wake on events with no file.
 *
 * @param choice - The template named and the runtime.
 */
export function chooseHeartbeatTemplate(choice: HeartbeatSeedChoice): HeartbeatTemplateId | null {
  if (choice.template) return choice.template;
  return choice.runtime === 'doe' ? 'lead' : null;
}

/**
 * Write a new agent's `HEARTBEAT.md` from its template, only where none exists.
 *
 * @param agentPath - The agent's home directory.
 * @param choice - The template named and the runtime.
 * @returns The template written, or null when nothing was written.
 */
export async function seedHeartbeatFile(
  agentPath: string,
  choice: HeartbeatSeedChoice
): Promise<HeartbeatTemplateId | null> {
  const template = chooseHeartbeatTemplate(choice);
  if (!template) return null;
  const wrote = await writeConventionFileIfAbsent(
    agentPath,
    CONVENTION_FILES.heartbeat,
    renderHeartbeatTemplate(template)
  );
  return wrote ? template : null;
}

/**
 * The field diff between two frontmatters, for `heartbeat.config_changed`.
 * Only fields that differ appear; the body's history is the file's.
 *
 * @param before - The frontmatter before the edit, or null when there was none.
 * @param after - The frontmatter after it, or null when it is gone or invalid.
 */
export function diffHeartbeatFrontmatter(
  before: HeartbeatFrontmatter | null,
  after: HeartbeatFrontmatter | null
): AuditChange[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changes: AuditChange[] = [];
  for (const key of [...keys].sort()) {
    const was = (before as Record<string, unknown> | null)?.[key] ?? null;
    const now = (after as Record<string, unknown> | null)?.[key] ?? null;
    if (JSON.stringify(was) !== JSON.stringify(now)) {
      changes.push({ field: key, before: was, after: now });
    }
  }
  return changes;
}

/**
 * Record an edit of `HEARTBEAT.md` through DorkOS (`heartbeat.config_changed`),
 * as the person or agent of the current audit scope: act, then tell (spec §2).
 * The change list is the frontmatter's field diff; the body is the file's own
 * history and never copied here. Nothing is recorded when the text is unchanged.
 *
 * @param agent - The agent whose file changed.
 * @param agent.id - Its mesh id.
 * @param agent.name - Its name, for the row.
 * @param beforeText - The file before the edit, or null when there was none.
 * @param afterText - The file as written.
 */
export function recordHeartbeatConfigChange(
  agent: { id: string; name: string },
  beforeText: string | null,
  afterText: string
): void {
  if (beforeText === afterText) return;
  const before = beforeText === null ? null : parseHeartbeatText(beforeText);
  const after = parseHeartbeatText(afterText);
  const change = diffHeartbeatFrontmatter(
    before?.ok ? before.frontmatter : null,
    after.ok ? after.frontmatter : null
  );
  recordAudit({
    action: 'heartbeat.config_changed',
    operation: beforeText === null ? 'create' : 'modify',
    target: { type: 'agent', id: agent.id, name: agent.name },
    outcome: 'ok',
    ...(change.length > 0 ? { change } : {}),
    summary: after.ok
      ? 'Changed its HEARTBEAT.md.'
      : 'Changed its HEARTBEAT.md; the header is not valid, so the last good one stays in force.',
    visibility: 'space',
  });
  heartbeatFileChanged(agent.id);
}
