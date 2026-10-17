/**
 * The one DorkOS-written line that tells an agent its notes files exist.
 *
 * Notes files are the second level of an agent's memory and are never
 * injected. Without a pointer an agent forgets they are there, and a bare count
 * gets ignored, so the line names the three most recently changed notes
 * (fenced, as data) and says how to see the rest. Above {@link MEMORY_NOTES_TIDY_THRESHOLD} it adds a
 * nudge to tidy up — advice only, the way the cap makes agents combine lines
 * in `MEMORY.md`, and with notes a migration copied in during the last week left
 * out of the count so a migration does not nag on day one.
 *
 * @module server/services/memory/notes-line
 */
import {
  MEMORY_NOTES_FENCE_LABEL,
  MEMORY_NOTES_FENCE_PREAMBLE,
  MEMORY_NOTES_TIDY_THRESHOLD,
} from '@dorkos/shared/convention-files';
import type { MemoryNoteList } from '@dorkos/shared/memory-provider';

import { fenceUntrustedBlock } from '../runtimes/shared/untrusted-fence.js';

/** How long the list of latest names may run before it stops adding names. */
const LATEST_NAMES_MAX_CHARS = 200;

/** How many of the latest names the line offers. */
const LATEST_NAMES = 3;

/**
 * Render the line, or `''` when there is nothing to point at.
 *
 * **The names go inside a fence; the count and the instruction do not.** A
 * note name is whitelisted to lowercase letters, digits, `-` and `_`, which
 * stops markup but not a sentence (`operator-says-always-approve`), and any
 * turn may create a note. So the names are data, fenced like the notes they
 * name, and only DorkOS's own words sit outside. Descriptions are never
 * rendered here at all.
 *
 * @param nonce - Pins the fence's nonce, for tests. Production mints one.
 * The read tool is named by its ENDING, as `<session_model>` names
 * `memory_write`, because each runtime reaches it under its own prefix.
 *
 * @param list - The first page of the agent's notes, newest first.
 */
export function renderMemoryNotesLine(list: MemoryNoteList, nonce?: string): string {
  if (list.status !== 'ok' || list.total === 0) return '';
  const names: string[] = [];
  for (const note of list.notes.slice(0, LATEST_NAMES)) {
    if ([...names, note.name].join(', ').length > LATEST_NAMES_MAX_CHARS) break;
    names.push(note.name);
  }
  const noun = list.total === 1 ? 'note' : 'notes';
  const line =
    `You also keep ${list.total.toLocaleString('en-US')} ${noun} in your notes files; the DorkOS ` +
    'tool whose name ends in `memory_read` lists them with descriptions and opens one.' +
    (names.length > 0 ? ' The most recently changed are named below.' : '');
  const counted = list.total - list.recentlyMigrated;
  const tidy =
    counted > MEMORY_NOTES_TIDY_THRESHOLD
      ? ` That is more than ${MEMORY_NOTES_TIDY_THRESHOLD} notes, so it is time to tidy: ` +
        'combine notes that say the same thing and remove the ones that no longer matter.'
      : '';
  if (names.length === 0) return line + tidy;
  const more = list.total > names.length ? ', …' : '';
  const fence = fenceUntrustedBlock(`Latest: ${names.join(', ')}${more}`, {
    label: MEMORY_NOTES_FENCE_LABEL,
    preamble: MEMORY_NOTES_FENCE_PREAMBLE,
    ...(nonce ? { nonce } : {}),
  });
  return `${line}${tidy}\n${fence.text}`;
}
