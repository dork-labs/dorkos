/**
 * The typed **`FlowRun` writer/reader** for `.dork/flow/flow-state.json` (§12,
 * tasks 3.1/3.5) — the durable run store keyed by issue id (`Record<issueId,
 * FlowRun>`). This module is the **schema-of-record** the v1 prose drain mirrors
 * and the P5 server (DOR-89) imports verbatim.
 *
 * ## Pure by construction — the fs lives at the seam, never in the package
 *
 * `@dorkos/flow` performs **no** filesystem I/O (see `contributing/flow-engine.md`:
 * "none performs I/O"). This module preserves that: the actual read/write of
 * `flow-state.json` is the **consumer's** job, reached through an injected
 * {@link FlowStateStore} seam — exactly mirroring how `dispatch.ts` injects
 * `classifyOwnership` instead of resolving ownership itself. The pure core is:
 *
 * - {@link parseFlowState} — `fromJSON`: validate raw text → records, fail-soft to
 *   `{}` (never throws), like the Stop-hook sentinel reader.
 * - {@link serializeFlowState} — `toJSON`: records → canonical JSON text.
 * - {@link pruneClosedRuns} — the pure GC/reconcile: given the records + a
 *   ground-truth `isClosed` signal, return which to keep and how many were dropped.
 *
 * The {@link FlowStateStore}-shaped helpers ({@link readFlowState},
 * {@link writeFlowRun}, {@link updateFlowRunStatus}, {@link gcFlowState}) are thin
 * read-mutate-write wrappers over that pure core; the store supplies the bytes.
 * The v1 prose drain (task 3.5) backs the store with `readFileSync`/`writeFileSync`
 * on `.dork/flow/flow-state.json` (resolved relative to the repo root, NOT via
 * `os.homedir()` — the packages rule); the P5 server backs it with the same file
 * then its SQLite mirror (ADR-0043 file-first write-through).
 *
 * @see ./flow-run.ts ({@link FlowRun} — the record schema + the recovery oracle)
 * @see specs/flow-triage-feeds-loop/02-specification.md §6 (the FlowRun record + recovery wiring)
 * @module @dorkos/flow/flow-state
 */

import { z } from 'zod';
import type { FlowRun, FlowRunStatus, FlowStage } from './flow-run.js';

/**
 * The {@link FlowStage} spine as a Zod enum — mirrors the `FlowStage` union in
 * `flow-run.ts` (the in-spine values match the `StagesSchema` keys plus the
 * post-`done` `monitor`/`signal` stages). Kept here, with the rest of the
 * persistence schema, so the on-disk validator lives next to the writer/reader.
 */
const FlowStageSchema: z.ZodType<FlowStage> = z.enum([
  'capture',
  'triage',
  'ideate',
  'specify',
  'decompose',
  'execute',
  'verify',
  'review',
  'done',
  'monitor',
  'signal',
]);

/** The {@link FlowRunStatus} lifecycle as a Zod enum (mirrors `flow-run.ts`). */
const FlowRunStatusSchema: z.ZodType<FlowRunStatus> = z.enum([
  'queued',
  'running',
  'waiting_for_review',
  'complete',
  'failed',
]);

/**
 * The Zod validator for a single {@link FlowRun} record — the on-disk schema the
 * reader validates against. Drift between this and the `FlowRun` interface is
 * caught at compile time: {@link parseFlowState} returns `Record<string, FlowRun>`,
 * so any field this schema omits (or mistypes) fails that assignment to compile.
 */
export const FlowRunSchema = z.object({
  issueId: z.string(),
  identifier: z.string(),
  sessionId: z.string(),
  worktreePath: z.string(),
  branch: z.string(),
  stage: FlowStageSchema,
  status: FlowRunStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  workerPid: z.number().int(),
  heartbeatAt: z.string().optional(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
});

/**
 * The full `flow-state.json` shape — a map of issue id → {@link FlowRun}. Runs are
 * keyed by issue so a re-claim/upsert of the same issue replaces, never
 * duplicates.
 */
export const FlowStateSchema = z.record(z.string(), FlowRunSchema);

/**
 * The injected persistence seam (task 3.1). The package never touches the
 * filesystem; the consumer supplies a store backed by `.dork/flow/flow-state.json`
 * (v1 prose drain) or the server (P5). Synchronous to mirror the Stop-hook
 * sentinel reader; an async consumer can await its own I/O around these helpers.
 */
export interface FlowStateStore {
  /**
   * Read the raw persisted contents, or `undefined` when the backing file is
   * absent. May return malformed text — {@link parseFlowState} fails soft on it.
   */
  read(): string | undefined;
  /** Persist the raw serialized contents, replacing the whole file. */
  write(contents: string): void;
}

/**
 * Parse raw `flow-state.json` text into the typed run map — the `fromJSON` half of
 * the writer/reader. **Fail-soft**: missing, empty, non-JSON, or
 * schema-invalid input reads as `{}` and never throws (the same posture as the
 * Stop-hook sentinel reader). A partially-valid file is rejected wholesale rather
 * than silently dropping fields, so a corrupt store degrades to "no known runs"
 * (the recovery ladder then re-derives from the tracker) instead of acting on
 * half a record.
 *
 * @param raw - The raw file contents, or `undefined`/`null` when absent.
 * @returns The validated run map, or `{}` when the input is absent or malformed.
 */
export function parseFlowState(raw: string | undefined | null): Record<string, FlowRun> {
  if (raw === undefined || raw === null || raw.trim() === '') return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {};
  }
  const parsed = FlowStateSchema.safeParse(json);
  return parsed.success ? parsed.data : {};
}

