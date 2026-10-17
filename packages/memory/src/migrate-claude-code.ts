/**
 * Moving the notes in Claude Code's own memory folders into each agent's
 * DorkOS memory, so an agent's DorkOS memory can be its only memory.
 *
 * Claude Code keeps a memory folder per working directory and per account:
 * `<account>/projects/<slug>/memory/`, a `MEMORY.md` index plus topic files.
 * This module maps each folder to the agent whose path has that slug, then
 * COPIES its files into `<agentPath>/.dork/memory/`. It never edits or deletes
 * an original: the most it adds to an old folder is a marker file saying where
 * the notes went, and a person removes the originals when they are ready.
 *
 * Two halves, so a dry run is the same code as the real one: {@link planClaudeMemoryMigration}
 * reads everything and decides, and {@link applyClaudeMemoryMigration} writes
 * exactly what the plan says. {@link renderMigrationReport} turns either into
 * the report a person reads first.
 *
 * @module memory/migrate-claude-code
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MIGRATED_PROVENANCE_PHRASE } from '@dorkos/shared/convention-files';

import { ensureNotesDir, parseFrontmatter, readOrNull } from './notes.js';
import { resolveNoteFile, resolveNotesDir } from './paths.js';

/** One agent the migration may copy notes into. */
export interface MigrationAgent {
  /** The agent's name, for the report. */
  name: string;
  /** The agent's registered home, absolute. Notes go to `<path>/.dork/memory/`. */
  path: string;
}

/** What the planner needs to know. Everything it touches is named here. */
export interface MigrationInput {
  /** Claude Code account folders to read, e.g. `~/.claude`, `~/.claude2`. */
  accountDirs: readonly string[];
  /** The agents on this machine, from the registry. */
  agents: readonly MigrationAgent[];
  /**
   * Claude Code's project slug for a path: how the agent's path is matched to a
   * memory folder. Passed in so the planner uses exactly the runtime's own rule.
   */
  slugOf: (agentPath: string) => string;
  /** Today, `YYYY-MM-DD`: the date every migrated note records. */
  date: string;
  /**
   * Read a folder that already carries the "moved" marker again. Off by
   * default, so a second run never brings back a note the agent has since
   * tidied away.
   */
  force?: boolean;
  /**
   * Named accounts to read anyway. By default only `.claude` and the numbered
   * `.claude2`, `.claude3` … are read; a NAMED account folder (`.claude-work`,
   * `.claude-ab1`) is usually a separate identity kept apart on purpose, such
   * as a work account, so its notes stay where they are unless named here.
   */
  includeAccounts?: readonly string[];
}

/** What happens to one source file. */
export type PlannedAction =
  /** Copy it to `target`. */
  | 'copy'
  /** The same text was already planned from another account: one copy is enough. */
  | 'same-as-other-account'
  /** An earlier run already copied this file; nothing to do. */
  | 'already-migrated'
  /** It could not be read, or no free name could be found for it. Reported, not copied. */
  | 'skipped';

/** One source file and where it goes. */
export interface PlannedNote {
  /** The original, absolute. Never modified. */
  source: string;
  /** Which account it came from, e.g. `claude3`. */
  account: string;
  /** The note name it is copied to, or would have been. */
  target: string;
  /** What happens to it. */
  action: PlannedAction;
  /** Why the name changed, when it did: an unusable character, or a clash. */
  renamedBecause?: 'name' | 'collision';
  /** Why it was skipped, when it was. */
  skippedBecause?: string;
  /** Size of the original, in characters. */
  chars: number;
  /** The original's SHA-1, recorded on the copy so a later run knows the text is already in. */
  sha1: string;
}

/** Everything planned for one agent. */
export interface AgentMigrationPlan {
  agent: MigrationAgent;
  /** The Claude Code memory folders that mapped to this agent. */
  folders: string[];
  notes: PlannedNote[];
}

