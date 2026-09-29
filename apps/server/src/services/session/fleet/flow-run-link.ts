/**
 * Which work item a session serves, read from the file the `/flow` plugin
 * keeps (spec claude-account-fleet D8, shared contract flow-cli-core §1.3).
 *
 * flow records every run it drives in `<main checkout>/.dork/flow/flow-state.json`,
 * a map of issue id to `FlowRun`, one file per project shared by every
 * worktree. A run's `sessionId` is the join key: a DorkOS session whose id
 * matches a record serves that record's `identifier`. A run's optional
 * `dispatchedBy` is the second key: the chat that started that work in a chat
 * of its own (spec `flow-multiproject` §6.8, N9). One chat can therefore work
 * on several items, and every one is kept, newest first. DorkOS only READS the
 * file: it never writes it and never takes its lock (`flow-state.json.lock`),
 * because flow owns it until a later contract moves the store into DorkOS.
 * The link survives a restart for free, since the file is flow's.
 *
 * ## Reading the way flow reads
 *
 * {@link parseFlowRunState} is all-or-nothing, like flow's own reader: one
 * record that fails the `FlowRun` shape makes the whole file read as no runs.
 * That is the contract's fixture (`flow-run.cases.json`, "one invalid record
 * makes the whole file read as empty"). Unknown fields pass through.
 *
 * It is deliberately MORE tolerant than flow in one way: `stage` and `status`
 * are checked as bare strings, where flow's schema accepts only the values it
 * knows today. A DorkOS older than the flow writing the file would otherwise
 * blank every run the moment flow adds a stage, so this reader tolerates
 * future values, as the contract already asks for `host` and `runtime`.
 *
 * ## Cost on the session list
 *
 * The main checkout comes from the one project-root rule
 * (`services/projects/resolve-project-root.ts`), cached per cwd for the life of
 * the process (a cwd that is not in a git repository is re-asked after 60 s),
 * and the file is re-read only when its mtime or size changes, so a list
 * refresh costs one `stat` per distinct project.
 *
 * @module services/session/fleet/flow-run-link
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readTextFileWithin } from '@dorkos/shared/bounded-read';
import type { Session } from '@dorkos/shared/types';

import { logger } from '../../../lib/logger.js';
import { peekProjectRoot, resolveProjectRoot } from '../../projects/resolve-project-root.js';

/** The largest `flow-state.json` read, in bytes. */
const FLOW_STATE_MAX_BYTES = 1024 * 1024;

/** The file's path under the main checkout (contract §1.3). */
const FLOW_STATE_RELATIVE_PATH = path.join('.dork', 'flow', 'flow-state.json');

/** An optional object field flow validates deeply and DorkOS does not read. */
const opaqueObject = z.looseObject({}).optional();

/**
 * One `FlowRun` as flow writes it, checked for the types DorkOS relies on.
 * `looseObject` passes every unknown field through (contract §1.3 "Readers
 * pass unknown fields through").
 */
const FlowRunSchema = z.looseObject({
  issueId: z.string(),
  identifier: z.string(),
  sessionId: z.string(),
  worktreePath: z.string(),
  branch: z.string(),
  stage: z.string(),
  status: z.string(),
  attemptCount: z.number().int().nonnegative(),
  workerPid: z.number().int(),
  startedAt: z.string(),
  /**
   * The chat that started this work in a chat of its own, when one did
   * (spec `flow-multiproject` §6.8). Optional: older flow never writes it.
   */
  dispatchedBy: z.string().optional(),
  heartbeatAt: z.string().optional(),
  /** Fleet contract 4.1.0: when flow last wrote the record. A non-string makes the file invalid. */
  updatedAt: z.string().optional(),
  completedAt: z.string().optional(),
  account: z.string().optional(),
  host: z.string().optional(),
  runtime: z.string().optional(),
  checkpointAt: z.string().optional(),
  checkpointSha: z.string().optional(),
  provenance: opaqueObject,
  drain: opaqueObject,
  limit: opaqueObject,
});