/**
 * Serialize the run map to canonical `flow-state.json` text — the `toJSON` half of
 * the writer/reader. Two-space indented to stay diff-friendly under the repo's
 * Prettier-formatted JSON convention.
 *
 * @param state - The run map to serialize.
 * @returns The JSON text to persist.
 */
export function serializeFlowState(state: Record<string, FlowRun>): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * The pure **GC / reconcile** function (task 3.1): given the current run map and a
 * ground-truth `isClosed` predicate (does the tracker consider this issue
 * closed/terminal?), return the kept records and the count dropped. No I/O — the
 * caller supplies the closed-signal and persists the result. Keep-or-drop only;
 * open runs are untouched.
 *
 * @param state - The current run map.
 * @param isClosed - Whether the issue behind a given id is closed/terminal on the
 *   tracker (the ground-truth signal — the package does not read the tracker).
 * @returns The kept run map and the number of records removed.
 */
export function pruneClosedRuns(
  state: Record<string, FlowRun>,
  isClosed: (issueId: string) => boolean
): { kept: Record<string, FlowRun>; removed: number } {
  const kept: Record<string, FlowRun> = {};
  let removed = 0;
  for (const [issueId, run] of Object.entries(state)) {
    if (isClosed(issueId)) {
      removed += 1;
    } else {
      kept[issueId] = run;
    }
  }
  return { kept, removed };
}

/**
 * Read the durable run map through an injected {@link FlowStateStore}. **Never
 * throws**: a store read error or malformed contents both degrade to `{}`.
 *
 * @param store - The injected persistence seam (the consumer owns the I/O).
 * @returns The validated run map, or `{}` when absent/unreadable/malformed.
 */
export function readFlowState(store: FlowStateStore): Record<string, FlowRun> {
  let raw: string | undefined;
  try {
    raw = store.read();
  } catch {
    return {};
  }
  return parseFlowState(raw);
}

/**
 * **Upsert** a run record by `issueId` through the store (read → replace → write),
 * file-first write-through (ADR-0043). A second write for the same `issueId`
 * replaces the prior record rather than duplicating it.
 *
 * @param store - The injected persistence seam.
 * @param run - The run record to persist (its `issueId` is the key).
 */
export function writeFlowRun(store: FlowStateStore, run: FlowRun): void {
  const state = readFlowState(store);
  state[run.issueId] = run;
  store.write(serializeFlowState(state));
}

/**
 * Transition a run's {@link FlowRunStatus} (and optionally patch other fields)
 * through the store. A no-op when no record exists for `issueId` (the writer/reader
 * never fabricates a run — the claim step owns creation via {@link writeFlowRun}).
 *
 * @param store - The injected persistence seam.
 * @param issueId - The run's primary key.
 * @param status - The new lifecycle status.
 * @param patch - Optional additional field updates applied with the status (e.g.
 *   `{ stage: 'review', completedAt }`). `issueId` and `status` are governed by
 *   the explicit args and ignored if present here.
 */
export function updateFlowRunStatus(
  store: FlowStateStore,
  issueId: string,
  status: FlowRunStatus,
  patch?: Partial<FlowRun>
): void {
  const state = readFlowState(store);
  const existing = state[issueId];
  if (existing === undefined) return;
  state[issueId] = { ...existing, ...patch, issueId, status };
  store.write(serializeFlowState(state));
}

/**
 * Garbage-collect stale records for closed/terminal issues through the store,
 * persisting only when something was actually dropped. Wraps the pure
 * {@link pruneClosedRuns} with the store's read/write.
 *
 * @param store - The injected persistence seam.
 * @param isClosed - Ground-truth closed/terminal predicate per issue id.
 * @returns The number of records removed.
 */
export function gcFlowState(store: FlowStateStore, isClosed: (issueId: string) => boolean): number {
  const state = readFlowState(store);
  const { kept, removed } = pruneClosedRuns(state, isClosed);
  if (removed > 0) store.write(serializeFlowState(kept));
  return removed;
}
