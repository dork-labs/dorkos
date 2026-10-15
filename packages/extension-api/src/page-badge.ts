/**
 * An extension page's own tab badge (DOR-2820): the status, count and sentence
 * `api.setPageBadge` puts on a tab showing one of the extension's pages, and
 * the one check the host runs on it.
 *
 * @module @dorkos/extension-api/page-badge
 */

/**
 * The statuses a tab can show, hottest first. The host draws them exactly as
 * it draws its own pages' statuses; an extension cannot style them.
 */
export const PAGE_BADGE_STATUSES = ['needs-you', 'failed', 'paused', 'working', 'new'] as const;

/** One of {@link PAGE_BADGE_STATUSES}. */
export type PageBadgeStatus = (typeof PAGE_BADGE_STATUSES)[number];

/** The longest sentence a badge may carry, in characters. */
export const PAGE_BADGE_SENTENCE_MAX = 80;

/** What an extension page reports for its own tab. Every field is optional. */
export interface ExtensionPageBadge {
  /** The tab's status dot, and the word a screen reader hears. */
  status?: PageBadgeStatus;
  /** A count drawn on the tab, a non-negative integer. Zero draws nothing. */
  count?: number;
  /** One plain sentence for the tab's hover card, at most 80 characters. */
  sentence?: string;
}

/**
 * Why a badge cannot be shown, in plain words, or `null` when it can. An
 * untyped extension can hand anything to `setPageBadge`, so the host checks
 * every field rather than trusting the type.
 *
 * @param badge - What the extension passed.
 */
export function pageBadgeProblem(badge: unknown): string | null {
  if (typeof badge !== 'object' || badge === null || Array.isArray(badge)) {
    return 'a badge is an object, or null to clear it';
  }
  const { status, count, sentence } = badge as Record<string, unknown>;
  if (status !== undefined && !PAGE_BADGE_STATUSES.includes(status as PageBadgeStatus)) {
    return `status must be one of ${PAGE_BADGE_STATUSES.join(', ')}`;
  }
  if (count !== undefined && !(Number.isInteger(count) && (count as number) >= 0)) {
    return 'count must be a whole number, 0 or more';
  }
  if (sentence !== undefined) {
    if (typeof sentence !== 'string') return 'sentence must be a string';
    if (sentence.trim().length > PAGE_BADGE_SENTENCE_MAX) {
      return `sentence must be at most ${PAGE_BADGE_SENTENCE_MAX} characters`;
    }
  }
  return null;
}

/**
 * A checked badge's own copy, with the sentence trimmed and empty fields
 * dropped. The host keeps this, never the extension's object.
 *
 * @param badge - A badge {@link pageBadgeProblem} accepted.
 */
export function copyPageBadge(badge: ExtensionPageBadge): ExtensionPageBadge {
  const sentence = badge.sentence?.trim();
  return {
    ...(badge.status !== undefined && { status: badge.status }),
    ...(badge.count !== undefined && { count: badge.count }),
    ...(sentence && { sentence }),
  };
}
