/**
 * `Message.Attachments` — the files posted with a message: thumbnails for the
 * ones the server verified, chips for everything else.
 *
 * Its own part for the reason the room's design record gives: the row was split
 * into pieces that can each be owned alone, and attachment rendering is not
 * allowed to grow it back.
 *
 * **The one rule this module exists to hold: the decision to render an `<img>`
 * comes from `preview`, and never from `mimeType`.** `preview` is non-null only
 * where the server sniffed the BYTES and found an image; `mimeType` for
 * anything else is whatever the uploader declared it was. A renderer that
 * branched on `mimeType` would let an uploader put a file of their choosing
 * into an `<img src>` on the cockpit's own origin by naming it `.png` — which is
 * exactly the case the server's own tests pin (a `.png` full of GIF bytes
 * stores with `preview: null`), so both layers are describing one attack.
 *
 * @module features/conversation/ui/message/MessageAttachments
 */
import { File as FileIcon } from 'lucide-react';
import type { RoomAttachment } from '@dorkos/shared/room-schemas';

/** What the attachment block draws. */
export interface MessageAttachmentsProps {
  /** The message's files, in the order they were posted. */
  items: readonly RoomAttachment[];
}

/** Size units, smallest first — each one 1024 of the last. */
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * A byte count as a person would say it: `812 B`, `1.4 KB`, `2.0 MB`.
 *
 * Whole bytes stay whole — "812.0 B" is a precision nobody asked for — and
 * anything scaled keeps one decimal, which is the difference between a 1.4 MB
 * screenshot and a 1.9 MB one without pretending to more.
 *
 * @param bytes - The file's size on disk, as the server measured it.
 */
function formatSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} ${SIZE_UNITS[0]}` : `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

/**
 * What the row's accessible description says about the files, or `null` when
 * there are none.
 *
 * The block below is a sibling of the message's words, so a description pointed
 * at them alone says nothing about the files hanging under them — a screen
 * reader would hear the words and never learn a file came with them. The host
 * row folds this line into the one summary it already writes rather than adding
 * a second `aria-describedby`, so a reader still hears one description per row.
 *
 * @param attachments - The entry's files, in posted order.
 */
export function attachmentsSummary(attachments: readonly RoomAttachment[]): string | null {
  if (attachments.length === 0) return null;
  const names = attachments.map((attachment) => attachment.name).join(', ');
  return `${attachments.length} ${attachments.length === 1 ? 'file' : 'files'}: ${names}`;
}

/**
 * One attachment: a thumbnail where the bytes were verified as an image, and a
 * chip you can download everywhere else.
 *
 * Both are links to `attachment.url` exactly as the server wrote it, never a URL
 * rebuilt from ids — today it is server-relative, and a remote store would
 * answer an absolute one with no change here. Neither carries `download`: what
 * happens on a click is decided by the `Content-Disposition` the server sends,
 * which is the only place that decision can be made safely, and a `download`
 * attribute is ignored cross-origin anyway.
 */
function AttachmentItem({ attachment }: { attachment: RoomAttachment }) {
  if (attachment.preview === 'image') {
    return (
      // `focus-ring` on the link, matching every other interactive element in
      // this widget: a thumbnail is reachable by keyboard and has to say so.
      <a
        href={attachment.url}
        target="_blank"
        rel="noreferrer"
        className="focus-ring inline-block rounded-md"
      >
        <img
          src={attachment.url}
          alt={attachment.name}
          loading="lazy"
          className="max-h-64 max-w-full rounded-md border"
        />
      </a>
    );
  }

  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noreferrer"
      data-testid="room-entry-attachment-chip"
      className="focus-ring border-border bg-muted/40 text-foreground hover:bg-muted flex max-w-full items-center gap-2 rounded-md border px-2 py-1 text-xs transition-colors"
    >
      <FileIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
      {/* `min-w-0` is what lets a long filename actually truncate: a flex item
          refuses to shrink below its content without it, so the chip would
          instead push past the column it sits in. */}
      <span className="min-w-0 truncate">{attachment.name}</span>
      <span className="text-muted-foreground shrink-0 tabular-nums">
        {formatSize(attachment.size)}
      </span>
    </a>
  );
}

/**
 * The files posted with a message, under the words and above the reactions.
 *
 * An entry with no files renders NOTHING — no rail, no ghost — the same way
 * `EntryReactionRow` renders nothing for a message nobody reacted to, and the
 * same way an entry written before rooms carried files renders today.
 */
export function MessageAttachments({ items }: MessageAttachmentsProps) {
  if (items.length === 0) return null;

  return (
    <div
      data-slot="message-attachments"
      data-testid="room-entry-attachments"
      className="mt-1 flex flex-wrap gap-2"
    >
      {items.map((attachment) => (
        <AttachmentItem key={attachment.id} attachment={attachment} />
      ))}
    </div>
  );
}
