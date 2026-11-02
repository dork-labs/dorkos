/**
 * The power a commitment or to-do carries (DOR-3088, Security's musts 1 and 3): who may have
 * shaped its words, read from the row's `authority` and `authority_marks` columns.
 *
 * Both columns are NOT NULL, and reading them fails closed: a value this module cannot read is
 * never taken as permission. An authority it does not recognise reads as `runtime-default` (the
 * stranger's bound), and marks it cannot read carry the outsider mark (`parseStoredMarks`).
 *
 * `legacy` is only ever READ. The migration wrote it on rows from before to-dos, and both a
 * trigger in the database and {@link writeAuthority} refuse it on every later write.
 *
 * @module services/commitments/commitment-authority
 */
import type {
  PermissionAsks,
  PermissionReach,
  TurnPermissionLevel,
} from '@dorkos/shared/agent-runtime';
import { hasMarks, parseStoredMarks, type TurnMarks } from '../core/turn-power/turn-marks.js';

/** What a row's `authority` column says. */
export type CommitmentAuthority =
  /** A row from before to-dos: an agent's own promise, in its own words. Read only. */
  | { readonly kind: 'legacy' }
  /** An agent's own promise, made by that agent for itself. */
  | { readonly kind: 'self' }
  /** Made, and only ever changed, by the person who owns this DorkOS. */
  | { readonly kind: 'person' }
  /** An outsider touched it, or nobody could vouch for who did: the stranger's bound. */
  | { readonly kind: 'runtime-default' }
  /** The lowest level of every turn that made or changed it. Marks are kept apart. */
  | {
      readonly kind: 'level';
      readonly level: Pick<TurnPermissionLevel, 'asks' | 'reach' | 'auto'>;
    };

/** What a new write may carry: anything but `legacy`. */
export type WritableCommitmentAuthority = Exclude<CommitmentAuthority, { kind: 'legacy' }>;

/** The fail-closed reading of an authority nobody can read. */
export const UNREADABLE_AUTHORITY: CommitmentAuthority = Object.freeze({ kind: 'runtime-default' });

/** The fail-closed reading of marks nobody can read: the outsider mark, as `parseStoredMarks`. */
const UNREADABLE_MARKS: TurnMarks = Object.freeze({ outsider: true });

const ASKS: readonly PermissionAsks[] = ['always', 'when-risky', 'never'];
const REACH: readonly PermissionReach[] = ['read', 'edit', 'workspace', 'everything'];
const NAMED = new Set(['legacy', 'self', 'person', 'runtime-default']);

/**
 * Read a row's `authority` column. Anything unrecognised reads as `runtime-default`.
 *
 * @param stored - The column's value.
 */
export function readAuthority(stored: string | null | undefined): CommitmentAuthority {
  if (typeof stored !== 'string') return UNREADABLE_AUTHORITY;
  if (NAMED.has(stored)) return { kind: stored } as CommitmentAuthority;
  try {
    const value = JSON.parse(stored) as { asks?: unknown; reach?: unknown; auto?: unknown };
    if (
      typeof value !== 'object' ||
      value === null ||
      !ASKS.includes(value.asks as PermissionAsks) ||
      !REACH.includes(value.reach as PermissionReach)
    ) {
      return UNREADABLE_AUTHORITY;
    }
    return {
      kind: 'level',
      level: {
        asks: value.asks as PermissionAsks,
        reach: value.reach as PermissionReach,
        ...(value.auto === true ? { auto: true as const } : {}),
      },
    };
  } catch {
    return UNREADABLE_AUTHORITY;
  }
}

/**
 * The column value for an authority. `legacy` is refused: no new write may claim it.
 *
 * @param authority - What the row should carry.
 * @throws When asked to write `legacy`.
 */
export function writeAuthority(authority: WritableCommitmentAuthority): string {
  if ((authority as CommitmentAuthority).kind === 'legacy') {
    throw new Error('legacy authority is only for rows from before to-dos');
  }
  if (authority.kind !== 'level') return authority.kind;
  const { asks, reach, auto } = authority.level;
  return JSON.stringify({ asks, reach, ...(auto === true ? { auto: true } : {}) });
}

/**
 * Read a row's `authority_marks` column. Marks that cannot be read are the outsider mark.
 *
 * @param stored - The column's value.
 */
export function readAuthorityMarks(stored: string | null | undefined): TurnMarks {
  // NOT NULL in the table, so a missing value is a value nobody can vouch for.
  if (stored === null || stored === undefined || stored === '') return UNREADABLE_MARKS;
  return parseStoredMarks(stored);
}

/**
 * The column value for a set of marks: `{}` when there are none.
 *
 * @param marks - The marks.
 */
export function writeAuthorityMarks(marks: TurnMarks): string {
  return hasMarks(marks) ? JSON.stringify(marks) : '{}';
}