/** A memory folder the migration leaves exactly where it is, and why. */
export interface UnmatchedFolder {
  account: string;
  folder: string;
  files: number;
  /**
   * - `'no-agent'`: no registered agent's path has this folder's slug.
   * - `'two-agents'`: more than one does, so it is not guessed.
   * - `'agent-folder-missing'`: the agent is registered but its folder is gone.
   * - `'already-moved'`: an earlier run left its marker; pass `force` to read it again.
   * - `'named-account'`: a named account, left out unless `includeAccounts` names it.
   */
  reason: 'no-agent' | 'two-agents' | 'agent-folder-missing' | 'already-moved' | 'named-account';
}

/** The whole plan: what a dry run reports and a real run carries out. */
export interface MigrationPlan {
  date: string;
  agents: AgentMigrationPlan[];
  unmatched: UnmatchedFolder[];
}

/** What a real run did, per agent. */
export interface AgentMigrationResult {
  agent: string;
  copied: number;
  /** Old folders a "moved" marker was written into: only folders whose every copy succeeded. */
  markers: number;
  /** What could not be written, with why. Nothing else about the run is affected. */
  failed: Array<{ source: string; error: string }>;
}

/**
 * The marker file left in an old folder. Its presence is also what tells the
 * Claude Code runtime that this folder's notes have moved, so Claude Code's
 * own memory can stay off for that agent.
 */
export const MOVED_MARKER_FILE = 'MOVED-TO-DORKOS.md';

/** How many numbered names a clash may try before the note is reported instead. */
const MAX_CLASH_SUFFIX = 100;

/**
 * Read every account's memory folders and decide what to copy where. Reads
 * only: nothing is written.
 *
 * @param input - The accounts, the agents, the slug rule and today's date.
 */
export async function planClaudeMemoryMigration(input: MigrationInput): Promise<MigrationPlan> {
  const bySlug = new Map<string, MigrationAgent | 'two-agents'>();
  for (const agent of input.agents) {
    const slug = input.slugOf(agent.path);
    const seen = bySlug.get(slug);
    bySlug.set(
      slug,
      seen && seen !== 'two-agents' && seen.path !== agent.path ? 'two-agents' : agent
    );
  }

  const plans = new Map<string, AgentMigrationPlan>();
  const unmatched: UnmatchedFolder[] = [];
  // Per agent: the names taken so far, and the text hash each one holds.
  const taken = new Map<string, Map<string, string>>();
  const migratedSources = new Map<string, Set<string>>();

  for (const accountDir of [...input.accountDirs].sort()) {
    const account = path.basename(accountDir).replace(/^\./, '');
    const named = !/^claude\d*$/.test(account) && !input.includeAccounts?.includes(account);
    const projects = path.join(accountDir, 'projects');
    for (const slug of (await listOrEmpty(projects)).sort()) {
      const folder = path.join(projects, slug, 'memory');
      const files = (await listOrEmpty(folder)).filter((file) => file.endsWith('.md')).sort();
      const notes = files.filter((file) => file !== MOVED_MARKER_FILE);
      if (notes.length === 0) continue;
      const leave = (reason: UnmatchedFolder['reason']) =>
        unmatched.push({ account, folder, files: notes.length, reason });
      const agent = bySlug.get(slug);
      if (!agent) {
        leave('no-agent');
        continue;
      }
      if (named) {
        leave('named-account');
        continue;
      }
      if (agent === 'two-agents') {
        leave('two-agents');
        continue;
      }
      if (!(await isDirectory(agent.path))) {
        leave('agent-folder-missing');
        continue;
      }
      if (files.includes(MOVED_MARKER_FILE) && !input.force) {
        leave('already-moved');
        continue;
      }

      let plan = plans.get(agent.path);
      if (!plan) {
        plan = { agent, folders: [], notes: [] };
        plans.set(agent.path, plan);
        taken.set(agent.path, await existingNoteHashes(agent.path));
        migratedSources.set(agent.path, await existingMigratedSources(agent.path));
      }
      plan.folders.push(folder);
      const names = taken.get(agent.path)!;
      const done = migratedSources.get(agent.path)!;

      for (const file of notes) {
        const source = path.join(folder, file);
        const base =
          file === 'MEMORY.md' ? `claude-code-index-${account}` : file.slice(0, -'.md'.length);
        const clean = noteNameFrom(base);
        let text: string;
        try {
          text = await readFile(source, 'utf8');
        } catch (err) {
          plan.notes.push({
            source,
            account,
            target: clean,
            action: 'skipped',
            skippedBecause: `could not be read: ${errorText(err)}`,
            chars: 0,
            sha1: '',
          });
          continue;
        }
        const hash = sha1(text);
        const entry = { source, account, chars: text.length, sha1: hash };

        if (done.has(sourceKey(account, file))) {
          plan.notes.push({ ...entry, target: clean, action: 'already-migrated' });
          continue;
        }
        const holder = names.get(clean);
        if (holder === hash) {
          plan.notes.push({ ...entry, target: clean, action: 'same-as-other-account' });
          continue;
        }
        let target: string | null = clean;
        let renamedBecause: PlannedNote['renamedBecause'] = clean !== base ? 'name' : undefined;
        if (holder !== undefined) {
          target = freeName(names, clean, account, hash);
          renamedBecause = 'collision';
          if (target !== null && names.get(target) === hash) {
            plan.notes.push({ ...entry, target, action: 'same-as-other-account' });
            continue;
          }
        }
        if (target === null) {
          plan.notes.push({
            ...entry,
            target: clean,
            action: 'skipped',
            skippedBecause: 'no free note name was left for it',
          });
          continue;
        }
        names.set(target, hash);
        plan.notes.push({
          ...entry,
          target,
          action: 'copy',
          ...(renamedBecause ? { renamedBecause } : {}),
        });
      }
    }
  }

  return {
    date: input.date,
    agents: [...plans.values()].sort((a, b) => a.agent.name.localeCompare(b.agent.name)),
    unmatched,
  };
}

