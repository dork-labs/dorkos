/**
 * What a pull request's row says: how the chats came to it, the day, and where
 * it lives on GitHub.
 *
 * @module entities/work-graph/lib/work-item-words
 */
import type { WorkItem, WorkItemLink } from '@dorkos/shared/work-graph-reads';

/** The words for each relation a chat has to a piece of work. */
const RELATION_WORDS: Record<string, string> = {
  opened: 'Opened',
  works_on: 'Works on',
  claims: 'Claimed',
  produced: 'Made',
  started: 'Started',
};

/**
 * One relation in words. One this build has no words for is spelled out from
 * its stored name, so a newer server's relation still reads.
 *
 * @param relation - The relation, as the work graph stores it.
 */
export function relationWords(relation: string): string {
  const known = RELATION_WORDS[relation];
  if (known !== undefined) return known;
  const spaced = relation.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Each distinct relation an item's links carry, in words, oldest link first.
 *
 * @param links - The item's links.
 */
export function itemRelations(links: readonly WorkItemLink[]): string[] {
  return [...new Set(links.map((link) => relationWords(link.relation)))];
}

/**
 * Whether every link to an item comes from a chat below `chatId`, not from it.
 *
 * @param item - The item.
 * @param chatId - The chat the list is about.
 */
export function fromSpinOffsOnly(item: WorkItem, chatId: string): boolean {
  return item.links.length > 0 && item.links.every((link) => link.chatId !== chatId);
}

/**
 * A `YYYY-MM-DD` day, short: `Nov 24`, with the year when it is not this one.
 * Read as a calendar day, never as midnight UTC, so it cannot slip a day west.
 *
 * @param day - The day.
 * @param now - The moment "this year" is read from.
 */
export function dayWords(day: string, now: Date = new Date()): string {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) return day;
  const when = new Date(year, month - 1, date);
  return when.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(year === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/**
 * The pull request's page on GitHub, or null when its id names no repository
 * (`#42`), so there is no page to point at.
 *
 * @param id - The pull request's id: `owner/repo#42` or `#42`.
 */
export function pullRequestUrl(id: string): string | null {
  const hash = id.lastIndexOf('#');
  if (hash <= 0) return null;
  const repoPath = id.slice(0, hash);
  const number = id.slice(hash + 1);
  if (!/^[1-9][0-9]*$/.test(number) || repoPath.split('/').length !== 2) return null;
  return `https://github.com/${repoPath}/pull/${number}`;
}
