/**
 * Helpers shared by the `account-usage*.test.ts` suites. Not a `*.test.ts`, so vitest
 * never collects it as a suite.
 *
 * @module account-usage.fixtures
 */
import {
  IMPLICIT_ACCOUNT_ID,
  type LedgerEntry,
  type LedgerObservation,
  type MergeLedgerResult,
  type UsageLedger,
} from '../../account-usage.js';

export const OPENCODE = { runtime: 'opencode', accountId: IMPLICIT_ACCOUNT_ID } as const;

export const NOW = new Date('2026-09-26T12:00:00.000Z');

export const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

export const MIN = 60 * 1000;

export const HOUR = 60 * MIN;

export const DAY = 24 * HOUR;

export function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    usedPct: 40,
    resetsAt: null,
    status: null,
    observedAt: at(-MIN),
    source: 'statusline',
    ...overrides,
  };
}

export function ledger(windows: Record<string, LedgerEntry>, extra: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    runtime: 'claude-code' as const,
    accountId: 'claude3',
    updatedAt: at(-HOUR),
    windows,
    ...extra,
  } satisfies UsageLedger;
}

export const OWNER = { runtime: 'claude-code', accountId: 'claude3' } as const;

export const CODEX = { runtime: 'codex', accountId: IMPLICIT_ACCOUNT_ID } as const;

export const obs = (key: string, overrides: Partial<LedgerEntry> = {}): LedgerObservation => ({
  key,
  ...entry(overrides),
});

/** The ledger a merge wrote, failing the test when it wrote nothing. */
export function written(out: MergeLedgerResult): UsageLedger {
  if (!out.changed) throw new Error('expected the merge to write the ledger');
  return out.ledger;
}

export const identity = {
  accountId: 'claude3',
  path: '/home/u/.claude3',
  label: 'Three',
  color: '#123456',
};

/** A spend fact observed a minute ago; overrides change any field. */
export const spend = (overrides: Record<string, unknown> = {}) => ({
  kind: 'spend' as const,
  periodStart: '2026-09-01T00:00:00.000Z',
  costUsd: 4.2,
  observedAt: at(-MIN),
  source: 'sidecar' as const,
  ...overrides,
});
