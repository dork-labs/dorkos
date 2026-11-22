/**
 * How a Claude Code transcript's conversation opens, for the chat's title.
 *
 * A new agent's first chat opens with DorkOS's greeting kickoff, a fenced
 * `user` record (`@dorkos/shared/kickoff`). Its line is often longer than the
 * transcript head the list reads, so the person's own first message can sit
 * past it. When the head shows a kickoff but no person message, a bounded
 * forward scan finds out which (DOR-4976): a chat the person has not written
 * in yet shows the untitled label, never the tag and never a model title made
 * from the greeting.
 *
 * Cost: the scan reruns whenever such a chat's metadata is re-read (its file
 * changed), capped at {@link OPENING_SCAN_BYTES} and stopping at the person's
 * first message, so it stays small; ordinary chats never take it.
 *
 * @module services/runtimes/claude-code/sessions/transcripts/opening-turn
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { KICKOFF_TAG, isKickoffEnvelope, shownToPerson } from '@dorkos/shared/kickoff';
import { extractTextContent, stripSystemTags, type TranscriptLine } from '../transcript-parser.js';

/** How far the opening scan reads before it gives up: enough for a kickoff turn's setup records. */
const OPENING_SCAN_BYTES = 512 * 1024;

/** Records DorkOS or the CLI wrote into the user role, never the person's words. */
const NOT_THE_PERSON = [
  '<local-command',
  '<command-name>',
  '<command-message>',
  '<task-notification>',
  '<dorkos-system-note>',
  '<relay_context>',
  'This session is being continued',
];

/**
 * The text of a `user` record a person may see as the chat's title, or `''`
 * for a record they did not write: CLI echoes, DorkOS notes, relay context, a
 * resumed session's summary, or a greeting kickoff.
 *
 * @param text - A `user` record's text content.
 */
export function personTitleText(text: string): string {
  if (NOT_THE_PERSON.some((prefix) => text.startsWith(prefix))) return '';
  return shownToPerson(stripSystemTags(text).trim());
}

/** How a transcript opens: whether a greeting kickoff came first, and the person's first words. */
export interface OpeningTurn {
  /** The first `user` record is a greeting kickoff. */
  kickoff: boolean;
  /** The person's first message, or `''` when none was found. */
  personFirst: string;
}

/**
 * Whether the head alone cannot say how the chat opens, so {@link readOpeningTurn}
 * must look further. True when the head found no person message and either
 * mentions the kickoff tag (its line was cut off) or held no whole `user`
 * record at all (the turn's context blocks, which come before the words, ran
 * past it). An ordinary chat, a room turn or an agent's own chat has a `user`
 * record in the head and never pays for the scan.
 *
 * @param head - The raw head the list already read.
 * @param headFirstUser - The first `user` record's text the head parsed, or `''`.
 * @param fileSize - The transcript's size in bytes.
 */
export function needsOpeningScan(head: string, headFirstUser: string, fileSize: number): boolean {
  return (
    head.includes(`<${KICKOFF_TAG}>`) || (!headFirstUser && fileSize > Buffer.byteLength(head))
  );
}

/**
 * Scan a transcript from the start, up to {@link OPENING_SCAN_BYTES}, for how
 * it opens. Stops at the person's first message.
 *
 * @param filePath - The transcript to read.
 */
export async function readOpeningTurn(filePath: string): Promise<OpeningTurn> {
  const opening: OpeningTurn = { kickoff: false, personFirst: '' };
  let sawUser = false;
  const stream = createReadStream(filePath, { encoding: 'utf-8', end: OPENING_SCAN_BYTES - 1 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let parsed: TranscriptLine;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.type !== 'user' || !parsed.message || parsed.isSidechain) continue;
      const text = extractTextContent(parsed.message.content);
      if (!sawUser) opening.kickoff = isKickoffEnvelope(text);
      sawUser = true;
      opening.personFirst = personTitleText(text);
      if (opening.personFirst) break;
    }
  } catch {
    // An unreadable transcript opens with nothing anyone can see.
  } finally {
    lines.close();
    stream.destroy();
  }
  return opening;
}
