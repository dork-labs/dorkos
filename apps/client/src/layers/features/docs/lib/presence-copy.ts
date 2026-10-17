/**
 * The quiet lines a live doc shows about who else is here (DOR-2984).
 *
 * @module features/docs/lib/presence-copy
 */
import type { DocWriter } from '@dorkos/shared/doc-collab';

/**
 * Who else has the doc open, or `null` when nobody does.
 *
 * @param names - The other people here, in the order they joined.
 */
export function presenceLine(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is here`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are here`;
  return `${names[0]} and ${names.length - 1} others are here`;
}

/**
 * Who just changed the doc from outside this editor.
 *
 * @param writer - Who changed it.
 */
export function changeLine(writer: DocWriter): string {
  if (writer.kind === 'disk') return 'Updated from the file on disk';
  if (writer.kind === 'person') return 'A previous version was restored';
  return `${writer.name ?? 'An agent'} changed this doc`;
}
