/**
 * The tasks and agents that said they read outside text, kept where no agent can write (DOR-3969).
 *
 * A task or an agent that reads mail, web pages or another app's text can say so
 * (`readsOutsideText: true`), whatever tool it reads them with. Every turn of its runs is then
 * marked as one that read outside words: what it posts is kept marked, and a send in it asks
 * first.
 *
 * Anyone may say it; only a person takes it back. The file that says it (a task's `SKILL.md`, an
 * agent's `.dork/agent.json`) is the agent's own to edit, so this record is the floor under it, the
 * way `permissions/person-set-permissions.ts` is the floor under an agent's settings: every write
 * that says `true`, from any door, lands here too, and the answer is this record OR the file. Only
 * {@link DeclaredReaders.clearByPerson}, reached from a door that has checked a person is asking,
 * removes an entry, so an agent editing its own file back to `false` changes nothing.
 *
 * An agent is kept by its id and by its folder, so the record still finds it when its own
 * `.dork/agent.json` cannot be read or names a different id. A task is kept by its id and by its
 * agent and name, so a task folder moved, or copied with the old one deleted, is still declared
 * when its file comes back as a new task with a new id ({@link carryDeclaredTask}). A task renamed
 * and moved at once is a new task.
 *
 * It lives in DorkOS's own data directory, beside the person-set permissions record.
 *
 * ## An unreadable record
 *
 * Logged once, and never overwritten while it stays unreadable, so a person can still repair it.
 * The answer is then whatever this process has been told since it started, OR the file: a task or
 * agent whose file says `true` is still marked, and the install does not mark every turn.
 *
 * @module services/core/turn-power/declared-readers
 */
import fs from 'node:fs';
import path from 'node:path';
import { readManifest } from '@dorkos/shared/manifest';
import { logger } from '../../../lib/logger.js';

/**
 * What the record keeps: an agent by its id or its folder, and a task by its id or by its agent
 * and name ({@link taskNameKey}).
 */
export type DeclaredReaderKind = 'agent' | 'agentHome' | 'task' | 'taskName';

/** A task as the record knows it: its id, and its agent and name. */
export interface DeclaredTaskRef {
  /** The task's id. */
  id: string;
  /** The agent it belongs to, or `null` for a task with none. */
  agentId: string | null;
  /** The task's name. */
  name: string;
}

/** Where the record lives, and where to report a failure. */
export interface DeclaredReadersDeps {
  /** The JSON file, inside DorkOS's data directory. */
  file: string;
  /** Where read and write failures are reported. */
  logger: { warn: (...args: unknown[]) => void };
}

/** The file's shape: each declared agent by id and by folder, and each task by id and by name. */
interface RecordFile {
  version: 1;
  agents: Record<string, true>;
  agentHomes?: Record<string, true>;
  tasks: Record<string, true>;
  taskNames?: Record<string, true>;
}

/** The record of every task and agent that said it reads outside text. */
export class DeclaredReaders {
  private readonly ids: Record<DeclaredReaderKind, Set<string>> = {
    agent: new Set(),
    agentHome: new Set(),
    task: new Set(),
    taskName: new Set(),
  };
  private broken = false;

  /**
   * Load the record from disk.
   *
   * @param deps - The file and the logger.
   */
  constructor(private readonly deps: DeclaredReadersDeps) {
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.deps.file, 'utf-8')) as Partial<RecordFile>;
      const homes = raw.agentHomes ?? {};
      const names = raw.taskNames ?? {};
      if (
        raw.version !== 1 ||
        !isIdMap(raw.agents) ||
        !isIdMap(homes) ||
        !isIdMap(raw.tasks) ||
        !isIdMap(names)
      ) {
        throw new Error('the record has an unknown shape');
      }
      for (const id of Object.keys(raw.agents)) this.ids.agent.add(id);
      for (const home of Object.keys(homes)) this.ids.agentHome.add(home);
      for (const id of Object.keys(raw.tasks)) this.ids.task.add(id);
      for (const name of Object.keys(names)) this.ids.taskName.add(name);
    } catch (err) {
      // No file yet is the normal start: nothing has said it reads outside text.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.broken = true;
      this.deps.logger.warn(
        '[turn-power] The record of tasks and agents that read outside text could not be read; ' +
          'each one’s own file still counts until it can',
        { err: err instanceof Error ? err.message : String(err) }
      );
    }
  }

  private save(): void {
    // Never over a record that could not be read: a person may still repair it.
    if (this.broken) return;
    try {
      fs.mkdirSync(path.dirname(this.deps.file), { recursive: true });
      const tmp = `${this.deps.file}.${process.pid}.tmp`;
      const body: RecordFile = {
        version: 1,
        agents: Object.fromEntries([...this.ids.agent].map((id) => [id, true as const])),
        agentHomes: Object.fromEntries([...this.ids.agentHome].map((h) => [h, true as const])),
        tasks: Object.fromEntries([...this.ids.task].map((id) => [id, true as const])),
        taskNames: Object.fromEntries([...this.ids.taskName].map((n) => [n, true as const])),
      };
      fs.writeFileSync(tmp, JSON.stringify(body), 'utf-8');
      fs.renameSync(tmp, this.deps.file);
    } catch (err) {
      this.deps.logger.warn(
        '[turn-power] Could not save the record of tasks and agents that read outside text',
        { err: err instanceof Error ? err.message : String(err) }
      );
    }
  }

  /**
   * Whether this task or agent said it reads outside text.
   *
   * @param kind - A task by id or name, or an agent by id or folder.
   * @param id - Its id, the task's {@link taskNameKey}, or the agent's folder.
   */
  has(kind: DeclaredReaderKind, id: string): boolean {
    return this.ids[kind].has(id);
  }

  /**
   * Record that this task or agent reads outside text. Any caller may; a no-op when it already
   * said so.
   *
   * @param kind - A task by id or name, or an agent by id or folder.
   * @param id - Its id, the task's {@link taskNameKey}, or the agent's folder.
   */
  declare(kind: DeclaredReaderKind, id: string): void {
    if (this.ids[kind].has(id)) return;
    this.ids[kind].add(id);
    this.save();
  }

  /**
   * Take it back. Only for a door that has already checked a person is asking: an agent's own
   * write never reaches here.
   *
   * @param kind - A task by id or name, or an agent by id or folder.
   * @param id - Its id, the task's {@link taskNameKey}, or the agent's folder.
   */
  clearByPerson(kind: DeclaredReaderKind, id: string): void {
    if (!this.ids[kind].delete(id)) return;
    this.save();
  }
}

