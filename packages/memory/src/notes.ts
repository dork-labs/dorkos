/**
 * Notes files: the second level of an agent's memory, read on demand.
 *
 * `MEMORY.md` is capped because every turn carries it. A notes file is never
 * injected; the agent lists its notes and opens the one it needs. Each file is
 * plain markdown with a small frontmatter block — its name, a one-line
 * description, and on a migrated note where it came from — so a person can
 * open the folder and read it without DorkOS.
 *
 * @module memory/notes
 */
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MEMORY_NOTE_MAX_CHARS } from '@dorkos/shared/convention-files';
import {
  AgentMemoryRefSchema,
  MemoryNoteListQuerySchema,
  MemoryNoteListSchema,
  MemoryNoteNameSchema,
  MemorySnapshotSchema,
  type AgentMemoryRef,
  type MemoryNoteEntry,
  type MemoryNoteList,
  type MemoryNoteListQuery,
  type MemorySnapshot,
} from '@dorkos/shared/memory-provider';

import { resolveNoteFile, resolveNotesDir } from './paths.js';

/** How many notes one page lists when the caller does not say. */
export const NOTES_PAGE_SIZE = 50;

/**
 * How much of one notes file a read returns: twice the write cap, so a migrated
 * note over the cap still reads whole, and only a file a person grew by hand
 * far past it is cut short — with a warning, never silently.
 */
export const NOTE_READ_MAX_CHARS = MEMORY_NOTE_MAX_CHARS * 2;

/**
 * How much of each file a list reads: enough for any frontmatter this engine or
 * Claude Code writes and a first line, never the whole note. A list runs on the
 * way into every agent turn.
 */
const LIST_HEAD_BYTES = 4096;

/** How long a migrated note stays out of the tidy nudge's count. */
const RECENT_MIGRATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What the notes folder's own `.gitignore` says: ignore everything here.
 *
 * Written into the folder itself rather than into the repository's
 * `.gitignore`, so it works in any repo an agent lives in without DorkOS
 * editing a file it does not own. Notes can hold things a person would not
 * want committed, and an agent's folder is often a git checkout.
 */
const NOTES_GITIGNORE = '# Written by DorkOS: an agent’s notes are never committed.\n*\n';

/**
 * The start of a new notes file: its name and what it is about.
 *
 * The description is written as a JSON string, which is a valid YAML scalar
 * whatever it contains, so a colon or a quote in it cannot break the block.
 *
 * @param name - The note's name.
 * @param description - One line saying what it is about.
 */
export function noteTemplate(name: string, description: string): string {
  return ['---', `name: ${name}`, `description: ${JSON.stringify(description)}`, '---', ''].join(
    '\n'
  );
}

/**
 * Make sure the notes folder exists, with its `.gitignore`.
 *
 * The `.gitignore` is written only when it is missing (`wx`), so a person who
 * changed theirs keeps their version.
 *
 * @param agentPath - The agent's own directory.
 */
