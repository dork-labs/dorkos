/**
 * How a stored run row becomes a {@link TurnRun} and a {@link RunPatch}
 * becomes columns: the run store's row mapping, kept beside it so the store
 * itself stays about the record's rules (spec `turns-survive-restarts` §4.2:
 * the store answers in the port's types, never in Drizzle rows).
 *
 * @module services/runs/run-rows
 */
import type { TurnRunRow } from '@dorkos/db';
import { TurnOriginSchema, type TurnOrigin } from '@dorkos/shared/turn-port';
import type { RunEndingDetail, RunPatch, TurnRun } from './run-store.js';

/**
 * Whether an error is SQLite refusing a unique index, through any wrapper
 * Drizzle adds around it.
 *
 * @param error - What was thrown.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/.test(e.message)) {
      return true;
    }
  }
  return false;
}

/** Read a stored origin, degrading an unreadable one to "not recorded". */
function parseOrigin(json: string | null): TurnOrigin | null {
  if (json === null) return null;
  try {
    const parsed = TurnOriginSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Read a stored `ending_detail`, degrading an unreadable one to empty. */
function parseDetail(json: string | null): RunEndingDetail {
  if (json === null) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' ? (parsed as RunEndingDetail) : {};
  } catch {
    return {};
  }
}

/** Read stored launch warnings, degrading an unreadable value to none. */
function parseWarnings(json: string | null): TurnRun['warnings'] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as TurnRun['warnings']) : [];
  } catch {
    return [];
  }
}

/**
 * A stored row as the store answers it.
 *
 * @param row - The row.
 */
export function toRun(row: TurnRunRow): TurnRun {
  return {
    id: row.id,
    sessionId: row.sessionId,
    chatSeq: row.chatSeq,
    chainId: row.chainId,
    agentId: row.agentId,
    origin: parseOrigin(row.originJson),
    openedBy: row.openedBy,
    status: row.status,
    waitReason: row.waitReason,
    attempt: row.attempt,
    attemptReason: row.attemptReason,
    queueMessageId: row.queueMessageId,
    sourceRef: row.sourceRef,
    notAfter: row.notAfter,
    warnings: parseWarnings(row.warningsJson),
    runtime: row.runtime,
    runtimeTurnRef: row.runtimeTurnRef,
    turnBindingId: row.turnBindingId,
    ownerEpoch: row.ownerEpoch,
    leaseUntil: row.leaseUntil,
    waitingOnPerson: row.waitingOnPerson,
    ending: row.ending,
    endingDetail: parseDetail(row.endingDetail),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    deliveredAt: row.deliveredAt,
    endedAt: row.endedAt,
    recoveryDecidedAt: row.recoveryDecidedAt,
    settledAt: row.settledAt,
  };
}

/**
 * The column values a {@link RunPatch} writes.
 *
 * @param patch - The patch.
 */
export function patchColumns(patch: RunPatch): Partial<TurnRunRow> {
  const { endingDetail, ...rest } = patch;
  return {
    ...rest,
    ...(endingDetail !== undefined
      ? { endingDetail: Object.keys(endingDetail).length > 0 ? JSON.stringify(endingDetail) : null }
      : {}),
  };
}
