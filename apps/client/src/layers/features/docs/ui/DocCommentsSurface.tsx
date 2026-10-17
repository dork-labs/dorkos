import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { BlintzPlugin } from 'blintz';
import { useBlintzComments, type CommentAnchor } from '@blintz/comments';
import type { DocCommentAnchor, DocCommentThread, DocRef } from '@dorkos/shared/doc-comments';
import { useDocCommentThreads, useUpdateDocCommentAnchors } from '@/layers/entities/doc';
import type { ThreadPlacement } from '../lib/comment-copy';
import { DocCommentsPanel } from './DocCommentsPanel';
import './doc-comments.css';

/** Props for {@link DocCommentsSurface}. */
export interface DocCommentsSurfaceProps {
  /** The file-backed markdown doc. */
  doc: DocRef;
  /** Whether the Docs experiment is on. Off, the editor is handed nothing. */
  enabled: boolean;
  /** The markdown the editor shows now (a draft while editing). */
  value: string;
  /** The markdown known to be on disk: the last confirmed save, or what was loaded. */
  saved: string;
  /** The editor, handed the comment plugin to install, or nothing while off. */
  children: (plugins: BlintzPlugin[] | undefined) => ReactNode;
}

const NO_THREADS: DocCommentThread[] = [];

/** One moved anchor waiting to be saved, and the markdown it was reported against. */
interface HeldAnchor {
  anchor: DocCommentAnchor;
  markdown: string;
}

/**
 * A doc with its comments: the editor (highlighting every thread's words) and
 * a panel beside it, or under it in a narrow pane, listing the threads.
 *
 * **One tree, on or off.** The editor sits in the same place whether the Docs
 * experiment is on or not, so flipping it never remounts the editor. Blintz
 * installs plugins only at mount, so a switch takes full effect the next time
 * the doc opens; until then, off means no highlights and no panel.
 *
 * **Anchors are saved only for markdown that is on disk.** The editor reports
 * moved anchors as the text changes, draft or not. Each report is held with the
 * markdown it was made against and saved only once that markdown is on disk
 * (a confirmed save, or the doc as loaded). A report made against a draft that
 * was then thrown away (Reload, a conflict) never reaches the server, so a
 * thread is never re-anchored to words the file does not have; the editor
 * reports again against what it shows instead.
 */
export function DocCommentsSurface({
  doc,
  enabled,
  value,
  saved,
  children,
}: DocCommentsSurfaceProps) {
  const threads = useDocCommentThreads(enabled ? doc : null).data ?? NO_THREADS;
  const { mutate: saveAnchors } = useUpdateDocCommentAnchors(doc);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [orphaned, setOrphaned] = useState<ReadonlySet<string>>(() => new Set());
  // The editor places threads after it renders; a second look a frame later
  // reads where it put them, so a thread that landed ambiguously says so.
  const [, setPlacedAt] = useState(0);

  const held = useRef(new Map<string, HeldAnchor>());
  const latest = useRef({ value, saved });
  useLayoutEffect(() => {
    latest.current = { value, saved };
  }, [value, saved]);

  /** Save what is held against the markdown on disk; drop what belongs to a discarded draft. */
  const flush = useCallback(() => {
    const { value: shown, saved: onDisk } = latest.current;
    const ready: Array<{ id: string; anchor: DocCommentAnchor }> = [];
    for (const [id, entry] of held.current) {
      if (entry.markdown === onDisk) ready.push({ id, anchor: entry.anchor });
      if (entry.markdown === onDisk || (shown === onDisk && entry.markdown !== shown)) {
        held.current.delete(id);
      }
    }
    if (ready.length > 0) saveAnchors(ready);
  }, [saveAnchors]);

  useEffect(flush, [value, saved, flush]);

  const refs = useMemo(
    () =>
      threads.map((thread) => ({
        id: thread.id,
        anchor: thread.anchor as unknown as CommentAnchor,
        resolved: thread.resolved,
      })),
    [threads]
  );

  const comments = useBlintzComments({
    threads: refs,
    activeThreadId: activeId,
    showResolved,
    onThreadClick: (ids) => setActiveId(ids[0] ?? null),
    onAnchorsChange: (updates) => {
      for (const { id, anchor } of updates) {
        held.current.set(id, {
          anchor: anchor as unknown as DocCommentAnchor,
          markdown: latest.current.value,
        });
      }
      flush();
    },
    onOrphanedChange: (ids) => setOrphaned(new Set(ids)),
  });
  const plugins = useMemo(() => [comments.plugin], [comments.plugin]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setPlacedAt(Date.now()));
    return () => cancelAnimationFrame(frame);
  }, [refs, orphaned]);

  const placementOf = (id: string): ThreadPlacement =>
    orphaned.has(id) ? 'orphaned' : (comments.rangeOf(id)?.match ?? 'exact');

  return (
    <div className="@container">
      <div className="flex flex-col gap-4 @3xl:flex-row">
        <div className="min-w-0 flex-1">{children(enabled ? plugins : undefined)}</div>
        {enabled && (
          <DocCommentsPanel
            doc={doc}
            threads={threads}
            activeId={activeId}
            onActiveChange={setActiveId}
            showResolved={showResolved}
            onShowResolvedChange={setShowResolved}
            placementOf={placementOf}
            anchorSelection={() => {
              const anchor = comments.anchorSelection();
              return anchor ? { ...anchor } : null;
            }}
            reveal={(id) => comments.reveal(id)}
          />
        )}
      </div>
    </div>
  );
}
