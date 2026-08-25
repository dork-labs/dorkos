/**
 * The starting content of a new `MEMORY.md`.
 *
 * @module memory/scaffold
 */
import { MEMORY_MAX_CHARS } from './constants.js';

/** Heading the engine appends new notes under. */
export const MEMORY_NOTES_HEADING = '## Notes';

/**
 * The file a brand-new agent starts with: a plain-language header the operator
 * can read, and an empty notes section.
 *
 * The header is a markdown comment, so it stays out of the way when the file is
 * rendered, and it says the four things somebody opening this file needs to
 * know:
 *
 * 1. **What it is** — the agent's own notes, carried between conversations.
 * 2. **The cap** — how big it may get, and what happens when it fills up.
 * 3. **The provenance convention** — every saved note ends with where it was
 *    learned, added automatically.
 * 4. **The visibility rule**, verbatim from the specification (D2). This is the
 *    one paragraph that must never be softened or paraphrased away: it is the
 *    only warning an operator gets before writing something into a file that can
 *    surface in a room full of other people.
 *
 * It is written for a person, not for a model — the agent's instruction to save
 * what it learns lives in the session-model block, which is present on every
 * turn whether or not this file exists.
 */
export function defaultMemoryTemplate(): string {
  return [
    '<!--',
    "This is your agent's memory: short notes it keeps between conversations.",
    'It reads them at the start of every conversation it joins, and adds to them',
    'as it learns things worth keeping.',
    '',
    'You can edit this file by hand. Change a line to correct it. Delete a line',
    'to forget it.',
    '',
    'Each note the agent saves ends with where it learned it, like',
    '"(noted in #general, 2026-01-31)". The agent does not choose that part — it',
    'is added automatically — so a note always says where it came from.',
    '',
    `This file holds up to ${MEMORY_MAX_CHARS} characters. When it fills up, the agent is`,
    'asked to tidy it up — combine notes that say the same thing, drop the ones',
    'that no longer matter — rather than being allowed to grow it.',
    '',
    'Anything in this file can come up in ANY conversation this agent joins,',
    'including group channels and bridged rooms with other people in them. Never',
    'store secrets, credentials, or anything you would not say in a shared room.',
    '-->',
    '',
    MEMORY_NOTES_HEADING,
    '',
  ].join('\n');
}
