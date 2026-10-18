/**
 * The messages a Direct chat holds outside its session (rule S12, DOR-2997).
 *
 * An agent's Direct chat is its standing 1:1 with you: a session, with the
 * direct message room underneath it as its log. A ping the agent sends you
 * from one of its other chats lands in that log and never becomes a turn of
 * this session, so the transcript alone would not show it. This puts each one
 * in the stream where it landed, as an ordinary message from its author.
 *
 * - **Only this room's entries.** The agent's posts in other rooms never show
 *   up here.
 * - **Nothing twice.** An entry this session wrote (under any id it has held)
 *   and its transcript still holds, or a post a turn here answered, is already
 *   in the transcript. One whose transcript is gone is drawn as a note.
 * - **Unanimated, at its real time.** A note is never a new message to the
 *   transcript's animation rule, which counts transcript messages only.
 * - **Read on open.** The room's read cursor is frozen as it stood when the
 *   chat opened, so the "Unread" divider stays where you left off, and the
 *   cursor itself moves to the newest entry.
 *
 * @module widgets/session/model/use-direct-chat-notes
 */
import { useMemo, useState } from 'react';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import {
  useDirectChat,
  useMarkRoomRead,
  useRoom,
  useRoomEntries,
  useRoomStream,
} from '@/layers/entities/room';
import type { ChatMessage } from '@/layers/shared/model';

/**
 * What a Direct chat holds under its session, read once by the chat panel and
 * handed to the transcript, which only arranges it.
 */
export interface DirectChatLog {
  /** The room under the Direct chat, or null for an ordinary chat. */
  roomId: string | null;
  /** The log's loaded entries, oldest first. Empty for an ordinary chat. */
  entries: readonly RoomEntry[];
  /** Every id the session has held. */
  sessionIds: readonly string[];
  /** The log's agent members; everyone else is the person. */
  agentAuthorIds: ReadonlySet<string>;
  /** The person's read cursor as it stood when the chat opened, or null. */
  readSeq: number | null;
  /** False while a Direct chat's log is still loading, so landing can wait. */
  ready: boolean;
}

/** What the transcript draws for a Direct chat. */
export interface DirectChatView {
  /** The transcript with the notes in it, oldest first. */
  messages: ChatMessage[];
  /** The id of the message just before the first unread note, when one is unread. */
  lastSeenBeforeUnread: string | null;
  /** Whether the first unread note is the first message in the stream. */
  unreadFromStart: boolean;
}

/** One note per entry, kept, so the layout cache sees the same object each render. */
const noteMessages = new WeakMap<RoomEntry, ChatMessage>();

/**
 * The entries of a Direct chat's log that the transcript does not already show.
 *
 * @param entries - The room's loaded history, oldest first.
 * @param sessionIds - Every id the session has held.
 * @param transcript - The session's messages.
 * @param agentAuthorIds - The room's agent members. Everyone else is the person.
 * @param transcriptWhole - Whether `transcript` is the whole conversation, with
 *   no older page left to read. Until it is, what this session wrote before
 *   the oldest loaded message is taken to be in the part not read yet.
 */
export function directNotesFor(
  entries: readonly RoomEntry[],
  sessionIds: readonly string[],
  transcript: readonly ChatMessage[],
  agentAuthorIds: ReadonlySet<string>,
  transcriptWhole = true
): ChatMessage[] {
  const own = new Set(sessionIds);
  const answered = new Set(
    transcript.flatMap((message) => (message.roomMessage ? [message.roomMessage.entryId] : []))
  );
  // What this session wrote is drawn by the transcript only while the
  // transcript still holds it. Claude Code deletes old transcripts on its own,
  // and a seat whose file is gone (or was cut short) would otherwise show the
  // person's half of the conversation and none of the agent's.
  let written: Set<string> | undefined;
  const unreadBefore = transcriptWhole ? null : earliestTimestamp(transcript);
  const notes: ChatMessage[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'post' || entry.threadRootEntryId) continue;
    if (entry.sessionId !== null && own.has(entry.sessionId)) {
      written ??= textsWritten(transcript);
      if (written.has(entry.body.text)) continue;
      if (
        !transcriptWhole &&
        (unreadBefore === null || Date.parse(entry.createdAt) < unreadBefore)
      ) {
        continue;
      }
    }
    if (answered.has(entry.id)) continue;
    let note = noteMessages.get(entry);
    if (!note) {
      const text = entry.body.text;
      note = {
        id: `direct-note-${entry.id}`,
        // A ping is the agent talking to you, so it reads as the agent's message.
        role: agentAuthorIds.has(entry.authorId) ? 'assistant' : 'user',
        content: text,
        parts: [{ type: 'text', text }],
        timestamp: entry.createdAt,
        _directNote: { roomId: entry.roomId, entryId: entry.id, seq: entry.seq },
      };
      noteMessages.set(entry, note);
    }
    notes.push(note);
  }
  return notes;
}

/** The tools whose text argument becomes a post in the room. */
const POSTING_TOOLS = /(?:^|[_.])(?:post_to_room|relay_notify_user)$/;

/**
 * Every text the transcript shows its agent posting: its replies (each part,
 * and a turn's parts joined, which is how room turns once posted them), and
 * the string arguments of the tools that post.
 */