export async function ensureNotesDir(agentPath: string): Promise<string> {
  const dir = resolveNotesDir(agentPath);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(path.join(dir, '.gitignore'), NOTES_GITIGNORE, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return dir;
}

/**
 * One page of an agent's notes, newest first.
 *
 * Never throws for a folder it cannot read: that is `status: 'error'`. A folder
 * that does not exist is an empty list, which is the truth.
 *
 * @param ref - Whose notes.
 * @param query - Filter, cursor and page size.
 * @param now - The clock, for the "migrated this week" count. Tests pass one.
 */
export async function listNotes(
  ref: AgentMemoryRef,
  query: MemoryNoteListQuery,
  now: number = Date.now()
): Promise<MemoryNoteList> {
  const { query: filter, cursor, limit } = MemoryNoteListQuerySchema.parse(query);
  let entries: MemoryNoteEntry[];
  try {
    entries = await readEntries(AgentMemoryRefSchema.parse(ref).agentPath);
  } catch (err) {
    return MemoryNoteListSchema.parse({
      status: 'error',
      notes: [],
      total: 0,
      recentlyMigrated: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const needle = filter?.toLowerCase();
  const matching = needle
    ? entries.filter(
        (entry) =>
          entry.name.toLowerCase().includes(needle) ||
          entry.description.toLowerCase().includes(needle)
      )
    : entries;
  // The cursor is an offset into the newest-first order. A cursor that is not
  // one starts from the top rather than failing: the worst case is a repeat.
  const start = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  const size = limit ?? NOTES_PAGE_SIZE;
  const page = matching.slice(start, start + size);
  const next = start + size < matching.length ? String(start + size) : undefined;

  return MemoryNoteListSchema.parse({
    status: 'ok',
    notes: page,
    total: matching.length,
    recentlyMigrated: matching.filter(
      (entry) =>
        entry.migratedAt !== undefined && now - Date.parse(entry.migratedAt) < RECENT_MIGRATION_MS
    ).length,
    ...(next ? { nextCursor: next } : {}),
  });
}

/**
 * Read one notes file whole, three-way honest like `readMemorySnapshot`.
 *
 * @param ref - Whose note.
 * @param name - Which note.
 */
export async function readNote(ref: AgentMemoryRef, name: string): Promise<MemorySnapshot> {
  let raw: string | null;
  try {
    const file = resolveNoteFile(AgentMemoryRefSchema.parse(ref).agentPath, name);
    raw = await readOrNull(file);
  } catch (err) {
    return MemorySnapshotSchema.parse({
      status: 'error',
      content: '',
      bytes: 0,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (raw === null || raw.trim() === '') {
    return MemorySnapshotSchema.parse({
      status: 'absent',
      content: '',
      bytes: 0,
      truncated: false,
    });
  }
  const truncated = raw.length > NOTE_READ_MAX_CHARS;
  return MemorySnapshotSchema.parse({
    status: 'present',
    content: truncated ? raw.slice(0, NOTE_READ_MAX_CHARS) : raw,
    bytes: Buffer.byteLength(raw, 'utf8'),
    truncated,
    ...(truncated
      ? {
          warning:
            `Only the first ${NOTE_READ_MAX_CHARS.toLocaleString('en-US')} characters of this ` +
            'note are shown. Split it into smaller notes so nothing is left out.',
        }
      : {}),
  });
}

/**
 * Read a file, distinguishing "not there" from "could not read it".
 *
 * @param file - The resolved path.
 * @returns The contents, or `null` when the file does not exist.
 */
export async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Every notes file in the folder, newest first; an absent folder is none. */
async function readEntries(agentPath: string): Promise<MemoryNoteEntry[]> {
  const dir = resolveNotesDir(agentPath);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const entries: Array<MemoryNoteEntry & { mtime: number }> = [];
  for (const file of names) {
    if (!file.endsWith('.md')) continue;
    const name = file.slice(0, -'.md'.length);
    // A file a person dropped in with a name the jail would refuse is not a
    // note this surface can open, so it is not listed as one.
    if (!MemoryNoteNameSchema.safeParse(name).success) continue;
    const full = path.join(dir, file);
    // One entry that cannot be read (a folder named `x.md`, a file removed
    // between the listing and the read) is left out, never the whole list.
    try {
      const info = await stat(full);
      if (!info.isFile()) continue;
      const front = parseFrontmatter(await readHead(full));
      entries.push({
        name,
        description: front.description ?? firstLine(front.body),
        bytes: info.size,
        updatedAt: info.mtime.toISOString(),
        ...(front.migratedAt ? { migratedAt: front.migratedAt } : {}),
        mtime: info.mtimeMs,
      });
    } catch {
      continue;
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  return entries.map(({ mtime: _mtime, ...entry }) => entry);
}

/** The first {@link LIST_HEAD_BYTES} of a file, as text. */
async function readHead(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(LIST_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, LIST_HEAD_BYTES, 0);
    // A cut through a multi-byte character decodes to U+FFFD at the very end,
    // which only ever lands in a description fallback, never a field.
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Pull the two fields a list needs out of a notes file's frontmatter.
 *
 * Deliberately not a YAML parser: it reads `key: value` lines, unquoting a
 * JSON-style or single-quoted value, which covers what this engine writes and
 * what Claude Code wrote. Anything it cannot read is simply absent.
 *
 * @param content - The whole file.
 */
export function parseFrontmatter(content: string): {
  description?: string;
  migratedAt?: string;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return { body: content };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (pair) fields[pair[1]!] = unquote(pair[2]!.trim());
  }
  return {
    ...(fields.description ? { description: fields.description } : {}),
    ...(fields.migratedAt ? { migratedAt: fields.migratedAt } : {}),
    body: content.slice(match[0].length),
  };
}

/** Strip one layer of JSON-style or single quotes from a frontmatter value. */
function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** The first line of text in a body, without heading or bullet marks, capped. */
function firstLine(body: string): string {
  const line =
    body
      .split(/\r?\n/)
      .map((raw) => raw.replace(/^\s*(?:#+|[-*])\s*/, '').trim())
      .find((raw) => raw !== '' && !raw.startsWith('<!--')) ?? '';
  return line.length <= 200 ? line : `${line.slice(0, 199)}…`;
}
