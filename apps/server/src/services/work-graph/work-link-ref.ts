/**
 * How a work-graph edge stores each of its ends: one text column per end, in
 * a spelling that round-trips every {@link EntityRef} kind.
 *
 * - A kind with a text form is stored as {@link formatEntityRef} writes it:
 *   `dork:chat:<id>` (and every other DorkOS kind), `DOR-1234` for a ticket,
 *   `owner/repo#42` or `PR #42` for a pull request.
 * - A `branch` or a `worktree` has no self-describing text form (`main` could
 *   be anything), so it is stored as `branch:<name>` or `worktree:<name>`.
 *   Neither prefix can begin any `formatEntityRef` output (a `dork:` URI, an
 *   upper-case ticket key, `PR #`, or a GitHub owner, which never holds `:`),
 *   and git refuses `:` inside a branch name, so the split is unambiguous.
 *
 * Only `kind` and `id` are stored. `label` and `url` are display hints, never
 * identity, and are dropped. A worktree is its folder NAME, never a path
 * (`entityRef` refuses one), so no path reaches the table.
 *
 * @module services/work-graph/work-link-ref
 */
import {
  entityRef,
  formatEntityRef,
  parseEntityRef,
  type EntityRef,
  type TextEntityKind,
} from '@dorkos/shared/entity-ref';

/** The prefix of a stored branch reference. */
export const BRANCH_REF_PREFIX = 'branch:';

/** The prefix of a stored worktree reference. */
export const WORKTREE_REF_PREFIX = 'worktree:';

/**
 * The stored spelling of a reference.
 *
 * The id is checked against its kind's grammar and written in its canonical
 * form, so `OWNER/Repo#42` and `owner/repo#42` store as the same pull request.
 *
 * @param ref - The reference, as built by `entityRef` or read by `parseEntityRef`.
 * @returns The stored text, or `null` when `ref` is not a valid reference.
 */
export function encodeWorkLinkRef(ref: EntityRef): string | null {
  const checked = entityRef(ref.kind, ref.id);
  if (!checked.ok) return null;
  const { kind, id } = checked.value;
  if (kind === 'branch') return `${BRANCH_REF_PREFIX}${id}`;
  if (kind === 'worktree') return `${WORKTREE_REF_PREFIX}${id}`;
  return formatEntityRef({ kind: kind as TextEntityKind, id });
}

/**
 * Read a stored spelling back into the reference it names. Only the exact
 * canonical spelling {@link encodeWorkLinkRef} writes is accepted: anything
 * else is `null`, so a row can never decode to a second spelling of one thing.
 *
 * @param stored - A `from_ref` or `to_ref` value.
 * @returns The reference (`kind` and `id` only), or `null`.
 */
export function decodeWorkLinkRef(stored: string): EntityRef | null {
  const ref = readStored(stored);
  return ref !== null && encodeWorkLinkRef(ref) === stored ? ref : null;
}

/** The reference a stored spelling reads as, before the canonical check. */
function readStored(stored: string): EntityRef | null {
  if (stored.startsWith(BRANCH_REF_PREFIX)) {
    const built = entityRef('branch', stored.slice(BRANCH_REF_PREFIX.length));
    return built.ok ? built.value : null;
  }
  if (stored.startsWith(WORKTREE_REF_PREFIX)) {
    const built = entityRef('worktree', stored.slice(WORKTREE_REF_PREFIX.length));
    return built.ok ? built.value : null;
  }
  const parsed = parseEntityRef(stored);
  return parsed.ok ? { kind: parsed.value.kind, id: parsed.value.id } : null;
}