function textsWritten(transcript: readonly ChatMessage[]): Set<string> {
  const texts = new Set<string>();
  for (const message of transcript) {
    if (message.role !== 'assistant') continue;
    const paragraphs: string[] = [];
    for (const part of message.parts ?? []) {
      if (part.type === 'text') {
        texts.add(part.text);
        texts.add(part.text.trim());
        paragraphs.push(part.text.trim());
      } else if (part.type === 'tool_call' && part.input && POSTING_TOOLS.test(part.toolName)) {
        for (const value of stringArguments(part.input)) texts.add(value);
      }
    }
    if (paragraphs.length > 1) texts.add(paragraphs.filter(Boolean).join('\n\n').trim());
  }
  return texts;
}

/** The string arguments of a tool call's JSON input; none when it does not parse. */
function stringArguments(input: string): string[] {
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed === null || typeof parsed !== 'object') return [];
    return Object.values(parsed).filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

/** The earliest time a transcript message carries, or null when none has one. */
function earliestTimestamp(transcript: readonly ChatMessage[]): number | null {
  let earliest: number | null = null;
  for (const message of transcript) {
    const at = Date.parse(message.timestamp);
    if (!Number.isNaN(at) && (earliest === null || at < earliest)) earliest = at;
  }
  return earliest;
}

/**
 * Put notes into a transcript by time. A note never lands below a live
 * message, which holds the "newest message" place streaming reads.
 *
 * @param transcript - The session's messages, oldest first.
 * @param notes - The notes, oldest first.
 */
export function interleaveDirectNotes(
  transcript: readonly ChatMessage[],
  notes: readonly ChatMessage[]
): ChatMessage[] {
  if (notes.length === 0) return transcript as ChatMessage[];
  const out: ChatMessage[] = [];
  let next = 0;
  for (const message of transcript) {
    const live = message.timestamp === '';
    const at = Date.parse(message.timestamp);
    while (
      next < notes.length &&
      (live || (!Number.isNaN(at) && Date.parse(notes[next]!.timestamp) < at))
    ) {
      out.push(notes[next]!);
      next += 1;
    }
    out.push(message);
  }
  while (next < notes.length) out.push(notes[next++]!);
  return out;
}

/**
 * Arrange a Direct chat's notes in its transcript. Pure, so the transcript can
 * call it without reading anything.
 *
 * @param transcript - The session's messages, oldest first.
 * @param log - The Direct chat's log, or undefined for an ordinary chat.
 * @param transcriptWhole - Whether no older page of the transcript is left to read.
 */
export function withDirectNotes(
  transcript: ChatMessage[],
  log: DirectChatLog | undefined,
  transcriptWhole = true
): DirectChatView {
  if (!log || log.entries.length === 0) {
    return { messages: transcript, lastSeenBeforeUnread: null, unreadFromStart: false };
  }
  const notes = directNotesFor(
    log.entries,
    log.sessionIds,
    transcript,
    log.agentAuthorIds,
    transcriptWhole
  );
  const messages = interleaveDirectNotes(transcript, notes);
  const { readSeq } = log;
  const firstUnread =
    readSeq === null
      ? -1
      : messages.findIndex(
          (message) =>
            message._directNote !== undefined &&
            message.role === 'assistant' &&
            message._directNote.seq > readSeq
        );
  return {
    messages,
    lastSeenBeforeUnread: firstUnread > 0 ? messages[firstUnread - 1]!.id : null,
    unreadFromStart: firstUnread === 0,
  };
}

/**
 * Read this session's Direct chat log, follow it live and mark it read. An
 * ordinary chat answers an empty log that is ready at once.
 *
 * @param sessionId - The session on screen.
 */
export function useDirectChatLog(sessionId: string | null): DirectChatLog {
  const chat = useDirectChat(sessionId);
  const roomId = chat.data?.roomId ?? null;
  const roomQuery = useRoom(roomId);
  const entriesQuery = useRoomEntries(roomId);
  const room = roomQuery.data;
  const entries = entriesQuery.data;
  useRoomStream(roomId, entries !== undefined);
  useMarkRoomRead(room, entries ?? EMPTY_ENTRIES);

  const viewerReadSeq =
    room?.members.find((member) => member.author.id === room.viewerAuthorId)?.lastReadSeq ?? null;
  const readSeq = useFrozen(roomId, viewerReadSeq);
  const sessionIds = chat.data?.sessionIds ?? EMPTY_IDS;

  return useMemo(() => {
    // A log that cannot be read leaves the chat as it is, and must not hold
    // the transcript's landing forever.
    const failed = roomQuery.isError || entriesQuery.isError;
    const loaded = roomId === null || failed || (entries !== undefined && readSeq !== null);
    return {
      roomId,
      entries: entries ?? EMPTY_ENTRIES,
      sessionIds,
      agentAuthorIds: new Set(
        (room?.members ?? [])
          .filter((member) => member.author.kind === 'agent')
          .map((member) => member.author.id)
      ),
      readSeq,
      ready: sessionId === null || chat.isError || (chat.isFetched && loaded),
    };
  }, [
    sessionId,
    chat.isError,
    chat.isFetched,
    roomId,
    room,
    entries,
    sessionIds,
    readSeq,
    roomQuery.isError,
    entriesQuery.isError,
  ]);
}

const EMPTY_IDS: string[] = [];
const EMPTY_ENTRIES: RoomEntry[] = [];

/** A value frozen the first time it is known for a key, until the key changes. */
function useFrozen(key: string | null, value: number | null): number | null {
  const [frozen, setFrozen] = useState<{ key: string | null; value: number | null }>({
    key: null,
    value: null,
  });
  if (frozen.key === key && frozen.value !== null) return frozen.value;
  if (key === null || value === null) return null;
  setFrozen({ key, value });
  return value;
}
