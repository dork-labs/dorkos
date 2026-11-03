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
import { stricterLevel } from '@dorkos/shared/permission-semantics';
import {
  hasMarks,
  mergeMarks,
  NO_MARKS,
  parseStoredMarks,
  type TurnMarks,
} from '../core/turn-power/turn-marks.js';

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

/** The outsider mark alone. */
const OUTSIDER: TurnMarks = Object.freeze({ outsider: true });

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

/**
 * How much each kind of authority lets its words do, highest first. `self` and `legacy` are an
 * agent's own words at its own level; a recorded `level` is a ceiling below that; `runtime-default`
 * is the stranger's bound.
 */
const RANK: Record<CommitmentAuthority['kind'], number> = {
  person: 3,
  self: 2,
  legacy: 2,
  level: 1,
  'runtime-default': 0,
};

/**
 * The lower of two authorities (Security's Must 3): what a row carries once both actors have
 * touched it. Two recorded levels meet at the stricter of the two. Never returns `legacy` unless
 * both sides are `legacy`, so a change to an old row stops it being one.
 *
 * @param a - One authority.
 * @param b - The other.
 */
export function lowerAuthority(
  a: CommitmentAuthority,
  b: CommitmentAuthority
): CommitmentAuthority {
  // `legacy` survives only a meeting of two legacy sides; anything else touching an old row makes
  // it a new write, which counts as the agent's own words (`self`) at most.
  if (a.kind === 'legacy' && b.kind === 'legacy') return a;
  const x: CommitmentAuthority = a.kind === 'legacy' ? { kind: 'self' } : a;
  const y: CommitmentAuthority = b.kind === 'legacy' ? { kind: 'self' } : b;
  if (x.kind === 'level' && y.kind === 'level') {
    const { asks, reach, auto } = stricterLevel(x.level, y.level);
    return { kind: 'level', level: { asks, reach, ...(auto === true ? { auto } : {}) } };
  }
  return RANK[x.kind] <= RANK[y.kind] ? x : y;
}

/**
 * The authority of an agent's own words, made in a turn at `level` (Security's Must 1): its own
 * standing (`self`), held to that turn's level when it ran under one.
 *
 * @param level - The turn's level, when known.
 */
export function ownWordsAuthority(
  level: Pick<TurnPermissionLevel, 'asks' | 'reach' | 'auto'> | undefined
): WritableCommitmentAuthority {
  const own: WritableCommitmentAuthority = { kind: 'self' };
  return level
    ? (lowerAuthority(own, { kind: 'level', level }) as WritableCommitmentAuthority)
    : own;
}

/**
 * The marks an agent's words carry (Security, #3454): its turn's own marks, plus the outsider mark
 * when that turn's level is unknown. A level DorkOS cannot read vouches for nothing, so the words
 * keep their standing but say so; a known, clean level adds nothing.
 *
 * @param level - The turn's level, when known.
 * @param marks - The turn's marks.
 */
export function agentWordsMarks(
  level: Pick<TurnPermissionLevel, 'asks' | 'reach' | 'auto'> | undefined,
  marks: TurnMarks
): TurnMarks {
  return level ? marks : mergeMarks(marks, OUTSIDER);
}

/** Who is acting on a to-do, as the server established it. Never read from a request body. */
export type TodoActor =
  /**
   * The person who owns this DorkOS, through the app. `proven` only for a request that carries the
   * owner's own session cookie (`personProof`); anything less writes no `person` authority.
   */
  | { readonly kind: 'person'; readonly proven: boolean }
  /**
   * An agent, by the Mesh id `callerAgentId` resolved, with the level and marks of the turn it is
   * acting from. An unknown level (a restart, a caller with no recorded turn) is the stranger bound.
   */
  | {
      readonly kind: 'agent';
      readonly agentId: string;
      readonly level: Pick<TurnPermissionLevel, 'asks' | 'reach' | 'auto'> | undefined;
      readonly marks: TurnMarks;
    }
  /** Somebody outside the owner's circle: a guest in a shared space, a bridged chat's user. */
  | { readonly kind: 'outsider'; readonly id: string };

/**
 * The authority and marks an actor's own words carry. A guest, a bridged user, and a person who
 * did not prove it get the stranger bound and the outsider mark, on every runtime.
 *
 * @param actor - Who is acting.
 */
export function authorityOf(actor: TodoActor): {
  authority: WritableCommitmentAuthority;
  marks: TurnMarks;
} {
  switch (actor.kind) {
    case 'person':
      return actor.proven
        ? { authority: { kind: 'person' }, marks: NO_MARKS }
        : { authority: { kind: 'runtime-default' }, marks: OUTSIDER };
    case 'agent':
      return actor.level
        ? { authority: { kind: 'level', level: actor.level }, marks: actor.marks }
        : {
            authority: { kind: 'runtime-default' },
            marks: agentWordsMarks(undefined, actor.marks),
          };
    case 'outsider':
      return { authority: { kind: 'runtime-default' }, marks: OUTSIDER };
  }
}

/**
 * A row's authority and marks after an actor touches it: the lower authority, every mark of both.
 *
 * @param stored - The row's `authority` and `authority_marks` columns.
 * @param actor - Who is changing it.
 * @returns The two column values to write.
 */
export function floorAfter(
  stored: { authority: string; authorityMarks: string },
  actor: TodoActor
): { authority: string; authorityMarks: string } {
  const own = authorityOf(actor);
  const lowered = lowerAuthority(readAuthority(stored.authority), own.authority);
  return {
    // `lowerAuthority` returns legacy only when both sides are, and an actor's never is.
    authority: writeAuthority(lowered as WritableCommitmentAuthority),
    authorityMarks: writeAuthorityMarks(
      mergeMarks(readAuthorityMarks(stored.authorityMarks), own.marks)
    ),
  };
}