/** The whole file: issue id to run. */
const FlowStateSchema = z.record(z.string(), FlowRunSchema);

/** One `FlowRun` record as read from `flow-state.json`, unknown fields included. */
export type FlowRunRecord = z.infer<typeof FlowRunSchema>;

/** One tracker item a session learns from a run that names it, newest first in lists. */
export interface FlowRunLink {
  /** The tracker identifier, e.g. `DOR-2386`. */
  identifier: string;
  /** The flow stage the run is in, e.g. `execute`. */
  stage: string;
  /** The run's status, e.g. `running`. */
  status: string;
  /** When the run started, as flow wrote it. */
  startedAt: string;
  /** `this-chat`: the run is this chat's. `own-chat`: this chat started it, and it runs in its own chat. */
  via: 'this-chat' | 'own-chat';
  /** For `own-chat`, the chat it runs in when that is a DorkOS chat; else null. */
  ownChatSessionId: string | null;
}

/**
 * Parse `flow-state.json` text the way flow's own reader does: all or nothing.
 *
 * @param raw - The file's text.
 * @returns The records unchanged, unknown fields included, or `null` when the
 *   text is empty, not JSON, or any record fails the `FlowRun` shape.
 */
export function parseFlowRunState(raw: string): Record<string, FlowRunRecord> | null {
  if (raw.trim() === '') return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = FlowStateSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Epoch ms of a run's start, with anything unreadable losing to every real time. */
function startedAtMs(startedAt: string): number {
  const ms = Date.parse(startedAt);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/**
 * Index runs by the sessions they belong to (spec `flow-multiproject` §6.8).
 *
 * A run belongs to the session it runs in (`this-chat`), and also to the
 * session that dispatched it, when that is another one (`own-chat`: work this
 * chat started that runs in its own chat). A run whose `dispatchedBy` is its
 * own `sessionId` counts once, as `this-chat`. Each list is newest first, by
 * parsed `startedAt`; a tie goes to the later record in the file.
 *
 * `ownChatSessionId` names the run's chat only when flow says it is a DorkOS
 * chat (`host: 'dorkos'`): a chat in a bare CLI has no page to open.
 */
function indexBySession(state: Record<string, FlowRunRecord>): Map<string, FlowRunLink[]> {
  const entries = new Map<string, { link: FlowRunLink; order: number }[]>();
  const add = (sessionId: string, link: FlowRunLink, order: number) => {
    let list = entries.get(sessionId);
    if (!list) entries.set(sessionId, (list = []));
    list.push({ link, order });
  };
  Object.values(state).forEach((record, order) => {
    const base = {
      identifier: record.identifier,
      stage: record.stage,
      status: record.status,
      startedAt: record.startedAt,
    };
    add(record.sessionId, { ...base, via: 'this-chat', ownChatSessionId: null }, order);
    if (record.dispatchedBy && record.dispatchedBy !== record.sessionId) {
      add(
        record.dispatchedBy,
        {
          ...base,
          via: 'own-chat',
          ownChatSessionId: record.host === 'dorkos' ? record.sessionId : null,
        },
        order
      );
    }
  });
  const links = new Map<string, FlowRunLink[]>();
  for (const [sessionId, list] of entries) {
    list.sort(
      (a, b) => startedAtMs(b.link.startedAt) - startedAtMs(a.link.startedAt) || b.order - a.order
    );
    links.set(
      sessionId,
      list.map((entry) => entry.link)
    );
  }
  return links;
}

/** The collaborators a {@link FlowRunLinkReader} uses; tests replace them. */
export interface FlowRunLinkDeps {
  /** The main checkout a cwd belongs to (`services/projects/resolve-project-root.ts`). */
  resolveRoot: (cwd: string) => Promise<string | null>;
  /**
   * The cached main checkout of a cwd without running git: the root, `null`
   * for no project, or `undefined` when not resolved yet.
   */
  peekRoot: (cwd: string) => string | null | undefined;
  /** Read a file's text with the size cap applied. */
  readText: (filePath: string) => Promise<string>;
  /** Where a file that cannot be read or parsed is reported. */
  log: { warn: (message: string) => void };
}

/** The two reads a session list needs. */
export interface FlowRunLinkReader {
  /**
   * The flow runs recorded for the project `cwd` belongs to, keyed by session id.
   *
   * @param cwd - A session's working directory (a main checkout or any of its worktrees).
   * @returns Session id to its runs, newest first; empty when `cwd` is not in a
   *   git repository or the project has no readable `flow-state.json`.
   */
  flowRunsFor(cwd: string): Promise<Map<string, FlowRunLink[]>>;
  /**
   * Set `trackerItems` (every run, newest first) and the deprecated
   * `trackerItem` (the newest run in THIS chat) on every session a flow run
   * names, in place. A session no run names is left exactly as it was. Each
   * distinct cwd is resolved once.
   *
   * @param page - The sessions about to be returned.
   */
  applyTrackerItems(page: Session[]): Promise<void>;
  /**
   * {@link applyTrackerItems} for a live event: it never runs git. A cwd whose
   * project is not resolved yet is resolved in the background and its
   * sessions are left as they are; the next event or list read carries them.
   *
   * @param page - The sessions about to be broadcast.
   */
  applyTrackerItemsLive(page: Session[]): Promise<void>;
}

const defaultDeps: FlowRunLinkDeps = {
  resolveRoot: resolveProjectRoot,
  peekRoot: peekProjectRoot,
  readText: (filePath) =>
    readTextFileWithin(filePath, FLOW_STATE_MAX_BYTES, 'The flow run file (flow-state.json)'),
  log: logger,
};

/**
 * Build a reader with its own caches. The server uses the module's default
 * instance ({@link flowRunsFor}, {@link applyTrackerItems}); a fresh one is
 * what a restart looks like.
 *
 * @param overrides - Collaborators to replace (tests).
 * @returns A reader with empty caches.
 */
export function createFlowRunLink(overrides: Partial<FlowRunLinkDeps> = {}): FlowRunLinkReader {
  const deps: FlowRunLinkDeps = { ...defaultDeps, ...overrides };
  /** flow-state.json path to what it read as, at one inode, mtime and size. */
  const runsByFile = new Map<
    string,
    { stamp: string; runs: Promise<Map<string, FlowRunLink[]>> }
  >();

  async function stateFileFor(cwd: string): Promise<string | null> {
    // Contract §1.3: the file lives in the main checkout. The root rule caches
    // per cwd (and a cwd in no repository for 60 s), so this costs no git
    // after the first list.
    const root = await deps.resolveRoot(cwd);
    return root === null ? null : path.join(root, FLOW_STATE_RELATIVE_PATH);
  }

  async function readRuns(file: string): Promise<Map<string, FlowRunLink[]>> {
    try {
      const state = parseFlowRunState(await deps.readText(file));
      if (state) return indexBySession(state);
      deps.log.warn(`[flow-run-link] ${file} is not a valid flow run file; reading it as no runs`);
    } catch (err) {
      deps.log.warn(
        `[flow-run-link] could not read ${file}; reading it as no runs: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    return new Map();
  }

  async function runsIn(file: string): Promise<Map<string, FlowRunLink[]>> {
    let stamp: string;
    try {
      const stat = await fs.stat(file);
      // The inode too: flow writes by rename, so a same-size rewrite within one
      // millisecond still gets a new inode.
      stamp = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      // No file: this project has no flow runs. Not worth a log line.
      runsByFile.delete(file);
      return new Map();
    }
    const cached = runsByFile.get(file);
    if (cached?.stamp === stamp) return cached.runs;
    // The promise is cached, not its result, so a main checkout and its
    // worktrees resolved in parallel share one read; and cached by stamp, so a
    // bad file is reported once per change, not once per list.
    const runs = readRuns(file);
    runsByFile.set(file, { stamp, runs });
    return runs;
  }

  async function flowRunsFor(cwd: string): Promise<Map<string, FlowRunLink[]>> {
    const file = await stateFileFor(cwd);
    return file === null ? new Map() : runsIn(file);
  }

  /** The runs of one cwd without git: `undefined` when its root is not known yet. */
  function flowRunsForLive(cwd: string): Promise<Map<string, FlowRunLink[]>> | undefined {
    const root = deps.peekRoot(cwd);
    if (root === undefined) {
      void deps.resolveRoot(cwd).catch(() => null);
      return undefined;
    }
    return root === null
      ? Promise.resolve(new Map())
      : runsIn(path.join(root, FLOW_STATE_RELATIVE_PATH));
  }

  async function overlay(
    page: Session[],
    runsOf: (cwd: string) => Promise<Map<string, FlowRunLink[]>> | undefined
  ): Promise<void> {
    const cwds = [...new Set(page.flatMap((s) => (s.cwd ? [s.cwd] : [])))];
    const runsByCwd = new Map<string, Map<string, FlowRunLink[]>>();
    await Promise.all(
      cwds.map(async (cwd) => {
        const runs = runsOf(cwd);
        if (runs) runsByCwd.set(cwd, await runs);
      })
    );
    for (const session of page) {
      const links = session.cwd ? runsByCwd.get(session.cwd)?.get(session.id) : undefined;
      if (!links || links.length === 0) continue;
      session.trackerItems = links.map((link) => ({
        id: link.identifier,
        stage: link.stage,
        runStatus: link.status,
        startedAt: link.startedAt,
        via: link.via,
        ownChatSessionId: link.ownChatSessionId,
      }));
      // Deprecated, kept for older flow installs until spec §6.8's removal
      // condition holds, with the meaning it always had: the newest run IN
      // this chat. Work this chat started in chats of their own is only in
      // `trackerItems`, so an older reader never mistakes it for this chat's.
      const own = links.find((link) => link.via === 'this-chat');
      if (own) {
        session.trackerItem = { id: own.identifier, stage: own.stage, runStatus: own.status };
      }
    }
  }

  function applyTrackerItems(page: Session[]): Promise<void> {
    return overlay(page, flowRunsFor);
  }

  function applyTrackerItemsLive(page: Session[]): Promise<void> {
    return overlay(page, flowRunsForLive);
  }

  return { flowRunsFor, applyTrackerItems, applyTrackerItemsLive };
}

const defaultReader = createFlowRunLink();

/**
 * The flow runs recorded for the project `cwd` belongs to, keyed by session id,
 * through the server's shared caches. See {@link FlowRunLinkReader.flowRunsFor}.
 *
 * @param cwd - A session's working directory.
 * @returns Session id to its runs, newest first.
 */
export function flowRunsFor(cwd: string): Promise<Map<string, FlowRunLink[]>> {
  return defaultReader.flowRunsFor(cwd);
}

/**
 * Set `trackerItems` and the deprecated `trackerItem` on every session a flow
 * run names, in place, through the server's shared caches. See
 * {@link FlowRunLinkReader.applyTrackerItems}.
 *
 * @param page - The sessions about to be returned.
 */
export function applyTrackerItems(page: Session[]): Promise<void> {
  return defaultReader.applyTrackerItems(page);
}

/**
 * {@link applyTrackerItems} for a live event, never running git. See
 * {@link FlowRunLinkReader.applyTrackerItemsLive}.
 *
 * @param page - The sessions about to be broadcast.
 */
export function applyTrackerItemsLive(page: Session[]): Promise<void> {
  return defaultReader.applyTrackerItemsLive(page);
}
