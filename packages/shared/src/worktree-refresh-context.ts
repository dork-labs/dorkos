/**
 * What the turn-start refresh did to an agent's copy of a room's files, and
 * what moved on the room's `main` (spec `agent-home-desk` §6). Split out of
 * `additional-context.ts`, which re-exports all of it, to keep that file
 * under the 500-line limit.
 *
 * @module shared/worktree-refresh-context
 */
import { z } from 'zod';

/**
 * One commit that landed on a room's `main` since an agent's copy branched off
 * it (spec `agent-home-desk` §6.2).
 *
 * **Named from the room log, never from git.** `who` is the display name of the
 * member the room entry announcing the commit is about — the agent whose work
 * was merged, or the person who changed a file. A commit no entry announces (a
 * repair, something committed by hand) is `other`, and `who` is `null`: git's
 * author fields are whatever the committer typed, and repeating them to an agent
 * as a member's name would let anyone with a shell impersonate one.
 *
 * `subject` and `files` are member-chosen text, so they render inside the
 * untrusted fence.
 */
export interface MainMovedCommit {
  /** The full sha. */
  sha: string;
  /** The member the room entry names, or `null` when no entry announced it. */
  who: string | null;
  /** The commit's first line. Member-chosen text. */
  subject: string;
  /** An agent's merge, a person's file change, or anything else. */
  kind: 'merge' | 'person' | 'other';
  /** Up to eight files the commit changed on `main`. Member-chosen text. */
  files: string[];
  /** How many files it changed in all, so the rest can be counted. */
  fileCount: number;
}

/** What moved on a room's `main` since an agent's copy branched (spec §6.2). */
export interface MainMoved {
  /** Newest first, `main`'s own first-parent history, at most eight. */
  commits: MainMovedCommit[];
  /** Commits beyond the ones listed, for "and N more". */
  overflow: number;
  /**
   * Files changed on `main` since the branch point that this agent has ALSO
   * changed, committed or not — the ones a `git merge main` may conflict on.
   */
  overlap: string[];
}

/**
 * What the turn-start refresh did to an agent's copy of a room's files (spec
 * `agent-home-desk` §6.1): brought it up to date, found it already there, or
 * left it alone and said why.
 *
 * `busy` and `unsafe-config` carry no `moved`: for `busy` another turn of this
 * agent in this room was running, so not a single git command was made; for
 * `unsafe-config` the room's shared git settings name a program git would run,
 * so the server makes no git call in the room at all until a person removes it.
 */
export type WorktreeRefreshOutcome =
  | { kind: 'current' }
  | { kind: 'refreshed'; from: string; to: string; paths: string[] }
  | {
      kind: 'held';
      reason: 'busy' | 'changes' | 'ahead' | 'off-branch' | 'unreadable' | 'unsafe-config';
      moved: MainMoved | null;
    };

/** Zod schema for {@link MainMoved}. */
export const MainMovedSchema = z.object({
  commits: z.array(
    z.object({
      sha: z.string(),
      who: z.string().nullable(),
      subject: z.string(),
      kind: z.enum(['merge', 'person', 'other']),
      files: z.array(z.string()),
      fileCount: z.number().int().nonnegative(),
    })
  ),
  overflow: z.number().int().nonnegative(),
  overlap: z.array(z.string()),
});

/** Zod schema for {@link WorktreeRefreshOutcome}. */
export const WorktreeRefreshOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('current') }),
  z.object({
    kind: z.literal('refreshed'),
    from: z.string(),
    to: z.string(),
    paths: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('held'),
    reason: z.enum(['busy', 'changes', 'ahead', 'off-branch', 'unreadable', 'unsafe-config']),
    moved: MainMovedSchema.nullable(),
  }),
]);