/**
 * Carry out a plan: copy each `copy` note, then leave a marker in each old
 * folder whose every copy succeeded.
 *
 * **Nothing is overwritten.** Every note is written with `wx`, so a file that
 * appeared since the plan was made is reported as failed, not replaced. One
 * failure, for one note or one whole agent, does not stop the rest. A folder
 * with a failed copy gets no marker, so its agent keeps Claude Code's own
 * memory until a later run finishes the job.
 *
 * `MEMORY.md` is not written: the memory block already names the notes files,
 * and leaving it alone means this script never races the running server for
 * the one file both would write.
 *
 * @param plan - What {@link planClaudeMemoryMigration} decided.
 */
export async function applyClaudeMemoryMigration(
  plan: MigrationPlan
): Promise<AgentMigrationResult[]> {
  const results: AgentMigrationResult[] = [];
  for (const agentPlan of plan.agents) {
    const { agent } = agentPlan;
    const result: AgentMigrationResult = { agent: agent.name, copied: 0, markers: 0, failed: [] };
    results.push(result);
    const copies = agentPlan.notes.filter((note) => note.action === 'copy');
    try {
      if (copies.length > 0) await ensureNotesDir(agent.path);
    } catch (err) {
      result.failed.push({ source: agent.path, error: errorText(err) });
      continue;
    }
    const failedFolders = new Set(
      agentPlan.notes.filter((note) => note.action === 'skipped').map((n) => path.dirname(n.source))
    );
    for (const note of copies) {
      try {
        const original = await readFile(note.source, 'utf8');
        await writeFile(
          resolveNoteFile(agent.path, note.target),
          migratedNoteText(original, note, plan.date),
          { flag: 'wx' }
        );
        result.copied++;
      } catch (err) {
        result.failed.push({ source: note.source, error: errorText(err) });
        failedFolders.add(path.dirname(note.source));
      }
    }

    for (const folder of agentPlan.folders) {
      if (failedFolders.has(folder)) continue;
      try {
        await writeFile(path.join(folder, MOVED_MARKER_FILE), movedMarkerText(agent, plan.date), {
          flag: 'wx',
        });
        result.markers++;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          result.failed.push({ source: folder, error: errorText(err) });
        }
      }
    }
  }
  return results;
}

