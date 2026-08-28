/**
 * Read one file out of a source that has nowhere else to show it (spec
 * `project-rooms` §3.9).
 *
 * The session pane opens a file into the canvas, beside the conversation it
 * belongs to. A room's files have no conversation to sit beside and no working
 * directory to be saved back into, so they are read here instead — a dialog on
 * a desktop, a drawer on a phone, closed with Escape either way.
 *
 * **Everything it shows was written by the room's members.** Markdown renders
 * through the same static renderer every other untrusted surface uses, which
 * sanitises the tags and puts every link behind the shared confirmation; text
 * renders as text in a `<pre>`. Nothing on this path takes raw HTML, and
 * nothing here needed a sanitiser of its own.
 *
 * @module features/file-explorer/ui/FilePreviewDialog
 */
import { useQuery } from '@tanstack/react-query';
import { FileWarning, Loader2 } from 'lucide-react';
import {
  MarkdownContent,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import { baseName } from '../model/tree';
import { provenanceLine } from '../lib/provenance';
import type { ExplorerFile, FileExplorerSource } from '../model/source';

/** Whether a path names a markdown document, by the same rule the canvas uses. */
function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

/** How many bytes, said the way a person says it. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What {@link FilePreviewDialog} shows. */
export interface FilePreviewDialogProps {
  /** The source the file is read from. Must offer `read`. */
  source: FileExplorerSource;
  /** The file to show, or `null` when nothing is open. */
  path: string | null;
  /** Called when the reader closes it. */
  onClose: () => void;
}

/**
 * Show one file from a source that previews in place.
 *
 * @param props - The source, the open path, and how to close.
 */
export function FilePreviewDialog({ source, path, onClose }: FilePreviewDialogProps) {
  const read = source.read;
  const query = useQuery({
    queryKey: ['file-explorer', 'preview', source.scopeKey, path],
    queryFn: () => read!(path!),
    enabled: path !== null && read !== undefined,
  });

  return (
    <ResponsiveDialog open={path !== null} onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent className="max-h-[80vh] sm:max-w-2xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="truncate font-mono text-sm">
            {path === null ? '' : baseName(path)}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="truncate text-xs">
            {describe(query.data, path)}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="min-h-0 flex-1 overflow-auto">
          {query.isPending ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="text-muted-foreground size-(--size-icon-md) animate-spin" />
            </div>
          ) : query.isError || query.data === undefined ? (
            <PreviewNote>This file couldn&apos;t be read.</PreviewNote>
          ) : (
            <PreviewBody file={query.data} />
          )}
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/** The line under the filename: where it sits, and who last touched it. */
function describe(file: ExplorerFile | undefined, path: string | null): string {
  if (path === null) return '';
  const line = file === undefined ? null : provenanceLine(file.lastCommit);
  return line === null ? path : `${path} · ${line.label}`;
}

/** The file itself, or the honest reason it is not here. */
function PreviewBody({ file }: { file: ExplorerFile }) {
  switch (file.body.kind) {
    case 'text':
      return isMarkdownPath(file.path) ? (
        <MarkdownContent
          content={file.body.text}
          className="text-sm"
          errorFallback="This file couldn't be displayed."
        />
      ) : (
        // `<pre>` renders the bytes as the characters they are — no
        // highlighting, no parsing, nothing that could interpret them.
        <pre className="text-foreground/90 overflow-x-auto font-mono text-xs whitespace-pre">
          {file.body.text}
        </pre>
      );
    case 'binary':
      return <PreviewNote>This isn&apos;t text, so there&apos;s nothing to show here.</PreviewNote>;
    case 'too-large':
      return (
        <PreviewNote>
          This file is larger than {formatBytes(file.body.maxBytes)}, so it isn&apos;t shown here.
        </PreviewNote>
      );
    case 'not-readable':
      return <PreviewNote>{file.body.reason}</PreviewNote>;
  }
}

/** A centred, muted sentence — the shape every "nothing to show" answer takes. */
function PreviewNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-32 flex-col items-center justify-center gap-2 px-6 text-center text-sm">
      <FileWarning className="size-(--size-icon-md) opacity-60" />
      <span>{children}</span>
    </div>
  );
}
