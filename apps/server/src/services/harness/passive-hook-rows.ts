/**
 * The quiet Needs-you rows for packages Full held back (DOR-3427), remembered
 * across a restart so a yes given after one is not lost.
 *
 * ## Why a file beside the approval
 *
 * A passive row's yes is acted on by the in-process wait that raised it
 * (`askForHookProjection`): it spends the token, records the approval, and
 * projects again. A restart ends that wait while the ticket itself survives, so
 * a person could answer it, see `granted`, and have nothing happen. The ticket
 * stores a hash of the request, never the request, so the wait cannot be rebuilt
 * from it. This file keeps the request (commands and the file pins the row was
 * raised for), one per package per project, and `resumePassiveHookRows`
 * (`ask-withheld-hooks.ts`) rebuilds the wait from it at startup.
 *
 * ## What it cannot change
 *
 * - **A yes records only what its ticket was raised for.** The rebuilt wait
 *   binds to the stored request, so it can only pick up a ticket whose input
 *   hash is that request's; a yes for older files records those older pins and
 *   the package stays withheld, as before a restart.
 * - **Only a person's grant counts.** The rebuilt wait spends the ticket's token
 *   the same way the first one did, and a ticket is granted only through the
 *   person-only route. This file grants nothing; a row whose ticket is gone is
 *   dropped, not raised again.
 * - **A no still wins**, because a refused package is never asked about.
 *
 * @module services/harness/passive-hook-rows
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../../lib/logger.js';
import { hookApprovalEntry, type HookProjectionRequest } from './hook-consent.js';

/** Where the rows live, under the DorkOS data directory. */
export function passiveHookRowsPath(dorkHome: string): string {
  return join(dorkHome, 'harness', 'passive-hook-rows.json');
}

/** One package in one project: the key a row is stored under. */
function rowKey(request: HookProjectionRequest): string {
  return `${request.projectPath}\0${request.packageName}`;
}

/** Whether a parsed value is one hook: a string event and command, and a string matcher if any. */
function isStoredHook(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const hook = value as Record<string, unknown>;
  return (
    typeof hook.event === 'string' &&
    typeof hook.command === 'string' &&
    (hook.matcher === undefined || typeof hook.matcher === 'string')
  );
}

/** Whether a parsed value is one file pin: a path and a hash, both strings. */
function isStoredPin(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string'
  );
}

/**
 * Whether a parsed value has the shape of a stored request, down to each hook
 * and pin. The file is read at startup, so anything a digest would choke on is
 * dropped here rather than reaching it.
 */
function isStoredRequest(value: unknown): value is HookProjectionRequest {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.projectPath === 'string' &&
    typeof row.packageName === 'string' &&
    Array.isArray(row.hooks) &&
    row.hooks.every(isStoredHook) &&
    (row.scripts === undefined || (Array.isArray(row.scripts) && row.scripts.every(isStoredPin)))
  );
}

/**
 * The stored rows. A missing or unreadable file is no rows: the worst it costs
 * is a yes that waits for the next sync, which is what happened before this file.
 *
 * @param dorkHome - The DorkOS data directory.
 * @returns The stored requests, one per package per project.
 */
export function readPassiveHookRows(dorkHome: string): HookProjectionRequest[] {
  let raw: string;
  try {
    raw = readFileSync(passiveHookRowsPath(dorkHome), 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isStoredRequest) : [];
  } catch (err) {
    logger.warn('[HarnessSync] The saved quiet rows could not be read; ignoring them', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Replace the file in one rename, so a crash never leaves half a list. */
function writeRows(dorkHome: string, rows: readonly HookProjectionRequest[]): void {
  const file = passiveHookRowsPath(dorkHome);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

/**
 * Remember the row raised for this request, replacing any older one for the
 * same package in the same project (DOR-3433: one row per package).
 *
 * @param dorkHome - The DorkOS data directory.
 * @param request - The exact request the row's ticket was raised for.
 */
export function rememberPassiveHookRow(dorkHome: string, request: HookProjectionRequest): void {
  const key = rowKey(request);
  const rows = readPassiveHookRows(dorkHome).filter((row) => rowKey(row) !== key);
  writeRows(dorkHome, [...rows, request]);
}

/**
 * Forget the row for exactly this request. A newer row for the same package,
 * raised while this one's wait was ending, is left alone.
 *
 * @param dorkHome - The DorkOS data directory.
 * @param request - The request whose wait has ended.
 */
export function forgetPassiveHookRow(dorkHome: string, request: HookProjectionRequest): void {
  const entry = hookApprovalEntry(request);
  const rows = readPassiveHookRows(dorkHome);
  const kept = rows.filter(
    (row) => rowKey(row) !== rowKey(request) || hookApprovalEntry(row) !== entry
  );
  if (kept.length !== rows.length) writeRows(dorkHome, kept);
}

/**
 * Drop the saved row for this package in this project, whatever it holds. For a
 * row that could not be picked up: it is matched by package and project alone,
 * so nothing about it has to be digestible.
 *
 * @param dorkHome - The DorkOS data directory.
 * @param request - The row to drop.
 */
export function dropPassiveHookRow(dorkHome: string, request: HookProjectionRequest): void {
  const rows = readPassiveHookRows(dorkHome);
  const kept = rows.filter((row) => rowKey(row) !== rowKey(request));
  if (kept.length !== rows.length) writeRows(dorkHome, kept);
}