/** Whether a parsed value is a map of ids to `true`. */
function isIdMap(value: unknown): value is Record<string, true> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => v === true)
  );
}

let current: DeclaredReaders | null = null;

/**
 * Install the record this process reads, once at startup (tests install their own).
 *
 * @param next - The record, or `null` to remove it.
 */
export function setDeclaredReaders(next: DeclaredReaders | null): void {
  current = next;
}

/** The record this process reads, or `null` before startup installed one. */
export function declaredReaders(): DeclaredReaders | null {
  return current;
}

/**
 * The key a task is kept by beside its id: its agent and its name.
 *
 * @param agentId - The task's agent, or `null` for a task with none.
 * @param name - The task's name.
 */
export function taskNameKey(agentId: string | null, name: string): string {
  return JSON.stringify([agentId, name]);
}

/**
 * Whether a task said it reads outside text. A file sync carries a declaration onto the id of the
 * task it lands ({@link carryDeclaredTask}), so the id alone answers here.
 *
 * @param taskId - The task.
 */
export function taskReadsOutsideText(taskId: string): boolean {
  return current?.has('task', taskId) === true;
}

/**
 * Record that a task reads outside text, by its id and by its agent and name. Any caller may.
 *
 * @param task - The task.
 */
export function declareTask(task: DeclaredTaskRef): void {
  current?.declare('task', task.id);
  current?.declare('taskName', taskNameKey(task.agentId, task.name));
}

/**
 * Settle the record after a task write that landed: `true` declares it, from anyone; `false`
 * clears it, by id and by name, and only for a person. A write that did not name the field
 * changes nothing.
 *
 * @param task - The task written, as it now reads.
 * @param value - The `readsOutsideText` the write carried, if any.
 * @param byPerson - Whether the door checked that a person is asking.
 */
export function settleDeclaredTask(
  task: DeclaredTaskRef,
  value: boolean | undefined,
  byPerson: boolean
): void {
  if (value === true) declareTask(task);
  else if (value === false && byPerson) {
    current?.clearByPerson('task', task.id);
    current?.clearByPerson('taskName', taskNameKey(task.agentId, task.name));
  }
}

/**
 * Settle the record after a file sync landed a task: declared when its file says so, or when the
 * record already holds it by id or by its agent and name. A task folder moved, or copied and the
 * old one deleted, lands as a new task with a new id; the declaration is carried onto that id, so
 * its runs are marked. A task renamed and moved at once matches neither, and is a new task.
 *
 * @param task - The task the sync landed.
 * @param fileSays - Whether its file says it reads outside text.
 * @returns Whether the task is declared now.
 */
export function carryDeclaredTask(task: DeclaredTaskRef, fileSays: boolean): boolean {
  const declared =
    fileSays ||
    current?.has('task', task.id) === true ||
    current?.has('taskName', taskNameKey(task.agentId, task.name)) === true;
  if (declared) declareTask(task);
  return declared;
}

/**
 * Record that an agent reads outside text, by its id and, when known, its folder. Any caller may.
 *
 * @param id - The agent's id.
 * @param home - The agent's folder, if known.
 */
export function declareAgent(id: string, home: string | undefined): void {
  current?.declare('agent', id);
  if (home !== undefined) current?.declare('agentHome', path.resolve(home));
}

/**
 * Take back that an agent reads outside text, by its id and its folder. Only for a door that has
 * already checked a person is asking.
 *
 * @param id - The agent's id.
 * @param home - The agent's folder, if known.
 */
export function clearAgentByPerson(id: string, home: string | undefined): void {
  current?.clearByPerson('agent', id);
  if (home !== undefined) current?.clearByPerson('agentHome', path.resolve(home));
}

/**
 * Whether the agent at this folder said it reads outside text: the record, by its folder or its
 * id, or its own `.dork/agent.json`. A file that says `true` is written into the record as it is
 * read, so a later edit of that file back to `false` cannot clear it, and the folder is kept too,
 * so a file that cannot be read or names another id cannot clear it either.
 *
 * @param agentPath - The agent's folder.
 */
export async function agentReadsOutsideText(agentPath: string): Promise<boolean> {
  if (current?.has('agentHome', path.resolve(agentPath))) return true;
  const manifest = await readManifest(agentPath, logger);
  if (!manifest) return false;
  if (manifest.readsOutsideText === true || current?.has('agent', manifest.id)) {
    declareAgent(manifest.id, agentPath);
    return true;
  }
  return false;
}
