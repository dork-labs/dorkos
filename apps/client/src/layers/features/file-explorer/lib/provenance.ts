/**
 * "Who last touched this, and when" — the one line the provenance column draws
 * (spec `project-rooms` §3.9).
 *
 * @module features/file-explorer/lib/provenance
 */
import { formatRelativeTime } from '@/layers/shared/lib';
import type { ExplorerCommit } from '../model/source';

/**
 * What a listing says when nobody is known to have touched a path.
 *
 * An em-dash rather than "unknown", because the source is not confused: it
 * looked, inside a bounded walk of the room's history, and found nothing. A
 * dash reads as "nothing to say here", which is true. "Unknown" reads as a
 * failure, which it is not, and it is also longer than the answer deserves.
 */
export const NO_PROVENANCE = '—';

/** One path's provenance, ready to render. */
export interface ProvenanceLine {
  /** The short line the column shows. */
  label: string;
  /** The fuller sentence behind it, or `null` when the label is the whole story. */
  title: string | null;
}

/**
 * Turn a commit into the column's line.
 *
 * The label is deliberately short — a name and a relative time — because the
 * column lives in a narrow pane beside the filename, which is what a person
 * came to read. The commit's subject is the interesting part but the long part,
 * so it goes in the title where hovering finds it.
 *
 * @param lastCommit - The last commit that touched the path, or `null`/absent
 *   when the source looked and found nothing.
 */
export function provenanceLine(lastCommit: ExplorerCommit | null | undefined): ProvenanceLine {
  if (lastCommit === null || lastCommit === undefined) {
    return { label: NO_PROVENANCE, title: null };
  }
  const when = formatRelativeTime(lastCommit.at);
  return {
    label: `${lastCommit.author} · ${when}`,
    // Everything in here is member-written, and it is rendered as a title
    // attribute — text the browser draws as text, never as markup.
    title: `${lastCommit.subject} · ${lastCommit.author}, ${when}`,
  };
}
