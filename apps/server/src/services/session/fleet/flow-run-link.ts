/**
 * Which work item a session serves, read from the file the `/flow` plugin
 * keeps (spec claude-account-fleet D8, shared contract flow-cli-core §1.3).
 *
 * flow records every run it drives in `<main checkout>/.dork/flow/flow-state.json`,
 * a map of issue id to `FlowRun`, one file per project shared by every
 * worktree. A run's `sessionId` is the join key: a DorkOS session whose id
 * matches a record serves that record's `identifier`. DorkOS only READS the
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
 * The main checkout is resolved once per cwd for the life of the process (a
 * cwd that is not in a git repository is re-asked after 60 s), and the file is
 * re-read only when its mtime or size changes, so a list refresh costs one
 * `stat` per distinct project.
 *
 * @module services/session/fleet/flow-run-link
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readTextFileWithin } from '@dorkos/shared/bounded-read';
import type { Session } from '@dorkos/shared/types';

import { logger } from '../../../lib/logger.js';
import { runGit } from '../../workspace/providers/git.js';

/** The largest `flow-state.json` read, in bytes. */
const FLOW_STATE_MAX_BYTES = 1024 * 1024;

/** How long a cwd that is not in a git repository stays "no runs" before git is asked again. */
const NEGATIVE_CWD_TTL_MS = 60_000;

/** Timeout for the one `git rev-parse`, which runs while a list request waits. */
const GIT_TIMEOUT_MS = 5_000;

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
  heartbeatAt: z.string().optional(),
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

/** What a session learns from the run that names it. */
export interface FlowRunLink {
  /** The tracker identifier, e.g. `DOR-2386`. */
  identifier: string;
  /** The flow stage the run is in, e.g. `execute`. */
  stage: string;
  /** The run's status, e.g. `running`. */
  status: string;
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

/**
 * Index runs by session id. When two runs name one session, the one started
 * most recently wins (a later tie goes to the later record in the file).
 */
function indexBySession(state: Record<string, FlowRunRecord>): Map<string, FlowRunLink> {
  const winners = new Map<string, FlowRunRecord>();
  for (const record of Object.values(state)) {
    const current = winners.get(record.sessionId);
    if (!current || record.startedAt >= current.startedAt) winners.set(record.sessionId, record);
  }
  const links = new Map<string, FlowRunLink>();
  for (const [sessionId, record] of winners) {
    links.set(sessionId, {
      identifier: record.identifier,
      stage: record.stage,
      status: record.status,
    });
  }
  return links;
}

/** The collaborators a {@link FlowRunLinkReader} uses; tests replace them. */
export interface FlowRunLinkDeps {
  /** The repo's git runner (`services/workspace/providers/git.ts`). */
  runGit: typeof runGit;
  /** Read a file's text with the size cap applied. */
  readText: (filePath: string) => Promise<string>;
  /** Where a file that cannot be read or parsed is reported. */
  log: { warn: (message: string) => void };
  /** The clock, in epoch ms. */
  now: () => number;
}

/** The two reads a session list needs. */
export interface FlowRunLinkReader {
  /**
   * The flow runs recorded for the project `cwd` belongs to, keyed by session id.
   *
   * @param cwd - A session's working directory (a main checkout or any of its worktrees).
   * @returns Session id to run; empty when `cwd` is not in a git repository or
   *   the project has no readable `flow-state.json`.
   */
  flowRunsFor(cwd: string): Promise<Map<string, FlowRunLink>>;
  /**
   * Set `trackerItem` on every session a flow run names, in place. A session
   * no run names is left exactly as it was. Each distinct cwd is resolved once.
   *
   * @param page - The sessions about to be returned.
   */
  applyTrackerItems(page: Session[]): Promise<void>;
}

const defaultDeps: FlowRunLinkDeps = {
  runGit,
  readText: (filePath) =>
    readTextFileWithin(filePath, FLOW_STATE_MAX_BYTES, 'The flow run file (flow-state.json)'),
  log: logger,
  now: Date.now,
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
  /**
   * cwd to the lookup of its flow-state.json path. The PROMISE is cached, so
   * concurrent list requests on a cold server share one `git` per cwd. A
   * positive answer holds for the process; `null` (not in a git repository)
   * holds until `retryAt`, set once the lookup settles.
   */
  const fileByCwd = new Map<string, { file: Promise<string | null>; retryAt?: number }>();
  /** flow-state.json path to what it read as, at one inode, mtime and size. */
  const runsByFile = new Map<string, { stamp: string; runs: Promise<Map<string, FlowRunLink>> }>();

  async function lookUpStateFile(cwd: string): Promise<string | null> {
    try {
      const commonDir = (
        await deps.runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd, {
          timeoutMs: GIT_TIMEOUT_MS,
        })
      ).trim();
      if (!commonDir) return null;
      // Contract §1.3: the main checkout is the parent of the git common dir.
      return path.join(path.dirname(commonDir), FLOW_STATE_RELATIVE_PATH);
    } catch {
      return null;
    }
  }

  function stateFileFor(cwd: string): Promise<string | null> {
    const cached = fileByCwd.get(cwd);
    if (cached && (cached.retryAt === undefined || deps.now() < cached.retryAt)) {
      return cached.file;
    }
    const entry: { file: Promise<string | null>; retryAt?: number } = {
      file: lookUpStateFile(cwd).then((file) => {
        if (file === null) entry.retryAt = deps.now() + NEGATIVE_CWD_TTL_MS;
        return file;
      }),
    };
    fileByCwd.set(cwd, entry);
    return entry.file;
  }

  async function readRuns(file: string): Promise<Map<string, FlowRunLink>> {
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

  async function runsIn(file: string): Promise<Map<string, FlowRunLink>> {
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

  async function flowRunsFor(cwd: string): Promise<Map<string, FlowRunLink>> {
    const file = await stateFileFor(cwd);
    return file === null ? new Map() : runsIn(file);
  }

  async function applyTrackerItems(page: Session[]): Promise<void> {
    const cwds = [...new Set(page.flatMap((s) => (s.cwd ? [s.cwd] : [])))];
    const runsByCwd = new Map(
      await Promise.all(cwds.map(async (cwd) => [cwd, await flowRunsFor(cwd)] as const))
    );
    for (const session of page) {
      const link = session.cwd ? runsByCwd.get(session.cwd)?.get(session.id) : undefined;
      if (!link) continue;
      session.trackerItem = { id: link.identifier, stage: link.stage, runStatus: link.status };
    }
  }

  return { flowRunsFor, applyTrackerItems };
}

const defaultReader = createFlowRunLink();

/**
 * The flow runs recorded for the project `cwd` belongs to, keyed by session id,
 * through the server's shared caches. See {@link FlowRunLinkReader.flowRunsFor}.
 *
 * @param cwd - A session's working directory.
 * @returns Session id to run.
 */
export function flowRunsFor(cwd: string): Promise<Map<string, FlowRunLink>> {
  return defaultReader.flowRunsFor(cwd);
}

/**
 * Set `trackerItem` on every session a flow run names, in place, through the
 * server's shared caches. See {@link FlowRunLinkReader.applyTrackerItems}.
 *
 * @param page - The sessions about to be returned.
 */
export function applyTrackerItems(page: Session[]): Promise<void> {
  return defaultReader.applyTrackerItems(page);
}
