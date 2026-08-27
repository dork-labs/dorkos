/**
 * The `ROOM.md` a brand-new room repo starts with (spec `project-rooms` §3.2).
 *
 * A seed, not a schema: the file belongs to the room's members the moment it
 * exists, and nothing in DorkOS reads it back for structure. What the template
 * owes is that a person opening it understands what it is for without being
 * told anywhere else — so it says what the file does, who reads it, and the one
 * rule an agent applies to it, in language a person who does not write code can
 * follow.
 *
 * Turn delivery — composing this into the pinned conventions block that reaches
 * every member agent — is task 1.3's, not this module's. Here it is only what
 * the first commit contains.
 *
 * @module server/services/rooms/repo/room-md
 */

/** The filename, in one place — the seed writes it and the reader will look for it. */
export const ROOM_MD_FILENAME = 'ROOM.md';

/** The subject of the commit that seeds a new room repo. */
export const ROOM_MD_SEED_COMMIT_MESSAGE = 'Start this room’s files';

/**
 * The starting `ROOM.md` for a room.
 *
 * @param room - The room being given files.
 * @param room.title - The room's title, used as the heading.
 * @param room.topic - The room's topic, or `null` when it has none.
 * @returns The file body, newline-terminated.
 */
export function seedRoomMd(room: { title: string; topic: string | null }): string {
  const lines = [`# ${room.title}`, ''];
  if (room.topic) lines.push(room.topic, '');
  lines.push(
    'This room has files of its own, and this is the file that explains them.',
    '',
    '## How this room works',
    '',
    'Everyone here shares these notes — the people and the agents both. Your',
    'agents read this file before they start work, so keep it short and keep it',
    'true. Anything you would otherwise have to explain twice belongs here:',
    '',
    '- what this room is working on',
    '- how work gets done here, and what to check before calling it done',
    '- anything to leave alone',
    '',
    'These notes are added to what each agent already knows, never a replacement',
    'for it. If something here clashes with an agent’s own instructions, it',
    'follows its own and tells you why.',
    ''
  );
  return lines.join('\n');
}
