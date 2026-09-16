import { useId, useState } from 'react';
import type { RemoteCommunityEntry } from '@dorkos/shared/community-views';
import { useTransport, type MessageAuthor } from '@/layers/shared/model';
import { Button, MarkdownContent } from '@/layers/shared/ui';
import { Message } from '@/layers/features/conversation';

/** Render remote identities as remote messages, with only authorized local download actions. */
export function RemoteCommunityMessage({
  entry,
  onThread,
}: {
  entry: RemoteCommunityEntry;
  onThread: (rootId: string) => void;
}) {
  const transport = useTransport();
  const labelId = useId();
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const author: MessageAuthor = {
    id: JSON.stringify([entry.community, entry.authorId]),
    kind: entry.authorKind,
    displayName: entry.authorDisplayName,
  };
  async function download(id: string, name: string) {
    if (downloading) return;
    setDownloading(id);
    setError(null);
    let url: string | undefined;
    try {
      const blob = await transport.downloadRemoteCommunityAttachment(
        entry.community,
        entry.roomId,
        id
      );
      url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = Array.from(name, (char) =>
        char === '/' || char === '\\' || char.charCodeAt(0) < 32 ? '_' : char
      ).join('');
      document.body.append(link);
      link.click();
      link.remove();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The file could not be downloaded.');
    } finally {
      if (url) setTimeout(() => URL.revokeObjectURL(url!), 1000);
      setDownloading(null);
    }
  }
  return (
    <Message.Root
      role={entry.authorKind === 'human' ? 'user' : 'assistant'}
      aria-labelledby={labelId}
    >
      <Message.Gutter author={author} at={entry.createdAt} />
      <Message.Body>
        <Message.Author id={labelId} author={author} at={entry.createdAt} />
        <Message.Content>
          <MarkdownContent content={entry.text} />
          {entry.attachments.map((file) => (
            <Button
              key={file.id}
              variant="outline"
              size="sm"
              disabled={downloading !== null}
              onClick={() => void download(file.id, file.name)}
            >
              {downloading === file.id ? 'Downloading…' : file.name}
            </Button>
          ))}
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onThread(entry.threadRootEntryId ?? entry.id)}
          >
            {entry.depth === 0 ? 'Reply in thread' : 'Open thread'}
          </Button>
        </Message.Content>
      </Message.Body>
    </Message.Root>
  );
}