/** Why a folder was left alone, as the report says it. */
const UNMATCHED_WHY: Record<UnmatchedFolder['reason'], string> = {
  'no-agent': 'no agent has this folder',
  'two-agents': 'two agents have the same folder, so it is not guessed',
  'agent-folder-missing': "the agent's own folder is gone",
  'already-moved': 'already copied by an earlier run',
  'named-account':
    'a named account (often a work account), left alone; pass --include-account to copy it',
};

/**
 * The report a person reads: what was found, where each note goes, the name
 * clashes first so they can be skimmed, and the folders left alone.
 *
 * @param plan - The plan.
 * @param results - What a real run did, or `undefined` for a dry run.
 */
export function renderMigrationReport(
  plan: MigrationPlan,
  results?: readonly AgentMigrationResult[]
): string {
  const lines: string[] = [];
  const mode = results ? 'Migration run' : 'Dry run (nothing was written)';
  lines.push(`# Claude Code memory → DorkOS memory: ${mode}, ${plan.date}`, '');

  lines.push('## Summary', '');
  lines.push(
    '| Agent | Found | Copy | Same text in another account | Already copied | Skipped | Renamed |'
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const { agent, notes } of plan.agents) {
    const count = (action: PlannedAction) => notes.filter((n) => n.action === action).length;
    const renamed = notes.filter((n) => n.renamedBecause).length;
    lines.push(
      `| ${agent.name} | ${notes.length} | ${count('copy')} | ${count('same-as-other-account')} | ${count('already-migrated')} | ${count('skipped')} | ${renamed} |`
    );
  }
  lines.push('');

  const clashes = plan.agents.flatMap(({ agent, notes }) =>
    notes
      .filter((n) => n.renamedBecause === 'collision')
      .map((n) => `- **${agent.name}**: \`${n.target}\` (from ${n.account}: ${n.source})`)
  );
  lines.push('## Name clashes', '');
  lines.push(
    clashes.length > 0
      ? 'Same file name, different text, in two accounts. Both are kept; the later account gets its name as a suffix.'
      : 'None.',
    ''
  );
  lines.push(...clashes, ...(clashes.length > 0 ? [''] : []));

  if (results) {
    lines.push('## What the run did', '');
    for (const r of results) {
      lines.push(
        `- **${r.agent}**: ${r.copied} copied, ${r.markers} marker(s) left` +
          (r.failed.length > 0 ? `, ${r.failed.length} failed` : '')
      );
      for (const f of r.failed) lines.push(`  - failed: ${f.source}: ${f.error}`);
    }
    lines.push('');
  }

  lines.push('## Folders left alone', '');
  lines.push(
    ...(plan.unmatched.length > 0
      ? plan.unmatched.map(
          (u) => `- ${u.account}: ${u.folder} (${u.files} files): ${UNMATCHED_WHY[u.reason]}`
        )
      : ['None.']),
    ''
  );

  lines.push('## Every note, per agent', '');
  for (const { agent, folders, notes } of plan.agents) {
    lines.push(`### ${agent.name}`, '', `Into \`${resolveNotesDir(agent.path)}\`, from:`, '');
    lines.push(...folders.map((f) => `- ${f}`), '');
    for (const n of notes) {
      const why = n.skippedBecause
        ? ` (${n.skippedBecause})`
        : n.renamedBecause
          ? ` (renamed: ${n.renamedBecause})`
          : '';
      lines.push(`- ${n.action}: ${n.account}/${path.basename(n.source)} → \`${n.target}\`${why}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The copy's text: the original, with where it came from added to its
 * frontmatter (created when it had none) and a stamp line at the end.
 *
 * The original's own frontmatter fields and dates are kept as they were.
 *
 * @param original - The source file's text.
 * @param note - The planned note.
 * @param date - Today.
 */
export function migratedNoteText(original: string, note: PlannedNote, date: string): string {
  const added = [
    `migratedFrom: ${JSON.stringify(sourceKey(note.account, path.basename(note.source)))}`,
    `migratedAt: ${date}`,
    `migratedAccount: ${note.account}`,
    `migratedSha1: ${note.sha1}`,
  ];
  const front = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(original);
  let head: string;
  let body: string;
  if (front) {
    head = `---\n${front[1]}\n${added.join('\n')}\n---\n`;
    body = original.slice(front[0].length);
  } else {
    const description = parseFrontmatter(original).description;
    head = [
      '---',
      `name: ${note.target}`,
      ...(description ? [`description: ${JSON.stringify(description)}`] : []),
      ...added,
      '---',
      '',
    ].join('\n');
    body = original;
  }
  const stamp = `_Copied in by DorkOS (${MIGRATED_PROVENANCE_PHRASE}, ${date})_`;
  return `${head}${body.trimEnd()}\n\n${stamp}\n`;
}

/**
 * Turn a file name into a note name the jail accepts: lowercase, with any other
 * character a `-`, starting with a letter or digit, at most 80 characters.
 *
 * @param base - The file name without `.md`.
 */
export function noteNameFrom(base: string): string {
  const name = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 80);
  if (name === '') return 'note';
  // A Windows device name cannot be a file there; keep it readable instead.
  return /^(?:con|prn|aux|nul|com\d|lpt\d)$/.test(name) ? `${name}-note` : name;
}

/** The marker an old folder gets: where its notes went, and that nothing was removed. */
function movedMarkerText(agent: MigrationAgent, date: string): string {
  return [
    '# These notes were copied to DorkOS',
    '',
    `On ${date}, DorkOS copied the notes in this folder into the memory of the agent`,
    `"${agent.name}": ${resolveNotesDir(agent.path)}`,
    '',
    'Nothing here was changed or deleted. When this agent runs in DorkOS, Claude Code no longer',
    'reads or writes this folder.',
    'You can delete it yourself once you are happy with the copy.',
    '',
  ].join('\n');
}

/**
 * The notes already in an agent's notes folder, by name, each with the hash a
 * source file would have to match to count as "the same text": a migrated
 * copy's recorded `migratedSha1`, or, for the agent's own note, a value no
 * source can match, so a source with that name is always kept beside it.
 */
async function existingNoteHashes(agentPath: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const dir = resolveNotesDir(agentPath);
  for (const file of await listOrEmpty(dir)) {
    if (!file.endsWith('.md')) continue;
    const text = await readOrNull(path.join(dir, file));
    if (text === null) continue;
    const recorded = /^migratedSha1:\s*([0-9a-f]{40})\s*$/m.exec(text);
    names.set(file.slice(0, -'.md'.length), recorded ? recorded[1]! : `own:${sha1(text)}`);
  }
  return names;
}

/** The originals an earlier run already copied, as `account:file`, from each copy's `migratedFrom`. */
async function existingMigratedSources(agentPath: string): Promise<Set<string>> {
  const sources = new Set<string>();
  const dir = resolveNotesDir(agentPath);
  for (const file of await listOrEmpty(dir)) {
    if (!file.endsWith('.md')) continue;
    const text = await readOrNull(path.join(dir, file));
    const match = text ? /^migratedFrom:\s*(.+)$/m.exec(text) : null;
    if (!match) continue;
    try {
      sources.add(String(JSON.parse(match[1]!.trim())));
    } catch {
      sources.add(match[1]!.trim());
    }
  }
  return sources;
}

/**
 * The first free name for a clashing note: `<name>--<account>`, then
 * `<name>--<account>-2` and so on, each cut so the suffix always survives the
 * 80-character limit. `null` when none is free.
 */
function freeName(
  names: ReadonlyMap<string, string>,
  clean: string,
  account: string,
  hash: string
): string | null {
  for (let n = 1; n <= MAX_CLASH_SUFFIX; n++) {
    const suffix = noteNameFrom(`--${account}${n === 1 ? '' : `-${n}`}`).replace(/^/, '--');
    const candidate = `${clean.slice(0, 80 - suffix.length)}${suffix}`;
    if (!names.has(candidate) || names.get(candidate) === hash) return candidate;
  }
  return null;
}

/** How a copy records its original: account and file name, never a full path. */
function sourceKey(account: string, file: string): string {
  return `${account}:${file}`;
}

/** Whether a path is an existing directory. */
async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A folder's entries, or none when it does not exist or is not a folder: a
 * `projects/` listing holds stray files too (macOS's `.DS_Store`).
 */
async function listOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
